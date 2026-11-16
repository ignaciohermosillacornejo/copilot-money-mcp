/**
 * Class detector: the category-name resolvers with a guessing fallback are
 * referenced nowhere in `src/` outside the module that defines each (#867).
 *
 *   - `getCategoryName()` (`src/utils/categories.ts`) title-cases a
 *     snake_case id it does not know and echoes any other id unchanged.
 *   - `getCategoryDisplayName()` (`src/models/category.ts`) returns the
 *     category id when the category has no name, and `""` for an empty one.
 *
 * WHY: reached from a field a client reads, either fallback turns a lookup
 * miss (a deleted or unsynced category, or one with no name) into something
 * that looks like a real name. That has shipped three times, #69, #91 and
 * #867, and each fix removed one caller while the function stayed importable
 * everywhere. Code that returns a name uses `lookupKnownCategoryName()`,
 * which answers `null` for an unknown id, or reads a user category's own
 * `name` and treats a missing or empty one as no name, so the caller decides
 * how "no name" looks (an absent key or `null`).
 *
 * WHAT IT CATCHES: any identifier with a banned name in a TypeScript file
 * under `src/` other than that name's defining module: a named import, a
 * renamed import (`{ getCategoryName as x }`), a namespace access
 * (`categories.getCategoryName`), a re-export by name, or a call. Comments
 * that mention it are not identifiers and are not flagged.
 *
 * WHAT IT DOES NOT CATCH: a reach through `export *` followed by a
 * computed property access, e.g. `utils['getCategory' + 'Name']`, and a new
 * resolver with a different name and the same kind of fallback. Nothing here
 * is written the first way; the second is why the table below is the place
 * to add one.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { scriptKindFor, tsFilesUnder } from './helpers/ts-files.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Each guessing resolver, and the one `src/` file allowed to name it. */
const BANNED: ReadonlyArray<{ name: string; definingModule: string }> = [
  { name: 'getCategoryName', definingModule: 'src/utils/categories.ts' },
  { name: 'getCategoryDisplayName', definingModule: 'src/models/category.ts' },
];

/** Line numbers of every identifier called `name` in `source`. */
function references(name: string, fileName: string, source: string): number[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName)
  );
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) {
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

describe('guessing category-name resolvers stay inside their modules (#867)', () => {
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
    expect(references('getCategoryName', 'sample.ts', sample)).toEqual([1, 2, 4, 5]);
  });

  describe.each(BANNED)('$name', ({ name, definingModule }) => {
    test('its defining module is where the sweep expects it', () => {
      const source = readFileSync(join(REPO_ROOT, definingModule), 'utf8');
      expect(references(name, definingModule, source).length).toBeGreaterThan(0);
    });

    test('no other src/ file references it', () => {
      const offenders: string[] = [];
      for (const file of tsFilesUnder(join(REPO_ROOT, 'src'))) {
        const rel = relative(REPO_ROOT, file);
        if (rel === definingModule) continue;
        for (const line of references(name, rel, readFileSync(file, 'utf8'))) {
          offenders.push(`${rel}:${line}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});
