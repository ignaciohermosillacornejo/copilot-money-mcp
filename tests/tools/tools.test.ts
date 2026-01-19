/**
 * Unit tests for MCP tools.
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
    amount: 50.0, // Expense (positive = money out in Copilot format)
    date: '2024-01-15',
    name: 'Coffee Shop',
    category_id: 'food_dining',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn2',
    amount: 120.5, // Expense (positive = money out in Copilot format)
    date: '2024-01-20',
    name: 'Grocery Store',
    category_id: 'groceries',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn3',
    amount: 25.0, // Expense (positive = money out in Copilot format)
    date: '2024-02-10',
    original_name: 'Fast Food',
    category_id: 'food_dining',
    account_id: 'acc2',
  },
  {
    transaction_id: 'txn4',
    amount: -1000.0, // Income (negative = money in in Copilot format)
    date: '2024-01-31',
    name: 'Paycheck',
    category_id: 'income',
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
    institution_name: 'Bank of Example',
  },
  {
    account_id: 'acc2',
    current_balance: 500.0,
    official_name: 'Savings Account',
    account_type: 'savings',
  },
];

// Additional mock data for testing new filtering behavior
const mockTransactionsWithFilters: Transaction[] = [
  {
    transaction_id: 'txn_normal',
    amount: 50.0, // Expense
    date: '2024-03-01',
    name: 'Normal Transaction',
    category_id: 'shopping',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn_transfer',
    amount: 100.0, // Transfer (expense)
    date: '2024-03-01',
    name: 'Transfer',
    category_id: 'transfer_credit_card',
    account_id: 'acc1',
    internal_transfer: true,
  },
  {
    transaction_id: 'txn_deleted',
    amount: 30.0, // Expense
    date: '2024-03-01',
    name: 'Deleted Transaction',
    category_id: 'shopping',
    account_id: 'acc1',
    plaid_deleted: true,
  },
  {
    transaction_id: 'txn_excluded',
    amount: 40.0, // Expense
    date: '2024-03-01',
    name: 'Excluded Transaction',
    category_id: 'shopping',
    account_id: 'acc1',
    excluded: true,
  },
];

const mockAccountsWithHidden: Account[] = [
  {
    account_id: 'acc_visible',
    current_balance: 1000.0,
    name: 'Visible Account',
    account_type: 'checking',
  },
  {
    account_id: 'acc_hidden',
    current_balance: 5000.0,
    name: 'Hidden Account',
    account_type: 'investment',
  },
];

// UserAccountCustomization for hidden accounts
const mockUserAccounts = [
  {
    account_id: 'acc_hidden',
    hidden: true,
  },
];

// Mock goals for testing
const mockGoals = [
  {
    goal_id: 'goal1',
    name: 'Emergency Fund',
    emoji: '🏦',
    created_date: '2024-01-01',
    savings: {
      target_amount: 10000,
      tracking_type: 'monthly_contribution',
      tracking_type_monthly_contribution: 500,
      start_date: '2024-01-01',
      status: 'active',
      is_ongoing: false,
      inflates_budget: true,
    },
  },
  {
    goal_id: 'goal2',
    name: 'Vacation Fund',
    emoji: '✈️',
    created_date: '2024-02-01',
    savings: {
      target_amount: 3000,
      tracking_type: 'end_date',
      start_date: '2024-02-01',
      status: 'active',
      is_ongoing: true,
      inflates_budget: false,
    },
  },
];

// Mock goal history - deliberately in WRONG order (oldest first) to test the fix
// This ensures we don't rely on sort order to get the latest month
const mockGoalHistoryWrongOrder = [
  {
    goal_id: 'goal1',
    month: '2024-01', // Older month
    current_amount: 500,
    user_id: 'user1',
  },
  {
    goal_id: 'goal1',
    month: '2024-03', // Latest month - should use this value
    current_amount: 1500,
    user_id: 'user1',
  },
  {
    goal_id: 'goal1',
    month: '2024-02', // Middle month
    current_amount: 1000,
    user_id: 'user1',
  },
  {
    goal_id: 'goal2',
    month: '2024-02', // Older month
    current_amount: 200,
    user_id: 'user1',
  },
  {
    goal_id: 'goal2',
    month: '2024-03', // Latest month - should use this value
    current_amount: 800,
    user_id: 'user1',
  },
];

describe('CopilotMoneyTools', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    // Mock the database with test data
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
    test('returns all transactions when no filters applied', async () => {
      const result = await tools.getTransactions({});
      expect(result.count).toBe(4);
      expect(result.transactions).toHaveLength(4);
    });

    test('filters by start_date and end_date', async () => {
      const result = await tools.getTransactions({
        start_date: '2024-02-01',
        end_date: '2024-02-28',
      });
      expect(result.count).toBe(1);
      expect(result.transactions[0].transaction_id).toBe('txn3');
    });

    test('parses period shorthand', async () => {
      // Note: This will use current date, so we can only test it doesn't crash
      const result = await tools.getTransactions({ period: 'last_30_days' });
      expect(result.count).toBeGreaterThanOrEqual(0);
    });

    test('filters by category', async () => {
      const result = await tools.getTransactions({ category: 'food' });
      expect(result.count).toBe(2);
    });

    test('filters by merchant', async () => {
      const result = await tools.getTransactions({ merchant: 'grocery' });
      expect(result.count).toBe(1);
    });

    test('filters by account_id', async () => {
      const result = await tools.getTransactions({ account_id: 'acc1' });
      expect(result.count).toBe(3);
    });

    test('filters by amount range', async () => {
      // Amount filtering uses absolute values (magnitude)
      // min_amount: 50 matches |amount| >= 50: Coffee (-50), Grocery (-120.5), Paycheck (1000)
      // max_amount: 150 matches |amount| <= 150: Coffee (-50), Grocery (-120.5), Fast Food (-25)
      // Combined: Coffee (-50), Grocery (-120.5) = 2 transactions
      const result = await tools.getTransactions({
        min_amount: 50.0,
        max_amount: 150.0,
      });
      expect(result.count).toBe(2);
    });

    test('applies limit correctly', async () => {
      const result = await tools.getTransactions({ limit: 2 });
      expect(result.count).toBe(2);
    });

    test('combines multiple filters', async () => {
      const result = await tools.getTransactions({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
        category: 'food',
        limit: 10,
      });
      expect(result.count).toBe(1);
    });

    test('filters by region', async () => {
      // Add a transaction with region for testing
      const txnWithRegion: Transaction = {
        transaction_id: 'txn_region',
        amount: 75.0,
        date: '2024-01-25',
        name: 'Regional Store',
        category_id: 'shopping',
        account_id: 'acc1',
        region: 'California',
        city: 'San Francisco',
      };
      (db as any)._transactions = [...mockTransactions, txnWithRegion];

      const result = await tools.getTransactions({ region: 'california' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].region).toBe('California');
    });

    test('filters by region matching city', async () => {
      const txnWithCity: Transaction = {
        transaction_id: 'txn_city',
        amount: 85.0,
        date: '2024-01-26',
        name: 'City Store',
        category_id: 'shopping',
        account_id: 'acc1',
        city: 'Los Angeles',
      };
      (db as any)._transactions = [...mockTransactions, txnWithCity];

      const result = await tools.getTransactions({ region: 'los angeles' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].city).toBe('Los Angeles');
    });

    test('filters by country exact match', async () => {
      const txnWithCountry: Transaction = {
        transaction_id: 'txn_country',
        amount: 95.0,
        date: '2024-01-27',
        name: 'International Store',
        category_id: 'shopping',
        account_id: 'acc1',
        country: 'US',
      };
      (db as any)._transactions = [...mockTransactions, txnWithCountry];

      const result = await tools.getTransactions({ country: 'us' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].country).toBe('US');
    });

    test('filters by country partial match', async () => {
      const txnWithCountry: Transaction = {
        transaction_id: 'txn_country2',
        amount: 105.0,
        date: '2024-01-28',
        name: 'Foreign Store',
        category_id: 'shopping',
        account_id: 'acc1',
        country: 'United States',
      };
      (db as any)._transactions = [...mockTransactions, txnWithCountry];

      const result = await tools.getTransactions({ country: 'united' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].country).toBe('United States');
    });

    test('filters by pending status', async () => {
      const pendingTxn: Transaction = {
        transaction_id: 'txn_pending',
        amount: 45.0,
        date: '2024-01-29',
        name: 'Pending Transaction',
        category_id: 'shopping',
        account_id: 'acc1',
        pending: true,
      };
      (db as any)._transactions = [...mockTransactions, pendingTxn];

      const result = await tools.getTransactions({ pending: true });
      expect(result.count).toBe(1);
      expect(result.transactions[0].pending).toBe(true);
    });
  });

  describe('getAccounts', () => {
    test('returns all accounts with total balance', async () => {
      const result = await tools.getAccounts();
      expect(result.count).toBe(2);
      expect(result.total_balance).toBe(2000.0);
      expect(result.accounts).toHaveLength(2);
    });

    test('filters by account type', async () => {
      const result = await tools.getAccounts({ account_type: 'checking' });
      expect(result.count).toBe(1);
      expect(result.accounts[0].account_type).toBe('checking');
    });
  });

  describe('getAccounts with hidden accounts', () => {
    beforeEach(() => {
      // Override with mock data that includes hidden accounts
      (db as any)._accounts = [...mockAccountsWithHidden];
      (db as any)._userAccounts = [...mockUserAccounts];
    });

    test('excludes hidden accounts by default', async () => {
      const result = await tools.getAccounts();
      expect(result.count).toBe(1);
      expect(result.accounts[0].account_id).toBe('acc_visible');
      expect(result.total_balance).toBe(1000.0);
    });

    test('includes hidden accounts when include_hidden is true', async () => {
      const result = await tools.getAccounts({ include_hidden: true });
      expect(result.count).toBe(2);
      expect(result.total_balance).toBe(6000.0);
    });
  });

  describe('getTransactions with filtering defaults', () => {
    beforeEach(() => {
      // Override with mock data that includes transfers, deleted, and excluded transactions
      (db as any)._transactions = [...mockTransactionsWithFilters];
    });

    test('excludes transfers, deleted, and excluded transactions by default', async () => {
      const result = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
      });
      // Only normal transaction should be returned
      expect(result.count).toBe(1);
      expect(result.transactions[0].transaction_id).toBe('txn_normal');
    });

    test('includes transfers when exclude_transfers is false', async () => {
      const result = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
        exclude_transfers: false,
      });
      // Normal + transfer
      expect(result.count).toBe(2);
    });

    test('includes deleted transactions when exclude_deleted is false', async () => {
      const result = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
        exclude_deleted: false,
      });
      // Normal + deleted
      expect(result.count).toBe(2);
    });

    test('includes excluded transactions when exclude_excluded is false', async () => {
      const result = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
        exclude_excluded: false,
      });
      // Normal + excluded
      expect(result.count).toBe(2);
    });

    test('includes all transactions when all filters are disabled', async () => {
      const result = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
        exclude_transfers: false,
        exclude_deleted: false,
        exclude_excluded: false,
      });
      // All 4 transactions
      expect(result.count).toBe(4);
    });
  });

  describe('getCategories', () => {
    test('returns all unique categories', async () => {
      const result = await tools.getCategories();

      expect(result.view).toBe('list');
      expect(result.count).toBeGreaterThan(0);
      expect((result.data as { categories: unknown[] }).categories).toBeDefined();
    });

    test('includes human-readable category names', async () => {
      const result = await tools.getCategories();
      const categories = (
        result.data as { categories: { category_id: string; category_name: string }[] }
      ).categories;

      const foodCategory = categories.find((c) => c.category_id === 'food_dining');
      expect(foodCategory?.category_name).toBe('Food & Drink');
    });

    test('includes transaction count and total amount', async () => {
      const result = await tools.getCategories();
      const categories = (
        result.data as { categories: { transaction_count: number; total_amount: number }[] }
      ).categories;

      // All categories should have valid count and amount fields (including $0)
      for (const cat of categories) {
        expect(cat.transaction_count).toBeGreaterThanOrEqual(0);
        expect(cat.total_amount).toBeGreaterThanOrEqual(0);
      }

      // Should include categories with transactions
      const categoriesWithTransactions = categories.filter((c) => c.transaction_count > 0);
      expect(categoriesWithTransactions.length).toBeGreaterThan(0);
    });

    test('filters by period', async () => {
      const result = await tools.getCategories({ period: 'this_month' });
      expect(result.view).toBe('list');
      expect(result.period).toBe('this_month');
    });

    test('filters by date range', async () => {
      const result = await tools.getCategories({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
      });
      expect(result.view).toBe('list');
      expect(result.period).toContain('2024-03');
    });

    test('includes parent category info', async () => {
      const result = await tools.getCategories();
      const categories = (
        result.data as {
          categories: {
            category_id: string;
            parent_id: string | null;
            parent_name: string | null;
          }[];
        }
      ).categories;

      // Find a subcategory that should have a parent
      const restaurants = categories.find((c) => c.category_id === 'restaurants');
      if (restaurants) {
        expect(restaurants.parent_id).toBe('food_and_drink');
        expect(restaurants.parent_name).toBe('Food & Drink');
      }

      // Root categories should have null parent
      const foodDrink = categories.find((c) => c.category_id === 'food_and_drink');
      if (foodDrink) {
        expect(foodDrink.parent_id).toBeNull();
        expect(foodDrink.parent_name).toBeNull();
      }
    });
  });

  describe('getGoals', () => {
    test('returns goals with current_amount from goal history', async () => {
      (db as any)._goals = [...mockGoals];
      (db as any)._goalHistory = [...mockGoalHistoryWrongOrder];

      const result = await tools.getGoals({});

      expect(result.count).toBe(2);
      expect(result.total_target).toBe(13000);
      expect(result.total_saved).toBe(2300); // 1500 + 800

      const emergencyFund = result.goals.find((g) => g.goal_id === 'goal1');
      expect(emergencyFund?.name).toBe('Emergency Fund');
      expect(emergencyFund?.target_amount).toBe(10000);
      expect(emergencyFund?.current_amount).toBe(1500); // Latest month (2024-03)
      expect(emergencyFund?.monthly_contribution).toBe(500);

      const vacationFund = result.goals.find((g) => g.goal_id === 'goal2');
      expect(vacationFund?.name).toBe('Vacation Fund');
      expect(vacationFund?.target_amount).toBe(3000);
      expect(vacationFund?.current_amount).toBe(800); // Latest month (2024-03)
    });

    test('uses latest month regardless of history order (regression test)', async () => {
      // This test specifically guards against the bug where we took the first
      // history entry instead of the latest month's entry
      (db as any)._goals = [
        { goal_id: 'test_goal', name: 'Test', savings: { target_amount: 1000 } },
      ];

      // Deliberately put oldest entry FIRST - this is the bug scenario
      (db as any)._goalHistory = [
        { goal_id: 'test_goal', month: '2023-01', current_amount: 100 }, // OLD - first in array
        { goal_id: 'test_goal', month: '2023-06', current_amount: 600 }, // NEWER
        { goal_id: 'test_goal', month: '2023-12', current_amount: 999 }, // LATEST - should use this
        { goal_id: 'test_goal', month: '2023-03', current_amount: 300 }, // OLD
      ];

      const result = await tools.getGoals({});

      // Must use 2023-12's value (999), NOT 2023-01's value (100)
      expect(result.goals[0]?.current_amount).toBe(999);
      expect(result.total_saved).toBe(999);
    });

    test('handles goals with no history', async () => {
      (db as any)._goals = [...mockGoals];
      (db as any)._goalHistory = []; // No history

      const result = await tools.getGoals({});

      expect(result.count).toBe(2);
      expect(result.total_saved).toBe(0);
      expect(result.goals[0]?.current_amount).toBeUndefined();
      expect(result.goals[1]?.current_amount).toBeUndefined();
    });

    test('handles history entries with undefined current_amount', async () => {
      (db as any)._goals = [{ goal_id: 'goal1', name: 'Test', savings: { target_amount: 1000 } }];
      (db as any)._goalHistory = [
        { goal_id: 'goal1', month: '2024-01' }, // No current_amount
        { goal_id: 'goal1', month: '2024-02', current_amount: 500 },
        { goal_id: 'goal1', month: '2024-03' }, // No current_amount
      ];

      const result = await tools.getGoals({});

      // Should use 2024-02's value since it's the latest with a defined current_amount
      expect(result.goals[0]?.current_amount).toBe(500);
    });

    test('filters active goals when active_only is true', async () => {
      const goalsWithInactive = [
        ...mockGoals,
        {
          goal_id: 'goal3',
          name: 'Paused Goal',
          savings: { target_amount: 5000, status: 'paused' },
        },
      ];
      (db as any)._goals = goalsWithInactive;
      (db as any)._goalHistory = [];

      const result = await tools.getGoals({ active_only: true });

      expect(result.count).toBe(2);
      expect(result.goals.map((g) => g.name)).toContain('Emergency Fund');
      expect(result.goals.map((g) => g.name)).toContain('Vacation Fund');
      expect(result.goals.map((g) => g.name)).not.toContain('Paused Goal');
    });
  });
});

describe('createToolSchemas', () => {
  test('returns 8 tool schemas', async () => {
    const schemas = createToolSchemas();
    expect(schemas).toHaveLength(8);
  });

  test('all tools have readOnlyHint: true', async () => {
    const schemas = createToolSchemas();

    for (const schema of schemas) {
      expect(schema.annotations?.readOnlyHint).toBe(true);
    }
  });

  test('all tools have required fields', async () => {
    const schemas = createToolSchemas();

    for (const schema of schemas) {
      expect(schema.name).toBeDefined();
      expect(schema.description).toBeDefined();
      expect(schema.inputSchema).toBeDefined();
      expect(schema.inputSchema.type).toBe('object');
      expect(schema.inputSchema.properties).toBeDefined();
    }
  });

  test('tool names match expected names', async () => {
    const schemas = createToolSchemas();
    const names = schemas.map((s) => s.name);

    // Core 8 tools
    expect(names).toContain('get_transactions');
    expect(names).toContain('get_cache_info');
    expect(names).toContain('refresh_database');
    expect(names).toContain('get_accounts');
    expect(names).toContain('get_categories');
    expect(names).toContain('get_recurring_transactions');
    expect(names).toContain('get_budgets');
    expect(names).toContain('get_goals');

    // Should have exactly 8 tools
    expect(names.length).toBe(8);
  });
});
