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
 * own test. The controls at the bottom assemble their fixtures from these two
 * constants for the same reason.
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
 *
 * `.*` is greedy, so a line holding TWO one-line docblocks matches once and is
 * classed as one — a docblock stranded by another on the same physical line is
 * invisible. The mirror of the known false-positive shape in the header, with
 * the same status: no instance exists, and Prettier does not produce one.
 */
const ONE_LINE_DOCBLOCK = new RegExp(`^\\${'/'}\\*\\*.*\\*\\${'/'}$`);

/**
 * Which spelling of "this line ends a comment" a line is, or undefined.
 *
 * Returns the KIND rather than a boolean, and the two kinds are counted
 * separately below, because a disjunction behind a single total is deletable in
 * silence: floored only on the sum, dropping the one-line arm took the count
 * from 1297 to 999, still far over a 500 floor, so the round-2 widening could
 * be removed with the whole suite green and the detector quietly back to the
 * round-1 rule. That is the vacuous-assertion class applied to the guard added
 * to close a gap — caught in round-3 review of #724, and the reason each arm
 * now has a floor naming the way its own input can go to zero.
 */
function closingKind(line: string): 'bare' | 'oneLine' | undefined {
  if (line === CLOSES_COMMENT) return 'bare';
  if (ONE_LINE_DOCBLOCK.test(line)) return 'oneLine';
  return undefined;
}

/**
 * `lstatSync`, not `statSync`: stat FOLLOWS a symlink and throws on a dangling
 * one, so a broken link anywhere under the scanned trees would crash the whole
 * suite instead of failing informatively here. lstat answers about the link
 * itself, and a link is not a directory to descend into. (Raised in review of
 * #724.)
 *
 * It fixes the WALKER only, which is half the claim: a dangling link named
 * `*.ts` is not a directory, so it lands in the file list and throws at the
 * read instead. That is why scan() collects unreadable files rather than
 * letting the read throw at module scope.
 *
 * lstat is also a scan SHRINK, which is the class this PR is about, so it is
 * stated rather than left implicit: stat used to follow a symlinked DIRECTORY
 * under a scanned tree and lstat does not. No such link exists under src/,
 * scripts/ or tests/ today, not following one avoids a cycle, and the files
 * floor below catches gross shrinkage — but it catches only gross shrinkage.
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
  /** Files swept per tree, so one tree leaving the sweep cannot hide in a sum. */
  perTree: Record<string, number>;
  files: number;
  /** Lines that are nothing but a closing delimiter. */
  bareClosings: number;
  /** Whole docblocks written on one line — the round-2 widening. */
  oneLineClosings: number;
  /** Lines that OPEN a docblock — the other half of the rule's conjunction. */
  opens: number;
  /** Files the sweep could not read, with the cause. */
  unreadable: string[];
  stranded: string[];
}

/**
 * The rule itself, over one file's lines: 1-based numbers of every line that
 * closes a comment and is immediately followed by one that opens a docblock.
 *
 * Extracted from scan() so a POSITIVE CONTROL can run past it. Round-4 review
 * of #724 pointed out that the rule is a conjunction and only its closing half
 * was floored — the closing counters are incremented before the opening test,
 * so breaking OPENS_DOCBLOCK left every assertion green and the sweep reporting
 * zero for the same reason a clean tree does. Floors alone cannot fix that:
 * they measure inputs, and a detector that has only ever been observed
 * returning [] has not been observed detecting. The controls below feed it a
 * hit, built from the same constants so this file still cannot match itself.
 */
function strandedLines(lines: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (closingKind(lines[i].trim()) === undefined) continue;
    if (lines[i + 1].trim().startsWith(OPENS_DOCBLOCK)) out.push(i + 1);
  }
  return out;
}

