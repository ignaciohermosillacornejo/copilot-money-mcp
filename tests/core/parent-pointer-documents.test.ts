/**
 * Fieldless documents must never become rows (#627).
 *
 * Firestore materializes an empty "parent pointer" document at any path that
 * has subcollections. A real cache holds thousands of them — roughly 150 per
 * real item — and they carry no data at all: they exist only so the path
 * resolves.
 *
 * A processor that builds a row from one manufactures a record that does not
 * exist. `processItem` did exactly that: it fell back to `item_id: docId` and
 * so always returned at least a stub, while a comment at the call site asserted
 * the opposite ("parent-pointer docs have empty fields and processItem returns
 * null"). The code trusted its own documentation.
 *
 * These pin the invariant at the processor, so it holds for every caller rather
 * than only the one call site that was fixed.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  decodeItems,
  decodeAllCollections,
  routeCollection,
  COLLECTION_ROUTES,
} from '../../src/core/decoder.js';
import type { AllCollectionsResult, CollectionRoute } from '../../src/core/decoder.js';
import { ROUTE_ROWS } from '../../scripts/smoke/cache.js';
import { createDeepTestDb } from '../helpers/test-db.js';
import { stripComments } from '../helpers/strip-comments.js';
import { createTestDatabase } from '../../src/core/leveldb-reader.js';

const FIXTURES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-pointer-'));

afterAll(() => {
  fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

const REAL_ITEM = 'itm_5pQw8ZnRvL3MxK7cHt2J';
const POINTER_ONLY = 'itm_9wKe4RnTpB2XvL7mQd3F';

describe('fieldless documents never become rows (#627)', () => {
  test('a fieldless items document is not decoded as an item', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'items-pointer');
    await createTestDatabase(dbPath, [
      { collection: 'items', id: REAL_ITEM, fields: { institution_name: 'Synthetic Bank' } },
      { collection: 'items', id: POINTER_ONLY, fields: {} },
    ]);

    const items = await decodeItems(dbPath);

    expect(items.map((i) => i.item_id)).toEqual([REAL_ITEM]);
  });

  test('the aggregate path agrees — no phantom row from the fieldless document', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'items-pointer-aggregate');
    await createTestDatabase(dbPath, [
      { collection: 'items', id: REAL_ITEM, fields: { institution_name: 'Synthetic Bank' } },
      { collection: 'items', id: POINTER_ONLY, fields: {} },
    ]);

    const all = await decodeAllCollections(dbPath);

    expect(all.items.map((i) => i.item_id)).toEqual([REAL_ITEM]);
  });

  test('a phantom would otherwise carry an id and nothing else', async () => {
    // Documents what the bug actually looked like, so the assertions above
    // cannot be mistaken for a count check. The phantom was not malformed —
    // it was a structurally valid Item whose every field but the id was absent,
    // which is why no schema validation objected.
    const dbPath = path.join(FIXTURES_DIR, 'items-pointer-shape');
    await createTestDatabase(dbPath, [{ collection: 'items', id: POINTER_ONLY, fields: {} }]);

    const items = await decodeItems(dbPath);

    expect(items).toEqual([]);
  });
});

describe('every parent-pointer dispatch clause guards its processor (#627)', () => {
  // The class-level ratchet. Two routing clauses in routeCollection (users and
  // amazon; the items one went with #627) deliberately match Firestore's
  // parent-pointer paths with a `/^name\/[^/]+$/` regex, and the switch in
  // decodeAllCollections sends each to a processor. Each is only safe because
  // the processor it calls returns null for a fieldless document — an
  // invariant that lived nowhere enforceable, which is how `items` shipped
  // without it. Since #797 every processor carries the guard, and the sweep
  // below asserts it behaviourally for every route.
  //
  // This pins the pairing: add a parent-pointer clause, and the processor it
  // dispatches to must carry the guard.
  test('each processor reachable from a parent-pointer clause checks fields.size === 0', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '../../src/core/decoder.ts'), 'utf8');
    // Stripped ONCE and used for EVERY step below (switch bounds, clause regex,
    // processor lookup, guard match), as decoder-field-completeness.test.ts
    // does. Stripping only the final window left the discovery steps reading
    // raw source, so a commented-out `case` or clause could steer the scan to a
    // guarded processor and pass. stripComments (#691) blanks comments in place,
    // so offsets into `text` are still offsets into `src`.
    const text = stripComments(src, 'decoder.ts');

    // The routing decision lives in `routeCollection` and the processor call in
    // the matching `case` of `decodeAllCollections`'s switch (#778), so a clause
    // is followed in two hops: regex → returned route → that case's body.
    //
    // `[-\w]+` not `\w+`: a hyphenated collection name would otherwise not
    // match the clause at all, and an unmatched clause is an unchecked one.
    const clause =
      /\/\^([-\w]+)\\\/\[\^\/\]\+\$\/\.test\(collection\)\)\s*\{?\s*return '([-\w]+)'/g;
    const checked: string[] = [];
    const unguarded: string[] = [];
    const unresolved: string[] = [];

    // Cases are looked up only inside decodeAllCollections's dispatch switch,
    // so a route string appearing earlier in the file cannot be mistaken for it.
    const switchStart = text.indexOf('switch (route) {');
    expect(switchStart).toBeGreaterThan(-1);
    // An unmatched end would make slice(start, -1) quietly re-widen the scope.
    const dispatchEnd = text.indexOf('\n    }\n  }\n', switchStart);
    expect(dispatchEnd).toBeGreaterThan(switchStart);
    const dispatch = text.slice(switchStart, dispatchEnd);

    let m: RegExpExecArray | null;
    while ((m = clause.exec(text)) !== null) {
      const collectionName = m[1] ?? '?';
      const route = m[2] ?? '?';
      const caseIdx = dispatch.search(new RegExp(`case '${route}':\\s*\\{`));
      const body = caseIdx === -1 ? '' : dispatch.slice(caseIdx, caseIdx + 400);
      const call = /\b(process\w+)\(/.exec(body);
      if (!call) {
        // A clause whose processor we could not identify is NOT a pass. The
        // body window is capped, so a long comment or nested logic before the
        // call would land here — and skipping silently is exactly the failure
        // this ratchet exists to prevent, one level up.
        unresolved.push(collectionName);
        continue;
      }
      const processor = call[1]!;
      checked.push(processor);

      // Pull the processor's own body and look for the guard.
      const declIdx = text.indexOf(`function ${processor}(`);
      expect(declIdx).toBeGreaterThan(-1);
      const decl = text.slice(declIdx, declIdx + 900);
      // The literal is the contract with the two guard sites this reaches
      // (processUserProfile, processAmazonIntegration), which say so; the other
      // processors' guards are pinned behaviourally by the sweep below.
      // Hoisting it into a helper means updating this pattern to match, NOT
      // loosening it: a scan that accepts anything is a vacuous scan.
      //
      // `decl` comes from the stripped text and the pattern requires the `if (`:
      // both guard sites carry a comment quoting the literal, so matching raw
      // source would pass on the comment alone with the guard gone.
      if (!/if \(fields\.size === 0\)/.test(decl)) unguarded.push(processor);
    }

    // Vacuity guard: if the clause pattern stops matching (a refactor, a
    // rename), this test would silently pass while checking nothing.
    expect(checked.length).toBeGreaterThanOrEqual(2);
    expect(unresolved).toEqual([]);
    expect(unguarded).toEqual([]);
  });
});

/** Routes with no processor, so nothing to sweep: sentinels, and the unread #666 path. */
const NO_PROCESSOR = ['financial_goal_sentinels', 'user_accounts'] as const;
/** Every route that has a processor. */
type SweptRoute = Exclude<CollectionRoute, (typeof NO_PROCESSOR)[number]>;

