/**
 * The contract of tests/helpers/ts-files.ts.
 *
 * `scriptKindFor` had no test file of its own and its only assertion lived
 * under a `describe` about `stripComments`, which is not where the next reader
 * looks for it: the invariant it carries is "ScriptKind follows the
 * extension", not anything about comments, and its callers are spread across
 * the tests/ tree. WHO they are is not restated here. tsconfig.tests.json's
 * header carries that map and tests/unit/tsconfig-tests-sync.test.ts derives
 * it from the tree, so a list here would be a second one that nothing gates —
 * which is what it was, and it had already gone wrong.
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
    // And the measurement above is now a GATE rather than a note about one
    // `tsc` run. Indexed deliberately: the claim being re-run is that the
    // table's VALUES are compile-checked, and `mapped` not being `any` is
    // weaker than that. If `Object.fromEntries`'s `T` ever infers as `any`
    // while the tuple shape still matches, `mapped` is
    // `{ [k: string]: any }` — assigning THAT to a `string` is still an error,
    // so a gate written against `mapped` would stay green while the four
    // values below went unchecked, which is the failure it exists to catch.
    //
    // `mapped['.ts']` is `ts.ScriptKind`, a numeric enum, so the assignment is
    // an error today and the directive is used. The day the value type becomes
    // `any` — whether the whole expression widened or only the values — it
    // compiles, the directive goes unused, and `tsc` fails with TS2578. No
    // `| undefined` noise: this program sets `noUncheckedIndexedAccess: false`.
    // Two assertions, because neither half is the claim on its own. A
    // suppressor passes on ANY error, so it says "not assignable to `string`",
    // which `unknown` also satisfies; a positive assignment says "assignable
    // to ScriptKind", which `any` also satisfies. Together they are exact:
    // the positive one rejects `unknown`, `string`, a widened union; the
    // suppressor rejects the `any` the positive one would wave through.
    const valuesAreScriptKind: ts.ScriptKind = mapped['.ts'];
    void valuesAreScriptKind;
    // @ts-expect-error `mapped`'s VALUES must be ScriptKind, not `any`; see above.
    const valuesMustNotBeAny: string = mapped['.ts'];
    void valuesMustNotBeAny;
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
    // fail it on the missing key — what the table derives from `EXTENSIONS` is
    // the key SET, not the expected values, which are hand-listed. So this
    // floor is not what catches a dropped `.ts` today. It is here for the day
    // that literal is derived too, which would leave nothing else naming an
    // extension outright. Floor, not a budget.
    expect(EXTENSIONS.length).toBeGreaterThanOrEqual(1);
    expect(EXTENSIONS).toContain('.ts');
  });
});
