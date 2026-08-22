/**
 * Atomic file replacement with a cleaned failure path (#641).
 *
 * The write-then-rename idiom strands its temp file if the write lands and
 * the rename throws — the same stranded-artifact shape as the temp-copy
 * leak (#631/#632), reached through a different mechanism. Every
 * write-then-rename in src/ goes through this helper; a sweep test
 * (tests/core/write-then-rename-sweep.test.ts) fails on any direct
 * `renameSync` elsewhere.
 */

import { renameSync, rmSync, writeFileSync } from 'fs';

/** Injectable seam for tests — a rename-only failure has no portable
 * filesystem setup (anything that breaks the rename in the same directory
 * breaks the write first). */
export interface AtomicWriteOps {
  writeFileSync: (file: string, data: string) => void;
  renameSync: (from: string, to: string) => void;
  rmSync: (file: string, opts: { force: boolean }) => void;
}

const REAL_OPS: AtomicWriteOps = { writeFileSync, renameSync, rmSync };

/**
 * Write `data` to `${file}.${pid}.tmp`, then rename over `file`. If either
 * step throws, the tmp is best-effort removed before the error propagates —
 * the caller owns the failure policy, this helper owns not littering.
 */
export function writeFileAtomic(file: string, data: string, ops: AtomicWriteOps = REAL_OPS): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    ops.writeFileSync(tmp, data);
    ops.renameSync(tmp, file);
  } catch (e) {
    try {
      ops.rmSync(tmp, { force: true });
    } catch {
      // best-effort — the original error is the one worth propagating
    }
    throw e;
  }
}
