/**
 * Unit tests for coverage gaps in getCacheInfo, refreshDatabase, cross-tool
 * interactions, and write-tool edge cases.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import type { Transaction, Account, Category, Tag, Goal, Budget } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock database with all collection caches pre-populated. */
function createMockDb(
  overrides: {
    transactions?: Transaction[];
    accounts?: Account[];
    userCategories?: Category[];
    tags?: Tag[];
    goals?: Goal[];
    budgets?: Budget[];
  } = {}
): CopilotDatabase {
  const db = new CopilotDatabase('/nonexistent');
  const a = db as any;

  a.dbPath = '/fake';
  a._transactions = overrides.transactions ?? [];
  a._accounts = overrides.accounts ?? [];
  a._recurring = [];
  a._budgets = overrides.budgets ?? [];
  a._goals = overrides.goals ?? [];
  a._goalHistory = [];
  a._investmentPrices = [];
  a._investmentSplits = [];
  a._items = [];
  a._userCategories = overrides.userCategories ?? [];
  a._userAccounts = [];
  a._categoryNameMap = new Map<string, string>();
  a._accountNameMap = new Map<string, string>();
  a._securities = [];
  a._holdingsHistory = [];
  a._tags = overrides.tags ?? [];
  a._allCollectionsLoaded = true;
  a._cacheLoadedAt = Date.now();

  return db;
}

/** A no-op FirestoreClient stub for write tools. */
function createMockClient() {
  return {
    requireUserId: async () => 'test-user-123',
    getUserId: () => 'test-user-123',
    createDocument: async (_col: string, docId: string | undefined) => docId ?? 'auto_generated_id',
    updateDocument: async () => {},
    deleteDocument: async () => {},
  } as any;
}

// ---------------------------------------------------------------------------
// 1. getCacheInfo -- expanded coverage
// ---------------------------------------------------------------------------

describe('getCacheInfo — expanded', () => {
  test('returns date range spanning multiple months', async () => {
    const db = createMockDb({
      transactions: [
        { transaction_id: 't1', amount: 10, date: '2023-06-01', account_id: 'a1' },
        { transaction_id: 't2', amount: 20, date: '2023-09-15', account_id: 'a1' },
        { transaction_id: 't3', amount: 30, date: '2024-01-31', account_id: 'a1' },
      ],
    });
    const tools = new CopilotMoneyTools(db);

    const info = await tools.getCacheInfo();

    expect(info.transaction_count).toBe(3);
    expect(info.oldest_transaction_date).toBe('2023-06-01');
    expect(info.newest_transaction_date).toBe('2024-01-31');
    expect(info.cache_note).toContain('3 transactions');
    expect(info.cache_note).toContain('2023-06-01');
    expect(info.cache_note).toContain('2024-01-31');
  });

  test('handles single transaction edge case', async () => {
    const db = createMockDb({
      transactions: [{ transaction_id: 'only', amount: 99, date: '2024-03-10', account_id: 'a1' }],
    });
    const tools = new CopilotMoneyTools(db);

    const info = await tools.getCacheInfo();

    expect(info.transaction_count).toBe(1);
    expect(info.oldest_transaction_date).toBe('2024-03-10');
    expect(info.newest_transaction_date).toBe('2024-03-10');
  });

  test('returns nulls and zero count for empty database', async () => {
    const db = createMockDb({ transactions: [] });
    const tools = new CopilotMoneyTools(db);

    const info = await tools.getCacheInfo();

    expect(info.transaction_count).toBe(0);
    expect(info.oldest_transaction_date).toBeNull();
    expect(info.newest_transaction_date).toBeNull();
    expect(info.cache_note).toContain('No transactions');
  });

  test('sorts dates correctly when inserted out of order', async () => {
    const db = createMockDb({
      transactions: [
        { transaction_id: 't1', amount: 10, date: '2024-12-25', account_id: 'a1' },
        { transaction_id: 't2', amount: 20, date: '2024-01-01', account_id: 'a1' },
        { transaction_id: 't3', amount: 30, date: '2024-06-15', account_id: 'a1' },
      ],
    });
    const tools = new CopilotMoneyTools(db);

    const info = await tools.getCacheInfo();

    expect(info.oldest_transaction_date).toBe('2024-01-01');
    expect(info.newest_transaction_date).toBe('2024-12-25');
  });
});

// ---------------------------------------------------------------------------
// 2. refreshDatabase -- expanded coverage
// ---------------------------------------------------------------------------

