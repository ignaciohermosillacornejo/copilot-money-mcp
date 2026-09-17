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
  nonEmptyRowsUnder,
  isAccountDocumentPattern,
  readAccountVisibilityRow,
  countDashboardActive,
  classifyDashboardActive,
} from '../../scripts/smoke/cache.js';
import type { AccountVisibilityRow } from '../../scripts/smoke/cache.js';
import type { FirestoreValue } from '../../src/core/protobuf-parser.js';
import { isVisibleAccount } from '../../src/models/account.js';
import type { Account } from '../../src/models/account.js';

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

describe('nonEmptyRowsUnder', () => {
  const raw = new Map([
    ['items/*/accounts', { total: 30, empty: 9 }],
    ['items/*/accounts/*/transactions', { total: 1000, empty: 0 }],
    ['users/*/accounts', { total: 438, empty: 438 }],
    ['accounts_archive', { total: 5, empty: 0 }],
  ]);

  test('sums a root and its subcollections, excluding parent pointers', () => {
    expect(nonEmptyRowsUnder('items/*/accounts', raw)).toBe(21 + 1000);
  });

  test('reads an all-parent-pointer collection as zero rows', () => {
    // The extinct-candidate report turns on this number, so counting the 438
    // structural documents would report a dead collection as alive.
    expect(nonEmptyRowsUnder('users/*/accounts', raw)).toBe(0);
  });

  test('returns zero for a collection the cache does not have', () => {
    expect(nonEmptyRowsUnder('never/*/existed', raw)).toBe(0);
  });

  test('matches on a path SEGMENT, not a string prefix', () => {
    // 'accounts_archive' starts with neither 'accounts' nor 'accounts/'; a
    // bare startsWith would fold it into the accounts total.
    expect(nonEmptyRowsUnder('accounts', raw)).toBe(0);
  });
});

describe('isAccountDocumentPattern', () => {
  test.each([['accounts'], ['items/*/accounts']])('accepts %s', (pattern) => {
    expect(isAccountDocumentPattern(pattern)).toBe(true);
  });

  test('rejects the user-customization collection that shares the leaf', () => {
    // Both end in '/accounts' and the two have different field vocabularies —
    // 'hidden' there, 'user_hidden' here. Mixing them would feed check 7 rows
    // whose visibility is unreadable.
    expect(isAccountDocumentPattern('users/*/accounts')).toBe(false);
  });

  test('rejects a NESTED user-customization path, as the decoder does', () => {
    // The decoder routes on `collection.includes('users/')`, so a path with
    // the segment anywhere goes to processUserAccount. A startsWith-based
    // predicate here would admit it and read `user_hidden` off a document
    // that spells the flag `hidden`.
    expect(isAccountDocumentPattern('tenants/*/users/*/accounts')).toBe(false);
  });

  test('rejects an unrelated collection', () => {
    expect(isAccountDocumentPattern('transactions')).toBe(false);
  });
});

describe('readAccountVisibilityRow', () => {
  const flag = (value: boolean): FirestoreValue => ({ type: 'boolean', value });

  test('reads both flags off a raw document', () => {
    const row = readAccountVisibilityRow(
      new Map([
        ['dashboard_active', flag(false)],
        ['user_hidden', flag(true)],
      ])
    );
    expect(row).toEqual({ dashboardActive: false, invisible: true });
  });

  test('a missing dashboard_active is undefined, not false', () => {
    // The three-way distinction is the whole point: 'absent' and 'false' mean
    // different things to classifyDashboardActive.
    expect(readAccountVisibilityRow(new Map()).dashboardActive).toBeUndefined();
  });

  test('user_deleted alone makes a row invisible', () => {
    expect(readAccountVisibilityRow(new Map([['user_deleted', flag(true)]])).invisible).toBe(true);
  });

  test('an account with neither flag set is visible', () => {
    expect(
      readAccountVisibilityRow(
        new Map([
          ['user_hidden', flag(false)],
          ['user_deleted', flag(false)],
        ])
      ).invisible
    ).toBe(false);
  });

  test('ignores a non-boolean value in a boolean field', () => {
    const row = readAccountVisibilityRow(
      new Map<string, FirestoreValue>([
        ['dashboard_active', { type: 'null', value: null }],
        ['user_hidden', { type: 'string', value: 'true' }],
      ])
    );
    expect(row).toEqual({ dashboardActive: undefined, invisible: false });
  });
});

