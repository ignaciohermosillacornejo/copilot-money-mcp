/**
 * #867 detector: a category id that is in NEITHER name map (the user's
 * categories nor the Plaid taxonomy) yields no `category_name` in every tool
 * that returns one, in cache mode and live mode alike.
 *
 * Cache mode used to run such an id through getCategoryName(), which
 * title-cases a snake_case id and echoes any other id verbatim, so the caller
 * got the raw id back as if it were a name. Live mode has never done that: the
 * name comes from the server's category list or not at all.
 *
 * Each case drives a real tool entry point over a fixture that carries one
 * KNOWN id (so a resolver that returned nothing for everything would fail) and
 * two unknown ids — an opaque Firestore-shaped one (the echo path) and a
 * snake_case one (the title-case path).
 */

import { describe, test, expect, mock } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { LiveTransactionsTools } from '../../src/tools/live/transactions.js';
import { LiveRecurringTools } from '../../src/tools/live/recurring.js';
import { LiveUpcomingRecurringsTools } from '../../src/tools/live/upcoming-recurrings.js';
import { lookupKnownCategoryName } from '../../src/utils/categories.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import type { TransactionNode } from '../../src/core/graphql/queries/transactions.js';
import type { CategoryNode } from '../../src/core/graphql/queries/categories.js';
import type { RecurringNode } from '../../src/core/graphql/queries/recurrings.js';
import type { Transaction } from '../../src/models/index.js';

const CAT_KNOWN = 'Kq8vN3tR6mW2pX9sL4dB';
const KNOWN_NAME = 'Shopping';
// Opaque, like a deleted user category's id: getCategoryName() echoed it.
const CAT_OPAQUE = 'Ux9qK5aD3gJ8cX4hY6eC';
// snake_case and not in the Plaid taxonomy: getCategoryName() title-cased it.
const CAT_SNAKE = 'retired_custom_bucket';
const UNKNOWN_IDS = [CAT_OPAQUE, CAT_SNAKE] as const;

const RANGE = { start_date: '2026-03-01', end_date: '2026-03-31' } as const;

/** One transaction id per category, so a row can be traced back to its id. */
const TXN_BY_CATEGORY: Record<string, string> = {
  [CAT_KNOWN]: 'Ab3kW9mQ2nR7tV4xL8sP',
  [CAT_OPAQUE]: 'Bc4mX2nR8tW5qK9vL3sQ',
  [CAT_SNAKE]: 'Cd5nY3pS9vX6rL2wM4tR',
};
const ALL_IDS = [CAT_KNOWN, ...UNKNOWN_IDS];
/** What every tool must report for each id: the known name, or nothing. */
const EXPECTED_NAME: Record<string, string | null> = {
  [CAT_KNOWN]: KNOWN_NAME,
  [CAT_OPAQUE]: null,
  [CAT_SNAKE]: null,
};

const RECURRING_BY_CATEGORY: Record<string, string> = {
  [CAT_KNOWN]: 'Rk1vN3tR6mW2pX9sL4dB',
  [CAT_OPAQUE]: 'Ro2qK5aD3gJ8cX4hY6eC',
  [CAT_SNAKE]: 'Rs3nY3pS9vX6rL2wM4tR',
};

test('the fixture ids are what the cases claim', () => {
  const userMap = new Map([[CAT_KNOWN, KNOWN_NAME]]);
  expect(lookupKnownCategoryName(CAT_KNOWN, userMap)).toBe(KNOWN_NAME);
  for (const id of UNKNOWN_IDS) expect(lookupKnownCategoryName(id, userMap)).toBeNull();
});

function cacheTools(): CopilotMoneyTools {
  const db = new CopilotDatabase('/fake/path');
  const transactions: Transaction[] = ALL_IDS.flatMap((categoryId, i) => [
    {
      transaction_id: TXN_BY_CATEGORY[categoryId]!,
      amount: 20,
      date: '2026-03-10',
      name: `MERCHANT ${i}`,
      category_id: categoryId,
    },
    // A second charge from the same merchant, so the recurring detector
    // reports a pattern carrying this category.
    {
      transaction_id: `${TXN_BY_CATEGORY[categoryId]!.slice(0, -1)}Z`,
      amount: 20,
      date: '2026-03-24',
      name: `MERCHANT ${i}`,
      category_id: categoryId,
    },
  ]);
  db._injectDataForTesting({
    transactions,
    accounts: [],
    recurring: ALL_IDS.map((categoryId, i) => ({
      recurring_id: RECURRING_BY_CATEGORY[categoryId]!,
      name: `Subscription ${i}`,
      amount: 10,
      frequency: 'monthly',
      state: 'active',
      category_id: categoryId,
      transaction_ids: [],
    })),
    budgets: ALL_IDS.map((categoryId, i) => ({
      budget_id: `Bu${i}dK5aD3gJ8cX4hY6eC`,
      amount: 100,
      category_id: categoryId,
      is_active: true,
    })),
    goals: [],
    goalHistory: [],
    investmentPrices: [],
    items: [],
    tags: [],
    userCategories: [{ category_id: CAT_KNOWN, name: KNOWN_NAME, order: 0 }],
    categoryNameMap: new Map([[CAT_KNOWN, KNOWN_NAME]]),
    accountNameMap: new Map(),
  });
  return new CopilotMoneyTools(db);
}