describe('refreshDatabase — expanded', () => {
  test('returns expected fields after refresh', async () => {
    const db = createMockDb({
      transactions: [
        { transaction_id: 't1', amount: 10, date: '2024-01-01', account_id: 'a1' },
        { transaction_id: 't2', amount: 20, date: '2024-06-01', account_id: 'a1' },
      ],
    });
    const tools = new CopilotMoneyTools(db);

    db.getCacheInfo = async () => ({
      oldest_transaction_date: '2024-01-01',
      newest_transaction_date: '2024-06-01',
      transaction_count: 2,
      cache_note: 'test',
    });

    const result = await tools.refreshDatabase();

    expect(result.refreshed).toBe(true);
    expect(result.message).toContain('refreshed');
    expect(result.cache_info.transaction_count).toBe(2);
    expect(result.cache_info.oldest_transaction_date).toBe('2024-01-01');
    expect(result.cache_info.newest_transaction_date).toBe('2024-06-01');
  });

  test('reports cleared=false when cache was already empty', async () => {
    const db = createMockDb();
    (db as any)._transactions = null;
    (db as any)._accounts = null;
    (db as any)._allCollectionsLoaded = false;

    const tools = new CopilotMoneyTools(db);

    db.getCacheInfo = async () => ({
      oldest_transaction_date: null,
      newest_transaction_date: null,
      transaction_count: 0,
      cache_note: 'empty',
    });

    const result = await tools.refreshDatabase();

    expect(result.refreshed).toBe(false);
    expect(result.message).toContain('already empty');
  });

  test('second consecutive refresh returns refreshed=false after cache was cleared', async () => {
    const db = createMockDb({
      transactions: [{ transaction_id: 't1', amount: 5, date: '2024-02-01', account_id: 'a1' }],
    });
    const tools = new CopilotMoneyTools(db);

    let callCount = 0;
    db.getCacheInfo = async () => {
      callCount++;
      return {
        oldest_transaction_date: '2024-02-01',
        newest_transaction_date: '2024-02-01',
        transaction_count: 1,
        cache_note: `call ${callCount}`,
      };
    };

    const r1 = await tools.refreshDatabase();
    const r2 = await tools.refreshDatabase();

    expect(r1.refreshed).toBe(true);
    expect(r2.refreshed).toBe(false);
    expect(r1.cache_info.transaction_count).toBe(1);
    expect(r2.cache_info.transaction_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-tool interaction tests
// ---------------------------------------------------------------------------

describe('cross-tool interactions', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  const baseTxn: Transaction = {
    transaction_id: 'txn_cross',
    amount: 42,
    date: '2024-05-10',
    name: 'Test Txn',
    category_id: 'food_and_drink',
    account_id: 'acct1',
    item_id: 'item1',
  };

  const baseCategories: Category[] = [
    { category_id: 'food_and_drink', name: 'Food & Drink', user_id: 'test-user-123' },
    { category_id: 'shopping', name: 'Shopping', user_id: 'test-user-123' },
  ];

  /** Write tools clear the cache; this restores it so subsequent reads work. */
  function repopulateCache(
    extra: {
      transactions?: Transaction[];
      categories?: Category[];
      budgets?: Budget[];
      tags?: Tag[];
      goals?: Goal[];
    } = {}
  ) {
    const a = db as any;
    a._transactions = extra.transactions ?? [{ ...baseTxn }];
    a._userCategories = extra.categories ?? [...baseCategories];
    a._budgets = extra.budgets ?? [];
    a._tags = extra.tags ?? [];
    a._goals = extra.goals ?? [{ goal_id: 'goal1', name: 'Emergency Fund' }];
    a._allCollectionsLoaded = true;
    a._cacheLoadedAt = Date.now();
  }

  beforeEach(() => {
    const client = createMockClient();
    db = createMockDb({
      transactions: [{ ...baseTxn }],
      userCategories: [...baseCategories],
      tags: [],
      goals: [{ goal_id: 'goal1', name: 'Emergency Fund' }],
      budgets: [],
    });
    tools = new CopilotMoneyTools(db, client);
  });

  test('createCategory then createBudget referencing the new category', async () => {
    const catResult = await tools.createCategory({ name: 'Streaming' });
    expect(catResult.success).toBe(true);

    repopulateCache({
      categories: [...baseCategories, { category_id: catResult.category_id, name: 'Streaming' }],
    });

    const budgetResult = await tools.createBudget({
      category_id: catResult.category_id,
      amount: 15,
    });
    expect(budgetResult.success).toBe(true);
    expect(budgetResult.category_id).toBe(catResult.category_id);
    expect(budgetResult.amount).toBe(15);
  });

  test('createTag then update_transaction sets the new tag', async () => {
    const tagResult = await tools.createTag({ name: 'urgent' });
    expect(tagResult.success).toBe(true);

    repopulateCache({
      tags: [{ tag_id: tagResult.tag_id, name: 'urgent' }],
    });

    const updateResult = await tools.updateTransaction({
      transaction_id: 'txn_cross',
      tag_ids: [tagResult.tag_id],
    });
    expect(updateResult.success).toBe(true);
    expect(updateResult.updated).toEqual(['tag_ids']);
  });

  test('createCategory then update_transaction assigns it', async () => {
    const catResult = await tools.createCategory({ name: 'Custom Cat' });
    expect(catResult.success).toBe(true);

    repopulateCache({
      categories: [...baseCategories, { category_id: catResult.category_id, name: 'Custom Cat' }],
    });

    const updateResult = await tools.updateTransaction({
      transaction_id: 'txn_cross',
      category_id: catResult.category_id,
    });
    expect(updateResult.success).toBe(true);
    expect(updateResult.updated).toEqual(['category_id']);
  });

  test('reviewTransactions then unmark', async () => {
    const txn2: Transaction = {
      transaction_id: 'txn_cross2',
      amount: 10,
      date: '2024-05-11',
      name: 'Second Txn',
      category_id: 'shopping',
      account_id: 'acct1',
      item_id: 'item1',
    };
    (db as any)._transactions = [{ ...baseTxn }, txn2];

    const reviewResult = await tools.reviewTransactions({
      transaction_ids: ['txn_cross', 'txn_cross2'],
      reviewed: true,
    });
    expect(reviewResult.success).toBe(true);
    expect(reviewResult.reviewed_count).toBe(2);

    const unmarkResult = await tools.reviewTransactions({
      transaction_ids: ['txn_cross', 'txn_cross2'],
      reviewed: false,
    });
    expect(unmarkResult.success).toBe(true);
    expect(unmarkResult.reviewed_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Write-tool edge cases
// ---------------------------------------------------------------------------

describe('write-tool edge cases', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  const writeTxn: Transaction = {
    transaction_id: 'txn_edge',
    amount: 77,
    date: '2024-04-20',
    name: 'Edge Case Txn',
    category_id: 'food_and_drink',
    account_id: 'acct1',
    item_id: 'item1',
    user_note: 'old note',
    tag_ids: ['existing_tag'],
  };

  beforeEach(() => {
    const client = createMockClient();
    db = createMockDb({
      transactions: [{ ...writeTxn }],
      userCategories: [
        { category_id: 'food_and_drink', name: 'Food & Drink', user_id: 'test-user-123' },
      ],
      tags: [],
      goals: [],
      budgets: [],
    });
    tools = new CopilotMoneyTools(db, client);
  });

  test('createTag with Unicode-only name throws (no valid id chars)', async () => {
    await expect(tools.createTag({ name: '\u{1F680}\u{1F525}' })).rejects.toThrow(
      'Cannot generate a valid tag_id'
    );
  });

  test('createTag with mixed Unicode and ASCII uses ASCII portion', async () => {
    const result = await tools.createTag({ name: 'caf\u00e9 latte' });
    expect(result.success).toBe(true);
    expect(result.tag_id).toBe('caf_latte');
    expect(result.name).toBe('caf\u00e9 latte');
  });

  test('createTag replaces each stripped char with its own underscore (no collapsing)', async () => {
    // 'café & bar' is transformed in two steps:
    //   1. spaces → '_': 'café_&_bar'
    //   2. strip non-[a-z0-9_-]: 'é' and '&' dropped → 'caf__bar'
    // The two underscores come from the spaces flanking '&' (step 1);
    // 'é' itself is stripped in step 2, not replaced with an underscore.
    // The contract is that consecutive underscores are NOT collapsed.
    const result = await tools.createTag({ name: 'caf\u00e9 & bar' });
    expect(result.tag_id).toBe('caf__bar');
  });

  test('createBudget for duplicate category throws', async () => {
    (db as any)._budgets = [
      { budget_id: 'b1', category_id: 'food_and_drink', amount: 200, period: 'monthly' },
    ];

    await expect(
      tools.createBudget({ category_id: 'food_and_drink', amount: 100 })
    ).rejects.toThrow('already exists');
  });
});
