/**
 * LevelDB reader for Copilot Money Firestore data.
 *
 * This module provides proper iteration over LevelDB databases using the
 * classic-level library, eliminating the need for raw binary file parsing.
 *
 * To support concurrent access (reading while Copilot Money app is running),
 * this module copies the database files to a temp directory before reading.
 * LevelDB uses file locks that prevent multiple processes from opening the
 * same database, so copying allows us to read without conflicting with the app.
 *
 * Firestore stores documents with keys like:
 * remote_document/projects/{project}/databases/(default)/documents/{collection}/{doc_id}
 */

import { ClassicLevel } from 'classic-level';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseFirestoreDocument,
  toPlainObject,
  encodeFirestoreDocument,
  type FirestoreValue,
} from './protobuf-parser.js';

/**
 * Cache for temporary database copies.
 * Maps source path to { tempPath, refCount, lastAccess, sourceFingerprint }.
 */
interface TempDbCacheEntry {
  tempPath: string;
  refCount: number;
  lastAccess: number;
  /**
   * Fingerprint of the source LevelDB at copy time (max mtime across the
   * directory and every relevant file inside). Used to detect whether the
   * source has changed since this entry was populated.
   */
  sourceFingerprint: number;
}

const tempDbCache = new Map<string, TempDbCacheEntry>();

// Cleanup interval (5 minutes)
const TEMP_DB_CACHE_TTL = 5 * 60 * 1000;

/** Prefix every temp copy is created with. */
const TEMP_DB_PREFIX = 'copilot-leveldb-';

/**
 * Predicate for files that make up a LevelDB database state. Matches the set
 * `copyDatabaseToTemp` actually copies (LOCK is intentionally excluded — we
 * never want to copy or fingerprint it).
 */
function isLevelDBFile(file: string): boolean {
  return (
    file.endsWith('.ldb') ||
    file.endsWith('.log') ||
    file.startsWith('MANIFEST-') ||
    file === 'CURRENT' ||
    file === 'LOG' ||
    file === 'LOG.old'
  );
}

/**
 * Compute a fingerprint of the source LevelDB's current state.
 *
 * Returns max(directory mtime, file mtime for every relevant file). The
 * directory mtime catches structural changes (new/removed/renamed files,
 * e.g. compaction producing a new .ldb or rolling MANIFEST); per-file
 * mtimes catch in-place appends (e.g. writes to the active .log file,
 * which don't bump the directory mtime). Combined, no LevelDB write can
 * leave the fingerprint unchanged.
 */
