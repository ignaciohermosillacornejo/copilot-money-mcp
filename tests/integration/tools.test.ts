/**
 * Integration tests for MCP tools.
 *
 * Tests the full tool functionality with mocked database data.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyTools, createToolSchemas } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import type {
  Transaction,
  Account,
  Recurring,
  Budget,
  Goal,
  GoalHistory,
  InvestmentPrice,
  InvestmentSplit,
  Category,
  Tag,
} from '../../src/models/index.js';

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

// --- Additional mock data for expanded tests ---

const mockRecurring: Recurring[] = [
  {
    recurring_id: 'rec1',
    name: 'Netflix',
    amount: 15.99,
    frequency: 'monthly',
    last_date: '2025-01-10',
    next_date: '2025-02-10',
    account_id: 'acc1',
    category_id: 'entertainment',
    is_active: true,
    state: 'active',
  },
  {
    recurring_id: 'rec2',
    name: 'Gym Membership',
    amount: 49.99,
    frequency: 'monthly',
    last_date: '2025-01-05',
    next_date: '2025-02-05',
    account_id: 'acc1',
    category_id: 'health_fitness',
    is_active: false,
    state: 'paused',
  },
  {
    recurring_id: 'rec3',
    name: 'Annual Insurance',
    amount: 1200.0,
    frequency: 'yearly',
    last_date: '2024-06-01',
    next_date: '2025-06-01',
    account_id: 'acc2',
    category_id: 'insurance',
    is_active: true,
    state: 'active',
  },
];

const mockBudgets: Budget[] = [
  {
    budget_id: 'bud1',
    name: 'Food Budget',
    amount: 500,
    period: 'monthly',
    category_id: 'food_and_drink',
    is_active: true,
  },
  {
    budget_id: 'bud2',
    name: 'Entertainment Budget',
    amount: 200,
    period: 'monthly',
    category_id: 'entertainment',
    is_active: true,
  },
  {
    budget_id: 'bud3',
    name: 'Travel Budget',
    amount: 3000,
    period: 'yearly',
    category_id: 'travel',
    is_active: false,
  },
];

const mockGoals: Goal[] = [
  {
    goal_id: 'goal1',
    name: 'Emergency Fund',
    emoji: '\uD83D\uDCB0',
    savings: {
      type: 'savings',
      status: 'active',
      target_amount: 10000,
      tracking_type: 'monthly_contribution',
      tracking_type_monthly_contribution: 500,
      start_date: '2024-06-01',
    },
    created_date: '2024-06-01',
  },
  {
    goal_id: 'goal2',
    name: 'Vacation',
    savings: {
      type: 'savings',
      status: 'paused',
      target_amount: 5000,
      tracking_type: 'monthly_contribution',
      tracking_type_monthly_contribution: 200,
    },
  },
];

const mockGoalHistory: GoalHistory[] = [
  { month: '2025-01', goal_id: 'goal1', current_amount: 3500 },
  { month: '2024-12', goal_id: 'goal1', current_amount: 3000 },
  { month: '2025-01', goal_id: 'goal2', current_amount: 1000 },
];

const mockInvestmentPrices: InvestmentPrice[] = [
  {
    investment_id: 'inv1',
    ticker_symbol: 'AAPL',
    price: 185.5,
    date: '2025-01-15',
    price_type: 'daily',
  },
  {
    investment_id: 'inv2',
    ticker_symbol: 'GOOG',
    price: 140.25,
    date: '2025-01-15',
    price_type: 'daily',
  },
  {
    investment_id: 'inv3',
    ticker_symbol: 'AAPL',
    price: 183.0,
    date: '2025-01-14',
    price_type: 'daily',
  },
];

const mockInvestmentSplits: InvestmentSplit[] = [
  {
    split_id: 'split1',
    ticker_symbol: 'AAPL',
    split_date: '2020-08-28',
    split_ratio: '4:1',
    from_factor: 1,
    to_factor: 4,
  },
  {
    split_id: 'split2',
    ticker_symbol: 'TSLA',
    split_date: '2022-08-25',
    split_ratio: '3:1',
    from_factor: 1,
    to_factor: 3,
  },
];

const mockAccountsWithHoldings: Account[] = [
  ...mockAccounts,
  {
    account_id: 'acc_invest',
    current_balance: 50000,
    name: 'Brokerage Account',
    account_type: 'investment',
    holdings: [
      {
        security_id: 'sec_aapl',
        quantity: 100,
        institution_price: 185.5,
        institution_value: 18550,
        cost_basis: 15000,
      },
      {
        security_id: 'sec_goog',
        quantity: 50,
        institution_price: 140.25,
        institution_value: 7012.5,
        cost_basis: 6000,
      },
    ],
  },
];

const mockUserCategories: Category[] = [
  {
    category_id: 'custom_food',
    name: 'My Food',
    user_id: 'test-user-123',
  },
  {
    category_id: 'custom_fun',
    name: 'My Fun',
    user_id: 'test-user-123',
  },
];

const mockTags: Tag[] = [
  { tag_id: 'tax_deductible', name: 'Tax Deductible' },
  { tag_id: 'reimbursable', name: 'Reimbursable' },
];

// Transactions with item_id set, required by write tool resolveTransaction
const mockWriteTransactions: Transaction[] = [
  {
    transaction_id: 'wtxn1',
    amount: 42.0,
    date: '2025-01-20',
    name: 'Coffee Shop',
    category_id: 'food_and_drink',
    account_id: 'acc1',
    item_id: 'item1',
  },
  {
    transaction_id: 'wtxn2',
    amount: 99.0,
    date: '2025-01-18',
    name: 'Electronics Store',
    category_id: 'shopping',
    account_id: 'acc2',
    item_id: 'item1',
  },
];

/**
 * Helper to create a fresh database instance with all required fields initialized.
 * Optionally override default mock data.
 */
