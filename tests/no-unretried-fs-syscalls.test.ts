/**
 * Class detector: no retryable synchronous fs syscall in `src/` may bypass
 * `retryInterrupted` (#774).
 *
 * THE CLASS — `retryable-errno-treated-as-fatal`
 *
 * A syscall error whose contract is "reissue me" (`EINTR`, `EAGAIN`) handled by
 * the same branch as errors that mean "stop". Two instances, one root:
 *
 *   - `leveldb-reader.ts` copy loop: an interrupted `copyFileSync` fell into
 *     `throw err` and failed the whole snapshot — every cache-mode read;
 *   - `findCopilotDatabase()`: an interrupted `readdirSync` fell into a bare
 *     `catch {}` and became "Database not found. Please ensure Copilot Money is
 *     installed and has synced data." for a user who was installed and synced.
 *
 * The directories these calls touch belong to applications that are writing
 * them while we read (Copilot's Firestore container, a browser's profile
 * store). Measured during #756: ~1 `readdirSync` in 1,000 against the live
 * container blocked for seconds and threw `EINTR`.
 *
 * WHAT IT CATCHES — every TypeScript file under `src/`, plus the four scripts
 * in `CONTAINER_SCRIPTS` that read the real container, syntax only: any
 * reference to one of `RETRYABLE_SYNC_OPS` (as `fs.op`, `anything.op`, or a
 * bare imported `op`) that is not exactly the call in
 * `retryInterrupted(() => <ns>.op(...))` — the concise arrow body, passed as
 * the first argument. A bare call, a call inside a block-bodied arrow, an
 * arrow defined elsewhere and passed by name, and taking the function as a
 * value (`const r = fs.readdirSync`) are all flagged. Those last three are
 * fail-closed rather than wrong: they could be retried correctly, but the
 * gate would have to follow data flow to know, and the one accepted shape
 * costs nothing to write.
 *
 * And the wrapper must be the real one: a file whose accepted calls name
 * `retryInterrupted` but that does not import it from `fs-retry` — a local
 * function of that name, or an import from somewhere else — is flagged too,
 * because the shape check alone would pass a wrapper that retries nothing.
 *
 * WHAT IT DOES NOT CATCH, stated so a green run is not over-read:
 *   - `existsSync`. It cannot be retried: it returns `false` on ANY error,
 *     `EINTR` included, so an interrupted existence check reads as "absent"
 *     and nothing downstream can tell. Discovery and `availability()` no
 *     longer call it at all — the retried `readdirSync` is the existence check
 *     there, with `ENOENT` read as absence — and
 *     `tests/core/database-discovery.test.ts` pins that by making `existsSync`
 *     always answer false. `browser-token.ts` dropped the two that sat directly
 *     in front of a retried readdir whose `catch` already returns the same
 *     empty answer (`searchLevelDBDir`, the outer gate in
 *     `searchFirefoxProfiles`), since removing those is behaviour-identical.
 *     The rest remain and are not swept: `iterateDocuments`' path check, the
 *     Chromium profile scan (an interrupt there degrades to the `Default`
 *     profile only), and the inner Firefox/Safari checks, where an unguarded
 *     throw would abort the whole profile loop rather than skip one entry;
 *   - the async API (`fs.promises.*`, callback `fs.*`). The only async site
 *     touching these trees is the orphan sweep, which is best effort by design;
 *   - sync ops outside the set (`readFileSync`, `appendFileSync`,
 *     `writeFileSync`, `rmSync`, …). The set is what was MEASURED to fail —
 *     `readdirSync` (8,470-call histogram, #756) and `copyFileSync` (the
 *     `smoke:cache` crash) — plus `statSync`/`mkdtempSync` on the same paths.
 *     `readFileSync` on the same trees is plausibly in the class too:
 *     `browser-token.ts` reads browser LevelDB files inside `catch { continue }`,
 *     so an interrupt there would be "no token in this file". It is left out
 *     because nothing has measured it, not because it is known safe; widening
 *     the set is a deliberate edit here, not something the gate infers;
 *   - the rest of `scripts/`. It also holds many repo-file walkers that are not
 *     in the class, and a gate that flagged all of them would be argued down to
 *     an allowlist, so only `CONTAINER_SCRIPTS` are swept;
 *   - a binding the scanner does not see by name (`const { readdirSync: r } =
 *     fs`, `fs['readdirSync']`). It matches NAMES, not resolved bindings; the
 *     import check narrows that for the wrapper, but an import of the right
 *     name from `fs-retry` that is then shadowed in an inner scope passes.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { tsFilesUnder, scriptKindFor } from './helpers/ts-files.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

/**
 * The scripts that read the real Copilot container (#774's sibling list, minus
 * five that no longer exist). The rest of `scripts/` walks repo files.
 */
