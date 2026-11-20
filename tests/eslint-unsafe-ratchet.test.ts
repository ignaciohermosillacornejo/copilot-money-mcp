/**
 * Gate for the shrink-only ratchet in eslint.config.js (#919).
 *
 * The type-aware no-unsafe-* rules are on for tests/, except for a named list
 * of files still built on hand-written `(x as any)` fixture casts. The config
 * says a file leaves that list once it is clean and a new file never joins it.
 * Prose nobody checks is how a temporary disablement outlives its reason, so
 * both halves are asserted here, against the config ESLint actually computes
 * for each file rather than a parse of the config's text:
 *
 *  - SHRINK ONLY: every file with the rules off is in BASELINE, and its hit
 *    count with the rules switched back on is at most its baseline count.
 *  - NO VACUOUS ENTRY: every listed file still has at least one hit. A clean
 *    file fails here with "remove it from the list", which is how the list
 *    shrinks; lowering a baseline number after a cleanup is welcome too.
 *  - NO STALE ROW: every BASELINE file still has the rules off, so the
 *    baseline and the config list are the same set (a bijection, as in
 *    scripts/mutation-guards.ts), not one inclusion.
 *  - NO SIDE DOOR: `calculateConfigForFile` cannot see an inline directive,
 *    so a file could switch the rules off line by line without joining the
 *    list. Every inline directive that turns off a no-unsafe-* rule (by name,
 *    or by naming no rule at all) must be line-scoped, carry a `-- reason`,
 *    and the total may not grow past INLINE_DISABLE_BASELINE.
 *  - A fatal message (parse error, file outside the lint program) fails as
 *    itself, rather than scoring zero hits and reading as "clean".
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import ts from 'typescript';
import { tsFilesUnder } from './helpers/ts-files.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const UNSAFE_RULES = [
  '@typescript-eslint/no-unsafe-argument',
  '@typescript-eslint/no-unsafe-assignment',
  '@typescript-eslint/no-unsafe-call',
  '@typescript-eslint/no-unsafe-member-access',
  '@typescript-eslint/no-unsafe-return',
] as const;

/** no-unsafe-* hits per ratchet file when the rules are on. Only ever lowered. */
const BASELINE: Record<string, number> = {
  'tests/core/database.test.ts': 106,
  'tests/e2e/server.test.ts': 261,
  'tests/integration/tools.test.ts': 79,
  'tests/tools/optimistic-cache.test.ts': 32,
  'tests/tools/tools.test.ts': 286,
  'tests/tools/unit-coverage-gaps.test.ts': 28,
  'tests/tools/update-transactions-batching.test.ts': 79,
  'tests/tools/write-tools.test.ts': 61,
  'tests/unit/delete-split-parent.test.ts': 21,
  'tests/unit/reference-validation.test.ts': 22,
  'tests/unit/resolve-transaction-meta.test.ts': 23,
  'tests/unit/server-protocol.test.ts': 25,
  'tests/unit/split-transaction-resolution.test.ts': 27,
  'tests/unit/update-transaction.test.ts': 68,
};

/**
 * Inline no-unsafe-* disables allowed under tests/. All are the bun-types case:
 * asymmetric matchers (`expect.arrayContaining`, `expect.stringContaining`)
 * are typed `any`. Only ever lowered.
 */
const INLINE_DISABLE_BASELINE = 3;

// Built, not written, so this file's own source holds no directive for the
// sweep below to find.
const DIRECTIVE = new RegExp('^\\s*eslint-' + 'disable(-next-line|-line)?(?=\\s|$)(.*)$', 's');

interface InlineDisable {
  where: string;
  problem: string | undefined;
}

