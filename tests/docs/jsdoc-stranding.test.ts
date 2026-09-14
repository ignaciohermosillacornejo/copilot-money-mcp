/**
 * No docblock in this repository documents the wrong declaration.
 *
 * THE BUG CLASS. A JSDoc block attaches to whatever declaration follows it, so
 * inserting a new `/** ... *\/` + declaration pair between an existing docblock
 * and the thing it describes silently re-points it. Nothing fails: it compiles,
 * it lints, it formats, and the two docstrings simply describe each other's
 * neighbours from then on. The only signature left behind is the one this test
 * looks for — a comment that closes and is IMMEDIATELY followed by a docblock
 * that opens, with nothing in between for the first one to document.
 *
 * WHY A DETECTOR RATHER THAN A FIX. `scripts/check-concealment.ts` had this
 * happen to the same docblock twice: commit 81307f3 un-stranded it once, and
 * PR #698 re-stranded it by inserting `gitDecline` back into the same gap
 * (audit issue #701). A fix that only moves the block back is a fix aimed at
 * the instance — it leaves the third occurrence to be found by a reviewer who
 * happens to read carefully. The sweep below found three siblings the moment it
 * was written (`src/tools/tools.ts`, `src/models/account.ts`, and a SECOND site
 * in `scripts/check-concealment.ts`), all fixed in the same PR, which is the
 * evidence that reading carefully is not a strategy.
 *
 * THE RULE IS ADJACENCY, NOT PROXIMITY. A file-header docblock followed by a
 * BLANK LINE and then the first declaration's docblock is ordinary and common
 * here — seven such pairs in src/ alone. Those are not stranded: the header
 * documents the module. Requiring the two to be touching separates them
 * cleanly, and it is measured rather than assumed — after the four fixes in
 * this PR the whole tree has zero touching pairs, so the rule has no
 * exemption list and needs none.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** Trees whose `.ts` files are hand-written and reviewed. */
const SCANNED_TREES = ['src', 'scripts', 'tests'];

/**
 * Built by concatenation so this file cannot match itself. A literal `*` + `/`
 * alone on a line, followed by a line opening a docblock, is exactly the
 * pattern below — writing the fixture out would make the detector report its
 * own test.
 */
const CLOSES_COMMENT = `*${'/'}`;
const OPENS_DOCBLOCK = `/*${'*'}`;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Scan {
  files: number;
  closings: number;
  stranded: string[];
}

function scan(): Scan {
  const result: Scan = { files: 0, closings: 0, stranded: [] };
  for (const tree of SCANNED_TREES) {
    for (const file of tsFilesUnder(join(REPO_ROOT, tree))) {
      result.files++;
      const lines = readFileSync(file, 'utf-8').split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i].trim() !== CLOSES_COMMENT) continue;
        result.closings++;
        if (lines[i + 1].trim().startsWith(OPENS_DOCBLOCK)) {
          result.stranded.push(`${relative(REPO_ROOT, file)}:${i + 1}`);
        }
      }
    }
  }
  return result;
}

describe('no stranded docblocks (#701)', () => {
  const result = scan();

  test('the sweep actually reached the repository', () => {
    // Guards the gate: a walker that returned nothing, or a closing-delimiter
    // string that matched nothing, would report zero stranded blocks for the
    // same reason a clean tree does. Both floors are far below the real
    // numbers (336 files and 997 closing delimiters as this lands) and far
    // above zero.
    expect(result.files).toBeGreaterThan(200);
    expect(result.closings).toBeGreaterThan(500);
  });

  test('no docblock is immediately followed by another docblock', () => {
    expect(
      result.stranded,
      `A comment closes and the very next line opens a docblock, so the first one ` +
        `documents nothing and the second documents the declaration the first was ` +
        `written for. Move the inserted docblock + declaration ABOVE the existing ` +
        `docblock rather than into the gap between it and its subject.`
    ).toEqual([]);
  });
});
