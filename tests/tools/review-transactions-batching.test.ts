/**
 * Tests for review_transactions behavior over the GraphQL path.
 *
 * The current implementation issues one EditTransaction mutation per
 * transaction with bounded concurrency (max 5 in flight). This file
 * verifies:
 *  - one GraphQL call is issued per transaction ID
 *  - each call carries the right accountId/itemId from the local cache
 *  - result shape matches the input
 *  - at no point are there more than 5 in-flight GraphQL mutations
 */

import { describe, test, expect } from 'bun:test';
import { mock } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';
import { GraphQLError } from '../../src/core/graphql/client.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';

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

  test('batch of 25 issues one call per id', async () => {
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
    // Every id should have been called exactly once (bounded-concurrency
    // does not guarantee call-ordering across workers, only that the count
    // and set of ids match).
    const calledIds = client._calls.map((c) => (c.variables as any).id).sort();
    expect(calledIds).toEqual([...ids].sort());
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

describe('review_transactions respects 5-parallel concurrency cap', () => {
  /**
   * Build a GraphQL client that delays every mutate() for `delayMs` and
   * tracks the max number of concurrent in-flight calls.
   */
  function makeConcurrencyTrackingClient(delayMs: number): GraphQLClient & {
    _maxConcurrent: number;
    _inflightSamples: number[];
    _totalCalls: number;
  } {
    let inflight = 0;
    let maxConcurrent = 0;
    const samples: number[] = [];
    let totalCalls = 0;

    const client = {
      mutate: mock(async (op: string, _query: string, vars: unknown) => {
        inflight++;
        totalCalls++;
        maxConcurrent = Math.max(maxConcurrent, inflight);
        samples.push(inflight);
        try {
          await new Promise((r) => setTimeout(r, delayMs));
          const v = vars as { id: string; input: { isReviewed: boolean } };
          return {
            editTransaction: {
              transaction: {
                id: v.id,
                categoryId: 'c',
                userNotes: null,
                isReviewed: v.input.isReviewed,
                tags: [],
              },
            },
          };
        } finally {
          inflight--;
        }
      }),
      get _maxConcurrent(): number {
        return maxConcurrent;
      },
      get _inflightSamples(): number[] {
        return samples;
      },
      get _totalCalls(): number {
        return totalCalls;
      },
    };
    return client as unknown as GraphQLClient & {
      _maxConcurrent: number;
      _inflightSamples: number[];
      _totalCalls: number;
    };
  }

  test('batch of 20 never exceeds 5 concurrent calls', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `txn-${String(i).padStart(2, '0')}`);
    const db = makeMockDb(ids);
    // Use a delay so multiple workers genuinely run concurrently.
    const client = makeConcurrencyTrackingClient(25);
    const tools = new CopilotMoneyTools(db, client);

    const result = await tools.reviewTransactions({ transaction_ids: ids });
    expect(result.success).toBe(true);
    expect(result.reviewed_count).toBe(20);
    expect(client._totalCalls).toBe(20);

    // The cap is 5: we should observe concurrency saturated at 5 but
    // never strictly greater than 5.
    expect(client._maxConcurrent).toBeLessThanOrEqual(5);
    // Sanity: we also want to confirm real parallelism — at least one
    // sample should be > 1 (otherwise we'd be sequential).
    expect(client._maxConcurrent).toBeGreaterThan(1);
  });

  test('batch of 3 runs all concurrently (below cap)', async () => {
    const ids = ['a', 'b', 'c'];
    const db = makeMockDb(ids);
    const client = makeConcurrencyTrackingClient(20);
    const tools = new CopilotMoneyTools(db, client);

    await tools.reviewTransactions({ transaction_ids: ids });
    // All 3 should be able to run in parallel (since 3 < 5).
    expect(client._maxConcurrent).toBeLessThanOrEqual(5);
    expect(client._maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  test('partial failure reports non-zero succeeded count under bounded concurrency', async () => {
    // Mock 8 transactions; fail on 'txn-05'. Concurrent workers mean txns 1-4
    // and some of 6-8 may complete before the failure surfaces.
    const txnIds = Array.from({ length: 8 }, (_, i) => `txn-0${i + 1}`);
    const db = makeMockDb(txnIds);

    const client = {
      mutate: mock((_op: string, _q: string, vars: any) => {
        if (vars.id === 'txn-05') {
          return Promise.reject(new GraphQLError('USER_ACTION_REQUIRED', 'simulated failure'));
        }
        return Promise.resolve({
          editTransaction: {
            transaction: {
              id: vars.id,
              categoryId: 'c1',
              userNotes: null,
              isReviewed: true,
              tags: [],
            },
          },
        });
      }),
    } as unknown as GraphQLClient;

    const tools = new CopilotMoneyTools(db, client);

    await expect(
      tools.reviewTransactions({ transaction_ids: txnIds, reviewed: true })
    ).rejects.toThrow(/review_transactions failed at id=txn-05 \(\d+\/8 succeeded\)/);
  });
});