function scan(): Scan {
  const result: Scan = {
    perTree: {},
    files: 0,
    bareClosings: 0,
    oneLineClosings: 0,
    opens: 0,
    unreadable: [],
    stranded: [],
  };
  for (const tree of SCANNED_TREES) {
    result.perTree[tree] = 0;
    for (const file of tsFilesUnder(join(REPO_ROOT, tree))) {
      const rel = relative(REPO_ROOT, file);
      // Collected rather than thrown, for the reason the gate this test was
      // written for now applies to itself: `scan()` runs at MODULE scope, so an
      // uncaught read failure here takes down the whole suite with a raw ENOENT
      // and no indication of which file produced it. lstat above stops the
      // WALKER throwing on a dangling link; a dangling link named `*.ts` is not
      // a directory, so it lands in the file list and fails here instead — the
      // robustness claim was half-applied until this. (Round-3 review of #724.)
      let contents: string;
      try {
        contents = readFileSync(file, 'utf-8');
      } catch (err) {
        result.unreadable.push(`${rel}  ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      // Counted only once the file has actually been read, so the number cannot
      // overstate by construction — the principle this PR's own gate fix rests
      // on, applied here rather than left to the neighbouring unreadable test.
      result.files++;
      result.perTree[tree]++;
      const lines = contents.split('\n');
      for (const line of lines) {
        const kind = closingKind(line.trim());
        if (kind === 'bare') result.bareClosings++;
        else if (kind === 'oneLine') result.oneLineClosings++;
        if (line.trim().startsWith(OPENS_DOCBLOCK)) result.opens++;
      }
      for (const n of strandedLines(lines)) result.stranded.push(`${rel}:${n}`);
    }
  }
  return result;
}

describe('no stranded docblocks (#701)', () => {
  const result = scan();

  test('the sweep actually reached the repository', () => {
    // Guards the gate: a walker that returned nothing, or a delimiter that
    // matched nothing, would report zero stranded blocks for the same reason a
    // clean tree does.
    //
    // Every arm floored SEPARATELY, because a floor over a sum is satisfied by
    // one arm alone. That argument has now been made three times about this one
    // test — the two closing spellings (a widening deletable in silence), the
    // opening delimiter (the conjunction's other half, whose counters sit
    // BEFORE it, so breaking it left everything green), and the tree list
    // itself: with one floor of 200 over three trees, dropping `src` left 220
    // and dropping `scripts` left 287, so either could leave the sweep quietly
    // — including `scripts`, where the bug that prompted all of this lives.
    //
    // Measured as this lands: 336 files (src 116, scripts 49, tests 171), 999
    // bare delimiters, 298 one-line docblocks, 1342 opening delimiters. Every
    // floor sits roughly 3x below its value, and each tree only grows.
    expect(result.files).toBeGreaterThan(200);
    // PINNED, not iterated. The first version of this looped over
    // SCANNED_TREES, which cannot see a tree removed FROM SCANNED_TREES —
    // measured, not reasoned about: deleting `scripts` from the list passed
    // every assertion. A guard whose domain is the thing it guards has no
    // domain. The literal below is what makes the per-tree floors reachable.
    expect([...SCANNED_TREES].sort()).toEqual(['scripts', 'src', 'tests']);
    for (const tree of ['src', 'scripts', 'tests']) {
      expect(result.perTree[tree], `${tree} left the sweep`).toBeGreaterThan(30);
    }
    expect(result.bareClosings).toBeGreaterThan(500);
    expect(result.oneLineClosings).toBeGreaterThan(150);
    expect(result.opens).toBeGreaterThan(600);
  });

  test('positive control: the rule detects a hit it is shown', () => {
    // A detector observed only returning [] has not been observed detecting.
    // Fixtures are assembled from the delimiter constants at runtime, so this
    // source file still contains no literal stranded pair for the sweep above
    // to report.
    const closed = `${OPENS_DOCBLOCK} the block that gets stranded ${CLOSES_COMMENT}`;
    expect(strandedLines([CLOSES_COMMENT, closed, 'const x = 1;'])).toEqual([1]);
    // Both closing spellings reach the rule, not just the bare delimiter — the
    // round-2 widening pinned through the detector rather than through a count.
    expect(strandedLines([closed, closed, 'const x = 1;'])).toEqual([1]);
  });

  test('negative control: a blank line between them is not stranding', () => {
    // The adjacency rule the header docblock argues for, asserted rather than
    // asserted about. Without this, "no stranded blocks" would also be the
    // answer a rule that matched nothing gave.
    const closed = `${OPENS_DOCBLOCK} a module header ${CLOSES_COMMENT}`;
    expect(strandedLines([CLOSES_COMMENT, '', closed, 'const x = 1;'])).toEqual([]);
  });

  test('every scanned file was actually read', () => {
    // The sweep's own version of the fail-open this PR fixes in the concealment
    // gate: a file that could not be read contributes no findings and, without
    // this, would be indistinguishable from a clean one.
    expect(
      result.unreadable,
      `Files under ${SCANNED_TREES.join(', ')} that the sweep could not read, so nothing ` +
        `above covers them: ${result.unreadable.join('; ')}.`
    ).toEqual([]);
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
