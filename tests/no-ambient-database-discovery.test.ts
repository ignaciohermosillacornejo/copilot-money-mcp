/**
 * No test may let `CopilotDatabase` go looking for the real database (#756).
 *
 * `new CopilotDatabase()` with no path calls `findCopilotDatabase()`, which
 * `existsSync`/`readdirSync`-walks the user's live Copilot Money Firestore
 * container. That is right for the server and for `scripts/smoke/*`, whose job
 * is to find the real database. It is wrong inside a unit test, whose result
 * then depends on the state of another application's data directory on the
 * machine that happens to be running it.
 *
 * The instance: `tests/core/database-errors.test.ts` constructed sixteen
 * databases that way and immediately assigned `dbPath = undefined` over the
 * result — it wanted the *absence* of a path, and paid for a discovery walk to
 * get it. Measured over 8,470 `readdirSync` calls against that container on an
 * idle machine, the latency is bimodal: 93% under 1ms, nothing at all between
 * 100ms and 1s, and 8 calls (~0.1%) that blocked for seconds and then failed
 * with `EINTR`, the longest at 6,366ms. Thirty-two such calls per run of that
 * one file put a multi-second stall in about 10% of runs, and bun's 5,000ms
 * default test timeout turned each stall into a failed assertion naming
 * whichever getter was executing. `bun run check` is the pre-push hook, so the
 * cost was landing on unrelated pushes.
 *
 * WHAT IT CATCHES — every `tests/**` TypeScript file, syntax only, no type
 * checker: a `new CopilotDatabase(...)` whose first argument is absent, or is
 * one of the falsy literals that reach the same discovery branch (`undefined`,
 * `null`, `''`). The falsy literals are listed because they are the cheapest
 * way to satisfy a gate that only asked for *an* argument while changing
 * nothing about what the constructor does.
 *
 * WHAT IT DOES NOT CATCH, stated rather than implied:
 *   - a path computed at runtime that turns out falsy (`new CopilotDatabase(
 *     process.env.NOPE)`). Deciding that needs evaluation, not a parse; no
 *     instance in this suite, and the failure mode is a loud "database not
 *     found" rather than a stall;
 *   - a database constructed inside a helper OUTSIDE `tests/` that a test
 *     calls. `src/` is excluded on purpose — production constructing without a
 *     path is the feature — so a `src/` factory used only by tests would be
 *     out of reach;
 *   - any other route to ambient machine state. This closes one resource, not
 *     the class. It is exact for that resource only because
 *     `findCopilotDatabase` has exactly one call site and is not exported,
 *     which `the constructor is still the only route` below re-checks rather
 *     than assumes — an under-collecting scan reports clean, so the premise
 *     has to be asserted, not inherited from the day it was written.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { tsFilesUnder, scriptKindFor } from './helpers/ts-files.js';

const TESTS_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TESTS_ROOT, '..');
const DATABASE_SOURCE = join(REPO_ROOT, 'src', 'core', 'database.ts');

/**
 * The deliberate specimen reproduces every shape on purpose, so the sweep must
 * skip it — `the scanner recognises the shapes` scans it directly instead.
 */
const SPECIMEN = join(TESTS_ROOT, 'fixtures', 'ambient-database-discovery-sample.ts');

/** Spellings of "no path" that reach `findCopilotDatabase()` anyway. */
const FALSY_FIRST_ARGS = new Set(['undefined', 'null', "''", '""', '``']);

interface Finding {
  file: string;
  line: number;
  what: string;
}

/**
 * Every TypeScript file under `tests/`, helpers and fixtures included, minus
 * the specimen.
 *
 * `tsFilesUnder` rather than a fourth hand-rolled walk: this wants exactly what
 * that helper is — every TS file under a tree, `node_modules`/`dist` skipped,
 * and the whole `.ts`/`.tsx`/`.mts`/`.cts` family, so a file renamed out of
 * `.ts` is not silently dropped from the sweep. Sorted here because the helper
 * returns readdir order, which is the filesystem's: a multi-finding message is
 * read by diffing it against the one someone else saw.
 */
function testFiles(dir: string): string[] {
  return tsFilesUnder(dir)
    .filter((file) => file !== SPECIMEN)
    .sort();
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file)
  );
}