function sourceFingerprint(srcPath: string): number {
  let max = fs.statSync(srcPath).mtimeMs;
  for (const file of fs.readdirSync(srcPath)) {
    if (!isLevelDBFile(file)) continue;
    try {
      const m = fs.statSync(path.join(srcPath, file)).mtimeMs;
      if (m > max) max = m;
    } catch (err) {
      // TOCTOU: compaction may delete .ldb between readdir and stat; vanished file is safe to skip (dir mtime bumps), others propagate.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return max;
}

/**
 * Mark a temp copy as still in use.
 *
 * The orphan sweep decides what to delete from a copy's mtime, which otherwise
 * only reflects when it was created. Refreshing it on every reuse makes "not
 * touched in an hour" mean genuinely idle rather than merely old, so a
 * long-lived process reusing one copy can never have it swept out from under it.
 */
function touchTempCopy(tempPath: string): void {
  try {
    const now = new Date();
    fs.utimesSync(tempPath, now, now);
  } catch {
    // Best effort only: a failure here costs nothing but sweep precision.
  }
}

/**
 * Copy a LevelDB database to a temporary directory.
 * This allows reading while another process has the database locked.
 *
 * Uses a cache to avoid copying the same database multiple times. The
 * cache entry is reference-counted and cleaned up when no longer in use.
 * On a cache hit, the source's current fingerprint is compared against the
 * one captured at copy time; if the source has changed, the stale temp
 * copy is discarded and a fresh one is made.
 *
 * @param srcPath - Source database directory
 * @returns Path to the temporary copy
 */
function copyDatabaseToTemp(srcPath: string): string {
  const cached = tempDbCache.get(srcPath);
  if (cached && fs.existsSync(cached.tempPath)) {
    const currentFingerprint = sourceFingerprint(srcPath);
    if (currentFingerprint <= cached.sourceFingerprint) {
      cached.refCount++;
      cached.lastAccess = Date.now();
      touchTempCopy(cached.tempPath);
      return cached.tempPath;
    }
    // Source has changed since the cached copy was made. If nothing is
    // currently iterating it, drop the stale copy and fall through to
    // copy fresh. If a concurrent iteration is still using it, return
    // the stale path (the iterator can't safely have its temp dir
    // deleted out from under it). This concurrent case is unreachable
    // in production (worker isolates each have their own cache) and not
    // exercised by current callers; preserving it as a fallback keeps
    // correctness when refCount drops back to 0.
    if (cached.refCount === 0) {
      cleanupTempDatabase(cached.tempPath);
      tempDbCache.delete(srcPath);
    } else {
      cached.refCount++;
      cached.lastAccess = Date.now();
      touchTempCopy(cached.tempPath);
      return cached.tempPath;
    }
  }

  // Snapshot the fingerprint BEFORE copying. Any source change during the
  // copy itself will then be observed as `current > stored` on the next
  // call and trigger a re-copy — preferring an extra copy over a stale
  // snapshot. (Storing the post-copy fingerprint would risk missing
  // mid-copy writes.) Recomputed here rather than reusing the
  // staleness-check value above, so this snapshot is captured as close
  // to the copy start as possible.
  const fingerprint = sourceFingerprint(srcPath);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DB_PREFIX));
  // A copy now exists on disk. Guarantee it cannot outlive this process, and
  // (once per process) reclaim any copies stranded by an earlier version.
  registerTempDbExitSweep();
  startOrphanSweep();
  try {
    const files = fs.readdirSync(srcPath);
    for (const file of files) {
      if (!isLevelDBFile(file)) continue;
      try {
        fs.copyFileSync(path.join(srcPath, file), path.join(tempDir, file));
      } catch (err) {
        // TOCTOU: compaction may delete .ldb between readdir and copyFile; MANIFEST already dropped it, so omitting is correct, others propagate.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  } catch (err) {
    // A real read/copy failure (EACCES, EIO) aborts before the entry reaches
    // `tempDbCache`, so from here on nothing in the process can name this
    // directory: the exit sweep and `cleanupAllTempDatabases` both iterate the
    // cache, and only the orphan sweep would ever reclaim it, an hour later.
    // This is the last place that still holds the path — delete it here.
    cleanupTempDatabase(tempDir);
    throw err;
  }

  tempDbCache.set(srcPath, {
    tempPath: tempDir,
    refCount: 1,
    lastAccess: Date.now(),
    sourceFingerprint: fingerprint,
  });

  return tempDir;
}

/**
 * Scheduled cleanup callback for temporary database copies.
 * This is the callback that runs after the TTL expires.
 *
 * @param srcPath - The source database path
 * @param scheduledTime - The time when the cleanup was scheduled
 */
function scheduledCleanupCallback(srcPath: string, scheduledTime: number): void {
  const entry = tempDbCache.get(srcPath);
  if (entry && entry.refCount <= 0 && Date.now() - scheduledTime >= TEMP_DB_CACHE_TTL) {
    cleanupTempDatabase(entry.tempPath);
    tempDbCache.delete(srcPath);
  }
}

/**
 * Release a reference to a temporary database copy.
 *
 * When refCount reaches 0 the copy is deliberately KEPT and its cleanup is
 * scheduled after the TTL, so a subsequent read of the same database reuses it
 * instead of re-copying (~120 MB). The timer is unref'd: a pending cleanup must
 * never be the reason a finished server or worker stays alive for the full TTL,
 * and — since an unref'd timer will usually never fire at all — it must never be
 * the only thing standing between a temp copy and deletion. That guarantee comes
 * from `registerTempDbExitSweep`.
 */
function releaseTempDatabase(srcPath: string): void {
  const cached = tempDbCache.get(srcPath);
  if (!cached) return;

  cached.refCount--;
  cached.lastAccess = Date.now();

  // Schedule cleanup if no more references
  if (cached.refCount <= 0) {
    const scheduledTime = cached.lastAccess;
    const timer = setTimeout(
      () => scheduledCleanupCallback(srcPath, scheduledTime),
      TEMP_DB_CACHE_TTL
    );
    timer.unref();
  }
}

/**
 * Clean up a temporary database copy.
 */
function cleanupTempDatabase(tempPath: string): void {
  try {
    fs.rmSync(tempPath, { recursive: true, force: true });
  } catch (error) {
    // Log cleanup errors for debugging - temp files will be cleaned up eventually by the OS
    console.error(
      `[WARN] Failed to clean up temp database at ${tempPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Signals an MCP client may use to stop the server. */
const SWEEP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

let exitSweepRegistered = false;

/**
 * Guarantee that temp copies never outlive the process that created them.
 *
 * The TTL timer in `releaseTempDatabase` cannot be relied on to do the actual
 * deleting: this server usually runs as a short-lived, per-request process, and
 * decoding runs in a worker thread that exits as soon as it posts its result.
 * Both are gone long before a 5-minute timer could fire, and pending timers are
 * simply dropped on exit — so every temp copy was orphaned. In the wild this
 * accumulated to 366 stale `copilot-leveldb-*` directories (~33 GB) and filled
 * the disk (issue #631).
 *
 * Registered lazily, the first time a copy is actually made, so merely importing
 * this module never installs process listeners.
 */
function registerTempDbExitSweep(): void {
  if (exitSweepRegistered) return;
  exitSweepRegistered = true;

  // Normal termination: a worker finishing, stdin closing, an explicit
  // process.exit(). 'exit' listeners must be synchronous, which rmSync is.
  process.on('exit', () => cleanupAllTempDatabases());

  // A signal terminates the process WITHOUT emitting 'exit'. Sweep, then
  // re-raise: the listener is registered with `once`, so by the time we
  // re-raise it has already been removed and the default disposition applies,
  // preserving the conventional 128+n exit code.
  for (const signal of SWEEP_SIGNALS) {
    process.once(signal, () => {
      cleanupAllTempDatabases();
      process.kill(process.pid, signal);
    });
  }
}

/**
 * How long a temp copy must sit untouched before the sweep treats it as
 * abandoned. 12x TEMP_DB_CACHE_TTL: comfortably longer than any read, and
 * `touchTempCopy` keeps an actively reused copy well under it.
 */
const ORPHAN_SWEEP_MIN_AGE_MS = 60 * 60 * 1000;

let orphanSweepStarted = false;

/**
 * Reclaim temp copies stranded on disk by an earlier version of this module.
 *
 * `registerTempDbExitSweep` stops new leaks but cannot help anyone who already
 * has hundreds of orphans (one reporter had ~33 GB). This removes any
 * `copilot-leveldb-*` directory that has gone untouched for
 * ORPHAN_SWEEP_MIN_AGE_MS, including copies left by other processes.
 *
 * Deleting another process's copy is safe by construction:
 *   - copies this process still has cached are skipped explicitly;
 *   - `copyDatabaseToTemp` guards every reuse with `fs.existsSync` and simply
 *     re-copies when the directory is gone, so the worst case for another
 *     process is one extra copy, never a failed read;
 *   - `touchTempCopy` refreshes mtime on reuse, so a copy old enough to sweep
 *     is one nobody has read from in an hour.
 *
 * Best effort by design: it runs on an unref'd timer with async removal, so it
 * never delays startup, blocks a read, or keeps a short-lived process alive. A
 * per-request process may exit mid-sweep and simply finish the job next run.
 * Set COPILOT_MCP_NO_TEMP_SWEEP=1 to disable.
 */
function startOrphanSweep(): void {
  if (orphanSweepStarted) return;
  orphanSweepStarted = true;
  if (process.env.COPILOT_MCP_NO_TEMP_SWEEP) return;

  const timer = setTimeout(() => {
    void runOrphanSweep();
  }, 0);
  timer.unref();
}

/** @internal exported for tests */
export async function runOrphanSweep(): Promise<number> {
  const tmpRoot = os.tmpdir();
  let entries: string[];
  try {
    entries = await fs.promises.readdir(tmpRoot);
  } catch {
    return 0;
  }

  const cutoff = Date.now() - ORPHAN_SWEEP_MIN_AGE_MS;
  const inUse = new Set([...tempDbCache.values()].map((entry) => entry.tempPath));
  let removed = 0;

  for (const name of entries) {
    if (!name.startsWith(TEMP_DB_PREFIX)) continue;
    const full = path.join(tmpRoot, name);
    if (inUse.has(full)) continue;
    try {
      const stat = await fs.promises.stat(full);
      if (!stat.isDirectory() || stat.mtimeMs > cutoff) continue;
      await fs.promises.rm(full, { recursive: true, force: true });
      removed++;
    } catch {
      // Raced with the owning process or another sweeper; nothing to do.
    }
  }

  return removed;
}

/**
 * Force cleanup of all cached temp databases.
 * Useful for tests.
 */
export function cleanupAllTempDatabases(): void {
  for (const [, entry] of tempDbCache) {
    cleanupTempDatabase(entry.tempPath);
  }
  tempDbCache.clear();
}

/**
 * Run the scheduled cleanup for a specific database path.
 * This function is exported for testing purposes to trigger the cleanup
 * callback logic without waiting for the actual TTL timer.
 *
 * @internal
 * @param srcPath - The source database path
 * @param scheduledTime - The time when cleanup was scheduled (use Date.now() - TEMP_DB_CACHE_TTL for immediate cleanup)
 */
export function _runScheduledCleanup(srcPath: string, scheduledTime?: number): void {
  // If no scheduledTime provided, use a time that ensures TTL check passes
  const time = scheduledTime ?? Date.now() - TEMP_DB_CACHE_TTL;
  scheduledCleanupCallback(srcPath, time);
}

/**
 * Get the current temp database cache for testing purposes.
 * @internal
 */
export function _getTempDbCache(): Map<string, TempDbCacheEntry> {
  return tempDbCache;
}

/**
 * A parsed document from the LevelDB database.
 */
export interface LevelDBDocument {
  /** The full LevelDB key */
  key: string;
  /** The Firestore collection name (e.g., "transactions", "accounts") */
  collection: string;
  /** The document ID within the collection */
  documentId: string;
  /** Parsed Firestore fields */
  fields: Map<string, FirestoreValue>;
}

/**
 * Options for opening a LevelDB database.
 */
export interface OpenOptions {
  /** Open in read-only mode (default: true) */
  readOnly?: boolean;
  /** Create if missing (default: false) */
  createIfMissing?: boolean;
}

/**
 * Options for iterating documents.
 */
export interface IterateOptions {
  /**
   * Only include documents from this collection.
   *
   * Matches the LEAF segment: a document's collection qualifies when it equals
   * this value or ends with `/{collection}`. Use this for collections that sit
   * at the end of the path (`transactions`, `accounts`, `financial_goals`, ...).
   *
   * NOT suitable for a collection that is a PARENT segment of the real path —
   * e.g. `investment_prices/{securityId}/daily`, whose leaf is `daily`. Use
   * `collectionRoot` for those (issue #622).
   */
  collection?: string;
  /**
   * Only include documents whose collection path STARTS with this segment.
   *
   * The counterpart to `collection`, for collections whose real documents live
   * in per-entity subcollections and whose identity therefore lives in a middle
   * path segment rather than the leaf.
   */
  collectionRoot?: string;
  /** Only include documents matching this key prefix */
  keyPrefix?: string;
  /** Limit the number of documents returned */
  limit?: number;
}

/**
 * Decide whether a parsed collection path satisfies an iteration filter.
 *
 * Shared by both iteration entry points so the two can never drift — a
 * divergence of exactly this kind is what hid issue #622 (the standalone
 * decoder matched nothing while the aggregate loader matched 165 documents).
 */
export function collectionFilterMatches(
  parsedCollection: string,
  options: Pick<IterateOptions, 'collection' | 'collectionRoot'>
): boolean {
  const { collection, collectionRoot } = options;

  if (collectionRoot !== undefined) {
    if (parsedCollection !== collectionRoot && !parsedCollection.startsWith(`${collectionRoot}/`)) {
      return false;
    }
  }

  if (collection !== undefined) {
    if (parsedCollection !== collection && !parsedCollection.endsWith(`/${collection}`)) {
      return false;
    }
  }

  return true;
}

/**
 * Regex to parse Firestore document keys (legacy format).
 * Expected format: remote_document/.../documents/{collection}/{doc_id}
 */
const DOCUMENT_KEY_REGEX = /documents\/([^/]+)\/([^/]+)$/;

/**
 * Alternative key format for subcollections (legacy format).
 * Expected format: .../documents/{parent_collection}/{parent_id}/{sub_collection}/{doc_id}
 */
const SUBCOLLECTION_KEY_REGEX = /documents\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/;

/**
 * Parse a LevelDB key in the binary format used by Firestore SDK.
 *
 * The binary format uses:
 * - 0x85 as start marker for "remote_document"
 * - 0x00 0x01 as separators between segments
 * - 0xBE as prefix for string segments (followed immediately by the string)
 * - 0x80 as end marker
 *
 * Example key structure:
 * \x85remote_document\x00\x01\xBEitems\x00\x01\xBE<item_id>\x00\x01\xBEaccounts\x00\x01\xBE<account_id>\x00\x01\xBEtransactions\x00\x01\xBE<transaction_id>\x00\x01\x80
 *
 * Also handles simple string path format for test databases:
 * remote_document/.../documents/{collection}/{doc_id}
 *
 * We extract the last two non-empty segments as collection and document ID.
 */
function parseBinaryKey(keyBuffer: Buffer): { collection: string; documentId: string } | null {
  const keyStr = keyBuffer.toString('utf8');

  // Look for 'remote_document' marker
  if (!keyStr.includes('remote_document')) {
    return null;
  }

  // Try simple string path format first (for test databases)
  // Format: remote_document/.../documents/{collection}/{doc_id}
  // Or subcollection: remote_document/.../documents/{parent}/{parent_id}/{sub}/{doc_id}
  const skipCollections = ['collection_parent', 'target', 'target_global', 'mutation_queue'];

  // Try subcollection pattern first (4 segments after documents/)
  const subPathMatch = keyStr.match(/documents\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (subPathMatch && subPathMatch[1] && subPathMatch[2] && subPathMatch[3] && subPathMatch[4]) {
    const collection = `${subPathMatch[1]}/${subPathMatch[2]}/${subPathMatch[3]}`;
    const documentId = subPathMatch[4];
    if (!skipCollections.includes(subPathMatch[3])) {
      return { collection, documentId };
    }
  }

  // Try simple collection pattern (2 segments after documents/)
  const pathMatch = keyStr.match(/documents\/([^/]+)\/([^/]+)$/);
  if (pathMatch && pathMatch[1] && pathMatch[2]) {
    const collection = pathMatch[1];
    const documentId = pathMatch[2];
    if (!skipCollections.includes(collection)) {
      return { collection, documentId };
    }
  }

  // Try binary format (for real Firestore databases)
  const remoteDocStr = 'remote_document';
  const remoteDocIndex = keyBuffer.indexOf(remoteDocStr, 0, 'utf8');
  if (remoteDocIndex === -1) {
    return null;
  }

  // Extract segments by parsing the binary structure directly
  // Pattern: 0x00 0x01 0xBE followed by string, then 0x00 0x01 or 0x80 (end)
  const segments: string[] = [];
  let pos = remoteDocIndex + remoteDocStr.length;

  while (pos < keyBuffer.length) {
    // Look for separator: 0x00 0x01
    if (keyBuffer[pos] === 0x00 && pos + 1 < keyBuffer.length && keyBuffer[pos + 1] === 0x01) {
      pos += 2;

      // Check for 0xBE (string segment marker) or 0x80 (end marker)
      if (pos < keyBuffer.length) {
        if (keyBuffer[pos] === 0x80) {
          // End of key
          break;
        }
        if (keyBuffer[pos] === 0xbe) {
          pos++;
          // Find the end of this string (next 0x00 or end of buffer)
          let strEnd = pos;
          while (
            strEnd < keyBuffer.length &&
            keyBuffer[strEnd] !== 0x00 &&
            keyBuffer[strEnd] !== 0x80
          ) {
            strEnd++;
          }
          if (strEnd > pos) {
            const str = keyBuffer.slice(pos, strEnd).toString('utf8');
            // Filter out non-printable strings
            if (str.length > 0 && /^[\x20-\x7e]+$/.test(str)) {
              segments.push(str);
            }
          }
          pos = strEnd;
        }
      }
    } else {
      pos++;
    }
  }

  // Need at least: collection, doc_id
  if (segments.length < 2) {
    return null;
  }

  const documentId = segments[segments.length - 1];
  const lastCollection = segments[segments.length - 2];

  // Skip certain collections that aren't actual document storage
  // (skipCollections is declared at the top of this function)
  if (!documentId || !lastCollection || skipCollections.includes(lastCollection)) {
    return null;
  }

  // Return full collection path (all segments except documentId) for subcollections
  // e.g., users/{user_id}/financial_goals/{goal_id}/financial_goal_history
  const collection = segments.slice(0, -1).join('/');

  return { collection, documentId };
}

/**
 * Parse a LevelDB key to extract collection and document ID.
 * Supports both the legacy string format and the binary format used by Firestore SDK.
 */
export function parseDocumentKey(
  key: string | Buffer
): { collection: string; documentId: string } | null {
  // If it's a buffer, use the binary parser
  if (Buffer.isBuffer(key)) {
    return parseBinaryKey(key);
  }

  // For strings, try the legacy path-based format first
  // Try subcollection pattern first (more specific)
  const subMatch = key.match(SUBCOLLECTION_KEY_REGEX);
  if (subMatch && subMatch[1] && subMatch[2] && subMatch[3] && subMatch[4]) {
    return {
      collection: `${subMatch[1]}/${subMatch[2]}/${subMatch[3]}`,
      documentId: subMatch[4],
    };
  }

  // Try simple collection pattern
  const match = key.match(DOCUMENT_KEY_REGEX);
  if (match && match[1] && match[2]) {
    return {
      collection: match[1],
      documentId: match[2],
    };
  }

  // Try binary format on string by converting to buffer
  if (key.includes('remote_document')) {
    return parseBinaryKey(Buffer.from(key, 'utf8'));
  }

  return null;
}

/**
 * Open a LevelDB database and iterate through Firestore documents.
 *
 * To support concurrent access (e.g., reading while Copilot Money app is running),
 * this function copies the database to a temp directory before reading. LevelDB
 * uses file locks that prevent multiple processes from opening the same database.
 *
 * @param dbPath - Path to the LevelDB database directory
 * @param options - Iteration options
 * @yields LevelDBDocument objects
 */
export async function* iterateDocuments(
  dbPath: string,
  options: IterateOptions = {}
): AsyncGenerator<LevelDBDocument> {
  const { collection: filterCollection, collectionRoot, keyPrefix, limit } = options;

  // Validate path exists
  if (!fs.existsSync(dbPath)) {
    throw new Error('Database path not found');
  }

  // Validate path is a directory
  const stats = fs.statSync(dbPath);
  if (!stats.isDirectory()) {
    throw new Error('Path is not a directory');
  }

  // Copy database to temp directory to avoid lock conflicts with Copilot app
  const tempDbPath = copyDatabaseToTemp(dbPath);

  // Open the temp copy with buffer key encoding to handle binary keys
  const db = new ClassicLevel<Buffer, Buffer>(tempDbPath, {
    createIfMissing: false,
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
  });

  try {
    let count = 0;

    for await (const [key, value] of db.iterator()) {
      // Check limit
      if (limit !== undefined && count >= limit) {
        break;
      }

      const keyStr = key.toString('utf8');

      // Check key prefix filter
      if (keyPrefix && !keyStr.startsWith(keyPrefix)) {
        continue;
      }

      // Skip non-document keys (must contain remote_document)
      if (!keyStr.includes('remote_document')) {
        continue;
      }

      // Parse the key (supports both binary and string formats)
      const parsed = parseDocumentKey(key);
      if (!parsed) {
        continue;
      }

      // Check collection filter
      if (
        !collectionFilterMatches(parsed.collection, {
          collection: filterCollection,
          collectionRoot,
        })
      ) {
        continue;
      }

      // Parse the protobuf value.
      // Note: rawValue is intentionally omitted from the yielded document to avoid
      // retaining references to classic-level's native ArrayBuffers. The primary
      // memory leak fix is worker-thread isolation in decodeAllCollectionsIsolated.
      try {
        const fields = parseFirestoreDocument(value);

        yield {
          key: keyStr,
          collection: parsed.collection,
          documentId: parsed.documentId,
          fields,
        };

        count++;
      } catch (error) {
        // Log parsing errors for debugging - can indicate corrupted data or unknown format
        console.error(
          `[WARN] Failed to parse document ${parsed.collection}/${parsed.documentId}: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
    }
  } finally {
    await db.close();
    // Release reference to temp copy (will be cleaned up after TTL if no other users)
    releaseTempDatabase(dbPath);
  }
}

/**
 * Get all documents from a collection.
 *
 * @param dbPath - Path to the LevelDB database directory
 * @param collection - Collection name to filter by
 * @returns Array of parsed documents
 */
export async function getCollection(
  dbPath: string,
  collection: string
): Promise<LevelDBDocument[]> {
  const documents: LevelDBDocument[] = [];

  for await (const doc of iterateDocuments(dbPath, { collection })) {
    documents.push(doc);
  }

  return documents;
}

/**
 * Get all documents and group them by collection.
 *
 * @param dbPath - Path to the LevelDB database directory
 * @returns Map of collection names to document arrays
 */
export async function getAllCollections(dbPath: string): Promise<Map<string, LevelDBDocument[]>> {
  const collections = new Map<string, LevelDBDocument[]>();

  for await (const doc of iterateDocuments(dbPath)) {
    const existing = collections.get(doc.collection) ?? [];
    existing.push(doc);
    collections.set(doc.collection, existing);
  }

  return collections;
}

/**
 * Convert a LevelDBDocument to a plain JavaScript object.
 */
export function documentToObject(doc: LevelDBDocument): Record<string, unknown> {
  return {
    _id: doc.documentId,
    _collection: doc.collection,
    ...toPlainObject(doc.fields),
  };
}

/**
 * A wrapper class for working with LevelDB databases.
 */
export class LevelDBReader {
  private db: ClassicLevel<string, Buffer> | null = null;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Open the database.
   */
  async open(options: OpenOptions = {}): Promise<void> {
    const { createIfMissing = false } = options;
    // Note: readOnly option is accepted but classic-level doesn't support it directly
    // Read-only behavior is achieved by not performing writes

    this.db = new ClassicLevel<string, Buffer>(this.dbPath, {
      createIfMissing,
      keyEncoding: 'utf8',
      valueEncoding: 'buffer',
    });
    // Wait for database to be ready
    await this.db.open();
  }

  /**
   * Close the database.
   */
  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  /**
   * Check if the database is open.
   */
  isOpen(): boolean {
    return this.db !== null;
  }

  /**
   * Iterate through all documents.
   */
  async *iterate(options: IterateOptions = {}): AsyncGenerator<LevelDBDocument> {
    if (!this.db) {
      throw new Error('Database not open. Call open() first.');
    }

    const { collection: filterCollection, collectionRoot, keyPrefix, limit } = options;
    let count = 0;

    for await (const [key, value] of this.db.iterator()) {
      if (limit !== undefined && count >= limit) {
        break;
      }

      if (keyPrefix && !key.startsWith(keyPrefix)) {
        continue;
      }

      if (!key.includes('documents/')) {
        continue;
      }

      const parsed = parseDocumentKey(key);
      if (!parsed) {
        continue;
      }

      if (
        !collectionFilterMatches(parsed.collection, {
          collection: filterCollection,
          collectionRoot,
        })
      ) {
        continue;
      }

      try {
        const fields = parseFirestoreDocument(value);

        yield {
          key,
          collection: parsed.collection,
          documentId: parsed.documentId,
          fields,
        };

        count++;
      } catch (error) {
        // Log parsing errors for debugging - can indicate corrupted data or unknown format
        console.error(
          `[WARN] Failed to parse document ${parsed.collection}/${parsed.documentId}: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
    }
  }

  /**
   * Get all documents from a collection.
   */
  async getCollection(collection: string): Promise<LevelDBDocument[]> {
    const documents: LevelDBDocument[] = [];

    for await (const doc of this.iterate({ collection })) {
      documents.push(doc);
    }

    return documents;
  }

  /**
   * Get a specific document by collection and ID.
   */
  async getDocument(collection: string, documentId: string): Promise<LevelDBDocument | null> {
    for await (const doc of this.iterate({ collection })) {
      if (doc.documentId === documentId) {
        return doc;
      }
    }
    return null;
  }

  /**
   * Put a document into the database (for testing purposes).
   */
  async putDocument(
    collection: string,
    documentId: string,
    fields: Record<string, unknown>
  ): Promise<void> {
    if (!this.db) {
      throw new Error('Database not open. Call open() first.');
    }

    // Create the key
    const key = `remote_document/projects/copilot-production-22904/databases/(default)/documents/${collection}/${documentId}`;

    // Encode the document
    const value = encodeFirestoreDocument(fields);

    await this.db.put(key, value);
  }

  /**
   * Delete a document from the database (for testing purposes).
   */
  async deleteDocument(collection: string, documentId: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not open. Call open() first.');
    }

    const key = `remote_document/projects/copilot-production-22904/databases/(default)/documents/${collection}/${documentId}`;
    await this.db.del(key);
  }
}

/**
 * Create a new LevelDB database for testing.
 */
export async function createTestDatabase(
  dbPath: string,
  documents: Array<{ collection: string; id: string; fields: Record<string, unknown> }>
): Promise<void> {
  const reader = new LevelDBReader(dbPath);
  await reader.open({ readOnly: false, createIfMissing: true });

  try {
    for (const doc of documents) {
      await reader.putDocument(doc.collection, doc.id, doc.fields);
    }
  } finally {
    await reader.close();
  }
}
