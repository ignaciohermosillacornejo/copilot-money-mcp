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
// Copilot Money format: positive = expenses, negative = income
const mockTransactions: Transaction[] = [
  {
    transaction_id: 'txn1',
    amount: 50.0, // Expense (positive = money out in Copilot format)
    date: '2025-01-15',
    name: 'Coffee Shop',
    category_id: 'food_dining',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn2',
    amount: 120.5, // Expense (positive = money out in Copilot format)
    date: '2025-01-20',
    name: 'Grocery Store',
    category_id: 'groceries',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn3',
    amount: 10.0, // Expense (positive = money out in Copilot format)
    date: '2025-01-15',
    name: 'Parking',
    category_id: 'transportation',
    account_id: 'acc2',
  },
  {
    transaction_id: 'txn4',
    amount: 25.0, // Expense (positive = money out in Copilot format)
    date: '2025-01-18',
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
    // Add required cache fields for async database methods
    (db as any)._recurring = [];
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

    server = new CopilotMoneyServer('/fake/path');
    // Override server's database
    (server as any).db = db;
    (server as any).tools = new CopilotMoneyTools(db);

    tools = (server as any).tools;
  });

  describe('server initialization', () => {
    test('server can be initialized', async () => {
      expect(server).toBeDefined();
    });

    test('server has database', async () => {
      expect((server as any).db).toBeDefined();
    });

    test('server has tools', async () => {
      expect((server as any).tools).toBeDefined();
    });
  });

  describe('tool functionality', () => {
    test('get_transactions tool works', async () => {
      const result = await tools.getTransactions({ limit: 10 });

      expect(result.count).toBeDefined();
      expect(result.transactions).toBeDefined();
      expect(result.count).toBeLessThanOrEqual(10);
    });

    test('get_transactions with all filters', async () => {
      // Amount filtering uses absolute values (magnitude)
      const result = await tools.getTransactions({
        start_date: '2025-01-01',
        end_date: '2025-01-31',
        min_amount: 5.0,
        max_amount: 100.0,
        limit: 20,
      });

      for (const txn of result.transactions) {
        expect(txn.date >= '2025-01-01' && txn.date <= '2025-01-31').toBe(true);
        expect(Math.abs(txn.amount) >= 5.0 && Math.abs(txn.amount) <= 100.0).toBe(true);
      }
    });

    test('get_accounts tool works', async () => {
      const result = await tools.getAccounts();

      expect(result.count).toBeDefined();
      expect(result.total_balance).toBeDefined();
      expect(result.accounts).toBeDefined();
      expect(result.count).toBe(result.accounts.length);
    });
  });

  describe('response serialization', () => {
    test('all tool responses can be serialized to JSON', async () => {
      const toolsToTest = [
        { func: () => tools.getTransactions({ limit: 5 }) },
        { func: () => tools.getAccounts() },
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
    test('account balance totals are correct', async () => {
      const result = await tools.getAccounts();

      const calculatedTotal = result.accounts.reduce((sum, acc) => sum + acc.current_balance, 0);

      expect(Math.abs(result.total_balance - calculatedTotal)).toBeLessThan(0.01);
    });
  });

  describe('empty results', () => {
    test('handles impossible date ranges', async () => {
      const result = await tools.getTransactions({
        start_date: '1900-01-01',
        end_date: '1900-01-31',
      });
      expect(result.count).toBe(0);
      expect(result.transactions).toEqual([]);
    });
  });

  describe('large limits', () => {
    test('handles large limits appropriately', async () => {
      const result = await tools.getTransactions({ limit: 10000 });

      expect(result.count).toBeGreaterThanOrEqual(0);
      expect(result.count).toBeLessThanOrEqual(10000);
    });
  });

  describe('boundary conditions', () => {
    test('single day date range works', async () => {
      const result = await tools.getTransactions({
        start_date: '2025-01-15',
        end_date: '2025-01-15',
        limit: 100,
      });

      for (const txn of result.transactions) {
        expect(txn.date).toBe('2025-01-15');
      }
    });

    test('exact amount match works', async () => {
      // Amount filtering uses absolute values (magnitude)
      // Match transactions with magnitude = 10.0
      const result = await tools.getTransactions({
        min_amount: 10.0,
        max_amount: 10.0,
        limit: 100,
      });

      for (const txn of result.transactions) {
        // With absolute value filtering, exact match means |amount| = 10.0
        // So the actual amount could be -10.0 or 10.0
        expect(Math.abs(txn.amount)).toBe(10.0);
      }
    });
  });

  describe('consistency', () => {
    test('multiple calls return consistent results', async () => {
      const result1 = await tools.getTransactions({ limit: 10 });
      const result2 = await tools.getTransactions({ limit: 10 });

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
    test('database unavailable returns appropriate message', async () => {
      const dbUnavailable = new CopilotDatabase('/nonexistent/path');
      expect(dbUnavailable.isAvailable()).toBe(false);
    });
  });
});
