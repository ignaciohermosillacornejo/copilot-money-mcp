/**
 * delete_transaction refuses a split parent (#822).
 *
 * Deleting a split parent makes Copilot's server credit the parent's amount
 * back to the account a second time (the children already replaced it), so
 * the balance ends wrong by the parent's amount. There is no unsplit
 * mutation, so the tool refuses before any network call whenever the target
 * is a KNOWN split parent — known from the local cache (soft-deleted children
 * included, #842), the live window cache, or the split record this server
 * keeps (in memory and persisted).
 *
 * #842: no evidence is ever negative. Once all of a parent's children are
 * deleted, Copilot returns it as an ordinary row, and deleting it still
 * double-credits — so a row for the id never makes it deletable again.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { TransactionMetaStore } from '../../src/core/persistence/transaction-meta-store.js';
import { SplitParentStore } from '../../src/core/persistence/split-parent-store.js';
import { createTestDb } from '../helpers/test-db.js';
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
  db._markLoadedForTesting();
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

const inWindow = (id: string, amount: number, parentId: string | null = null) => ({
  ...node(id, amount, parentId),
  date: IN_WINDOW_DATE,
});

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

  test('live mode reads the local cache once for split evidence (#842)', async () => {
    // Delete is rare and destructive, so the first one in a process pays for
    // the local decode every cache read uses; later deletes reuse it.
    const client = createMockGraphQLClient({
      ...WINDOW([inWindow(PLAIN_ID, 20)]),
      DeleteTransaction: { deleteTransaction: true },
    });
    const db = new CopilotDatabase('/nonexistent');
    (db as any).dbPath = '/fake';
    let decodes = 0;
    (db as any).loadAllCollections = () => {
      decodes += 1;
      (db as any)._transactions = [];
      db._markLoadedForTesting();
      return Promise.resolve();
    };
    let fullReads = 0;
    db.getAllTransactions = () => {
      fullReads += 1;
      return Promise.resolve([]);
    };
    const tools = new CopilotMoneyTools(db, client, makeLiveDb(client, db));

    await tools.deleteTransaction({ transaction_id: PLAIN_ID, ...routing });
    await tools.deleteTransaction({ transaction_id: PLAIN_ID, ...routing });
    expect(decodes).toBe(1);
    // The row half reads only what is already in memory in live mode: one
    // decode per delete at most, never a second full read (#852 review).
    expect(fullReads).toBe(0);
    expect(deletes(client)).toHaveLength(2);
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

  test('the refusal offers no retry: a childless parent still cannot be deleted (#842)', async () => {
    const client = createMockGraphQLClient({ ...WINDOW([inWindow(CHILD_1, 60, PARENT_ID)]) });
    const db = makeDb();
    const tools = new CopilotMoneyTools(db, client, makeLiveDb(client, db));

    const err = await tools
      .deleteTransaction({ transaction_id: PARENT_ID, ...routing })
      .then(() => null)
      .catch((e: Error) => e);
    expect(err?.message).toMatch(/reappears as an ordinary transaction/);
    expect(err?.message).toMatch(/still cannot be deleted safely/);
    expect(err?.message).not.toMatch(/retry/i);
    expect(err?.message).not.toMatch(/refresh_cache|refresh_database/);
  });

  test('(842) split, delete both children, the parent comes back as an ordinary row → still refused', async () => {
    // The exact #842 sequence. After its children are deleted Copilot returns
    // the ex-parent as an ordinary row (parentId null) from a freshly fetched
    // month, and deleting it still credits its amount back a second time. The
    // #822 guard took that row as proof the id was no longer a parent.
    let parentVisible = false;
    const fetches = { n: 0 };
    const client = createMockGraphQLClient({
      ...SPLIT_MOCK,
      Transactions: () => {
        fetches.n += 1;
        return {
          transactions: {
            edges: parentVisible ? [{ cursor: 'c-p', node: inWindow(PARENT_ID, 100) }] : [],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        };
      },
      DeleteTransaction: { deleteTransaction: true },
    });
    const db = makeDb();
    const liveDb = makeLiveDb(client, db);
    const tools = new CopilotMoneyTools(db, client, liveDb);
    await tools.splitTransaction({
      transaction_id: PARENT_ID,
      ...routing,
      splits: [
        { amount: 60, category_id: CAT_A, name: 'A', date: IN_WINDOW_DATE },
        { amount: 40, category_id: CAT_B, name: 'B', date: IN_WINDOW_DATE },
      ],
    });
    await tools.deleteTransaction({ transaction_id: CHILD_1, ...routing });
    await tools.deleteTransaction({ transaction_id: CHILD_2, ...routing });

    // What refresh_cache does; then the server shows the ex-parent again.
    liveDb.getTransactionsWindowCache().invalidate('all');
    parentVisible = true;
    const fetchesBefore = fetches.n;
    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(deletes(client).map((c) => (c.variables as { id: string }).id)).toEqual([
      CHILD_1,
      CHILD_2,
    ]);
    // Refused from the record, before any fetch could offer the row.
    expect(fetches.n).toBe(fetchesBefore);

    // And again once the row is cached from a fresh fetch (a read in between).
    await liveDb.getTransactions(CopilotMoneyTools.writeResolveWindow());
    expect(liveDb.lookupTransactionNodes([PARENT_ID]).get(PARENT_ID)?.parentId).toBeNull();
    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(deletes(client)).toHaveLength(2);
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

  test('(g-live) a drifted split leaves no stale cached parent that retires the record', async () => {
    // The parent sits in a cached month. The drifted response throws in the
    // mapping, before the children are written through. Two things must hold:
    // no stale pre-split row may remain for a later check to mistake for a
    // live one, and the month must not be left cached with neither the parent
    // nor its children (the #820 shape) — it is dropped, so the next read
    // refetches. 2025-03 is outside the write-resolve window, so the window
    // fetch never refreshes it: what is exercised is the eviction and the
    // record, not a cold-tier refetch.
    const drifted = { ...serverTx(PARENT_ID, 100, ''), tags: null };
    const client = createMockGraphQLClient({
      ...WINDOW(),
      SplitTransaction: {
        splitTransaction: {
          parentTransaction: drifted as unknown as CreatedTransaction,
          splitTransactions: [serverTx(CHILD_1, 60, CAT_A), serverTx(CHILD_2, 40, CAT_B)],
        },
      },
      DeleteTransaction: { deleteTransaction: true },
    });
    const db = makeDb();
    const liveDb = makeLiveDb(client, db);
    liveDb.getTransactionsWindowCache().ingestMonth('2025-03', [node(PARENT_ID, 100)], 1);
    const tools = new CopilotMoneyTools(db, client, liveDb);
    await expect(
      tools.splitTransaction({
        transaction_id: PARENT_ID,
        ...routing,
        splits: [
          { amount: 60, category_id: CAT_A },
          { amount: 40, category_id: CAT_B },
        ],
      })
    ).rejects.toThrow();
    expect(liveDb.getTransactionsWindowCache().hasMonth('2025-03')).toBe(false);

    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(deletes(client)).toHaveLength(0);
  });

  test('a stale cached row does not retire the record either', async () => {
    // Record taken, then some other write invalidates an unrelated month
    // while the parent's pre-split row is still cached in a month the window
    // fetch does not refetch (2025-03 is outside the write-resolve window).
    // Under #822 only a refetched row could retire a record; since #842 no
    // row does, and a stale one least of all.
    const client = createMockGraphQLClient({
      ...WINDOW(),
      ...SPLIT_MOCK,
      DeleteTransaction: { deleteTransaction: true },
    });
    const db = makeDb();
    const liveDb = makeLiveDb(client, db);
    const cache = liveDb.getTransactionsWindowCache();
    cache.ingestMonth('2025-03', [node(PARENT_ID, 100)], 1);
    const tools = new CopilotMoneyTools(db, client, liveDb);
    await tools.splitTransaction({
      transaction_id: PARENT_ID,
      ...routing,
      splits: [
        { amount: 60, category_id: CAT_A },
        { amount: 40, category_id: CAT_B },
      ],
    });
    // Put a stale copy back, as a drifted path could leave it, and invalidate
    // an unrelated month the way another write does.
    cache.ingestMonth('2025-03', [node(PARENT_ID, 100)], 1);
    cache.invalidate(['2024-01']);

    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(deletes(client)).toHaveLength(0);
  });

  test('no Transactions fetch when the session record already knows the parent', async () => {
    const fetches = { n: 0 };
    const client = createMockGraphQLClient({
      ...WINDOW([], fetches),
      ...SPLIT_MOCK,
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
    const afterSplit = fetches.n;

    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(fetches.n).toBe(afterSplit);
  });

  test('live mode + an already-loaded local cache with children_transaction_ids → refused', async () => {
    const client = createMockGraphQLClient({
      ...WINDOW(),
      DeleteTransaction: { deleteTransaction: true },
    });
    const db = makeDb([
      {
        transaction_id: PARENT_ID,
        amount: 100,
        date: '2025-03-12',
        name: 'Hardware Store',
        ...routing,
        category_id: '',
        children_transaction_ids: [CHILD_1, CHILD_2],
      },
    ]);
    const tools = new CopilotMoneyTools(db, client, makeLiveDb(client, db));

    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(deletes(client)).toHaveLength(0);
  });

  test('live mode + an unreadable local cache → the delete is not blocked', async () => {
    const client = createMockGraphQLClient({
      ...WINDOW([inWindow(PLAIN_ID, 20)]),
      DeleteTransaction: { deleteTransaction: true },
    });
    const db = new CopilotDatabase('/nonexistent');
    (db as any).dbPath = '/fake';
    let decodes = 0;
    (db as any).loadAllCollections = () => {
      decodes += 1;
      return Promise.reject(new Error('synthetic unreadable cache'));
    };
    const tools = new CopilotMoneyTools(db, client, makeLiveDb(client, db));

    const res = await tools.deleteTransaction({ transaction_id: PLAIN_ID, ...routing });
    expect(res.deleted).toBe(true);
    expect(decodes).toBeGreaterThan(0);
  });
});

describe('split-parent evidence that survives a restart (#842)', () => {
  // A real LevelDB fixture: the parent's two children were deleted (in the app,
  // or by an earlier process), so Copilot soft-deleted their documents —
  // `user_deleted: true`, `parent_transaction_id` kept — and the ex-parent is
  // an ordinary document with no split marker. Nothing else in the cache says
  // it was ever split.
  const LEVELDB_DIR = mkdtempSync(join(tmpdir(), 'delete-split-parent-leveldb-'));
  afterAll(() => rmSync(LEVELDB_DIR, { recursive: true, force: true }));

  const deletedChild = (id: string, amount: number) => ({
    collection: 'transactions',
    id,
    fields: {
      transaction_id: id,
      ...routing,
      amount,
      date: '2025-03-12',
      name: 'Hardware Store',
      category_id: CAT_A,
      parent_transaction_id: PARENT_ID,
      user_deleted: true,
    },
  });

  /** Age the loaded cache past its TTL and the split-evidence re-read floor. */
  function age(db: CopilotDatabase): void {
    const past = Date.now() - 24 * 60 * 60 * 1000;
    (db as any)._cacheLoadedAt = past;
    (db as any)._splitEvidenceAttemptAt = past;
  }

  async function fixtureDb(): Promise<CopilotDatabase> {
    const dbPath = join(mkdtempSync(join(LEVELDB_DIR, 'db-')), 'leveldb');
    await createTestDb(dbPath, [
      {
        collection: 'transactions',
        id: PARENT_ID,
        fields: {
          transaction_id: PARENT_ID,
          ...routing,
          amount: 100,
          date: '2025-03-12',
          name: 'Hardware Store',
          category_id: CAT_B,
        },
      },
      deletedChild(CHILD_1, 60),
      deletedChild(CHILD_2, 40),
      {
        collection: 'transactions',
        id: PLAIN_ID,
        fields: {
          transaction_id: PLAIN_ID,
          ...routing,
          amount: 20,
          date: '2025-03-10',
          name: 'Bakery',
          category_id: CAT_B,
        },
      },
    ]);
    return new CopilotDatabase(dbPath);
  }

  test('live mode, empty session: a soft-deleted child in the local cache refuses its parent', async () => {
    // The server shows the ex-parent as an ordinary row; the process has no
    // record of the split. Only the deleted children's documents remain.
    const client = createMockGraphQLClient({
      ...WINDOW([inWindow(PARENT_ID, 100), inWindow(PLAIN_ID, 20)]),
      DeleteTransaction: { deleteTransaction: true },
    });
    const db = await fixtureDb();
    const tools = new CopilotMoneyTools(db, client, makeLiveDb(client, db));

    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(deletes(client)).toHaveLength(0);
    // The deleted children are evidence only, never rows.
    const ids = (await db.getAllTransactions()).map((t) => t.transaction_id).sort();
    expect(ids).toEqual([PARENT_ID, PLAIN_ID].sort());

    const plain = await tools.deleteTransaction({ transaction_id: PLAIN_ID, ...routing });
    expect(plain.deleted).toBe(true);
  });

  test('cache-only mode: a soft-deleted child in the local cache refuses its parent', async () => {
    const client = createMockGraphQLClient({ DeleteTransaction: { deleteTransaction: true } });
    const tools = new CopilotMoneyTools(await fixtureDb(), client);

    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(client._calls).toHaveLength(0);
  });

  test('past the cache TTL a delete re-reads the local cache and sees a newly deleted child', async () => {
    // A long-running session: the first delete decoded the cache before the
    // split happened. The user then splits a row in the app and deletes both
    // children there; the desktop app syncs the soft-deleted children. Once
    // the loaded cache is past its TTL, the next delete must decode again.
    const dbPath = join(mkdtempSync(join(LEVELDB_DIR, 'ttl-')), 'leveldb');
    const parentDoc = {
      collection: 'transactions',
      id: PARENT_ID,
      fields: {
        transaction_id: PARENT_ID,
        ...routing,
        amount: 100,
        date: '2025-03-12',
        name: 'Hardware Store',
        category_id: CAT_B,
      },
    };
    const plainDoc = {
      collection: 'transactions',
      id: PLAIN_ID,
      fields: {
        transaction_id: PLAIN_ID,
        ...routing,
        amount: 20,
        date: '2025-03-10',
        name: 'Bakery',
        category_id: CAT_B,
      },
    };
    await createTestDb(dbPath, [parentDoc, plainDoc]);
    const client = createMockGraphQLClient({
      ...WINDOW([inWindow(PARENT_ID, 100), inWindow(PLAIN_ID, 20)]),
      DeleteTransaction: { deleteTransaction: true },
    });
    const db = new CopilotDatabase(dbPath);
    const tools = new CopilotMoneyTools(db, client, makeLiveDb(client, db));
    await tools.deleteTransaction({ transaction_id: PLAIN_ID, ...routing });

    await createTestDb(dbPath, [parentDoc, deletedChild(CHILD_1, 60), deletedChild(CHILD_2, 40)]);
    // Age the loaded cache and its split evidence past the TTL and the
    // re-read floor instead of waiting them out.
    age(db);

    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(deletes(client).map((c) => (c.variables as { id: string }).id)).toEqual([PLAIN_ID]);
  });

  test('evidence only accumulates: a re-decode that no longer holds the children still refuses', async () => {
    // Decode 1 learns the parent from its soft-deleted children. By the next
    // delete, past the TTL, the app has purged those documents (or a partial
    // read missed them): decode 2 names nothing. The parent stays refused.
    const db = await fixtureDb();
    const client = createMockGraphQLClient({
      ...WINDOW([inWindow(PARENT_ID, 100), inWindow(PLAIN_ID, 20)]),
      DeleteTransaction: { deleteTransaction: true },
    });
    const tools = new CopilotMoneyTools(db, client, makeLiveDb(client, db));
    await tools.deleteTransaction({ transaction_id: PLAIN_ID, ...routing });

    await createTestDb(db.getDbPath()!, [
      {
        collection: 'transactions',
        id: PARENT_ID,
        fields: {
          transaction_id: PARENT_ID,
          ...routing,
          amount: 100,
          date: '2025-03-12',
          name: 'Hardware Store',
          category_id: CAT_B,
        },
      },
    ]);
    age(db);
    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    // Decode 2 did run: its rows are the rewritten fixture's.
    expect((await db.getAllTransactions()).map((t) => t.transaction_id)).toEqual([PARENT_ID]);
    expect(deletes(client).map((c) => (c.variables as { id: string }).id)).toEqual([PLAIN_ID]);
  });

  test('at a cache TTL of 0, a delete within a minute of the last decode does not decode again', async () => {
    // TTL 0 makes the cache always stale; the re-read floor
    // (splitEvidenceRereadMs: the TTL, at least a minute) still bounds the
    // split check to one decode attempt per minute.
    const prev = process.env.COPILOT_CACHE_TTL_MINUTES;
    process.env.COPILOT_CACHE_TTL_MINUTES = '0';
    try {
      const db = await fixtureDb();
      const client = createMockGraphQLClient({
        ...WINDOW([inWindow(PLAIN_ID, 20)]),
        DeleteTransaction: { deleteTransaction: true },
      });
      const tools = new CopilotMoneyTools(db, client, makeLiveDb(client, db));
      await tools.deleteTransaction({ transaction_id: PLAIN_ID, ...routing });

      let reloads = 0;
      (db as any).loadAllCollections = () => {
        reloads += 1;
        return Promise.resolve();
      };
      await tools.deleteTransaction({ transaction_id: PLAIN_ID, ...routing });
      expect(reloads).toBe(0);

      // A minute on, the stale cache is re-read.
      (db as any)._splitEvidenceAttemptAt = Date.now() - 61_000;
      await tools.deleteTransaction({ transaction_id: PLAIN_ID, ...routing });
      expect(reloads).toBe(1);
      expect(deletes(client)).toHaveLength(3);
    } finally {
      if (prev === undefined) delete process.env.COPILOT_CACHE_TTL_MINUTES;
      else process.env.COPILOT_CACHE_TTL_MINUTES = prev;
    }
  });

  test('a failing decode is latched too: one attempt per re-read interval, not per delete', async () => {
    const client = createMockGraphQLClient({
      ...WINDOW([inWindow(PLAIN_ID, 20)]),
      DeleteTransaction: { deleteTransaction: true },
    });
    const db = new CopilotDatabase('/nonexistent');
    (db as any).dbPath = '/fake';
    let attempts = 0;
    (db as any).loadAllCollections = () => {
      attempts += 1;
      return Promise.reject(new Error('synthetic decode timeout'));
    };
    const tools = new CopilotMoneyTools(db, client, makeLiveDb(client, db));

    await tools.deleteTransaction({ transaction_id: PLAIN_ID, ...routing });
    await tools.deleteTransaction({ transaction_id: PLAIN_ID, ...routing });
    expect(attempts).toBe(1);

    // Past the interval (the 5-minute default TTL), it is tried again.
    (db as any)._splitEvidenceAttemptAt = Date.now() - 6 * 60 * 1000;
    await tools.deleteTransaction({ transaction_id: PLAIN_ID, ...routing });
    expect(attempts).toBe(2);
    expect(deletes(client)).toHaveLength(3);
  });

  test('a stale reload that throws still refuses what earlier decodes named', async () => {
    const db = await fixtureDb();
    const client = createMockGraphQLClient({
      ...WINDOW([inWindow(PARENT_ID, 100), inWindow(PLAIN_ID, 20)]),
      DeleteTransaction: { deleteTransaction: true },
    });
    const tools = new CopilotMoneyTools(db, client, makeLiveDb(client, db));
    await tools.deleteTransaction({ transaction_id: PLAIN_ID, ...routing });

    let reloads = 0;
    (db as any).loadAllCollections = () => {
      reloads += 1;
      // What a stale reload does before its decode fails.
      db.clearCache();
      return Promise.reject(new Error('synthetic decode timeout'));
    };
    age(db);
    await expect(
      tools.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(reloads).toBe(1);
    expect(deletes(client)).toHaveLength(1);
  });

  test('a split recorded by one process is refused by the next one (persisted record)', async () => {
    const storeDir = mkdtempSync(join(META_DIR, 'split-parents-'));
    const store = () =>
      new SplitParentStore({ baseDir: storeDir, uidProvider: () => 'Qe7rT2yU9iO4pA1sD6fG' });

    const client1 = createMockGraphQLClient({
      ...WINDOW(),
      ...SPLIT_MOCK,
      DeleteTransaction: { deleteTransaction: true },
    });
    const db1 = makeDb();
    const first = new CopilotMoneyTools(db1, client1, makeLiveDb(client1, db1), {
      splitParentStore: store(),
    });
    await first.splitTransaction({
      transaction_id: PARENT_ID,
      ...routing,
      splits: [
        { amount: 60, category_id: CAT_A, name: 'A', date: IN_WINDOW_DATE },
        { amount: 40, category_id: CAT_B, name: 'B', date: IN_WINDOW_DATE },
      ],
    });

    // Restart: a fresh process whose server shows the ex-parent as an
    // ordinary row and whose local cache knows nothing.
    const client2 = createMockGraphQLClient({
      ...WINDOW([inWindow(PARENT_ID, 100)]),
      DeleteTransaction: { deleteTransaction: true },
    });
    const db2 = makeDb();
    const second = new CopilotMoneyTools(db2, client2, makeLiveDb(client2, db2), {
      splitParentStore: store(),
    });
    await expect(
      second.deleteTransaction({ transaction_id: PARENT_ID, ...routing })
    ).rejects.toThrow(REFUSAL);
    expect(deletes(client2)).toHaveLength(0);
  });
});
