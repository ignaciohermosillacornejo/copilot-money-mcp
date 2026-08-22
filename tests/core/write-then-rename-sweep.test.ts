/**
 * Class detector for stranded write-then-rename artifacts (#641).
 *
 * The idiom — write `${file}.tmp`, rename over `file` — strands the tmp if
 * the write lands and the rename throws. `writeFileAtomic`
 * (src/utils/atomic-write.ts) owns the idiom including that failure path,
 * so the class-level guarantee is structural: no other file in src/ may
 * call `renameSync` (or fs.promises `rename`) directly. A new call site
 * either routes through the helper or consciously registers itself here,
 * in review.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(import.meta.dir, '..', '..', 'src');

// The one place the idiom is allowed to live.
const ALLOWED = new Set(['utils/atomic-write.ts']);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts')) yield p;
  }
}

describe('write-then-rename sweep (#641)', () => {
  test('renameSync appears in src/ only inside writeFileAtomic', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = file.slice(SRC_ROOT.length + 1);
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      if (/\brenameSync\b|\brename\s*\(/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test('the allowed file still exists and still owns the idiom', () => {
    // Guards the allowlist against rot: if the helper moves, the sweep
    // above would silently sweep nothing it excludes.
    for (const rel of ALLOWED) {
      const text = readFileSync(join(SRC_ROOT, rel), 'utf8');
      expect(text).toContain('renameSync');
    }
  });
});
