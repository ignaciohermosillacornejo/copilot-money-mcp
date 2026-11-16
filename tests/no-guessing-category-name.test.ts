/**
 * Class detector: `getCategoryName()` is referenced nowhere in `src/` outside
 * `src/utils/categories.ts`, the module that defines it (#867).
 *
 * WHY: getCategoryName()'s fallback makes up a name for an id it does not
 * know: it title-cases a snake_case id and echoes any other id unchanged.
 * Reached from a field a client reads, a lookup miss (a deleted or unsynced
 * category) looks like a real name. That has shipped three times, #69, #91
 * and #867, and each fix removed one caller while the function stayed
 * importable everywhere. Code that returns a name uses
 * `lookupKnownCategoryName()`, which answers `null` for an unknown id, so the
 * caller decides how "no name" looks (an absent key or `null`).
 *
 * WHAT IT CATCHES: any identifier `getCategoryName` in a TypeScript file
 * under `src/` other than the defining module: a named import, a renamed
 * import (`{ getCategoryName as x }`), a namespace access
 * (`categories.getCategoryName`), a re-export by name, or a call. Comments
 * that mention it are not identifiers and are not flagged.
 *
 * WHAT IT DOES NOT CATCH: a reach through `export *` followed by a
 * computed property access, e.g. `utils['getCategory' + 'Name']`. Nothing
 * here is written that way.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { scriptKindFor, tsFilesUnder } from './helpers/ts-files.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFINING_MODULE = 'src/utils/categories.ts';
const NAME = 'getCategoryName';

/** Line numbers of every `getCategoryName` identifier in `source`. */
function guessingResolverReferences(fileName: string, source: string): number[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName)
  );
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === NAME) {
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

describe('getCategoryName() stays inside its module (#867)', () => {
  test('the sweep sees the shapes it claims to catch, and skips comments', () => {
    const sample = [
      "import { getCategoryName } from '../utils/categories.js';",
      "import { getCategoryName as guess } from '../utils/categories.js';",
      "import * as categories from '../utils/categories.js';",
      "const a = categories.getCategoryName('x');",
      "export { getCategoryName } from '../utils/categories.js';",
      '// getCategoryName() is not used here',
      '/** Deliberately NOT getCategoryName(). */',
    ].join('\n');
    expect(guessingResolverReferences('sample.ts', sample)).toEqual([1, 2, 4, 5]);
  });

  test('the defining module is where the sweep expects it', () => {
    expect(
      guessingResolverReferences(
        DEFINING_MODULE,
        readFileSync(join(REPO_ROOT, DEFINING_MODULE), 'utf8')
      ).length
    ).toBeGreaterThan(0);
  });

  test('no other src/ file references it', () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(join(REPO_ROOT, 'src'))) {
      const rel = relative(REPO_ROOT, file);
      if (rel === DEFINING_MODULE) continue;
      for (const line of guessingResolverReferences(rel, readFileSync(file, 'utf8'))) {
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
