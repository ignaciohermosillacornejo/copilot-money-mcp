/**
 * Integration tests for MCP tools.
 *
 * Tests the full tool functionality with mocked database data.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyTools, createToolSchemas } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import type { Transaction, Account } from '../../src/models/index.js';

// Mock data
// Copilot Money format: positive = expenses, negative = income
const mockTransactions: Transaction[] = [
  {
    transaction_id: 'txn1',
    amount: 50.0, // Expense (positive in Copilot format)
    date: '2025-01-15',
    name: 'Starbucks',
    category_id: 'food_dining',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn2',
    amount: 15.5, // Expense (positive in Copilot format)
    date: '2025-01-10',
    name: 'Starbucks Coffee',
    category_id: 'food_dining',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn3',
    amount: 120.0, // Expense (positive in Copilot format)
    date: '2025-01-08',
    name: 'Whole Foods',
    category_id: 'groceries',
    account_id: 'acc2',
  },
  {
    transaction_id: 'txn4',
    amount: -1000.0, // Income (negative in Copilot format = money coming in)
    date: '2025-01-05',
    name: 'Paycheck',
    category_id: 'income',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn5',
    amount: 250.0, // Expense (positive in Copilot format)
    date: '2024-12-20',
    name: 'Target',
    category_id: 'shopping',
    account_id: 'acc1',
  },
];

const mockAccounts: Account[] = [
  {
    account_id: 'acc1',
    current_balance: 1500.0,
    available_balance: 1450.0,
    name: 'Checking Account',
    account_type: 'checking',
    mask: '1234',
    institution_name: 'Chase',
  },
  {
    account_id: 'acc2',
    current_balance: 2500.0,
    name: 'Savings Account',
    account_type: 'savings',
  },
];

describe('CopilotMoneyTools Integration', () => {
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
    tools = new CopilotMoneyTools(db);
  });

  describe('getTransactions', () => {
    test('returns basic transaction data', async () => {
      const result = await tools.getTransactions({ limit: 10 });

      expect(result.count).toBeDefined();
      expect(result.transactions).toBeDefined();
      expect(result.count).toBe(result.transactions.length);
      expect(result.count).toBeLessThanOrEqual(10);

      if (result.transactions.length > 0) {
        const txn = result.transactions[0];
        expect(txn.transaction_id).toBeDefined();
        expect(txn.amount).toBeDefined();
        expect(txn.date).toBeDefined();
      }
    });

    test('filters by date range', async () => {
      const result = await tools.getTransactions({
        start_date: '2025-01-01',
        end_date: '2025-01-31',
        limit: 50,
      });

      for (const txn of result.transactions) {
        expect(txn.date >= '2025-01-01' && txn.date <= '2025-01-31').toBe(true);
      }
    });

    test('filters by merchant', async () => {
      const result = await tools.getTransactions({
        merchant: 'starbucks',
        limit: 20,
      });

      for (const txn of result.transactions) {
        const name = txn.name || txn.original_name || '';
        expect(name.toLowerCase().includes('starbucks')).toBe(true);
      }
    });

    test('filters by category', async () => {
      const result = await tools.getTransactions({
        category: 'food',
        limit: 20,
      });

      for (const txn of result.transactions) {
        expect(txn.category_id && txn.category_id.toLowerCase().includes('food')).toBe(true);
      }
    });

    test('filters by amount range', async () => {
      // Amount filtering uses absolute values (magnitude)
      const result = await tools.getTransactions({
        min_amount: 10.0,
        max_amount: 100.0,
        limit: 50,
      });

      for (const txn of result.transactions) {
        expect(Math.abs(txn.amount) >= 10.0 && Math.abs(txn.amount) <= 100.0).toBe(true);
      }
    });
  });

  describe('searchTransactions', () => {
    test('finds transactions by query', async () => {
      const result = await tools.searchTransactions('starbucks', { limit: 20 });

      expect(result.count).toBeDefined();
      expect(result.transactions).toBeDefined();
      expect(result.count).toBeLessThanOrEqual(20);
    });

    test('search is case-insensitive', async () => {
      const result1 = await tools.searchTransactions('STARBUCKS', { limit: 10 });
      const result2 = await tools.searchTransactions('starbucks', { limit: 10 });

      expect(result1.count).toBe(result2.count);
    });

    test('returns empty results for no matches', async () => {
      const result = await tools.searchTransactions('xyznonexistent123', {});

      expect(result.count).toBe(0);
      expect(result.transactions).toEqual([]);
    });
  });

  describe('getAccounts', () => {
    test('returns all accounts with total balance', async () => {
      const result = await tools.getAccounts();

      expect(result.count).toBeDefined();
      expect(result.total_balance).toBeDefined();
      expect(result.accounts).toBeDefined();
      expect(result.count).toBe(result.accounts.length);

      // Verify total balance calculation
      const calculatedTotal = result.accounts.reduce((sum, acc) => sum + acc.current_balance, 0);
      expect(Math.abs(result.total_balance - calculatedTotal)).toBeLessThan(0.01);
    });

    test('account structure is correct', async () => {
      const result = await tools.getAccounts();

      if (result.accounts.length > 0) {
        const acc = result.accounts[0];
        expect(acc.account_id).toBeDefined();
        expect(acc.current_balance).toBeDefined();
      }
    });

    test('filters by account type', async () => {
      const result = await tools.getAccounts({ account_type: 'checking' });

      for (const acc of result.accounts) {
        // Account may have account_type='depository' with subtype='checking', or account_type='checking'
        const matchesAccountType =
          acc.account_type?.toLowerCase().includes('checking') ||
          acc.subtype?.toLowerCase().includes('checking');
        expect(matchesAccountType).toBe(true);
      }
    });
  });

  describe('getSpendingByCategory', () => {
    test('aggregates spending by category', async () => {
      const result = await tools.getSpendingByCategory({
        start_date: '2025-01-01',
        end_date: '2025-01-31',
      });

      expect(result.period).toBeDefined();
      expect(result.total_spending).toBeDefined();
      expect(result.category_count).toBeDefined();
      expect(result.categories).toBeDefined();

      expect(result.period.start_date).toBe('2025-01-01');
      expect(result.period.end_date).toBe('2025-01-31');
    });

    test('categories are sorted by spending descending', async () => {
      const result = await tools.getSpendingByCategory({
        start_date: '2025-01-01',
        end_date: '2025-01-31',
      });

      const categories = result.categories;
      for (let i = 0; i < categories.length - 1; i++) {
        expect(categories[i].total_spending >= categories[i + 1].total_spending).toBe(true);
      }
    });

    test('excludes income (negative amounts)', async () => {
      const result = await tools.getSpendingByCategory({
        start_date: '2025-01-01',
        end_date: '2025-01-31',
      });

      // Should not include income category
      const incomeCategory = result.categories.find((cat) => cat.category_id === 'income');
      expect(incomeCategory).toBeUndefined();
    });

    test('total spending matches sum of categories', async () => {
      const result = await tools.getSpendingByCategory({
        start_date: '2025-01-01',
        end_date: '2025-01-31',
      });

      const calculatedTotal = result.categories.reduce((sum, cat) => sum + cat.total_spending, 0);

      expect(Math.abs(result.total_spending - calculatedTotal)).toBeLessThan(0.01);
    });

    test('category structure is correct', async () => {
      const result = await tools.getSpendingByCategory({
        start_date: '2025-01-01',
        end_date: '2025-01-31',
      });

      if (result.categories.length > 0) {
        const cat = result.categories[0];
        expect(cat.category_id).toBeDefined();
        expect(cat.category_name).toBeDefined();
        expect(cat.total_spending).toBeDefined();
        expect(cat.transaction_count).toBeDefined();
        expect(cat.total_spending >= 0).toBe(true);
        expect(cat.transaction_count > 0).toBe(true);
      }
    });
  });

  describe('getAccountBalance', () => {
    test('returns account details', async () => {
      const result = await tools.getAccountBalance('acc1');

      expect(result.account_id).toBe('acc1');
      expect(result.name).toBeDefined();
      expect(result.current_balance).toBeDefined();
    });

    test('includes all account fields', async () => {
      const result = await tools.getAccountBalance('acc1');

      expect(result.account_id).toBe('acc1');
      expect(result.name).toBe('Checking Account');
      expect(result.account_type).toBe('checking');
      expect(result.current_balance).toBe(1500.0);
      expect(result.available_balance).toBe(1450.0);
      expect(result.mask).toBe('1234');
      expect(result.institution_name).toBe('Chase');
    });

    test('throws error for invalid account_id', async () => {
      await expect(tools.getAccountBalance('nonexistent')).rejects.toThrow('Account not found');
    });
  });

  describe('tool schemas', () => {
    test('returns correct number of tool schemas', async () => {
      const schemas = createToolSchemas();
      expect(schemas.length).toBe(31);
    });

    test('all tools have readOnlyHint annotation', async () => {
      const schemas = createToolSchemas();

      for (const schema of schemas) {
        expect(schema.annotations?.readOnlyHint).toBe(true);
      }
    });

    test('all schemas have required fields', async () => {
      const schemas = createToolSchemas();

      for (const schema of schemas) {
        expect(schema.name).toBeDefined();
        expect(schema.description).toBeDefined();
        expect(schema.inputSchema).toBeDefined();
        expect(schema.inputSchema.type).toBe('object');
        expect(schema.inputSchema.properties).toBeDefined();
      }
    });

    test('tool names are correct', async () => {
      const schemas = createToolSchemas();
      const names = schemas.map((s) => s.name);

      // Core tools
      expect(names).toContain('get_transactions');
      expect(names).toContain('get_accounts');
      expect(names).toContain('get_account_balance');

      // Consolidated tools
      expect(names).toContain('get_spending');
      expect(names).toContain('get_categories');
      expect(names).toContain('get_recurring_transactions');
      expect(names).toContain('get_income');
      expect(names).toContain('compare_periods');
      expect(names).toContain('get_account_analytics');
      expect(names).toContain('get_budget_analytics');
      expect(names).toContain('get_goal_analytics');
      expect(names).toContain('get_investment_analytics');
      expect(names).toContain('get_merchant_analytics');
    });

    test('required parameters are specified', async () => {
      const schemas = createToolSchemas();

      const spendingTool = schemas.find((s) => s.name === 'get_spending');
      expect(spendingTool?.inputSchema.required).toContain('group_by');

      const balanceTool = schemas.find((s) => s.name === 'get_account_balance');
      expect(balanceTool?.inputSchema.required).toContain('account_id');

      const compareTool = schemas.find((s) => s.name === 'compare_periods');
      expect(compareTool?.inputSchema.required).toContain('period1');
      expect(compareTool?.inputSchema.required).toContain('period2');
    });
  });

  describe('response formats', () => {
    test('transaction responses are JSON serializable', async () => {
      const result = await tools.getTransactions({ limit: 5 });
      const json = JSON.stringify(result);
      const parsed = JSON.parse(json);
      expect(parsed.count).toBe(result.count);
    });

    test('account responses are JSON serializable', async () => {
      const result = await tools.getAccounts();
      const json = JSON.stringify(result);
      const parsed = JSON.parse(json);
      expect(parsed.count).toBe(result.count);
    });

    test('spending responses are JSON serializable', async () => {
      const result = await tools.getSpendingByCategory({
        start_date: '2025-01-01',
        end_date: '2025-01-31',
      });
      const json = JSON.stringify(result);
      const parsed = JSON.parse(json);
      expect(parsed.total_spending).toBe(result.total_spending);
    });
  });

  describe('empty results', () => {
    test('handles empty transaction results', async () => {
      const result = await tools.getTransactions({
        start_date: '1900-01-01',
        end_date: '1900-01-31',
      });

      expect(result.count).toBe(0);
      expect(result.transactions).toEqual([]);
    });

    test('handles empty search results', async () => {
      const result = await tools.searchTransactions('xyznonexistent123', {});

      expect(result.count).toBe(0);
      expect(result.transactions).toEqual([]);
    });
  });
});
