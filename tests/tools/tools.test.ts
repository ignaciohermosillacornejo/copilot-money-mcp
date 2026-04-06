/**
 * Unit tests for MCP tools.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyTools, createToolSchemas } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import type { Transaction, Account, Security, HoldingsHistory } from '../../src/models/index.js';

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

    test('filters by query (free-text search)', async () => {
      const result = await tools.getTransactions({ query: 'coffee' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].name).toBe('Coffee Shop');
    });

    test('query search is case-insensitive', async () => {
      const result = await tools.getTransactions({ query: 'GROCERY' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].name).toBe('Grocery Store');
    });

    test('filters by tag', async () => {
      const taggedTxn: Transaction = {
        transaction_id: 'txn_tagged',
        amount: 55.0,
        date: '2024-01-30',
        name: 'Business Lunch #work #expense',
        category_id: 'food_dining',
        account_id: 'acc1',
      };
      (db as any)._transactions = [...mockTransactions, taggedTxn];

      const result = await tools.getTransactions({ tag: 'work' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].name).toContain('#work');
    });

    test('filters by tag with # prefix', async () => {
      const taggedTxn: Transaction = {
        transaction_id: 'txn_tagged2',
        amount: 65.0,
        date: '2024-01-30',
        name: 'Office Supplies #business',
        category_id: 'shopping',
        account_id: 'acc1',
      };
      (db as any)._transactions = [...mockTransactions, taggedTxn];

      const result = await tools.getTransactions({ tag: '#business' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].name).toContain('#business');
    });

    test('filters by transaction_type hsa_eligible', async () => {
      const medicalTxn: Transaction = {
        transaction_id: 'txn_medical',
        amount: 150.0,
        date: '2024-01-30',
        name: 'CVS Pharmacy',
        category_id: 'medical_pharmacies_and_supplements',
        account_id: 'acc1',
      };
      (db as any)._transactions = [...mockTransactions, medicalTxn];

      const result = await tools.getTransactions({ transaction_type: 'hsa_eligible' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].name).toBe('CVS Pharmacy');
      expect(result.type_specific_data?.total_hsa_eligible).toBeDefined();
    });

    test('filters by transaction_type tagged', async () => {
      const taggedTxn: Transaction = {
        transaction_id: 'txn_with_tag',
        amount: 75.0,
        date: '2024-01-30',
        name: 'Team Dinner #team',
        category_id: 'food_dining',
        account_id: 'acc1',
      };
      (db as any)._transactions = [...mockTransactions, taggedTxn];

      const result = await tools.getTransactions({ transaction_type: 'tagged' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].name).toContain('#');
      expect(result.type_specific_data?.tags).toBeDefined();
      expect(Array.isArray(result.type_specific_data?.tags)).toBe(true);
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

    test('returns tree view with hierarchy', async () => {
      const result = await tools.getCategories({ view: 'tree' });

      expect(result.view).toBe('tree');
      expect(result.count).toBeGreaterThan(0);
      const data = result.data as { categories: { id: string; children: unknown[] }[] };
      expect(data.categories).toBeDefined();
      expect(Array.isArray(data.categories)).toBe(true);

      // Each root category should have children array
      for (const cat of data.categories) {
        expect(cat.id).toBeDefined();
        expect(Array.isArray(cat.children)).toBe(true);
      }
    });

    test('returns search view with matching categories', async () => {
      const result = await tools.getCategories({ view: 'search', query: 'groceries' });

      expect(result.view).toBe('search');
      const data = result.data as {
        query: string;
        categories: { name: string; display_name: string }[];
      };
      expect(data.query).toBe('groceries');
      expect(data.categories).toBeDefined();
      expect(Array.isArray(data.categories)).toBe(true);
      expect(data.categories.length).toBeGreaterThan(0);

      // At least one result should contain 'groceries'
      const hasGroceries = data.categories.some(
        (cat) =>
          cat.name.toLowerCase().includes('groceries') ||
          cat.display_name.toLowerCase().includes('groceries')
      );
      expect(hasGroceries).toBe(true);
    });

    test('returns subcategories view when parent_id provided', async () => {
      const result = await tools.getCategories({ parent_id: 'food_and_drink' });

      expect(result.view).toBe('subcategories');
      const data = result.data as {
        parent_id: string;
        parent_name: string;
        subcategories: { id: string; name: string }[];
      };
      expect(data.parent_id).toBe('food_and_drink');
      expect(data.parent_name).toBe('Food & Drink');
      expect(Array.isArray(data.subcategories)).toBe(true);
      expect(data.subcategories.length).toBeGreaterThan(0);
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

  describe('getBudgets', () => {
    test('returns budgets with category names resolved', async () => {
      (db as any)._budgets = [
        {
          budget_id: 'budget1',
          name: 'Food Budget',
          amount: 500,
          period: 'monthly',
          category_id: 'food_and_drink',
          is_active: true,
        },
      ];
      (db as any)._userCategories = [];

      const result = await tools.getBudgets({});

      expect(result.count).toBe(1);
      expect(result.budgets[0].category_name).toBe('Food & Drink');
    });

    test('filters out budgets with orphaned category references', async () => {
      (db as any)._budgets = [
        {
          budget_id: 'valid_plaid',
          amount: 100,
          category_id: 'food_and_drink', // Known Plaid category
          is_active: true,
        },
        {
          budget_id: 'valid_user',
          amount: 200,
          category_id: 'user_cat_1', // User-defined category
          is_active: true,
        },
        {
          budget_id: 'orphan',
          amount: 50,
          category_id: 'rXFkilafMIseI6OMZ6ze', // Orphaned (deleted category)
          is_active: true,
        },
        {
          budget_id: 'no_category',
          amount: 75, // No category - should keep
          is_active: true,
        },
      ];
      // Set up user category map (must set the cache directly as _categoryNameMap)
      (db as any)._categoryNameMap = new Map([['user_cat_1', 'My Custom Category']]);

      const result = await tools.getBudgets({});

      expect(result.count).toBe(3);
      expect(result.budgets.map((b) => b.budget_id)).toContain('valid_plaid');
      expect(result.budgets.map((b) => b.budget_id)).toContain('valid_user');
      expect(result.budgets.map((b) => b.budget_id)).toContain('no_category');
      expect(result.budgets.map((b) => b.budget_id)).not.toContain('orphan');
    });

    test('calculates total_budgeted excluding orphaned budgets', async () => {
      (db as any)._budgets = [
        {
          budget_id: 'valid',
          amount: 100,
          period: 'monthly',
          category_id: 'food_and_drink',
          is_active: true,
        },
        {
          budget_id: 'orphan',
          amount: 9999, // Should not be included in total
          period: 'monthly',
          category_id: 'deleted_category_id_xyz',
          is_active: true,
        },
      ];
      (db as any)._userCategories = [];

      const result = await tools.getBudgets({});

      expect(result.count).toBe(1);
      expect(result.total_budgeted).toBe(100);
    });

    test('keeps budgets with numeric Plaid category IDs', async () => {
      (db as any)._budgets = [
        {
          budget_id: 'numeric_cat',
          amount: 150,
          category_id: '13005000', // Numeric Plaid ID for Food & Drink > Restaurant
          is_active: true,
        },
      ];
      (db as any)._userCategories = [];

      const result = await tools.getBudgets({});

      expect(result.count).toBe(1);
      expect(result.budgets[0].category_name).toBe('Food & Drink > Restaurant');
    });
  });
});

describe('CopilotMoneyTools - Location Filtering', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    tools = new CopilotMoneyTools(db);
    (db as any)._allCollectionsLoaded = true;
    (db as any)._accounts = mockAccounts;
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
  });

  test('filters by lat/lon coordinates within radius', async () => {
    // San Francisco coordinates: 37.7749, -122.4194
    const transactionsWithLocation: Transaction[] = [
      {
        transaction_id: 'txn_sf',
        amount: 50.0,
        date: '2024-01-15',
        name: 'SF Restaurant',
        category_id: 'food_dining',
        account_id: 'acc1',
        lat: 37.7749,
        lon: -122.4194,
      },
      {
        transaction_id: 'txn_oakland',
        amount: 30.0,
        date: '2024-01-16',
        name: 'Oakland Store',
        category_id: 'shopping',
        account_id: 'acc1',
        lat: 37.8044,
        lon: -122.2712, // ~15km from SF
      },
      {
        transaction_id: 'txn_la',
        amount: 100.0,
        date: '2024-01-17',
        name: 'LA Store',
        category_id: 'shopping',
        account_id: 'acc1',
        lat: 34.0522,
        lon: -118.2437, // ~560km from SF
      },
      {
        transaction_id: 'txn_no_location',
        amount: 25.0,
        date: '2024-01-18',
        name: 'No Location',
        category_id: 'shopping',
        account_id: 'acc1',
      },
    ];
    (db as any)._transactions = transactionsWithLocation;

    // Search near SF with 20km radius - should find SF and Oakland
    const result = await tools.getTransactions({
      lat: 37.7749,
      lon: -122.4194,
      radius_km: 20,
    });

    expect(result.count).toBe(2);
    expect(result.transactions.map((t) => t.transaction_id)).toContain('txn_sf');
    expect(result.transactions.map((t) => t.transaction_id)).toContain('txn_oakland');
    expect(result.transactions.map((t) => t.transaction_id)).not.toContain('txn_la');
    expect(result.transactions.map((t) => t.transaction_id)).not.toContain('txn_no_location');
  });

  test('filters by city name', async () => {
    const transactionsWithCity: Transaction[] = [
      {
        transaction_id: 'txn_sf_city',
        amount: 50.0,
        date: '2024-01-15',
        name: 'SF Restaurant',
        category_id: 'food_dining',
        account_id: 'acc1',
        city: 'San Francisco',
      },
      {
        transaction_id: 'txn_la_city',
        amount: 100.0,
        date: '2024-01-17',
        name: 'LA Store',
        category_id: 'shopping',
        account_id: 'acc1',
        city: 'Los Angeles',
      },
    ];
    (db as any)._transactions = transactionsWithCity;

    const result = await tools.getTransactions({ city: 'San Francisco' });

    expect(result.count).toBe(1);
    expect(result.transactions[0].transaction_id).toBe('txn_sf_city');
  });

  test('defaults to 10km radius when not specified', async () => {
    const transactionsWithLocation: Transaction[] = [
      {
        transaction_id: 'txn_close',
        amount: 50.0,
        date: '2024-01-15',
        name: 'Close Store',
        category_id: 'shopping',
        account_id: 'acc1',
        lat: 37.78,
        lon: -122.42, // ~1km from center
      },
      {
        transaction_id: 'txn_far',
        amount: 30.0,
        date: '2024-01-16',
        name: 'Far Store',
        category_id: 'shopping',
        account_id: 'acc1',
        lat: 37.9,
        lon: -122.5, // ~15km from center
      },
    ];
    (db as any)._transactions = transactionsWithLocation;

    // Search without radius_km - should use default 10km
    const result = await tools.getTransactions({
      lat: 37.7749,
      lon: -122.4194,
    });

    expect(result.count).toBe(1);
    expect(result.transactions[0].transaction_id).toBe('txn_close');
  });
});

describe('CopilotMoneyTools - Recurring Transactions Detail View', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    tools = new CopilotMoneyTools(db);
    (db as any)._allCollectionsLoaded = true;
    (db as any)._accounts = mockAccounts;
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
  });

  test('returns detail view with transaction history when filtering by name', async () => {
    const mockRecurring = [
      {
        recurring_id: 'rec1',
        name: 'Netflix',
        amount: 15.99,
        merchant_name: 'Netflix',
        category_id: 'entertainment',
        account_id: 'acc1',
        frequency: 'monthly',
        state: 'active',
        transaction_ids: ['txn1', 'txn2'],
      },
    ];
    const mockTransactionsForHistory: Transaction[] = [
      {
        transaction_id: 'txn1',
        amount: 15.99,
        date: '2024-01-01',
        name: 'Netflix',
        category_id: 'entertainment',
        account_id: 'acc1',
      },
      {
        transaction_id: 'txn2',
        amount: 15.99,
        date: '2024-02-01',
        name: 'Netflix',
        category_id: 'entertainment',
        account_id: 'acc1',
      },
    ];
    (db as any)._recurring = mockRecurring;
    (db as any)._transactions = mockTransactionsForHistory;

    const result = await tools.getRecurringTransactions({ name: 'Netflix' });

    expect(result.detail_view).toBeDefined();
    expect(result.detail_view?.length).toBe(1);
    expect(result.detail_view?.[0].name).toBe('Netflix');
    expect(result.detail_view?.[0].transaction_history).toBeDefined();
    expect(result.detail_view?.[0].transaction_history?.length).toBe(2);
    // Transaction history is sorted by date descending, so txn2 (Feb) comes first
    expect(result.detail_view?.[0].transaction_history?.[0].transaction_id).toBe('txn2');
    expect(result.detail_view?.[0].transaction_history?.[1].transaction_id).toBe('txn1');
  });

  test('returns empty transaction history when no transaction_ids', async () => {
    const mockRecurring = [
      {
        recurring_id: 'rec1',
        name: 'Spotify',
        amount: 9.99,
        merchant_name: 'Spotify',
        category_id: 'entertainment',
        account_id: 'acc1',
        frequency: 'monthly',
        state: 'active',
        // No transaction_ids
      },
    ];
    (db as any)._recurring = mockRecurring;
    (db as any)._transactions = [];

    const result = await tools.getRecurringTransactions({ name: 'Spotify' });

    expect(result.detail_view).toBeDefined();
    expect(result.detail_view?.length).toBe(1);
    expect(result.detail_view?.[0].transaction_history).toEqual([]);
  });

  test('detects pattern-based recurring from repeated transactions', async () => {
    // Create multiple transactions with the same merchant over time
    const recurringTransactions: Transaction[] = [
      {
        transaction_id: 'gym1',
        amount: 50.0,
        date: '2024-01-15',
        name: 'Planet Fitness',
        category_id: 'personal_care_gyms_and_fitness_centers',
        account_id: 'acc1',
      },
      {
        transaction_id: 'gym2',
        amount: 50.0,
        date: '2024-02-15',
        name: 'Planet Fitness',
        category_id: 'personal_care_gyms_and_fitness_centers',
        account_id: 'acc1',
      },
      {
        transaction_id: 'gym3',
        amount: 50.0,
        date: '2024-03-15',
        name: 'Planet Fitness',
        category_id: 'personal_care_gyms_and_fitness_centers',
        account_id: 'acc1',
      },
    ];
    (db as any)._recurring = []; // No Copilot native recurring
    (db as any)._transactions = recurringTransactions;

    // Explicitly set date range to cover the test transactions
    const result = await tools.getRecurringTransactions({
      start_date: '2024-01-01',
      end_date: '2024-04-01',
    });

    // Should detect pattern-based recurring
    expect(result.count).toBeGreaterThan(0);
    const planetFitness = result.recurring.find((r) => r.merchant === 'Planet Fitness');
    expect(planetFitness).toBeDefined();
    expect(planetFitness?.occurrences).toBe(3);
    expect(planetFitness?.average_amount).toBe(50);
    expect(planetFitness?.transactions).toBeDefined();
    expect(planetFitness?.transactions?.length).toBeLessThanOrEqual(5);
  });

  test('returns copilot subscriptions with grouped items by state', async () => {
    // Create mock Copilot recurring with various states
    const mockRecurringForCalendar = [
      {
        recurring_id: 'rec_active',
        name: 'Netflix',
        amount: 15.99,
        merchant_name: 'Netflix',
        category_id: 'entertainment',
        account_id: 'acc1',
        frequency: 'monthly',
        state: 'active',
        next_date: '2026-02-01',
      },
      {
        recurring_id: 'rec_paused',
        name: 'Gym',
        amount: 50.0,
        merchant_name: 'Planet Fitness',
        category_id: 'fitness',
        account_id: 'acc1',
        frequency: 'monthly',
        state: 'paused',
      },
      {
        recurring_id: 'rec_archived',
        name: 'Old Service',
        amount: 9.99,
        frequency: 'monthly',
        state: 'archived',
      },
    ];
    (db as any)._recurring = mockRecurringForCalendar;
    (db as any)._transactions = [];

    // Call without name filter to get the copilot_subscriptions view
    const result = await tools.getRecurringTransactions({});

    // Verify copilot_subscriptions structure
    expect(result.copilot_subscriptions).toBeDefined();
    expect(result.copilot_subscriptions?.summary).toBeDefined();
    expect(result.copilot_subscriptions?.summary?.total_active).toBe(1);
    expect(result.copilot_subscriptions?.summary?.total_paused).toBe(1);
    expect(result.copilot_subscriptions?.summary?.total_archived).toBe(1);
    expect(result.copilot_subscriptions?.paused?.length).toBe(1);
    expect(result.copilot_subscriptions?.archived?.length).toBe(1);
  });
});

describe('getCacheInfo', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    // Mock the database with test data
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
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

  test('returns cache info with transaction date range', async () => {
    const result = await tools.getCacheInfo();

    expect(result.transaction_count).toBe(4);
    expect(result.oldest_transaction_date).toBe('2024-01-15');
    expect(result.newest_transaction_date).toBe('2024-02-10');
    expect(result.cache_note).toContain('4 transactions');
  });

  test('returns null dates for empty database', async () => {
    (db as any)._transactions = [];

    const result = await tools.getCacheInfo();

    expect(result.transaction_count).toBe(0);
    expect(result.oldest_transaction_date).toBeNull();
    expect(result.newest_transaction_date).toBeNull();
    expect(result.cache_note).toContain('No transactions');
  });
});

describe('refreshDatabase', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    // Mock the database with test data
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
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

  test('clearCache clears internal state', () => {
    // First verify data is loaded
    expect((db as any)._transactions).toHaveLength(4);

    // Clear the cache
    const result = db.clearCache();

    expect(result.cleared).toBe(true);
    expect((db as any)._transactions).toBeNull();
    expect((db as any)._accounts).toBeNull();
  });

  test('refreshDatabase return structure is correct', async () => {
    // Mock getCacheInfo to avoid disk access after clearCache
    const mockCacheInfo = {
      oldest_transaction_date: '2024-01-01',
      newest_transaction_date: '2024-03-01',
      transaction_count: 100,
      cache_note: 'Test cache info',
    };
    db.getCacheInfo = async () => mockCacheInfo;

    const result = await tools.refreshDatabase();

    expect(result.refreshed).toBe(true);
    expect(result.message).toContain('refreshed');
    expect(result.cache_info).toBeDefined();
    expect(result.cache_info.transaction_count).toBe(100);
    expect(result.cache_info.oldest_transaction_date).toBe('2024-01-01');
    expect(result.cache_info.newest_transaction_date).toBe('2024-03-01');
  });
});

describe('createToolSchemas', () => {
  test('returns 12 tool schemas', async () => {
    const schemas = createToolSchemas();
    expect(schemas).toHaveLength(12);
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

    // Core tools
    expect(names).toContain('get_transactions');
    expect(names).toContain('get_cache_info');
    expect(names).toContain('refresh_database');
    expect(names).toContain('get_accounts');
    expect(names).toContain('get_connection_status');
    expect(names).toContain('get_categories');
    expect(names).toContain('get_recurring_transactions');
    expect(names).toContain('get_budgets');
    expect(names).toContain('get_goals');
    expect(names).toContain('get_investment_prices');
    expect(names).toContain('get_investment_splits');
    expect(names).toContain('get_holdings');

    // Should have exactly 12 tools
    expect(names.length).toBe(12);
  });
});

describe('getConnectionStatus', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  const mockItems = [
    {
      item_id: 'item1',
      institution_name: 'Chase',
      institution_id: 'ins_56',
      billed_products: ['transactions'],
      status_transactions_last_successful_update: '2026-03-08T06:14:29.057Z',
      status_transactions_last_failed_update: null,
      latest_fetch: '2026-03-08T06:14:34.117Z',
      login_required: false,
      disconnected: false,
      consent_expiration_time: null,
      error_code: null,
      error_message: null,
    },
    {
      item_id: 'item2',
      institution_name: 'Wells Fargo',
      institution_id: 'ins_127991',
      billed_products: ['transactions'],
      status_transactions_last_successful_update: '2026-03-07T05:40:00.864Z',
      latest_fetch: '2026-03-07T14:51:45.246Z',
      login_required: true,
      disconnected: false,
      consent_expiration_time: null,
      error_code: null,
      error_message: null,
    },
    {
      item_id: 'item3',
      institution_name: 'Fidelity',
      institution_id: 'akoya_fidelity',
      billed_products: ['investments'],
      status_investments_last_successful_update: '2026-03-08T15:52:47.181Z',
      latest_investments_fetch: '2026-03-08T15:52:47.481Z',
      login_required: false,
      disconnected: false,
      consent_expiration_time: '2027-01-06T03:00:29Z',
      error_code: null,
      error_message: null,
    },
  ];

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
    (db as any)._recurring = [];
    (db as any)._budgets = [];
    (db as any)._goals = [];
    (db as any)._goalHistory = [];
    (db as any)._investmentPrices = [];
    (db as any)._investmentSplits = [];
    (db as any)._items = [...mockItems];
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
    (db as any)._categoryNameMap = new Map<string, string>();
    (db as any)._accountNameMap = new Map<string, string>();

    tools = new CopilotMoneyTools(db);
  });

  test('returns connection status for all institutions', async () => {
    const result = await tools.getConnectionStatus();

    expect(result.connections.length).toBe(3);
    expect(result.summary.total).toBe(3);
  });

  test('correctly identifies connected institutions', async () => {
    const result = await tools.getConnectionStatus();

    const chase = result.connections.find((c) => c.institution_name === 'Chase');
    expect(chase?.status).toBe('connected');
    expect(chase?.login_required).toBe(false);
    expect(chase?.last_transactions_update).toBe('2026-03-08T06:14:29.057Z');
    expect(chase?.latest_fetch).toBe('2026-03-08T06:14:34.117Z');
  });

  test('correctly identifies login_required institutions', async () => {
    const result = await tools.getConnectionStatus();

    const wells = result.connections.find((c) => c.institution_name === 'Wells Fargo');
    expect(wells?.status).toBe('login_required');
    expect(wells?.login_required).toBe(true);
  });

  test('returns per-product sync timestamps', async () => {
    const result = await tools.getConnectionStatus();

    const fidelity = result.connections.find((c) => c.institution_name === 'Fidelity');
    expect(fidelity?.last_investments_update).toBe('2026-03-08T15:52:47.181Z');
    expect(fidelity?.consent_expires).toBe('2027-01-06T03:00:29Z');
  });

  test('summary counts are accurate', async () => {
    const result = await tools.getConnectionStatus();

    expect(result.summary.connected).toBe(2); // Chase + Fidelity
    expect(result.summary.needs_attention).toBe(1); // Wells Fargo (login_required)
  });

  test('returns empty connections for no items', async () => {
    (db as any)._items = [];

    const result = await tools.getConnectionStatus();

    expect(result.connections.length).toBe(0);
    expect(result.summary.total).toBe(0);
    expect(result.summary.connected).toBe(0);
    expect(result.summary.needs_attention).toBe(0);
  });
});

describe('getAccounts - total balance calculation', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._transactions = [];
    (db as any)._accounts = [];
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

  test('calculates total balance with mixed account types', async () => {
    // Mock accounts with assets and liabilities
    const mixedAccounts: Account[] = [
      {
        account_id: 'checking1',
        current_balance: 1000.0,
        account_type: 'depository', // ASSET
        name: 'Checking',
      },
      {
        account_id: 'investment1',
        current_balance: 5000.0,
        account_type: 'investment', // ASSET
        name: 'Brokerage',
      },
      {
        account_id: 'mortgage1',
        current_balance: 300000.0,
        account_type: 'loan', // LIABILITY
        name: 'Mortgage',
      },
      {
        account_id: 'credit1',
        current_balance: 2000.0,
        account_type: 'credit', // LIABILITY
        name: 'Credit Card',
      },
    ];

    (db as any)._accounts = mixedAccounts;
    (db as any)._userAccounts = [];

    const result = await tools.getAccounts();

    // Total Balance = Assets - Liabilities
    // = (1000 + 5000) - (300000 + 2000) = 6000 - 302000 = -296000
    expect(result.total_balance).toBe(-296000.0);
    expect(result.total_assets).toBe(6000.0);
    expect(result.total_liabilities).toBe(302000.0);
    expect(result.count).toBe(4);
  });

  test('handles only asset accounts', async () => {
    const assetAccounts: Account[] = [
      {
        account_id: 'checking1',
        current_balance: 1000.0,
        account_type: 'depository',
        name: 'Checking',
      },
      {
        account_id: 'investment1',
        current_balance: 5000.0,
        account_type: 'investment',
        name: 'Brokerage',
      },
    ];

    (db as any)._accounts = assetAccounts;
    (db as any)._userAccounts = [];

    const result = await tools.getAccounts();
    expect(result.total_balance).toBe(6000.0); // 1000 + 5000
    expect(result.total_assets).toBe(6000.0);
    expect(result.total_liabilities).toBe(0);
  });

  test('handles only liability accounts', async () => {
    const liabilityAccounts: Account[] = [
      {
        account_id: 'mortgage1',
        current_balance: 300000.0,
        account_type: 'loan',
        name: 'Mortgage',
      },
      {
        account_id: 'credit1',
        current_balance: 2000.0,
        account_type: 'credit',
        name: 'Credit Card',
      },
    ];

    (db as any)._accounts = liabilityAccounts;
    (db as any)._userAccounts = [];

    const result = await tools.getAccounts();
    expect(result.total_balance).toBe(-302000.0); // -(300000 + 2000)
    expect(result.total_assets).toBe(0);
    expect(result.total_liabilities).toBe(302000.0);
  });

  test('handles real estate accounts as assets', async () => {
    const realEstateAccounts: Account[] = [
      {
        account_id: 'house1',
        current_balance: 500000.0,
        account_type: 'real-estate',
        name: 'Primary Home',
      },
      {
        account_id: 'mortgage1',
        current_balance: 400000.0,
        account_type: 'loan',
        name: 'Mortgage',
      },
    ];

    (db as any)._accounts = realEstateAccounts;
    (db as any)._userAccounts = [];

    const result = await tools.getAccounts();
    // Home equity = 500000 - 400000 = 100000
    expect(result.total_balance).toBe(100000.0);
    expect(result.total_assets).toBe(500000.0);
    expect(result.total_liabilities).toBe(400000.0);
  });

  test('handles unknown account types as assets (legacy behavior)', async () => {
    const unknownAccounts: Account[] = [
      {
        account_id: 'unknown1',
        current_balance: 1000.0,
        account_type: 'unknown_type',
        name: 'Unknown Account',
      },
    ];

    (db as any)._accounts = unknownAccounts;
    (db as any)._userAccounts = [];

    const result = await tools.getAccounts();
    expect(result.total_balance).toBe(1000.0); // Treated as asset
    expect(result.total_assets).toBe(1000.0);
    expect(result.total_liabilities).toBe(0);
  });
});

describe('database securities accessors', () => {
  let db: CopilotDatabase;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._securities = [
      {
        security_id: 'hash1',
        ticker_symbol: 'AAPL',
        name: 'Apple Inc.',
        type: 'equity',
        current_price: 150.0,
        is_cash_equivalent: false,
      },
      {
        security_id: 'hash2',
        ticker_symbol: 'SCHX',
        name: 'Schwab U.S. Large-Cap ETF',
        type: 'etf',
        current_price: 25.0,
        is_cash_equivalent: false,
      },
      {
        security_id: 'hash3',
        ticker_symbol: 'USD',
        name: 'United States Dollar',
        type: 'cash',
        current_price: 1.0,
        is_cash_equivalent: true,
      },
    ];
  });

  test('getSecurities returns all securities', async () => {
    const result = await db.getSecurities();
    expect(result.length).toBe(3);
  });

  test('getSecurityMap returns map keyed by security_id', async () => {
    const map = await db.getSecurityMap();
    expect(map.size).toBe(3);
    expect(map.get('hash1')?.ticker_symbol).toBe('AAPL');
    expect(map.get('hash2')?.ticker_symbol).toBe('SCHX');
  });
});

describe('getInvestmentPrices', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._allCollectionsLoaded = true;
    (db as any)._accounts = [];
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
    (db as any)._investmentPrices = [
      {
        investment_id: 'hash1',
        ticker_symbol: 'AAPL',
        price: 150.0,
        date: '2024-01-15',
        price_type: 'hf',
      },
      {
        investment_id: 'hash1',
        ticker_symbol: 'AAPL',
        month: '2024-01',
        close_price: 148.0,
        price_type: 'daily',
      },
      {
        investment_id: 'hash2',
        ticker_symbol: 'SCHX',
        price: 25.0,
        date: '2024-01-15',
        price_type: 'hf',
      },
      {
        investment_id: 'hash2',
        ticker_symbol: 'SCHX',
        month: '2024-02',
        close_price: 26.0,
        price_type: 'daily',
      },
    ];
    tools = new CopilotMoneyTools(db);
  });

  test('returns all prices', async () => {
    const result = await tools.getInvestmentPrices({});
    expect(result.count).toBe(4);
    expect(result.total_count).toBe(4);
    expect(result).toHaveProperty('tickers');
    expect(result).toHaveProperty('prices');
  });

  test('filters by ticker_symbol', async () => {
    const result = await tools.getInvestmentPrices({ ticker_symbol: 'AAPL' });
    expect(result.count).toBe(2);
    for (const p of result.prices) {
      expect(p.ticker_symbol).toBe('AAPL');
    }
  });

  test('filters by price_type', async () => {
    const result = await tools.getInvestmentPrices({ price_type: 'daily' });
    expect(result.count).toBe(2);
    for (const p of result.prices) {
      expect(p.price_type).toBe('daily');
    }
  });

  test('respects limit and offset', async () => {
    const result = await tools.getInvestmentPrices({ limit: 2, offset: 1 });
    expect(result.count).toBe(2);
    expect(result.total_count).toBe(4);
    expect(result.offset).toBe(1);
    expect(result.has_more).toBe(true);
  });

  test('returns unique tickers list', async () => {
    const result = await tools.getInvestmentPrices({});
    expect(result.tickers).toContain('AAPL');
    expect(result.tickers).toContain('SCHX');
    expect(result.tickers.length).toBe(2);
  });

  test('ticker_symbol filter is case-insensitive', async () => {
    const result = await tools.getInvestmentPrices({ ticker_symbol: 'aapl' });
    expect(result.count).toBe(2);
    for (const p of result.prices) {
      expect(p.ticker_symbol).toBe('AAPL');
    }
  });

  test('daily prices are not excluded by date filter (month fallback)', async () => {
    // Daily prices have p.month (e.g., "2024-01") instead of p.date.
    // The database filter falls back to p.month so daily prices aren't silently dropped.
    const allDaily = await tools.getInvestmentPrices({ price_type: 'daily' });
    expect(allDaily.count).toBe(2);

    // A broad date range should include all daily prices
    const filtered = await tools.getInvestmentPrices({
      price_type: 'daily',
      start_date: '2023-01-01',
      end_date: '2025-12-31',
    });
    expect(filtered.count).toBe(2);
  });
});

describe('getInvestmentSplits', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._allCollectionsLoaded = true;
    (db as any)._accounts = [];
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
    (db as any)._investmentSplits = [
      {
        split_id: 's1',
        ticker_symbol: 'AAPL',
        split_date: '2020-08-31',
        split_ratio: '4:1',
        multiplier: 4,
      },
      {
        split_id: 's2',
        ticker_symbol: 'TSLA',
        split_date: '2022-08-25',
        split_ratio: '3:1',
        multiplier: 3,
      },
      {
        split_id: 's3',
        ticker_symbol: 'AAPL',
        split_date: '2014-06-09',
        split_ratio: '7:1',
        multiplier: 7,
      },
    ];
    tools = new CopilotMoneyTools(db);
  });

  test('returns all splits', async () => {
    const result = await tools.getInvestmentSplits({});
    expect(result.count).toBe(3);
    expect(result.total_count).toBe(3);
    expect(result).toHaveProperty('splits');
  });

  test('filters by ticker_symbol', async () => {
    const result = await tools.getInvestmentSplits({ ticker_symbol: 'AAPL' });
    expect(result.count).toBe(2);
    for (const s of result.splits) {
      expect(s.ticker_symbol).toBe('AAPL');
    }
  });

  test('filters by date range', async () => {
    const result = await tools.getInvestmentSplits({
      start_date: '2020-01-01',
      end_date: '2021-12-31',
    });
    expect(result.count).toBe(1);
    expect(result.splits[0].ticker_symbol).toBe('AAPL');
  });

  test('respects limit and offset', async () => {
    const result = await tools.getInvestmentSplits({ limit: 1, offset: 0 });
    expect(result.count).toBe(1);
    expect(result.total_count).toBe(3);
    expect(result.has_more).toBe(true);
  });

  test('ticker_symbol filter is case-insensitive', async () => {
    const result = await tools.getInvestmentSplits({ ticker_symbol: 'tsla' });
    expect(result.count).toBe(1);
    expect(result.splits[0].ticker_symbol).toBe('TSLA');
  });
});

const mockSecurities: Security[] = [
  {
    security_id: 'sec_aapl',
    ticker_symbol: 'AAPL',
    name: 'Apple Inc.',
    type: 'equity',
    current_price: 190.0,
    is_cash_equivalent: false,
    iso_currency_code: 'USD',
  },
  {
    security_id: 'sec_schx',
    ticker_symbol: 'SCHX',
    name: 'Schwab U.S. Large-Cap ETF',
    type: 'etf',
    current_price: 25.0,
    is_cash_equivalent: false,
    iso_currency_code: 'USD',
  },
  {
    security_id: 'sec_usd',
    ticker_symbol: 'USD',
    name: 'United States Dollar',
    type: 'cash',
    current_price: 1.0,
    is_cash_equivalent: true,
    iso_currency_code: 'USD',
  },
];

const mockAccountsWithHoldings: Account[] = [
  {
    account_id: 'inv_acc1',
    current_balance: 100000,
    name: 'Individual Brokerage',
    account_type: 'investment',
    holdings: [
      {
        security_id: 'sec_aapl',
        account_id: 'inv_acc1',
        cost_basis: 15000,
        institution_price: 190.0,
        institution_value: 19000,
        quantity: 100,
        iso_currency_code: 'USD',
      },
      {
        security_id: 'sec_schx',
        account_id: 'inv_acc1',
        cost_basis: 5000,
        institution_price: 25.0,
        institution_value: 7500,
        quantity: 300,
        iso_currency_code: 'USD',
      },
      {
        security_id: 'sec_usd',
        account_id: 'inv_acc1',
        cost_basis: null,
        institution_price: 1.0,
        institution_value: 500,
        quantity: 500,
        iso_currency_code: 'USD',
      },
    ],
  },
  {
    account_id: 'inv_acc2',
    current_balance: 50000,
    name: 'Retirement 401k',
    account_type: 'investment',
    holdings: [
      {
        security_id: 'sec_schx',
        account_id: 'inv_acc2',
        cost_basis: 8000,
        institution_price: 25.0,
        institution_value: 12500,
        quantity: 500,
        iso_currency_code: 'USD',
      },
    ],
  },
];

const mockHoldingsHistoryData: HoldingsHistory[] = [
  {
    history_id: 'sec_aapl:2024-01',
    security_id: 'sec_aapl',
    account_id: 'inv_acc1',
    month: '2024-01',
    history: {
      '2024-01-15': { price: 185.0, quantity: 100 },
      '2024-01-31': { price: 188.0, quantity: 100 },
    },
  },
  {
    history_id: 'sec_aapl:2024-02',
    security_id: 'sec_aapl',
    account_id: 'inv_acc1',
    month: '2024-02',
    history: { '2024-02-15': { price: 189.0, quantity: 100 } },
  },
];

describe('getHoldings', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._allCollectionsLoaded = true;
    (db as any)._transactions = [];
    (db as any)._accounts = [...mockAccountsWithHoldings];
    (db as any)._recurring = [];
    (db as any)._budgets = [];
    (db as any)._goals = [];
    (db as any)._goalHistory = [];
    (db as any)._investmentPrices = [];
    (db as any)._investmentSplits = [];
    (db as any)._items = [];
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
    (db as any)._securities = [...mockSecurities];
    (db as any)._holdingsHistory = [...mockHoldingsHistoryData];
    tools = new CopilotMoneyTools(db);
  });

  test('returns all holdings enriched with security data', async () => {
    const result = await tools.getHoldings({});
    expect(result.total_count).toBe(4);
    expect(result.count).toBe(4);

    const aapl = result.holdings.find((h) => h.ticker_symbol === 'AAPL');
    expect(aapl).toBeDefined();
    expect(aapl!.name).toBe('Apple Inc.');
    expect(aapl!.type).toBe('equity');
    expect(aapl!.quantity).toBe(100);
    expect(aapl!.institution_price).toBe(190.0);
    expect(aapl!.institution_value).toBe(19000);
    expect(aapl!.account_name).toBe('Individual Brokerage');
  });

  test('computes average_cost and total_return when cost_basis is present', async () => {
    const result = await tools.getHoldings({});
    const aapl = result.holdings.find((h) => h.ticker_symbol === 'AAPL');
    expect(aapl!.cost_basis).toBe(15000);
    expect(aapl!.average_cost).toBe(150);
    expect(aapl!.total_return).toBe(4000);
    expect(aapl!.total_return_percent).toBeCloseTo(26.67, 1);
  });

  test('omits average_cost and total_return when cost_basis is null', async () => {
    const result = await tools.getHoldings({});
    const usd = result.holdings.find((h) => h.ticker_symbol === 'USD');
    expect(usd).toBeDefined();
    expect(usd!.cost_basis).toBeUndefined();
    expect(usd!.average_cost).toBeUndefined();
    expect(usd!.total_return).toBeUndefined();
  });

  test('filters by account_id', async () => {
    const result = await tools.getHoldings({ account_id: 'inv_acc2' });
    expect(result.count).toBe(1);
    expect(result.holdings[0].ticker_symbol).toBe('SCHX');
    expect(result.holdings[0].account_name).toBe('Retirement 401k');
  });

  test('filters by ticker_symbol', async () => {
    const result = await tools.getHoldings({ ticker_symbol: 'SCHX' });
    expect(result.count).toBe(2);
    for (const h of result.holdings) {
      expect(h.ticker_symbol).toBe('SCHX');
    }
  });

  test('does not include history by default', async () => {
    const result = await tools.getHoldings({});
    for (const h of result.holdings) {
      expect(h.history).toBeUndefined();
    }
  });

  test('includes history when include_history is true', async () => {
    const result = await tools.getHoldings({ include_history: true });
    const aapl = result.holdings.find((h) => h.ticker_symbol === 'AAPL');
    expect(aapl!.history).toBeDefined();
    expect(aapl!.history!.length).toBe(2);
  });

  test('respects limit and offset', async () => {
    const result = await tools.getHoldings({ limit: 2, offset: 1 });
    expect(result.count).toBe(2);
    expect(result.total_count).toBe(4);
    expect(result.offset).toBe(1);
    expect(result.has_more).toBe(true);
  });

  test('omits cost basis fields when quantity is zero', async () => {
    (db as any)._accounts = [
      {
        account_id: 'inv_zero',
        current_balance: 0,
        name: 'Zero Qty Account',
        account_type: 'investment',
        holdings: [
          {
            security_id: 'sec_aapl',
            account_id: 'inv_zero',
            cost_basis: 500,
            institution_price: 190.0,
            institution_value: 0,
            quantity: 0,
            iso_currency_code: 'USD',
          },
        ],
      },
    ];

    const result = await tools.getHoldings({});
    expect(result.count).toBe(1);
    expect(result.holdings[0].quantity).toBe(0);
    expect(result.holdings[0].cost_basis).toBeUndefined();
    expect(result.holdings[0].average_cost).toBeUndefined();
    expect(result.holdings[0].total_return).toBeUndefined();
  });

  test('ticker_symbol filter is case-insensitive', async () => {
    const result = await tools.getHoldings({ ticker_symbol: 'schx' });
    expect(result.count).toBe(2);
    for (const h of result.holdings) {
      expect(h.ticker_symbol).toBe('SCHX');
    }
  });
});
