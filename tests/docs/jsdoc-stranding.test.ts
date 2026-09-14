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
 * happens to read carefully. The sweep found three siblings the moment it was
 * written (`src/tools/tools.ts`, `src/models/account.ts`, and a SECOND site in
 * `scripts/check-concealment.ts`), and a fourth when review widened it to the
 * one-line form (`tests/core/decoder-field-completeness.test.ts`). Five
 * instances, in a tree nobody suspected of having any, is the evidence that
 * reading carefully is not a strategy.
 *
 * KNOWN FALSE-POSITIVE SHAPE, stated rather than left to be discovered: a
 * multi-line NON-doc comment (a license header, say) immediately followed by a
 * docblock is reported even though nothing was displaced, because the rule
 * tests how a comment ENDS and `*` + `/` closes both kinds. No instance exists
 * today. The fix if one appears is a blank line, which is the idiom anyway.
 *
 * THE RULE IS ADJACENCY, NOT PROXIMITY. A file-header docblock followed by a
 * BLANK LINE and then the first declaration's docblock is ordinary and common
 * here — seven such pairs in src/ alone. Those are not stranded: the header
 * documents the module. Requiring the two to be touching separates them
 * cleanly, and it is measured rather than assumed — after the five fixes in
 * this PR the whole tree has zero touching pairs, so the rule has no
 * exemption list and needs none.
 */

import { describe, expect, test } from 'bun:test';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
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

/**
 * A docblock written on ONE line, which closes a comment just as much as a
 * lone delimiter does.
 *
 * Raised in review of #724: matching only a bare closing delimiter meant a
 * stranded one-liner was invisible, and the one-line form is common here. It
 * is not hypothetical — widening the rule immediately found a fifth instance
 * of the class, in tests/core/decoder-field-completeness.test.ts, where a
 * one-line summary sat above the ASSUMPTION block that had been added later.
 * (Fixed by merging the two, since both described the same function; the other
 * four were insertions and were moved.)
 *
 * The closing slash is interpolated rather than written, for the same
 * self-match reason as CLOSES_COMMENT above.
 */
const ONE_LINE_DOCBLOCK = new RegExp(`^\\${'/'}\\*\\*.*\\*\\${'/'}$`);

/** True for any line that ENDS a comment, in either spelling. */
function closesAComment(line: string): boolean {
  return line === CLOSES_COMMENT || ONE_LINE_DOCBLOCK.test(line);
}

/**
 * `lstatSync`, not `statSync`: stat FOLLOWS a symlink and throws on a dangling
 * one, so a broken link anywhere under the scanned trees would crash the whole
 * suite instead of failing informatively here. lstat answers about the link
 * itself, and a link is not a directory to descend into. (Raised in review of
 * #724.)
 *
 * That is a scan SHRINK, which is the class this PR is about, so it is stated
 * rather than left implicit: stat used to follow a symlinked DIRECTORY under a
 * scanned tree and lstat does not. No such link exists under src/, scripts/ or
 * tests/ today, not following one avoids a cycle, and the files floor below
 * catches gross shrinkage — but it catches only gross shrinkage.
 */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (lstatSync(full).isDirectory()) out.push(...tsFilesUnder(full));
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
        if (!closesAComment(lines[i].trim())) continue;
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
    // numbers (336 files and 1295 closing delimiters as this lands) and far
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
