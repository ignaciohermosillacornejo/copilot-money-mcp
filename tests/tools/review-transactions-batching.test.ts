/**
 * Tests for review_transactions behavior over the GraphQL path.
 *
 * The current implementation issues one EditTransaction mutation per
 * transaction (sequential await loop). This file verifies:
 *  - one GraphQL call is issued per transaction ID
 *  - calls happen in input order
 *  - each call carries the right accountId/itemId from the local cache
 *  - result shape matches the input
 *
 * (Historically this file tested a concurrent batch cap; the current
 * implementation is sequential, which trivially respects any concurrency cap.)
 */

import { describe, test, expect } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';

function makeMockDb(txnIds: string[]): CopilotDatabase {
  const db = new CopilotDatabase('/nonexistent');
  (db as any)._allCollectionsLoaded = true;

  const transactions = txnIds.map((id) => ({
    transaction_id: id,
    item_id: 'item1',
    account_id: 'acct1',
    amount: 10,
    date: '2024-01-01',
    name: `Txn ${id}`,
    user_reviewed: false,
  }));
  (db as any).getAllTransactions = async () => transactions;
  (db as any).clearCache = () => {};

  return db;
}

describe('review_transactions dispatches one EditTransaction per id', () => {
  test('single transaction', async () => {
    const db = makeMockDb(['txn-1']);
    const client = createMockGraphQLClient({
      EditTransaction: {
        editTransaction: {
          transaction: {
            id: 'txn-1',
            categoryId: 'c',
            userNotes: null,
            isReviewed: true,
            tags: [],
          },
        },
      },
    });
    const tools = new CopilotMoneyTools(db, client);

    const result = await tools.reviewTransactions({ transaction_ids: ['txn-1'] });
    expect(result.success).toBe(true);
    expect(result.reviewed_count).toBe(1);
    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('EditTransaction');
    expect(client._calls[0].variables).toMatchObject({
      id: 'txn-1',
      accountId: 'acct1',
      itemId: 'item1',
      input: { isReviewed: true },
    });
  });

  test('batch of 25 issues one call per id, preserving order', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `txn-${String(i).padStart(2, '0')}`);
    const db = makeMockDb(ids);
    const client = createMockGraphQLClient({
      EditTransaction: (vars: any) => ({
        editTransaction: {
          transaction: {
            id: vars.id,
            categoryId: 'c',
            userNotes: null,
            isReviewed: true,
            tags: [],
          },
        },
      }),
    });
    const tools = new CopilotMoneyTools(db, client);

    const result = await tools.reviewTransactions({ transaction_ids: ids });
    expect(result.success).toBe(true);
    expect(result.reviewed_count).toBe(25);
    expect(result.transaction_ids).toEqual(ids);

    expect(client._calls).toHaveLength(25);
    expect(client._calls.map((c) => (c.variables as any).id)).toEqual(ids);
  });

  test('passes reviewed=false through as isReviewed=false', async () => {
    const db = makeMockDb(['a', 'b']);
    const client = createMockGraphQLClient({
      EditTransaction: (vars: any) => ({
        editTransaction: {
          transaction: {
            id: vars.id,
            categoryId: 'c',
            userNotes: null,
            isReviewed: vars.input.isReviewed,
            tags: [],
          },
        },
      }),
    });
    const tools = new CopilotMoneyTools(db, client);

    await tools.reviewTransactions({ transaction_ids: ['a', 'b'], reviewed: false });
    expect(client._calls.every((c) => (c.variables as any).input.isReviewed === false)).toBe(true);
  });
});
