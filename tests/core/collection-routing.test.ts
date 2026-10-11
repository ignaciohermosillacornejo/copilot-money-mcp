/**
 * `routeCollection` is the decoder's dispatch decision, as a value (#778).
 *
 * `decodeAllCollections` used to inline an ordered if/else chain, and every
 * tool that needed to know "where would the decoder send this document?" wrote
 * its own copy: `scripts/smoke/cache.ts` matched by root prefix, and
 * `scripts/decode-coverage.ts` mirrored the chain by hand behind a "keep this
 * in sync" comment. Both drifted. The smoke compared six of its nine roots
 * against nothing, and the coverage script still accepted the `items/{id}`
 * clause #627 removed from the decoder.
 *
 * These pin the routing itself — mostly its ORDER, since a leaf name alone is
 * ambiguous (`users/<uid>/accounts` vs `items/<id>/accounts`) and the first
 * matching clause wins.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  routeCollection,
  decodeGoalHistory,
  decodeAllCollections,
} from '../../src/core/decoder.js';
import { createDeepTestDb } from '../helpers/test-db.js';

describe('routeCollection', () => {
  test.each([
    // The six roots the root-prefix smoke could not see: all nested.
    [
      'items/itm_5pQw8ZnRvL3MxK7cHt2J/accounts/acc_9wKe4RnTpB2XvL7mQd3F/transactions',
      'transactions',
    ],
    ['items/itm_5pQw8ZnRvL3MxK7cHt2J/accounts', 'accounts'],
    ['users/usr_3hTq7WmZ2xKv9LpR4cNb/categories', 'categories'],
    ['users/usr_3hTq7WmZ2xKv9LpR4cNb/budgets', 'budgets'],
    ['users/usr_3hTq7WmZ2xKv9LpR4cNb/financial_goals', 'financial_goals'],
    ['users/usr_3hTq7WmZ2xKv9LpR4cNb/tags', 'tags'],
    // And the three it could.
    ['items', 'items'],
    ['investment_prices/sec_8nVc2KpX5tLm3QwR7zHd/daily', 'investment_prices'],
    ['securities', 'securities'],
  ])('%s → %s', (collection, route) => {
    expect(routeCollection(collection)).toBe(route);
  });

  test('the user-customization accounts collection is not the account collection', () => {
    // Same leaf, different vocabulary (`hidden` vs `user_hidden`). Checked first
    // in the chain for exactly this reason; a leaf match would merge them.
    expect(routeCollection('users/usr_3hTq7WmZ2xKv9LpR4cNb/accounts')).toBe('user_accounts');
  });

  test('a subcollection under an account is not routed as the account', () => {
    // What made the root-prefix `items` count sum every document beneath it:
    // these all live under `items/` and none of them is an item.
    const acct = 'items/itm_5pQw8ZnRvL3MxK7cHt2J/accounts/acc_9wKe4RnTpB2XvL7mQd3F';
    expect(routeCollection(acct)).toBe('plaid_accounts');
    expect(routeCollection(`${acct}/balance_history`)).toBe('balance_history');
    expect(routeCollection(`${acct}/holdings_history`)).toBe('holdings_history_meta');
    expect(routeCollection(`${acct}/holdings_history/h_2mXq/history`)).toBe('holdings_history');
  });

  test('an items/{id} parent-pointer path is not routed to items (#627)', () => {
    // The clause #627 removed from the decoder and that the hand-mirrored copy
    // in scripts/decode-coverage.ts kept.
    expect(routeCollection('items/itm_5pQw8ZnRvL3MxK7cHt2J')).toBeNull();
  });

  test('goal history routes to its own collection, not to financial_goals', () => {
    expect(
      routeCollection(
        'users/usr_3hTq7WmZ2xKv9LpR4cNb/financial_goals/gol_6rLp/financial_goal_history'
      )
    ).toBe('financial_goal_history');
  });

  test('change subcollections route by their one-letter leaf', () => {
    expect(routeCollection('changes/chg_4kWz/t')).toBe('transaction_changes');
    expect(routeCollection('changes/chg_4kWz/a')).toBe('account_changes');
    expect(routeCollection('changes')).toBe('changes');
  });

  test('user profiles match both the collection and its parent-pointer path', () => {
    expect(routeCollection('users')).toBe('users');
    expect(routeCollection('users/usr_3hTq7WmZ2xKv9LpR4cNb')).toBe('users');
  });

  test('investment_prices is root-anchored, unlike the leaf-matched routes', () => {
    // The decoder genuinely uses a prefix here; a leaf match would miss every
    // nested price document.
    expect(routeCollection('investment_prices')).toBe('investment_prices');
    expect(routeCollection('users/usr_3hTq7WmZ2xKv9LpR4cNb/investment_prices')).toBeNull();
  });

  test('an unknown collection is unrouted', () => {
    expect(routeCollection('never_existed')).toBeNull();
    // Leaf match is on a whole segment, not a string suffix.
    expect(routeCollection('archived_transactions')).toBeNull();
  });
});

describe('goal history resolves its goal id from the path the same way everywhere (#778 review)', () => {
  // The same class one level down: decodeGoalHistory's goalId filter read the
  // goal id at segment [1] while processGoalHistory read it at [3]. On the real
  // layout [1] is the USER id, so filtering by goal returned nothing; on the
  // only fixture layout ([1] = goal id) [3] does not exist. Each spelling was
  // right for its own tests and neither was right for both.
  const FIXTURES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-history-path-'));
  afterAll(() => fs.rmSync(FIXTURES_DIR, { recursive: true, force: true }));

  const USER = 'usr_3hTq7WmZ2xKv9LpR4cNb';
  const GOAL = 'gol_6rLpX3mQw9KzT2vN8cHb';
  const OTHER = 'gol_2vLq9XmT4kRz7PwN3cHb';

  test.each([
    ['the real nested layout', `users/${USER}/financial_goals`],
    ['the top-level fixture layout', 'financial_goals'],
  ])('filtering by goal id works on %s', async (_label, goalsPath) => {
    const dbPath = path.join(FIXTURES_DIR, goalsPath.replace(/\//g, '_'));
    await createDeepTestDb(dbPath, [
      {
        collection: `${goalsPath}/${GOAL}/financial_goal_history`,
        id: '2026-01',
        fields: { current_amount: 100 },
      },
      {
        collection: `${goalsPath}/${OTHER}/financial_goal_history`,
        id: '2026-01',
        fields: { current_amount: 200 },
      },
    ]);

    const filtered = await decodeGoalHistory(dbPath, GOAL);
    const all = await decodeAllCollections(dbPath);

    expect(filtered.map((h) => h.goal_id)).toEqual([GOAL]);
    // And the processor agrees with the filter about whose history this is.
    expect(all.goalHistory.map((h) => h.goal_id).sort()).toEqual([GOAL, OTHER].sort());
  });
});
