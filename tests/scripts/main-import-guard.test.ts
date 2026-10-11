/**
 * Class detector: a script's top-level `main()` call must sit behind
 * `if (import.meta.main)`, so importing the module runs nothing.
 *
 * `scripts/smoke/cache.ts` carried that guard with the reason written down
 * ("importing the module to unit-test its predicates kicks off a full scan of
 * the real cache"), and thirteen other scripts did not. Importing any of those
 * for one helper would have run the whole script inside `bun test`: a live
 * GraphQL session and a walk of the user's real Copilot container for the
 * smokes, and real writes for `verify-optimistic-consistency.ts`. No test
 * imported one yet, which is why it had not happened; this makes the first
 * such import safe instead of finding out.
 *
 * WHAT IT CATCHES — every TypeScript file under `scripts/`, syntax only: a
 * top-level statement that calls `main` (`main()`, `main().catch(…)`,
 * `void main()`, `await main()`) and is not an `if` whose condition is exactly
 * `import.meta.main`.
 *
 * WHAT IT DOES NOT CATCH, in both directions:
 *   - fail-open: an entry point not named `main`, a top-level call to some
 *     other function with the same effect, and a `main()` inside a top-level
 *     function declaration (`export function run() { main(); }`) — the
 *     declaration is skipped whole, because defining a function runs nothing,
 *     so a call nested in one is never seen even when an importer would call
 *     it. The name is the convention every script here follows (checked);
 *   - fail-closed: `callsMain` searches the whole statement, so a module-scope
 *     statement that only CONTAINS a call — `export const x = { run: () =>
 *     main() }` — is flagged although importing it runs nothing. No instance
 *     (checked), and wrapping it in the guard costs nothing.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { tsFilesUnder, scriptKindFor } from '../helpers/ts-files.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS_ROOT = join(REPO_ROOT, 'scripts');

function callsMain(node: ts.Node): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'main'
  ) {
    return true;
  }
  return ts.forEachChild(node, (child) => (callsMain(child) ? true : undefined)) ?? false;
}

function isImportMetaMain(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === 'main' &&
    ts.isMetaProperty(expr.expression) &&
    expr.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

function scan(fileName: string, text: string): { unguarded: number[]; guarded: number } {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName)
  );
  const unguarded: number[] = [];
  let guarded = 0;
  for (const statement of sf.statements) {
    if (!callsMain(statement)) continue;
    if (ts.isFunctionDeclaration(statement)) continue; // a definition, not a call
    if (ts.isIfStatement(statement) && isImportMetaMain(statement.expression)) {
      guarded++;
      continue;
    }
    unguarded.push(sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line + 1);
  }
  return { unguarded, guarded };
}

let swept: { findings: string[]; guarded: number; files: number } | undefined;

function sweep(): { findings: string[]; guarded: number; files: number } {
  if (swept) return swept;
  const files = tsFilesUnder(SCRIPTS_ROOT).sort();
  const findings: string[] = [];
  let guarded = 0;
  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    const result = scan(rel, readFileSync(file, 'utf8'));
    for (const line of result.unguarded) findings.push(`${rel}:${line}`);
    guarded += result.guarded;
  }
  swept = { findings, guarded, files: files.length };
  return swept;
}

describe('scripts run main() only when invoked directly', () => {
  test('every top-level main() call in scripts/ is behind if (import.meta.main)', () => {
    expect(
      sweep().findings,
      'Wrap it: `if (import.meta.main) main().catch(…)`. Without the guard, importing the ' +
        'script for one helper runs the whole thing — inside bun test, against real data.'
    ).toEqual([]);
  });

  test('the sweep reached the scripts it exists for (an empty scan is not a pass)', () => {
    const { files, guarded } = sweep();
    expect(files).toBeGreaterThan(30);
    // cache.ts plus the thirteen guarded alongside this gate.
    expect(guarded).toBeGreaterThanOrEqual(14);
  });

  test.each([
    ['a bare call', 'main();'],
    ['a call with a catch', 'main().catch((e) => console.error(e));'],
    ['void', 'void main();'],
    ['top-level await', 'await main();'],
    ['a guard on something else', 'if (process.argv.length > 2) main();'],
  ])('flags: %s', (_label, text) => {
    expect(scan('specimen.ts', text).unguarded).toHaveLength(1);
  });

  test.each([
    ['the guard', 'if (import.meta.main) main();'],
    [
      'the guard with a block',
      'if (import.meta.main) {\n  main().catch(() => process.exit(1));\n}',
    ],
    ['the definition alone', 'async function main(): Promise<void> {}'],
  ])('accepts: %s', (_label, text) => {
    expect(scan('specimen.ts', text).unguarded).toEqual([]);
  });
});
