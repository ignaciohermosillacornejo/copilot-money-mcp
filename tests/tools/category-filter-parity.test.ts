/**
 * #845 detector: the `category` filter means the same thing in cache mode
 * (get_transactions) and live mode (get_transactions_live), driven through
 * both tools' real entry points over one fixture:
 *   - a category id matches exactly (never a substring, never a name);
 *   - a parent id also returns its subcategories' rows;
 *   - a value that is no category id is an error that says where to get one,
 *     instead of a silent zero-row answer.
 */

import { describe, test, expect, mock, spyOn } from 'bun:test';
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
// Orphan ids carried in-window ONLY by rows the GraphQL server never returns
// and the cache tool drops by default (#858 review). The Plaid-deleted row is a
// real shape: it exists in the cache only, as on real data. The split parent is
// included for symmetry and to pin the predicate: the server blanks a split
// parent's categoryId, so on real data only the deleted case is reachable.
const DELETED_ONLY = 'Dl5nQ8wK2mT6vR3xP9sB';
const SPLIT_PARENT_ONLY = 'Sp7kW3nR9mQ2vT6xL4sD';

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
  const transactions: Transaction[] = [
    ...ROWS.map((r) => ({
      transaction_id: r.id,
      amount: 20,
      date: '2026-03-10',
      name: 'SYNTHETIC',
      category_id: r.categoryId,
      account_id: 'Wn7qL3xK9mT2vR6pB4sD',
    })),
    {
      transaction_id: 'Cx1kW9mQ2nR7tV4xL8sZ',
      amount: 20,
      date: '2026-03-10',
      name: 'SYNTHETIC',
      category_id: DELETED_ONLY,
      account_id: 'Wn7qL3xK9mT2vR6pB4sD',
      plaid_deleted: true,
    },
    {
      transaction_id: 'Cy2mX2nR8tW5qK9vL3sY',
      amount: 40,
      date: '2026-03-10',
      name: 'SYNTHETIC',
      category_id: SPLIT_PARENT_ONLY,
      account_id: 'Wn7qL3xK9mT2vR6pB4sD',
      children_transaction_ids: ['Cz3nY3pS9vX6rL2wM4tX'],
    },
    {
      // The split child: uncategorized, so it carries no id any case filters on.
      transaction_id: 'Cz3nY3pS9vX6rL2wM4tX',
      amount: 40,
      date: '2026-03-10',
      name: 'SYNTHETIC',
      account_id: 'Wn7qL3xK9mT2vR6pB4sD',
      parent_transaction_id: 'Cy2mX2nR8tW5qK9vL3sY',
    },
  ];
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
    // #858 review: an id carried only by a row neither mode returns is not
    // "known elsewhere" — cache used to accept it and return zero rows.
    ['an id carried only by a deleted row', DELETED_ONLY, RANGE, /matches no category id/],
    ['an id carried only by a split parent', SPLIT_PARENT_ONLY, RANGE, /matches no category id/],
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

describe("the corpus follows the call's own flags (#858 review round 5)", () => {
  test('exclude_deleted: false returns the deleted row instead of rejecting its id', async () => {
    const result = await cacheTools().getTransactions({
      ...RANGE,
      category: DELETED_ONLY,
      exclude_deleted: false,
    });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['Cx1kW9mQ2nR7tV4xL8sZ']);
  });

  test('exclude_split_parents: false returns the split parent instead of rejecting its id', async () => {
    const result = await cacheTools().getTransactions({
      ...RANGE,
      category: SPLIT_PARENT_ONLY,
      exclude_split_parents: false,
    });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['Cy2mX2nR8tW5qK9vL3sY']);
  });
});

describe('a lookup by transaction_id still validates category (#858 review)', () => {
  test('an unknown category is an error in both modes; a known one does not block it', async () => {
    const lookup = {
      transaction_id: ROWS[0].id,
      account_id: 'Wn7qL3xK9mT2vR6pB4sD',
      item_id: 'Xp8rM4yL2nV7wS3qC5tF',
      ...RANGE,
    };
    await expect(cacheTools().getTransactions({ ...lookup, category: 'Food' })).rejects.toThrow(
      /'Food' is a category NAME/
    );
    const live = await liveTools();
    await expect(live.getTransactions({ ...lookup, category: 'Food' })).rejects.toThrow(
      /'Food' is a category NAME/
    );
    const cacheOk = await cacheTools().getTransactions({ ...lookup, category: PARENT });
    expect(cacheOk.transactions.map((t) => t.transaction_id)).toEqual([ROWS[0].id]);
    const liveOk = await live.getTransactions({ ...lookup, category: PARENT });
    expect(liveOk.transactions.map((t) => t.transaction_id)).toEqual([ROWS[0].id]);
  });
});

describe('the cache lookup path searches the whole cache (#858 review round 6)', () => {
  test('an orphan id carried by the looked-up row is accepted outside the period', async () => {
    // The ORPHAN row is dated March; the period is April. A lookup by id
    // ignores the period, so the corpus is the whole cache and the id is known.
    // (Live mode cannot see the row outside its fetched window, so this is a
    // cache-mode capability, not a parity case.)
    const result = await cacheTools().getTransactions({
      transaction_id: ROWS[4].id,
      category: ORPHAN,
      start_date: '2026-04-01',
      end_date: '2026-04-30',
    });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual([ROWS[4].id]);
  });

  // #860 review: the uncapped read is unobservable without a 50k-row fixture,
  // so pin the call instead — the lookup path must never fall back to the
  // capped, date-bounded read.
  test('the lookup path reads the uncapped whole cache, never the 50k-capped window', async () => {
    const tools = cacheTools();
    const db = (tools as unknown as { db: CopilotDatabase }).db;
    const capped = spyOn(db, 'getTransactions');
    const whole = spyOn(db, 'getAllTransactions');
    await tools.getTransactions({
      transaction_id: ROWS[4].id,
      category: ORPHAN,
      start_date: '2026-04-01',
      end_date: '2026-04-30',
    });
    expect(capped).not.toHaveBeenCalled();
    expect(whole).toHaveBeenCalled();
  });

  test('an unknown category on a lookup names the cache as the corpus', async () => {
    await expect(
      cacheTools().getTransactions({
        transaction_id: ROWS[0].id,
        category: 'not-a-category',
        ...RANGE,
      })
    ).rejects.toThrow(/no transaction in the cache carries it/);
  });
});

describe('cache mode with no date bounds (#858 review)', () => {
  test('the error names the corpus it actually searched: the whole cache', async () => {
    await expect(
      cacheTools().getTransactions({ category: 'not-a-category', limit: 500 })
    ).rejects.toThrow(/no transaction in the cache carries it/);
  });
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
