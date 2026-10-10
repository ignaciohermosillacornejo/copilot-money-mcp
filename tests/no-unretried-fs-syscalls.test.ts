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
 * WHAT IT CATCHES — every TypeScript file under `src/`, syntax only: any
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
 * WHAT IT DOES NOT CATCH, stated so a green run is not over-read:
 *   - `existsSync`. It cannot be retried: it returns `false` on ANY error,
 *     `EINTR` included, so an interrupted existence check reads as "absent"
 *     and nothing downstream can tell. Every `existsSync` in discovery is
 *     followed by a retried `readdirSync` of the same path, which narrows but
 *     does not close that hole;
 *   - the async API (`fs.promises.*`, callback `fs.*`). The only async site
 *     touching these trees is the orphan sweep, which is best effort by design;
 *   - sync ops outside the set (`readFileSync`, `writeFileSync`, `rmSync`, …).
 *     The set is the measured class — directory reads, stats and the snapshot
 *     copy against trees another process writes. Widening it is a deliberate
 *     edit here, not something the gate infers;
 *   - `scripts/`. The sibling scripts that read the real container
 *     (`snapshot.ts`, `profile-database.ts`, `decode-coverage.ts`,
 *     `verify-optimistic-consistency.ts`) were converted by hand in #774, but
 *     `scripts/` also holds many repo-file walkers that are not in the class,
 *     and a gate that flagged all of them would be argued down to an allowlist;
 *   - a binding the scanner does not see by name (`const { readdirSync: r } =
 *     fs`, `fs['readdirSync']`). It matches NAMES, not resolved bindings.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { tsFilesUnder, scriptKindFor } from './helpers/ts-files.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

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

  const visit = (node: ts.Node): void => {
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
        if (isWrapped(call)) wrapped++;
        else report(ref, op, `is called outside ${WRAPPER}(() => …)`);
      } else {
        report(ref, op, 'is referenced as a value, so its calls cannot be checked');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { findings, wrapped };
}

function scanTree(): Scan & { files: number } {
  const all: Scan = { findings: [], wrapped: 0 };
  const files = tsFilesUnder(SRC_ROOT).sort();
  for (const file of files) {
    const { findings, wrapped } = scanSource(relative(REPO_ROOT, file), readFileSync(file, 'utf8'));
    all.findings.push(...findings);
    all.wrapped += wrapped;
  }
  return { ...all, files: files.length };
}

describe('no retryable fs syscall in src/ bypasses retryInterrupted (#774)', () => {
  test('every copy/readdir/mkdtemp/stat in src/ is retried', () => {
    const { findings } = scanTree();
    expect(findings).toEqual([]);
  });

  test('the sweep reached the sites it exists for (an empty scan is not a pass)', () => {
    const { files, wrapped } = scanTree();
    expect(files).toBeGreaterThan(20);
    // The snapshot path alone has six wrapped calls; discovery has three.
    expect(wrapped).toBeGreaterThanOrEqual(9);
    for (const file of ['src/core/leveldb-reader.ts', 'src/core/database.ts']) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(scanSource(file, text).wrapped).toBeGreaterThan(0);
    }
  });
});

describe('the scanner recognises the shapes', () => {
  const flagged = (src: string): number => scanSource('specimen.ts', src).findings.length;
  const wrapped = (src: string): number => scanSource('specimen.ts', src).wrapped;

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

  test('every op in the set is recognised', () => {
    for (const op of RETRYABLE_SYNC_OPS) {
      expect(flagged(`fs.${op}(p);`)).toBe(1);
      expect(wrapped(`retryInterrupted(() => fs.${op}(p));`)).toBe(1);
    }
  });
});
