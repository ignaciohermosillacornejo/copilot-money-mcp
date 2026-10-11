/**
 * Class detector: no relative module specifier in `src/`, `scripts/` or
 * `tests/` may end in a TypeScript extension (#789).
 *
 * WHY: bun resolves `import … from '../../scripts/x.ts'` happily at runtime,
 * so the suite runs green — but `tsc` rejects the specifier (TS5097) unless
 * `allowImportingTsExtensions` is on, which it is not here. A file written
 * that way therefore stays OUT of every typechecked program, because adding it
 * to one would turn the typecheck red; and because no program contains it,
 * nothing says so. That is how `tests/scripts/check-action-pins.test.ts`
 * imported its subject as `.ts` and went typechecked by nothing. Fixing that
 * file was the instance; this sweep is the class, so the next file written the
 * same way fails here instead of slipping out of coverage in silence.
 *
 * WHAT IT CATCHES — syntax only, every TypeScript file under the three trees:
 * the specifier of an `import … from`, an `export … from`, an
 * `import x = require(…)`, a dynamic `import(…)` with a string-literal
 * argument, and a type-position `import('…').T`, when the specifier is
 * relative (`./`, `../`) and ends in `.ts`, `.tsx`, `.mts` or `.cts`.
 * Paths built at runtime and handed to `Bun.spawn` or `new URL(…)` are
 * deliberately NOT import specifiers and are not flagged —
 * several gate tests spawn a script by its `.ts` path, which is correct.
 *
 * WHAT IT DOES NOT CATCH: a specifier computed at runtime (`import(path)`),
 * and a template literal with substitutions. Neither occurs in a form `tsc`
 * would reject the same way, which is the property this exists to protect.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { scriptKindFor, tsFilesUnder } from './helpers/ts-files.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TREES = ['src', 'scripts', 'tests'] as const;
const TS_EXTENSION = /\.(?:ts|tsx|mts|cts)$/;

interface Offender {
  file: string;
  line: number;
  specifier: string;
}

/** Every relative, TS-extension module specifier in `source`. */
function tsExtensionSpecifiers(fileName: string, source: string): Offender[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName)
  );
  const found: Offender[] = [];
  const check = (node: ts.Node | undefined): void => {
    if (node === undefined || !ts.isStringLiteralLike(node)) return;
    const spec = node.text;
    if ((spec.startsWith('./') || spec.startsWith('../')) && TS_EXTENSION.test(spec)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      found.push({ file: fileName, line: line + 1, specifier: spec });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      check(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      check(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      check(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      // `type T = import('./x.ts').Foo` — a type-position import, which tsc
      // rejects with the same TS5097 and which is not a CallExpression.
      check(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('no relative import specifier ends in a TypeScript extension', () => {
  test('the detector recognises every specifier shape it claims to', () => {
    // Guards the sweep below against passing vacuously: each shape named in
    // the docblock must be found, and the non-specifiers must not be.
    const specimen = [
      "import a from './a.ts';",
      "import type { B } from '../b.tsx';",
      "export { c } from './c.mts';",
      "import d = require('../d.cts');",
      "const e = await import('./e.ts');",
      "type J = import('./j.ts').X;",
      // Not specifiers, or not relative: none of these may be flagged.
      "import f from './f.js';",
      "import g from 'some-package.ts';",
      "const h = new URL('../h.ts', import.meta.url);",
      "Bun.spawn(['bun', 'run', './i.ts']);",
    ].join('\n');
    expect(tsExtensionSpecifiers('specimen.ts', specimen).map((o) => o.specifier)).toEqual([
      './a.ts',
      '../b.tsx',
      './c.mts',
      '../d.cts',
      './e.ts',
      './j.ts',
    ]);
  });

  test('src/, scripts/ and tests/ hold none', () => {
    const offenders: Offender[] = [];
    let scanned = 0;
    for (const tree of TREES) {
      for (const abs of tsFilesUnder(join(REPO_ROOT, tree))) {
        const rel = relative(REPO_ROOT, abs);
        // Local, untracked scratch — excluded from tsconfig.scripts.json too.
        if (rel.startsWith(join('scripts', 'local'))) continue;
        scanned += 1;
        offenders.push(...tsExtensionSpecifiers(rel, readFileSync(abs, 'utf8')));
      }
    }
    // A walk that found nothing would pass for the wrong reason.
    expect(scanned).toBeGreaterThan(100);
    expect(
      offenders.map((o) => `${o.file}:${String(o.line)} imports '${o.specifier}'`),
      `Import with a .js specifier instead. bun runs a .ts specifier, but tsc rejects it ` +
        `(TS5097), so a file importing that way can never join a typechecked program and ` +
        `is checked by nothing — the #789 instance.`
    ).toEqual([]);
  });
});