describe('no route builds a row from a fieldless document (#627, #778, #797)', () => {
  // The behavioural form of the source scan above, over EVERY route the smoke
  // compares rather than the clauses a regex can find. One fieldless document
  // is written at a real path for each route, and the decoder must produce
  // nothing from it. `smoke:cache` check 1b fails on the real-cache shape of
  // this (rows with no non-empty document behind them); this catches it with
  // no cache at all. A route with no path here is a type error under
  // `bun run check` (this file is in tsconfig.tests.json), and also fails the
  // coverage test below, which is what catches it under a bare `bun test`.
  const I = 'itm_5pQw8ZnRvL3MxK7cHt2J';
  const A = 'acc_9wKe4RnTpB2XvL7mQd3F';
  const U = 'usr_3hTq7WmZ2xKv9LpR4cNb';
  // Invariant pinned here (#797): the smoke excludes a route from checks 1 and
  // 2 ONLY for lacking a processor, so its accessor table covers exactly the
  // swept routes, and the coverage test below fails if a processor-bearing
  // route is ever excluded. If one must be excluded for another reason (as
  // plaid_accounts was before #797), restore an explicit accessor for it here
  // rather than dropping it from the sweep.
  const ROWS: Record<SweptRoute, (all: AllCollectionsResult) => number> = ROUTE_ROWS;
  const PATHS: Record<SweptRoute, { collection: string; id: string }> = {
    holdings_history: {
      collection: `items/${I}/accounts/${A}/holdings_history/hh_4kWz8nVq/history`,
      id: '2026-01',
    },
    holdings_history_meta: {
      collection: `items/${I}/accounts/${A}/holdings_history`,
      id: 'hh_4kWz8nVq',
    },
    balance_history: { collection: `items/${I}/accounts/${A}/balance_history`, id: '2026-01-15' },
    plaid_accounts: { collection: `items/${I}/accounts/${A}`, id: 'pa_7Kd2mQxZ' },
    transactions: { collection: `items/${I}/accounts/${A}/transactions`, id: 'txn_2vLq9XmT' },
    accounts: { collection: `items/${I}/accounts`, id: A },
    recurring: { collection: `users/${U}/recurring`, id: 'rec_8kLm3PqX' },
    budgets: { collection: `users/${U}/budgets`, id: 'bud_4kWzR8nV' },
    financial_goals: { collection: `users/${U}/financial_goals`, id: 'gol_6rLpX3mQ' },
    financial_goal_history: {
      collection: `users/${U}/financial_goals/gol_6rLpX3mQ/financial_goal_history`,
      id: '2026-01',
    },
    investment_prices: { collection: 'investment_prices/sec_8nVc2KpX/daily', id: '2026-01' },
    investment_splits: { collection: 'investment_splits', id: 'spl_3hTq7WmZ' },
    items: { collection: 'items', id: I },
    tags: { collection: `users/${U}/tags`, id: 'tag_3hTq7WmZ' },
    categories: { collection: `users/${U}/categories`, id: 'cat_7Kd2mQxZ' },
    transaction_changes: { collection: 'changes/chg_4kWz/t', id: 'tc_2mXq' },
    account_changes: { collection: 'changes/chg_4kWz/a', id: 'ac_2mXq' },
    changes: { collection: 'changes', id: 'chg_4kWz' },
    securities: { collection: 'securities', id: 'sec_8nVc2KpX' },
    users: { collection: 'users', id: U },
    amazon_orders: { collection: 'amazon/amz_5pQw/orders', id: 'ord_9wKe' },
    amazon: { collection: 'amazon', id: 'amz_5pQw' },
    subscriptions: { collection: 'subscriptions', id: 'sub_6rLp' },
    invites: { collection: 'invites', id: 'inv_6rLp' },
    user_items: { collection: 'user_items', id: U },
    feature_tracking: { collection: 'feature_tracking', id: U },
    support: { collection: 'support', id: U },
  };

  test('the sweep covers every route that has a processor', () => {
    const swept = COLLECTION_ROUTES.filter(
      (r) => !(NO_PROCESSOR as readonly string[]).includes(r)
    ).sort();
    expect(Object.keys(PATHS).sort()).toEqual(swept);
    expect(Object.keys(ROWS).sort()).toEqual(swept);
  });

  test.each(Object.entries(PATHS))('%s', async (route, { collection, id }) => {
    // The table must say what it means: a path that routes elsewhere would
    // make this pass for the wrong processor.
    expect(routeCollection(collection)).toBe(route as CollectionRoute);

    const dbPath = path.join(FIXTURES_DIR, `fieldless-${route}`);
    await createDeepTestDb(dbPath, [{ collection, id, fields: {} }]);
    const all = await decodeAllCollections(dbPath);
    const rows = ROWS[route as SweptRoute](all);

    expect(rows).toBe(0);
    // Every accessor, not only the route's own: a guard removed together with
    // a dispatch change that pushes the row into a different array would pass
    // the line above and fail here. The line above is subsumed by this one and
    // stays only for its clearer failure: it names the route's own count.
    const everywhere = Object.entries(ROWS)
      .filter(([, count]) => count(all) !== 0)
      .map(([other]) => other);
    expect(everywhere).toEqual([]);
  });
});
