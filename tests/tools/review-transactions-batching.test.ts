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
import type { EditTransactionResponse } from '../../src/core/graphql/transactions.js';

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
            name: 'Coffee Shop',
            categoryId: 'c',
            userNotes: null,
            isReviewed: true,
            type: 'REGULAR',
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
            name: 'Coffee Shop',
            categoryId: 'c',
            userNotes: null,
            isReviewed: true,
            type: 'REGULAR',
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
            name: 'Coffee Shop',
            categoryId: 'c',
            userNotes: null,
            isReviewed: vars.input.isReviewed,
            type: 'REGULAR',
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
      mutate: mock(async (_op: string, _query: string, vars: unknown): Promise<unknown> => {
        inflight++;
        totalCalls++;
        maxConcurrent = Math.max(maxConcurrent, inflight);
        samples.push(inflight);
        try {
          await new Promise((r) => setTimeout(r, delayMs));
          const v = vars as { id: string; input: { isReviewed: boolean } };
          const response: EditTransactionResponse = {
            editTransaction: {
              transaction: {
                id: v.id,
                name: 'Coffee Shop',
                categoryId: 'c',
                userNotes: null,
                isReviewed: v.input.isReviewed,
                type: 'REGULAR',
                tags: [],
              },
            },
          };
          return response;
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
              type: 'REGULAR',
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

describe('review_transactions rows mode (out-of-window bypass)', () => {
  const echoClient = () =>
    createMockGraphQLClient({
      EditTransaction: (vars: any) => ({
        editTransaction: {
          transaction: {
            id: vars.id,
            name: 'Old Row',
            categoryId: 'c',
            userNotes: null,
            isReviewed: vars.input.isReviewed,
            type: 'REGULAR',
            tags: [],
          },
        },
      }),
    });

  test('rows dispatch with the caller-supplied routing ids, skipping local resolution', async () => {
    // Empty cache: id-based resolution would reject both rows. The rows
    // entries carry the routing ids directly (from a live read), so the
    // writes go out anyway — the out-of-window bulk path.
    const db = makeMockDb([]);
    const client = echoClient();
    const tools = new CopilotMoneyTools(db, client);

    const result = await tools.reviewTransactions({
      rows: [
        { transaction_id: 'old-1', account_id: 'acctA', item_id: 'itemA' },
        { transaction_id: 'old-2', account_id: 'acctB', item_id: 'itemB' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.reviewed_count).toBe(2);
    expect(result.transaction_ids).toEqual(['old-1', 'old-2']);

    expect(client._calls).toHaveLength(2);
    const byId = new Map(client._calls.map((c) => [(c.variables as any).id, c.variables as any]));
    expect(byId.get('old-1')).toMatchObject({
      accountId: 'acctA',
      itemId: 'itemA',
      input: { isReviewed: true },
    });
    expect(byId.get('old-2')).toMatchObject({
      accountId: 'acctB',
      itemId: 'itemB',
      input: { isReviewed: true },
    });
  });

  test('large rows batch issues one call per row through the shared worker loop', async () => {
    const db = makeMockDb([]);
    const client = echoClient();
    const tools = new CopilotMoneyTools(db, client);

    const rows = Array.from({ length: 25 }, (_, i) => ({
      transaction_id: `old-${String(i).padStart(2, '0')}`,
      account_id: 'acctA',
      item_id: 'itemA',
    }));
    const result = await tools.reviewTransactions({ rows, reviewed: false });

    expect(result.reviewed_count).toBe(25);
    expect(result.transaction_ids).toEqual(rows.map((r) => r.transaction_id));
    expect(client._calls).toHaveLength(25);
    const calledIds = client._calls.map((c) => (c.variables as any).id).sort();
    expect(calledIds).toEqual(rows.map((r) => r.transaction_id).sort());
  });

  test('rows win when both modes are passed', async () => {
    // 'ghost' is unresolvable, which would reject the transaction_ids path —
    // proving the rows path took precedence.
    const db = makeMockDb([]);
    const client = echoClient();
    const tools = new CopilotMoneyTools(db, client);

    const result = await tools.reviewTransactions({
      transaction_ids: ['ghost'],
      rows: [{ transaction_id: 'old-1', account_id: 'acctA', item_id: 'itemA' }],
    });

    expect(result.transaction_ids).toEqual(['old-1']);
    expect(client._calls).toHaveLength(1);
  });

  test('explicitly-passed empty rows: rows-shaped error, no fall-through to transaction_ids', async () => {
    // Passing rows selects the bypass mode; an empty array must not silently
    // degrade into the transaction_ids path (whose error would misleadingly
    // talk about transaction_ids).
    const db = makeMockDb(['txn-1']);
    const client = echoClient();
    const tools = new CopilotMoneyTools(db, client);

    await expect(
      tools.reviewTransactions({ rows: [], transaction_ids: ['txn-1'] })
    ).rejects.toThrow(/rows must be a non-empty array.*omit it to use transaction_ids/);
    await expect(tools.reviewTransactions({ rows: [] })).rejects.toThrow(
      /rows must be a non-empty array/
    );
    expect(client._calls).toHaveLength(0);
  });

  test('neither transaction_ids nor rows: mode error names both options, no write', async () => {
    const db = makeMockDb([]);
    const client = echoClient();
    const tools = new CopilotMoneyTools(db, client);

    await expect(tools.reviewTransactions({})).rejects.toThrow(
      /transaction_ids must be a non-empty array.*rows array of \{transaction_id, account_id, item_id\}/
    );
    expect(client._calls).toHaveLength(0);
  });

  test('invalid doc id in a row throws before any write', async () => {
    const db = makeMockDb([]);
    const client = echoClient();
    const tools = new CopilotMoneyTools(db, client);

    await expect(
      tools.reviewTransactions({
        rows: [{ transaction_id: 'old-1', account_id: 'bad/acct', item_id: 'itemA' }],
      })
    ).rejects.toThrow(/Invalid account_id/);
    expect(client._calls).toHaveLength(0);
  });

  test('cache-only path still resolves locally and its not-found error points at rows', async () => {
    const db = makeMockDb(['txn-1']);
    const client = echoClient();
    const tools = new CopilotMoneyTools(db, client);

    await expect(
      tools.reviewTransactions({ transaction_ids: ['txn-1', 'gone-1'] })
    ).rejects.toThrow(/Transaction not found: gone-1.*'rows' array/);
    expect(client._calls).toHaveLength(0);
  });
});
