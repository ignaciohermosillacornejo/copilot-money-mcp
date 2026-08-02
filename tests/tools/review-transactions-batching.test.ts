/**
 * Tests for review_transactions over the GraphQL path.
 *
 * The tool now issues ONE `bulkEditTransactions` mutation for the whole set
 * (Copilot's native bulk endpoint) instead of a bounded fan-out of
 * `editTransaction` calls. The properties that matter:
 *  - exactly one GraphQL call, whatever the batch size
 *  - every id reaches the server in `filter.ids` with its routing triple
 *  - `filter` carries ONLY `ids` — any other TransactionFilter key would widen
 *    the row set, and `filter` is nullable server-side, so this is the whole
 *    safety story
 *  - rows-mode routing is passed through verbatim
 *  - a silently-skipped id (the server drops unknown ids without erroring)
 *    fails the call rather than reporting a clean success
 *  - the optimistic cache patch reflects only rows the server confirmed
 */

import { describe, test, expect } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';
import { GraphQLError } from '../../src/core/graphql/client.js';
import type { BulkEditTransactionsResponse } from '../../src/core/graphql/transactions.js';

function txnPayload(id: string, isReviewed = true) {
  return {
    id,
    name: `Txn ${id}`,
    categoryId: 'c',
    userNotes: null,
    isReviewed,
    type: 'REGULAR' as const,
    date: '2024-01-01',
    amount: 50,
    tags: [],
  };
}

/** Echo every requested id back as updated — the all-succeeded server case. */
function echoBulk(vars: unknown): BulkEditTransactionsResponse {
  const v = vars as { filter: { ids: { id: string }[] }; input: { isReviewed?: boolean } };
  return {
    bulkEditTransactions: {
      updated: v.filter.ids.map((t) => txnPayload(t.id, v.input.isReviewed ?? true)),
      failed: [],
    },
  };
}

const echoClient = () => createMockGraphQLClient({ BulkEditTransactions: echoBulk });

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

describe('review_transactions issues ONE bulk call for the whole set', () => {
  test('single transaction', async () => {
    const db = makeMockDb(['txn-1']);
    const client = echoClient();
    const tools = new CopilotMoneyTools(db, client);

    const result = await tools.reviewTransactions({ transaction_ids: ['txn-1'] });

    expect(result.success).toBe(true);
    expect(result.reviewed_count).toBe(1);
    expect(result.transaction_ids).toEqual(['txn-1']);
    expect(client._calls).toHaveLength(1);
    expect(client._calls[0]!.op).toBe('BulkEditTransactions');
    expect(client._calls[0]!.variables).toEqual({
      input: { isReviewed: true },
      filter: { ids: [{ id: 'txn-1', accountId: 'acct1', itemId: 'item1' }] },
    });
  });

  test('batch of 25 is still exactly one call carrying all 25 ids', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `txn-${String(i).padStart(2, '0')}`);
    const db = makeMockDb(ids);
    const client = echoClient();
    const tools = new CopilotMoneyTools(db, client);

    const result = await tools.reviewTransactions({ transaction_ids: ids });

    expect(result.reviewed_count).toBe(25);
    // The headline property: turn count and round trips are both 1.
    expect(client._calls).toHaveLength(1);
    const vars = client._calls[0]!.variables as { filter: { ids: { id: string }[] } };
    expect(vars.filter.ids.map((t) => t.id).sort()).toEqual([...ids].sort());
  });

  test('filter carries ONLY ids — no matchString or other widening key', async () => {
    const db = makeMockDb(['txn-1', 'txn-2']);
    const client = echoClient();
    const tools = new CopilotMoneyTools(db, client);

    await tools.reviewTransactions({ transaction_ids: ['txn-1', 'txn-2'] });

    const vars = client._calls[0]!.variables as { filter: Record<string, unknown> };
    // `filter` is nullable server-side and TransactionFilter also accepts
    // dates/categoryIds/isReviewed/types — any of which would silently widen
    // the row set beyond the ids we asked for.
    expect(Object.keys(vars.filter)).toEqual(['ids']);
  });

  test('passes reviewed=false through as isReviewed=false', async () => {
    const db = makeMockDb(['txn-1']);
    const client = echoClient();
    const tools = new CopilotMoneyTools(db, client);

    const result = await tools.reviewTransactions({
      transaction_ids: ['txn-1'],
      reviewed: false,
    });

    expect(result.reviewed_count).toBe(1);
    const vars = client._calls[0]!.variables as { input: { isReviewed: boolean } };
    expect(vars.input.isReviewed).toBe(false);
  });

  test('defaults reviewed to true when not specified', async () => {
    const db = makeMockDb(['txn-1']);
    const client = echoClient();
    const tools = new CopilotMoneyTools(db, client);

    await tools.reviewTransactions({ transaction_ids: ['txn-1'] });

    const vars = client._calls[0]!.variables as { input: { isReviewed: boolean } };
    expect(vars.input.isReviewed).toBe(true);
  });
});

