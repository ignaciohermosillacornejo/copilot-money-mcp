/**
 * #825 "cache vs live parity" items that are behaviour, not documentation:
 *   - `fields` accepts user_note and user_notes in both modes, with no
 *     `_field_warning`, and returns the mode's own spelling;
 *   - a live uncategorized income row reports category_id null, not "";
 *   - the shared ticker comparison treats CUR:USD and USD as one ticker.
 * (The cache default row's internal_transfer default is pinned in
 * tests/tools/tools.test.ts beside the other key-count tests.)
 */

import { describe, test, expect, mock } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { LiveTransactionsTools } from '../../src/tools/live/transactions.js';
import { tickerMatches } from '../../src/utils/ticker.js';
import {
  applyFieldAliases,
  CACHE_TRANSACTION_FIELD_ALIASES,
  LIVE_TRANSACTION_FIELD_ALIASES,
} from '../../src/tools/field-selection.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import type { TransactionNode } from '../../src/core/graphql/queries/transactions.js';

const TXN = 'Nt4kW9mQ2nR7tV4xL8sP';
const RANGE = { start_date: '2026-03-01', end_date: '2026-03-31' } as const;

function cacheTools(): CopilotMoneyTools {
  const db = new CopilotDatabase('/fake/path');
  db._injectDataForTesting({
    transactions: [
      {
        transaction_id: TXN,
        amount: 20,
        date: '2026-03-10',
        name: 'SYNTHETIC',
        category_id: 'Ct7vN3tR6mW2pX9sL4dB',
        user_note: 'a note',
      },
    ],
    accounts: [],
    recurring: [],
    budgets: [],
    goals: [],
    goalHistory: [],
    investmentPrices: [],
    items: [],
    tags: [],
    userCategories: [{ category_id: 'Ct7vN3tR6mW2pX9sL4dB', name: 'Shopping', order: 0 }],
    categoryNameMap: new Map([['Ct7vN3tR6mW2pX9sL4dB', 'Shopping']]),
    accountNameMap: new Map(),
  });
  return new CopilotMoneyTools(db);
}

async function liveTools(node: Partial<TransactionNode>): Promise<LiveTransactionsTools> {
  const client = { mutate: mock(), query: mock() } as unknown as GraphQLClient;
  const cache = {
    getAccounts: mock(() => Promise.resolve([])),
    getTags: mock(() => Promise.resolve([])),
  } as unknown as CopilotDatabase;
  const live = new LiveCopilotDatabase(client, cache);
  const row = {
    id: TXN,
    accountId: 'Wn7qL3xK9mT2vR6pB4sD',
    itemId: 'Xp8rM4yL2nV7wS3qC5tF',
    categoryId: 'Ct7vN3tR6mW2pX9sL4dB',
    recurringId: null,
    parentId: null,
    isReviewed: false,
    isPending: false,
    amount: 20,
    date: '2026-03-10',
    name: 'Synthetic',
    type: 'REGULAR',
    userNotes: 'a note',
    tipAmount: null,
    suggestedCategoryIds: [],
    isoCurrencyCode: 'USD',
    createdAt: 0,
    tags: [],
    goal: null,
    ...node,
  } as TransactionNode;
  (live as unknown as { getTransactions: () => Promise<unknown> }).getTransactions = async () => ({
    rows: [row],
    oldest_fetched_at: 0,
    newest_fetched_at: 0,
    hit: true,
    dropped_invalid_rows: 0,
  });
  await live.getCategoriesCache().read(() => Promise.resolve([]));
  return new LiveTransactionsTools(live);
}

describe('note field aliases (#825)', () => {
  test.each(['user_note', 'user_notes'])(
    'cache mode accepts %s and returns user_note, warning-free',
    async (name) => {
      const result = await cacheTools().getTransactions({ ...RANGE, fields: [name] });
      expect(result._field_warning).toBeUndefined();
      expect(result.transactions[0]).toEqual({ user_note: 'a note' });
    }
  );

  test.each(['user_note', 'user_notes'])(
    'live mode accepts %s and returns user_notes, warning-free',
    async (name) => {
      const result = await (await liveTools({})).getTransactions({ ...RANGE, fields: [name] });
      expect(result._field_warning).toBeUndefined();
      expect(result.transactions[0]).toEqual({ user_notes: 'a note' });
    }
  );

  test('both spellings together name one field, once (#860 review)', () => {
    expect(
      applyFieldAliases(['user_note', 'user_notes', 'date'], CACHE_TRANSACTION_FIELD_ALIASES)
    ).toEqual(['user_note', 'date']);
    expect(applyFieldAliases(['user_notes', 'user_note'], LIVE_TRANSACTION_FIELD_ALIASES)).toEqual([
      'user_notes',
    ]);
  });

  test('a real typo still warns in both modes', async () => {
    const cache = await cacheTools().getTransactions({ ...RANGE, fields: ['user_nots'] });
    const live = await (await liveTools({})).getTransactions({ ...RANGE, fields: ['user_nots'] });
    expect(cache._field_warning).toContain('user_nots');
    expect(live._field_warning).toContain('user_nots');
  });
});

describe('live category_id normalisation (#825)', () => {
  test('an uncategorized INCOME row reports category_id null, not ""', async () => {
    const tools = await liveTools({ type: 'INCOME', amount: -20, categoryId: '' });
    const result = await tools.getTransactions({ ...RANGE, fields: ['category_id'] });
    expect(result.transactions[0]).toEqual({ category_id: null });
  });
});

describe('tickerMatches (#825, narrowed in the #860 review)', () => {
  test.each([
    ['USD', 'CUR:USD', true, true],
    ['CUR:USD', 'usd', true, true],
    ['cur:usd', 'CUR:USD', true, true],
    ['AAPL', 'aapl', false, true],
    ['USD', 'EUR', true, false],
    [null, 'USD', true, false],
    // A security (not cash) tickered USD: the bare spelling matches it, the
    // currency-prefixed one does not.
    ['USD', 'USD', false, true],
    ['USD', 'CUR:USD', false, false],
    // A non-cash security that happens to be spelled with the prefix: only an
    // exact match selects it (#860 review).
    ['CUR:USD', 'USD', false, false],
    ['CUR:USD', 'cur:usd', false, true],
  ] as const)('%p vs %p (cash: %p) -> %p', (row, filter, isCash, expected) => {
    expect(tickerMatches(row, filter, isCash)).toBe(expected);
  });
});
