/**
 * #845 detector: the `category` filter means the same thing in cache mode
 * (get_transactions) and live mode (get_transactions_live), driven through
 * both tools' real entry points over one fixture:
 *   - a category id matches exactly (never a substring, never a name);
 *   - a parent id also returns its subcategories' rows;
 *   - a value that is no category id is an error that says where to get one,
 *     instead of a silent zero-row answer.
 */

import { describe, test, expect, mock } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { LiveTransactionsTools } from '../../src/tools/live/transactions.js';
import { resolveCategoryFilter } from '../../src/tools/category-filter.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import type { TransactionNode } from '../../src/core/graphql/queries/transactions.js';
import type { CategoryNode } from '../../src/core/graphql/queries/categories.js';
import type { Transaction } from '../../src/models/index.js';

const PARENT = 'Pq3mW8nR2tV6xL9sK4dB'; // "Food"
const CHILD_A = 'Ca7vN2qT5wR9mK3xP6sF'; // "Restaurants", child of Food
const CHILD_B = 'Cb4xL8pS2nW6vQ9tM3rH'; // "Groceries", child of Food
const OTHER = 'Ot9kR3mV7qN2wT5xL8sJ'; // "Shopping", top level
const ORPHAN = 'Or2tW6nK9mQ4vR8xP3sL'; // on a transaction, in no category list

const CATEGORIES: Array<{ id: string; name: string; parentId: string | null }> = [
  { id: PARENT, name: 'Food', parentId: null },
  { id: CHILD_A, name: 'Restaurants', parentId: PARENT },
  { id: CHILD_B, name: 'Groceries', parentId: PARENT },
  { id: OTHER, name: 'Shopping', parentId: null },
];

const ROWS: Array<{ id: string; categoryId: string }> = [
  { id: 'Ra1kW9mQ2nR7tV4xL8sP', categoryId: PARENT },
  { id: 'Rb2mX2nR8tW5qK9vL3sQ', categoryId: CHILD_A },
  { id: 'Rc3nY3pS9vX6rL2wM4tR', categoryId: CHILD_B },
  { id: 'Rd4pZ4qT2wY7sM3xN5vS', categoryId: OTHER },
  { id: 'Re5qA5rV3xZ8tN4yP6wT', categoryId: ORPHAN },
];

function cacheTools(): CopilotMoneyTools {
  const db = new CopilotDatabase('/fake/path');
  const transactions: Transaction[] = ROWS.map((r) => ({
    transaction_id: r.id,
    amount: 20,
    date: '2026-03-10',
    name: 'SYNTHETIC',
    category_id: r.categoryId,
    account_id: 'Wn7qL3xK9mT2vR6pB4sD',
  }));
  db._injectDataForTesting({
    transactions,
    accounts: [],
    recurring: [],
    budgets: [],
    goals: [],
    goalHistory: [],
    investmentPrices: [],
    items: [],
    tags: [],
    userCategories: CATEGORIES.map((c, i) => ({
      category_id: c.id,
      name: c.name,
      order: i,
      ...(c.parentId ? { parent_category_id: c.parentId } : {}),
    })),
    categoryNameMap: new Map(CATEGORIES.map((c) => [c.id, c.name])),
    accountNameMap: new Map(),
  });
  return new CopilotMoneyTools(db);
}

async function liveTools(): Promise<LiveTransactionsTools> {
  const client = { mutate: mock(), query: mock() } as unknown as GraphQLClient;
  const cache = {
    getAccounts: mock(() => Promise.resolve([])),
    getTags: mock(() => Promise.resolve([])),
  } as unknown as CopilotDatabase;
  const live = new LiveCopilotDatabase(client, cache);
  const nodes = ROWS.map(
    (r) =>
      ({
        id: r.id,
        accountId: 'Wn7qL3xK9mT2vR6pB4sD',
        itemId: 'Xp8rM4yL2nV7wS3qC5tF',
        categoryId: r.categoryId,
        recurringId: null,
        parentId: null,
        isReviewed: false,
        isPending: false,
        amount: 20,
        date: '2026-03-10',
        name: 'Synthetic',
        type: 'REGULAR',
        userNotes: null,
        tipAmount: null,
        suggestedCategoryIds: [],
        isoCurrencyCode: 'USD',
        createdAt: 0,
        tags: [],
        goal: null,
      }) as TransactionNode
  );
  // Honour the requested window, as the real fetch does: an orphan id is
  // accepted only when a row in the window carries it (#858 review).
  (
    live as unknown as {
      getTransactions: (r: { from: string; to: string }) => Promise<unknown>;
    }
  ).getTransactions = async ({ from, to }) => ({
    rows: nodes.filter((n) => n.date >= from && n.date <= to),
    oldest_fetched_at: 0,
    newest_fetched_at: 0,
    hit: true,
    dropped_invalid_rows: 0,
  });
  const categoryNodes: CategoryNode[] = CATEGORIES.map((c) => ({
    id: c.id,
    parentId: c.parentId,
    name: c.name,
    templateId: null,
    colorName: null,
    icon: null,
    isExcluded: false,
    isRolloverDisabled: false,
    canBeDeleted: true,
    budget: null,
  }));
  await live.getCategoriesCache().read(() => Promise.resolve(categoryNodes));
  return new LiveTransactionsTools(live);
}

