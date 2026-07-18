/**
 * Unit tests for `normalizeDriftPath` (issue #552).
 *
 * Contract under test: a Zod issue path is collapsed into a dedupe-key
 * segment where numeric (array-index) segments become `*` and string
 * segments pass through unchanged, so a single field-type drift across an
 * array warns ONCE instead of once per element.
 */

import { describe, test, expect } from 'bun:test';
import { normalizeDriftPath } from '../../../src/core/graphql/drift-path.js';

describe('normalizeDriftPath', () => {
  test('maps numeric segments to *', () => {
    expect(normalizeDriftPath([0])).toBe('*');
    expect(normalizeDriftPath([12])).toBe('*');
  });

  test('leaves string segments unchanged', () => {
    expect(normalizeDriftPath(['accounts'])).toBe('accounts');
    expect(normalizeDriftPath(['createTransaction', 'categoryId'])).toBe(
      'createTransaction.categoryId'
    );
  });

  test('handles a mixed path (object field inside an array element)', () => {
    expect(normalizeDriftPath(['accounts', 0, 'balance'])).toBe('accounts.*.balance');
    expect(normalizeDriftPath(['accounts', 1, 'balance'])).toBe('accounts.*.balance');
    expect(normalizeDriftPath(['accounts', 42, 'balance'])).toBe('accounts.*.balance');
  });

  test('handles an empty path', () => {
    expect(normalizeDriftPath([])).toBe('');
  });

  test('handles nested arrays', () => {
    expect(normalizeDriftPath(['a', 0, 'b', 1, 'c'])).toBe('a.*.b.*.c');
  });
});
