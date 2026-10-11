/**
 * Unit tests for the pure predicates behind `bun run smoke:cache`.
 *
 * The smoke itself needs a real Copilot cache, so it cannot run in CI. These
 * cover the logic that decides PASS/FAIL, which is where a silently-wrong
 * threshold would make the whole gate decorative.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeCollection,
  isTotalDecodeLoss,
  isUnmeasuredRoot,
  reportDecodeLossCoverage,
  joinStats,
  findExtinctDependencies,
  reportExtinctDependencies,
  nonFiniteLeafPaths,
  isAccountDocumentCollection,
  tallyRoutedDocument,
  routedNonEmpty,
  compareRoots,
  decodedRoots,
  reportTotalDecodeLoss,
  reportConservation,
  reportUnreadCollection,
  ROUTE_ROWS,
  ROUTES_NOT_COMPARED,
  readAccountVisibilityRow,
  countDashboardActive,
  classifyDashboardActive,
} from '../../scripts/smoke/cache.js';
import type { CollectionRoute } from '../../src/core/decoder.js';
import type {
  AccountVisibilityRow,
  RootComparison,
  RoutedCounts,
} from '../../scripts/smoke/cache.js';
import type { FirestoreValue } from '../../src/core/protobuf-parser.js';
import { iterateDocuments } from '../../src/core/leveldb-reader.js';
import { decodeAllCollections, COLLECTION_ROUTES } from '../../src/core/decoder.js';
import { createDeepTestDb, createEmptyDb } from '../helpers/test-db.js';
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

describe('isUnmeasuredRoot', () => {
  test('fires on the shape that made check 1 pass vacuously (#763)', () => {
    // The shape, with an illustrative row count: account documents live at
    // `items/<id>/accounts`, so the root-anchored raw count for `accounts` is
    // 0 and check 1 compared the decoded rows against nothing, then called it
    // a pass.
    expect(isUnmeasuredRoot(0, 21)).toBe(true);
  });

  test('fires wherever the decoder found rows the raw side could not', () => {
    // Not a property of one root: six of the nine had this shape. A single
    // decoded row with no raw counterpart is already unmeasured.
    expect(isUnmeasuredRoot(0, 1)).toBe(true);
  });

  test('a healthy root with documents on both sides does not warn', () => {
    // The direction that must stay quiet, or the WARN is noise on every run
    // and gets muted.
    expect(isUnmeasuredRoot(16, 16)).toBe(false);
  });

  test('a root that lost every row is NOT unmeasured — it is check 1 failing', () => {
    // The #622 signature is a real measurement with a bad result. Calling it
    // "unmeasured" would downgrade a FAIL to a WARN.
    expect(isUnmeasuredRoot(863, 0)).toBe(false);
  });

  test('a genuinely empty collection is not unmeasured either', () => {
    // Nothing on disk and nothing decoded is consistent, not vacuous — check 3
    // owns the question of whether code depends on it.
    expect(isUnmeasuredRoot(0, 0)).toBe(false);
  });

  test('partial loss is a measurement, so it does not warn', () => {
    expect(isUnmeasuredRoot(863, 78)).toBe(false);
  });

  test('never overlaps isTotalDecodeLoss, so a warn can never hide a fail', () => {
    // The two predicates run over the same list in the same order. If both
    // could hold for one root, the WARN would be describing a FAIL.
    for (const raw of [0, 1, 10, 863]) {
      for (const rows of [0, 1, 21, 945]) {
        expect(isUnmeasuredRoot(raw, rows) && isTotalDecodeLoss(raw, rows)).toBe(false);
      }
    }
  });

  test('reads its arguments in the same order as isTotalDecodeLoss', () => {
    // Both take (rawNonEmpty, decodedRows) and are called on the same tuple.
    // A swapped argument at either call site turns the warn into a fail and
    // back; this pins the orientation from the outside.
    expect(isUnmeasuredRoot(0, 945)).toBe(true);
    expect(isUnmeasuredRoot(945, 0)).toBe(false);
  });
});

describe('reportDecodeLossCoverage', () => {
  // Shaped like the real comparison list, with synthetic counts.
  const healthy: RootComparison[] = [
    { root: 'securities', raw: 16, rows: 16 },
    { root: 'investment_prices', raw: 498, rows: 498 },
  ];

  test('FAILs when a root decoded rows with no non-empty document behind them', () => {
    // Before #778 this was a permanent WARN: the raw side was root-anchored, so
    // six roots read 0 on every real cache and the line was yellow forever.
    // The raw side now routes through the decoder's own `routeCollection`, so
    // anchoring can no longer produce this shape. What can: rows built from
    // fieldless documents (#627's phantom items), or a root mapped to the wrong
    // route. Both are defects in this repo, not facts about the cache.
    const { status } = reportDecodeLossCoverage([
      ...healthy,
      { root: 'accounts', raw: 0, rows: 21 },
    ]);
    expect(status).toBe('FAIL');
  });

  test('the FAIL names the roots and both causes', () => {
    const { detail } = reportDecodeLossCoverage([
      ...healthy,
      { root: 'accounts', raw: 0, rows: 21 },
      { root: 'tags', raw: 0, rows: 11 },
    ]);
    expect(detail).toContain('accounts (0 raw → 21 rows)');
    expect(detail).toContain('tags (0 raw → 11 rows)');
    expect(detail).toContain('2/4');
    // A red line that does not say where to look is a line people re-run
    // until it goes away.
    expect(detail).toContain('fieldless');
    expect(detail).toContain('route');
  });

  test('the FAIL does not name a root it did measure', () => {
    // Listing a healthy root would make the reason false for it, and the
    // reader cannot tell which half of the list to believe.
    const { detail } = reportDecodeLossCoverage([
      ...healthy,
      { root: 'accounts', raw: 0, rows: 21 },
    ]);
    expect(detail).not.toContain('securities');
  });

  test('PASSes when every root had raw documents to compare against', () => {
    // The state every real cache is expected to be in after #778. If this
    // were not reachable the check would be furniture in the other colour.
    const { status, detail } = reportDecodeLossCoverage(healthy);
    expect(status).toBe('PASS');
    expect(detail).toContain('all 2 roots');
  });

  test('a total decode loss is left to check 1 rather than reported here', () => {
    // raw > 0 and zero rows is the #622 FAIL. Reporting it twice would make one
    // finding read as two.
    expect(
      reportDecodeLossCoverage([{ root: 'investment_prices', raw: 863, rows: 0 }]).status
    ).toBe('PASS');
  });

  test('an empty comparison list SKIPs rather than passing over nothing', () => {
    // A PASS over an empty list is the true-of-nothing line #763 removed.
    // Unreachable today; wrong if it ever were reached — which is also why the
    // summary it carries is pinned rather than assumed.
    const { status, comparedSummary } = reportDecodeLossCoverage([]);
    expect(status).toBe('SKIP');
    expect(comparedSummary).toBe('0/0 roots had raw documents at all');
  });

  test('counts a root as measured only when raw documents backed it', () => {
    // The figure checks 1 and 2 quote. "Not unmeasured" is the wrong definition: a
    // root with nothing on disk AND nothing decoded is consistent rather than
    // vacuous, but the raw side still saw nothing there, so it must not
    // inflate the numerator. `total - unmeasured` would say 3/4 here.
    const { comparedSummary } = reportDecodeLossCoverage([
      ...healthy,
      { root: 'accounts', raw: 0, rows: 21 }, // unmeasured: rows with no raw
      { root: 'financial_goals', raw: 0, rows: 0 }, // empty on both sides
    ]);
    expect(comparedSummary).toBe('2/4 roots had raw documents at all');
  });

  test('reports zero measured when nothing on the list had raw documents', () => {
    expect(reportDecodeLossCoverage([{ root: 'tags', raw: 0, rows: 11 }]).comparedSummary).toBe(
      '0/1 roots had raw documents at all'
    );
  });
});

describe('reportTotalDecodeLoss', () => {
  // Check 1's verdict, extracted from `main()` (#778) for the reason #777 gave
  // for check 1b: a status branch only a real cache executes is asserted nowhere.
  const summary = '2/2 roots had raw documents at all';

  test('FAILs and names every root with documents and zero rows (the #622 shape)', () => {
    const { status, detail } = reportTotalDecodeLoss(
      [
        { root: 'investment_prices', raw: 863, rows: 0 },
        { root: 'securities', raw: 16, rows: 16 },
        { root: 'tags', raw: 4, rows: 0 },
      ],
      summary
    );
    expect(status).toBe('FAIL');
    expect(detail).toContain('investment_prices (863 docs)');
    expect(detail).toContain('tags (4 docs)');
    expect(detail).not.toContain('securities');
  });

  test('PASSes when every root with documents decoded something, quoting coverage', () => {
    // The PASS must carry the coverage figure: a decode-loss pass is only as
    // good as the number of roots the raw side could see.
    const { status, detail } = reportTotalDecodeLoss(
      [
        { root: 'securities', raw: 16, rows: 16 },
        { root: 'investment_prices', raw: 863, rows: 78 },
      ],
      summary
    );
    expect(status).toBe('PASS');
    expect(detail).toContain(summary);
  });

  test('a root empty on both sides is not a loss', () => {
    expect(reportTotalDecodeLoss([{ root: 'tags', raw: 0, rows: 0 }], summary).status).toBe('PASS');
  });
});

describe('reportConservation', () => {
  const summary = '9/9 roots had raw documents at all';

  test('WARNs on a root that kept under half its documents', () => {
    const { status, detail } = reportConservation(
      [
        { root: 'investment_prices', raw: 863, rows: 78 },
        { root: 'securities', raw: 16, rows: 16 },
      ],
      summary
    );
    expect(status).toBe('WARN');
    expect(detail).toContain('investment_prices 863→78');
    expect(detail).not.toContain('securities');
  });

  test('exactly half is not a loss of MORE than half', () => {
    expect(reportConservation([{ root: 'tags', raw: 20, rows: 10 }], summary).status).toBe('PASS');
    expect(reportConservation([{ root: 'tags', raw: 20, rows: 9 }], summary).status).toBe('WARN');
  });

  test('a root at or below the 10-document floor never warns', () => {
    // `raw > 10`, not `>= 10`: ten documents decoding to one row is below the
    // floor. The PASS text says "10 or fewer", and this pins the two together.
    expect(reportConservation([{ root: 'tags', raw: 10, rows: 1 }], summary).status).toBe('PASS');
    expect(reportConservation([{ root: 'tags', raw: 11, rows: 1 }], summary).status).toBe('WARN');
  });

  test('a total loss is left to the total-decode-loss check', () => {
    // `rows > 0`: one root, one finding.
    expect(reportConservation([{ root: 'tags', raw: 863, rows: 0 }], summary).status).toBe('PASS');
  });

  test('the PASS names all three narrowings of the filter, and the coverage', () => {
    // The invariant that drifted through four review rounds on #777: the
    // sentence must describe the predicate. Each narrowing is pinned by a test
    // above, so a change to one fails both there and here.
    const { status, detail } = reportConservation(
      [{ root: 'securities', raw: 16, rows: 16 }],
      summary
    );
    expect(status).toBe('PASS');
    expect(detail).toContain('more than half'); // the ratio
    expect(detail).toContain('10 or fewer documents'); // raw > 10
    expect(detail).toContain('total losses'); // rows > 0
    expect(detail).toContain(summary);
  });
});

describe('routed raw counts (#778)', () => {
  const ITEM = 'itm_5pQw8ZnRvL3MxK7cHt2J';
  const ACCT = 'acc_9wKe4RnTpB2XvL7mQd3F';
  const USER = 'usr_3hTq7WmZ2xKv9LpR4cNb';

  test('a nested document counts toward the route the decoder sends it to', () => {
    // The six roots the root-prefix count could not see were all nested.
    const routed: RoutedCounts = new Map();
    tallyRoutedDocument(routed, `items/${ITEM}/accounts/${ACCT}/transactions`, false);
    tallyRoutedDocument(routed, `users/${USER}/tags`, false);
    expect(routedNonEmpty('transactions', routed)).toBe(1);
    expect(routedNonEmpty('tags', routed)).toBe(1);
  });

  test('items no longer sums the subcollections beneath it', () => {
    // The other half of the same bug: by root prefix, `items` counted every
    // account, transaction and balance document under every item.
    const routed: RoutedCounts = new Map();
    tallyRoutedDocument(routed, 'items', false);
    tallyRoutedDocument(routed, `items/${ITEM}/accounts`, false);
    tallyRoutedDocument(routed, `items/${ITEM}/accounts/${ACCT}/transactions`, false);
    tallyRoutedDocument(routed, `items/${ITEM}/accounts/${ACCT}/balance_history`, false);
    expect(routedNonEmpty('items', routed)).toBe(1);
  });

  test('the user-customization accounts collection is not counted as accounts', () => {
    // Why this is not a blanket switch to leaf matching: both end in
    // `/accounts`, and only one of them is what processAccount reads.
    const routed: RoutedCounts = new Map();
    tallyRoutedDocument(routed, `users/${USER}/accounts`, false);
    tallyRoutedDocument(routed, `items/${ITEM}/accounts`, false);
    expect(routedNonEmpty('accounts', routed)).toBe(1);
    expect(routedNonEmpty('user_accounts', routed)).toBe(1);
  });

  test('fieldless parent pointers are tallied but not counted as rows', () => {
    const routed: RoutedCounts = new Map();
    tallyRoutedDocument(routed, 'items', true);
    tallyRoutedDocument(routed, 'items', true);
    tallyRoutedDocument(routed, 'items', false);
    expect(routed.get('items')).toEqual({ total: 3, empty: 2 });
    expect(routedNonEmpty('items', routed)).toBe(1);
  });

  test('an unrouted collection is ignored, and an absent route reads as zero', () => {
    const routed: RoutedCounts = new Map();
    tallyRoutedDocument(routed, 'never_existed', false);
    expect(routed.size).toBe(0);
    expect(routedNonEmpty('tags', routed)).toBe(0);
  });

  test('compareRoots pairs each decoded root with its routed raw count', () => {
    const routed: RoutedCounts = new Map([
      ['tags', { total: 5, empty: 1 }],
      ['items', { total: 40, empty: 27 }],
    ]);
    expect(
      compareRoots(
        [
          { root: 'tags', rows: 4 },
          { root: 'items', rows: 13 },
          { root: 'budgets', rows: 0 },
        ],
        routed
      )
    ).toEqual([
      { root: 'tags', raw: 4, rows: 4 },
      { root: 'items', raw: 13, rows: 13 },
      { root: 'budgets', raw: 0, rows: 0 },
    ]);
  });
});

describe('checks 1 and 2 measure every root on the real nested layout (#778)', () => {
  // The class-level detector. Every unit test above feeds hand-built counts,
  // which is exactly how the root-prefix bug survived: the fixtures were
  // top-level collections, so root and leaf anchoring agreed on them. This one
  // writes each of the nine roots at the NESTED path a real cache uses, runs
  // the real decoder over it, and requires the smoke's raw side to see every
  // root the decoder produced rows for.
  const FIXTURES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-cache-routing-'));
  afterAll(() => fs.rmSync(FIXTURES_DIR, { recursive: true, force: true }));

  const ITEM = 'itm_5pQw8ZnRvL3MxK7cHt2J';
  const ACCT = 'acc_9wKe4RnTpB2XvL7mQd3F';
  const USER = 'usr_3hTq7WmZ2xKv9LpR4cNb';
  const SEC = 'sec_8nVc2KpX5tLm3QwR7zHd';

  test('no root is unmeasured and none sums a neighbour', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'nested');
    await createDeepTestDb(dbPath, [
      { collection: 'items', id: ITEM, fields: { institution_name: 'Synthetic Bank' } },
      {
        collection: `items/${ITEM}/accounts`,
        id: ACCT,
        fields: { name: 'Synthetic Checking', current_balance: 100, item_id: ITEM },
      },
      {
        collection: `items/${ITEM}/accounts/${ACCT}/transactions`,
        id: 'txn_2vLq9XmT4kRz7PwN3cHb',
        fields: { amount: 100, date: '2026-01-15', name: 'Synthetic Merchant', account_id: ACCT },
      },
      {
        collection: `items/${ITEM}/accounts/${ACCT}/balance_history`,
        id: '2026-01-15',
        fields: { current_balance: 100 },
      },
      // A user-customization account: same leaf, must not join `accounts`.
      {
        collection: `users/${USER}/accounts`,
        id: ACCT,
        fields: { name: 'Custom Name', hidden: false },
      },
      {
        collection: `users/${USER}/categories`,
        id: 'cat_7Kd2mQxZ1vBnR4pLcS9t',
        fields: { name: 'Synthetic Category' },
      },
      {
        collection: `users/${USER}/budgets`,
        id: 'bud_4kWzR8nVq2XmT7pLc3Hd',
        fields: { amount: 200, category_id: 'cat_7Kd2mQxZ1vBnR4pLcS9t' },
      },
      {
        collection: `users/${USER}/financial_goals`,
        id: 'gol_6rLpX3mQw9KzT2vN8cHb',
        fields: { name: 'Synthetic Goal' },
      },
      {
        collection: `users/${USER}/tags`,
        id: 'tag_3hTq7WmZ2xKv9LpR4cNb',
        fields: { name: 'Synthetic Tag' },
      },
      { collection: 'securities', id: SEC, fields: { ticker_symbol: 'SYN' } },
      {
        collection: `investment_prices/${SEC}/daily`,
        id: '2026-01',
        fields: { prices: { '1768435200000': 100 } },
      },
    ]);

    const routed: RoutedCounts = new Map();
    for await (const doc of iterateDocuments(dbPath)) {
      tallyRoutedDocument(routed, doc.collection, doc.fields.size === 0);
    }
    const roots = compareRoots(decodedRoots(await decodeAllCollections(dbPath)), routed);

    // Vacuity guard: the fixture must actually produce a row for every route it
    // seeds, or "no root is unmeasured" is true of a list of zeroes. The other
    // compared routes read 0 on both sides here, which the next line accepts.
    const seeded: readonly CollectionRoute[] = [
      'transactions',
      'accounts',
      'items',
      'categories',
      'budgets',
      'financial_goals',
      'investment_prices',
      'securities',
      'tags',
      'balance_history',
    ];
    // Read from `seeded`, not from `roots`, so a seeded route that dropped out
    // of the comparison fails here instead of being filtered past.
    expect(seeded.filter((s) => !roots.find((r) => r.root === s)?.rows)).toEqual([]);
    expect(roots.filter((r) => isUnmeasuredRoot(r.raw, r.rows)).map((r) => r.root)).toEqual([]);
    expect(reportDecodeLossCoverage(roots).status).toBe('PASS');
    // And `items` is the one item document, not the four beneath it.
    expect(roots.find((r) => r.root === 'items')).toEqual({ root: 'items', raw: 1, rows: 1 });
    // Route-anchored, not leaf-anchored: the users/<uid>/accounts document shares
    // this leaf and must be counted under user_accounts (unread since #666, so
    // not compared — check 8 counts it), not here.
    expect(roots.find((r) => r.root === 'accounts')).toEqual({ root: 'accounts', raw: 1, rows: 1 });
    expect(routedNonEmpty('user_accounts', routed)).toBe(1);
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

// Shared by the two extinct-dependency suites below. A collection consisting
// ENTIRELY of Firestore parent pointers (`users/*/accounts`) is what an extinct
// collection with surviving subcollections looks like, and it must read as
// extinct; `items` has some pointers and some data, which must not.
const EXTINCT_FIXTURE = new Map([
  ['transactions', { total: 100, empty: 0 }],
  ['users/*/accounts', { total: 438, empty: 438 }],
  ['items', { total: 20, empty: 8 }],
]);

describe('findExtinctDependencies', () => {
  // DEPENDED_ON is empty right now (#624 removed its only entry), so the check
  // cannot exercise itself against a real cache. These keep it honest anyway —
  // otherwise a gate nobody can currently trip is indistinguishable from a
  // gate that is broken.
  const raw = EXTINCT_FIXTURE;

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

describe('reportExtinctDependencies', () => {
  const raw = EXTINCT_FIXTURE;

  test('SKIPs rather than passing when nothing is registered as depended-on (#763)', () => {
    // The live state of the check: DEPENDED_ON has been empty since #624.
    // "Every depended-on collection has documents" is true of nothing, and
    // reads exactly like the same line over a populated list.
    const { status, detail } = reportExtinctDependencies([], raw);
    expect(status).toBe('SKIP');
    expect(detail).toContain('compared nothing');
  });

  test('FAILs when a depended-on collection has no real documents', () => {
    const { status, detail } = reportExtinctDependencies(['users/*/accounts'], raw);
    expect(status).toBe('FAIL');
    expect(detail).toContain('users/*/accounts');
  });

  test('PASSes when every depended-on collection has documents', () => {
    // The pass must stay reachable, or the SKIP branch has just disabled the
    // check instead of qualifying it.
    expect(reportExtinctDependencies(['transactions'], raw).status).toBe('PASS');
  });
});

describe('reportUnreadCollection', () => {
  test('PASSes with zero documents — consistent with the decoder deletion (#666)', () => {
    const { status, detail } = reportUnreadCollection('users/*/accounts', 0);
    expect(status).toBe('PASS');
    expect(detail).toContain('zero documents');
  });

  test('WARNs when the unread collection has documents again, naming it', () => {
    const { status, detail } = reportUnreadCollection('users/*/accounts', 3);
    expect(status).toBe('WARN');
    expect(detail).toContain('3 document(s)');
    expect(detail).toContain('users/*/accounts');
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

describe('isAccountDocumentCollection', () => {
  // Delegates to the decoder's `routeCollection` (#778) instead of keeping a
  // second spelling of the rule, so check 7's row set is by construction the
  // one processAccount sees.
  test.each([['accounts'], ['items/itm_5pQw8ZnRvL3MxK7cHt2J/accounts']])('accepts %s', (c) => {
    expect(isAccountDocumentCollection(c)).toBe(true);
  });

  test('rejects the user-customization collection that shares the leaf', () => {
    // Both end in '/accounts' and the two have different field vocabularies —
    // 'hidden' there, 'user_hidden' here. Mixing them would feed check 7 rows
    // whose visibility is unreadable.
    expect(isAccountDocumentCollection('users/usr_3hTq7WmZ2xKv9LpR4cNb/accounts')).toBe(false);
  });

  test('rejects a NESTED user-customization path, as the decoder does', () => {
    // The decoder routes on `collection.includes('users/')`, so a path with
    // the segment anywhere routes to user_accounts and is skipped unread.
    expect(isAccountDocumentCollection('tenants/t_1/users/usr_3hTq7WmZ2xKv9LpR4cNb/accounts')).toBe(
      false
    );
  });

  test('rejects the Plaid account documents and subcollections beneath an account', () => {
    const acct = 'items/itm_5pQw8ZnRvL3MxK7cHt2J/accounts/acc_9wKe4RnTpB2XvL7mQd3F';
    expect(isAccountDocumentCollection(acct)).toBe(false);
    expect(isAccountDocumentCollection(`${acct}/balance_history`)).toBe(false);
  });

  test('rejects an unrelated collection', () => {
    expect(isAccountDocumentCollection('transactions')).toBe(false);
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

  test('absent still means account documents exist and none carries the field', () => {
    // One visible document and one hidden one, neither carrying the flag.
    // Visibility is the only other thing a row knows, so this also pins that
    // 'absent' is decided on the field alone — which an all-visible row set
    // cannot show.
    expect(classifyDashboardActive([row(undefined), row(undefined, true)])).toBe('absent');
  });

  test('no account documents at all is NOT absent — the check measured nothing', () => {
    // 'absent' means the field is gone from documents we did see; this means
    // we saw no documents. Opposite conclusions, so they get separate names
    // and separate statuses (SKIP vs WARN).
    expect(classifyDashboardActive([])).toBe('no-account-documents');
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

describe('every decoder route is compared or excluded with a reason (#778)', () => {
  // The two Record types already make a missing or doubled route a compile
  // error; this is the runtime half, so a cast cannot get one past.
  test('ROUTE_ROWS and ROUTES_NOT_COMPARED partition COLLECTION_ROUTES', () => {
    const compared = Object.keys(ROUTE_ROWS);
    const excluded = Object.keys(ROUTES_NOT_COMPARED);
    expect(compared.filter((r) => excluded.includes(r))).toEqual([]);
    expect([...compared, ...excluded].sort()).toEqual([...COLLECTION_ROUTES].sort());
  });

  test('every exclusion states why', () => {
    for (const reason of Object.values(ROUTES_NOT_COMPARED)) {
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  test('decodedRoots yields every compared route, in routing order, each with its rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-cache-roots-'));
    try {
      const dbPath = path.join(dir, 'empty');
      await createEmptyDb(dbPath);
      // Written out, not derived from COLLECTION_ROUTES and ROUTE_ROWS, so the
      // test does not restate the expression decodedRoots is built from.
      expect(decodedRoots(await decodeAllCollections(dbPath))).toEqual(
        [
          'holdings_history',
          'balance_history',
          'transactions',
          'accounts',
          'recurring',
          'budgets',
          'financial_goals',
          'financial_goal_history',
          'investment_prices',
          'investment_splits',
          'items',
          'tags',
          'categories',
          'transaction_changes',
          'account_changes',
          'changes',
          'securities',
          'users',
          'amazon_orders',
          'amazon',
          'subscriptions',
          'invites',
          'user_items',
          'feature_tracking',
          'support',
        ].map((root) => ({ root, rows: 0 }))
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
