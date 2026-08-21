/**
 * Unit tests for the pure predicates behind `bun run smoke:cache`.
 *
 * The smoke itself needs a real Copilot cache, so it cannot run in CI. These
 * cover the logic that decides PASS/FAIL, which is where a silently-wrong
 * threshold would make the whole gate decorative.
 */

import { describe, test, expect } from 'bun:test';
import {
  normalizeCollection,
  isTotalDecodeLoss,
  joinStats,
  findExtinctDependencies,
  nonFiniteLeafPaths,
} from '../../scripts/smoke/cache.js';
import type { FirestoreValue } from '../../src/core/protobuf-parser.js';

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

describe('findExtinctDependencies', () => {
  // DEPENDED_ON is empty right now (#624 removed its only entry), so the check
  // cannot exercise itself against a real cache. These keep it honest anyway —
  // otherwise a gate nobody can currently trip is indistinguishable from a
  // gate that is broken.
  const raw = new Map([
    ['transactions', { total: 100, empty: 0 }],
    // A collection consisting ENTIRELY of Firestore parent pointers: documents
    // exist, but none carries a field. This is what an extinct collection with
    // surviving subcollections looks like, and it must read as extinct.
    ['users/*/accounts', { total: 438, empty: 438 }],
    ['items', { total: 20, empty: 8 }],
  ]);

  test('flags a collection whose documents are all parent pointers', () => {
    expect(findExtinctDependencies(['users/*/accounts'], raw)).toEqual(['users/*/accounts']);
  });

  test('flags a collection absent from the cache entirely', () => {
    expect(findExtinctDependencies(['never/*/existed'], raw)).toEqual(['never/*/existed']);
  });

  test('does not flag a collection with real documents', () => {
    expect(findExtinctDependencies(['transactions'], raw)).toEqual([]);
  });

  test('does not flag a collection that merely has SOME parent pointers', () => {
    // items has 8 empty of 20 — normal, not extinct. Counting raw totals
    // instead of non-empty ones would miss the real case; counting any empty
    // document as fatal would flag every healthy collection.
    expect(findExtinctDependencies(['items'], raw)).toEqual([]);
  });

  test('returns nothing for an empty dependency list', () => {
    expect(findExtinctDependencies([], raw)).toEqual([]);
  });
});

describe('nonFiniteLeafPaths', () => {
  const num = (value: number): FirestoreValue => ({ type: 'double', value });

  test('finds nothing in a document of finite numbers', () => {
    expect(nonFiniteLeafPaths(new Map([['current_balance', num(5000)]]))).toEqual([]);
  });

  test.each([
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['NaN', NaN],
  ])('reports a top-level %s', (_label, bad) => {
    expect(nonFiniteLeafPaths(new Map([['price', num(bad)]]))).toEqual(['price']);
  });

  test('walks into arrays and maps (the reported #659 shapes)', () => {
    const holdings: FirestoreValue = {
      type: 'array',
      value: [
        { type: 'map', value: new Map([['institution_price', num(Infinity)]]) },
        { type: 'map', value: new Map([['institution_price', num(25)]]) },
      ],
    };
    const history: FirestoreValue = {
      type: 'map',
      value: new Map<string, FirestoreValue>([
        ['1787025600000', { type: 'map', value: new Map([['price', num(NaN)]]) }],
      ]),
    };

    expect(nonFiniteLeafPaths(new Map([['holdings', holdings]]))).toEqual([
      'holdings.<n>.institution_price',
    ]);
    // The epoch-ms map key is dynamic, so it is redacted rather than logged.
    expect(nonFiniteLeafPaths(new Map([['history', history]]))).toEqual(['history.<key>.price']);
  });

  test('never lets a dynamic map key through', () => {
    // Same PII guarantee as normalizeCollection: these paths get logged, and
    // map keys in some collections are user data.
    const doc = new Map<string, FirestoreValue>([
      ['by_merchant', { type: 'map', value: new Map([['SECRET_MERCHANT_ID', num(Infinity)]]) }],
    ]);

    const paths = nonFiniteLeafPaths(doc);
    expect(paths).toEqual(['by_merchant.<key>']);
    expect(paths.join()).not.toContain('SECRET_MERCHANT_ID');
  });

  test('reports every offending leaf, not just the first', () => {
    const doc = new Map<string, FirestoreValue>([
      ['a', num(Infinity)],
      ['b', num(1)],
      ['c', num(NaN)],
    ]);

    expect(nonFiniteLeafPaths(doc)).toEqual(['a', 'c']);
  });

  test('ignores non-numeric leaves', () => {
    const doc = new Map<string, FirestoreValue>([
      ['name', { type: 'string', value: 'Synthetic' }],
      ['missing', { type: 'null', value: null }],
      ['flag', { type: 'boolean', value: true }],
    ]);

    expect(nonFiniteLeafPaths(doc)).toEqual([]);
  });
});
