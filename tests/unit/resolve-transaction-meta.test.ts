/**
 * Resolution-order tests for resolveTransactionMeta v2 (write-tool routing
 * ids). Live mode resolves: ① liveDb meta index → ② windowed live fetch →
 * ③ honest window error. LevelDB is NOT consulted when liveDb is present;
 * it remains the sole resolver in degraded mode (no liveDb).
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import type { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';

function echoEdit(vars: any) {
  return {
    editTransaction: {
      transaction: {
        id: vars.id,
        name: 'n',
        categoryId: 'c1',
        userNotes: null,
        isReviewed: vars.input.isReviewed ?? false,
        type: 'REGULAR',
        tags: [],
      },
    },
  };
}

function makeDb(transactions: unknown[] = []) {
  const db = new CopilotDatabase('/nonexistent');
  (db as any).dbPath = '/fake';
  (db as any)._transactions = transactions;
  (db as any)._userCategories = [];
  (db as any)._tags = [];
  (db as any)._goals = [];
  return db;
}

/** Stub liveDb: `indexed` backs lookupTransactionMeta; `liveRows` backs the
 *  windowed getTransactions fetch. Returns the spy so tests can assert
 *  whether the network fallback fired. */
function stubLiveDb(overrides: {
  indexed?: Record<string, { accountId: string; itemId: string }>;
  liveRows?: Array<{ id: string; accountId: string; itemId: string }>;
}) {
  const getTransactions = mock(() =>
    Promise.resolve({
      rows: overrides.liveRows ?? [],
      oldest_fetched_at: 0,
      newest_fetched_at: 0,
      hit: false,
    })
  );
  const liveDb = {
    lookupTransactionMeta: (ids: string[]) => {
      const out = new Map<string, { accountId: string; itemId: string }>();
      for (const id of ids) {
        const m = overrides.indexed?.[id];
        if (m) out.set(id, m);
      }
      return out;
    },
    getTransactions,
    patchLiveTransaction: () => {}, // no-op for tests
  } as unknown as LiveCopilotDatabase;
  return { liveDb, getTransactions };
}

const ORIGINAL_ENV = process.env.COPILOT_WRITE_RESOLVE_WINDOW_MONTHS;
beforeEach(() => {
  delete process.env.COPILOT_WRITE_RESOLVE_WINDOW_MONTHS;
});
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.COPILOT_WRITE_RESOLVE_WINDOW_MONTHS;
  else process.env.COPILOT_WRITE_RESOLVE_WINDOW_MONTHS = ORIGINAL_ENV;
});

describe('resolveTransactionMeta v2 — live mode', () => {
  test('index hit: no live fetch, mutation receives the indexed triple', async () => {
    const client = createMockGraphQLClient({ EditTransaction: echoEdit as any });
    const { liveDb, getTransactions } = stubLiveDb({
      indexed: { tA: { accountId: 'acct-1', itemId: 'item-1' } },
    });
    const tools = new CopilotMoneyTools(makeDb(), client, liveDb);

    await tools.updateTransaction({ transaction_id: 'tA', reviewed: true });

    expect(getTransactions).toHaveBeenCalledTimes(0);
    const call = client._calls.find((c) => c.op === 'EditTransaction')!;
    expect((call.variables as any).accountId).toBe('acct-1');
    expect((call.variables as any).itemId).toBe('item-1');
  });

  test('index miss: windowed fetch resolves the triple (the #498-owed test)', async () => {
    const client = createMockGraphQLClient({ EditTransaction: echoEdit as any });
    const { liveDb, getTransactions } = stubLiveDb({
      liveRows: [{ id: 'tOld', accountId: 'acct-2', itemId: 'item-2' }],
    });
    const tools = new CopilotMoneyTools(makeDb(), client, liveDb);

    await tools.updateTransaction({ transaction_id: 'tOld', reviewed: true });

    expect(getTransactions).toHaveBeenCalledTimes(1);
    const call = client._calls.find((c) => c.op === 'EditTransaction')!;
    expect((call.variables as any).accountId).toBe('acct-2');
    expect((call.variables as any).itemId).toBe('item-2');
  });

  test('LevelDB is NOT consulted in live mode', async () => {
    // The row exists in the local cache with valid ids, but liveDb knows
    // nothing about it → v2 must fail with the window error, proving the
    // local cache was skipped.
    const client = createMockGraphQLClient({});
    const { liveDb } = stubLiveDb({});
    const tools = new CopilotMoneyTools(
      makeDb([
        {
          transaction_id: 'tLocal',
          amount: 100,
          date: '2026-06-01',
          name: 'Synthetic',
          account_id: 'acct-3',
          item_id: 'item-3',
        },
      ]),
      client,
      liveDb
    );

    await expect(
      tools.updateTransaction({ transaction_id: 'tLocal', reviewed: true })
    ).rejects.toThrow(/last 13 months/);
    expect(client._calls).toHaveLength(0);
  });

  test('unresolved after fetch: honest error names the window and the env var', async () => {
    const client = createMockGraphQLClient({});
    const { liveDb } = stubLiveDb({});
    const tools = new CopilotMoneyTools(makeDb(), client, liveDb);

    await expect(
      tools.updateTransaction({ transaction_id: 'tGone', reviewed: true })
    ).rejects.toThrow(/COPILOT_WRITE_RESOLVE_WINDOW_MONTHS/);
    await expect(
      tools.updateTransaction({ transaction_id: 'tGone', reviewed: true })
    ).rejects.toThrow(/Transaction not found: tGone/);
  });

  test('bulk review: mixed index/fetch resolution, one fetch total; honest bulk error', async () => {
    const client = createMockGraphQLClient({ EditTransaction: echoEdit as any });
    const { liveDb, getTransactions } = stubLiveDb({
      indexed: { tA: { accountId: 'acct-1', itemId: 'item-1' } },
      liveRows: [{ id: 'tB', accountId: 'acct-2', itemId: 'item-2' }],
    });
    const tools = new CopilotMoneyTools(makeDb(), client, liveDb);

    const result = await tools.reviewTransactions({ transaction_ids: ['tA', 'tB'] });
    expect(result.reviewed_count).toBe(2);
    expect(getTransactions).toHaveBeenCalledTimes(1);

    const { liveDb: emptyLive } = stubLiveDb({});
    const tools2 = new CopilotMoneyTools(makeDb(), createMockGraphQLClient({}), emptyLive);
    await expect(
      tools2.reviewTransactions({ transaction_ids: ['tX', 'tY'] })
    ).rejects.toThrow(/Transactions not found: tX, tY.*last 13 months/);
  });

  test('env var override is honored; garbage/zero/negative fall back to 13', async () => {
    const client = createMockGraphQLClient({});
    const { liveDb } = stubLiveDb({});
    const tools = new CopilotMoneyTools(makeDb(), client, liveDb);

    process.env.COPILOT_WRITE_RESOLVE_WINDOW_MONTHS = '30';
    await expect(
      tools.updateTransaction({ transaction_id: 'tGone', reviewed: true })
    ).rejects.toThrow(/last 30 months/);

    for (const bad of ['-5', '0', 'garbage']) {
      process.env.COPILOT_WRITE_RESOLVE_WINDOW_MONTHS = bad;
      await expect(
        tools.updateTransaction({ transaction_id: 'tGone', reviewed: true })
      ).rejects.toThrow(/last 13 months/);
    }
  });
});

