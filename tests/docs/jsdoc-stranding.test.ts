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
 * here — eight such pairs in src/ alone. Those are not stranded: the header
 * documents the module. Requiring the two to be touching separates them
 * cleanly, and it is measured rather than assumed — after the five fixes in
 * this PR the whole tree has zero touching pairs, so the rule has no
 * exemption list and needs none.
 */

import { describe, expect, test } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
 * from 1328 to 1015, still far over a 500 floor, so the round-2 widening could
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
 *
 * It returns the COUNTS as well, in the same single pass, and that is not
 * tidiness. Round-5 review of #724: with the counters in their own loop over
 * the same lines, every floor measured a traversal that was not the rule —
 * deleting the `strandedLines` call site left `stranded` empty, all four floors
 * green and BOTH controls passing, because the controls call this function
 * directly. Truncating the loop to one iteration was green too, since each
 * control's only hit sat at index 0. One pass means each floor is now evidence
 * that the rule itself ran over the tree, which is the property the floors were
 * always supposed to have.
 */
interface LineScan {
  /** 1-based line numbers where a comment closes and the next line opens one. */
  stranded: number[];
  bare: number;
  oneLine: number;
  opens: number;
}

function strandedLines(lines: string[]): LineScan {
  const out: LineScan = { stranded: [], bare: 0, oneLine: 0, opens: 0 };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const kind = closingKind(line);
    if (kind === 'bare') out.bare++;
    else if (kind === 'oneLine') out.oneLine++;
    if (line.startsWith(OPENS_DOCBLOCK)) out.opens++;
    if (kind === undefined) continue;
    const next = lines[i + 1];
    if (next !== undefined && next.trim().startsWith(OPENS_DOCBLOCK)) out.stranded.push(i + 1);
  }
  return out;
}

/**
 * Parameterised on the root, so the same machinery that sweeps this repository
 * can be pointed at a synthetic tree — see the end-to-end control below.
 *
 * Why that matters and a control over `strandedLines` alone does not: the two
 * are separated by an accumulation step, and "the rule found nothing" and "the
 * rule's findings were thrown away" are the same observation over a clean tree.
 * Measured, not supposed — deleting only the line that pushes into
 * `result.stranded` left every floor and both unit controls green. A positive
 * has to be fed to THIS function, not to the rule underneath it.
 */
function scanTrees(root: string, trees: readonly string[]): Scan {
  const result: Scan = {
    perTree: {},
    files: 0,
    bareClosings: 0,
    oneLineClosings: 0,
    opens: 0,
    unreadable: [],
    stranded: [],
  };
  for (const tree of trees) {
    result.perTree[tree] = 0;
    for (const file of tsFilesUnder(join(root, tree))) {
      const rel = relative(root, file);
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
      const scanned = strandedLines(contents.split('\n'));
      result.bareClosings += scanned.bare;
      result.oneLineClosings += scanned.oneLine;
      result.opens += scanned.opens;
      for (const n of scanned.stranded) result.stranded.push(`${rel}:${n}`);
    }
  }
  return result;
}