function createMockDatabase(overrides?: {
  transactions?: Transaction[];
  accounts?: Account[];
  items?: any[];
  recurring?: Recurring[];
  budgets?: Budget[];
  goals?: Goal[];
  goalHistory?: GoalHistory[];
  investmentPrices?: InvestmentPrice[];
  investmentSplits?: InvestmentSplit[];
  userCategories?: Category[];
  tags?: Tag[];
  securities?: any[];
}) {
  const db = new CopilotDatabase('/fake/path');
  (db as any)._transactions = overrides?.transactions
    ? [...overrides.transactions]
    : [...mockTransactions];
  (db as any)._accounts = overrides?.accounts ? [...overrides.accounts] : [...mockAccounts];
  (db as any)._recurring = overrides?.recurring ?? [];
  (db as any)._budgets = overrides?.budgets ?? [];
  (db as any)._goals = overrides?.goals ?? [];
  (db as any)._goalHistory = overrides?.goalHistory ?? [];
  (db as any)._investmentPrices = overrides?.investmentPrices ?? [];
  (db as any)._investmentSplits = overrides?.investmentSplits ?? [];
  (db as any)._items = overrides?.items ?? [];
  (db as any)._userCategories = overrides?.userCategories ?? [];
  (db as any)._userAccounts = [];
  (db as any)._tags = overrides?.tags ?? [];
  (db as any)._securities = overrides?.securities ?? [];
  (db as any)._holdingsHistory = [];
  (db as any)._categoryNameMap = new Map<string, string>();
  (db as any)._accountNameMap = new Map<string, string>();
  // Mark as loaded so individual getters don't trigger disk reload
  (db as any)._allCollectionsLoaded = true;
  (db as any)._cacheLoadedAt = Date.now();
  return db;
}

/** Create a mock FirestoreClient for write tool tests. */
function createMockFirestoreClient() {
  return {
    requireUserId: async () => 'test-user-123',
    createDocument: async () => {},
    updateDocument: async () => {},
    deleteDocument: async () => {},
  } as any;
}

