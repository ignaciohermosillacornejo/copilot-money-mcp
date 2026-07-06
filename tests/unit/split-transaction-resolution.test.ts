/**
 * Live-first parent resolution for split_transaction (#509). The parent's
 * CONTENT (amount/name/date) resolves: window cache → windowed live fetch →
 * honest window error. Degraded mode (no liveDb) keeps the LevelDB path and
 * is covered by the pre-existing suite in tests/tools/write-tools.test.ts.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import type { LiveCopilotDatabase } from '../../src/core/live-database.js';
import type { TransactionNode } from '../../src/core/graphql/queries/transactions.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';
import type { CreatedTransaction } from '../../src/core/graphql/transactions.js';

function node(id: string, amount: number, date: string, name: string): TransactionNode {
  return {
    id,
    accountId: 'acct-P',
    itemId: 'item-P',
    categoryId: 'c1',
    recurringId: null,
    parentId: null,
    isReviewed: false,
    isPending: false,
    amount,
    date,
    name,
    type: 'REGULAR',
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    isoCurrencyCode: null,
    createdAt: 1,
    tags: [],
    goal: null,
  };
}

/** Server-shaped TransactionFields for the SplitTransaction mock response. */
function serverTx(id: string, amount: number): CreatedTransaction {
  return {
    id,
    accountId: 'acct-P',
    itemId: 'item-P',
    categoryId: '',
    recurringId: null,
    isReviewed: false,
    isPending: false,
    amount,
    date: '2025-10-05',
    name: `srv-${id}`,
    type: 'REGULAR',
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    tags: [],
    goal: null,
    createdAt: 1,
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

/** Stub liveDb: `cachedNodes` back lookupTransactionNodes from the start;
 *  `liveRows` back the windowed getTransactions RETURN VALUE and — like the
 *  real ingestMonth — become visible via lookupTransactionNodes once the
 *  fetch has run; `storeOnlyNodes` simulate same-month future-dated rows the
 *  fetch stores but does not return (#513). */
function stubLiveDb(overrides: {
  cachedNodes?: TransactionNode[];
  liveRows?: TransactionNode[];
  storeOnlyNodes?: TransactionNode[];
}) {
  let fetched = false;
  const getTransactions = mock(() => {
    fetched = true;
    return Promise.resolve({
      rows: overrides.liveRows ?? [],
      oldest_fetched_at: 0,
      newest_fetched_at: 0,
      hit: false,
    });
  });
  const indexTransactionMeta = mock();
  const lookupTransactionNodes = (ids: string[]) => {
    const pool = [
      ...(overrides.cachedNodes ?? []),
      ...(fetched ? [...(overrides.liveRows ?? []), ...(overrides.storeOnlyNodes ?? [])] : []),
    ];
    const out = new Map<string, TransactionNode>();
    for (const id of ids) {
      const n = pool.find((c) => c.id === id);
      if (n) out.set(id, n);
    }
    return out;
  };
  const liveDb = {
    lookupTransactionNodes,
    lookupTransactionMeta: () => new Map(),
    getTransactions,
    indexTransactionMeta,
    patchLiveTransaction: () => {},
    patchLiveTransactionDelete: () => {},
  } as unknown as LiveCopilotDatabase;
  return { liveDb, getTransactions, indexTransactionMeta };
}

const SPLIT_RESPONSE: {
  SplitTransaction: {
    splitTransaction: {
      parentTransaction: CreatedTransaction;
      splitTransactions: CreatedTransaction[];
    };
  };
} = {
  SplitTransaction: {
    splitTransaction: {
      parentTransaction: serverTx('parent-1', 120),
      splitTransactions: [serverTx('child-a', 70), serverTx('child-b', 50)],
    },
  },
};

const VALID_SPLITS = [
  { amount: 70, category_id: 'catA' },
  { amount: 50, category_id: 'catB' },
];

const ORIGINAL_ENV = process.env.COPILOT_WRITE_RESOLVE_WINDOW_MONTHS;
beforeEach(() => {
  delete process.env.COPILOT_WRITE_RESOLVE_WINDOW_MONTHS;
});
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.COPILOT_WRITE_RESOLVE_WINDOW_MONTHS;
  else process.env.COPILOT_WRITE_RESOLVE_WINDOW_MONTHS = ORIGINAL_ENV;
});

