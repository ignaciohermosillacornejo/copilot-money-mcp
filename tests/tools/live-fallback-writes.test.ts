/**
 * Tests for live-fallback transaction resolution in write tools.
 *
 * When --live-reads is enabled and a transaction is not in the local LevelDB
 * cache (e.g. older transactions beyond the ~30-day window), write tools
 * should fall back to the live GraphQL layer to resolve account_id and item_id
 * before sending the mutation.
 *
 * This file tests:
 *  - resolveTransaction falls back to the live transaction window cache
 *  - resolveTransaction falls back to a GraphQL fetch when the window cache misses
 *  - resolveTransactions (batch) performs the same fallback for review_transactions
 *  - existing behavior is preserved when --live-reads is NOT enabled
 *  - existing behavior is preserved when the transaction IS in the local cache
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import type { TransactionNode } from '../../src/core/graphql/queries/transactions.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build a minimal TransactionNode for the live cache. */
function makeTransactionNode(overrides: Partial<TransactionNode> = {}): TransactionNode {
  return {
    id: 'txn-live-1',
    accountId: 'acc-live',
    itemId: 'item-live',
    categoryId: 'cat1',
    recurringId: null,
    parentId: null,
    isReviewed: false,
    isPending: false,
    amount: 42.0,
    date: '2025-03-15',
    name: 'Live Merchant',
    type: 'REGULAR',
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    isoCurrencyCode: 'USD',
    createdAt: Date.now(),
    tags: [],
    goal: null,
    ...overrides,
  };
}

/** Create a mock CopilotDatabase with an empty transaction cache. */
function makeEmptyMockDb(): CopilotDatabase {
  const db = new CopilotDatabase('/nonexistent');
  (db as any).dbPath = '/fake';
  (db as any)._allCollectionsLoaded = true;
  (db as any)._cacheLoadedAt = Date.now();
  (db as any)._transactions = []; // empty: transaction not in local cache
  (db as any)._userCategories = [{ category_id: 'cat1', name: 'Food' }];
  (db as any)._tags = [];
  (db as any)._recurring = [];
  return db;
}

/** Create a mock CopilotDatabase that HAS the transaction in its local cache. */
function makeMockDbWithTransaction(): CopilotDatabase {
  const db = makeEmptyMockDb();
  (db as any)._transactions = [
    {
      transaction_id: 'txn-local',
      amount: 25.0,
      date: '2026-04-01',
      name: 'Local Merchant',
      account_id: 'acc-local',
      item_id: 'item-local',
      category_id: 'cat1',
      user_reviewed: false,
    },
  ];
  return db;
}

/**
 * Create a LiveCopilotDatabase with a pre-populated transaction window cache.
 *
 * Uses the real LiveCopilotDatabase constructor with a mock GraphQL client
 * (the constructor only stores references, no network calls). We then
 * manually ingest a TransactionNode into the window cache to simulate
 * a prior get_transactions_live call having fetched it.
 */