function scan(file: string): Finding[] {
  const src = parse(file);
  const rel = relative(REPO_ROOT, file);
  const findings: Finding[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'CopilotDatabase'
    ) {
      const first = node.arguments?.[0];
      const spelling = first?.getText(src);
      const missing = first === undefined;
      if (missing || FALSY_FIRST_ARGS.has(spelling ?? '')) {
        findings.push({
          file: rel,
          line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1,
          what: missing
            ? 'new CopilotDatabase() with no path'
            : `new CopilotDatabase(${spelling}) — falsy, so discovery runs anyway`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);

  return findings;
}

/** Every call to `findCopilotDatabase`, with the enclosing declaration named. */
function discoveryCallSites(file: string): string[] {
  const src = parse(file);
  const sites: string[] = [];

  const enclosing = (node: ts.Node): string => {
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
      if (ts.isConstructorDeclaration(p)) return 'CopilotDatabase constructor';
      if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name)) return `method ${p.name.text}`;
      if (ts.isFunctionDeclaration(p) && p.name) return `function ${p.name.text}`;
    }
    return 'module scope';
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'findCopilotDatabase'
    ) {
      sites.push(enclosing(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(src);

  return sites;
}

let swept: { files: string[]; findings: Finding[] } | undefined;

/** The whole-suite walk, run once on first use and never at collection time. */
function sweepSuite(): { files: string[]; findings: Finding[] } {
  if (!swept) {
    const files = testFiles(TESTS_ROOT);
    swept = { files, findings: files.flatMap(scan) };
  }
  return swept;
}

describe('no test discovers the real Copilot database', () => {
  test('guards the gate: the scan found the test suite', () => {
    // An empty file list would make the sweep below a pass over nothing.
    const { files } = sweepSuite();
    expect(files.length).toBeGreaterThan(100);
    expect(
      files.some((f) => f.endsWith(join('core', 'database-errors.test.ts'))),
      'The sweep must reach the file this gate was written for.'
    ).toBe(true);
    expect(files, 'The deliberate specimen must be scanned only by the gate below.').not.toContain(
      SPECIMEN
    );
  });

  test('guards the gate: the scanner recognises the shapes it looks for', () => {
    const found = scan(SPECIMEN);
    expect(
      found.map((f) => f.what),
      `tests/fixtures/ambient-database-discovery-sample.ts reproduces every shape this gate ` +
        `exists to catch, and two it must leave alone. Finding the wrong set means the ` +
        `scanner stopped working, not that the suite is clean.`
    ).toEqual([
      'new CopilotDatabase() with no path',
      'new CopilotDatabase(undefined) — falsy, so discovery runs anyway',
      "new CopilotDatabase('') — falsy, so discovery runs anyway",
    ]);
  });

  test('guards the gate: the constructor is still the only route to discovery', () => {
    // This gate is exact only while argument-less construction is the sole way
    // a test can reach `findCopilotDatabase`. A second call site, or an
    // `export`, would leave the sweep reporting clean over a route it cannot
    // see — the failure mode this project files under `silent-under-collecting-scan`.
    expect(
      discoveryCallSites(DATABASE_SOURCE),
      `src/core/database.ts must call findCopilotDatabase() from the constructor and nowhere ` +
        `else, or the sweep below stops being an exact statement about what tests can reach.`
    ).toEqual(['CopilotDatabase constructor']);
    expect(
      readFileSync(DATABASE_SOURCE, 'utf8'),
      'findCopilotDatabase() must stay module-private; exported, a test could call it directly.'
    ).not.toMatch(/export\s+(async\s+)?function\s+findCopilotDatabase\b/);
  });

  test('every CopilotDatabase built in a test is given a path', () => {
    const { findings } = sweepSuite();
    expect(
      findings.map((f) => `${f.file}:${f.line} — ${f.what}`),
      `Constructing CopilotDatabase without a path runs findCopilotDatabase(), which walks ` +
        `the user's live Copilot Money container. That readdir is bimodal — usually ` +
        `sub-millisecond, ~0.1% of the time a multi-second block ending in EINTR — so it puts ` +
        `bun's 5,000ms test timeout inside a test that never wanted the filesystem at all ` +
        `(#756). Pass any non-empty path; assign over it afterwards if the test wants none.`
    ).toEqual([]);
  });
});
