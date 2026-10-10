/**
 * The LevelDB snapshot copy survives a retryable interrupt (#774).
 *
 * The instance: `bun run smoke:cache` under concurrent load crashed with
 * `EINTR: interrupted system call, copyfile '…/001800.ldb' -> '…/T/copilot-
 * leveldb-…'`. The copy loop's catch skipped `ENOENT` (compaction TOCTOU) and
 * rethrew everything else, so one interrupted `copyFileSync` failed the whole
 * read — every cache-mode tool, not one file. `EINTR` means "reissue me"; the
 * copy would have succeeded on the next attempt.
 *
 * Each test swaps one `fs` function on the shared default-export object (the
 * one `leveldb-reader.ts` calls through) for a wrapper that throws an
 * EINTR-shaped error for the first N calls touching the fixture, then
 * delegates. TMPDIR points at an empty directory so "nothing was left behind"
 * is exact.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  createTestDatabase,
  iterateDocuments,
  cleanupAllTempDatabases,
} from '../../src/core/leveldb-reader.js';
import { MAX_INTERRUPT_ATTEMPTS } from '../../src/core/fs-retry.js';

type FsFn = 'copyFileSync' | 'readdirSync' | 'mkdtempSync' | 'statSync';

let root: string;
let dbPath: string;
let tmpdir: string;
let originalTmpdir: string | undefined;
const restores: Array<() => void> = [];

function eintr(syscall: string, p: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`EINTR: interrupted system call, ${syscall} '${p}'`);
  err.code = 'EINTR';
  err.syscall = syscall;
  return err;
}

/**
 * Make `fs[name]` throw EINTR for its first `failures` calls whose first
 * argument lies under `under`, then behave normally. Returns a counter of the
 * interrupts actually delivered, so a test can prove the fault was reached.
 */
function interrupt(name: FsFn, under: string, failures: number): () => number {
  const target = fs as unknown as Record<FsFn, (...args: unknown[]) => unknown>;
  const original = target[name];
  let delivered = 0;
  target[name] = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'string' && first.startsWith(under) && delivered < failures) {
      delivered++;
      throw eintr(name.replace(/Sync$/, '').toLowerCase(), first);
    }
    return original.apply(fs, args);
  };
  restores.push(() => {
    target[name] = original;
  });
  return () => delivered;
}

async function drain(p: string): Promise<number> {
  let n = 0;
  for await (const _doc of iterateDocuments(p)) n++;
  return n;
}

function tempCopies(): string[] {
  return fs.readdirSync(tmpdir).filter((name) => name.startsWith('copilot-leveldb-'));
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eintr-reader-'));
  dbPath = path.join(root, 'db');
  tmpdir = path.join(root, 'tmp');
  fs.mkdirSync(tmpdir);
  await createTestDatabase(dbPath, [
    { collection: 'test', id: 'doc1', fields: { x: 1 } },
    { collection: 'test', id: 'doc2', fields: { x: 2 } },
  ]);
  originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = tmpdir;
});

afterEach(() => {
  while (restores.length) restores.pop()!();
  cleanupAllTempDatabases();
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('LevelDB snapshot copy under EINTR (#774)', () => {
  // Every syscall the snapshot path makes against the source or the temp root.
  // `mkdtempSync`'s argument is the temp prefix, so its fault is keyed on TMPDIR.
  const cases: Array<{ name: FsFn; under: () => string }> = [
    { name: 'copyFileSync', under: () => dbPath },
    { name: 'readdirSync', under: () => dbPath },
    { name: 'statSync', under: () => dbPath },
    { name: 'mkdtempSync', under: () => tmpdir },
  ];

  test.each(cases)(
    '$name: interrupts that clear are reissued and the read completes',
    async (c) => {
      const delivered = interrupt(c.name, c.under(), MAX_INTERRUPT_ATTEMPTS - 1);
      expect(await drain(dbPath)).toBe(2);
      // The fault was actually on the path — a test that never reached it would
      // pass with the retry deleted.
      expect(delivered()).toBeGreaterThan(0);
    }
  );

  test.each(cases)(
    '$name: an interrupt that never clears still fails, bounded, and leaves no temp copy',
    async (c) => {
      const delivered = interrupt(c.name, c.under(), Number.POSITIVE_INFINITY);
      await expect(drain(dbPath)).rejects.toThrow('EINTR');
      // Bounded: the first site to hit the fault gave up after exactly the
      // bound — not one attempt (no retry) and not forever.
      expect(delivered()).toBe(MAX_INTERRUPT_ATTEMPTS);
      expect(tempCopies()).toEqual([]);
    }
  );
});
