#!/usr/bin/env bun
/**
 * Decode coverage report — measures what % of the LevelDB we actually decode.
 *
 * Iterates every document in the database, groups by collection path pattern,
 * and reports decoded vs undecoded counts.
 *
 * Usage: bun run scripts/decode-coverage.ts [--db-path=/path/to/db]
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { iterateDocuments } from '../src/core/leveldb-reader.js';
import { routeCollection } from '../src/core/decoder.js';
import { retryInterrupted } from '../src/core/fs-retry.js';

function findRealDatabase(): string | undefined {
  const home = homedir();
  const containerBase = join(
    home,
    'Library/Containers/com.copilot.production/Data/Library/Application Support'
  );

  if (!existsSync(containerBase)) return undefined;

  const firestorePath = join(containerBase, 'firestore/__FIRAPP_DEFAULT');
  if (!existsSync(firestorePath)) return undefined;

  const entries = retryInterrupted(() => readdirSync(firestorePath, { withFileTypes: true }));
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('copilot-')) {
      const mainPath = join(firestorePath, entry.name, 'main');
      if (existsSync(mainPath)) {
        return mainPath;
      }
    }
  }

  return undefined;
}

/**
 * Get database size in MB.
 * LevelDB keeps all .ldb/.sst files flat in the directory — no subdirectory traversal needed.
 */
function getDatabaseSizeMB(dbPath: string): number {
  let totalSize = 0;
  const files = retryInterrupted(() => readdirSync(dbPath));
  for (const file of files) {
    const filePath = join(dbPath, file);
    const stat = retryInterrupted(() => statSync(filePath));
    if (stat.isFile()) {
      totalSize += stat.size;
    }
  }
  return totalSize / (1024 * 1024);
}

/**
 * Normalize a collection path to a pattern for grouping.
 * Strips the Firestore prefix (projects/.../documents/) if present,
 * then replaces specific IDs (odd-indexed path segments) with '*'.
 */
function normalizeCollectionPath(collection: string): string {
  const docsIdx = collection.indexOf('/documents/');
  const stripped = docsIdx >= 0 ? collection.slice(docsIdx + '/documents/'.length) : collection;

  const parts = stripped.split('/');
  return parts.map((part, i) => (i % 2 === 1 ? '*' : part)).join('/');
}

/**
 * Would `decodeAllCollections` route a document in this raw collection path?
 *
 * Asks the decoder's own `routeCollection` (#778). This used to be a
 * hand-mirrored copy of the dispatch chain behind a "keep this in sync"
 * comment, and it had drifted: it still accepted the `items/{id}`
 * parent-pointer clause #627 removed from the decoder, and matched
 * `investment_prices/` anywhere in the path where the decoder anchors it at
 * the root. A coverage figure computed from a copy measures the copy.
 */
function isDecoded(rawCollection: string): boolean {
  return routeCollection(rawCollection) !== null;
}

function parseDbPath(): string | undefined {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--db-path=')) {
      return arg.split('=')[1];
    }
  }
  return undefined;
}

async function main() {
  const dbPath = parseDbPath() ?? findRealDatabase();
  if (!dbPath) {
    console.error('Could not find Copilot Money database. Use --db-path=/path/to/db');
    process.exit(1);
  }

  const sizeMB = getDatabaseSizeMB(dbPath);
  console.log(`Database: ${dbPath}`);
  console.log(`Database size: ${sizeMB.toFixed(1)} MB\n`);

  // Count documents by raw collection path
  const rawCounts = new Map<string, number>();
  let totalDocs = 0;

  console.log('Scanning all documents...');
  const start = Date.now();

  for await (const doc of iterateDocuments(dbPath)) {
    totalDocs++;
    rawCounts.set(doc.collection, (rawCounts.get(doc.collection) ?? 0) + 1);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Scanned ${totalDocs.toLocaleString()} documents in ${elapsed}s\n`);

  // Categorize by checking isDecoded against raw paths, then aggregate by normalized pattern
  const decodedByPattern = new Map<string, number>();
  const undecodedByPattern = new Map<string, number>();
  let decodedDocs = 0;
  let undecodedDocs = 0;

  for (const [rawPath, count] of rawCounts.entries()) {
    const pattern = normalizeCollectionPath(rawPath);
    if (isDecoded(rawPath)) {
      decodedDocs += count;
      decodedByPattern.set(pattern, (decodedByPattern.get(pattern) ?? 0) + count);
    } else {
      undecodedDocs += count;
      undecodedByPattern.set(pattern, (undecodedByPattern.get(pattern) ?? 0) + count);
    }
  }

  const decodedCollections = [...decodedByPattern.entries()].sort((a, b) => b[1] - a[1]);
  const undecodedCollections = [...undecodedByPattern.entries()].sort((a, b) => b[1] - a[1]);

  const pct = totalDocs > 0 ? ((decodedDocs / totalDocs) * 100).toFixed(1) : '0.0';

  // Report
  console.log('='.repeat(70));
  console.log(
    `DECODE COVERAGE: ${decodedDocs.toLocaleString()} / ${totalDocs.toLocaleString()} documents (${pct}%)`
  );
  console.log('='.repeat(70));

  console.log(
    `\nDECODED (${decodedCollections.length} collection patterns, ${decodedDocs.toLocaleString()} docs):`
  );
  for (const [pattern, count] of decodedCollections) {
    console.log(`  ${count.toString().padStart(8)}  ${pattern}`);
  }

  console.log(
    `\nNOT DECODED (${undecodedCollections.length} collection patterns, ${undecodedDocs.toLocaleString()} docs):`
  );
  for (const [pattern, count] of undecodedCollections) {
    console.log(`  ${count.toString().padStart(8)}  ${pattern}`);
  }

  const totalPatterns = decodedCollections.length + undecodedCollections.length;
  console.log(`\n${'='.repeat(70)}`);
  console.log(
    `Collections: ${totalPatterns} total | ${decodedCollections.length} decoded | ${undecodedCollections.length} remaining`
  );
  console.log(
    `Documents:   ${totalDocs.toLocaleString()} total | ${decodedDocs.toLocaleString()} decoded (${pct}%) | ${undecodedDocs.toLocaleString()} remaining`
  );
}

if (import.meta.main) main().catch(console.error);