const CONTAINER_SCRIPTS = [
  'scripts/decode-coverage.ts',
  'scripts/profile-database.ts',
  'scripts/snapshot.ts',
  'scripts/verify-optimistic-consistency.ts',
];

/** The module the real wrapper lives in; the one file allowed to define it. */
const HELPER_MODULE = 'src/core/fs-retry.ts';
const HELPER_SPECIFIER = /(^|\/)fs-retry(\.js|\.ts)?$/;

/** The synchronous fs operations in the class. */
const RETRYABLE_SYNC_OPS = new Set(['copyFileSync', 'readdirSync', 'mkdtempSync', 'statSync']);

const WRAPPER = 'retryInterrupted';

interface Scan {
  findings: string[];
  wrapped: number;
}

/** True when `call` is exactly `retryInterrupted(() => call)`, first argument. */
function isWrapped(call: ts.CallExpression): boolean {
  const arrow = call.parent;
  if (!arrow || !ts.isArrowFunction(arrow) || arrow.body !== call) return false;
  const outer = arrow.parent;
  return (
    !!outer &&
    ts.isCallExpression(outer) &&
    ts.isIdentifier(outer.expression) &&
    outer.expression.text === WRAPPER &&
    outer.arguments[0] === arrow
  );
}

function scanSource(fileName: string, text: string): Scan {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName)
  );
  const findings: string[] = [];
  let wrapped = 0;

  const report = (node: ts.Node, op: string, how: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push(`${fileName}:${line + 1} ${op} ${how}`);
  };

  let importsWrapper = false;
  let firstWrapped: ts.Node | undefined;

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      HELPER_SPECIFIER.test(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if (el.name.text === WRAPPER && (el.propertyName ?? el.name).text === WRAPPER) {
            importsWrapper = true;
          }
        }
      }
    }
    // The reference itself: `x.op` or a bare `op` that is not an import
    // specifier and not the `.name` half of a property access.
    let ref: ts.Expression | undefined;
    let op: string | undefined;
    if (ts.isPropertyAccessExpression(node) && RETRYABLE_SYNC_OPS.has(node.name.text)) {
      ref = node;
      op = node.name.text;
    } else if (
      ts.isIdentifier(node) &&
      RETRYABLE_SYNC_OPS.has(node.text) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !ts.isImportSpecifier(node.parent)
    ) {
      ref = node;
      op = node.text;
    }
    if (ref && op) {
      const call = ref.parent;
      if (call && ts.isCallExpression(call) && call.expression === ref) {
        if (isWrapped(call)) {
          wrapped++;
          firstWrapped ??= call;
        } else report(ref, op, `is called outside ${WRAPPER}(() => …)`);
      } else {
        report(ref, op, 'is referenced as a value, so its calls cannot be checked');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (firstWrapped && !importsWrapper && fileName !== HELPER_MODULE) {
    report(
      firstWrapped,
      WRAPPER,
      `is not imported from fs-retry, so the wrapper may retry nothing`
    );
  }
  return { findings, wrapped };
}

let memo: (Scan & { files: string[] }) | undefined;

/** One parse of the tree per run — two tests read it. */
function scanTree(): Scan & { files: string[] } {
  if (memo) return memo;
  const all: Scan = { findings: [], wrapped: 0 };
  const files = [
    ...tsFilesUnder(SRC_ROOT).map((file) => relative(REPO_ROOT, file)),
    ...CONTAINER_SCRIPTS,
  ].sort();
  for (const file of files) {
    const { findings, wrapped } = scanSource(file, readFileSync(join(REPO_ROOT, file), 'utf8'));
    all.findings.push(...findings);
    all.wrapped += wrapped;
  }
  memo = { ...all, files };
  return memo;
}

describe('no retryable fs syscall in src/ bypasses retryInterrupted (#774)', () => {
  test('every copy/readdir/mkdtemp/stat in src/ and the container scripts is retried', () => {
    const { findings } = scanTree();
    expect(findings).toEqual([]);
  });

  test('the sweep reached the sites it exists for (an empty scan is not a pass)', () => {
    const { files, wrapped } = scanTree();
    expect(files.length).toBeGreaterThan(20);
    for (const script of CONTAINER_SCRIPTS) expect(files).toContain(script);
    // The snapshot path alone has six wrapped calls; discovery has three.
    expect(wrapped).toBeGreaterThanOrEqual(9);
    for (const file of [
      'src/core/leveldb-reader.ts',
      'src/core/database.ts',
      ...CONTAINER_SCRIPTS,
    ]) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(scanSource(file, text).wrapped).toBeGreaterThan(0);
    }
  });
});

