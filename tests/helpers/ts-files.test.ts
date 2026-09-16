/**
 * The contract of tests/helpers/ts-files.ts.
 *
 * `scriptKindFor` had no test file of its own and its only assertion lived
 * under a `describe` about `stripComments`, which is not where the next reader
 * looks for it — it has four callers (`strip-comments.ts`,
 * `exported-constants.test.ts`, `no-hand-rolled-comment-strippers.test.ts`,
 * and this file) and the invariant it carries is "ScriptKind follows the
 * extension", not anything about comments. Same four named in
 * tsconfig.tests.json's importer map; if these two lists ever disagree, one of
 * them is wrong and neither is a gate.
 *
 * The mapping is asserted by DERIVING it from `EXTENSIONS` rather than
 * hand-listing the four values. Hand-listing is the drift shape this whole
 * file set is a ratchet against: the walker's docblock explicitly anticipates
 * the list growing, and on the day it does, a copied assertion keeps passing
 * while the new extension is walked and parsed under a kind nothing pinned.
 */

import { describe, expect, test } from 'bun:test';
import ts from 'typescript';

import { EXTENSIONS, scriptKindFor } from './ts-files.js';

describe('ts-files: ScriptKind follows the extension', () => {
  test('every extension the walker collects has a pinned kind', () => {
    // Derived, not copied. The assertion is over the real list, so adding an
    // extension without deciding its kind fails here rather than silently
    // parsing those files as TS.
    // No `as const` on the callback's return, deliberately. Review of #732 read
    // this as resolving to `Object.fromEntries`'s untyped `any` overload, which
    // would make the `toEqual` below a runtime check only. Measured instead of
    // reasoned about: with the array literal exactly as written, `tsc -p
    // tsconfig.tests.json` reports `mapped` as `{ [k: string]: ts.ScriptKind }`
    // — identical with and without the annotation — so the values in the table
    // below ARE compile-checked and the annotation would buy nothing.
    //
    // What did buy something is this file being on tsconfig.tests.json's
    // include list at all: before that, no program read it, and the type it
    // resolved to was moot.
    const mapped = Object.fromEntries(EXTENSIONS.map((ext) => [ext, scriptKindFor(`f${ext}`)]));
    expect(mapped).toEqual({
      '.ts': ts.ScriptKind.TS,
      '.tsx': ts.ScriptKind.TSX,
      '.mts': ts.ScriptKind.TS,
      '.cts': ts.ScriptKind.TS,
    });
  });

  test('exactly one of them is JSX', () => {
    // The property the mapping exists for, stated independently of the table
    // above so that widening `EXTENSIONS` to another JSX-bearing extension has
    // to be a deliberate edit here too.
    const jsx = EXTENSIONS.filter((ext) => scriptKindFor(`f${ext}`) === ts.ScriptKind.TSX);
    expect(jsx).toEqual(['.tsx']);
  });

  test('the walker list is non-empty and holds `.ts` (guards the guard)', () => {
    // The `exactly one of them is JSX` test states nothing about what
    // EXTENSIONS must CONTAIN — it is derived from the list, so it describes
    // whatever list it is handed, and an empty one fails it only by accident
    // (`[]` is not `['.tsx']`). The table test above is stronger than that: it
    // compares against a hand-written four-key literal, so dropping `.ts` DOES
    // fail it on the missing key. That literal is the reason to keep this one
    // anyway — it is the thing the file's own docblock says will be derived
    // from EXTENSIONS one day, and on that day this is the only assertion left
    // naming an extension outright. Floor, not a budget.
    expect(EXTENSIONS.length).toBeGreaterThanOrEqual(1);
    expect(EXTENSIONS).toContain('.ts');
  });
});
