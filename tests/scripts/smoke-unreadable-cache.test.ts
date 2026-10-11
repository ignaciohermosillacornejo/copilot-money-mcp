/**
 * A smoke that could not READ the cache must not report "no cache" (#774).
 *
 * `smoke:cache` printed `no-cache-found … This is not a failure` and exited 0,
 * and `smoke:account-names` printed SKIP, whenever `isAvailable()` was false —
 * which included a cache that exists and could not be read. Both now ask
 * `availability()` and fail when it carries a lookup error.
 *
 * Both checks live in each script's module-private `main()`, so they are run
 * the way a person runs them: as a child process, with HOME pointed at a
 * synthetic home. In the unreadable case the Firestore directory exists with
 * mode 000, so discovery's readdir fails with EACCES; in the absent case the
 * home is empty. Neither reaches the user's real container.
 *
 * Only EACCES, deliberately. An EINTR is a signal arriving mid-syscall in the
 * child, which a test cannot induce from outside the process; the in-process
 * fault injection in tests/core/database-discovery.test.ts covers the
 * retryable path instead, including `getDbPath()` re-looking, which is what
 * `smoke:cache` reads.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIRESTORE =
  'Library/Containers/com.copilot.production/Data/Library/Application Support/firestore/__FIRAPP_DEFAULT';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-unreadable-'));
});

afterEach(() => {
  const firestore = path.join(home, FIRESTORE);
  if (fs.existsSync(firestore)) fs.chmodSync(firestore, 0o755);
  fs.rmSync(home, { recursive: true, force: true });
});

function makeUnreadable(): void {
  const firestore = path.join(home, FIRESTORE);
  fs.mkdirSync(firestore, { recursive: true });
  fs.chmodSync(firestore, 0o000);
}

function run(script: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, ['run', script], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stderr: result.stderr };
}

describe('smoke scripts tell "could not read" from "no cache"', () => {
  test('control: the synthetic home really is unreadable to this process', () => {
    makeUnreadable();
    // If the suite runs as a user that bypasses mode bits, the cases below
    // would test nothing; fail here rather than pass vacuously there.
    expect(() => fs.readdirSync(path.join(home, FIRESTORE))).toThrow();
  });

  test('smoke:cache fails on an unreadable cache instead of reporting nothing to check', () => {
    makeUnreadable();
    const { status, stderr } = run('scripts/smoke/cache.ts');
    expect(stderr).toContain('cache-unreadable');
    expect(stderr).toContain('EACCES');
    expect(stderr).not.toContain('no-cache-found');
    expect(status).toBe(1);
  }, 90_000);

  test('smoke:cache still reports no-cache-found, exit 0, for a home with no cache', () => {
    const { status, stderr } = run('scripts/smoke/cache.ts');
    expect(stderr).toContain('no-cache-found');
    expect(status).toBe(0);
  }, 90_000);

  test('smoke:account-names fails on an unreadable cache instead of SKIP', () => {
    makeUnreadable();
    const { status, stderr } = run('scripts/smoke/account-names.ts');
    expect(stderr).toContain('FAIL account-name parity');
    expect(stderr).toContain('EACCES');
    expect(stderr).not.toContain('SKIP');
    expect(status).toBe(1);
  }, 90_000);

  test('smoke:account-names still SKIPs for a home with no cache', () => {
    const { status, stderr } = run('scripts/smoke/account-names.ts');
    expect(stderr).toContain('SKIP account-name parity');
    expect(status).toBe(0);
  }, 90_000);
});
