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
import { readFileSync, readdirSync } from 'fs';
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