/** Inline directives in `source` that switch off a no-unsafe-* rule, each judged. */
export function unsafeDisables(fileName: string, source: string): InlineDisable[] {
  const found: InlineDisable[] = [];
  // Comments come from the parsed tree, not a bare scanner: a scanner with no
  // parser misreads regex and template literals and loses its place.
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const seen = new Set<number>();
  const comments: ts.CommentRange[] = [];
  const collect = (ranges: ts.CommentRange[] | undefined) => {
    for (const r of ranges ?? []) {
      if (!seen.has(r.pos)) {
        seen.add(r.pos);
        comments.push(r);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(source, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(source, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  collect(ts.getLeadingCommentRanges(source, sf.endOfFileToken.getFullStart()));
  for (const c of comments.sort((a, b) => a.pos - b.pos)) {
    const raw = source.slice(c.pos, c.end);
    const body = c.kind === ts.SyntaxKind.SingleLineCommentTrivia ? raw.slice(2) : raw.slice(2, -2);
    const m = DIRECTIVE.exec(body);
    if (!m) continue;
    const [rulesPart = '', reason] = (m[2] ?? '').split(/\s--\s/, 2);
    const rules = rulesPart
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    const hitsUnsafe = rules.length === 0 || rules.some((r) => r.includes('no-unsafe-'));
    if (!hitsUnsafe) continue;
    const lineNo = sf.getLineAndCharacterOfPosition(c.pos).line + 1;
    const problem =
      m[1] === undefined
        ? 'not line-scoped (use -next-line)'
        : rules.length === 0
          ? 'names no rule, so it disables every rule'
          : !reason?.trim()
            ? 'no `-- reason`'
            : undefined;
    found.push({ where: `${fileName}:${String(lineNo)}`, problem });
  }
  return found;
}

const isOff = (entry: Linter.RuleEntry | undefined): boolean => {
  const level = Array.isArray(entry) ? entry[0] : entry;
  return level === 0 || level === 'off';
};

describe('eslint no-unsafe-* ratchet over tests/ (#919)', () => {
  test('only BASELINE files may switch the rules off, each still has hits, none has grown', async () => {
    const config = new ESLint({ cwd: REPO_ROOT });
    const relaxed: string[] = [];
    const files = tsFilesUnder(join(REPO_ROOT, 'tests')).map((abs) => relative(REPO_ROOT, abs));
    for (const file of files) {
      const computed = (await config.calculateConfigForFile(file)) as Linter.Config | undefined;
      const offRules = UNSAFE_RULES.filter((rule) => isOff(computed?.rules?.[rule]));
      if (offRules.length > 0) relaxed.push(file);
    }
    // A walk that found nothing would pass for the wrong reason.
    expect(files.length).toBeGreaterThan(100);

    expect(
      relaxed.filter((file) => !(file in BASELINE)),
      'These files switch no-unsafe-* off but are not on the ratchet baseline. The list ' +
        'only shrinks: fix the hits instead of adding the file to eslint.config.js.'
    ).toEqual([]);
    expect(
      Object.keys(BASELINE).filter((file) => !relaxed.includes(file)),
      'Stale ratchet baseline: these files no longer switch no-unsafe-* off. Delete the rows.'
    ).toEqual([]);

    const strict = new ESLint({
      cwd: REPO_ROOT,
      overrideConfig: {
        files: ['tests/**/*.ts'],
        rules: Object.fromEntries(UNSAFE_RULES.map((rule) => [rule, 'error'])),
      },
    });
    const results = await strict.lintFiles(relaxed);
    const fatal = results.flatMap((r) =>
      r.messages
        .filter((m) => m.fatal)
        .map((m) => `${relative(REPO_ROOT, r.filePath)}:${String(m.line)} ${m.message}`)
    );
    expect(
      fatal,
      'ESLint could not lint these files, so their hit counts mean nothing. Fix the error.'
    ).toEqual([]);
    const report = results.map((r) => {
      const file = relative(REPO_ROOT, r.filePath);
      const hits = r.messages.filter((m) =>
        (UNSAFE_RULES as readonly string[]).includes(m.ruleId ?? '')
      ).length;
      return { file, hits, baseline: BASELINE[file] ?? 0 };
    });
    expect(report.length).toBe(relaxed.length);

    expect(
      report.filter((r) => r.hits === 0).map((r) => r.file),
      'Clean: remove these from the ratchet list in eslint.config.js and from BASELINE.'
    ).toEqual([]);
    expect(
      report.filter((r) => r.hits > r.baseline).map((r) => `${r.file}: ${r.hits} > ${r.baseline}`),
      'New no-unsafe-* hits in a ratchet file. Fix them; the baseline is only ever lowered.'
    ).toEqual([]);
  }, 180_000);

  test('the inline-directive detector judges every shape it claims to', () => {
    const d = 'eslint-' + 'disable';
    const rule = '@typescript-eslint/no-unsafe-' + 'argument';
    const specimen = [
      `// ${d}-next-line ${rule} -- bun-types types matchers as any`,
      `// ${d}-next-line ${rule}`,
      `/* ${d} ${rule} -- file-wide */`,
      `// ${d}-line`,
      `// ${d}-next-line @typescript-eslint/no-explicit-any -- not an unsafe rule`,
      `const s = '// ${d}-next-line ${rule}';`,
    ].join('\n');
    expect(unsafeDisables('specimen.ts', specimen)).toEqual([
      { where: 'specimen.ts:1', problem: undefined },
      { where: 'specimen.ts:2', problem: 'no `-- reason`' },
      { where: 'specimen.ts:3', problem: 'not line-scoped (use -next-line)' },
      { where: 'specimen.ts:4', problem: 'names no rule, so it disables every rule' },
    ]);
  });

  test('inline no-unsafe-* disables under tests/ are line-scoped, reasoned, and not growing', () => {
    const files = tsFilesUnder(join(REPO_ROOT, 'tests')).map((abs) => relative(REPO_ROOT, abs));
    const found = files.flatMap((file) =>
      unsafeDisables(file, readFileSync(join(REPO_ROOT, file), 'utf8'))
    );
    expect(
      found.filter((f) => f.problem !== undefined).map((f) => `${f.where}: ${f.problem ?? ''}`),
      'An inline disable of a no-unsafe-* rule is a ratchet side door: scope it to one line ' +
        'and say why after `--`.'
    ).toEqual([]);
    expect(
      found.length,
      `Inline no-unsafe-* disables grew past ${String(INLINE_DISABLE_BASELINE)} ` +
        `(${found.map((f) => f.where).join(', ')}). Type the value instead; the baseline only falls.`
    ).toBeLessThanOrEqual(INLINE_DISABLE_BASELINE);
    expect(found.length, 'Fewer than the baseline: lower INLINE_DISABLE_BASELINE.').toBe(
      INLINE_DISABLE_BASELINE
    );
  });
});
