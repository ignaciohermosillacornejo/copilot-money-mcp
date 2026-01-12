/**
 * End-to-end tests using the synthetic test database.
 *
 * These tests run against a real LevelDB database with synthetic data,
 * testing the full decoder -> database -> tools pipeline.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { join } from 'path';
import { CopilotDatabase } from '../../src/core/database.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';

const SYNTHETIC_DB_PATH = join(__dirname, '../fixtures/synthetic-db');

describe('Synthetic Database E2E Tests', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeAll(() => {
    db = new CopilotDatabase(SYNTHETIC_DB_PATH);
    tools = new CopilotMoneyTools(db);
  });

  describe('Database availability', () => {
    test('synthetic database is available', () => {
      expect(db.isAvailable()).toBe(true);
    });

    test('database path is correct', () => {
      expect(db.getDbPath()).toBe(SYNTHETIC_DB_PATH);
    });
  });

  describe('Transaction decoding', () => {
    test('decodes all 12 synthetic transactions', () => {
      const txns = db.getAllTransactions();
      expect(txns.length).toBe(12);
    });

    test('transactions have required fields', () => {
      const txns = db.getAllTransactions();
      for (const txn of txns) {
        expect(txn.transaction_id).toBeDefined();
        expect(txn.amount).toBeDefined();
        expect(txn.date).toBeDefined();
        expect(txn.name || txn.original_name).toBeDefined();
      }
    });

    test('transactions are sorted by date descending', () => {
      const txns = db.getAllTransactions();
      for (let i = 0; i < txns.length - 1; i++) {
        expect(txns[i].date >= txns[i + 1].date).toBe(true);
      }
    });

    test('can find specific transaction by search', () => {
      const results = db.searchTransactions('Coffee');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name?.toLowerCase()).toContain('coffee');
    });

    test('can filter by date range', () => {
      const results = db.getTransactions({
        startDate: '2025-01-05',
        endDate: '2025-01-10',
      });
      for (const txn of results) {
        expect(txn.date >= '2025-01-05').toBe(true);
        expect(txn.date <= '2025-01-10').toBe(true);
      }
    });

    test('can filter by category', () => {
      const results = db.getTransactions({ category: 'food_dining' });
      expect(results.length).toBe(2); // Coffee Shop and Restaurant
      for (const txn of results) {
        expect(txn.category_id).toBe('food_dining');
      }
    });

    test('can filter by amount range', () => {
      const results = db.getTransactions({
        minAmount: -100,
        maxAmount: -50,
      });
      for (const txn of results) {
        expect(txn.amount >= -100).toBe(true);
        expect(txn.amount <= -50).toBe(true);
      }
    });
  });

  describe('Account decoding', () => {
    test('decodes all 3 synthetic accounts', () => {
      const accounts = db.getAccounts();
      expect(accounts.length).toBe(3);
    });

    test('accounts have required fields', () => {
      const accounts = db.getAccounts();
      for (const acc of accounts) {
        expect(acc.account_id).toBeDefined();
        expect(acc.current_balance).toBeDefined();
        expect(acc.name || acc.official_name).toBeDefined();
      }
    });

    test('can filter by account type', () => {
      const checking = db.getAccounts('checking');
      expect(checking.length).toBe(1);
      expect(checking[0].subtype).toBe('checking');

      const savings = db.getAccounts('savings');
      expect(savings.length).toBe(1);
      expect(savings[0].subtype).toBe('savings');

      const credit = db.getAccounts('credit');
      expect(credit.length).toBe(1);
      expect(credit[0].account_type).toBe('credit');
    });

    test('account balances are correct', () => {
      const accounts = db.getAccounts();
      const checking = accounts.find((a) => a.name === 'Test Checking');
      const savings = accounts.find((a) => a.name === 'Test Savings');
      const creditCard = accounts.find((a) => a.name === 'Test Credit Card');

      expect(checking?.current_balance).toBe(2500.0);
      expect(savings?.current_balance).toBe(10000.0);
      expect(creditCard?.current_balance).toBe(-450.37);
    });
  });

  describe('Categories', () => {
    test('extracts unique categories from transactions', () => {
      const categories = db.getCategories();
      expect(categories.length).toBeGreaterThan(0);

      const categoryIds = categories.map((c) => c.category_id);
      expect(categoryIds).toContain('food_dining');
      expect(categoryIds).toContain('groceries');
      expect(categoryIds).toContain('transportation');
      expect(categoryIds).toContain('income');
    });
  });

  describe('Tools integration', () => {
    test('getTransactions tool works with synthetic data', () => {
      const result = tools.getTransactions({ limit: 10 });
      expect(result.count).toBeGreaterThan(0);
      expect(result.transactions.length).toBeLessThanOrEqual(10);
    });

    test('searchTransactions tool finds matching transactions', () => {
      const result = tools.searchTransactions('Grocery');
      expect(result.count).toBeGreaterThan(0);
      const txn = result.transactions[0];
      const displayName = txn.name || txn.original_name || '';
      expect(displayName.toLowerCase()).toContain('grocery');
    });

    test('getAccounts tool returns all accounts', () => {
      const result = tools.getAccounts();
      expect(result.count).toBe(3);
      expect(result.total_balance).toBeDefined();
    });

    test('getAccountBalance returns specific account', () => {
      const result = tools.getAccountBalance('test_acc_checking');
      expect(result.account_id).toBe('test_acc_checking');
      expect(result.current_balance).toBe(2500.0);
    });

    test('getSpendingByCategory aggregates correctly', () => {
      const result = tools.getSpendingByCategory({
        start_date: '2025-01-01',
        end_date: '2025-01-31',
      });

      expect(result.total_spending).toBeGreaterThan(0);
      expect(result.categories.length).toBeGreaterThan(0);

      // The tool counts positive amounts as "spending"
      // In our synthetic data, income (3500) and transfer-in (500) are positive
      const income = result.categories.find((c) => c.category_id === 'income');
      expect(income).toBeDefined();
      expect(income?.total_spending).toBe(3500);
      expect(income?.transaction_count).toBe(1);
    });

    test('spending aggregation math is correct', () => {
      const result = tools.getSpendingByCategory({
        start_date: '2025-01-01',
        end_date: '2025-01-31',
      });

      const calculatedTotal = result.categories.reduce((sum, cat) => sum + cat.total_spending, 0);
      expect(Math.abs(result.total_spending - calculatedTotal)).toBeLessThan(0.01);
    });
  });

  describe('Edge cases', () => {
    test('handles empty search results gracefully', () => {
      const result = tools.searchTransactions('nonexistent_merchant_xyz');
      expect(result.count).toBe(0);
      expect(result.transactions).toEqual([]);
    });

    test('handles future date range with no results', () => {
      const result = tools.getTransactions({
        start_date: '2030-01-01',
        end_date: '2030-12-31',
      });
      expect(result.count).toBe(0);
    });

    test('handles account not found', () => {
      expect(() => tools.getAccountBalance('nonexistent_account')).toThrow('Account not found');
    });
  });

  describe('Data integrity', () => {
    test('transaction IDs are unique', () => {
      const txns = db.getAllTransactions();
      const ids = txns.map((t) => t.transaction_id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    test('account IDs are unique', () => {
      const accounts = db.getAccounts();
      const ids = accounts.map((a) => a.account_id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    test('income transaction has positive amount', () => {
      const income = db.getTransactions({ category: 'income' });
      expect(income.length).toBeGreaterThan(0);
      expect(income[0].amount).toBeGreaterThan(0);
    });

    test('expense transactions have negative amounts', () => {
      const expenses = db.getTransactions({ category: 'groceries' });
      for (const txn of expenses) {
        expect(txn.amount).toBeLessThan(0);
      }
    });
  });
});
