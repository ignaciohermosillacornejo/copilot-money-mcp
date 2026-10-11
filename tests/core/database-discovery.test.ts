/**
 * Database discovery under EINTR, and "could not look" vs "looked, absent"
 * (#774, second site).
 *
 * Measured during #756: ~1 in 1,000 `readdirSync` calls against the live
 * Copilot container blocked for seconds and threw `EINTR`. Both `catch` blocks
 * in discovery swallowed it and fell through to "no database", so the user was
 * told "Database not found. Please ensure Copilot Money is installed and has
 * synced data." — a transient interrupt reported as a configuration problem.
 *
 * Two halves, two describes: the interrupt is reissued (so it almost never
 * matters), and when it does not clear, the result says "could not determine"
 * instead of collapsing into "absent".
 *
 * Every test runs against a synthetic home directory. Nothing here touches the
 * real container — that dependence is what #756 removed from the suite.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  CopilotDatabase,
  discoverCopilotDatabase,
  missingDatabaseError,
} from '../../src/core/database.js';
import { MAX_INTERRUPT_ATTEMPTS } from '../../src/core/fs-retry.js';
import { CopilotMoneyServer } from '../../src/server.js';
import { createTestDatabase } from '../../src/core/leveldb-reader.js';

const FIRESTORE =
  'Library/Containers/com.copilot.production/Data/Library/Application Support/firestore/__FIRAPP_DEFAULT';
const DB_DIR_NAME = 'copilot-production-00000.copilot-production-firestore';

let home: string;
let mainPath: string;
const restores: Array<() => void> = [];

function eintr(p: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`EINTR: interrupted system call, scandir '${p}'`);
  err.code = 'EINTR';
  err.syscall = 'scandir';
  return err;
}

function eacces(p: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`EACCES: permission denied, scandir '${p}'`);
  err.code = 'EACCES';
  err.syscall = 'scandir';
  return err;
}

/** `fs.readdirSync` throws EINTR for its first `failures` calls under `home`. */
function interruptReaddir(failures: number): () => number {
  const original = fs.readdirSync;
  let delivered = 0;
  (fs as { readdirSync: unknown }).readdirSync = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'string' && first.startsWith(home) && delivered < failures) {
      delivered++;
      throw eintr(first);
    }
    return (original as (...a: unknown[]) => unknown).apply(fs, args);
  };
  restores.push(() => {
    (fs as { readdirSync: unknown }).readdirSync = original;
  });
  return () => delivered;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-home-'));
  mainPath = path.join(home, FIRESTORE, DB_DIR_NAME, 'main');
  fs.mkdirSync(mainPath, { recursive: true });
  fs.writeFileSync(path.join(mainPath, '000001.ldb'), '');
});

