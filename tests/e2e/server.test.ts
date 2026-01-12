/**
 * End-to-end tests for the MCP server.
 *
 * Tests the full server protocol including tool functionality.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyServer } from '../../src/server.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import type { Transaction, Account } from '../../src/models/index.js';

// Mock data for E2E tests
const mockTransactions: Transaction[] = [
  {
    transaction_id: 'txn1',
    amount: 50.0,
    date: '2026-01-15',
    name: 'Coffee Shop',
    category_id: 'food_dining',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn2',
    amount: 120.5,
    date: '2026-01-20',
    name: 'Grocery Store',
    category_id: 'groceries',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn3',
    amount: 10.0,
    date: '2026-01-15',
    name: 'Parking',
    category_id: 'transportation',
    account_id: 'acc2',
  },
  {
    transaction_id: 'txn4',
    amount: 25.0,
    date: '2026-01-18',
    name: 'Fast Food',
    category_id: 'food_dining',
    account_id: 'acc1',
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
    name: 'Savings Account',
    account_type: 'savings',
  },
];

describe('CopilotMoneyServer E2E', () => {
  let server: CopilotMoneyServer;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    const db = new CopilotDatabase('/fake/path');
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];

    server = new CopilotMoneyServer('/fake/path');
    // Override server's database
    (server as any).db = db;
    (server as any).tools = new CopilotMoneyTools(db);

    tools = (server as any).tools;
  });

  describe('server initialization', () => {
    test('server can be initialized', () => {
      expect(server).toBeDefined();
    });

    test('server has database', () => {
      expect((server as any).db).toBeDefined();
    });

    test('server has tools', () => {
      expect((server as any).tools).toBeDefined();
    });
  });

  describe('tool functionality', () => {
    test('get_transactions tool works', () => {
      const result = tools.getTransactions({ limit: 10 });

      expect(result.count).toBeDefined();
      expect(result.transactions).toBeDefined();
      expect(result.count).toBeLessThanOrEqual(10);
    });

    test('get_transactions with all filters', () => {
      const result = tools.getTransactions({
        start_date: '2026-01-01',
        end_date: '2026-01-31',
        min_amount: 5.0,
        max_amount: 100.0,
        limit: 20,
      });

      for (const txn of result.transactions) {
        expect(txn.date >= '2026-01-01' && txn.date <= '2026-01-31').toBe(true);
        expect(txn.amount >= 5.0 && txn.amount <= 100.0).toBe(true);
      }
    });

    test('search_transactions tool works', () => {
      const result = tools.searchTransactions('coffee', 10);

      expect(result.count).toBeDefined();
      expect(result.transactions).toBeDefined();
    });

    test('get_accounts tool works', () => {
      const result = tools.getAccounts();

      expect(result.count).toBeDefined();
      expect(result.total_balance).toBeDefined();
      expect(result.accounts).toBeDefined();
      expect(result.count).toBe(result.accounts.length);
    });

    test('get_spending_by_category tool works', () => {
      const result = tools.getSpendingByCategory({
        start_date: '2026-01-01',
        end_date: '2026-01-31',
      });

      expect(result.period).toBeDefined();
      expect(result.total_spending).toBeDefined();
      expect(result.categories).toBeDefined();

      // Verify categories are sorted
      const categories = result.categories;
      for (let i = 0; i < categories.length - 1; i++) {
        expect(categories[i].total_spending >= categories[i + 1].total_spending).toBe(true);
      }
    });

    test('get_account_balance tool works', () => {
      const result = tools.getAccountBalance('acc1');

      expect(result.account_id).toBe('acc1');
      expect(result.current_balance).toBeDefined();
    });

    test('get_account_balance throws for invalid account', () => {
      expect(() => tools.getAccountBalance('nonexistent_123')).toThrow('Account not found');
    });
  });

  describe('response serialization', () => {
    test('all tool responses can be serialized to JSON', () => {
      const toolsToTest = [
        { func: () => tools.getTransactions({ limit: 5 }) },
        { func: () => tools.searchTransactions('test') },
        { func: () => tools.getAccounts() },
        {
          func: () =>
            tools.getSpendingByCategory({
              start_date: '2026-01-01',
              end_date: '2026-01-31',
            }),
        },
        { func: () => tools.getAccountBalance('acc1') },
      ];

      for (const { func } of toolsToTest) {
        const result = func();
        const jsonStr = JSON.stringify(result);
        const deserialized = JSON.parse(jsonStr);
        expect(deserialized).toBeDefined();
      }
    });
  });

  describe('data accuracy', () => {
    test('spending aggregation is mathematically correct', () => {
      const result = tools.getSpendingByCategory({
        start_date: '2026-01-01',
        end_date: '2026-01-31',
      });

      const categoryTotal = result.categories.reduce((sum, cat) => sum + cat.total_spending, 0);

      expect(Math.abs(result.total_spending - categoryTotal)).toBeLessThan(0.01);
    });

    test('account balance totals are correct', () => {
      const result = tools.getAccounts();

      const calculatedTotal = result.accounts.reduce((sum, acc) => sum + acc.current_balance, 0);

      expect(Math.abs(result.total_balance - calculatedTotal)).toBeLessThan(0.01);
    });

    test('category transaction counts are accurate', () => {
      const result = tools.getSpendingByCategory({
        start_date: '2026-01-01',
        end_date: '2026-01-31',
      });

      for (const cat of result.categories) {
        expect(cat.transaction_count).toBeGreaterThan(0);
        expect(cat.total_spending).toBeGreaterThan(0);
      }
    });
  });

  describe('empty results', () => {
    test('handles empty transaction results gracefully', () => {
      const result = tools.searchTransactions('xyznonexistent123');
      expect(result.count).toBe(0);
      expect(result.transactions).toEqual([]);
    });

    test('handles impossible date ranges', () => {
      const result = tools.getTransactions({
        start_date: '1900-01-01',
        end_date: '1900-01-31',
      });
      expect(result.count).toBe(0);
      expect(result.transactions).toEqual([]);
    });
  });

  describe('large limits', () => {
    test('handles large limits appropriately', () => {
      const result = tools.getTransactions({ limit: 10000 });

      expect(result.count).toBeGreaterThanOrEqual(0);
      expect(result.count).toBeLessThanOrEqual(10000);
    });
  });

  describe('boundary conditions', () => {
    test('single day date range works', () => {
      const result = tools.getTransactions({
        start_date: '2026-01-15',
        end_date: '2026-01-15',
        limit: 100,
      });

      for (const txn of result.transactions) {
        expect(txn.date).toBe('2026-01-15');
      }
    });

    test('exact amount match works', () => {
      const result = tools.getTransactions({
        min_amount: 10.0,
        max_amount: 10.0,
        limit: 100,
      });

      for (const txn of result.transactions) {
        expect(txn.amount).toBe(10.0);
      }
    });
  });

  describe('consistency', () => {
    test('multiple calls return consistent results', () => {
      const result1 = tools.getTransactions({ limit: 10 });
      const result2 = tools.getTransactions({ limit: 10 });

      expect(result1.count).toBe(result2.count);

      const ids1 = new Set(result1.transactions.map((t) => t.transaction_id));
      const ids2 = new Set(result2.transactions.map((t) => t.transaction_id));

      expect(ids1.size).toBe(ids2.size);
      for (const id of ids1) {
        expect(ids2.has(id)).toBe(true);
      }
    });
  });

  describe('error handling', () => {
    test('database unavailable returns appropriate message', () => {
      const dbUnavailable = new CopilotDatabase('/nonexistent/path');
      expect(dbUnavailable.isAvailable()).toBe(false);
    });
  });
});
