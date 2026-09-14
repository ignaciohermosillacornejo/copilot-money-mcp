/**
 * Class detector: no regex in this repo may recognise a TypeScript comment.
 *
 * THE CLASS
 *
 * A source-scanning guard — a discovery scan, a coverage census, a config
 * reader — strips comments so it can see the code underneath, and strips them
 * with a pair of regexes. A regex does not know what a string literal is, so
 * the stripper is wrong in two directions at once:
 *
 *   - a comment marker INSIDE a string literal reads as a comment, and the
 *     scanner loses the rest of that line (a URL literal is the common case)
 *   - a block-comment opener inside a LINE comment lets the block pass run
 *     forward to the next closer, deleting whole declarations in between
 *
 * Both failures shorten what the scan sees. A discovery scan that sees less
 * source finds fewer declarations, and fewer declarations is exactly what a
 * clean run looks like: the forward direction has nothing to complain about,
 * and an under-reporting guard is indistinguishable from a passing one.
 *
 * FOUR COPIES, one defect (#691):
 *
 *   tests/exported-constants.test.ts            — now an AST walk with no
 *                                                 comment handling at all
 *   tests/core/decoder-field-completeness.test.ts
 *   tests/core/dedup-identity.test.ts           — both now call the
 *                                                 parser-owned helper in
 *                                                 tests/helpers/strip-comments.ts
 *   tests/unit/tsconfig-tests-sync.test.ts      — now reads JSONC with
 *                                                 ts.parseConfigFileTextToJson
 *
 * Fixing the four instances is not a class-level fix; nothing stops the fifth.
 * This test is the ratchet. There is NO allowlist: every current call site
 * either uses the parser or does not touch comments, so the honest expectation
 * is zero, and an exemption would have to be argued into this file rather than
 * appended to a list.
 *
 * HOW IT DECIDES, and why it is behavioural rather than a text search
 *
 * Searching for the escape sequence someone happened to type would catch the
 * four copies and nothing else — `[/][/]`, `\x2f\x2f` and a dozen other
 * spellings mean the same thing, and the next copy is as likely to be a
 * rewrite as a paste. So each regex literal in the tree is COMPILED and run
 * against probes:
 *
 *   flagged  when it matches a bare comment in its ENTIRETY (it recognises a
 *            comment as a unit — that is what a stripper does)
 *   cleared  when it also matches ordinary code in its entirety (a bare dotall
 *            wildcard matches anything; it is not about comments)
 *
 * KNOWN LIMITS, so a green run is not over-read:
 *
 *   - It sees regex LITERALS. A pattern assembled at runtime
 *     (`new RegExp(marker + '.*')`) is invisible.
 *   - It sees regexes that recognise a WHOLE comment. A scanner that finds
 *     comment openers and slices by index — no regex that spans a comment —
 *     passes. That shape has its own problem (it still has to know where
 *     strings are) and this gate would not tell you about it.
 *   - A regex literal that the TypeScript scanner accepts but `new RegExp`
 *     refuses is skipped, silently, while still counting toward `considered`.
 *     Nothing in the tree does this — body and flags come verbatim from source
 *     — but the two grammars are not identical and this file would be a poor
 *     advertisement for naming your own limits if it left that one out.
 *   - It scans the TS extension family (`.ts`, `.tsx`, `.mts`, `.cts`) and
 *     nothing else, with `ScriptKind` taken from the extension. A source file
 *     outside that set is not misparsed — it is never opened, and the detector
 *     reports zero findings over it, which is the under-collecting direction
 *     this class is named for. `.d.ts` files are scanned like any other and
 *     hold no regexes worth flagging.
 *   - `CODE_PROBES` is the same bound pointing the other way, and it is the
 *     sharper one: a regex is CLEARED if it matches any code probe end to end,
 *     so widening that list silently retires detections. This file declined to
 *     have an allowlist on the grounds that an exemption should be argued
 *     rather than appended — and an append-only clearing list is that
 *     allowlist spelled differently. Widen it only after checking the new probe
 *     against the real stripper shapes, which is why the entries below carry
 *     their reason.
 *   - The verdict is as wide as the probe list and no wider. A pattern needing
 *     context the probes do not supply is invisible: the probes carry a leading
 *     newline, a leading newline + indent, and a multi-line block for that
 *     reason, but a stripper requiring, say, a preceding `;` would still slip
 *     through. Widening the probes is the fix when one does, and is cheap.
 *   - It says nothing about whether the parser-owned helper is used CORRECTLY,
 *     only that comments are not being matched by hand.
 *
 * This file contains no regex literal that recognises a comment, which is why
 * it needs no self-exemption: the probes below are string literals, and string
 * literals are not what the walk collects.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

import { scriptKindFor, tsFilesUnder } from './helpers/ts-files.js';

const REPO_ROOT = join(import.meta.dir, '..');
const SCANNED_DIRS = ['src', 'tests', 'scripts'];

/**
 * Bare comments. A stripper matches one of these end to end.
 *
 * The verdict is only ever as wide as this list, so each entry is a SHAPE the
 * others do not cover, not a variation:
 *
 *   - single-line block, line, and doc comments — the three spellings the four
 *     hand-rolled copies handled
 *   - a line comment preceded by a NEWLINE, and one preceded by a newline and
 *     INDENT: a stripper anchored to a line start never matches a comment
 *     beginning at offset 0, and one demanding the marker immediately after the
 *     break never matches an indented comment
 *   - a MULTI-LINE block comment, because a pattern requiring an interior
 *     newline never matches a one-line one
 */