const CATEGORY_NODES: CategoryNode[] = [
  {
    id: CAT_KNOWN,
    parentId: null,
    name: KNOWN_NAME,
    templateId: null,
    colorName: null,
    icon: null,
    isExcluded: false,
    isRolloverDisabled: false,
    canBeDeleted: true,
    budget: null,
  },
];

function transactionNode(categoryId: string): TransactionNode {
  return {
    id: TXN_BY_CATEGORY[categoryId]!,
    accountId: 'Wn7qL3xK9mT2vR6pB4sD',
    itemId: 'Xp8rM4yL2nV7wS3qC5tF',
    categoryId,
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
  } as TransactionNode;
}

function recurringNode(categoryId: string): RecurringNode {
  return {
    id: RECURRING_BY_CATEGORY[categoryId]!,
    name: 'Synthetic',
    state: 'ACTIVE',
    frequency: 'MONTHLY',
    nextPaymentAmount: null,
    nextPaymentDate: null,
    categoryId,
    emoji: null,
    icon: null,
    rule: null,
    payments: [],
  };
}

/** A live db whose client answers every read this file makes. */
async function liveDb(): Promise<LiveCopilotDatabase> {
  const recurrings = ALL_IDS.map(recurringNode);
  const client = {
    mutate: mock(),
    query: mock((operation: string) => {
      if (operation === 'User')
        return Promise.resolve({ user: { id: 'Us3rQ7mK2nW9vR4xT8sL', budgetingConfig: null } });
      if (operation === 'Categories')
        return Promise.resolve({
          categories: CATEGORY_NODES.map(({ parentId: _p, ...rest }) => rest),
        });
      return Promise.resolve({ recurrings, unpaidUpcomingRecurrings: recurrings });
    }),
  } as unknown as GraphQLClient;
  const cache = {
    getAccounts: mock(() => Promise.resolve([])),
    getTags: mock(() => Promise.resolve([])),
  } as unknown as CopilotDatabase;
  const live = new LiveCopilotDatabase(client, cache);
  const nodes = ALL_IDS.map(transactionNode);
  (live as unknown as { getTransactions: () => Promise<unknown> }).getTransactions = async () => ({
    rows: nodes,
    oldest_fetched_at: 0,
    newest_fetched_at: 0,
    hit: true,
    dropped_invalid_rows: 0,
  });
  await live.getCategoriesCache().read(() => Promise.resolve(CATEGORY_NODES));
  return live;
}

type Row = Record<string, unknown>;

/** What the client receives: the MCP response is JSON, so an `undefined` value is no key. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Every tool (and every row group inside it) that returns a category name,
 * with a function that maps each category id to the row(s) carrying it.
 * "No name" is expressed the way the tool's own uncategorized rows express it
 * (an absent key in most, `null` where the row's other absent values are
 * `null`); `noName` pins which.
 */
interface Case {
  tool: string;
  mode: 'cache' | 'live';
  /** How "no name" looks: the key is absent, or present and `null`. */
  noName: 'absent' | 'null';
  rows: () => Promise<Map<string, Row[]>>;
}

function byCategory(rows: Row[], idOf: (row: Row) => string | undefined): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const row of rows) {
    const id = idOf(row);
    if (id === undefined) continue;
    out.set(id, [...(out.get(id) ?? []), row]);
  }
  return out;
}

const categoryOfTxn = (row: Row) =>
  Object.keys(TXN_BY_CATEGORY).find((c) => TXN_BY_CATEGORY[c] === row.transaction_id);
const categoryOfRecurring = (key: string) => (row: Row) =>
  Object.keys(RECURRING_BY_CATEGORY).find((c) => RECURRING_BY_CATEGORY[c] === row[key]);