const RANGE = { start_date: '2026-03-01', end_date: '2026-03-31', limit: 500 } as const;

async function idsInBothModes(category: string): Promise<{ cache: string[]; live: string[] }> {
  const cache = await cacheTools().getTransactions({ ...RANGE, category });
  const live = await (await liveTools()).getTransactions({ ...RANGE, category });
  return {
    cache: cache.transactions.map((t) => t.transaction_id as string).sort(),
    live: live.transactions.map((t) => t.transaction_id as string).sort(),
  };
}

describe('category filter parity across modes (#845)', () => {
  test.each([
    ['a parent id includes its subcategories', PARENT, [ROWS[0], ROWS[1], ROWS[2]]],
    ['a child id is only that child', CHILD_A, [ROWS[1]]],
    ['a top-level id with no children', OTHER, [ROWS[3]]],
    ['an id only a transaction carries', ORPHAN, [ROWS[4]]],
  ] as const)('%s', async (_label, category, expected) => {
    const { cache, live } = await idsInBothModes(category);
    expect(live).toEqual(cache);
    expect(cache).toEqual(expected.map((r) => r.id).sort());
  });

  const APRIL = { start_date: '2026-04-01', end_date: '2026-04-30', limit: 500 } as const;

  async function errorOf(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error('expected the call to be rejected');
  }

  test.each([
    [
      'a category name',
      'Food',
      RANGE,
      /'Food' is a category NAME; its id is 'Pq3mW8nR2tV6xL9sK4dB'/,
    ],
    ['a substring of an id', PARENT.slice(0, 6), RANGE, /matches no category id/],
    ['a different-case id', PARENT.toLowerCase(), RANGE, /matches no category id/],
    ['a typo', 'not-a-category', RANGE, /matches no category id/],
    // #858 review: both modes judge an orphan id by the same corpus, the rows in
    // the queried window. Outside its rows' window it is rejected in both.
    ["an orphan id outside its rows' window", ORPHAN, APRIL, /matches no category id/],
  ] as const)(
    '%s is rejected in both modes, with a hint',
    async (_label, category, range, message) => {
      const cacheMessage = await errorOf(() =>
        cacheTools().getTransactions({ ...range, category })
      );
      const live = await liveTools();
      const liveMessage = await errorOf(() => live.getTransactions({ ...range, category }));
      expect(cacheMessage).toMatch(message);
      expect(cacheMessage).toMatch(/from get_categories\./);
      expect(liveMessage).toMatch(message);
      expect(liveMessage).toMatch(/from get_categories_live\./);
    }
  );
});

describe('resolveCategoryFilter', () => {
  test('walks more than one level and survives a parent cycle in bad data', () => {
    const nodes = [
      { id: 'Ga1', parentId: 'Gc3' },
      { id: 'Gb2', parentId: 'Ga1' },
      { id: 'Gc3', parentId: 'Gb2' },
    ];
    expect(resolveCategoryFilter('Ga1', nodes, { listTool: 'x' })).toEqual(
      new Set(['Ga1', 'Gb2', 'Gc3'])
    );
  });

  test('a row that is its own parent terminates and selects itself', () => {
    expect(
      resolveCategoryFilter('Gs1', [{ id: 'Gs1', parentId: 'Gs1' }], { listTool: 'x' })
    ).toEqual(new Set(['Gs1']));
  });

  test('an orphan id accepted via knownElsewhere still expands children that name it', () => {
    // A parent deleted upstream whose children survive in the list.
    const nodes = [{ id: 'Gk2', parentId: 'Gp1' }];
    expect(resolveCategoryFilter('Gp1', nodes, { listTool: 'x', knownElsewhere: true })).toEqual(
      new Set(['Gp1', 'Gk2'])
    );
  });
});
