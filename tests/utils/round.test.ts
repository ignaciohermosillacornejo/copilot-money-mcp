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
import { parseAmount } from '../../src/utils/round.js';

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
