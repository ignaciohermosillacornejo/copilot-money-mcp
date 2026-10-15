/**
 * delete_transaction refuses a split parent (#822).
 *
 * Deleting a split parent makes Copilot's server credit the parent's amount
 * back to the account a second time (the children already replaced it), so
 * the balance ends wrong by the parent's amount. There is no unsplit
 * mutation, so the tool refuses before any network call whenever the target
 * is a KNOWN split parent — known from the local cache, the live window
 * cache, or this session's own split/child-delete history.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { TransactionMetaStore } from '../../src/core/persistence/transaction-meta-store.js';
import type { TransactionNode } from '../../src/core/graphql/queries/transactions.js';
import type { CreatedTransaction } from '../../src/core/graphql/transactions.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';

// Firestore-shaped opaque ids (never id-equals-name fixtures).
const ACCOUNT_ID = 'Vq3nR8kT2pX6wL9mZ4yB';
const ITEM_ID = 'Hc7fJ1sD5gK8aQ3vN6tW';
const CAT_A = 'Lm2xP7rT4uY9bE1cG5hJ';
const CAT_B = 'Nk6wS3dF8jZ2qV5tR9oA';
const PARENT_ID = 'Rt4yU9iO2pA7sD1fG6hK';
const CHILD_1 = 'Zx8cV3bN6mQ1wE4rT7yU';
const CHILD_2 = 'Jh5gF2dS9aP4oI7uY1tR';
const PLAIN_ID = 'Bn1mK6jH3gF8dS2aQ5wE';

const META_DIR = mkdtempSync(join(tmpdir(), 'delete-split-parent-meta-'));
afterAll(() => rmSync(META_DIR, { recursive: true, force: true }));

const routing = { account_id: ACCOUNT_ID, item_id: ITEM_ID };

function makeDb(transactions: unknown[] = []): CopilotDatabase {
  const db = new CopilotDatabase('/nonexistent');
  (db as any).dbPath = '/fake';
  (db as any)._transactions = transactions;
  (db as any)._userCategories = [];
  (db as any)._tags = [];
  (db as any)._allCollectionsLoaded = true;
  (db as any)._cacheLoadedAt = Date.now();
  return db;
}

function makeLiveDb(client: ReturnType<typeof createMockGraphQLClient>, db: CopilotDatabase) {
  return new LiveCopilotDatabase(client, db, {
    metaStore: new TransactionMetaStore({
      baseDir: mkdtempSync(join(META_DIR, 'store-')),
      uidProvider: () => 'test-uid',
    }),
  });
}

function node(id: string, amount: number, parentId: string | null = null): TransactionNode {
  return {
    id,
    accountId: ACCOUNT_ID,
    itemId: ITEM_ID,
    categoryId: CAT_A,
    recurringId: null,
    parentId,
    isReviewed: false,
    isPending: false,
    amount,
    date: '2025-03-12',
    name: 'Hardware Store',
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

function serverTx(id: string, amount: number, categoryId: string): CreatedTransaction {
  return {
    id,
    accountId: ACCOUNT_ID,
    itemId: ITEM_ID,
    categoryId,
    recurringId: null,
    isReviewed: false,
    isPending: false,
    amount,
    date: '2025-03-12',
    name: 'Hardware Store',
    type: 'REGULAR',
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    tags: [],
    goal: null,
    createdAt: 1,
  };
}

const SPLIT_MOCK = {
  SplitTransaction: {
    splitTransaction: {
      parentTransaction: serverTx(PARENT_ID, 100, ''),
      splitTransactions: [serverTx(CHILD_1, 60, CAT_A), serverTx(CHILD_2, 40, CAT_B)],
    },
  },
};

/** A date inside the write-resolve window (the window ends today). */
const IN_WINDOW_DATE = new Date().toISOString().slice(0, 10);

