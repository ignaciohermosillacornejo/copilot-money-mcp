/**
 * The contract of tests/helpers/ts-files.ts.
 *
 * `scriptKindFor` had no test file of its own and its only assertion lived
 * under a `describe` about `stripComments`, which is not where the next reader
 * looks for it — it has three callers (`strip-comments.ts`,
 * `exported-constants.test.ts`, `no-hand-rolled-comment-strippers.test.ts`) and
 * the invariant it carries is "ScriptKind follows the extension", not anything
 * about comments.
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
    // An empty EXTENSIONS would make both assertions above vacuous — the first
    // compares `{}` to a literal and would fail, but the second would pass on
    // an empty filter. Floor, not a budget.
    expect(EXTENSIONS.length).toBeGreaterThanOrEqual(1);
    expect(EXTENSIONS).toContain('.ts');
  });
});
