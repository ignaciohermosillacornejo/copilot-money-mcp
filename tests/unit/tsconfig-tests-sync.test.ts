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

const repoRoot = join(import.meta.dir, '../..');

function walk(dir: string): string[] {
  return readdirSync(join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(rel);
    return rel.endsWith('.test.ts') ? [rel] : [];
  });
}

// tsconfig.tests.json is JSONC — strip full-line and inline // comments
// before parsing. The comment marker must sit at line start or after
// whitespace so protocol-relative strings like "https://x" survive.
function readJsonc(path: string): { include: string[] } {
  const raw = readFileSync(join(repoRoot, path), 'utf-8')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
  return JSON.parse(raw) as { include: string[] };
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