describe('splitTransaction parent resolution — live mode', () => {
  test('window-cache hit: no live fetch; defaults come from the cached node', async () => {
    const client = createMockGraphQLClient(SPLIT_RESPONSE);
    const { liveDb, getTransactions } = stubLiveDb({
      cachedNodes: [node('parent-1', 120, '2025-10-05', 'Cached Parent')],
    });
    const tools = new CopilotMoneyTools(makeDb(), client, liveDb);

    const result = await tools.splitTransaction({
      transaction_id: 'parent-1',
      account_id: 'acct-P',
      item_id: 'item-P',
      splits: VALID_SPLITS,
    });

    expect(result.success).toBe(true);
    expect(getTransactions).toHaveBeenCalledTimes(0);
    const sent = (client._calls[0]!.variables as any).input;
    expect(sent[0].name).toBe('Cached Parent');
    expect(sent[0].date).toBe('2025-10-05');
  });

  test('window-cache miss: one windowed fetch resolves the parent', async () => {
    const client = createMockGraphQLClient(SPLIT_RESPONSE);
    const { liveDb, getTransactions } = stubLiveDb({
      liveRows: [node('parent-1', 120, '2025-10-05', 'Fetched Parent')],
    });
    const tools = new CopilotMoneyTools(makeDb(), client, liveDb);

    const result = await tools.splitTransaction({
      transaction_id: 'parent-1',
      account_id: 'acct-P',
      item_id: 'item-P',
      splits: VALID_SPLITS,
    });

    expect(result.success).toBe(true);
    expect(getTransactions).toHaveBeenCalledTimes(1);
    const sent = (client._calls[0]!.variables as any).input;
    expect(sent[0].name).toBe('Fetched Parent');
    expect(sent[0].date).toBe('2025-10-05');
  });

  test('still missing after fetch: honest window error, no mutation issued', async () => {
    const client = createMockGraphQLClient({});
    const { liveDb } = stubLiveDb({});
    const tools = new CopilotMoneyTools(
      makeDb([
        {
          transaction_id: 'parent-gone',
          amount: 100,
          date: '2025-10-05',
          name: 'Stale Local Parent',
          account_id: 'acct-P',
          item_id: 'item-P',
        },
      ]),
      client,
      liveDb
    );

    await expect(
      tools.splitTransaction({
        transaction_id: 'parent-gone',
        account_id: 'acct-P',
        item_id: 'item-P',
        splits: VALID_SPLITS,
      })
    ).rejects.toThrow(/Transaction not found: parent-gone.*last 13 months/);
    await expect(
      tools.splitTransaction({
        transaction_id: 'parent-gone',
        account_id: 'acct-P',
        item_id: 'item-P',
        splits: VALID_SPLITS,
      })
    ).rejects.toThrow(/COPILOT_WRITE_RESOLVE_WINDOW_MONTHS/);
    expect(client._calls).toHaveLength(0);
  });

  test('sum check runs against the LIVE amount, not a stale LevelDB row', async () => {
    // LevelDB holds a stale amount (100); the window cache holds the fresh
    // one (120). Splits summing 120 must pass — proving LevelDB is bypassed —
    // and splits summing 100 must fail naming Parent=120.
    const staleLocalRow = {
      transaction_id: 'parent-1',
      amount: 100,
      date: '2025-10-05',
      name: 'Stale Parent',
      account_id: 'acct-P',
      item_id: 'item-P',
    };
    const client = createMockGraphQLClient(SPLIT_RESPONSE);
    const { liveDb } = stubLiveDb({
      cachedNodes: [node('parent-1', 120, '2025-10-05', 'Fresh Parent')],
    });
    const tools = new CopilotMoneyTools(makeDb([staleLocalRow]), client, liveDb);

    const ok = await tools.splitTransaction({
      transaction_id: 'parent-1',
      account_id: 'acct-P',
      item_id: 'item-P',
      splits: VALID_SPLITS, // sums to 120
    });
    expect(ok.success).toBe(true);

    await expect(
      tools.splitTransaction({
        transaction_id: 'parent-1',
        account_id: 'acct-P',
        item_id: 'item-P',
        splits: [
          { amount: 60, category_id: 'catA' },
          { amount: 40, category_id: 'catB' },
        ], // sums to the stale 100
      })
    ).rejects.toThrow(/Parent=120/);
  });

  test('same-month future-dated parent resolves on the FIRST call (#513)', async () => {
    const client = createMockGraphQLClient(SPLIT_RESPONSE);
    const { liveDb, getTransactions } = stubLiveDb({
      storeOnlyNodes: [node('parent-1', 120, '2025-10-30', 'Future Parent')],
    });
    const tools = new CopilotMoneyTools(makeDb(), client, liveDb);

    const result = await tools.splitTransaction({
      transaction_id: 'parent-1',
      account_id: 'acct-P',
      item_id: 'item-P',
      splits: VALID_SPLITS,
    });

    expect(result.success).toBe(true);
    expect(getTransactions).toHaveBeenCalledTimes(1);
    const sent = (client._calls[0]!.variables as any).input;
    expect(sent[0].name).toBe('Future Parent');
  });
});

describe('splitTransaction output feeds the meta index', () => {
  test('parent and children are indexed from the mutation response; empty ids skipped', async () => {
    const emptyIdChild = { ...serverTx('child-c', 0), accountId: '' };
    const client = createMockGraphQLClient({
      SplitTransaction: {
        splitTransaction: {
          parentTransaction: serverTx('parent-1', 120),
          splitTransactions: [serverTx('child-a', 70), serverTx('child-b', 50), emptyIdChild],
        },
      },
    });
    const { liveDb, indexTransactionMeta } = stubLiveDb({
      cachedNodes: [node('parent-1', 120, '2025-10-05', 'Cached Parent')],
    });
    const tools = new CopilotMoneyTools(makeDb(), client, liveDb);

    await tools.splitTransaction({
      transaction_id: 'parent-1',
      account_id: 'acct-P',
      item_id: 'item-P',
      splits: [
        { amount: 70, category_id: 'catA' },
        { amount: 50, category_id: 'catB' },
        { amount: 0, category_id: 'catC' },
      ],
    });

    const indexedIds = indexTransactionMeta.mock.calls.map((c: any[]) => c[0]);
    expect(indexedIds).toContain('parent-1');
    expect(indexedIds).toContain('child-a');
    expect(indexedIds).toContain('child-b');
    expect(indexedIds).not.toContain('child-c'); // empty accountId → skipped
    for (const call of indexTransactionMeta.mock.calls as any[]) {
      expect(call[1]).toEqual({ accountId: 'acct-P', itemId: 'item-P' });
    }
  });
});