describe('resolveTransactionMeta v2 — degraded mode (no liveDb)', () => {
  test('resolves from LevelDB; message stays the plain not-found (no env-var hint)', async () => {
    const client = createMockGraphQLClient({ EditTransaction: echoEdit as any });
    const tools = new CopilotMoneyTools(
      makeDb([
        {
          transaction_id: 'tLocal',
          amount: 100,
          date: '2026-06-01',
          name: 'Synthetic',
          account_id: 'acct-3',
          item_id: 'item-3',
        },
      ]),
      client
    );

    await tools.updateTransaction({ transaction_id: 'tLocal', reviewed: true });
    const call = client._calls.find((c) => c.op === 'EditTransaction')!;
    expect((call.variables as any).accountId).toBe('acct-3');

    await expect(
      tools.updateTransaction({ transaction_id: 'tMissing', reviewed: true })
    ).rejects.toThrow('Transaction not found: tMissing');
    let msg = '';
    try {
      await tools.updateTransaction({ transaction_id: 'tMissing', reviewed: true });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toMatch(/COPILOT_WRITE_RESOLVE_WINDOW_MONTHS/);
  });
});

describe('createRecurring uses resolveTransactionMeta', () => {
  test('uncached id resolves via live fetch; mutation receives the triple', async () => {
    const client = createMockGraphQLClient({
      CreateRecurring: {
        createRecurring: { id: 'rec-1', name: 'n', state: 'ACTIVE', frequency: 'MONTHLY' },
      },
    });
    const { liveDb } = stubLiveDb({
      liveRows: [{ id: 'tOld', accountId: 'acct-9', itemId: 'item-9' }],
    });
    (liveDb as any).patchLiveRecurringUpsert = () => {};
    const tools = new CopilotMoneyTools(makeDb(), client, liveDb);

    await tools.createRecurring({ transaction_id: 'tOld', frequency: 'MONTHLY' });

    const call = client._calls.find((c) => c.op === 'CreateRecurring')!;
    expect((call.variables as any).input.transaction).toEqual({
      accountId: 'acct-9',
      itemId: 'item-9',
      transactionId: 'tOld',
    });
  });

  test('unresolvable id gets the honest window error', async () => {
    const client = createMockGraphQLClient({});
    const { liveDb } = stubLiveDb({});
    const tools = new CopilotMoneyTools(makeDb(), client, liveDb);

    await expect(
      tools.createRecurring({ transaction_id: 'tGone', frequency: 'MONTHLY' })
    ).rejects.toThrow(/Transaction not found: tGone.*last 13 months/);
    expect(client._calls).toHaveLength(0);
  });
});

describe('createTransaction feeds the meta index', () => {
  test('created id becomes resolvable without a fetch', async () => {
    const client = createMockGraphQLClient({
      CreateTransaction: {
        createTransaction: {
          id: 'tNew',
          name: 'Synthetic',
          date: '2026-07-01',
          amount: 100,
          categoryId: 'c1',
          type: 'REGULAR',
          accountId: 'acct-5',
          itemId: 'item-5',
          isPending: false,
          isReviewed: true,
          createdAt: 1,
          recurringId: null,
          userNotes: null,
          tipAmount: null,
          suggestedCategoryIds: [],
          tags: [],
          goal: null,
        },
      },
    });
    const indexTransactionMeta = mock();
    const { liveDb } = stubLiveDb({});
    (liveDb as any).indexTransactionMeta = indexTransactionMeta;
    const db = makeDb();
    (db as any)._userCategories = [{ category_id: 'c1', name: 'Synthetic Cat' }];
    const tools = new CopilotMoneyTools(db, client, liveDb);

    await tools.createTransaction({
      account_id: 'acct-5',
      item_id: 'item-5',
      name: 'Synthetic',
      date: '2026-07-01',
      amount: 100,
      category_id: 'c1',
      type: 'REGULAR',
    });

    expect(indexTransactionMeta).toHaveBeenCalledWith('tNew', {
      accountId: 'acct-5',
      itemId: 'item-5',
    });
  });
});
