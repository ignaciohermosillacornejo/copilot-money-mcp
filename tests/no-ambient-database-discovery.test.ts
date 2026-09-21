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
 * one of the five falsy literals that reach the same discovery branch
 * (`undefined`, `null`, `''`, `""`, and the empty template literal — the set is
 * `FALSY_FIRST_ARGS` below, and the prose is not a second copy of it: a guard
 * test requires one specimen line per member). They are listed because they are
 * the cheapest way to satisfy a gate that only asked for *an* argument while
 * changing nothing about what the constructor does.
 *
 * WHAT IT DOES NOT CATCH, stated rather than implied:
 *   - a path computed at runtime that turns out falsy (`new CopilotDatabase(
 *     process.env.NOPE)`). Deciding that needs evaluation, not a parse; no
 *     instance in this suite, and the failure mode is a loud "database not
 *     found" rather than a stall;
 *   - `new CopilotDatabase(...args)`. The first argument is a `SpreadElement`
 *     whose text is `...args`, which is neither absent nor in the falsy set, so
 *     it passes. Same reason as above: what it spreads to is a runtime fact;
 *   - `new someModule.CopilotDatabase()`. The callee is a
 *     `PropertyAccessExpression`, so the `ts.isIdentifier` test is false and
 *     the node is never considered;
 *   - `import { CopilotDatabase as DB }` then `new DB()`. The callee IS a bare
 *     identifier, just not that text. Both of these follow from the same fact,
 *     stated plainly because an earlier draft of this block got it backwards:
 *     the scanner matches a NAME, it does not resolve a binding. So it also
 *     false-positives on a test that declares its own local
 *     `class CopilotDatabase {}` — fail-closed, and the cheapness is the point,
 *     but neither direction is binding resolution. None of the three shapes
 *     exists in the suite today (checked);
 *   - a database constructed inside a helper OUTSIDE `tests/` that a test
 *     calls. `src/` is excluded on purpose — production constructing without a
 *     path is the feature — so a `src/` factory used only by tests would be
 *     out of reach;
 *   - any other route to ambient machine state. This closes one resource, not
 *     the class. It is exact for that resource only because
 *     `findCopilotDatabase` has exactly one call site and is not exported,
 *     which `the constructor is still the only route` below re-checks rather
 *     than assumes — an under-collecting scan reports clean, so the premise
 *     has to be asserted, not inherited from the day it was written. That
 *     re-check is itself a name match over one file: `export const findDb =
 *     findCopilotDatabase` is caught, but an alias re-exported at a second hop
 *     (`const findDb = findCopilotDatabase;` then `export { findDb }`) is not.
 *     Moving the function to another module fails CLOSED — the call-site
 *     assertion would then find none in `src/core/database.ts` and go red.
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

/** The module-private function whose single call site is this gate's premise. */
const DISCOVERY_FN = 'findCopilotDatabase';

