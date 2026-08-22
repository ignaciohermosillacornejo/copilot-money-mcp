/**
 * writeFileAtomic (#641): write-then-rename must not strand its tmp file on
 * ANY failure path. Rename-only failures cannot be provoked through the real
 * filesystem portably (anything that breaks the rename in the same directory
 * breaks the write first), so failures are injected through the ops seam;
 * the success path runs against the real filesystem.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileAtomic } from '../../src/utils/atomic-write.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tmpFilesIn(d: string): string[] {
  return readdirSync(d).filter((f) => f.endsWith('.tmp'));
}

describe('writeFileAtomic', () => {
  test('success: replaces the file, leaves no tmp', () => {
    const file = join(dir, 'target.jsonl');
    writeFileSync(file, 'old\n');
    writeFileAtomic(file, 'new\n');
    expect(readFileSync(file, 'utf8')).toBe('new\n');
    expect(tmpFilesIn(dir)).toEqual([]);
  });

  test('rename throws after a successful write: tmp removed, error propagates, target untouched', () => {
    const file = join(dir, 'target.jsonl');
    writeFileSync(file, 'old\n');
    expect(() =>
      writeFileAtomic(file, 'new\n', {
        writeFileSync,
        renameSync: () => {
          throw new Error('simulated rename failure');
        },
        rmSync,
      })
    ).toThrow('simulated rename failure');
    expect(readFileSync(file, 'utf8')).toBe('old\n');
    expect(tmpFilesIn(dir)).toEqual([]);
  });

  test('write throws: error propagates, cleanup of the never-written tmp is quiet', () => {
    const file = join(dir, 'target.jsonl');
    writeFileSync(file, 'old\n');
    expect(() =>
      writeFileAtomic(file, 'new\n', {
        writeFileSync: () => {
          throw new Error('simulated write failure');
        },
        renameSync,
        rmSync,
      })
    ).toThrow('simulated write failure');
    expect(readFileSync(file, 'utf8')).toBe('old\n');
    expect(tmpFilesIn(dir)).toEqual([]);
  });

  test('cleanup itself throws: the ORIGINAL error still propagates', () => {
    const file = join(dir, 'target.jsonl');
    expect(() =>
      writeFileAtomic(file, 'new\n', {
        writeFileSync,
        renameSync: () => {
          throw new Error('simulated rename failure');
        },
        rmSync: () => {
          throw new Error('cleanup failure — must not mask the rename error');
        },
      })
    ).toThrow('simulated rename failure');
  });
});