const COMMENT_PROBES = [
  '/* a comment */',
  '// a comment',
  '/** a doc comment */',
  '\n// a comment on its own line',
  '\n  // an indented comment',
  '/**\n * a doc comment\n * over several lines\n */',
];

/**
 * Ordinary code. A regex that swallows one of these whole is a wildcard, not a
 * comment matcher, so it is cleared rather than flagged.
 *
 * The `=`-free entries neutralise `/^[^=]+$/`-shaped bounds. The path entry
 * neutralises the other obvious false positive: an absolute-path matcher swallows
 * a line comment whole and no identifier-shaped probe clears it. The
 * newline-bearing entry does the same for a newline wildcard. A gate that fires
 * on ordinary regexes gets turned off, and then it protects nothing.
 */
const CODE_PROBES = [
  'const x = 1;',
  'return items;',
  'export default thing;',
  '/usr/local/bin/thing',
  '  indented statement;',
  '\nconst y = 2;',
];

type Finding = {
  readonly file: string;
  readonly line: number;
  readonly pattern: string;
};

/** Split `/body/flags` — the raw text of a regex literal — without a regex. */
function splitRegexLiteral(literal: string): { body: string; flags: string } | null {
  if (!literal.startsWith('/')) return null;
  const lastSlash = literal.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  return { body: literal.slice(1, lastSlash), flags: literal.slice(lastSlash + 1) };
}

/** Does `pattern` match `probe` from end to end? */
function matchesWholly(pattern: RegExp, probe: string): boolean {
  pattern.lastIndex = 0;
  const match = pattern.exec(probe);
  return match !== null && match[0] === probe;
}

/**
 * One file's regex literals: how many there were, and which of them recognise a
 * comment as a unit.
 *
 * The count comes back alongside the findings rather than from a second walk,
 * because it is the non-vacuity floor for those findings — a scan that parsed
 * nothing and a scan that found nothing both report zero, and the floor only
 * separates them if it counts what the SAME walk considered.
 *
 * Regex literals are collected from the AST, not by text search: a slash inside
 * a string, a comment or a division is not a regex literal, and this file would
 * be a poor advertisement for parser-owned lexing if it guessed.
 */
