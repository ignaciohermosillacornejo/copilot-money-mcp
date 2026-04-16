/**
 * Unit tests for CopilotDatabase abstraction layer.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { CopilotDatabase } from '../../src/core/database.js';
import type { Transaction, Account, Recurring, Security } from '../../src/models/index.js';
import type { BalanceHistory } from '../../src/models/balance-history.js';
import type { InvestmentPerformance, TwrHolding } from '../../src/models/investment-performance.js';

// Mock the decoder functions
// Copilot Money format: positive = expenses, negative = income
const mockTransactions: Transaction[] = [
  {
    transaction_id: 'txn1',
    amount: 50.0, // Expense (positive in Copilot format)
    date: '2024-01-15',
    name: 'Coffee Shop',
    category_id: 'food_dining',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn2',
    amount: 120.5, // Expense (positive in Copilot format)
    date: '2024-01-20',
    name: 'Grocery Store',
    category_id: 'groceries',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn3',
    amount: 25.0, // Expense (positive in Copilot format)
    date: '2024-02-10',
    original_name: 'Fast Food',
    category_id: 'food_dining',
    account_id: 'acc2',
  },
];

const mockAccounts: Account[] = [
  {
    account_id: 'acc1',
    current_balance: 1500.0,
    name: 'Checking Account',
    account_type: 'checking',
  },
  {
    account_id: 'acc2',
    current_balance: 500.0,
    official_name: 'Savings Account',
    account_type: 'savings',
  },
];

const mockRecurring: Recurring[] = [
  {
    recurring_id: 'rec_active1234',
    name: 'Netflix',
    amount: 15.99,
    frequency: 'monthly',
    is_active: true,
  },
  {
    recurring_id: 'rec_inactive123',
    name: 'Old Gym',
    amount: 50.0,
    frequency: 'monthly',
    is_active: false,
  },
  {
    recurring_id: 'rec_unknown1234',
    name: 'Unknown Status Subscription',
    amount: 9.99,
    frequency: 'monthly',
    // is_active is undefined
  },
];

describe('CopilotDatabase', () => {
  let db: CopilotDatabase;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    // Override the private _transactions, _accounts, and _recurring fields
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
    (db as any)._recurring = [...mockRecurring];
    // Add required cache fields for async database methods
    (db as any)._budgets = [];
    (db as any)._goals = [];
    (db as any)._goalHistory = [];
    (db as any)._investmentPrices = [];
    (db as any)._investmentSplits = [];
    (db as any)._items = [];
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
    (db as any)._categoryNameMap = new Map<string, string>();
    (db as any)._accountNameMap = new Map<string, string>();
  });

  describe('getTransactions', () => {
    test('returns all transactions when no filters applied', async () => {
      const result = await db.getTransactions();
      expect(result).toHaveLength(3);
    });

    test('filters by start date', async () => {
      const result = await db.getTransactions({ startDate: '2024-02-01' });
      expect(result).toHaveLength(1);
      expect(result[0].transaction_id).toBe('txn3');
    });

    test('filters by end date', async () => {
      const result = await db.getTransactions({ endDate: '2024-01-31' });
      expect(result).toHaveLength(2);
    });

    test('filters by category (case-insensitive)', async () => {
      const result = await db.getTransactions({ category: 'FOOD' });
      expect(result).toHaveLength(2);
      expect(result.every((txn) => txn.category_id?.includes('food'))).toBe(true);
    });

    test('filters by merchant name', async () => {
      const result = await db.getTransactions({ merchant: 'coffee' });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Coffee Shop');
    });

    test('filters by account ID', async () => {
      const result = await db.getTransactions({ accountId: 'acc1' });
      expect(result).toHaveLength(2);
    });

    test('filters by min amount', async () => {
      const result = await db.getTransactions({ minAmount: 50.0 });
      expect(result).toHaveLength(2);
    });

    test('filters by max amount', async () => {
      const result = await db.getTransactions({ maxAmount: 50.0 });
      expect(result).toHaveLength(2);
    });

    test('applies limit correctly', async () => {
      const result = await db.getTransactions({ limit: 2 });
      expect(result).toHaveLength(2);
    });

    test('combines multiple filters', async () => {
      const result = await db.getTransactions({
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        category: 'food',
      });
      expect(result).toHaveLength(1);
      expect(result[0].transaction_id).toBe('txn1');
    });
  });

  describe('searchTransactions', () => {
    test('finds transactions by merchant name', async () => {
      const result = await db.searchTransactions('grocery');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Grocery Store');
    });

    test('is case-insensitive', async () => {
      const result = await db.searchTransactions('COFFEE');
      expect(result).toHaveLength(1);
    });

    test('uses original_name when name is not present', async () => {
      const result = await db.searchTransactions('fast');
      expect(result).toHaveLength(1);
      expect(result[0].original_name).toBe('Fast Food');
    });

    test('applies limit correctly', async () => {
      const result = await db.searchTransactions('food', 0);
      expect(result).toHaveLength(0);
    });
  });

  describe('getAccounts', () => {
    test('returns all accounts when no filter applied', async () => {
      const result = await db.getAccounts();
      expect(result).toHaveLength(2);
    });

    test('filters by account type', async () => {
      const result = await db.getAccounts('checking');
      expect(result).toHaveLength(1);
      expect(result[0].account_type).toBe('checking');
    });

    test('account type filter is case-insensitive', async () => {
      const result = await db.getAccounts('SAVINGS');
      expect(result).toHaveLength(1);
    });
  });

  describe('getCategories', () => {
    test('returns unique categories from transactions', async () => {
      const result = await db.getCategories();
      expect(result).toHaveLength(2);

      const categoryIds = result.map((c) => c.category_id);
      expect(categoryIds).toContain('food_dining');
      expect(categoryIds).toContain('groceries');
    });

    test('category name is human-readable', async () => {
      const result = await db.getCategories();
      const foodCategory = result.find((c) => c.category_id === 'food_dining');
      expect(foodCategory?.name).toBe('Food & Drink');
    });
  });

  describe('isAvailable', () => {
    test('returns false for non-existent path', async () => {
      const db = new CopilotDatabase('/fake/nonexistent/path');
      expect(db.isAvailable()).toBe(false);
    });
  });

  describe('getDbPath', () => {
    test('returns the database path', async () => {
      expect(db.getDbPath()).toBe('/fake/path');
    });
  });

  describe('getRecurring', () => {
    test('returns all recurring transactions when activeOnly is false', async () => {
      const result = await db.getRecurring(false);
      expect(result).toHaveLength(3);
    });

    test('returns all recurring transactions when no parameter passed', async () => {
      const result = await db.getRecurring();
      expect(result).toHaveLength(3);
    });

    test('filters to only active when activeOnly is true', async () => {
      const result = await db.getRecurring(true);
      expect(result).toHaveLength(2);
      // Should include active and undefined
      const ids = result.map((r) => r.recurring_id);
      expect(ids).toContain('rec_active1234');
      expect(ids).toContain('rec_unknown1234');
      expect(ids).not.toContain('rec_inactive123');
    });

    test('includes undefined is_active as active when activeOnly is true', async () => {
      const result = await db.getRecurring(true);
      const unknownStatus = result.find((r) => r.recurring_id === 'rec_unknown1234');
      expect(unknownStatus).toBeDefined();
      expect(unknownStatus?.is_active).toBeUndefined();
    });

    test('excludes explicitly inactive subscriptions when activeOnly is true', async () => {
      const result = await db.getRecurring(true);
      const inactive = result.find((r) => r.is_active === false);
      expect(inactive).toBeUndefined();
    });
  });

  describe('patchCachedTransaction', () => {
    test('updates category_id on cached transaction', async () => {
      (db as any)._transactions = [
        { transaction_id: 'txn1', amount: 50, date: '2024-01-15', category_id: 'old_cat' },
        { transaction_id: 'txn2', amount: 30, date: '2024-01-16', category_id: 'other' },
      ];

      const result = db.patchCachedTransaction('txn1', { category_id: 'new_cat' });
      expect(result).toBe(true);
      const txns = await db.getAllTransactions();
      const txn1 = txns.find((t) => t.transaction_id === 'txn1');
      expect(txn1?.category_id).toBe('new_cat');
    });

    test('returns false when transaction not in cache', () => {
      (db as any)._transactions = [{ transaction_id: 'txn1', amount: 50, date: '2024-01-15' }];
      const result = db.patchCachedTransaction('nonexistent', { category_id: 'x' });
      expect(result).toBe(false);
    });

    test('returns false when cache is empty', () => {
      (db as any)._transactions = null;
      const result = db.patchCachedTransaction('txn1', { category_id: 'x' });
      expect(result).toBe(false);
    });

    test('does not affect other transactions', () => {
      (db as any)._transactions = [
        { transaction_id: 'txn1', amount: 50, date: '2024-01-15', category_id: 'old' },
        { transaction_id: 'txn2', amount: 30, date: '2024-01-16', category_id: 'keep' },
      ];
      db.patchCachedTransaction('txn1', { category_id: 'new' });
      const txn2 = ((db as any)._transactions as any[]).find((t) => t.transaction_id === 'txn2');
      expect(txn2?.category_id).toBe('keep');
    });

    test('can patch multiple fields at once', () => {
      (db as any)._transactions = [
        {
          transaction_id: 'txn1',
          amount: 50,
          date: '2024-01-15',
          category_id: 'old',
          user_reviewed: false,
        },
      ];
      db.patchCachedTransaction('txn1', { category_id: 'new', user_reviewed: true });
      const txn = ((db as any)._transactions as any[])[0];
      expect(txn.category_id).toBe('new');
      expect(txn.user_reviewed).toBe(true);
    });
  });

  describe('patchCachedBudget (issue #278 follow-up)', () => {
    const currentMonth = (): string => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };

    test('updates amounts[current_month] on an existing budget matched by category_id', () => {
      (db as any)._budgets = [
        { budget_id: 'b1', category_id: 'cat_food', amount: 0, amounts: {} },
        { budget_id: 'b2', category_id: 'cat_rent', amount: 2000, amounts: {} },
      ];
      const month = currentMonth();

      const result = db.patchCachedBudget('cat_food', 250);

      expect(result).toBe(true);
      const budgets = (db as any)._budgets as Array<{
        category_id: string;
        amounts: Record<string, number>;
      }>;
      expect(budgets.find((b) => b.category_id === 'cat_food')!.amounts[month]).toBe(250);
      // Other budgets untouched
      expect(budgets.find((b) => b.category_id === 'cat_rent')!.amounts).toEqual({});
    });

    test('uses explicit month when provided', () => {
      (db as any)._budgets = [
        { budget_id: 'b1', category_id: 'cat_food', amount: 0, amounts: { '2026-01': 100 } },
      ];

      db.patchCachedBudget('cat_food', 175, '2026-07');

      const b = ((db as any)._budgets as Array<{ amounts: Record<string, number> }>)[0]!;
      expect(b.amounts['2026-07']).toBe(175);
      expect(b.amounts['2026-01']).toBe(100); // untouched
    });

    test('treats amount=0 as explicit clear (stored as 0, not skipped)', () => {
      (db as any)._budgets = [
        { budget_id: 'b1', category_id: 'cat_food', amount: 250, amounts: { '2026-04': 250 } },
      ];

      db.patchCachedBudget('cat_food', 0, '2026-04');

      const b = ((db as any)._budgets as Array<{ amounts: Record<string, number> }>)[0]!;
      expect(b.amounts['2026-04']).toBe(0);
    });

    test('initializes amounts map when the existing budget has no map', () => {
      (db as any)._budgets = [{ budget_id: 'b1', category_id: 'cat_food', amount: 0 }]; // no amounts key
      const month = currentMonth();

      db.patchCachedBudget('cat_food', 300);

      const b = ((db as any)._budgets as Array<{ amounts?: Record<string, number> }>)[0]!;
      expect(b.amounts?.[month]).toBe(300);
    });

    test('creates a new budget entry when no budget exists for the category', () => {
      (db as any)._budgets = [
        { budget_id: 'b1', category_id: 'cat_rent', amount: 2000, amounts: {} },
      ];
      const month = currentMonth();

      const result = db.patchCachedBudget('cat_new', 500);

      expect(result).toBe(true);
      const budgets = (db as any)._budgets as Array<{
        category_id?: string;
        amounts?: Record<string, number>;
      }>;
      expect(budgets).toHaveLength(2);
      const created = budgets.find((b) => b.category_id === 'cat_new')!;
      expect(created.amounts?.[month]).toBe(500);
    });

    test('returns false when budgets cache is not loaded', () => {
      (db as any)._budgets = null;

      const result = db.patchCachedBudget('cat_food', 250);

      expect(result).toBe(false);
    });
  });

  describe('patchCachedTagUpsert / patchCachedTagDelete', () => {
    test('upsert adds a new tag when id does not exist', () => {
      (db as any)._tags = [{ tag_id: 't1', name: 'Existing', color_name: 'RED1' }];

      db.patchCachedTagUpsert({ tag_id: 't2', name: 'New Tag', color_name: 'OLIVE1' });

      const tags = (db as any)._tags as Array<{ tag_id: string; name?: string }>;
      expect(tags).toHaveLength(2);
      expect(tags.find((t) => t.tag_id === 't2')?.name).toBe('New Tag');
    });

    test('upsert merges fields into an existing tag', () => {
      (db as any)._tags = [{ tag_id: 't1', name: 'Old', color_name: 'RED1' }];

      db.patchCachedTagUpsert({ tag_id: 't1', name: 'Updated' });

      const tag = (
        (db as any)._tags as Array<{ tag_id: string; name?: string; color_name?: string }>
      )[0]!;
      expect(tag.name).toBe('Updated');
      expect(tag.color_name).toBe('RED1'); // preserved
    });

    test('delete removes the tag by id', () => {
      (db as any)._tags = [
        { tag_id: 't1', name: 'Keep' },
        { tag_id: 't2', name: 'Remove' },
      ];

      const result = db.patchCachedTagDelete('t2');

      expect(result).toBe(true);
      expect((db as any)._tags).toHaveLength(1);
      expect(((db as any)._tags as Array<{ tag_id: string }>)[0]!.tag_id).toBe('t1');
    });

    test('patchers are no-ops when cache is not loaded', () => {
      (db as any)._tags = null;
      expect(db.patchCachedTagDelete('t1')).toBe(false);
      // upsert does nothing (no exception); cache stays null so next load is fresh
      db.patchCachedTagUpsert({ tag_id: 't1', name: 'X' });
      expect((db as any)._tags).toBeNull();
    });
  });

  describe('patchCachedCategoryUpsert / patchCachedCategoryDelete', () => {
    test('upsert adds a new category and invalidates category name map', () => {
      (db as any)._userCategories = [{ category_id: 'c1', name: 'Existing' }];
      (db as any)._categoryNameMap = new Map([['c1', 'Existing']]);

      db.patchCachedCategoryUpsert({ category_id: 'c2', name: 'New Category' });

      expect((db as any)._userCategories).toHaveLength(2);
      expect((db as any)._categoryNameMap).toBeNull();
    });

    test('upsert updates an existing category by id', () => {
      (db as any)._userCategories = [{ category_id: 'c1', name: 'Old', emoji: '🍕' }];
      (db as any)._categoryNameMap = new Map([['c1', 'Old']]);

      db.patchCachedCategoryUpsert({ category_id: 'c1', name: 'New' });

      const cat = ((db as any)._userCategories as Array<{ name?: string; emoji?: string }>)[0]!;
      expect(cat.name).toBe('New');
      expect(cat.emoji).toBe('🍕'); // preserved
      expect((db as any)._categoryNameMap).toBeNull();
    });

    test('delete removes the category and invalidates the name map', () => {
      (db as any)._userCategories = [
        { category_id: 'c1', name: 'Keep' },
        { category_id: 'c2', name: 'Remove' },
      ];
      (db as any)._categoryNameMap = new Map([
        ['c1', 'Keep'],
        ['c2', 'Remove'],
      ]);

      const result = db.patchCachedCategoryDelete('c2');

      expect(result).toBe(true);
      expect((db as any)._userCategories).toHaveLength(1);
      expect((db as any)._categoryNameMap).toBeNull();
    });
  });

  describe('patchCachedRecurringUpsert / patchCachedRecurringDelete', () => {
    test('upsert adds a new recurring', () => {
      (db as any)._recurring = [{ recurring_id: 'r1', name: 'Spotify' }];

      db.patchCachedRecurringUpsert({ recurring_id: 'r2', name: 'Netflix', state: 'active' });

      expect((db as any)._recurring).toHaveLength(2);
    });

    test('upsert merges fields into existing recurring', () => {
      (db as any)._recurring = [{ recurring_id: 'r1', name: 'Spotify', state: 'active' }];

      db.patchCachedRecurringUpsert({ recurring_id: 'r1', state: 'paused' });

      const rec = ((db as any)._recurring as Array<{ name?: string; state?: string }>)[0]!;
      expect(rec.state).toBe('paused');
      expect(rec.name).toBe('Spotify'); // preserved
    });

    test('delete removes the recurring by id', () => {
      (db as any)._recurring = [
        { recurring_id: 'r1', name: 'Keep' },
        { recurring_id: 'r2', name: 'Remove' },
      ];

      const result = db.patchCachedRecurringDelete('r2');

      expect(result).toBe(true);
      expect((db as any)._recurring).toHaveLength(1);
    });
  });

  describe('Cache TTL configuration', () => {
    const originalEnv = process.env.COPILOT_CACHE_TTL_MINUTES;

    // Mirrors DEFAULT_CACHE_TTL_MINUTES in src/core/database.ts. If that
    // constant changes, update this value and the fresh/stale boundaries
    // below that straddle it.
    const DEFAULT_TTL_MINUTES = 5;
    const MINUTE_MS = 60 * 1000;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.COPILOT_CACHE_TTL_MINUTES;
      } else {
        process.env.COPILOT_CACHE_TTL_MINUTES = originalEnv;
      }
    });

    test('uses custom TTL from environment variable', () => {
      const customTtlMinutes = 10;
      process.env.COPILOT_CACHE_TTL_MINUTES = String(customTtlMinutes);

      const testDb = new CopilotDatabase('/fake/path');
      // Just-loaded cache is fresh under a 10-minute TTL.
      (testDb as any)._cacheLoadedAt = Date.now();
      expect((testDb as any).isCacheStale()).toBe(false);

      // Straddle the 10-minute boundary.
      (testDb as any)._cacheLoadedAt = Date.now() - (customTtlMinutes - 1) * MINUTE_MS;
      expect((testDb as any).isCacheStale()).toBe(false);
      (testDb as any)._cacheLoadedAt = Date.now() - (customTtlMinutes + 1) * MINUTE_MS;
      expect((testDb as any).isCacheStale()).toBe(true);
    });

    test('disables caching when TTL is 0', () => {
      process.env.COPILOT_CACHE_TTL_MINUTES = '0';

      const testDb = new CopilotDatabase('/fake/path');
      // Even with a freshly-loaded cache, TTL=0 means always stale.
      (testDb as any)._cacheLoadedAt = Date.now();
      expect((testDb as any).isCacheStale()).toBe(true);
    });

    test('falls back to default TTL for invalid env value', () => {
      process.env.COPILOT_CACHE_TTL_MINUTES = 'not-a-number';

      const testDb = new CopilotDatabase('/fake/path');
      // Straddle the default-TTL boundary.
      (testDb as any)._cacheLoadedAt = Date.now() - (DEFAULT_TTL_MINUTES - 1) * MINUTE_MS;
      expect((testDb as any).isCacheStale()).toBe(false);
      (testDb as any)._cacheLoadedAt = Date.now() - (DEFAULT_TTL_MINUTES + 1) * MINUTE_MS;
      expect((testDb as any).isCacheStale()).toBe(true);
    });

    test('falls back to default TTL for negative env value', () => {
      process.env.COPILOT_CACHE_TTL_MINUTES = '-5';

      const testDb = new CopilotDatabase('/fake/path');
      (testDb as any)._cacheLoadedAt = Date.now() - (DEFAULT_TTL_MINUTES - 1) * MINUTE_MS;
      expect((testDb as any).isCacheStale()).toBe(false);
      (testDb as any)._cacheLoadedAt = Date.now() - (DEFAULT_TTL_MINUTES + 1) * MINUTE_MS;
      expect((testDb as any).isCacheStale()).toBe(true);
    });

    test('is stale when cache has never been loaded', () => {
      const testDb = new CopilotDatabase('/fake/path');
      expect((testDb as any)._cacheLoadedAt).toBeNull();
      expect((testDb as any).isCacheStale()).toBe(true);
    });
  });

  describe('getBalanceHistory', () => {
    const mockBalanceHistory: BalanceHistory[] = [
      {
        balance_id: 'item1:acc1:2024-01-15',
        date: '2024-01-15',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1500,
        available_balance: 1450,
      },
      {
        balance_id: 'item1:acc1:2024-02-01',
        date: '2024-02-01',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1600,
        available_balance: 1550,
      },
      {
        balance_id: 'item1:acc2:2024-01-15',
        date: '2024-01-15',
        item_id: 'item1',
        account_id: 'acc2',
        current_balance: 5000,
        available_balance: 5000,
      },
    ];

    beforeEach(() => {
      (db as any)._balanceHistory = [...mockBalanceHistory];
      (db as any)._allCollectionsLoaded = true;
    });

    test('returns all balance history when no filters applied', async () => {
      const result = await db.getBalanceHistory();
      expect(result).toHaveLength(3);
    });

    test('filters by accountId', async () => {
      const result = await db.getBalanceHistory({ accountId: 'acc1' });
      expect(result).toHaveLength(2);
      expect(result.every((h) => h.account_id === 'acc1')).toBe(true);
    });

    test('filters by startDate', async () => {
      const result = await db.getBalanceHistory({ startDate: '2024-02-01' });
      expect(result).toHaveLength(1);
      expect(result[0].date).toBe('2024-02-01');
    });

    test('filters by endDate', async () => {
      const result = await db.getBalanceHistory({ endDate: '2024-01-31' });
      expect(result).toHaveLength(2);
      expect(result.every((h) => h.date <= '2024-01-31')).toBe(true);
    });

    test('combines accountId and date filters', async () => {
      const result = await db.getBalanceHistory({ accountId: 'acc1', startDate: '2024-02-01' });
      expect(result).toHaveLength(1);
      expect(result[0].balance_id).toBe('item1:acc1:2024-02-01');
    });

    test('returns empty array when no data matches', async () => {
      const result = await db.getBalanceHistory({ accountId: 'nonexistent' });
      expect(result).toHaveLength(0);
    });

    test('sorts by account_id asc then date desc', async () => {
      const history = await db.getBalanceHistory();
      for (let i = 1; i < history.length; i++) {
        const prev = history[i - 1]!;
        const curr = history[i]!;
        if (prev.account_id === curr.account_id) {
          expect(prev.date >= curr.date).toBe(true);
        } else {
          expect(prev.account_id < curr.account_id).toBe(true);
        }
      }
    });
  });

  describe('getInvestmentPerformance', () => {
    const mockPerformance: InvestmentPerformance[] = [
      {
        performance_id: 'perf1',
        security_id: 'sec_aapl',
        type: 'equity',
        position: 10,
      },
      {
        performance_id: 'perf2',
        security_id: 'sec_tsla',
        type: 'equity',
        position: 5,
      },
      {
        performance_id: 'perf3',
        // no security_id — top-level aggregate doc
        type: 'aggregate',
      },
    ];

    beforeEach(() => {
      (db as any)._investmentPerformance = [...mockPerformance];
      (db as any)._allCollectionsLoaded = true;
    });

    test('returns all performance records when no filters applied', async () => {
      const result = await db.getInvestmentPerformance();
      expect(result).toHaveLength(3);
    });

    test('filters by securityId', async () => {
      const result = await db.getInvestmentPerformance({ securityId: 'sec_aapl' });
      expect(result).toHaveLength(1);
      expect(result[0].performance_id).toBe('perf1');
    });

    test('returns empty array when securityId does not match', async () => {
      const result = await db.getInvestmentPerformance({ securityId: 'nonexistent' });
      expect(result).toHaveLength(0);
    });
  });

  describe('getTwrHoldings', () => {
    const mockTwrHoldings: TwrHolding[] = [
      {
        twr_id: 'twr1',
        security_id: 'sec_aapl',
        month: '2024-01',
        history: { '1704067200000': { value: 0.05 } },
      },
      {
        twr_id: 'twr2',
        security_id: 'sec_aapl',
        month: '2024-02',
        history: { '1706745600000': { value: 0.03 } },
      },
      {
        twr_id: 'twr3',
        security_id: 'sec_tsla',
        month: '2024-01',
        history: { '1704067200000': { value: -0.02 } },
      },
    ];

    beforeEach(() => {
      (db as any)._twrHoldings = [...mockTwrHoldings];
      (db as any)._allCollectionsLoaded = true;
    });

    test('returns all TWR holdings when no filters applied', async () => {
      const result = await db.getTwrHoldings();
      expect(result).toHaveLength(3);
    });

    test('filters by securityId', async () => {
      const result = await db.getTwrHoldings({ securityId: 'sec_aapl' });
      expect(result).toHaveLength(2);
      expect(result.every((t) => t.security_id === 'sec_aapl')).toBe(true);
    });

    test('filters by startMonth', async () => {
      const result = await db.getTwrHoldings({ startMonth: '2024-02' });
      expect(result).toHaveLength(1);
      expect(result[0].month).toBe('2024-02');
    });

    test('filters by endMonth', async () => {
      const result = await db.getTwrHoldings({ endMonth: '2024-01' });
      expect(result).toHaveLength(2);
      expect(result.every((t) => t.month! <= '2024-01')).toBe(true);
    });

    test('combines securityId and month filters', async () => {
      const result = await db.getTwrHoldings({ securityId: 'sec_aapl', startMonth: '2024-02' });
      expect(result).toHaveLength(1);
      expect(result[0].twr_id).toBe('twr2');
    });

    test('returns empty array when no data matches', async () => {
      const result = await db.getTwrHoldings({ securityId: 'nonexistent' });
      expect(result).toHaveLength(0);
    });
  });

  describe('getSecurities', () => {
    const mockSecurities: Security[] = [
      {
        security_id: 'sec_aapl',
        ticker_symbol: 'AAPL',
        name: 'Apple Inc.',
        type: 'equity',
        current_price: 175.0,
      },
      {
        security_id: 'sec_spy',
        ticker_symbol: 'SPY',
        name: 'SPDR S&P 500 ETF Trust',
        type: 'etf',
        current_price: 450.0,
      },
      {
        security_id: 'sec_tsla',
        ticker_symbol: 'TSLA',
        name: 'Tesla, Inc.',
        type: 'equity',
        current_price: 200.0,
      },
      {
        security_id: 'sec_vmmxx',
        ticker_symbol: 'VMMXX',
        name: 'Vanguard Federal Money Market Fund',
        type: 'mutual fund',
        is_cash_equivalent: true,
      },
    ];

    beforeEach(() => {
      (db as any)._securities = [...mockSecurities];
      (db as any)._allCollectionsLoaded = true;
    });

    test('returns all securities when no filters applied', async () => {
      const result = await db.getSecurities();
      expect(result).toHaveLength(4);
    });

    test('filters by tickerSymbol (exact, case-insensitive)', async () => {
      const result = await db.getSecurities({ tickerSymbol: 'aapl' });
      expect(result).toHaveLength(1);
      expect(result[0].security_id).toBe('sec_aapl');
    });

    test('tickerSymbol filter is case-insensitive', async () => {
      const result = await db.getSecurities({ tickerSymbol: 'TSLA' });
      expect(result).toHaveLength(1);
      expect(result[0].ticker_symbol).toBe('TSLA');
    });

    test('filters by type', async () => {
      const result = await db.getSecurities({ type: 'equity' });
      expect(result).toHaveLength(2);
      expect(result.every((s) => s.type === 'equity')).toBe(true);
    });

    test('filters by type etf', async () => {
      const result = await db.getSecurities({ type: 'etf' });
      expect(result).toHaveLength(1);
      expect(result[0].ticker_symbol).toBe('SPY');
    });

    test('combines tickerSymbol and type filters', async () => {
      const result = await db.getSecurities({ tickerSymbol: 'AAPL', type: 'equity' });
      expect(result).toHaveLength(1);
      expect(result[0].security_id).toBe('sec_aapl');
    });

    test('returns empty array when tickerSymbol does not match', async () => {
      const result = await db.getSecurities({ tickerSymbol: 'NONEXISTENT' });
      expect(result).toHaveLength(0);
    });

    test('returns empty array when type does not match', async () => {
      const result = await db.getSecurities({ type: 'bond' });
      expect(result).toHaveLength(0);
    });
  });
});
