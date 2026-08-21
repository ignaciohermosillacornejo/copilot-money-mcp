/**
 * Unit tests for `stripNonFiniteNumbers` — the repair step that keeps a single
 * NaN / ±Infinity leaf from costing a whole document (issue #659).
 *
 * The structural dimension is what matters here: the offending leaf can sit at
 * the top level, inside an object nested in an array (`holdings.0.price`), or
 * inside a record keyed by dynamic map keys (`history.<epoch>.price`). Each
 * placement is exercised because each is a different branch of the walk.
 */

import { describe, test, expect } from 'bun:test';
import { stripNonFiniteNumbers } from '../../src/core/non-finite.js';

describe('stripNonFiniteNumbers', () => {
  test('returns the input untouched when every number is finite', () => {
    const input = { a: 1, b: { c: -2.5 }, d: [{ e: 0 }] };
    const result = stripNonFiniteNumbers(input);

    expect(result.paths).toEqual([]);
    // Identity, not just equality: the happy path must not clone.
    expect(result.value).toBe(input);
  });

  test('strips a top-level non-finite field', () => {
    const result = stripNonFiniteNumbers({ id: 'x', price: Infinity });

    expect(result.value).toEqual({ id: 'x' });
    expect(result.paths).toEqual(['price']);
  });

  test.each([
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['NaN', NaN],
  ])('strips %s', (_label, bad) => {
    const result = stripNonFiniteNumbers({ price: bad });

    expect(result.value).toEqual({});
    expect(result.paths).toEqual(['price']);
  });

  test('strips inside an object nested in an array (the accounts.holdings shape)', () => {
    const result = stripNonFiniteNumbers({
      account_id: 'acc_1',
      holdings: [
        { security_id: 'sec_1', institution_price: 10 },
        { security_id: 'sec_2', institution_price: Infinity, quantity: 0 },
      ],
    });

    expect(result.value).toEqual({
      account_id: 'acc_1',
      holdings: [
        { security_id: 'sec_1', institution_price: 10 },
        { security_id: 'sec_2', quantity: 0 },
      ],
    });
    expect(result.paths).toEqual(['holdings.1.institution_price']);
  });

  test('strips inside a dynamically keyed record (the holdings_history shape)', () => {
    const result = stripNonFiniteNumbers({
      history: {
        '1785124800000': { price: 150.5, quantity: 10 },
        '1787025600000': { price: Infinity, quantity: 0 },
      },
    });

    expect(result.value).toEqual({
      history: {
        '1785124800000': { price: 150.5, quantity: 10 },
        '1787025600000': { quantity: 0 },
      },
    });
    expect(result.paths).toEqual(['history.1787025600000.price']);
  });

  test('reports every stripped leaf, not just the first', () => {
    const result = stripNonFiniteNumbers({
      a: NaN,
      b: { c: Infinity },
      d: [{ e: -Infinity }],
    });

    expect(result.value).toEqual({ b: {}, d: [{}] });
    expect(result.paths).toEqual(['a', 'b.c', 'd.0.e']);
  });

  test('drops a non-finite array element rather than leaving a hole', () => {
    const result = stripNonFiniteNumbers({ prices: [1, Infinity, 3] });

    expect(result.value).toEqual({ prices: [1, 3] });
    expect(result.paths).toEqual(['prices.1']);
  });

  test('leaves untouched values that are not plain containers', () => {
    const buf = Buffer.from([1, 2, 3]);
    const input = { raw: buf, when: { seconds: 1, nanos: 2 }, nothing: null, flag: true };
    const result = stripNonFiniteNumbers(input);

    expect(result.paths).toEqual([]);
    expect(result.value).toBe(input);
    expect((result.value as { raw: Buffer }).raw).toBe(buf);
  });

  test('does not mutate the input document', () => {
    const input = { holdings: [{ institution_price: Infinity }] };
    stripNonFiniteNumbers(input);

    expect(input.holdings[0]?.institution_price).toBe(Infinity);
  });

  test('leaves a non-finite root alone — there is nothing to strip it from', () => {
    const result = stripNonFiniteNumbers(Infinity);

    expect(result.value).toBe(Infinity);
    expect(result.paths).toEqual([]);
  });
});