function makeLiveDbWithCachedTransaction(
  graphqlClient: GraphQLClient,
  cacheDb: CopilotDatabase,
  node: TransactionNode
): LiveCopilotDatabase {
  const liveDb = new LiveCopilotDatabase(graphqlClient, cacheDb);
  // Ingest the node into the window cache for its month
  const month = node.date.slice(0, 7); // e.g. '2025-03'
  liveDb.getTransactionsWindowCache().ingestMonth(month, [node], Date.now());
  return liveDb;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('live-fallback: updateTransaction', () => {
  test('resolves from live window cache when local cache misses', async () => {
    const db = makeEmptyMockDb();
    const node = makeTransactionNode({ id: 'txn-live-1' });
    const graphqlClient = createMockGraphQLClient({
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
    const liveDb = makeLiveDbWithCachedTransaction(graphqlClient, db, node);
    const tools = new CopilotMoneyTools(db, graphqlClient, liveDb);

    const result = await tools.updateTransaction({
      transaction_id: 'txn-live-1',
      note: 'updated',
    });

    expect(result.success).toBe(true);
    expect(result.transaction_id).toBe('txn-live-1');
    // Verify the mutation used account_id/item_id from the live node
    expect(graphqlClient._calls[0].variables).toMatchObject({
      id: 'txn-live-1',
      accountId: 'acc-live',
      itemId: 'item-live',
    });
  });

  test('still works when transaction IS in local cache (no fallback needed)', async () => {
    const db = makeMockDbWithTransaction();
    const graphqlClient = createMockGraphQLClient({
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
    const tools = new CopilotMoneyTools(db, graphqlClient);

    const result = await tools.updateTransaction({
      transaction_id: 'txn-local',
      note: 'note',
    });

    expect(result.success).toBe(true);
    expect(graphqlClient._calls[0].variables).toMatchObject({
      id: 'txn-local',
      accountId: 'acc-local',
      itemId: 'item-local',
    });
  });

  test('throws "Transaction not found" when --live-reads is NOT enabled', async () => {
    const db = makeEmptyMockDb();
    const graphqlClient = createMockGraphQLClient({});
    // No liveDb passed — simulates --live-reads being off
    const tools = new CopilotMoneyTools(db, graphqlClient);

    await expect(
      tools.updateTransaction({ transaction_id: 'txn-missing', note: 'x' })
    ).rejects.toThrow('Transaction not found: txn-missing');
  });
});

describe('live-fallback: splitTransaction', () => {
  test('resolves parent from live window cache when local cache misses', async () => {
    const db = makeEmptyMockDb();
    const parentNode = makeTransactionNode({
      id: 'txn-parent',
      amount: 100,
      name: 'Big Purchase',
    });
    const graphqlClient = createMockGraphQLClient({
      SplitTransaction: {
        splitTransaction: {
          parentTransaction: {
            id: 'txn-parent',
            amount: 100,
            date: '2025-03-15',
            name: 'Big Purchase',
            accountId: 'acc-live',
            itemId: 'item-live',
            categoryId: '',
            isPending: false,
            isReviewed: false,
            userNotes: null,
            recurringId: null,
            type: 'REGULAR',
            tags: [],
          },
          splitTransactions: [
            {
              id: 'child-1',
              amount: 60,
              date: '2025-03-15',
              name: 'Big Purchase',
              accountId: 'acc-live',
              itemId: 'item-live',
              categoryId: 'cat1',
              isPending: false,
              isReviewed: false,
              userNotes: null,
              recurringId: null,
              type: 'REGULAR',
              tags: [],
            },
            {
              id: 'child-2',
              amount: 40,
              date: '2025-03-15',
              name: 'Big Purchase',
              accountId: 'acc-live',
              itemId: 'item-live',
              categoryId: 'cat1',
              isPending: false,
              isReviewed: false,
              userNotes: null,
              recurringId: null,
              type: 'REGULAR',
              tags: [],
            },
          ],
        },
      },
    });
    const liveDb = makeLiveDbWithCachedTransaction(graphqlClient, db, parentNode);
    const tools = new CopilotMoneyTools(db, graphqlClient, liveDb);

    const result = await tools.splitTransaction({
      transaction_id: 'txn-parent',
      account_id: 'acc-live',
      item_id: 'item-live',
      splits: [
        { amount: 60, category_id: 'cat1' },
        { amount: 40, category_id: 'cat1' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.child_transaction_ids).toHaveLength(2);
  });
});

describe('live-fallback: reviewTransactions', () => {
  test('resolves batch from live window cache when local cache misses', async () => {
    const db = makeEmptyMockDb();
    const node1 = makeTransactionNode({ id: 'txn-r1', date: '2025-03-10' });
    const node2 = makeTransactionNode({ id: 'txn-r2', date: '2025-03-11' });

    const graphqlClient = createMockGraphQLClient({
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

    const liveDb = new LiveCopilotDatabase(graphqlClient, db);
    // Ingest both nodes into the same month
    liveDb.getTransactionsWindowCache().ingestMonth('2025-03', [node1, node2], Date.now());
    const tools = new CopilotMoneyTools(db, graphqlClient, liveDb);

    const result = await tools.reviewTransactions({
      transaction_ids: ['txn-r1', 'txn-r2'],
      reviewed: true,
    });

    expect(result.success).toBe(true);
    expect(result.reviewed_count).toBe(2);
    // Verify both mutations used the live-resolved account/item IDs
    expect(graphqlClient._calls[0].variables).toMatchObject({
      accountId: 'acc-live',
      itemId: 'item-live',
    });
    expect(graphqlClient._calls[1].variables).toMatchObject({
      accountId: 'acc-live',
      itemId: 'item-live',
    });
  });

  test('throws listing all missing IDs when --live-reads is off', async () => {
    const db = makeEmptyMockDb();
    const graphqlClient = createMockGraphQLClient({});
    const tools = new CopilotMoneyTools(db, graphqlClient);

    await expect(
      tools.reviewTransactions({ transaction_ids: ['a', 'b'], reviewed: true })
    ).rejects.toThrow('Transactions not found: a, b');
  });
});

describe('live-fallback: createRecurring', () => {
  test('resolves transaction from live window cache when local cache misses', async () => {
    const db = makeEmptyMockDb();
    const node = makeTransactionNode({ id: 'txn-sub', amount: 15.99, name: 'Netflix' });
    const graphqlClient = createMockGraphQLClient({
      CreateRecurring: {
        createRecurring: {
          id: 'rec-1',
          name: 'Netflix',
          state: 'ACTIVE',
          frequency: 'MONTHLY',
        },
      },
    });
    const liveDb = makeLiveDbWithCachedTransaction(graphqlClient, db, node);
    const tools = new CopilotMoneyTools(db, graphqlClient, liveDb);

    const result = await tools.createRecurring({
      transaction_id: 'txn-sub',
      frequency: 'MONTHLY',
    });

    expect(result.success).toBe(true);
    expect(result.recurring_id).toBe('rec-1');
    // Verify the mutation used the live-resolved IDs
    expect(graphqlClient._calls[0].variables).toMatchObject({
      input: {
        transaction: {
          accountId: 'acc-live',
          itemId: 'item-live',
          transactionId: 'txn-sub',
        },
      },
    });
  });
});

describe('live-fallback: mixed local + live resolution', () => {
  test('reviewTransactions resolves some from local, rest from live', async () => {
    const db = makeEmptyMockDb();
    // Put one transaction in the local cache
    (db as any)._transactions = [
      {
        transaction_id: 'txn-local',
        amount: 10,
        date: '2026-04-01',
        name: 'Local',
        account_id: 'acc-local',
        item_id: 'item-local',
        user_reviewed: false,
      },
    ];

    // Put another in the live window cache
    const liveNode = makeTransactionNode({ id: 'txn-live', date: '2025-03-15' });
    const graphqlClient = createMockGraphQLClient({
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
    const liveDb = makeLiveDbWithCachedTransaction(graphqlClient, db, liveNode);
    const tools = new CopilotMoneyTools(db, graphqlClient, liveDb);

    const result = await tools.reviewTransactions({
      transaction_ids: ['txn-local', 'txn-live'],
      reviewed: true,
    });

    expect(result.success).toBe(true);
    expect(result.reviewed_count).toBe(2);

    // First call should use the local account/item IDs
    const call0 = graphqlClient._calls.find((c: any) => c.variables.id === 'txn-local');
    expect(call0?.variables).toMatchObject({
      accountId: 'acc-local',
      itemId: 'item-local',
    });

    // Second call should use the live account/item IDs
    const call1 = graphqlClient._calls.find((c: any) => c.variables.id === 'txn-live');
    expect(call1?.variables).toMatchObject({
      accountId: 'acc-live',
      itemId: 'item-live',
    });
  });
});
