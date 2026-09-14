/**
 * A one-test `bun test` run that strands a LevelDB temp copy (#642).
 *
 * Deliberately NOT named `*.test.ts`: `bun test` only collects files whose
 * names contain `.test`, `_test_`, `.spec` or `_spec_`, so the normal suite
 * never picks this up. `tests/core/temp-db-suite-teardown.test.ts` runs it on
 * purpose, as a child process with a private `$TMPDIR`, via
 * `bun test ./tests/fixtures/temp-db-leak-probe.ts` — the leading `./` is what
 * makes bun treat the argument as a path rather than a name filter.
 *
 * It reads a fixture database once per process that makes temp copies:
 *   - `iterateDocuments` on the main thread, the path every cache read takes.
 *     It cleans up nothing — no `cleanupAllTempDatabases()` in an `afterAll`,
 *     exactly like the test files that motivated the run-wide teardown — so
 *     whether that copy is on disk once the child exits is what the parent
 *     measures. This file must therefore never grow a cleanup hook of its own.
 *   - `decodeAllCollectionsIsolated`, which decodes in a WORKER thread. Its
 *     module instance has its own temp-copy cache that no teardown on the main
 *     thread can reach, so the worker has to sweep for itself; that one is
 *     asserted here, in-process, because it is observable the moment the
 *     decode resolves.
 */

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDatabase, iterateDocuments } from '../../src/core/leveldb-reader.js';
import { decodeAllCollectionsIsolated } from '../../src/core/decoder.js';

// Firestore-shaped opaque ids: a fixture whose id equals its name can mask a
// resolution bug (#461), and this file is copied from as often as it is read.
const TXN_ID = 'Yk3QpZ7mVt2LhRs9Nc4B';
const ACCOUNT_ID = 'Ax8DfJ1rQw6TnP0ZmE5v';

/** `copilot-leveldb-*` directories in this child's private TMPDIR, right now. */
function copiesInTmp(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('copilot-leveldb-'));
}

/** One fixture database, reused by both probes below. */
async function makeDb(): Promise<string> {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-db-leak-probe-src-'));
  await createTestDatabase(src, [
    {
      collection: 'transactions',
      id: TXN_ID,
      fields: {
        transaction_id: TXN_ID,
        account_id: ACCOUNT_ID,
        amount: 100,
        date: '2026-01-15',
        name: 'probe',
      },
    },
  ]);
  return src;
}

test('main thread: reads through a temp copy, and cleans up nothing', async () => {
  const src = await makeDb();

  const seen: string[] = [];
  for await (const doc of iterateDocuments(src, { collection: 'transactions' })) {
    seen.push(doc.documentId);
  }

  // Not the point of the probe, but a read that returned nothing would also
  // make a temp copy, and then a green child would prove less than it looks.
  expect(seen).toEqual([TXN_ID]);
});

test('worker thread: sweeps its own temp copy before it hands back the result', async () => {
  const src = await makeDb();
  const before = new Set(copiesInTmp());
  const decoded = await decodeAllCollectionsIsolated(src);

  // A decode that returned nothing would still have made a copy, and the
  // assertion below would then pass while proving nothing.
  expect(decoded.transactions.length).toBe(1);

  // Nothing in the parent can reclaim a worker's copy — separate isolate,
  // separate temp-copy cache, and the run-wide teardown only ever sees this
  // thread's. The worker sweeps inside its `finally`, BEFORE postMessage, so
  // the copy is already gone the instant this promise resolves. Asserting here
  // rather than after the child exits is what makes it deterministic: put the
  // sweep after the postMessage instead and a bun worker is routinely torn
  // down mid-statement, which is a race, not a guarantee.
  expect(
    copiesInTmp().filter((name) => !before.has(name)),
    'The decode worker left its temp copy behind. src/core/decode-worker.ts must call ' +
      'cleanupAllTempDatabases() before it posts the result (#642).'
  ).toEqual([]);
});
