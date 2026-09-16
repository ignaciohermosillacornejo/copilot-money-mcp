/**
 * Typecheck-gate sync: every test file that calls createMockGraphQLClient
 * must be listed in tsconfig.tests.json's include list, or its mock shapes
 * are not typechecked and the #433 gate silently doesn't apply to it.
 *
 * Same pattern as tests/unit/doc-sync.test.ts: the registration that a
 * human must remember (the include list) is asserted against the ground
 * truth derived from the tree (which files actually use the typed mock).
 */

import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';

const repoRoot = join(import.meta.dir, '../..');

function walk(dir: string): string[] {
  return readdirSync(join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(rel);
    return rel.endsWith('.test.ts') ? [rel] : [];
  });
}

// tsconfig.tests.json is JSONC, so `JSON.parse` cannot read it directly.
// `ts.parseConfigFileTextToJson` is the compiler's own reader for exactly this
// file format — it is what `tsc -p` uses — so comments are handled by the
// thing that defines what a comment is in a tsconfig.
//
// This was a hand-rolled line-comment stripper, the fourth copy of the class
// #691 closed. It was the least wrong of the four (it required the marker to
// sit at line start or after whitespace, so `"https://x"` survived), but the
// guard was a heuristic about spacing, not about strings: a path value holding
// ` //` anywhere would still have been truncated, silently shortening the
// include list this test compares against. See
// tests/no-hand-rolled-comment-strippers.test.ts.
function readJsonc(path: string): { include: string[] } {
  const raw = readFileSync(join(repoRoot, path), 'utf-8');
  const parsed = ts.parseConfigFileTextToJson(path, raw);
  if (parsed.error !== undefined) {
    throw new Error(
      `${path} is not valid JSONC: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, ' ')}`
    );
  }
  return parsed.config as { include: string[] };
}

describe('tsconfig.tests.json stays in sync with typed-mock adoption', () => {
  const included = new Set(readJsonc('tsconfig.tests.json').include);

  // Adoption = importing the typed-mock helper module (merely naming the
  // function in prose is not adoption). The needle is split so this file's
  // own source doesn't match it.
  const needle = 'helpers/' + 'mock-graphql';
  const adopters = walk('tests').filter((file) =>
    readFileSync(join(repoRoot, file), 'utf-8').includes(needle)
  );

  test('the walker finds the known adopters (sanity floor)', () => {
    expect(adopters.length).toBeGreaterThanOrEqual(5);
  });

  test('every test file using createMockGraphQLClient is typechecked', () => {
    const missing = adopters
      .map((file) => relative(repoRoot, join(repoRoot, file)))
      .filter((file) => !included.has(file));
    expect(
      missing,
      `These files call createMockGraphQLClient but are not in tsconfig.tests.json's ` +
        `include list, so their mock shapes are NOT typechecked — add them:\n  ${missing.join('\n  ')}`
    ).toEqual([]);
  });
});

/**
 * The class behind #737, which was fixed one file at a time.
 *
 * `tests/helpers/ts-files.test.ts` sat outside every program in
 * `bun run check` — the base config excludes `tests/`, eslint reads `src/`
 * only, and it was not on the include list — so nothing read a line of it.
 * Its subject module WAS on the list. A helper judged worth typechecking whose
 * own contract test is not typechecked is the shape: the assertions that say
 * what the helper promises are the half nothing checks.
 *
 * Deliberately narrow, so it holds today rather than fighting the ~87
 * pre-existing errors the tsconfig header describes: it speaks only about
 * `tests/helpers/<name>.test.ts` next to a `tests/helpers/<name>.ts` it
 * actually imports, and only when the SUBJECT is already on the list. It says
 * nothing about the two scanners, which are off the list on purpose.
 */
describe('a typechecked helper brings its own contract test onto the list', () => {
  const included = new Set(readJsonc('tsconfig.tests.json').include);
  const HELPERS = 'tests/helpers';

  // Pairing is by name AND by import: `<name>.test.ts` beside `<name>.ts`,
  // where the test really imports the sibling. Name alone would pair a file
  // that merely shares a prefix.
  const pairs = readdirSync(join(repoRoot, HELPERS))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => ({
      test: join(HELPERS, name),
      subject: join(HELPERS, name.replace(/\.test\.ts$/, '.ts')),
      specifier: `./${name.replace(/\.test\.ts$/, '')}.js`,
    }))
    .filter(
      ({ test, subject, specifier }) =>
        existsSync(join(repoRoot, subject)) &&
        readFileSync(join(repoRoot, test), 'utf-8').includes(specifier)
    );

  test('the pairing walk finds the known helper contract tests (sanity floor)', () => {
    // A rule that paired nothing would pass the assertion below for the wrong
    // reason — the same non-vacuity argument the adopter floor above makes.
    const names = pairs.map((p) => p.test);
    expect(names).toContain(join(HELPERS, 'strip-comments.test.ts'));
    expect(names).toContain(join(HELPERS, 'ts-files.test.ts'));
  });

  test("a typechecked helper's contract test is typechecked too", () => {
    const missing = pairs
      .filter(({ subject }) => included.has(subject))
      .map(({ test }) => test)
      .filter((test) => !included.has(test));
    expect(
      missing,
      `These helper modules are on tsconfig.tests.json's include list but their own ` +
        `contract tests are not, so nothing in \`bun run check\` reads the assertions that ` +
        `say what the helper promises (#737) — add them:\n  ${missing.join('\n  ')}`
    ).toEqual([]);
  });
});
