/**
 * Persistent per-uid split-parent record (#842). Append-only JSONL beside the
 * routing-id index, identity-scoped, crash-tolerant, never fails the caller.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SplitParentStore } from '../../../src/core/persistence/split-parent-store.js';

// Firestore-shaped opaque ids.
const UID_A = 'Kp3sW8dF1gH6jL2zX9cV';
const UID_B = 'Mn7bV4cX2zL9kJ5hG1fD';
const PARENT_1 = 'Rt4yU9iO2pA7sD1fG6hK';
const PARENT_2 = 'Wq2eR7tY4uI9oP3aS8dF';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'split-parent-store-'));
  delete process.env.COPILOT_DISABLE_PERSISTENT_INDEX;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.COPILOT_DISABLE_PERSISTENT_INDEX;
});

const store = (uid: string | null, baseDir = dir) =>
  new SplitParentStore({ baseDir, uidProvider: () => uid });

describe('SplitParentStore', () => {
  test('a recorded id is known to a fresh instance (restart)', () => {
    store(UID_A).record(PARENT_1);
    const next = store(UID_A);
    expect(next.has(PARENT_1)).toBe(true);
    expect(next.has(PARENT_2)).toBe(false);
  });

  test('identity isolation: one login never sees another login’s record', () => {
    store(UID_A).record(PARENT_1);
    expect(store(UID_B).has(PARENT_1)).toBe(false);
  });

  test('no uid: nothing is written and nothing is known', () => {
    const s = store(null);
    s.record(PARENT_1);
    expect(s.has(PARENT_1)).toBe(false);
    expect(existsSync(join(dir, `split-parents.${UID_A}.jsonl`))).toBe(false);
  });

  test('a throwing uid provider is treated as no uid', () => {
    const s = new SplitParentStore({
      baseDir: dir,
      uidProvider: () => {
        throw new Error('synthetic');
      },
    });
    expect(() => s.record(PARENT_1)).not.toThrow();
    expect(s.has(PARENT_1)).toBe(false);
  });

  test('recording an id twice appends it once', () => {
    const s = store(UID_A);
    s.record(PARENT_1);
    s.record(PARENT_1);
    store(UID_A).record(PARENT_1);
    const lines = readFileSync(join(dir, `split-parents.${UID_A}.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  test('a torn line is skipped and the rest still counts', () => {
    writeFileSync(
      join(dir, `split-parents.${UID_A}.jsonl`),
      `${JSON.stringify({ i: PARENT_1 })}\n{"i":"Wq2eR7t\n${JSON.stringify({ i: 7 })}\n`
    );
    const s = store(UID_A);
    expect(s.has(PARENT_1)).toBe(true);
    expect(s.has(PARENT_2)).toBe(false);
  });

  test('COPILOT_DISABLE_PERSISTENT_INDEX=1 disables both directions', () => {
    store(UID_A).record(PARENT_1);
    process.env.COPILOT_DISABLE_PERSISTENT_INDEX = '1';
    const s = store(UID_A);
    expect(s.has(PARENT_1)).toBe(false);
    s.record(PARENT_2);
    delete process.env.COPILOT_DISABLE_PERSISTENT_INDEX;
    expect(store(UID_A).has(PARENT_2)).toBe(false);
  });

  test('an unwritable directory degrades with one warning, never a throw', () => {
    // A regular file where the directory should be: mkdir and append fail.
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = store(UID_A, blocker);
      expect(() => s.record(PARENT_1)).not.toThrow();
      expect(() => s.record(PARENT_2)).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