describe('CopilotMoneyTools Integration', () => {
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    const db = createMockDatabase();
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

  describe('tool schemas', () => {
    test('returns correct number of tool schemas', async () => {
      const schemas = createToolSchemas();
      expect(schemas.length).toBe(17);
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
      // New tools
      expect(names).toContain('get_balance_history');
      expect(names).toContain('get_investment_performance');
      expect(names).toContain('get_twr_returns');
      expect(names).toContain('get_securities');
      expect(names).toContain('get_goal_history');

      // Should have exactly 17 tools
      expect(names.length).toBe(17);
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
  });

  describe('getConnectionStatus', () => {
    test('returns empty connections when no items', async () => {
      const result = await tools.getConnectionStatus();

      expect(result.connections).toEqual([]);
      expect(result.summary.total).toBe(0);
      expect(result.summary.connected).toBe(0);
      expect(result.summary.needs_attention).toBe(0);
    });

    test('returns connection with all expected fields', async () => {
      const db = createMockDatabase({
        transactions: [],
        accounts: [],
        items: [
          {
            item_id: 'item1',
            institution_name: 'Chase',
            institution_id: 'ins_56',
            billed_products: ['transactions'],
            status_transactions_last_successful_update: '2026-03-08T06:14:29.057Z',
            latest_fetch: '2026-03-08T06:14:34.117Z',
            login_required: false,
            disconnected: false,
          },
        ],
      });
      const localTools = new CopilotMoneyTools(db);

      const result = await localTools.getConnectionStatus();

      expect(result.connections.length).toBe(1);
      const conn = result.connections[0];
      expect(conn).toBeDefined();
      if (conn) {
        expect(conn.item_id).toBe('item1');
        expect(conn.institution_name).toBe('Chase');
        expect(conn.institution_id).toBe('ins_56');
        expect(conn.status).toBe('connected');
        expect(conn.products).toEqual(['transactions']);
        expect(conn.last_transactions_update).toBe('2026-03-08T06:14:29.057Z');
        expect(conn.last_transactions_failed).toBeNull();
        expect(conn.last_investments_update).toBeNull();
        expect(conn.latest_fetch).toBe('2026-03-08T06:14:34.117Z');
        expect(conn.login_required).toBe(false);
        expect(conn.disconnected).toBe(false);
        expect(conn.consent_expires).toBeNull();
        expect(conn.error_code).toBeNull();
        expect(conn.error_message).toBeNull();
      }
    });

    test('identifies login_required status', async () => {
      const db = createMockDatabase({
        transactions: [],
        accounts: [],
        items: [
          {
            item_id: 'item_locked',
            institution_name: 'Wells Fargo',
            institution_id: 'ins_127991',
            billed_products: ['transactions'],
            login_required: true,
            disconnected: false,
          },
        ],
      });
      const localTools = new CopilotMoneyTools(db);

      const result = await localTools.getConnectionStatus();

      expect(result.connections[0]?.status).toBe('login_required');
      expect(result.summary.needs_attention).toBe(1);
      expect(result.summary.connected).toBe(0);
    });

    test('identifies disconnected status', async () => {
      const db = createMockDatabase({
        transactions: [],
        accounts: [],
        items: [
          {
            item_id: 'item_disc',
            institution_name: 'Old Bank',
            institution_id: 'ins_old',
            billed_products: [],
            login_required: false,
            disconnected: true,
          },
        ],
      });
      const localTools = new CopilotMoneyTools(db);

      const result = await localTools.getConnectionStatus();

      expect(result.connections[0]?.status).toBe('disconnected');
      expect(result.summary.needs_attention).toBe(1);
    });

    test('response is JSON serializable', async () => {
      const result = await tools.getConnectionStatus();
      const json = JSON.stringify(result);
      const parsed = JSON.parse(json);
      expect(parsed.summary.total).toBe(result.summary.total);
    });
  });

  // ============================================
  // Read Tools — expanded coverage
  // ============================================

  describe('getCategories', () => {
    test('returns categories with transaction counts and totals', async () => {
      const result = await tools.getCategories();

      expect(result.view).toBe('list');
      expect(result.count).toBeGreaterThan(0);
      const data = result.data as { categories: any[] };
      expect(data.categories).toBeDefined();

      // Our mock transactions use food_dining, groceries, income, shopping
      const foodCategory = data.categories.find((c: any) => c.category_id === 'food_dining');
      expect(foodCategory).toBeDefined();
      expect(foodCategory!.transaction_count).toBe(2);
      expect(foodCategory!.total_amount).toBeGreaterThan(0);
      expect(foodCategory!.category_name).toBeDefined();
    });

    test('tree view returns hierarchical data', async () => {
      const result = await tools.getCategories({ view: 'tree' });

      expect(result.view).toBe('tree');
      expect(result.count).toBeGreaterThan(0);
      const data = result.data as { categories: any[] };
      expect(data.categories.length).toBeGreaterThan(0);
      // Each root should have an id, name, and children array
      const root = data.categories[0];
      expect(root.id).toBeDefined();
      expect(root.children).toBeDefined();
    });

    test('search view finds categories by keyword', async () => {
      const result = await tools.getCategories({ view: 'search', query: 'food' });

      expect(result.view).toBe('search');
      const data = result.data as { query: string; categories: any[] };
      expect(data.query).toBe('food');
      expect(data.categories.length).toBeGreaterThan(0);
    });
  });

  describe('getRecurringTransactions', () => {
    let recurringTools: CopilotMoneyTools;

    beforeEach(() => {
      const db = createMockDatabase({ recurring: [...mockRecurring] });
      recurringTools = new CopilotMoneyTools(db);
    });

    test('returns copilot subscriptions list with summary', async () => {
      const result = await recurringTools.getRecurringTransactions({});

      expect(result.copilot_subscriptions).toBeDefined();
      const subs = result.copilot_subscriptions!;
      expect(subs.summary.total_active).toBe(2);
      expect(subs.summary.total_paused).toBe(1);
      expect(subs.summary.monthly_cost_estimate).toBeGreaterThan(0);
    });

    test('detail view returns filtered by recurring_id', async () => {
      const result = await recurringTools.getRecurringTransactions({
        recurring_id: 'rec1',
      });

      expect(result.detail_view).toBeDefined();
      expect(result.detail_view!.length).toBe(1);
      expect(result.detail_view![0]!.recurring_id).toBe('rec1');
      expect(result.detail_view![0]!.name).toBe('Netflix');
      expect(result.detail_view![0]!.frequency).toBe('monthly');
    });

    test('detail view returns filtered by name search', async () => {
      const result = await recurringTools.getRecurringTransactions({
        name: 'gym',
      });

      expect(result.detail_view).toBeDefined();
      expect(result.detail_view!.length).toBe(1);
      expect(result.detail_view![0]!.recurring_id).toBe('rec2');
    });
  });

  describe('getBudgets', () => {
    let budgetTools: CopilotMoneyTools;

    beforeEach(() => {
      const db = createMockDatabase({
        budgets: [...mockBudgets],
        userCategories: [...mockUserCategories],
      });
      budgetTools = new CopilotMoneyTools(db);
    });

    test('returns all budgets with total amount', async () => {
      const result = await budgetTools.getBudgets();

      // Budgets with known Plaid categories or user categories are kept;
      // orphaned ones are filtered out. Our mocks use Plaid categories
      // food_and_drink, entertainment, travel which are known.
      expect(result.count).toBeGreaterThan(0);
      expect(result.total_budgeted).toBeGreaterThan(0);
      expect(result.budgets.length).toBe(result.count);

      const foodBudget = result.budgets.find((b) => b.budget_id === 'bud1');
      expect(foodBudget).toBeDefined();
      expect(foodBudget!.amount).toBe(500);
      expect(foodBudget!.period).toBe('monthly');
    });

    test('active_only filter excludes inactive budgets', async () => {
      const all = await budgetTools.getBudgets({ active_only: false });
      const active = await budgetTools.getBudgets({ active_only: true });

      expect(active.count).toBeLessThanOrEqual(all.count);
      for (const b of active.budgets) {
        expect(b.is_active).not.toBe(false);
      }
    });
  });

  describe('getGoals', () => {
    let goalTools: CopilotMoneyTools;

    beforeEach(() => {
      const db = createMockDatabase({
        goals: [...mockGoals],
        goalHistory: [...mockGoalHistory],
      });
      goalTools = new CopilotMoneyTools(db);
    });

    test('returns goals with totals and current amounts from history', async () => {
      const result = await goalTools.getGoals();

      expect(result.count).toBe(2);
      expect(result.total_target).toBe(15000);
      // goal1 = 3500 (latest month 2025-01), goal2 = 1000
      expect(result.total_saved).toBe(4500);

      const emergency = result.goals.find((g) => g.goal_id === 'goal1');
      expect(emergency).toBeDefined();
      expect(emergency!.name).toBe('Emergency Fund');
      expect(emergency!.target_amount).toBe(10000);
      expect(emergency!.current_amount).toBe(3500);
      expect(emergency!.monthly_contribution).toBe(500);
    });

    test('active_only filter excludes paused goals', async () => {
      const all = await goalTools.getGoals({ active_only: false });
      const active = await goalTools.getGoals({ active_only: true });

      expect(active.count).toBeLessThanOrEqual(all.count);
      for (const g of active.goals) {
        expect(g.status).not.toBe('paused');
      }
    });
  });

  describe('getHoldings', () => {
    let holdingsTools: CopilotMoneyTools;

    beforeEach(() => {
      const db = createMockDatabase({
        accounts: [...mockAccountsWithHoldings],
        securities: [
          { security_id: 'sec_aapl', ticker_symbol: 'AAPL', name: 'Apple Inc.', type: 'equity' },
          { security_id: 'sec_goog', ticker_symbol: 'GOOG', name: 'Alphabet Inc.', type: 'equity' },
        ],
      });
      holdingsTools = new CopilotMoneyTools(db);
    });

    test('returns all holdings with computed returns', async () => {
      const result = await holdingsTools.getHoldings();

      expect(result.total_count).toBe(2);
      expect(result.holdings.length).toBe(2);

      const aapl = result.holdings.find((h) => h.ticker_symbol === 'AAPL');
      expect(aapl).toBeDefined();
      expect(aapl!.quantity).toBe(100);
      expect(aapl!.institution_price).toBe(185.5);
      expect(aapl!.cost_basis).toBeDefined();
      expect(aapl!.total_return).toBeDefined();
      expect(aapl!.total_return_percent).toBeDefined();
    });

    test('filters by account_id', async () => {
      const result = await holdingsTools.getHoldings({ account_id: 'acc1' });

      // acc1 has no holdings, only acc_invest does
      expect(result.total_count).toBe(0);

      const investResult = await holdingsTools.getHoldings({ account_id: 'acc_invest' });
      expect(investResult.total_count).toBe(2);
    });
  });

  describe('getInvestmentPrices', () => {
    let priceTools: CopilotMoneyTools;

    beforeEach(() => {
      const db = createMockDatabase({
        investmentPrices: [...mockInvestmentPrices],
      });
      priceTools = new CopilotMoneyTools(db);
    });

    test('returns all prices with ticker list', async () => {
      const result = await priceTools.getInvestmentPrices();

      expect(result.total_count).toBe(3);
      expect(result.tickers).toContain('AAPL');
      expect(result.tickers).toContain('GOOG');
      expect(result.prices.length).toBe(3);
    });

    test('filters by ticker_symbol', async () => {
      const result = await priceTools.getInvestmentPrices({ ticker_symbol: 'AAPL' });

      expect(result.total_count).toBe(2);
      for (const p of result.prices) {
        expect(p.ticker_symbol).toBe('AAPL');
      }
    });
  });

  describe('getInvestmentSplits', () => {
    let splitTools: CopilotMoneyTools;

    beforeEach(() => {
      const db = createMockDatabase({
        investmentSplits: [...mockInvestmentSplits],
      });
      splitTools = new CopilotMoneyTools(db);
    });

    test('returns all splits', async () => {
      const result = await splitTools.getInvestmentSplits();

      expect(result.total_count).toBe(2);
      expect(result.splits.length).toBe(2);
    });

    test('filters by ticker_symbol', async () => {
      const result = await splitTools.getInvestmentSplits({ ticker_symbol: 'TSLA' });

      expect(result.total_count).toBe(1);
      expect(result.splits[0]!.split_ratio).toBe('3:1');
    });
  });

  describe('getCacheInfo', () => {
    test('returns date range and count for populated data', async () => {
      const result = await tools.getCacheInfo();

      expect(result.transaction_count).toBe(5);
      expect(result.oldest_transaction_date).toBe('2024-12-20');
      expect(result.newest_transaction_date).toBe('2025-01-15');
      expect(result.cache_note).toBeDefined();
    });

    test('returns null dates for empty database', async () => {
      const db = createMockDatabase({ transactions: [] });
      const emptyTools = new CopilotMoneyTools(db);
      const result = await emptyTools.getCacheInfo();

      expect(result.transaction_count).toBe(0);
      expect(result.oldest_transaction_date).toBeNull();
      expect(result.newest_transaction_date).toBeNull();
    });
  });

  describe('refreshDatabase', () => {
    test('returns refreshed status with cache info', async () => {
      // refreshDatabase calls clearCache() then getCacheInfo(), which reloads
      // from disk. Patch clearCache to re-populate mock data after clearing.
      const db = createMockDatabase();
      const originalClearCache = db.clearCache.bind(db);
      db.clearCache = () => {
        const result = originalClearCache();
        // Re-populate so getCacheInfo can read transactions
        (db as any)._transactions = [...mockTransactions];
        (db as any)._allCollectionsLoaded = true;
        (db as any)._cacheLoadedAt = Date.now();
        return result;
      };
      const localTools = new CopilotMoneyTools(db);

      const result = await localTools.refreshDatabase();

      expect(result.refreshed).toBe(true);
      expect(result.message).toContain('Cache refreshed');
      expect(result.cache_info.transaction_count).toBe(5);
      expect(result.cache_info.oldest_transaction_date).toBe('2024-12-20');
      expect(result.cache_info.newest_transaction_date).toBe('2025-01-15');
    });
  });

  // ============================================
  // Write Tools — happy-path tests
  // ============================================

  describe('write tools', () => {
    let writeTools: CopilotMoneyTools;

    beforeEach(() => {
      const db = createMockDatabase({
        transactions: [...mockWriteTransactions],
        userCategories: [...mockUserCategories],
        tags: [...mockTags],
        recurring: [...mockRecurring],
        budgets: [...mockBudgets],
        goals: [...mockGoals],
        goalHistory: [...mockGoalHistory],
      });
      const client = createMockFirestoreClient();
      writeTools = new CopilotMoneyTools(db, client);
    });

    test('updateTransaction multi-field call returns updated field list', async () => {
      const result = await writeTools.updateTransaction({
        transaction_id: 'wtxn1',
        category_id: 'custom_food',
        note: 'integration test',
      });
      expect(result.success).toBe(true);
      expect(result.updated.sort()).toEqual(['category_id', 'note']);
    });

    test('reviewTransactions marks reviewed', async () => {
      const result = await writeTools.reviewTransactions({
        transaction_ids: ['wtxn1', 'wtxn2'],
        reviewed: true,
      });

      expect(result.success).toBe(true);
      expect(result.reviewed_count).toBe(2);
      expect(result.transaction_ids).toContain('wtxn1');
      expect(result.transaction_ids).toContain('wtxn2');
    });

    test('createTag creates new tag', async () => {
      const result = await writeTools.createTag({
        name: 'Work Expense',
        color_name: 'blue',
      });

      expect(result.success).toBe(true);
      expect(result.tag_id).toBe('work_expense');
      expect(result.name).toBe('Work Expense');
      expect(result.color_name).toBe('blue');
    });

    test('deleteTag removes existing tag', async () => {
      const result = await writeTools.deleteTag({ tag_id: 'tax_deductible' });

      expect(result.success).toBe(true);
      expect(result.tag_id).toBe('tax_deductible');
      expect(result.deleted_name).toBe('Tax Deductible');
    });

    test('createCategory creates new user category', async () => {
      const result = await writeTools.createCategory({
        name: 'Pet Supplies',
        emoji: '\uD83D\uDC36',
      });

      expect(result.success).toBe(true);
      expect(result.category_id).toMatch(/^custom_/);
      expect(result.name).toBe('Pet Supplies');
    });

    test('updateCategory updates existing category', async () => {
      const result = await writeTools.updateCategory({
        category_id: 'custom_food',
        name: 'Gourmet Food',
      });

      expect(result.success).toBe(true);
      expect(result.category_id).toBe('custom_food');
      expect(result.updated_fields).toContain('name');
    });

    test('deleteCategory removes existing category', async () => {
      const result = await writeTools.deleteCategory({
        category_id: 'custom_fun',
      });

      expect(result.success).toBe(true);
      expect(result.deleted_name).toBe('My Fun');
    });

    test('createBudget creates new budget', async () => {
      // Use a category that exists in mockUserCategories and has no budget yet
      const result = await writeTools.createBudget({
        category_id: 'custom_food',
        amount: 300,
        period: 'monthly',
        name: 'Food Spending',
      });

      expect(result.success).toBe(true);
      expect(result.budget_id).toMatch(/^budget_/);
      expect(result.amount).toBe(300);
      expect(result.period).toBe('monthly');
    });

    test('updateBudget updates existing budget', async () => {
      const result = await writeTools.updateBudget({
        budget_id: 'bud1',
        amount: 600,
        name: 'Updated Food Budget',
      });

      expect(result.success).toBe(true);
      expect(result.updated_fields).toContain('amount');
      expect(result.updated_fields).toContain('name');
    });

    test('deleteBudget removes existing budget', async () => {
      const result = await writeTools.deleteBudget({ budget_id: 'bud2' });

      expect(result.success).toBe(true);
      expect(result.budget_id).toBe('bud2');
      expect(result.deleted_name).toBe('Entertainment Budget');
    });

    test('setRecurringState changes state', async () => {
      const result = await writeTools.setRecurringState({
        recurring_id: 'rec1',
        state: 'paused',
      });

      expect(result.success).toBe(true);
      expect(result.old_state).toBe('active');
      expect(result.new_state).toBe('paused');
      expect(result.name).toBe('Netflix');
    });

    test('deleteRecurring removes recurring item', async () => {
      const result = await writeTools.deleteRecurring({ recurring_id: 'rec2' });

      expect(result.success).toBe(true);
      expect(result.deleted_name).toBe('Gym Membership');
    });

    test('updateGoal updates goal fields', async () => {
      const result = await writeTools.updateGoal({
        goal_id: 'goal1',
        name: 'Bigger Emergency Fund',
        target_amount: 20000,
      });

      expect(result.success).toBe(true);
      expect(result.updated_fields).toContain('name');
      expect(result.updated_fields).toContain('savings');
    });

    test('deleteGoal removes existing goal', async () => {
      const result = await writeTools.deleteGoal({ goal_id: 'goal2' });

      expect(result.success).toBe(true);
      expect(result.deleted_name).toBe('Vacation');
    });
  });
});