describe('countDashboardActive', () => {
  test('counts the four numbers the check reports, and only those', () => {
    // The detail line is built from these, so a wrong count here is a smoke
    // run that describes a cache it did not see.
    expect(
      countDashboardActive([
        { dashboardActive: true, invisible: false },
        { dashboardActive: false, invisible: false },
        { dashboardActive: false, invisible: true },
        { dashboardActive: undefined, invisible: false },
      ])
    ).toEqual({ accounts: 4, carrying: 3, negatives: 2, visibleNegatives: 1 });
  });

  test('is all zeroes for no accounts', () => {
    expect(countDashboardActive([])).toEqual({
      accounts: 0,
      carrying: 0,
      negatives: 0,
      visibleNegatives: 0,
    });
  });
});

describe('classifyDashboardActive', () => {
  const row = (dashboardActive: boolean | undefined, invisible = false): AccountVisibilityRow => ({
    dashboardActive,
    invisible,
  });

  test('the shape measured on a real cache reads as independent', () => {
    // A false flag on an account the user has neither hidden nor deleted is
    // the whole evidence that this is not a visibility flag (#666).
    expect(classifyDashboardActive([row(true), row(false), row(false, true)])).toBe('independent');
  });

  test('all-false-and-all-invisible reads as indistinguishable', () => {
    // The #666 reading. Not a failure — this cache simply cannot tell the two
    // apart, so the note on Account.dashboard_active needs a fresh probe.
    expect(classifyDashboardActive([row(true), row(false, true), row(false, true)])).toBe(
      'indistinguishable'
    );
  });

  test('no false values reads as no-negatives, not as independence', () => {
    // The vacuous pass (#596): with nothing false, "every false account is
    // visible" and "every false account is hidden" are both true and neither
    // means anything.
    expect(classifyDashboardActive([row(true), row(true)])).toBe('no-negatives');
  });

  test('a field no document carries reads as absent', () => {
    expect(classifyDashboardActive([row(undefined), row(undefined)])).toBe('absent');
  });

  test('no account documents at all is NOT absent — the check measured nothing', () => {
    // 'absent' means the field is gone from documents we did see; this means
    // we saw no documents. Opposite conclusions, so they get separate names
    // and separate statuses (SKIP vs WARN).
    expect(classifyDashboardActive([])).toBe('no-account-documents');
  });

  test('absent still means account documents exist and none carries the field', () => {
    expect(classifyDashboardActive([row(undefined), row(undefined)])).toBe('absent');
  });

  test('rows without the field never make a verdict', () => {
    // Accounts that do not carry the flag say nothing about it; counting them
    // as visible negatives would manufacture 'independent' out of silence.
    expect(classifyDashboardActive([row(undefined), row(false, true)])).toBe('indistinguishable');
  });
});

describe('readAccountVisibilityRow agrees with isVisibleAccount (for now)', () => {
  const flag = (value: boolean): FirestoreValue => ({ type: 'boolean', value });

  // WHY THIS TEST EXISTS. `readAccountVisibilityRow` re-implements the
  // visibility rule off raw fields instead of importing `isVisibleAccount`,
  // and that is deliberate: check 7 asks whether a THIRD flag belongs in that
  // rule, so it must not inherit the rule's current answer. The cost is a
  // silent coupling — grow `isVisibleAccount` a term and `invisible` quietly
  // starts meaning something else, which changes what 'independent' asserts.
  //
  // So the divergence is pinned rather than prevented: the two must agree over
  // every combination of the flags they both know about, AND over
  // `dashboard_active`, which only one of them knows about. If
  // `isVisibleAccount` ever starts consulting `dashboard_active`, the rows
  // where it is `false` stop agreeing and this fails — which is the moment to
  // re-read the comment on the field and re-run the probe.
  const combos = [false, true].flatMap((hidden) =>
    [false, true].flatMap((deleted) =>
      [false, true].map((dashboardActive) => ({ hidden, deleted, dashboardActive }))
    )
  );

  test.each(combos)(
    'hidden=$hidden deleted=$deleted dashboard_active=$dashboardActive',
    ({ hidden, deleted, dashboardActive }) => {
      const row = readAccountVisibilityRow(
        new Map([
          ['user_hidden', flag(hidden)],
          ['user_deleted', flag(deleted)],
          ['dashboard_active', flag(dashboardActive)],
        ])
      );
      const account: Account = {
        account_id: 'acc_7Kd2mQxZ1vBnR4pLcS9t',
        current_balance: 100,
        user_hidden: hidden,
        user_deleted: deleted,
        dashboard_active: dashboardActive,
      };

      expect(row.invisible).toBe(!isVisibleAccount(account));
    }
  );
});
