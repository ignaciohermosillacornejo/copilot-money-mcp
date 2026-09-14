/**
 * Every TypeScript source file under a directory, recursively.
 *
 * Shared because the source-scanning guards in this repo kept growing their own
 * copy, and the copies were not the same: one skipped `node_modules`/`dist` and
 * one did not, which is harmless only for as long as nobody points the second
 * at a directory that has them. A PR whose whole argument is "one lexer, not
 * four" should not leave three tree walkers behind.
 *
 * The extension list is the whole TS family, not `.ts` alone. `.ts` alone was
 * the first version and it was the bug class this helper's callers exist to
 * detect: `'a.tsx'.endsWith('.ts')` is false, so a `.tsx` under `src/` would not
 * have been misparsed, it would have been NEVER SCANNED — its constants
 * undiscovered, the forward check passing on it, and the detector reporting
 * zero findings over it. Under-collection reported as success. Zero files with
 * these extensions exist today (checked), so widening costs nothing now and
 * removes the trap later. Callers that care about JSX parsing pick their
 * `ts.ScriptKind` from the extension.
 *
 * `tests/unit/tsconfig-tests-sync.test.ts` deliberately keeps its own `walk`:
 * it filters to `.test.ts` and returns repo-relative paths, which is a
 * different function wearing a similar shape.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const SKIP = new Set(['node_modules', 'dist', '.git']);
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

export function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  // `withFileTypes`, not `statSync`: one syscall per entry instead of two, and
  // `statSync` follows symlinks, so a symlinked directory cycle would recurse
  // until the stack blew. This walker runs over three trees on every
  // `bun run check`.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

/** The `ScriptKind` a filename implies — `.tsx` is JSX, everything else is not. */
export function scriptKindFor(fileName: string): ts.ScriptKind {
  return fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}