/**
 * Spellings of "no path" that reach `findCopilotDatabase()` anyway.
 *
 * Every member needs its own line in the specimen, which
 * `every falsy spelling it knows has a specimen` enforces in the direction that
 * rots: a member with no specimen is deletable from this set with the suite
 * green, and the sweep then walks past that spelling in silence. `""` is a
 * member even though this repo's prettier rewrites it to `''`, because a
 * `// prettier-ignore` — or a future config — puts it back within reach.
 */
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
function discoveryCallSites(src: ts.SourceFile): string[] {
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
      node.expression.text === DISCOVERY_FN
    ) {
      sites.push(enclosing(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(src);

  return sites;
}

/**
 * Every way `findCopilotDatabase` escapes its module, described.
 *
 * An AST walk rather than a regex over the text, because "not exported" has
 * more spellings than `export function`: `export { findCopilotDatabase }`,
 * `export { findCopilotDatabase as findDb }`, `export const
 * findCopilotDatabase = …` and `export default findCopilotDatabase` each leave
 * it callable from a test while matching no pattern written for the
 * declaration form. A single-spelling check here would be this gate committing
 * the `silent-under-collecting-scan` it exists to refuse. Parsing also stops a
 * docblock that merely MENTIONS `export function findCopilotDatabase` from
 * failing it.
 */
function discoveryExports(src: ts.SourceFile): string[] {
  const found: string[] = [];

  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name?.text === DISCOVERY_FN &&
      isExported(node)
    ) {
      found.push(`exported declaration of ${DISCOVERY_FN}`);
    }
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === DISCOVERY_FN) {
          found.push(`exported binding \`export const ${DISCOVERY_FN}\``);
        }
        // `export const findDb = findCopilotDatabase` — the DECLARED name is
        // innocent and the initializer is the escape. Checking the name alone
        // would let a rename on the way out satisfy the premise while a test
        // imports `findDb` and walks the container directly, which is the
        // under-collecting scan this test exists to refuse.
        if (decl.initializer && ts.isIdentifier(decl.initializer)) {
          if (decl.initializer.text === DISCOVERY_FN) {
            found.push(`exported alias \`${decl.name.getText(src)} = ${DISCOVERY_FN}\``);
          }
        }
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        // `export { a as b }` puts the local name in `propertyName`; a bare
        // `export { a }` leaves that undefined and `name` is the local name.
        const local = element.propertyName?.text ?? element.name.text;
        if (local === DISCOVERY_FN) found.push(`re-export as \`${element.name.text}\``);
      }
    }
    if (
      ts.isExportAssignment(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === DISCOVERY_FN
    ) {
      found.push(`\`export default\` of ${DISCOVERY_FN}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);

  return found;
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
        `exists to catch — one line per FALSY_FIRST_ARGS member, so no member can be deleted ` +
        `from the set with this green — and two it must leave alone. Finding the wrong set ` +
        `means the scanner stopped working, not that the suite is clean.`
    ).toEqual([
      'new CopilotDatabase() with no path',
      'new CopilotDatabase(undefined) — falsy, so discovery runs anyway',
      'new CopilotDatabase(null) — falsy, so discovery runs anyway',
      "new CopilotDatabase('') — falsy, so discovery runs anyway",
      'new CopilotDatabase("") — falsy, so discovery runs anyway',
      'new CopilotDatabase(``) — falsy, so discovery runs anyway',
    ]);
  });

  test('guards the gate: every falsy spelling it knows has a specimen', () => {
    // The assertion above pins a LIST of findings; this one pins that list
    // against the SET it is derived from, which is the direction that rots.
    // Adding a member to FALSY_FIRST_ARGS without a specimen line leaves it
    // deletable again with everything green — under-collection reported as a
    // pass, which is the failure mode this whole file is about.
    const covered = new Set(
      scan(SPECIMEN)
        .map((finding) => /^new CopilotDatabase\((.*)\) — falsy/.exec(finding.what)?.[1])
        .filter((spelling): spelling is string => spelling !== undefined)
    );
    expect(
      [...FALSY_FIRST_ARGS].filter((spelling) => !covered.has(spelling)),
      `Every FALSY_FIRST_ARGS member needs its own line in the specimen. A member with none ` +
        `can be deleted from the set with the suite green, and the sweep then walks past that ` +
        `spelling in silence.`
    ).toEqual([]);
  });

  test('guards the gate: the constructor is still the only route to discovery', () => {
    // Parsed once and handed to both walks. `sweepSuite()` two functions up is
    // memoised for exactly this reason, and one file's AST built twice in one
    // test would read as an oversight rather than a choice.
    const databaseSource = parse(DATABASE_SOURCE);
    // This gate is exact only while argument-less construction is the sole way
    // a test can reach `findCopilotDatabase`. A second call site, or an
    // `export`, would leave the sweep reporting clean over a route it cannot
    // see — the failure mode this project files under `silent-under-collecting-scan`.
    expect(
      discoveryCallSites(databaseSource),
      `src/core/database.ts must call findCopilotDatabase() from the constructor and nowhere ` +
        `else, or the sweep below stops being an exact statement about what tests can reach.`
    ).toEqual(['CopilotDatabase constructor']);
    expect(
      discoveryExports(databaseSource),
      'findCopilotDatabase() must stay module-private. Exported under ANY spelling — a ' +
        'declaration modifier, a named re-export, an alias, a default — a test could call it ' +
        'directly, and the sweep below would stop being an exact statement about what tests ' +
        'can reach.'
    ).toEqual([]);
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