describe('no stranded docblocks (#701)', () => {
  const result = scanTrees(REPO_ROOT, SCANNED_TREES);

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
    // Measured as this lands: 340 files (src 116, scripts 49, tests 175), 1015
    // bare delimiters, 313 one-line docblocks, 1370 opening delimiters. The
    // margins are 1.7x (files), 1.6x (scripts, the smallest tree), 2.0x (both
    // closing spellings) and 2.3x (opens) — stated as measured rather than
    // rounded up to a comfortable "3x", which is what the first version of this
    // comment said and what a reader would have re-derived and found false. The
    // thin ones are the file counts; a deletion large enough to trip them
    // innocently would be a refactor worth re-reading this test during.
    expect(result.files).toBeGreaterThan(200);
    // PINNED, not iterated. The first version of this looped over
    // SCANNED_TREES, which cannot see a tree removed FROM SCANNED_TREES —
    // measured, not reasoned about: deleting `scripts` from the list passed
    // every assertion. A guard whose domain is the thing it guards has no
    // domain. The literal below is what makes the per-tree floors reachable.
    //
    // It fails on an ADDED tree too, reporting the list mismatch rather than
    // anything about floors. That is the intended direction: a new tree has to
    // arrive with a floor of its own rather than sliding under the aggregate.
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
    // The hit sits at line 3, never at line 1: a loop truncated to its first
    // iteration — the shape an "optimization" produces — satisfies a control
    // whose only hit is at index 0, and did, before round 5.
    const lead = ['const before = 1;', ''];
    expect(strandedLines([...lead, CLOSES_COMMENT, closed, 'const x = 1;']).stranded).toEqual([3]);
    // Both closing spellings reach the rule, not just the bare delimiter — the
    // round-2 widening pinned through the detector rather than through a count.
    expect(strandedLines([...lead, closed, closed, 'const x = 1;']).stranded).toEqual([3]);
  });

  test('end-to-end control: a stranded file inside a swept tree is reported', () => {
    // The control the unit ones cannot be: it runs the WHOLE sweep — walk,
    // read, rule, accumulate — over a tree built to contain exactly one hit.
    // Without it, discarding the rule's output is indistinguishable from a
    // clean repository, which is how deleting the accumulation line passed
    // every other assertion in this file.
    const dir = mkdtempSync(join(tmpdir(), 'jsdoc-stranding-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'src', 'strand.ts'),
        [
          'const before = 1;',
          '',
          CLOSES_COMMENT,
          `${OPENS_DOCBLOCK} the block inserted into the gap ${CLOSES_COMMENT}`,
          'const after = 2;',
          '',
        ].join('\n')
      );
      const probe = scanTrees(dir, ['src']);
      expect(probe.stranded).toEqual([`${join('src', 'strand.ts')}:3`]);
      expect(probe.files).toBe(1);
      expect(probe.unreadable).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('end-to-end control: a file the sweep cannot read is named, not skipped', () => {
    // The positive control for `unreadable`, raised in round-6 review of #724.
    // Both assertions on that list are `toEqual([])`, and nothing fed it a file
    // it could not read — so replacing the wrapped read with the literal
    // `catch { continue }` this PR exists to remove left every assertion in
    // this file green, `unreadable` included, because an empty list is also
    // what a clean tree produces. A collector only ever observed empty has not
    // been observed collecting: the round-4 argument about `stranded`, applied
    // to the list beside it.
    //
    // A dangling symlink named `*.ts` is the exact case the lstat docblock
    // claims is handled: lstat says it is not a directory, so it enters the
    // file list, and the read is where it fails.
    const dir = mkdtempSync(join(tmpdir(), 'jsdoc-stranding-unreadable-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'ok.ts'), 'const a = 1;\n');
      symlinkSync('no-such-target.ts', join(dir, 'src', 'dangling.ts'));
      const probe = scanTrees(dir, ['src']);
      expect(probe.unreadable).toHaveLength(1);
      expect(probe.unreadable[0]).toContain(join('src', 'dangling.ts'));
      expect(probe.unreadable[0]).toContain('ENOENT');
      // And the readable sibling is still swept, so the failure is scoped to
      // the file that caused it rather than to the tree.
      //
      // Both counters, not just the total. They are adjacent and were added two
      // rounds apart, and until this assertion `perTree` was the one counter
      // here that could still overstate with everything green: moving its `++`
      // above the read leaves the repo sweep unchanged (nothing under the real
      // trees is unreadable) and no control looked at it. Asserting the exact
      // value on a tree that contains an unreadable file is what makes
      // "increment at the point of inspection" checkable for both of them.
      // (Round-7 review of #724.)
      expect(probe.files).toBe(1);
      expect(probe.perTree.src).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('negative control: a blank line between them is not stranding', () => {
    // The adjacency rule the header docblock argues for, asserted rather than
    // asserted about. Without this, "no stranded blocks" would also be the
    // answer a rule that matched nothing gave.
    const closed = `${OPENS_DOCBLOCK} a module header ${CLOSES_COMMENT}`;
    expect(
      strandedLines(['const before = 1;', CLOSES_COMMENT, '', closed, 'const x = 1;']).stranded
    ).toEqual([]);
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