function scanRegexLiterals(
  source: string,
  file: string
): { considered: number; findings: Finding[] } {
  // `setParentNodes: false`: nothing here needs a parent pointer — `getText`
  // and `getStart` are both handed the source file explicitly, and the walk is
  // `forEachChild`, not `getChildren`. This runs over every .ts in three trees
  // on each `bun run check`.
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKindFor(file)
  );
  const findings: Finding[] = [];
  let considered = 0;

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      considered++;
      const literal = node.getText(sourceFile);
      const parts = splitRegexLiteral(literal);
      if (parts !== null) {
        let compiled: RegExp | null = null;
        try {
          // Drop `g`/`y`: both carry lastIndex state across calls, and this
          // only ever asks "does it match", never "where next".
          compiled = new RegExp(parts.body, parts.flags.replaceAll('g', '').replaceAll('y', ''));
        } catch {
          compiled = null;
        }
        if (compiled !== null) {
          const matchesComment = COMMENT_PROBES.some((probe) => matchesWholly(compiled, probe));
          const matchesCode = CODE_PROBES.some((probe) => matchesWholly(compiled, probe));
          if (matchesComment && !matchesCode) {
            findings.push({
              file,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
              pattern: literal,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { considered, findings };
}

/** Just the findings, for the synthetic snippets below. */
function findCommentMatchingRegexes(source: string, file: string): Finding[] {
  return scanRegexLiterals(source, file).findings;
}

describe('no hand-rolled comment strippers (#691 class detector)', () => {
  const files = SCANNED_DIRS.flatMap((dir) => tsFilesUnder(join(REPO_ROOT, dir)));
  const scans = files.map((file) =>
    scanRegexLiterals(readFileSync(file, 'utf-8'), relative(REPO_ROOT, file))
  );

  test('the scan reaches the tree at all (guards the guard)', () => {
    // Two independently derived numbers rather than one: a walk that returned
    // no FILES and a walk that returned files holding no REGEXES both produce
    // zero findings, and zero findings is what passing looks like. Loose
    // floors on purpose — they exist to catch a collapse, not to budget.
    expect(files.length).toBeGreaterThanOrEqual(200);
    expect(scans.reduce((n, s) => n + s.considered, 0)).toBeGreaterThanOrEqual(200);
  });

  test('no regex in src/, tests/ or scripts/ recognises a comment', () => {
    const findings = scans.flatMap((s) => s.findings);
    expect(
      findings.map((f) => `${f.file}:${f.line} ${f.pattern}`),
      'A regex here matches a whole TypeScript comment, which means something is ' +
        'stripping or finding comments by hand. Use stripComments from ' +
        'tests/helpers/strip-comments.ts (or ts.parseConfigFileTextToJson for JSONC) — ' +
        'a regex cannot tell a comment from the same characters inside a string literal, ' +
        'and the failure is silent in the direction that keeps the suite green. See #691. ' +
        'If your regex genuinely is NOT about comments and this is a false positive ' +
        '(an absolute-path or URL matcher is the likely shape), argue the exception ' +
        'in this file — there is deliberately no allowlist to append to. Widening ' +
        'CODE_PROBES is the mechanism, but it is an exemption that retires real ' +
        'detections silently, so check the new probe against the stripper shapes ' +
        'first and record why it is there.'
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The detector's own behaviour, pinned on synthetic input. Without these the
  // repo scan above is a test that has never seen a violation.
  // -------------------------------------------------------------------------

  test('detects the exact stripper this class is named for', () => {
    // The two-pass form that lived in three test files. Written here as
    // concatenated fragments so this file holds no comment-matching regex of
    // its own — which is also the only reason it needs no self-exemption.
    const blockPass = 'text.replace(/' + '\\/\\*[\\s\\S]*?\\*\\/' + '/g, "")';
    const linePass = '.replace(/' + '\\/\\/[^\\n]*' + '/g, "")';
    const findings = findCommentMatchingRegexes(
      `function stripComments(text: string) { return ${blockPass}${linePass}; }`,
      'fixture.ts'
    );
    expect(findings.map((f) => f.pattern)).toHaveLength(2);
  });

  test('detects a stripper spelled without escaped slashes', () => {
    // The point of compiling and probing rather than text-matching: this one
    // shares no characters with the pattern above and does the same thing.
    const source = 'const out = text.replace(/[/][/][^\\n]*/g, "");';
    expect(findCommentMatchingRegexes(source, 'fixture.ts')).toHaveLength(1);
  });

  test('detects a comment regex reached through a variable', () => {
    // Not every hand-rolled stripper puts its regex at the call site. The walk
    // collects literals wherever they are declared, so indirection does not
    // launder it.
    const source = 'const LINE = /' + '\\/\\/.*$' + '/m;\nconst out = text.replace(LINE, "");';
    expect(findCommentMatchingRegexes(source, 'fixture.ts')).toHaveLength(1);
  });

  test('detects the JSONC line-comment form, whitespace guard and all', () => {
    // tests/unit/tsconfig-tests-sync.test.ts carried this. The `(^|\\s)` guard
    // made it less wrong, not right, and "less wrong" is what the probe is
    // deliberately blind to.
    const source = 'const out = line.replace(/(^|\\s)' + '\\/\\/' + '.*$/, "$1");';
    expect(findCommentMatchingRegexes(source, 'fixture.ts')).toHaveLength(1);
  });

  test('detects a stripper anchored to a line start', () => {
    // A `\n`-anchored pattern never matches a comment at offset 0, so the bare
    // `'// a comment'` probe clears it — the newline-prefixed probes are what
    // catch it. Added after review pointed out that the verdict is only ever as
    // wide as the probe list. String.raw so the backslashes reach the fixture
    // verbatim: this snippet has to CONTAIN a regex literal, not evaluate one.
    const source = `const out = text.replace(${String.raw`/\n\/\/[^\n]*/g`}, '');`;
    expect(findCommentMatchingRegexes(source, 'fixture.ts')).toHaveLength(1);
  });

  test('detects a stripper that requires a multi-line block comment', () => {
    const source = `const out = text.replace(${String.raw`/\/\*[\s\S]*?\n[\s\S]*?\*\//g`}, '');`;
    expect(findCommentMatchingRegexes(source, 'fixture.ts')).toHaveLength(1);
  });

  test('clears an absolute-path matcher, which swallows a line comment whole', () => {
    // The false-positive shape the identifier-shaped code probes miss: it
    // matches a line comment end to end and is about paths, not comments.
    const source = `const isAbsolute = ${String.raw`/^\/.*$/`}.test(p);`;
    expect(findCommentMatchingRegexes(source, 'fixture.ts')).toEqual([]);
  });

  test('clears regexes that are not about comments', () => {
    // The false-positive direction. A gate that fired on ordinary regexes
    // would be turned off, and then it protects nothing. `[^\\r\\n]` is the one
    // the shared helper itself uses to blank a comment range it was HANDED by
    // the parser — it matches one character and knows nothing about comments.
    const source = [
      'const a = text.replace(/[^\\r\\n]/g, " ");',
      'const b = text.replace(/\\s+/g, " ");',
      'const c = host.replace(/[.,)]+$/, "");',
      'const d = /https?:' + '\\/\\/' + '([a-zA-Z0-9.-]+)/g;',
      'const e = text.replace(/[\\s\\S]*/g, "");',
      'const f = name.replace(/^[A-Z][A-Z0-9_]*$/, "");',
    ].join('\n');
    expect(findCommentMatchingRegexes(source, 'fixture.ts')).toEqual([]);
  });

  test('a slash inside a string or a division is not a regex literal', () => {
    // Collecting literals from the AST rather than by text search is the whole
    // difference between this gate and the thing it forbids.
    const source = [
      'const looksLikeOne = "/* not a regex */";',
      'const alsoNot = a / b / c;',
      '// /* a comment mentioning an opener */',
    ].join('\n');
    expect(findCommentMatchingRegexes(source, 'fixture.ts')).toEqual([]);
  });
});
