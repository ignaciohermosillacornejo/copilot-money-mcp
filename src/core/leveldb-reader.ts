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
 * Maps source path to { tempPath, refCount, lastAccess }.
 */
interface TempDbCacheEntry {
  tempPath: string;
  refCount: number;
  lastAccess: number;
}

const tempDbCache = new Map<string, TempDbCacheEntry>();

// Cleanup interval (5 minutes)
const TEMP_DB_CACHE_TTL = 5 * 60 * 1000;

/**
 * Copy a LevelDB database to a temporary directory.
 * This allows reading while another process has the database locked.
 *
 * Uses a cache to avoid copying the same database multiple times.
 * The cache entry is reference-counted and cleaned up when no longer in use.
 *
 * @param srcPath - Source database directory
 * @returns Path to the temporary copy
 */
function copyDatabaseToTemp(srcPath: string): string {
  // Check cache first
  const cached = tempDbCache.get(srcPath);
  if (cached && fs.existsSync(cached.tempPath)) {
    cached.refCount++;
    cached.lastAccess = Date.now();
    return cached.tempPath;
  }

  // Create a unique temp directory
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-leveldb-'));

  // Copy all LevelDB files
  // LevelDB database consists of: .ldb (SST files), MANIFEST-*, CURRENT, LOG, LOCK
  const files = fs.readdirSync(srcPath);
  for (const file of files) {
    // Copy all relevant LevelDB files (skip LOCK file - we don't need it for read-only)
    if (
      file.endsWith('.ldb') ||
      file.endsWith('.log') ||
      file.startsWith('MANIFEST-') ||
      file === 'CURRENT' ||
      file === 'LOG' ||
      file === 'LOG.old'
    ) {
      const srcFile = path.join(srcPath, file);
      const destFile = path.join(tempDir, file);
      fs.copyFileSync(srcFile, destFile);
    }
  }

  // Add to cache
  tempDbCache.set(srcPath, {
    tempPath: tempDir,
    refCount: 1,
    lastAccess: Date.now(),
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
 * When refCount reaches 0, schedule cleanup after TTL.
 */
function releaseTempDatabase(srcPath: string): void {
  const cached = tempDbCache.get(srcPath);
  if (!cached) return;

  cached.refCount--;
  cached.lastAccess = Date.now();

  // Schedule cleanup if no more references
  if (cached.refCount <= 0) {
    const scheduledTime = cached.lastAccess;
    setTimeout(() => scheduledCleanupCallback(srcPath, scheduledTime), TEMP_DB_CACHE_TTL);
  }
}

/**
 * Clean up a temporary database copy.
 */
function cleanupTempDatabase(tempPath: string): void {
  try {
    fs.rmSync(tempPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors - temp files will be cleaned up eventually
  }
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
  /** The raw protobuf bytes (for debugging) */
  rawValue: Buffer;
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
  /** Only include documents from this collection */
  collection?: string;
  /** Only include documents matching this key prefix */
  keyPrefix?: string;
  /** Limit the number of documents returned */
  limit?: number;
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
  const collection = segments[segments.length - 2];

  // Skip certain collections that aren't actual document storage
  // (skipCollections is declared at the top of this function)
  if (!documentId || !collection || skipCollections.includes(collection)) {
    return null;
  }

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
  const { collection: filterCollection, keyPrefix, limit } = options;

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
      if (filterCollection) {
        // Match either exact collection or subcollection ending with the filter
        const isMatch =
          parsed.collection === filterCollection ||
          parsed.collection.endsWith(`/${filterCollection}`);
        if (!isMatch) {
          continue;
        }
      }

      // Parse the protobuf value
      try {
        const fields = parseFirestoreDocument(value);

        yield {
          key: keyStr,
          collection: parsed.collection,
          documentId: parsed.documentId,
          rawValue: value,
          fields,
        };

        count++;
      } catch {
        // Skip documents that fail to parse
        // This can happen if the protobuf is corrupted or uses an unknown format
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

    const { collection: filterCollection, keyPrefix, limit } = options;
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

      if (filterCollection) {
        const isMatch =
          parsed.collection === filterCollection ||
          parsed.collection.endsWith(`/${filterCollection}`);
        if (!isMatch) {
          continue;
        }
      }

      try {
        const fields = parseFirestoreDocument(value);

        yield {
          key,
          collection: parsed.collection,
          documentId: parsed.documentId,
          rawValue: value,
          fields,
        };

        count++;
      } catch {
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