const CASES: Case[] = [
  {
    tool: 'get_transactions',
    mode: 'cache',
    noName: 'absent',
    rows: async () => {
      const r = wire(await cacheTools().getTransactions({ ...RANGE, fields: ['all'] }));
      return byCategory(r.transactions as Row[], categoryOfTxn);
    },
  },
  {
    tool: 'get_transactions_live',
    mode: 'live',
    noName: 'absent',
    rows: async () => {
      const tools = new LiveTransactionsTools(await liveDb());
      const r = wire(await tools.getTransactions({ ...RANGE, fields: ['all'] }));
      return byCategory(r.transactions as Row[], categoryOfTxn);
    },
  },
  {
    tool: 'get_recurring_transactions (copilot_subscriptions)',
    mode: 'cache',
    noName: 'absent',
    rows: async () => {
      const r = wire(await cacheTools().getRecurringTransactions({ ...RANGE }));
      const groups = r.copilot_subscriptions ?? {};
      const rows = Object.values(groups).flat() as Row[];
      return byCategory(rows, categoryOfRecurring('recurring_id'));
    },
  },
  {
    tool: 'get_recurring_transactions (detail_view)',
    mode: 'cache',
    noName: 'absent',
    rows: async () => {
      const out = new Map<string, Row[]>();
      for (const id of ALL_IDS) {
        const r = wire(
          await cacheTools().getRecurringTransactions({
            ...RANGE,
            recurring_id: RECURRING_BY_CATEGORY[id],
          })
        );
        out.set(id, (r.detail_view ?? []) as Row[]);
      }
      return out;
    },
  },
  {
    tool: 'get_recurring_transactions (detected patterns)',
    mode: 'cache',
    noName: 'absent',
    rows: async () => {
      const r = wire(
        await cacheTools().getRecurringTransactions({
          ...RANGE,
          include_copilot_subscriptions: false,
          fields: ['all'],
        })
      );
      // The fixture names merchant i after ALL_IDS[i].
      return byCategory(
        r.recurring as Row[],
        (row) => ALL_IDS[Number(String(row.merchant).replace(/\D/g, ''))]
      );
    },
  },
  {
    tool: 'get_recurring_live',
    mode: 'live',
    noName: 'null',
    rows: async () => {
      const r = wire(await new LiveRecurringTools(await liveDb()).getRecurring({}));
      return byCategory(r.recurring as Row[], categoryOfRecurring('id'));
    },
  },
  {
    tool: 'get_upcoming_recurrings_live',
    mode: 'live',
    noName: 'null',
    rows: async () => {
      const r = wire(
        await new LiveUpcomingRecurringsTools(await liveDb()).getUpcomingRecurrings({})
      );
      return byCategory(r.upcoming as Row[], categoryOfRecurring('id'));
    },
  },
  {
    tool: 'get_categories (list view)',
    mode: 'cache',
    noName: 'null',
    rows: async () => {
      const r = wire(await cacheTools().getCategories({ view: 'list', ...RANGE }));
      const rows = (r.data as { categories: Row[] }).categories;
      return byCategory(rows, (row) => row.category_id as string);
    },
  },
];

describe('category_name for an id in neither name map (#867)', () => {
  describe.each(CASES)('$tool ($mode)', (c) => {
    test('the known id resolves to its name', async () => {
      const rows = (await c.rows()).get(CAT_KNOWN) ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.category_name).toBe(KNOWN_NAME);
    });

    test.each(UNKNOWN_IDS)('unknown id %s yields no name', async (id) => {
      const rows = (await c.rows()).get(id) ?? [];
      // The row must still be returned — the fix drops the name, not the row.
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        if (c.noName === 'absent') expect('category_name' in row).toBe(false);
        else expect(row.category_name).toBeNull();
      }
    });
  });

  test('get_budgets drops a budget on an unknown id rather than naming it', async () => {
    const r = wire(await cacheTools().getBudgets({}));
    const named = r.budgets.map((b) => [b.category_id, b.category_name ?? null]);
    expect(named).toEqual([[CAT_KNOWN, KNOWN_NAME]]);
  });

  test('cache and live get_transactions agree row-for-row on category_name', async () => {
    const cache = wire(await cacheTools().getTransactions({ ...RANGE, fields: ['default'] }));
    const live = wire(
      await new LiveTransactionsTools(await liveDb()).getTransactions({
        ...RANGE,
        fields: ['default'],
      })
    );
    const pick = (rows: Row[]) =>
      Object.fromEntries(
        rows
          .filter((r) => Object.values(TXN_BY_CATEGORY).includes(r.transaction_id as string))
          .map((r) => [r.transaction_id, 'category_name' in r ? r.category_name : '<absent>'])
      );
    const cachePicked = pick(cache.transactions as Row[]);
    expect(cachePicked).toEqual(pick(live.transactions as Row[]));
    expect(cachePicked).toEqual(
      Object.fromEntries(
        ALL_IDS.map((id) => [TXN_BY_CATEGORY[id], EXPECTED_NAME[id] ?? '<absent>'])
      )
    );
  });
});
