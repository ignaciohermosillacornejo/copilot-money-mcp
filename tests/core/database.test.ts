/**
 * Unit tests for CopilotDatabase abstraction layer.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { CopilotDatabase } from '../../src/core/database.js';
import type { Transaction, Account, Recurring } from '../../src/models/index.js';

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

  describe('Cache TTL configuration', () => {
    const originalEnv = process.env.COPILOT_CACHE_TTL_MINUTES;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.COPILOT_CACHE_TTL_MINUTES;
      } else {
        process.env.COPILOT_CACHE_TTL_MINUTES = originalEnv;
      }
    });

    test('uses custom TTL from environment variable', async () => {
      process.env.COPILOT_CACHE_TTL_MINUTES = '10';

      // Create a new database to pick up the env var
      const testDb = new CopilotDatabase('/fake/path');
      (testDb as any)._transactions = [...mockTransactions];
      (testDb as any)._accounts = [...mockAccounts];
      (testDb as any)._recurring = [...mockRecurring];
      (testDb as any)._budgets = [];
      (testDb as any)._goals = [];
      (testDb as any)._goalHistory = [];
      (testDb as any)._investmentPrices = [];
      (testDb as any)._investmentSplits = [];
      (testDb as any)._items = [];
      (testDb as any)._userCategories = [];
      (testDb as any)._userAccounts = [];
      (testDb as any)._cacheLoadedAt = Date.now();

      // The cache should not be stale since we just set cacheLoadedAt
      const cacheInfo = await testDb.getCacheInfo();
      expect(cacheInfo).toBeDefined();
      expect(cacheInfo?.transaction_count).toBe(3);
    });

    test('disables caching when TTL is 0', async () => {
      process.env.COPILOT_CACHE_TTL_MINUTES = '0';

      // Create a new database to pick up the env var
      const testDb = new CopilotDatabase('/fake/path');
      (testDb as any)._transactions = [...mockTransactions];
      (testDb as any)._accounts = [...mockAccounts];
      (testDb as any)._recurring = [...mockRecurring];
      (testDb as any)._budgets = [];
      (testDb as any)._goals = [];
      (testDb as any)._goalHistory = [];
      (testDb as any)._investmentPrices = [];
      (testDb as any)._investmentSplits = [];
      (testDb as any)._items = [];
      (testDb as any)._userCategories = [];
      (testDb as any)._userAccounts = [];
      (testDb as any)._cacheLoadedAt = Date.now();

      // With TTL=0, isCacheStale should always return true
      // Which means getCacheInfo should trigger a reload attempt
      // But since we have fake path, it will fail gracefully
      const cacheInfo = await testDb.getCacheInfo();
      expect(cacheInfo).toBeDefined();
    });

    test('handles invalid TTL value gracefully', async () => {
      process.env.COPILOT_CACHE_TTL_MINUTES = 'not-a-number';

      // Should fall back to default TTL
      const testDb = new CopilotDatabase('/fake/path');
      (testDb as any)._transactions = [...mockTransactions];
      (testDb as any)._accounts = [...mockAccounts];
      (testDb as any)._cacheLoadedAt = Date.now();

      const cacheInfo = await testDb.getCacheInfo();
      expect(cacheInfo).toBeDefined();
    });
  });
});