describe('the scanner recognises the shapes', () => {
  // Specimens that use the wrapper get the real import, so the import check
  // has its own tests below instead of failing every shape test.
  const IMPORT = "import { retryInterrupted } from '../core/fs-retry.js';\n";
  const flagged = (src: string): number => scanSource('specimen.ts', IMPORT + src).findings.length;
  const wrapped = (src: string): number => scanSource('specimen.ts', IMPORT + src).wrapped;
  const raw = (src: string): string[] => scanSource('specimen.ts', src).findings;

  test.each([
    ['bare namespaced call', 'fs.copyFileSync(a, b);'],
    ['bare imported call', 'readdirSync(p);'],
    ['call on any receiver', 'nodeFs.statSync(p);'],
    ['block-bodied arrow', 'retryInterrupted(() => { return fs.readdirSync(p); });'],
    ['arrow passed by name', 'const f = () => fs.mkdtempSync(p);\nretryInterrupted(f);'],
    ['wrapper is the wrong function', 'otherRetry(() => fs.readdirSync(p));'],
    ['arrow is not the first argument', 'retryInterrupted(3, () => fs.readdirSync(p));'],
    ['taken as a value', 'const r = fs.readdirSync;'],
    ['nested one level too deep', 'retryInterrupted(() => g(fs.statSync(p)));'],
  ])('flags: %s', (_label, src) => {
    expect(flagged(src)).toBe(1);
  });

  test.each([
    ['namespaced', 'retryInterrupted(() => fs.copyFileSync(a, b));'],
    ['with options', 'retryInterrupted(() => fs.readdirSync(p, { withFileTypes: true }));'],
    ['bare imported', 'retryInterrupted(() => readdirSync(p));'],
    ['member access on the result', 'retryInterrupted(() => fs.statSync(p)).mtimeMs;'],
  ])('accepts: %s', (_label, src) => {
    expect(flagged(src)).toBe(0);
    expect(wrapped(src)).toBe(1);
  });

  test('ignores import specifiers and ops outside the set', () => {
    expect(
      flagged(
        "import { readdirSync, existsSync } from 'node:fs';\nfs.existsSync(p);\nfs.rmSync(p);"
      )
    ).toBe(0);
  });

  test.each([
    ['no import at all', 'retryInterrupted(() => fs.readdirSync(p));'],
    [
      'a local function of that name',
      'function retryInterrupted<T>(op: () => T): T { return op(); }\nretryInterrupted(() => fs.readdirSync(p));',
    ],
    [
      'imported from somewhere else',
      "import { retryInterrupted } from './my-retry.js';\nretryInterrupted(() => fs.readdirSync(p));",
    ],
    [
      'a different export renamed to it',
      "import { other as retryInterrupted } from './fs-retry.js';\nretryInterrupted(() => fs.readdirSync(p));",
    ],
  ])('flags a wrapper that is not the real one: %s', (_label, src) => {
    expect(raw(src)).toEqual([expect.stringContaining('is not imported from fs-retry')]);
  });

  test.each([
    ["'../core/fs-retry.js'", "import { retryInterrupted } from '../core/fs-retry.js';"],
    ["'./fs-retry.js'", "import { retryInterrupted } from './fs-retry.js';"],
    ["'../src/core/fs-retry.js'", "import { retryInterrupted } from '../src/core/fs-retry.js';"],
  ])('accepts the real import: %s', (_label, imp) => {
    expect(raw(`${imp}\nretryInterrupted(() => fs.readdirSync(p));`)).toEqual([]);
  });

  test('the helper module itself needs no import', () => {
    const text = readFileSync(join(REPO_ROOT, HELPER_MODULE), 'utf8');
    expect(scanSource(HELPER_MODULE, text).findings).toEqual([]);
  });

  test('every op in the set is recognised', () => {
    for (const op of RETRYABLE_SYNC_OPS) {
      expect(flagged(`fs.${op}(p);`)).toBe(1);
      expect(wrapped(`retryInterrupted(() => fs.${op}(p));`)).toBe(1);
    }
  });
});