afterEach(() => {
  while (restores.length) restores.pop()!();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('discoverCopilotDatabase: interrupts are reissued', () => {
  test('control: with no fault the synthetic database is found', () => {
    expect(discoverCopilotDatabase(home)).toEqual({ path: mainPath });
  });

  test('a readdir interrupt that clears does not lose the database', () => {
    const delivered = interruptReaddir(MAX_INTERRUPT_ATTEMPTS - 1);
    expect(discoverCopilotDatabase(home)).toEqual({ path: mainPath });
    expect(delivered()).toBe(MAX_INTERRUPT_ATTEMPTS - 1);
  });
});

describe('discoverCopilotDatabase: "could not look" is not "absent"', () => {
  test('an interrupt that never clears is reported as a lookup error, not as absence', () => {
    interruptReaddir(Number.POSITIVE_INFINITY);
    const result = discoverCopilotDatabase(home);
    expect(result.path).toBeUndefined();
    expect((result.lookupError as NodeJS.ErrnoException | undefined)?.code).toBe('EINTR');
  });

  test('a home with no Copilot container is plain absence — no lookup error', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-empty-'));
    try {
      expect(discoverCopilotDatabase(empty)).toEqual({ path: undefined });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('existsSync is not consulted, so an interrupted existence check cannot read as absence', () => {
    // existsSync reports ANY error as false. If discovery gated its reads on it,
    // an interrupt there would skip the retried readdir and say "absent".
    const original = fs.existsSync;
    (fs as { existsSync: unknown }).existsSync = () => false;
    restores.push(() => {
      (fs as { existsSync: unknown }).existsSync = original;
    });
    expect(discoverCopilotDatabase(home)).toEqual({ path: mainPath });
  });

  test('a container with no LevelDB files is plain absence — no lookup error', () => {
    fs.rmSync(path.join(mainPath, '000001.ldb'));
    expect(discoverCopilotDatabase(home)).toEqual({ path: undefined });
  });
});

describe('missingDatabaseError', () => {
  test('with no lookup error it is the not-installed message', () => {
    expect(missingDatabaseError(undefined).message).toBe(
      'Database not found. Please ensure Copilot Money is installed and has synced data.'
    );
  });

  test('with a lookup error it says the lookup failed, and does not tell the user to install or sync', () => {
    const message = missingDatabaseError(eintr('/synthetic/main')).message;
    expect(message).toContain('EINTR');
    expect(message).toContain('transient');
    expect(message).not.toContain('ensure Copilot Money is installed');
  });

  test('a non-retryable lookup error is not called transient', () => {
    const message = missingDatabaseError(eacces('/synthetic/main')).message;
    expect(message).toContain('EACCES from scandir');
    expect(message).not.toContain('transient');
    expect(message).not.toContain('ensure Copilot Money is installed');
  });

  test('the message names the errno, never the path (it reaches the MCP client)', () => {
    for (const err of [eintr('/synthetic/home/user/main'), eacces('/synthetic/home/user/main')]) {
      expect(missingDatabaseError(err).message).not.toContain('/synthetic');
    }
  });

  test('a non-retryable error does not assume the default container (an explicit path gets it too)', () => {
    expect(missingDatabaseError(eacces('/synthetic/custom')).message).toContain(
      'custom database path'
    );
  });

  test('a non-errno error keeps its message, with paths scrubbed', () => {
    const message = missingDatabaseError(
      new Error("unexpected shape under '/synthetic/home/user/main'")
    ).message;
    expect(message).toContain('unexpected shape under');
    expect(message).not.toContain('/synthetic');
  });

  test('a quoted path with spaces is scrubbed whole, not up to the first space', () => {
    const message = missingDatabaseError(
      new Error("unexpected shape under '/synthetic/user/Application Support/main' here")
    ).message;
    expect(message).toContain('unexpected shape under <path> here');
    expect(message).not.toContain('Support');
  });

  test('a reader whose discovery failed rejects with the lookup-failed message', async () => {
    // Constructed WITH a path so nothing walks a real home; the discovery
    // outcome is then set the way the no-path constructor would set it.
    const db = new CopilotDatabase('/synthetic/placeholder');
    const internals = db as unknown as { dbPath?: string; discoveryError?: Error };
    internals.dbPath = undefined;
    internals.discoveryError = eintr('/synthetic/main');
    await expect(db.getAccounts()).rejects.toThrow('transient');
  });
});

describe('availability: "could not look" survives to the server dispatch gate', () => {
  test('an explicit path that cannot be read reports the lookup error, not absence', () => {
    interruptReaddir(Number.POSITIVE_INFINITY);
    const result = new CopilotDatabase(mainPath).availability();
    expect(result.available).toBe(false);
    expect((result.lookupError as NodeJS.ErrnoException | undefined)?.code).toBe('EINTR');
  });

  test('an explicit path that does not exist is plain absence', () => {
    const result = new CopilotDatabase(path.join(home, 'nope')).availability();
    expect(result).toEqual({ available: false });
  });

  test('an interrupt that clears leaves the database available', () => {
    interruptReaddir(MAX_INTERRUPT_ATTEMPTS - 1);
    expect(new CopilotDatabase(mainPath).availability()).toEqual({ available: true });
  });

  test('a cache-mode tool call relays the lookup failure instead of the install advice', async () => {
    // Through handleCallTool, not the database directly: the dispatch gate in
    // src/server.ts answers before any read method runs, so a test that called
    // db.getAccounts() would pass while the user still saw the install advice.
    const server = new CopilotMoneyServer(mainPath);
    interruptReaddir(Number.POSITIVE_INFINITY);
    const response = await server.handleCallTool('get_accounts', {});
    const text = response.content[0]?.text ?? '';
    expect(response.isError).toBe(true);
    expect(text).toContain('EINTR');
    expect(text).not.toContain('ensure Copilot Money is installed');
  });

  test('the dispatch gate checks once, so a permanent interrupt pays the bound once', async () => {
    // isAvailable() followed by availability() ran the retried readdir twice —
    // twice the bound on the slow path, and a window where the two disagree.
    const server = new CopilotMoneyServer(mainPath);
    const delivered = interruptReaddir(Number.POSITIVE_INFINITY);
    await server.handleCallTool('get_accounts', {});
    expect(delivered()).toBe(MAX_INTERRUPT_ATTEMPTS);
  });

  test('a failed no-path discovery reaches the client the same way', async () => {
    const server = new CopilotMoneyServer(mainPath);
    const db = (server as unknown as { db: CopilotDatabase }).db;
    const internals = db as unknown as { dbPath?: string; discoveryError?: Error };
    internals.dbPath = undefined;
    internals.discoveryError = eintr('/synthetic/main');
    const text = (await server.handleCallTool('get_accounts', {})).content[0]?.text ?? '';
    expect(text).toContain('EINTR');
    expect(text).not.toContain('ensure Copilot Money is installed');
  });

  test('control: genuine absence still gets the install advice', async () => {
    const server = new CopilotMoneyServer(path.join(home, 'nope'));
    const text = (await server.handleCallTool('get_accounts', {})).content[0]?.text ?? '';
    expect(text).toContain('ensure Copilot Money is installed');
  });
});

describe('a retryable discovery failure is looked at again, not served from memory', () => {
  /**
   * The no-path constructor runs discovery once. If that hit an interrupt past
   * the bound, the error used to be stored and returned on every later call
   * with no syscall — so the message's own advice, "retry the request", could
   * never change the answer; only a restart could.
   *
   * Driven through `handleCallTool`, twice. The discovery outcome is set the way
   * the no-path constructor sets it, with `discoveryHome` pointed at the
   * synthetic home, so nothing here walks the real container.
   */
  async function serverWithFailedDiscovery(err: Error): Promise<CopilotMoneyServer> {
    fs.rmSync(mainPath, { recursive: true, force: true });
    await createTestDatabase(mainPath, [{ collection: 'test', id: 'doc1', fields: { x: 1 } }]);
    const server = new CopilotMoneyServer(mainPath);
    const db = (server as unknown as { db: CopilotDatabase }).db;
    const internals = db as unknown as {
      dbPath?: string;
      discoveryError?: Error;
      discoveryHome?: string;
    };
    internals.dbPath = undefined;
    internals.discoveryError = err;
    internals.discoveryHome = home;
    return server;
  }

  test('once the interrupt clears, retrying the request finds the database', async () => {
    const server = await serverWithFailedDiscovery(eintr('/synthetic/main'));
    // The first re-look is itself interrupted past the bound: still unavailable.
    interruptReaddir(MAX_INTERRUPT_ATTEMPTS);
    const first = (await server.handleCallTool('get_accounts', {})).content[0]?.text ?? '';
    expect(first).toContain('EINTR');
    // The interrupt has cleared. Retrying — what the message said to do — works.
    const second = await server.handleCallTool('get_accounts', {});
    expect(second.content[0]?.text ?? '').not.toContain('Database not available');
  });

  test('a persistent error is served from memory, not re-walked on every call', async () => {
    const server = await serverWithFailedDiscovery(eacces('/synthetic/main'));
    const delivered = interruptReaddir(Number.POSITIVE_INFINITY);
    const text = (await server.handleCallTool('get_accounts', {})).content[0]?.text ?? '';
    // Its message says to fix permissions; re-walking would not change that.
    expect(text).toContain('EACCES');
    expect(delivered()).toBe(0);
  });
});
