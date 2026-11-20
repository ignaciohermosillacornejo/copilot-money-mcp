/**
 * The ESLint half of tests/eslint-unsafe-ratchet.test.ts, run as its own
 * process (#929). Inside `bun test` the lint shared a process with every test
 * file before it, so anything a test left patched on a shared module (fs,
 * os, process) could change what TypeScript resolved: CI counted three more
 * hits than a clean checkout did. A child process sees only the repo.
 *
 * Prints one JSON object to stdout: the tests/ files scanned, the ones whose
 * computed config switches a no-unsafe-* rule off, and for each of those its
 * fatal messages and its no-unsafe-* hits with the rules switched back on.
 */
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import { tsFilesUnder } from './ts-files.js';

export const UNSAFE_RULES = [
  '@typescript-eslint/no-unsafe-argument',
  '@typescript-eslint/no-unsafe-assignment',
  '@typescript-eslint/no-unsafe-call',
  '@typescript-eslint/no-unsafe-member-access',
  '@typescript-eslint/no-unsafe-return',
] as const;

export interface RatchetReport {
  scanned: number;
  /** tests/ files no ESLint config matches at all, i.e. ignored and unlinted. */
  unmatched: string[];
  relaxed: string[];
  files: { file: string; fatal: string[]; hits: string[] }[];
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const isOff = (entry: Linter.RuleEntry | undefined): boolean => {
  const level = Array.isArray(entry) ? entry[0] : entry;
  return level === 0 || level === 'off';
};

async function main(): Promise<void> {
  const config = new ESLint({ cwd: REPO_ROOT });
  const files = tsFilesUnder(join(REPO_ROOT, 'tests')).map((abs) => relative(REPO_ROOT, abs));
  const relaxed: string[] = [];
  const unmatched: string[] = [];
  for (const file of files) {
    const computed = (await config.calculateConfigForFile(file)) as Linter.Config | undefined;
    if (computed === undefined) unmatched.push(file);
    else if (UNSAFE_RULES.some((rule) => isOff(computed.rules?.[rule]))) relaxed.push(file);
  }
  const strict = new ESLint({
    cwd: REPO_ROOT,
    // Counted with inline config off, so no comment can deflate a baseline.
    allowInlineConfig: false,
    overrideConfig: {
      files: ['tests/**/*.ts'],
      rules: Object.fromEntries(UNSAFE_RULES.map((rule) => [rule, 'error'])),
    },
  });
  const results = relaxed.length > 0 ? await strict.lintFiles(relaxed) : [];
  const report: RatchetReport = {
    scanned: files.length,
    unmatched,
    relaxed,
    files: results.map((r) => ({
      file: relative(REPO_ROOT, r.filePath),
      fatal: r.messages.filter((m) => m.fatal).map((m) => `${String(m.line)}: ${m.message}`),
      hits: r.messages
        .filter((m) => (UNSAFE_RULES as readonly string[]).includes(m.ruleId ?? ''))
        .map((m) => `${String(m.line)}:${String(m.column)} ${m.message}`),
    })),
  };
  process.stdout.write(JSON.stringify(report));
}

if (import.meta.main) await main();