describe('review_transactions surfaces server-side partial application', () => {
  test('a silently-skipped id fails the call instead of reporting success', async () => {
    // Verified live: the server drops ids it cannot find WITHOUT erroring and
    // WITHOUT a failed[] entry. If we trusted failed[] alone this batch would
    // report a clean success having written only half of it.
    const db = makeMockDb(['txn-1', 'txn-2']);
    const client = createMockGraphQLClient({
      BulkEditTransactions: {
        bulkEditTransactions: { updated: [txnPayload('txn-1')], failed: [] },
      },
    });
    const tools = new CopilotMoneyTools(db, client);

    await expect(tools.reviewTransactions({ transaction_ids: ['txn-1', 'txn-2'] })).rejects.toThrow(
      /did not apply 1 transaction\(s\)[\s\S]*txn-2/
    );
  });

  test('a failed[] entry throws, naming the row and its errorCode', async () => {
    const db = makeMockDb(['txn-1', 'txn-2']);
    const client = createMockGraphQLClient({
      BulkEditTransactions: {
        bulkEditTransactions: {
          updated: [txnPayload('txn-1')],
          failed: [{ transaction: { id: 'txn-2' }, error: 'nope', errorCode: 'SOME_CODE' }],
        },
      },
    });
    const tools = new CopilotMoneyTools(db, client);

    await expect(tools.reviewTransactions({ transaction_ids: ['txn-1', 'txn-2'] })).rejects.toThrow(
      /rejected 1 of 2[\s\S]*txn-2: SOME_CODE/
    );
  });

  test('throws on GraphQL error', async () => {
    const db = makeMockDb(['txn-1']);
    const client = createMockGraphQLClient({
      BulkEditTransactions: new GraphQLError('USER_ACTION_REQUIRED', 'session expired'),
    });
    const tools = new CopilotMoneyTools(db, client);

    await expect(tools.reviewTransactions({ transaction_ids: ['txn-1'] })).rejects.toThrow(
      /review_transactions failed/
    );
  });

  test('only server-confirmed rows are patched into the cache', async () => {
    const db = makeMockDb(['txn-1', 'txn-2']);
    const patched: string[] = [];
    (db as any).patchCachedTransaction = (id: string) => patched.push(id);
    const client = echoClient();
    const tools = new CopilotMoneyTools(db, client);

    await tools.reviewTransactions({ transaction_ids: ['txn-1', 'txn-2'] });

    expect(patched.sort()).toEqual(['txn-1', 'txn-2']);
  });
});

describe('review_transactions rows mode (out-of-window bypass)', () => {
  test('rows dispatch with the caller-supplied routing ids, skipping local resolution', async () => {
    // Empty cache: local resolution would fail for these ids.
    const db = makeMockDb([]);
    const client = echoClient();
    const tools = new CopilotMoneyTools(db, client);

    const result = await tools.reviewTransactions({
      rows: [
        { transaction_id: 'old-1', account_id: 'acctA', item_id: 'itemA' },
        { transaction_id: 'old-2', account_id: 'acctB', item_id: 'itemB' },
      ],
    });

    expect(result.reviewed_count).toBe(2);
    expect(client._calls).toHaveLength(1);
    const vars = client._calls[0]!.variables as {
      filter: { ids: { id: string; accountId: string; itemId: string }[] };
    };
    expect(vars.filter.ids).toEqual([
      { id: 'old-1', accountId: 'acctA', itemId: 'itemA' },
      { id: 'old-2', accountId: 'acctB', itemId: 'itemB' },
    ]);
  });

  test('large rows batch is still one call', async () => {
    const db = makeMockDb([]);
    const client = echoClient();
    const tools = new CopilotMoneyTools(db, client);

    const rows = Array.from({ length: 40 }, (_, i) => ({
      transaction_id: `row-${String(i).padStart(2, '0')}`,
      account_id: 'acctA',
      item_id: 'itemA',
    }));
    const result = await tools.reviewTransactions({ rows });

    expect(result.reviewed_count).toBe(40);
    expect(client._calls).toHaveLength(1);
  });

  test('rows win when both modes are passed', async () => {
    const db = makeMockDb(['txn-1']);
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
