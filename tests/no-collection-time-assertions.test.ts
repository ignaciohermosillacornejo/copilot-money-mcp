/**
 * No test file may assert outside a test (#713, #714).
 *
 * `bun test` evaluates every module body and every `describe` callback first,
 * to discover what tests exist, and only then runs them. An `expect()` that
 * fires during that phase has no test to attribute the failure to, so the
 * runner reports it as an unnamed "Unhandled error between tests" — and, worse,
 * every `test()` the throw skipped past is never registered at all. The run
 * goes red, but the message written for the failure is not attached to
 * anything, and the count of tests silently shrinks.
 *
 * Two instances in two weeks:
 *   - #713 `tests/docs/migration-guide.test.ts` — a duplicate table row
 *     asserted at module scope.
 *   - #714 `tests/scripts/synthesized-field-coverage.test.ts` — a ledger lookup
 *     that asserted, invoked from a `describe` body via `.map(evidenceFor)`.
 *     A renamed ledger surface dropped two tests from the run and reported the
 *     cause as a load error naming no test.
 *
 * The correct split, and what this gate exists to enforce the shape of:
 *   - THROW for a structural problem that leaves nothing to test (a missing
 *     file, a missing marker) — a plain `throw` is the honest signal there, and
 *     this gate permits it;
 *   - COLLECT during the walk and ASSERT inside a named test for a problem the
 *     file still has a test to report.
 *
 * WHAT IT CATCHES — per file, syntax only, no type checker:
 *   - an `expect()` evaluated at collection time (module body or `describe`
 *     body), directly;
 *   - a locally declared helper that asserts, *named* anywhere in
 *     collection-time code — called (`evidenceFor(s)`) or merely passed along
 *     (`.map(evidenceFor)`, which is how #714 actually reached the body).
 *
 * WHAT IT DOES NOT CATCH, stated rather than implied: an asserting helper
 * imported from another module (the analysis is per-file), and a helper reached
 * only through a value the syntax cannot follow (stored in an object, returned
 * from a factory). Both were absent from the two real instances, and closing
 * them needs a type checker rather than a parse.
 */

import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const TESTS_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TESTS_ROOT, '..');

/** Callbacks passed to these run AFTER collection, so assertions are fine inside. */
const DEFERRED_CALLERS = new Set([
  'test',
  'it',
  'beforeAll',
  'afterAll',
  'beforeEach',
  'afterEach',
]);

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...testFiles(full));
    else if (name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Leftmost identifier of a callee: `test.each(x)` and `it.skip` both -> the root. */
function rootCalleeName(expr: ts.Expression): string | undefined {
  let node: ts.Node = expr;
  for (;;) {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      node = node.expression;
    else if (ts.isCallExpression(node)) node = node.expression;
    else return undefined;
  }
}

/** `expect(x)` itself — not the `.toEqual(...)` call wrapped around it. */
function isExpectCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'expect'
  );
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** The name a function-like node is declared under, if it has one. */
function declaredName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node)) return node.name?.text;
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
    return parent.name.text;
  return undefined;
}

interface Finding {
  file: string;
  line: number;
  what: string;
}

function scan(file: string): Finding[] {
  const text = readFileSync(file, 'utf8');
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const rel = relative(REPO_ROOT, file);
  const findings: Finding[] = [];

  /** Function-like nodes whose body runs only after collection. */
  const deferred = new Set<ts.Node>();
  /** name -> declaration, for local helpers that contain an `expect()`. */
  const asserting = new Map<string, ts.Node>();

  const mark = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && DEFERRED_CALLERS.has(rootCalleeName(node.expression) ?? '')) {
      for (const arg of node.arguments) if (isFunctionLike(arg)) deferred.add(arg);
    }
    ts.forEachChild(node, mark);
  };
  mark(src);

  /** Nearest enclosing function-like node that is NOT deferred-rooted. */
  const collectionTime = (node: ts.Node): boolean => {
    for (let p = node.parent; p; p = p.parent) if (deferred.has(p)) return false;
    return true;
  };

  /** Does this function assert, ignoring `test()` bodies nested inside it? */
  const assertsDirectly = (fn: ts.Node): boolean => {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (deferred.has(node)) return;
      if (isExpectCall(node)) found = true;
      else ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn, visit);
    return found;
  };

  const collectHelpers = (node: ts.Node): void => {
    if (isFunctionLike(node) && !deferred.has(node) && assertsDirectly(node)) {
      const name = declaredName(node);
      if (name) asserting.set(name, node);
    }
    ts.forEachChild(node, collectHelpers);
  };
  collectHelpers(src);

  const lineOf = (node: ts.Node): number =>
    src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;

  const visit = (node: ts.Node): void => {
    // A bare `expect()` in the module body or a `describe` body, not inside any
    // helper — the direct form (#713).
    if (isExpectCall(node) && collectionTime(node)) {
      let insideHelper = false;
      for (let p = node.parent; p; p = p.parent) if (isFunctionLike(p)) insideHelper = true;
      if (!insideHelper) {
        findings.push({ file: rel, line: lineOf(node), what: 'expect() at collection time' });
      }
    }

    // An asserting helper named in collection-time code: called, or handed to
    // something that will call it during collection (#714's `.map(evidenceFor)`).
    if (ts.isIdentifier(node) && asserting.has(node.text) && collectionTime(node)) {
      const decl = asserting.get(node.text)!;
      const insideOwnDeclaration = (): boolean => {
        for (let p: ts.Node | undefined = node; p; p = p.parent) if (p === decl) return true;
        return false;
      };
      const isTheDeclarationName =
        node.parent &&
        ((ts.isVariableDeclaration(node.parent) && node.parent.name === node) ||
          (ts.isFunctionDeclaration(node.parent) && node.parent.name === node));
      if (!insideOwnDeclaration() && !isTheDeclarationName) {
        findings.push({
          file: rel,
          line: lineOf(node),
          what: `\`${node.text}\` asserts, and is named at collection time`,
        });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(src);

  return findings;
}

const files = testFiles(TESTS_ROOT);
const findings = files.flatMap(scan);

describe('no test file asserts outside a test', () => {
  test('guards the gate: the scan found the test suite', () => {
    // An empty file list, or a parse that silently produced nothing, would make
    // the assertion below a pass over zero files.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith('no-collection-time-assertions.test.ts'))).toBe(true);
  });

  test('guards the gate: the scanner recognises the shape it looks for', () => {
    // The detector is only worth its runtime if it still fires. This is the
    // #714 shape, verbatim, fed through the same scanner via a fixture file.
    const fixture = join(TESTS_ROOT, 'fixtures', 'collection-time-assertion-sample.ts');
    const found = scan(fixture);
    expect(
      found.map((f) => f.what).sort(),
      `tests/fixtures/collection-time-assertion-sample.ts reproduces both shapes this gate ` +
        `exists to catch. Finding neither means the scanner stopped working, not that the ` +
        `suite is clean.`
    ).toEqual([
      '`assertingHelper` asserts, and is named at collection time',
      'expect() at collection time',
    ]);
  });

  test('every expect() runs inside a test or hook', () => {
    expect(
      findings.map((f) => `${f.file}:${f.line} — ${f.what}`),
      `These assertions are evaluated while bun is still collecting tests, so a failure is ` +
        `reported as an unnamed load error and every test the throw skipped past is never ` +
        `registered (#713, #714). Either throw instead — right for a structural problem that ` +
        `leaves nothing to test — or collect the problem during the walk and assert on it ` +
        `inside a named test.`
    ).toEqual([]);
  });
});
