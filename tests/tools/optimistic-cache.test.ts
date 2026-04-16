/**
 * Integration tests for optimistic in-memory cache patching after writes.
 *
 * Each test: (1) inject cache fixture, (2) call the write tool against a mock
 * GraphQL client, (3) call the corresponding read tool WITHOUT
 * refresh_database, (4) assert the new value is visible. This proves the
 * `patchCached*` wiring makes writes observable without re-decoding LevelDB.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';

const currentMonth = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

describe('optimistic cache patching — transactions', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake');
    (db as any)._allCollectionsLoaded = true;
    (db as any)._cacheLoadedAt = Date.now();
    (db as any)._transactions = [
      {
        transaction_id: 'txn1',
        amount: 50,
        date: '2026-04-01',
        name: 'Coffee',
        category_id: 'cat_food',
        account_id: 'acc1',
        item_id: 'item1',
        user_note: 'old note',
        user_reviewed: false,
      },
    ];
    (db as any)._userCategories = [{ category_id: 'cat_new', name: 'Dining' }];
    (db as any)._tags = [];
  });

  test('update_transaction — read reflects new note without refresh', async () => {
    const client = createMockGraphQLClient({
      EditTransaction: {
        editTransaction: {
          transaction: {
            id: 'txn1',
            categoryId: 'cat_food',
            userNotes: 'new note',
            isReviewed: false,
            tags: [],
          },
        },
      },
    });
    tools = new CopilotMoneyTools(db, client);

    await tools.updateTransaction({ transaction_id: 'txn1', note: 'new note' });
    const after = await db.getAllTransactions();
    const t = after.find((x) => x.transaction_id === 'txn1');

    expect(t?.user_note).toBe('new note');
  });

  test('review_transactions — every id in batch is marked reviewed in cache', async () => {
    (db as any)._transactions = [
      {
        transaction_id: 't1',
        amount: 10,
        date: '2026-04-01',
        account_id: 'a',
        item_id: 'i',
        user_reviewed: false,
      },
      {
        transaction_id: 't2',
        amount: 20,
        date: '2026-04-02',
        account_id: 'a',
        item_id: 'i',
        user_reviewed: false,
      },
    ];
    const client = createMockGraphQLClient({
      EditTransaction: {
        editTransaction: {
          transaction: { id: 't1', categoryId: '', userNotes: null, isReviewed: true, tags: [] },
        },
      },
    });
    tools = new CopilotMoneyTools(db, client);

    await tools.reviewTransactions({ transaction_ids: ['t1', 't2'], reviewed: true });
    const after = await db.getAllTransactions();

    expect(after.find((t) => t.transaction_id === 't1')?.user_reviewed).toBe(true);
    expect(after.find((t) => t.transaction_id === 't2')?.user_reviewed).toBe(true);
  });
});

describe('optimistic cache patching — tags', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake');
    (db as any)._allCollectionsLoaded = true;
    (db as any)._cacheLoadedAt = Date.now();
    (db as any)._tags = [{ tag_id: 'existing', name: 'Existing', color_name: 'RED1' }];
  });

  test('create_tag — new tag appears in getTags', async () => {
    const client = createMockGraphQLClient({
      CreateTag: {
        createTag: { id: 'new_tag', name: 'New', colorName: 'OLIVE1' },
      },
    });
    tools = new CopilotMoneyTools(db, client);

    await tools.createTag({ name: 'New', color_name: 'OLIVE1' });
    const tags = await db.getTags();

    expect(tags.find((t) => t.tag_id === 'new_tag')?.name).toBe('New');
  });

  test('update_tag — cached tag reflects new color', async () => {
    const client = createMockGraphQLClient({
      EditTag: {
        editTag: { id: 'existing', name: 'Existing', colorName: 'BLUE1' },
      },
    });
    tools = new CopilotMoneyTools(db, client);

    await tools.updateTag({ tag_id: 'existing', color_name: 'BLUE1' });
    const tags = await db.getTags();

    expect(tags.find((t) => t.tag_id === 'existing')?.color_name).toBe('BLUE1');
  });

  test('delete_tag — tag no longer in getTags', async () => {
    const client = createMockGraphQLClient({ DeleteTag: { deleteTag: true } });
    tools = new CopilotMoneyTools(db, client);

    await tools.deleteTag({ tag_id: 'existing' });
    const tags = await db.getTags();

    expect(tags.find((t) => t.tag_id === 'existing')).toBeUndefined();
  });
});

describe('optimistic cache patching — categories', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake');
    (db as any)._allCollectionsLoaded = true;
    (db as any)._cacheLoadedAt = Date.now();
    (db as any)._userCategories = [{ category_id: 'cat1', name: 'Old Name', excluded: false }];
    (db as any)._categoryNameMap = new Map([['cat1', 'Old Name']]);
  });

  test('create_category — new category appears in cache without refresh', async () => {
    const client = createMockGraphQLClient({
      CreateCategory: {
        createCategory: { id: 'cat2', name: 'Travel', colorName: 'BLUE2' },
      },
    });
    tools = new CopilotMoneyTools(db, client);

    await tools.createCategory({
      name: 'Travel',
      color_name: 'BLUE2',
      emoji: '✈️',
      is_excluded: false,
    });
    const cats = await db.getUserCategories();

    expect(cats.find((c) => c.category_id === 'cat2')?.name).toBe('Travel');
    // Name-map invalidation: new category's name resolves through getCategoryNameMap.
    const map = await db.getCategoryNameMap();
    expect(map.get('cat2')).toBe('Travel');
  });

  test('update_category — rename visible without refresh, name map invalidated', async () => {
    const client = createMockGraphQLClient({
      EditCategory: {
        editCategory: {
          category: { id: 'cat1', name: 'New Name', colorName: 'RED1' },
        },
      },
    });
    tools = new CopilotMoneyTools(db, client);

    await tools.updateCategory({ category_id: 'cat1', name: 'New Name' });
    const cats = await db.getUserCategories();
    const cat = cats.find((c) => c.category_id === 'cat1');

    expect(cat?.name).toBe('New Name');
    // The cached name-map is eagerly rebuilt on next access; check the new
    // name comes through resolveCategoryName-style lookups.
    const map = await db.getCategoryNameMap();
    expect(map.get('cat1')).toBe('New Name');
  });

  test('delete_category — removed from cache', async () => {
    const client = createMockGraphQLClient({ DeleteCategory: { deleteCategory: true } });
    tools = new CopilotMoneyTools(db, client);

    await tools.deleteCategory({ category_id: 'cat1' });
    const cats = await db.getUserCategories();

    expect(cats.find((c) => c.category_id === 'cat1')).toBeUndefined();
  });
});

describe('optimistic cache patching — budgets (primary motivation for issue #278)', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake');
    (db as any)._allCollectionsLoaded = true;
    (db as any)._cacheLoadedAt = Date.now();
    (db as any)._userCategories = [{ category_id: 'cat_food', name: 'Food' }];
    (db as any)._budgets = [
      {
        budget_id: 'b1',
        category_id: 'cat_food',
        amount: 0, // the frozen legacy field
        amounts: {},
      },
    ];
  });

  test('set_budget without month — get_budgets reflects amount for current month', async () => {
    const client = createMockGraphQLClient({
      EditBudget: { editCategoryBudget: true },
    });
    tools = new CopilotMoneyTools(db, client);

    await tools.setBudget({ category_id: 'cat_food', amount: '275.50' });
    const result = await tools.getBudgets({});
    const b = result.budgets.find((x) => x.category_id === 'cat_food')!;

    expect(b.amount).toBe(275.5);
    expect(b.amounts?.[currentMonth()]).toBe(275.5);
  });

  test('set_budget with explicit future month — value lands in amounts map', async () => {
    const client = createMockGraphQLClient({
      EditBudgetMonthly: { editCategoryBudgetMonthly: true },
    });
    tools = new CopilotMoneyTools(db, client);

    await tools.setBudget({ category_id: 'cat_food', amount: '400.00', month: '2026-12' });
    const result = await tools.getBudgets({});
    const b = result.budgets.find((x) => x.category_id === 'cat_food')!;

    expect(b.amounts?.['2026-12']).toBe(400);
  });

  test('set_budget on a category with no prior budget creates a new entry', async () => {
    (db as any)._userCategories = [{ category_id: 'cat_food', name: 'Food' }];
    (db as any)._budgets = []; // no existing budget
    const client = createMockGraphQLClient({
      EditBudget: { editCategoryBudget: true },
    });
    tools = new CopilotMoneyTools(db, client);

    await tools.setBudget({ category_id: 'cat_food', amount: '100.00' });
    const result = await tools.getBudgets({});

    expect(result.budgets.find((x) => x.category_id === 'cat_food')?.amount).toBe(100);
  });
});

describe('optimistic cache patching — recurrings', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake');
    (db as any)._allCollectionsLoaded = true;
    (db as any)._cacheLoadedAt = Date.now();
    (db as any)._transactions = [
      {
        transaction_id: 'seed_txn',
        amount: 9.99,
        date: '2026-04-01',
        name: 'Spotify',
        account_id: 'acc1',
        item_id: 'item1',
      },
    ];
    (db as any)._recurring = [
      { recurring_id: 'r1', name: 'Netflix', state: 'active', frequency: 'MONTHLY' },
    ];
  });

  test('set_recurring_state — state change visible in cache (normalized to lowercase)', async () => {
    const client = createMockGraphQLClient({
      EditRecurring: {
        editRecurring: {
          recurring: {
            id: 'r1',
            name: 'Netflix',
            state: 'PAUSED',
            frequency: 'MONTHLY',
            categoryId: '',
          },
        },
      },
    });
    tools = new CopilotMoneyTools(db, client);

    await tools.setRecurringState({ recurring_id: 'r1', state: 'PAUSED' });
    const recs = (db as any)._recurring as Array<{ recurring_id: string; state?: string }>;

    expect(recs.find((r) => r.recurring_id === 'r1')?.state).toBe('paused');
  });

  test('create_recurring — new recurring appears in cache', async () => {
    const client = createMockGraphQLClient({
      CreateRecurring: {
        createRecurring: {
          id: 'new_rec',
          name: 'Spotify',
          state: 'ACTIVE',
          frequency: 'MONTHLY',
          categoryId: '',
        },
      },
    });
    tools = new CopilotMoneyTools(db, client);

    await tools.createRecurring({ transaction_id: 'seed_txn', frequency: 'MONTHLY' });
    const recs = (db as any)._recurring as Array<{ recurring_id: string }>;

    expect(recs.find((r) => r.recurring_id === 'new_rec')).toBeDefined();
  });

  test('delete_recurring — removed from cache', async () => {
    const client = createMockGraphQLClient({ DeleteRecurring: { deleteRecurring: true } });
    tools = new CopilotMoneyTools(db, client);

    await tools.deleteRecurring({ recurring_id: 'r1' });
    const recs = (db as any)._recurring as Array<{ recurring_id: string }>;

    expect(recs.find((r) => r.recurring_id === 'r1')).toBeUndefined();
  });
});
