/**
 * One real collection path per decoder route, shared by the tests that need
 * "a document the decoder would send to route R" (#915 review).
 *
 * `ROUTE_PATHS` is typed `Record<SweptRoute, ...>` and `ROUTE_SHAPES`
 * `Record<CollectionRoute, string>`, so adding a route to `COLLECTION_ROUTES`
 * without a path here is a type error under `bun run check`. That is the
 * ratchet: `tests/core/parent-pointer-documents.test.ts` sweeps every entry
 * for fieldless and populated documents, and
 * `tests/core/collection-routing.test.ts` probes an unknown subcollection
 * beneath every shape, so neither can silently skip a new route.
 *
 * Paths are the shapes seen on a real cache, with opaque synthetic ids.
 */

import type { CollectionRoute } from '../../src/core/decoder.js';

/** Routes with no processor, so nothing to sweep: the unread #666 path. */
export const NO_PROCESSOR = ['user_accounts'] as const;
/** Every route that has a processor. */
export type SweptRoute = Exclude<CollectionRoute, (typeof NO_PROCESSOR)[number]>;

const I = 'itm_5pQw8ZnRvL3MxK7cHt2J';
const A = 'acc_9wKe4RnTpB2XvL7mQd3F';
const U = 'usr_3hTq7WmZ2xKv9LpR4cNb';

/**
 * `populated` (#808): the smallest field set the route's processor turns into
 * a row. Where a processor passes every field through (holdings_history_meta
 * and the app-metadata routes) the field name is arbitrary; elsewhere it is a
 * field the processor reads.
 */
export const ROUTE_PATHS: Record<
  SweptRoute,
  { collection: string; id: string; populated: Record<string, unknown> }
> = {
  holdings_history: {
    collection: `items/${I}/accounts/${A}/holdings_history/hh_4kWz8nVq/history`,
    id: '2026-01',
    populated: { history: { '1767225600000': { price: 100, quantity: 2 } } },
  },
  holdings_history_meta: {
    collection: `items/${I}/accounts/${A}/holdings_history`,
    id: 'hh_4kWz8nVq',
    populated: { security_id: 'sec_8nVc2KpX' },
  },
  balance_history: {
    collection: `items/${I}/accounts/${A}/balance_history`,
    id: '2026-01-15',
    populated: { current_balance: 100 },
  },
  transactions: {
    collection: `items/${I}/accounts/${A}/transactions`,
    id: 'txn_2vLq9XmT',
    // Both required: no non-zero amount or no date is not a transaction.
    populated: { amount: 100, date: '2026-01-15' },
  },
  accounts: {
    collection: `items/${I}/accounts`,
    id: A,
    // Both required: a balance, and a name (or official_name).
    populated: { current_balance: 100, name: 'Synthetic Checking' },
  },
  recurring: {
    collection: `users/${U}/recurring`,
    id: 'rec_8kLm3PqX',
    populated: { name: 'Synthetic Subscription' },
  },
  budgets: { collection: `users/${U}/budgets`, id: 'bud_4kWzR8nV', populated: { amount: 100 } },
  financial_goals: {
    collection: `users/${U}/financial_goals`,
    id: 'gol_6rLpX3mQ',
    populated: { name: 'Synthetic Goal' },
  },
  financial_goal_history: {
    collection: `users/${U}/financial_goals/gol_6rLpX3mQ/financial_goal_history`,
    id: '2026-01',
    populated: { current_amount: 100 },
  },
  investment_prices: {
    collection: 'investment_prices/sec_8nVc2KpX/daily',
    id: '2026-01',
    populated: { price: 100 },
  },
  investment_splits: {
    collection: 'investment_splits',
    id: 'spl_3hTq7WmZ',
    populated: { '2026-01-15': 2 },
  },
  items: { collection: 'items', id: I, populated: { institution_name: 'Synthetic Bank' } },
  tags: { collection: `users/${U}/tags`, id: 'tag_3hTq7WmZ', populated: { name: 'Synthetic' } },
  categories: {
    collection: `users/${U}/categories`,
    id: 'cat_7Kd2mQxZ',
    populated: { name: 'Synthetic' },
  },
  transaction_changes: {
    collection: 'changes/chg_4kWz/t',
    id: 'tc_2mXq',
    populated: { action: 'create' },
  },
  account_changes: {
    collection: 'changes/chg_4kWz/a',
    id: 'ac_2mXq',
    populated: { action: 'update' },
  },
  changes: {
    collection: 'changes',
    id: 'chg_4kWz',
    populated: { timestamp: '2026-01-15T10:00:00Z' },
  },
  securities: {
    collection: 'securities',
    id: 'sec_8nVc2KpX',
    populated: { name: 'Synthetic Fund' },
  },
  users: { collection: 'users', id: U, populated: { public_id: 'pub_7Kd2mQxZ' } },
  amazon_orders: {
    collection: 'amazon/amz_5pQw/orders',
    id: 'ord_9wKe',
    populated: { date: '2026-01-15' },
  },
  amazon: { collection: 'amazon', id: 'amz_5pQw', populated: { status: 'connected' } },
  subscriptions: {
    collection: 'subscriptions',
    id: 'sub_6rLp',
    populated: { provider: 'apple' },
  },
  invites: { collection: 'invites', id: 'inv_6rLp', populated: { code: 'SYNTH123' } },
  user_items: { collection: 'user_items', id: U, populated: { items: { [I]: true } } },
  feature_tracking: { collection: 'feature_tracking', id: U, populated: { enabled: true } },
  support: { collection: 'support', id: U, populated: { topic: 'billing' } },
};

/** A real collection shape for EVERY route, including the ones with no processor. */
export const ROUTE_SHAPES: Record<CollectionRoute, string> = {
  ...(Object.fromEntries(
    Object.entries(ROUTE_PATHS).map(([route, { collection }]) => [route, collection])
  ) as Record<SweptRoute, string>),
  user_accounts: `users/${U}/accounts`,
};
