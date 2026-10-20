/**
 * Unit tests for parseAmount (src/utils/round.ts).
 *
 * parseAmount must accept BOTH the numeric wire type Copilot now returns for
 * monthlySpending/networthHistory amounts (#537 server type drift) AND the
 * Apollo-canonical string form other snapshot-mode amounts arrive in — the
 * tolerance is deliberate defensive design (the read-shape Zod gate stays
 * strict; parseAmount degrades gracefully). This locks in both paths, which
 * the tool-layer tests no longer exercise now that their fixtures are numeric.
 */

import { describe, test, expect } from 'bun:test';
import { parseAmount, computeTotalReturnPercent } from '../../src/utils/round.js';

describe('parseAmount', () => {
  test('parses a numeric-string amount (Apollo-canonical form)', () => {
    expect(parseAmount('100')).toBe(100);
    expect(parseAmount('12.5')).toBe(12.5);
    expect(parseAmount('-7')).toBe(-7);
  });

  test('passes a numeric amount through unchanged (current wire type)', () => {
    expect(parseAmount(100)).toBe(100);
    expect(parseAmount(0)).toBe(0);
    expect(parseAmount(-7.25)).toBe(-7.25);
  });

  test('returns null for null / undefined', () => {
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
  });

  test('returns null for a non-numeric string', () => {
    expect(parseAmount('not-a-number')).toBeNull();
  });

  test('returns null for non-finite numeric input', () => {
    expect(parseAmount(Number.NaN)).toBeNull();
    expect(parseAmount(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseAmount(Number.NEGATIVE_INFINITY)).toBeNull();
  });
});

describe('computeTotalReturnPercent truncates toward zero (#825)', () => {
  test('the #825 observation: -12.446% shows as -12.44%, not -12.45%', () => {
    expect(computeTotalReturnPercent(-12.446, 100)).toBe(-12.44);
  });

  test('a positive value truncates too', () => {
    expect(computeTotalReturnPercent(8.379, 100)).toBe(8.37);
  });

  test('float error does not cost a hundredth', () => {
    // (0.57 / 100) * 10000 is 56.99999999999999 in floating point.
    expect(computeTotalReturnPercent(0.57, 100)).toBe(0.57);
  });

  test('a tiny loss is 0, not -0', () => {
    expect(Object.is(computeTotalReturnPercent(-0.001, 100), 0)).toBe(true);
  });
});
