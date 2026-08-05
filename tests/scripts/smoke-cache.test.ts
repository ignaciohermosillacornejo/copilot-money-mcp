/**
 * Unit tests for the pure predicates behind `bun run smoke:cache`.
 *
 * The smoke itself needs a real Copilot cache, so it cannot run in CI. These
 * cover the logic that decides PASS/FAIL, which is where a silently-wrong
 * threshold would make the whole gate decorative.
 */

import { describe, test, expect } from 'bun:test';
import { normalizeCollection, isTotalDecodeLoss, joinStats } from '../../scripts/smoke/cache.js';

describe('normalizeCollection', () => {
  test('wildcards document ids at odd path depths', () => {
    expect(normalizeCollection('items/abc123/accounts')).toBe('items/*/accounts');
    expect(normalizeCollection('investment_prices/deadbeef/daily')).toBe(
      'investment_prices/*/daily'
    );
  });

  test('leaves a top-level collection untouched', () => {
    expect(normalizeCollection('transactions')).toBe('transactions');
  });

  test('wildcards every id in a deep path', () => {
    expect(normalizeCollection('items/i1/accounts/a1/holdings_history/h1/history')).toBe(
      'items/*/accounts/*/holdings_history/*/history'
    );
  });

  test('never lets a real document id through', () => {
    // This is the PII guarantee, not a formatting nicety: the smoke prints
    // collection patterns, so an id surviving normalization would be a leak.
    const normalized = normalizeCollection(
      'items/SECRET_ITEM_ID/accounts/SECRET_ACCT/transactions'
    );
    expect(normalized).not.toContain('SECRET_ITEM_ID');
    expect(normalized).not.toContain('SECRET_ACCT');
  });
});

describe('isTotalDecodeLoss', () => {
  test('fires when documents exist but nothing decoded (the #622 signature)', () => {
    expect(isTotalDecodeLoss(863, 0)).toBe(true);
  });

  test('does not fire on a genuinely empty collection', () => {
    // That case belongs to the extinct-dependency check; conflating the two
    // would make an absent collection look like a decoder bug.
    expect(isTotalDecodeLoss(0, 0)).toBe(false);
  });

  test('does not fire on partial loss', () => {
    expect(isTotalDecodeLoss(863, 78)).toBe(false);
  });
});

describe('joinStats', () => {
  test('reports every reference orphaned when none resolves (the #622 join failure)', () => {
    // Rows keyed by a period instead of a security id: every value is a
    // perfectly valid string, and none of them joins.
    expect(joinStats(['2025-06', '2025-07'], new Set(['sec_a', 'sec_b']))).toEqual({
      total: 2,
      matched: 0,
      orphans: 2,
      rate: 0,
    });
  });

  test('reports no orphans when every reference resolves', () => {
    expect(joinStats(['sec_a', 'sec_b'], new Set(['sec_a', 'sec_b', 'sec_c']))).toEqual({
      total: 2,
      matched: 2,
      orphans: 0,
      rate: 1,
    });
  });

  test('reports exact counts on partial resolution', () => {
    // orphans must come from a subtraction of integers, never from
    // round(rate * total) — the gate reports this number to a human.
    expect(joinStats(['sec_a', 'missing'], new Set(['sec_a']))).toEqual({
      total: 2,
      matched: 1,
      orphans: 1,
      rate: 0.5,
    });
  });

  test('keeps the orphan count exact where a rate roundtrip would not', () => {
    // 1/3 is not representable; deriving orphans from the rate invites
    // rounding to decide how many rows are broken.
    const refs = ['a', 'missing1', 'missing2'];
    expect(joinStats(refs, new Set(['a'])).orphans).toBe(2);
  });

  test('treats an empty reference list as vacuously fine', () => {
    // No rows to check is not a failure — the runner reports SKIP for this.
    expect(joinStats([], new Set()).rate).toBe(1);
  });

  test('the empty-reference short-circuit does not consult the target', () => {
    expect(joinStats([], new Set(['sec_a'])).rate).toBe(1);
  });
});
