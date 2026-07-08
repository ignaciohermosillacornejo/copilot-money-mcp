/**
 * Persistent per-uid transaction meta index (#511). Append-only JSONL,
 * identity-scoped, crash-tolerant, never fails the caller.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TransactionMetaStore } from '../../../src/core/persistence/transaction-meta-store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'meta-store-'));
  delete process.env.COPILOT_DISABLE_PERSISTENT_INDEX;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.COPILOT_DISABLE_PERSISTENT_INDEX;
});

const uid = (u: string | null) => () => u;
const META = { accountId: 'acct-1', itemId: 'item-1' };

function fileFor(u: string): string {
  return join(dir, `txn-meta-index.${u}.jsonl`);
}

describe('TransactionMetaStore', () => {
  test('round-trip: buffered+flushed entries hydrate in a fresh instance', () => {
    const a = new TransactionMetaStore({ baseDir: dir, uidProvider: uid('userA') });
    a.loadOnce();
    a.buffer('t1', META);
    a.buffer('t2', { accountId: 'acct-2', itemId: 'item-2' });
    a.flush();

    const b = new TransactionMetaStore({ baseDir: dir, uidProvider: uid('userA') });
    const hydrated = b.loadOnce();
    expect(hydrated.get('t1')).toEqual(META);
    expect(hydrated.get('t2')).toEqual({ accountId: 'acct-2', itemId: 'item-2' });
  });

  test('identity isolation: uid A entries invisible to uid B', () => {
    const a = new TransactionMetaStore({ baseDir: dir, uidProvider: uid('userA') });
    a.loadOnce();
    a.buffer('t1', META);
    a.flush();

    const b = new TransactionMetaStore({ baseDir: dir, uidProvider: uid('userB') });
    expect(b.loadOnce().size).toBe(0);
  });

  test('no uid: fully inert (no file created, no load, buffered entries flush later)', () => {
    let current: string | null = null;
    const s = new TransactionMetaStore({ baseDir: dir, uidProvider: () => current });
    expect(s.loadOnce().size).toBe(0);
    s.buffer('t1', META);
    s.flush();
    expect(existsSync(fileFor('userA'))).toBe(false);

    current = 'userA';
    s.flush(); // uid now known — buffered entry lands
    const b = new TransactionMetaStore({ baseDir: dir, uidProvider: uid('userA') });
    expect(b.loadOnce().get('t1')).toEqual(META);
  });

  test('torn last line: valid prefix loads, no crash', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      fileFor('userA'),
      '{"i":"t1","a":"acct-1","t":"item-1"}\n{"i":"t2","a":"acc' // torn
    );
    const s = new TransactionMetaStore({ baseDir: dir, uidProvider: uid('userA') });
    const origWarn = console.warn;
    console.warn = () => {};
    let m: ReturnType<typeof s.loadOnce>;
    try {
      m = s.loadOnce();
    } finally {
      console.warn = origWarn;
    }
    expect(m!.get('t1')).toEqual(META);
    expect(m!.has('t2')).toBe(false);
  });

  test('corrupt file: warn + start fresh, no crash', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(fileFor('userA'), 'not json at all\x00\x01');
    const s = new TransactionMetaStore({ baseDir: dir, uidProvider: uid('userA') });
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      expect(() => s.loadOnce()).not.toThrow();
    } finally {
      console.warn = origWarn;
    }
  });

  test('dedupe on load: duplicate ids hydrate once, last wins', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      fileFor('userA'),
      '{"i":"t1","a":"old","t":"old"}\n{"i":"t1","a":"acct-1","t":"item-1"}\n'
    );
    const m = new TransactionMetaStore({ baseDir: dir, uidProvider: uid('userA') }).loadOnce();
    expect(m.size).toBe(1);
    expect(m.get('t1')).toEqual(META);
  });

  test('flush skips entries already persisted (no duplicate lines across sessions)', () => {
    const a = new TransactionMetaStore({ baseDir: dir, uidProvider: uid('userA') });
    a.loadOnce();
    a.buffer('t1', META);
    a.flush();

    const b = new TransactionMetaStore({ baseDir: dir, uidProvider: uid('userA') });
    b.loadOnce();
    b.buffer('t1', META); // already persisted — must not append again
    b.buffer('t3', { accountId: 'acct-3', itemId: 'item-3' });
    b.flush();

    const lines = readFileSync(fileFor('userA'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2); // t1 once, t3 once
  });

  test('append failure never throws (unwritable dir)', () => {
    const roDir = join(dir, 'ro');
    mkdirSync(roDir);
    const s = new TransactionMetaStore({ baseDir: roDir, uidProvider: uid('userA') });
    s.loadOnce();
    s.buffer('t1', META);
    chmodSync(roDir, 0o555);
    try {
      expect(() => s.flush()).not.toThrow();
    } finally {
      chmodSync(roDir, 0o755);
    }
  });

  test('opt-out env var: no file, no load', () => {
    process.env.COPILOT_DISABLE_PERSISTENT_INDEX = '1';
    const s = new TransactionMetaStore({ baseDir: dir, uidProvider: uid('userA') });
    s.loadOnce();
    s.buffer('t1', META);
    s.flush();
    expect(existsSync(fileFor('userA'))).toBe(false);
  });

  test('cap valve: oversized file is rewritten deduped on load', () => {
    mkdirSync(dir, { recursive: true });
    const dupLine = '{"i":"t1","a":"acct-1","t":"item-1"}\n';
    writeFileSync(fileFor('userA'), dupLine.repeat(200));
    const s = new TransactionMetaStore({
      baseDir: dir,
      uidProvider: uid('userA'),
      maxBytes: 1024, // force the valve
    });
    const m = s.loadOnce();
    expect(m.size).toBe(1);
    const rewritten = readFileSync(fileFor('userA'), 'utf8').trim().split('\n');
    expect(rewritten).toHaveLength(1);
  });

  test('skipped lines emit a warn-once warning, valid entries still load', () => {
    mkdirSync(dir, { recursive: true });
    // One valid line, two invalid: a torn line and a JSON object missing required fields.
    writeFileSync(
      fileFor('userA'),
      '{"i":"t1","a":"acct-1","t":"item-1"}\n{"i":"bad"\n{"bad":true}\n'
    );
    const s = new TransactionMetaStore({ baseDir: dir, uidProvider: uid('userA') });
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(' '));
    let m: Map<string, { accountId: string; itemId: string }>;
    try {
      m = s.loadOnce();
    } finally {
      console.warn = origWarn;
    }
    // Valid entry survives.
    expect(m!.get('t1')).toEqual(META);
    // Exactly one warning, mentioning the skip count.
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('skipped 2 unparseable line');
  });

  test('cap-valve and load-failure warnings suppress independently per uid (#521 polish)', () => {
    mkdirSync(dir, { recursive: true });
    const line = '{"i":"t1","a":"acct-1","t":"item-1"}\n';
    writeFileSync(fileFor('userA'), line.repeat(200));
    writeFileSync(fileFor('userB'), line);

    let current: string | null = 'userA';
    const s = new TransactionMetaStore({
      baseDir: dir,
      uidProvider: () => current,
      maxBytes: 1024, // force the valve on userA's oversized file
    });

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(' '));
    try {
      chmodSync(dir, 0o555); // tmp-file write fails → cap-valve failure path
      s.loadOnce();
      expect(warns.some((w) => w.includes('cap-valve failed'))).toBe(true);
      chmodSync(dir, 0o755);

      // Rotate away and back so userA's file is re-read (loadedForUid moves).
      current = 'userB';
      s.loadOnce();

      // Now make userA's file unreadable: the LOAD failure for userA must
      // still warn — the cap-valve warning above must not have consumed
      // userA's load-failure suppression slot.
      chmodSync(fileFor('userA'), 0o000);
      current = 'userA';
      s.loadOnce();
      expect(warns.some((w) => w.includes('unreadable'))).toBe(true);
    } finally {
      console.warn = origWarn;
      chmodSync(dir, 0o755);
      try {
        chmodSync(fileFor('userA'), 0o644);
      } catch {
        // best-effort cleanup
      }
    }
  });

  test('uid change between buffer and flush: entries stay with the uid captured at buffer time', () => {
    let current: string | null = 'userA';
    const s = new TransactionMetaStore({ baseDir: dir, uidProvider: () => current });
    s.loadOnce();
    s.buffer('tA', META); // buffered under userA
    current = 'userB'; // re-auth as a different account
    s.buffer('tB', { accountId: 'acct-2', itemId: 'item-2' }); // buffered under userB
    s.flush();

    const a = new TransactionMetaStore({ baseDir: dir, uidProvider: uid('userA') }).loadOnce();
    const b = new TransactionMetaStore({ baseDir: dir, uidProvider: uid('userB') }).loadOnce();
    expect(a.get('tA')).toEqual(META);
    expect(a.has('tB')).toBe(false);
    expect(b.get('tB')).toEqual({ accountId: 'acct-2', itemId: 'item-2' });
    expect(b.has('tA')).toBe(false);
  });
});