/**
 * Transactions-query mock for the window fetch delete_transaction runs in live
 * mode. Every month page returns `rows` (the cache files each under its own
 * month); counts calls so a test can assert the fetch ran.
 */
function WINDOW(rows: TransactionNode[] = [], counter?: { n: number }) {
  return {
    Transactions: () => {
      if (counter) counter.n += 1;
      return {
        transactions: {
          edges: rows.map((n) => ({ cursor: `c-${n.id}`, node: n })),
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      };
    },
  };
}

const REFUSAL = /split parent/i;
const deletes = (client: ReturnType<typeof createMockGraphQLClient>) =>
  client._calls.filter((c) => c.op === 'DeleteTransaction');

describe('delete_transaction refuses a split parent (#822)', () => {
  test('(a) split this session, then delete the parent → refused, nothing sent', async () => {
    const client = createMockGraphQLClient({
      ...SPLIT_MOCK,
      DeleteTransaction: { deleteTransaction: true },
    });
    // Degraded mode (no liveDb): only the session record can know the parent.
    const tools = new CopilotMoneyTools(
      makeDb([
        {
          transaction_id: PARENT_ID,
          amount: 100,
          date: '2025-03-12',
          name: 'Hardware Store',
          ...routing,
          category_id: CAT_A,
        },
      ]),
      client
    );
    await tools.splitTransaction({
      transaction_id: PARENT_ID,
      ...routing,
      splits: [
        { amount: 60, category_id: CAT_A },
        { amount: 40, category_id: CAT_B },
      ],
    });

    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(deletes(client)).toHaveLength(0);
  });

  test('(b) delete both children, then the parent → children go, parent refused', async () => {
    // The exact repro: once both children are gone no cached row points at
    // the parent any more, so only the record taken at child-delete time
    // still knows it.
    const client = createMockGraphQLClient({
      ...WINDOW(),
      DeleteTransaction: { deleteTransaction: true },
    });
    const db = makeDb();
    const liveDb = makeLiveDb(client, db);
    liveDb
      .getTransactionsWindowCache()
      .ingestMonth('2025-03', [node(CHILD_1, 60, PARENT_ID), node(CHILD_2, 40, PARENT_ID)], 1);
    const tools = new CopilotMoneyTools(db, client, liveDb);

    await tools.deleteTransaction({ transaction_id: CHILD_1, ...routing });
    await tools.deleteTransaction({ transaction_id: CHILD_2, ...routing });
    expect(deletes(client).map((c) => (c.variables as { id: string }).id)).toEqual([
      CHILD_1,
      CHILD_2,
    ]);

    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(deletes(client)).toHaveLength(2);
  });

  test('(c) parent known only via local-cache children_transaction_ids → refused', async () => {
    const client = createMockGraphQLClient({ DeleteTransaction: { deleteTransaction: true } });
    const tools = new CopilotMoneyTools(
      makeDb([
        {
          transaction_id: PARENT_ID,
          amount: 100,
          date: '2025-03-12',
          name: 'Hardware Store',
          ...routing,
          category_id: '',
          children_transaction_ids: [CHILD_1, CHILD_2],
        },
      ]),
      client
    );

    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(client._calls).toHaveLength(0);
  });

  test('(c2) parent known only via a local-cache child parent_transaction_id → refused', async () => {
    const client = createMockGraphQLClient({ DeleteTransaction: { deleteTransaction: true } });
    const tools = new CopilotMoneyTools(
      makeDb([
        {
          transaction_id: CHILD_1,
          amount: 60,
          date: '2025-03-12',
          name: 'Hardware Store',
          ...routing,
          category_id: CAT_A,
          parent_transaction_id: PARENT_ID,
        },
      ]),
      client
    );

    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(client._calls).toHaveLength(0);
  });

  test('(d) parent known only via a live-cache child row → refused', async () => {
    const client = createMockGraphQLClient({
      ...WINDOW(),
      DeleteTransaction: { deleteTransaction: true },
    });
    const db = makeDb();
    const liveDb = makeLiveDb(client, db);
    liveDb.getTransactionsWindowCache().ingestMonth('2025-03', [node(CHILD_1, 60, PARENT_ID)], 1);
    const tools = new CopilotMoneyTools(db, client, liveDb);

    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(deletes(client)).toHaveLength(0);
  });

  test('the refusal says to delete the children instead and that there is no unsplit', async () => {
    const client = createMockGraphQLClient({ ...WINDOW() });
    const db = makeDb();
    const liveDb = makeLiveDb(client, db);
    liveDb.getTransactionsWindowCache().ingestMonth('2025-03', [node(CHILD_1, 60, PARENT_ID)], 1);
    const tools = new CopilotMoneyTools(db, client, liveDb);

    const err = await tools
      .deleteTransaction({ transaction_id: PARENT_ID, ...routing })
      .then(() => null)
      .catch((e: Error) => e);
    expect(err?.message).toMatch(/balance/i);
    expect(err?.message).toMatch(/delete the child transactions/i);
    expect(err?.message).toMatch(/no unsplit/i);
  });

  test('(e) an ordinary transaction and a split child still delete normally', async () => {
    const client = createMockGraphQLClient({
      ...WINDOW(),
      DeleteTransaction: { deleteTransaction: true },
    });
    const db = makeDb([
      {
        transaction_id: PLAIN_ID,
        amount: 20,
        date: '2025-03-10',
        name: 'Bakery',
        ...routing,
        category_id: CAT_B,
      },
    ]);
    const liveDb = makeLiveDb(client, db);
    liveDb
      .getTransactionsWindowCache()
      .ingestMonth('2025-03', [node(PLAIN_ID, 20), node(CHILD_1, 60, PARENT_ID)], 1);
    const tools = new CopilotMoneyTools(db, client, liveDb);

    const plain = await tools.deleteTransaction({ transaction_id: PLAIN_ID, ...routing });
    const child = await tools.deleteTransaction({ transaction_id: CHILD_1, ...routing });
    expect(plain.deleted).toBe(true);
    expect(child.deleted).toBe(true);
    expect(deletes(client).map((c) => (c.variables as { id: string }).id)).toEqual([
      PLAIN_ID,
      CHILD_1,
    ]);
  });
});

describe('delete_transaction split-parent evidence: live path, staleness, drift (#822 review)', () => {
  const inWindow = (id: string, amount: number, parentId: string | null = null) => ({
    ...node(id, amount, parentId),
    date: IN_WINDOW_DATE,
  });

  test('(f) parent known only via the live window fetch → refused, nothing deleted', async () => {
    // Nothing cached, no session record: the only evidence is a child row the
    // write-resolve window fetch returns from the server.
    const fetches = { n: 0 };
    const client = createMockGraphQLClient({
      ...WINDOW([inWindow(CHILD_1, 60, PARENT_ID)], fetches),
      DeleteTransaction: { deleteTransaction: true },
    });
    const db = makeDb();
    const tools = new CopilotMoneyTools(db, client, makeLiveDb(client, db));

    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(fetches.n).toBeGreaterThan(0);
    expect(deletes(client)).toHaveLength(0);
  });

  test('live mode never decodes the local cache', async () => {
    const client = createMockGraphQLClient({
      ...WINDOW([inWindow(PLAIN_ID, 20)]),
      DeleteTransaction: { deleteTransaction: true },
    });
    const db = makeDb();
    let localReads = 0;
    db.getAllTransactions = () => {
      localReads += 1;
      return Promise.resolve([]);
    };
    const tools = new CopilotMoneyTools(db, client, makeLiveDb(client, db));

    await tools.deleteTransaction({ transaction_id: PLAIN_ID, ...routing });
    expect(localReads).toBe(0);
    expect(deletes(client)).toHaveLength(1);
  });

  test('a failed window fetch does not block the delete — remaining evidence still applies', async () => {
    const client = createMockGraphQLClient({
      Transactions: new Error('synthetic network failure'),
      DeleteTransaction: { deleteTransaction: true },
    });
    const db = makeDb();
    const liveDb = makeLiveDb(client, db);
    liveDb.getTransactionsWindowCache().ingestMonth('2025-03', [node(CHILD_1, 60, PARENT_ID)], 1);
    const tools = new CopilotMoneyTools(db, client, liveDb);

    const plain = await tools.deleteTransaction({ transaction_id: PLAIN_ID, ...routing });
    expect(plain.deleted).toBe(true);
    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(deletes(client).map((c) => (c.variables as { id: string }).id)).toEqual([PLAIN_ID]);
  });

  test('the refusal names the way out when the split was removed in the app', async () => {
    const client = createMockGraphQLClient({ ...WINDOW([inWindow(CHILD_1, 60, PARENT_ID)]) });
    const db = makeDb();
    const tools = new CopilotMoneyTools(db, client, makeLiveDb(client, db));

    const err = await tools
      .deleteTransaction({ transaction_id: PARENT_ID, ...routing })
      .then(() => null)
      .catch((e: Error) => e);
    expect(err?.message).toMatch(/removed this split in the Copilot app/i);
    expect(err?.message).toMatch(/refresh_cache/);
    expect(err?.message).toMatch(/refresh_database/);
  });

  test('a session record is retired when the server returns the id as an ordinary row', async () => {
    // Split this session, then the split is removed in the app: the window
    // fetch now returns the former parent as a normal row. The Transactions
    // query omits split parents, so that row proves it is no longer one.
    let parentVisible = false;
    const client = createMockGraphQLClient({
      ...SPLIT_MOCK,
      Transactions: () => ({
        transactions: {
          edges: parentVisible ? [{ cursor: 'c-p', node: inWindow(PARENT_ID, 100) }] : [],
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      }),
      DeleteTransaction: { deleteTransaction: true },
    });
    const db = makeDb();
    const liveDb = makeLiveDb(client, db);
    liveDb.getTransactionsWindowCache().ingestMonth('2025-03', [node(PARENT_ID, 100)], 1);
    const tools = new CopilotMoneyTools(db, client, liveDb);
    await tools.splitTransaction({
      transaction_id: PARENT_ID,
      ...routing,
      splits: [
        { amount: 60, category_id: CAT_A },
        { amount: 40, category_id: CAT_B },
      ],
    });
    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);

    // What refresh_cache does, then the server shows the row again.
    liveDb.getTransactionsWindowCache().invalidate('all');
    parentVisible = true;
    const res = await tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing });
    expect(res.deleted).toBe(true);
  });

  test('(g) split recorded even when mapping a drifted response throws', async () => {
    // Response validation is warn-only, so a drifted response reaches the
    // local mapping; `tags: null` makes it throw after the server has split.
    const drifted = { ...serverTx(PARENT_ID, 100, ''), tags: null };
    const client = createMockGraphQLClient({
      SplitTransaction: {
        splitTransaction: {
          parentTransaction: drifted as unknown as CreatedTransaction,
          splitTransactions: [serverTx(CHILD_1, 60, CAT_A), serverTx(CHILD_2, 40, CAT_B)],
        },
      },
      DeleteTransaction: { deleteTransaction: true },
    });
    // Degraded mode: the session record is the only evidence.
    const tools = new CopilotMoneyTools(makeDb(), client);
    await expect(
      tools.splitTransaction({
        transaction_id: PARENT_ID,
        ...routing,
        splits: [
          { amount: 60, category_id: CAT_A, name: 'A', date: '2025-03-12' },
          { amount: 40, category_id: CAT_B, name: 'B', date: '2025-03-12' },
        ],
      })
    ).rejects.toThrow();

    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(deletes(client)).toHaveLength(0);
  });
});
