import { describe, expect, test } from 'bun:test';
import {
  classifyAccountNameParity,
  compareAccountNames,
  type CacheAccountLabels,
} from '../../scripts/smoke/account-names-checks.js';

// Firestore-shaped opaque ids, not names, so an id/name mix-up cannot pass.
const A = 'Xk3PqR9vTzL2mWn8bYc4';
const B = 'Qa7HsD2fJk9LpZx3VbN1';
const C = 'Mn5TyU8iOp1AsDf4GhJ6';

const names = (entries: Array<[string, string | undefined]>) => new Map(entries);

describe('compareAccountNames', () => {
  test('counts compared, mismatched, and one-sided ids per account id', () => {
    const parity = compareAccountNames(
      names([
        [A, 'One'],
        [B, 'Two'],
      ]),
      names([
        [A, 'One'],
        [B, 'Different'],
        [C, 'Three'],
      ]),
      []
    );
    expect(parity).toEqual({
      compared: 2,
      mismatched: 1,
      cacheOnly: 0,
      liveOnly: 1,
      discriminating: 0,
      fallbackDiscriminating: 0,
    });
  });

  test('a row is discriminating only when its nickname differs from the provider label', () => {
    const labels: CacheAccountLabels[] = [
      { account_id: A, nickname: 'Household', name: 'Provider Checking' }, // discriminating
      { account_id: B, nickname: 'Provider Savings', name: 'Provider Savings' }, // same label
      { account_id: C, nickname: '   ', name: 'Provider Card' }, // blank nickname
    ];
    const both = names([
      [A, 'Household'],
      [B, 'Provider Savings'],
      [C, 'Provider Card'],
    ]);
    expect(compareAccountNames(both, both, labels).discriminating).toBe(1);
  });

  test('the provider label falls back to official_name when name is absent', () => {
    const labels: CacheAccountLabels[] = [
      { account_id: A, nickname: 'Official', official_name: 'Official' },
    ];
    const both = names([[A, 'Official']]);
    expect(compareAccountNames(both, both, labels).discriminating).toBe(0);
  });

  test('fallback-discriminating counts only un-nicknamed rows whose two provider labels differ', () => {
    const labels: CacheAccountLabels[] = [
      { account_id: A, name: 'Short', official_name: 'Long Official' }, // counts
      { account_id: B, name: 'Same', official_name: 'Same' }, // labels agree
      { account_id: C, nickname: 'Nick', name: 'Short', official_name: 'Long' }, // has nickname
    ];
    const both = names([
      [A, 'Short'],
      [B, 'Same'],
      [C, 'Nick'],
    ]);
    const parity = compareAccountNames(both, both, labels);
    expect(parity.fallbackDiscriminating).toBe(1);
    expect(parity.discriminating).toBe(1);
  });

  test('a cache-only id is neither compared nor discriminating', () => {
    const parity = compareAccountNames(names([[A, 'Household']]), names([]), [
      { account_id: A, nickname: 'Household', name: 'Provider' },
    ]);
    expect(parity.cacheOnly).toBe(1);
    expect(parity.compared).toBe(0);
    expect(parity.discriminating).toBe(0);
  });
});

describe('classifyAccountNameParity', () => {
  const base = {
    compared: 5,
    mismatched: 0,
    cacheOnly: 0,
    liveOnly: 0,
    discriminating: 2,
    fallbackDiscriminating: 0,
  };

  test('PASS when every compared name agrees and some row discriminates', () => {
    expect(classifyAccountNameParity(base).status).toBe('PASS');
  });

  test('FAIL on any mismatch, even with discriminating rows', () => {
    expect(classifyAccountNameParity({ ...base, mismatched: 1 }).status).toBe('FAIL');
  });

  test('FAIL when nothing was compared — an empty join is a broken check', () => {
    const verdict = classifyAccountNameParity({
      ...base,
      compared: 0,
      discriminating: 0,
      cacheOnly: 3,
      liveOnly: 3,
    });
    expect(verdict.status).toBe('FAIL');
  });

  test('WARN, not FAIL, when neither mode returned any account', () => {
    const verdict = classifyAccountNameParity({ ...base, compared: 0, discriminating: 0 });
    expect(verdict.status).toBe('WARN');
    expect(verdict.detail).toContain('nothing to compare');
  });

  test('WARN, never PASS, when the row sets are one-sided', () => {
    expect(classifyAccountNameParity({ ...base, cacheOnly: 1 }).status).toBe('WARN');
    expect(classifyAccountNameParity({ ...base, liveOnly: 1 }).status).toBe('WARN');
  });

  test('a mismatch still FAILs when the row sets are one-sided', () => {
    expect(classifyAccountNameParity({ ...base, mismatched: 1, liveOnly: 2 }).status).toBe('FAIL');
  });

  test('WARN, never PASS, when no row could tell nickname from provider label', () => {
    const verdict = classifyAccountNameParity({ ...base, discriminating: 0 });
    expect(verdict.status).toBe('WARN');
    expect(verdict.detail).toContain('CANNOT distinguish');
  });

  test('the detail carries counts only', () => {
    const { detail } = classifyAccountNameParity(base);
    expect(detail).toContain('5 compared');
    expect(detail).toContain('2 discriminating');
  });
});
