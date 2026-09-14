/**
 * The two shapes `tests/no-collection-time-assertions.test.ts` exists to catch,
 * kept as a fixture so that gate can prove it still recognises them.
 *
 * Deliberately NOT named `*.test.ts`, so `bun test` never collects it — if it
 * did, this file would fail the way the real bugs did. It is scanned as text.
 *
 * Do not "fix" the assertions below. They are the specimen.
 */

import { describe, test, expect } from 'bun:test';

const rows = [1, 2, 3];

// Shape 1 (#713): a bare assertion in the module body.
expect(rows.length).toBeGreaterThan(0);

describe('a specimen', () => {
  // Shape 2 (#714): a helper that asserts, invoked from the describe body —
  // here by reference, which is how the real one reached it.
  const assertingHelper = (n: number): number => {
    expect(n).toBeGreaterThan(0);
    return n * 2;
  };

  const doubled = rows.map(assertingHelper);

  test('sees the doubled rows', () => {
    // An assertion in a test body is the correct shape and must NOT be flagged.
    expect(doubled).toEqual([2, 4, 6]);
  });
});

// Must NOT be flagged: a re-export names an asserting helper without calling
// it, and "assert inside the test" is not a move its author can make.
const assertRow = (n: number): void => {
  expect(n).toBe(n);
};

export { assertRow };
