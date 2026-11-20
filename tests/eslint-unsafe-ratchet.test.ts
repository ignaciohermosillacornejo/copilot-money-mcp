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
 */
import { describe, expect, test } from 'bun:test';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, type Linter } from 'eslint';
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
      const computed = (await config.calculateConfigForFile(file)) as Linter.Config;
      const offRules = UNSAFE_RULES.filter((rule) => isOff(computed.rules?.[rule]));
      if (offRules.length > 0) relaxed.push(file);
    }
    // A walk that found nothing would pass for the wrong reason.
    expect(files.length).toBeGreaterThan(100);

    expect(
      relaxed.filter((file) => !(file in BASELINE)),
      'These files switch no-unsafe-* off but are not on the ratchet baseline. The list ' +
        'only shrinks: fix the hits instead of adding the file to eslint.config.js.'
    ).toEqual([]);

    const strict = new ESLint({
      cwd: REPO_ROOT,
      overrideConfig: {
        files: ['tests/**/*.ts'],
        rules: Object.fromEntries(UNSAFE_RULES.map((rule) => [rule, 'error'])),
      },
    });
    const results = await strict.lintFiles(relaxed);
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
});
