/**
 * Tests for live-fallback resolution in write methods.
 *
 * When a transaction is not in the local LevelDB cache (>30-day window),
 * write methods should fall back to the live window cache before failing.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';
import type { TransactionNode } from '../../src/core/graphql/queries/transactions.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';

function makeLiveNode(overrides: Partial<TransactionNode> = {}): TransactionNode {
  return {
    id: 'txn-live-1',
    accountId: 'acct-live',
    itemId: 'item-live',
    categoryId: 'cat1',
    recurringId: null,
    parentId: null,
    isReviewed: false,
    isPending: false,
    amount: 42.5,
    date: '2025-11-15',
    name: 'Old Purchase',
    type: 'REGULAR',
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    isoCurrencyCode: 'USD',
    createdAt: 1700000000,
    tags: [],
    goal: null,
    ...overrides,
  };
}

function makeDb(): CopilotDatabase {
  const db = new CopilotDatabase('/fake');
  (db as any)._allCollectionsLoaded = true;
  (db as any)._cacheLoadedAt = Date.now();
  (db as any)._transactions = [];
  (db as any)._userCategories = [{ category_id: 'cat1', name: 'Food' }];
  (db as any)._tags = [];
  return db;
}

function makeLive(gqlClient?: GraphQLClient): LiveCopilotDatabase {
  const client =
    gqlClient ??
    ({
      mutate: () => Promise.resolve({}),
      query: () => Promise.resolve({}),
    } as unknown as GraphQLClient);
  return new LiveCopilotDatabase(client, new CopilotDatabase('/fake'));
}

describe('updateTransaction — live fallback', () => {
  let db: CopilotDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  test('resolves from live window cache when local misses', async () => {
    const editClient = createMockGraphQLClient({
      EditTransaction: {
        editTransaction: {
          transaction: {
            id: 'txn-live-1',
            categoryId: 'cat1',
            userNotes: 'updated',
            isReviewed: false,
            tags: [],
          },
        },
      },
    });

    const liveDb = makeLive(editClient);
    liveDb.getTransactionsWindowCache().ingestMonth('2025-11', [makeLiveNode()], Date.now());

    const tools = new CopilotMoneyTools(db, editClient, liveDb);
    const result = await tools.updateTransaction({
      transaction_id: 'txn-live-1',
      note: 'updated',
    });

    expect(result.success).toBe(true);
    expect(result.transaction_id).toBe('txn-live-1');
    expect(editClient._calls[0].variables).toMatchObject({
      id: 'txn-live-1',
      accountId: 'acct-live',
      itemId: 'item-live',
    });
  });

  test('uses local cache when available (no fallback)', async () => {
    (db as any)._transactions = [
      {
        transaction_id: 'txn-local',
        amount: 10,
        date: '2026-05-01',
        name: 'Local Coffee',
        category_id: 'cat1',
        account_id: 'acct-local',
        item_id: 'item-local',
      },
    ];

    const editClient = createMockGraphQLClient({
      EditTransaction: {
        editTransaction: {
          transaction: {
            id: 'txn-local',
            categoryId: 'cat1',
            userNotes: 'note',
            isReviewed: false,
            tags: [],
          },
        },
      },
    });

    const liveDb = makeLive(editClient);
    const tools = new CopilotMoneyTools(db, editClient, liveDb);
    const result = await tools.updateTransaction({
      transaction_id: 'txn-local',
      note: 'note',
    });

    expect(result.success).toBe(true);
    expect(editClient._calls[0].variables).toMatchObject({
      accountId: 'acct-local',
      itemId: 'item-local',
    });
  });

  test('throws when --live-reads is off and local cache misses', async () => {
    const editClient = createMockGraphQLClient({});
    const tools = new CopilotMoneyTools(db, editClient);

    await expect(
      tools.updateTransaction({ transaction_id: 'txn-gone', note: 'x' })
    ).rejects.toThrow('Transaction not found: txn-gone');
  });
});

describe('reviewTransactions — live fallback', () => {
  let db: CopilotDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  test('batch resolves mix of local + live', async () => {
    (db as any)._transactions = [
      {
        transaction_id: 'txn-local-1',
        amount: 10,
        date: '2026-05-01',
        name: 'Local',
        category_id: 'cat1',
        account_id: 'acct-local',
        item_id: 'item-local',
        user_reviewed: false,
      },
    ];

    const editClient = createMockGraphQLClient({
      EditTransaction: (vars: any) => ({
        editTransaction: {
          transaction: {
            id: vars.id,
            categoryId: 'cat1',
            userNotes: null,
            isReviewed: true,
            tags: [],
          },
        },
      }),
    });

    const liveDb = makeLive(editClient);
    liveDb
      .getTransactionsWindowCache()
      .ingestMonth(
        '2025-11',
        [makeLiveNode({ id: 'txn-live-2', accountId: 'acct-live-2', itemId: 'item-live-2' })],
        Date.now()
      );

    const tools = new CopilotMoneyTools(db, editClient, liveDb);
    const result = await tools.reviewTransactions({
      transaction_ids: ['txn-local-1', 'txn-live-2'],
    });

    expect(result.success).toBe(true);
    expect(result.reviewed_count).toBe(2);

    const localCall = editClient._calls.find((c: any) => c.variables.id === 'txn-local-1');
    const liveCall = editClient._calls.find((c: any) => c.variables.id === 'txn-live-2');
    expect(localCall!.variables).toMatchObject({ accountId: 'acct-local', itemId: 'item-local' });
    expect(liveCall!.variables).toMatchObject({ accountId: 'acct-live-2', itemId: 'item-live-2' });
  });

  test('throws listing missing IDs when --live-reads is off', async () => {
    const editClient = createMockGraphQLClient({});
    const tools = new CopilotMoneyTools(db, editClient);

    await expect(
      tools.reviewTransactions({ transaction_ids: ['miss-1', 'miss-2'] })
    ).rejects.toThrow('Transactions not found: miss-1, miss-2');
  });
});

describe('createRecurring — live fallback', () => {
  test('resolves from live window cache', async () => {
    const db = makeDb();
    const gqlClient = createMockGraphQLClient({
      CreateRecurring: {
        createRecurring: {
          id: 'rec-new',
          name: 'Old Purchase',
          state: 'ACTIVE',
          frequency: 'MONTHLY',
        },
      },
    });

    const liveDb = makeLive(gqlClient);
    liveDb.getTransactionsWindowCache().ingestMonth('2025-11', [makeLiveNode()], Date.now());

    const tools = new CopilotMoneyTools(db, gqlClient, liveDb);
    const result = await tools.createRecurring({
      transaction_id: 'txn-live-1',
      frequency: 'MONTHLY',
    });

    expect(result.success).toBe(true);
    expect(result.recurring_id).toBe('rec-new');
    expect(gqlClient._calls[0].variables).toMatchObject({
      input: {
        transaction: {
          accountId: 'acct-live',
          itemId: 'item-live',
          transactionId: 'txn-live-1',
        },
      },
    });
  });
});

describe('splitTransaction — live fallback', () => {
  test('resolves parent from live window cache', async () => {
    const db = makeDb();
    const node = makeLiveNode({ amount: 100 });
    const gqlClient = createMockGraphQLClient({
      SplitTransaction: {
        splitTransaction: {
          parentTransaction: {
            id: 'txn-live-1',
            amount: 100,
            date: '2025-11-15',
            name: 'Old Purchase',
            accountId: 'acct-live',
            itemId: 'item-live',
            categoryId: 'cat1',
            isPending: false,
            isReviewed: false,
            userNotes: null,
            recurringId: null,
            tags: [],
            type: 'REGULAR',
          },
          splitTransactions: [
            {
              id: 'split-1',
              amount: 60,
              date: '2025-11-15',
              name: 'Old Purchase',
              accountId: 'acct-live',
              itemId: 'item-live',
              categoryId: 'cat1',
              isPending: false,
              isReviewed: false,
              userNotes: null,
              recurringId: null,
              tags: [],
              type: 'REGULAR',
            },
            {
              id: 'split-2',
              amount: 40,
              date: '2025-11-15',
              name: 'Old Purchase',
              accountId: 'acct-live',
              itemId: 'item-live',
              categoryId: 'cat1',
              isPending: false,
              isReviewed: false,
              userNotes: null,
              recurringId: null,
              tags: [],
              type: 'REGULAR',
            },
          ],
        },
      },
    });

    const liveDb = makeLive(gqlClient);
    liveDb.getTransactionsWindowCache().ingestMonth('2025-11', [node], Date.now());

    const tools = new CopilotMoneyTools(db, gqlClient, liveDb);
    const result = await tools.splitTransaction({
      transaction_id: 'txn-live-1',
      account_id: 'acct-live',
      item_id: 'item-live',
      splits: [
        { amount: 60, category_id: 'cat1' },
        { amount: 40, category_id: 'cat1' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.child_transaction_ids).toEqual(['split-1', 'split-2']);
  });
});
