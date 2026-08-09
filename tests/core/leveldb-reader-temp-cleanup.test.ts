/**
 * Regression tests for temp-copy lifetime (issue #631).
 *
 * `copyDatabaseToTemp` copies the LevelDB into `os.tmpdir()` and
 * `releaseTempDatabase` only SCHEDULES cleanup (TEMP_DB_CACHE_TTL). Because the
 * server usually runs as a short-lived per-request process — and decoding runs
 * in a worker thread that exits as soon as it posts its result — that timer
 * almost never fires, and pending timers are dropped on exit. Every temp copy
 * was therefore orphaned (366 dirs / ~33 GB observed in the wild).
 *
 * These tests assert the property that actually matters and that a same-process
 * unit test cannot observe: once the reading PROCESS is gone, no temp copy is
 * left behind. Each child runs with its own TMPDIR so the assertion is exact and
 * can never collide with a concurrently running server's copies.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createTestDatabase } from '../../src/core/leveldb-reader.js';

const FIXTURES_DIR = path.join(__dirname, '../fixtures/leveldb-temp-cleanup');
const READER_MODULE = path.resolve(__dirname, '../../src/core/leveldb-reader.ts');

/** Temp copies visible in an isolated TMPDIR. */
function tempCopies(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.startsWith('copilot-leveldb-'));
}

/**
 * Write a child entrypoint that performs one full read of `dbPath`.
 * When `keepAlive` is set it stays running afterwards so the parent can signal it.
 */
function writeChildScript(file: string, keepAlive: boolean): void {
  fs.writeFileSync(
    file,
    [
      `import { iterateDocuments } from ${JSON.stringify(READER_MODULE)};`,
      `const dbPath = process.argv[2];`,
      `for await (const _doc of iterateDocuments(dbPath)) {`,
      `  // drain`,
      `}`,
      `console.log('read-complete');`,
      keepAlive ? `setInterval(() => {}, 1000);` : ``,
    ].join('\n')
  );
}

/** Resolve once the child prints its ready marker. */
function whenReady(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    let buf = '';
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      if (buf.includes('read-complete')) resolve();
    });
  });
}

/** Poll until `predicate` holds, so the async sweep needs no fixed sleep. */
async function waitUntil(predicate: () => boolean, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

/** Create a directory that looks like a temp copy, aged `ageMs` into the past. */
function makeFakeCopy(tmpdir: string, name: string, ageMs: number): string {
  const dir = path.join(tmpdir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n');
  const stamp = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, stamp, stamp);
  return dir;
}

describe('temp database copies do not outlive the reading process (issue #631)', () => {
  beforeEach(() => {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
  });

  test('nothing is left behind when the reading process exits normally', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'exit-db');
    await createTestDatabase(dbPath, [{ collection: 'test', id: 'doc1', fields: { x: 1 } }]);

    const tmpdir = path.join(FIXTURES_DIR, 'tmp-normal-exit');
    fs.mkdirSync(tmpdir, { recursive: true });

    const script = path.join(FIXTURES_DIR, 'read-once.ts');
    writeChildScript(script, false);

    const child = spawn(process.execPath, [script, dbPath], {
      env: { ...process.env, TMPDIR: tmpdir },
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    const code = await new Promise<number>((resolve) =>
      child.on('exit', (c) => resolve(c ?? 0))
    );

    // The read must have succeeded — otherwise "no temp copy" is vacuously true.
    expect(code).toBe(0);
    expect(tempCopies(tmpdir)).toEqual([]);
  }, 60000);

  test('nothing is left behind when the reading process is terminated by a signal', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'signal-db');
    await createTestDatabase(dbPath, [{ collection: 'test', id: 'doc1', fields: { x: 1 } }]);

    const tmpdir = path.join(FIXTURES_DIR, 'tmp-signal-exit');
    fs.mkdirSync(tmpdir, { recursive: true });

    const script = path.join(FIXTURES_DIR, 'read-and-wait.ts');
    writeChildScript(script, true);

    const child = spawn(process.execPath, [script, dbPath], {
      env: { ...process.env, TMPDIR: tmpdir },
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    // Wait until the copy definitely exists, so the assertion is meaningful.
    await whenReady(child);
    expect(tempCopies(tmpdir).length).toBe(1);

    // How an MCP client stops the server.
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));

    expect(tempCopies(tmpdir)).toEqual([]);
  }, 60000);
});

describe('orphan sweep reclaims copies stranded by earlier versions (issue #631)', () => {
  beforeEach(() => {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
  });

  test('sweeps idle orphans, keeps recent copies and unrelated directories', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'sweep-db');
    await createTestDatabase(dbPath, [{ collection: 'test', id: 'doc1', fields: { x: 1 } }]);

    const tmpdir = path.join(FIXTURES_DIR, 'tmp-sweep');
    fs.mkdirSync(tmpdir, { recursive: true });

    // Two hours idle: what a process killed before the fix leaves behind.
    const staleA = makeFakeCopy(tmpdir, 'copilot-leveldb-staleA', 2 * 60 * 60 * 1000);
    const staleB = makeFakeCopy(tmpdir, 'copilot-leveldb-staleB', 2 * 60 * 60 * 1000);
    // Recently touched: another live process may still be reading it.
    const recent = makeFakeCopy(tmpdir, 'copilot-leveldb-recent', 0);
    // Not ours: must never be touched, however old.
    const foreign = makeFakeCopy(tmpdir, 'some-other-tool-cache', 2 * 60 * 60 * 1000);

    const script = path.join(FIXTURES_DIR, 'read-and-wait-sweep.ts');
    writeChildScript(script, true);

    const child = spawn(process.execPath, [script, dbPath], {
      env: { ...process.env, TMPDIR: tmpdir },
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    await whenReady(child);
    const swept = await waitUntil(() => !fs.existsSync(staleA) && !fs.existsSync(staleB));

    const recentSurvived = fs.existsSync(recent);
    const foreignSurvived = fs.existsSync(foreign);

    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));

    expect(swept).toBe(true);
    expect(recentSurvived).toBe(true);
    expect(foreignSurvived).toBe(true);

    // And the child's own copy is still cleaned up on exit.
    expect(tempCopies(tmpdir)).toEqual(['copilot-leveldb-recent']);
  }, 60000);

  test('sweep is disabled by COPILOT_MCP_NO_TEMP_SWEEP', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'no-sweep-db');
    await createTestDatabase(dbPath, [{ collection: 'test', id: 'doc1', fields: { x: 1 } }]);

    const tmpdir = path.join(FIXTURES_DIR, 'tmp-no-sweep');
    fs.mkdirSync(tmpdir, { recursive: true });
    const stale = makeFakeCopy(tmpdir, 'copilot-leveldb-staleA', 2 * 60 * 60 * 1000);

    const script = path.join(FIXTURES_DIR, 'read-once-no-sweep.ts');
    writeChildScript(script, false);

    const child = spawn(process.execPath, [script, dbPath], {
      env: { ...process.env, TMPDIR: tmpdir, COPILOT_MCP_NO_TEMP_SWEEP: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));

    expect(fs.existsSync(stale)).toBe(true);
  }, 60000);
});
