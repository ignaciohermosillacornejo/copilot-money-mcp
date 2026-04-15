/**
 * End-to-end tests for the MCP server.
 *
 * Tests the full server protocol including tool functionality.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyServer } from '../../src/server.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import type {
  Transaction,
  Account,
  Recurring,
  Budget,
  Goal,
  GoalHistory,
  Item,
  Category,
  Tag,
  BalanceHistory,
  Security,
  InvestmentPerformance,
  TwrHolding,
  InvestmentPrice,
  InvestmentSplit,
  HoldingsHistory,
} from '../../src/models/index.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';

// Temp directory with a dummy .ldb so CopilotDatabase.isAvailable() returns true
const FAKE_DB_DIR = mkdtempSync(join(tmpdir(), 'copilot-test-'));
writeFileSync(join(FAKE_DB_DIR, 'dummy.ldb'), '');
afterAll(() => rmSync(FAKE_DB_DIR, { recursive: true, force: true }));

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
    item_id: 'item1',
  },
  {
    transaction_id: 'txn2',
    amount: 120.5, // Expense (positive = money out in Copilot format)
    date: '2025-01-20',
    name: 'Grocery Store',
    category_id: 'groceries',
    account_id: 'acc1',
    item_id: 'item1',
  },
  {
    transaction_id: 'txn3',
    amount: 10.0, // Expense (positive = money out in Copilot format)
    date: '2025-01-15',
    name: 'Parking',
    category_id: 'transportation',
    account_id: 'acc2',
    item_id: 'item1',
  },
  {
    transaction_id: 'txn4',
    amount: 25.0, // Expense (positive = money out in Copilot format)
    date: '2025-01-18',
    name: 'Fast Food',
    category_id: 'food_dining',
    account_id: 'acc1',
    item_id: 'item1',
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
  {
    account_id: 'acc3',
    current_balance: 50000.0,
    name: 'Brokerage Account',
    account_type: 'investment',
    holdings: [
      {
        security_id: 'sec1',
        account_id: 'acc3',
        cost_basis: 15000,
        institution_price: 185.5,
        institution_value: 18550,
        quantity: 100,
        iso_currency_code: 'USD',
      },
      {
        security_id: 'sec2',
        account_id: 'acc3',
        cost_basis: 20000,
        institution_price: 240.0,
        institution_value: 24000,
        quantity: 100,
        iso_currency_code: 'USD',
      },
    ],
  },
];

const mockRecurring: Recurring[] = [
  {
    recurring_id: 'rec1',
    name: 'Netflix',
    amount: 15.99,
    frequency: 'monthly',
    state: 'active',
    next_date: '2025-02-01',
    last_date: '2025-01-01',
    category_id: 'entertainment',
  },
  {
    recurring_id: 'rec2',
    name: 'Gym Membership',
    amount: 49.99,
    frequency: 'monthly',
    state: 'active',
    next_date: '2025-02-15',
    last_date: '2025-01-15',
    category_id: 'personal_care',
  },
];

const mockBudgets: Budget[] = [
  {
    budget_id: 'budget1',
    name: 'Food Budget',
    amount: 500,
    period: 'monthly',
    category_id: 'food_dining',
    is_active: true,
  },
  {
    budget_id: 'budget2',
    name: 'Transportation Budget',
    amount: 200,
    period: 'monthly',
    category_id: 'transportation',
    is_active: true,
  },
];

const mockGoals: Goal[] = [
  {
    goal_id: 'goal1',
    name: 'Emergency Fund',
    emoji: '🏦',
    savings: {
      target_amount: 10000,
      tracking_type: 'monthly_contribution',
      tracking_type_monthly_contribution: 500,
      status: 'active',
      start_date: '2024-01-01',
    },
    created_date: '2024-01-01',
  },
  {
    goal_id: 'goal2',
    name: 'Vacation',
    emoji: '✈️',
    savings: {
      target_amount: 5000,
      tracking_type: 'monthly_contribution',
      tracking_type_monthly_contribution: 200,
      status: 'active',
      start_date: '2024-06-01',
    },
    created_date: '2024-06-01',
  },
];

const mockGoalHistory: GoalHistory[] = [
  {
    goal_id: 'goal1',
    month: '2025-01',
    current_amount: 6000,
  },
  {
    goal_id: 'goal2',
    month: '2025-01',
    current_amount: 1200,
  },
];

const mockItems: Item[] = [
  {
    item_id: 'item1',
    institution_name: 'Chase Bank',
    institution_id: 'ins_3',
    connection_status: 'active',
    billed_products: ['transactions'],
    status_transactions_last_successful_update: '2025-01-20T12:00:00Z',
  },
];

const mockUserCategories: Category[] = [
  {
    category_id: 'custom_cat_1',
    name: 'Custom Dining',
    emoji: '🍔',
    excluded: false,
  },
  {
    category_id: 'food_dining',
    name: 'Food & Dining',
  },
];

const mockTags: Tag[] = [
  { tag_id: 'tag_vacation', name: 'Vacation' },
  { tag_id: 'tag_work', name: 'Work Expense' },
];

const mockBalanceHistory: BalanceHistory[] = [
  {
    balance_id: 'item1:acc1:2025-01-15',
    date: '2025-01-15',
    item_id: 'item1',
    account_id: 'acc1',
    current_balance: 1500.0,
    available_balance: 1400.0,
  },
  {
    balance_id: 'item1:acc1:2025-01-16',
    date: '2025-01-16',
    item_id: 'item1',
    account_id: 'acc1',
    current_balance: 1450.0,
    available_balance: 1350.0,
  },
  {
    balance_id: 'item1:acc2:2025-01-15',
    date: '2025-01-15',
    item_id: 'item1',
    account_id: 'acc2',
    current_balance: 500.0,
    available_balance: 500.0,
  },
];

const mockSecurities: Security[] = [
  {
    security_id: 'sec1',
    ticker_symbol: 'AAPL',
    name: 'Apple Inc.',
    type: 'equity',
    close_price: 185.5,
    iso_currency_code: 'USD',
  },
  {
    security_id: 'sec2',
    ticker_symbol: 'VTI',
    name: 'Vanguard Total Stock Market ETF',
    type: 'etf',
    close_price: 240.0,
    iso_currency_code: 'USD',
  },
];

const mockInvestmentPerformance: InvestmentPerformance[] = [
  {
    performance_id: 'perf1',
    security_id: 'sec1',
    type: 'security',
  },
  {
    performance_id: 'perf2',
    security_id: 'sec2',
    type: 'security',
  },
];

const mockTwrHoldings: TwrHolding[] = [
  {
    twr_id: 'twr1',
    security_id: 'sec1',
    month: '2025-01',
    history: {
      '1736899200000': { value: 0.05 },
    },
  },
  {
    twr_id: 'twr2',
    security_id: 'sec2',
    month: '2025-01',
    history: {
      '1736899200000': { value: 0.03 },
    },
  },
];

const mockInvestmentPrices: InvestmentPrice[] = [
  {
    investment_id: 'price1',
    ticker_symbol: 'AAPL',
    close_price: 185.5,
    month: '2025-01',
    price_type: 'daily',
  },
  {
    investment_id: 'price2',
    ticker_symbol: 'VTI',
    close_price: 240.0,
    month: '2025-01',
    price_type: 'daily',
  },
];

const mockInvestmentSplits: InvestmentSplit[] = [
  {
    split_id: 'split1',
    ticker_symbol: 'AAPL',
    split_date: '2020-08-28',
    split_ratio: '4:1',
    to_factor: 4,
    from_factor: 1,
  },
];

describe('CopilotMoneyServer E2E', () => {
  let server: CopilotMoneyServer;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    const db = new CopilotDatabase('/fake/path');
    db._injectDataForTesting({
      transactions: [...mockTransactions],
      accounts: [...mockAccounts],
      recurring: [],
      budgets: [],
      goals: [],
      goalHistory: [],
      investmentPrices: [],
      investmentSplits: [],
      items: [],
      userCategories: [],
      userAccounts: [],
      categoryNameMap: new Map<string, string>(),
      accountNameMap: new Map<string, string>(),
    });

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
        const result = await func();
        const jsonStr = JSON.stringify(result);
        const deserialized = JSON.parse(jsonStr);
        expect(deserialized).toEqual(result);
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

// ============================================
// handleCallTool E2E tests
// ============================================

/** Create a CopilotDatabase pre-loaded with mock data. */
function createMockDb(): CopilotDatabase {
  const db = new CopilotDatabase(FAKE_DB_DIR);
  db._injectDataForTesting({
    transactions: [...mockTransactions],
    accounts: [...mockAccounts],
    recurring: [...mockRecurring],
    budgets: [...mockBudgets],
    goals: [...mockGoals],
    goalHistory: [...mockGoalHistory],
    investmentPrices: [...mockInvestmentPrices],
    investmentSplits: [...mockInvestmentSplits],
    items: [...mockItems],
    userCategories: [...mockUserCategories],
    userAccounts: [],
    categoryNameMap: new Map<string, string>(),
    accountNameMap: new Map<string, string>(),
    tags: [...mockTags],
    holdingsHistory: [],
    securities: [...mockSecurities],
    balanceHistory: [...mockBalanceHistory],
    investmentPerformance: [...mockInvestmentPerformance],
    twrHoldings: [...mockTwrHoldings],
  });
  return db;
}

/**
 * Permissive GraphQL client for write-tool e2e tests: responds to every
 * mutation with a generic success shape. Tests that need to assert specific
 * request shapes should build their own client via createMockGraphQLClient.
 */
function createMockWriteClient() {
  return createMockGraphQLClient({
    EditTransaction: (vars: any) => ({
      editTransaction: {
        transaction: {
          id: vars.id,
          categoryId: vars.input?.categoryId ?? 'c',
          userNotes: vars.input?.userNotes ?? null,
          isReviewed: vars.input?.isReviewed ?? false,
          tags: (vars.input?.tagIds ?? []).map((id: string) => ({ id })),
        },
      },
    }),
    CreateTag: (vars: any) => ({
      createTag: {
        id: 'tag-created',
        name: vars.input?.name ?? 'n',
        colorName: vars.input?.colorName ?? 'PURPLE2',
      },
    }),
    EditTag: (vars: any) => ({
      editTag: {
        id: vars.id,
        name: vars.input?.name ?? 'n',
        colorName: vars.input?.colorName ?? 'PURPLE2',
      },
    }),
    DeleteTag: { deleteTag: true },
    CreateCategory: (vars: any) => ({
      createCategory: {
        id: 'cat-created',
        name: vars.input?.name ?? 'n',
        colorName: vars.input?.colorName ?? 'PURPLE2',
      },
    }),
    EditCategory: (vars: any) => ({
      editCategory: {
        category: {
          id: vars.id,
          name: vars.input?.name ?? 'n',
          colorName: vars.input?.colorName ?? 'PURPLE2',
        },
      },
    }),
    DeleteCategory: { deleteCategory: true },
    EditBudget: { editCategoryBudget: true },
    EditBudgetMonthly: { editCategoryBudgetMonthly: true },
    EditRecurring: (vars: any) => ({
      editRecurring: {
        recurring: { id: vars.id, state: vars.input?.state ?? 'ACTIVE' },
      },
    }),
    DeleteRecurring: { deleteRecurring: true },
    CreateRecurring: (vars: any) => ({
      createRecurring: {
        id: 'rec-new',
        name: 'New Rec',
        state: 'ACTIVE',
        frequency: vars.input?.frequency ?? 'MONTHLY',
      },
    }),
  });
}

/** Parse the JSON text from a handleCallTool result. */
function parseToolResult(result: {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}): unknown {
  expect(result.content).toBeArray();
  expect(result.content.length).toBeGreaterThanOrEqual(1);
  expect(result.content[0].type).toBe('text');
  return JSON.parse(result.content[0].text);
}

describe('handleCallTool — read tools', () => {
  let server: CopilotMoneyServer;

  beforeEach(() => {
    const db = createMockDb();
    server = new CopilotMoneyServer(FAKE_DB_DIR);
    const tools = new CopilotMoneyTools(db);
    server._injectForTesting(db, tools);
  });

  test('get_cache_info returns date range and count', async () => {
    const result = await server.handleCallTool('get_cache_info');
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.transaction_count).toBe(mockTransactions.length);
    expect(data.oldest_transaction_date).toBe('2025-01-15');
    expect(data.newest_transaction_date).toBe('2025-01-20');
    expect(data.cache_note).toBeString();
  });

  test('refresh_database clears cache then reloads (graceful error without real LevelDB)', async () => {
    // refresh_database explicitly clears the in-memory cache and reloads from disk.
    // With mock data (no real LevelDB files), the reload produces an error which
    // handleCallTool catches gracefully.
    const result = await server.handleCallTool('refresh_database');
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Error');
  });

  test('get_categories returns list view with count', async () => {
    const result = await server.handleCallTool('get_categories', {});
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.view).toBe('list');
    expect(data.count).toBeGreaterThanOrEqual(1);
    expect(data.data).toBeDefined();
    expect(data.data.categories).toBeArray();
  });

  test('get_recurring_transactions returns recurring list', async () => {
    const result = await server.handleCallTool('get_recurring_transactions', {});
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(typeof data.count).toBe('number');
    expect(typeof data.total_monthly_cost).toBe('number');
    expect(data.recurring).toBeArray();
    expect(data.period).toBeDefined();
  });

  test('get_budgets returns budget list with totals', async () => {
    const result = await server.handleCallTool('get_budgets', {});
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(mockBudgets.length);
    expect(typeof data.total_budgeted).toBe('number');
    expect(data.budgets).toBeArray();
    expect(data.budgets.length).toBe(mockBudgets.length);
    expect(data.budgets[0].budget_id).toBeString();
  });

  test('get_goals returns goals with progress', async () => {
    const result = await server.handleCallTool('get_goals', {});
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(mockGoals.length);
    expect(typeof data.total_target).toBe('number');
    expect(typeof data.total_saved).toBe('number');
    expect(data.goals).toBeArray();
    expect(data.goals.length).toBe(mockGoals.length);
    // Verify goal history was joined (current_amount populated from mockGoalHistory)
    const emergencyFund = data.goals.find((g: any) => g.goal_id === 'goal1');
    expect(emergencyFund.current_amount).toBe(6000);
    expect(emergencyFund.target_amount).toBe(10000);
  });

  test('get_connection_status returns summary and connections', async () => {
    const result = await server.handleCallTool('get_connection_status');
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.summary).toBeDefined();
    expect(typeof data.summary.total).toBe('number');
    expect(typeof data.summary.connected).toBe('number');
    expect(typeof data.summary.needs_attention).toBe('number');
    expect(data.connections).toBeArray();
    expect(data.connections.length).toBe(mockItems.length);
    expect(data.connections[0].institution_name).toBe('Chase Bank');
    expect(data.connections[0].status).toBe('connected');
  });

  test('get_transactions through handleCallTool returns structured data', async () => {
    const result = await server.handleCallTool('get_transactions', { limit: 10 });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(typeof data.count).toBe('number');
    expect(data.transactions).toBeArray();
    expect(data.count).toBeLessThanOrEqual(10);
  });

  test('get_accounts through handleCallTool returns structured data', async () => {
    const result = await server.handleCallTool('get_accounts', {});
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(typeof data.count).toBe('number');
    expect(typeof data.total_balance).toBe('number');
    expect(data.accounts).toBeArray();
  });
});

describe('handleCallTool — write tools', () => {
  let writeServer: CopilotMoneyServer;
  let db: CopilotDatabase;

  beforeEach(() => {
    db = createMockDb();
    writeServer = new CopilotMoneyServer(FAKE_DB_DIR, undefined, true);
    const writeTools = new CopilotMoneyTools(db, createMockWriteClient());
    writeServer._injectForTesting(db, writeTools);
  });

  test('create_tag creates a new tag', async () => {
    const result = await writeServer.handleCallTool('create_tag', {
      name: 'Business Trip',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.tag_id).toBeString();
    expect(data.name).toBe('Business Trip');
  });

  test('set_budget creates/updates a category budget', async () => {
    const result = await writeServer.handleCallTool('set_budget', {
      category_id: 'custom_cat_1',
      amount: '300.00',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.category_id).toBe('custom_cat_1');
    expect(data.amount).toBe('300.00');
    expect(data.cleared).toBe(false);
  });

  test('update_transaction multi-field call produces one write', async () => {
    const result = await writeServer.handleCallTool('update_transaction', {
      transaction_id: 'txn1',
      category_id: 'custom_cat_1',
      note: 'e2e test note',
      tag_ids: [],
    });
    expect(result.isError).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.transaction_id).toBe('txn1');
    expect(data.updated.sort()).toEqual(['category_id', 'note', 'tag_ids']);
  });

  test('update_transaction rejects empty patch', async () => {
    const result = await writeServer.handleCallTool('update_transaction', {
      transaction_id: 'txn1',
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/at least one field/i);
  });

  test('update_transaction with legacy field "name" returns error', async () => {
    // `name` is no longer writable via GraphQL EditTransaction and was removed
    // from the MCP schema; the defense-in-depth allowedKeys check catches it.
    const result = await writeServer.handleCallTool('update_transaction', {
      transaction_id: 'txn1',
      name: 'rename attempt',
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/unknown field/i);
  });

  test('update_transaction with legacy field goal_id returns error', async () => {
    const result = await writeServer.handleCallTool('update_transaction', {
      transaction_id: 'txn1',
      goal_id: 'goal1',
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/unknown field/i);
  });
});

describe('handleCallTool — error handling', () => {
  test('unknown tool returns isError with message', async () => {
    const db = createMockDb();
    const server = new CopilotMoneyServer(FAKE_DB_DIR);
    server._injectForTesting(db, new CopilotMoneyTools(db));

    const result = await server.handleCallTool('nonexistent_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });

  test('write tool on read-only server returns isError with --write hint', async () => {
    const db = createMockDb();
    const server = new CopilotMoneyServer(FAKE_DB_DIR);
    server._injectForTesting(db, new CopilotMoneyTools(db));

    const result = await server.handleCallTool('update_transaction', {
      transaction_id: 'txn1',
      category_id: 'food_dining',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('--write');
  });

  test('database unavailable returns informative message', async () => {
    const badDb = new CopilotDatabase('/nonexistent/path');
    const server = new CopilotMoneyServer(FAKE_DB_DIR);
    server._injectForTesting(badDb, new CopilotMoneyTools(badDb));

    const result = await server.handleCallTool('get_cache_info');
    expect(result.content[0].text).toContain('Database not available');
    // Server intentionally omits isError for unavailable DB (server.ts:134-145)
    // so the LLM receives the message as guidance rather than a hard error.
    expect(result.isError).toBeUndefined();
  });

  test('malformed args to write tool returns isError', async () => {
    const db = createMockDb();
    const writeServer = new CopilotMoneyServer(FAKE_DB_DIR, undefined, true);
    writeServer._injectForTesting(db, new CopilotMoneyTools(db, createMockWriteClient()));

    const result = await writeServer.handleCallTool('update_transaction', {
      category_id: 'food_dining',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error');
  });
});

// ============================================
// E2E tests for read tools — new coverage
// ============================================

describe('handleCallTool — read tools (extended)', () => {
  let server: CopilotMoneyServer;

  beforeEach(() => {
    const db = createMockDb();
    server = new CopilotMoneyServer(FAKE_DB_DIR);
    const tools = new CopilotMoneyTools(db);
    server._injectForTesting(db, tools);
  });

  test('get_balance_history returns daily balance snapshots', async () => {
    const result = await server.handleCallTool('get_balance_history', {
      granularity: 'daily',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(typeof data.count).toBe('number');
    expect(typeof data.total_count).toBe('number');
    expect(data.balance_history).toBeArray();
    expect(data.count).toBe(mockBalanceHistory.length);
    expect(data.accounts).toBeArray();
    expect(data.accounts.length).toBeGreaterThanOrEqual(1);
  });

  test('get_balance_history filters by account_id', async () => {
    const result = await server.handleCallTool('get_balance_history', {
      account_id: 'acc1',
      granularity: 'daily',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(2); // acc1 has 2 entries
    for (const entry of data.balance_history) {
      expect(entry.account_id).toBe('acc1');
    }
  });

  test('get_balance_history supports monthly granularity', async () => {
    const result = await server.handleCallTool('get_balance_history', {
      granularity: 'monthly',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    // Monthly downsamples: keeps last date per account per month
    expect(data.balance_history).toBeArray();
    expect(data.count).toBeLessThanOrEqual(mockBalanceHistory.length);
  });

  test('get_balance_history filters by date range', async () => {
    const result = await server.handleCallTool('get_balance_history', {
      start_date: '2025-01-16',
      end_date: '2025-01-16',
      granularity: 'daily',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    for (const entry of data.balance_history) {
      expect(entry.date).toBe('2025-01-16');
    }
  });

  test('get_balance_history returns pagination fields', async () => {
    const result = await server.handleCallTool('get_balance_history', {
      granularity: 'daily',
      limit: 1,
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(1);
    expect(data.total_count).toBe(mockBalanceHistory.length);
    expect(data.has_more).toBe(true);
    expect(data.offset).toBe(0);
  });

  test('get_securities returns security master data', async () => {
    const result = await server.handleCallTool('get_securities', {});
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(mockSecurities.length);
    expect(data.securities).toBeArray();
    expect(data.securities[0].security_id).toBeString();
    expect(data.securities[0].ticker_symbol).toBeString();
  });

  test('get_securities filters by ticker_symbol', async () => {
    const result = await server.handleCallTool('get_securities', {
      ticker_symbol: 'AAPL',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(1);
    expect(data.securities[0].ticker_symbol).toBe('AAPL');
    expect(data.securities[0].name).toBe('Apple Inc.');
  });

  test('get_securities filters by type', async () => {
    const result = await server.handleCallTool('get_securities', {
      type: 'etf',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(1);
    expect(data.securities[0].ticker_symbol).toBe('VTI');
  });

  test('get_securities returns pagination fields', async () => {
    const result = await server.handleCallTool('get_securities', {
      limit: 1,
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(1);
    expect(data.total_count).toBe(mockSecurities.length);
    expect(data.has_more).toBe(true);
  });

  test('get_investment_performance returns enriched performance data', async () => {
    const result = await server.handleCallTool('get_investment_performance', {});
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(mockInvestmentPerformance.length);
    expect(data.performance).toBeArray();
    // Should be enriched with security data
    const applePerf = data.performance.find((p: any) => p.security_id === 'sec1');
    expect(applePerf).toBeDefined();
    expect(applePerf.ticker_symbol).toBe('AAPL');
    expect(applePerf.name).toBe('Apple Inc.');
  });

  test('get_investment_performance filters by ticker_symbol', async () => {
    const result = await server.handleCallTool('get_investment_performance', {
      ticker_symbol: 'VTI',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(1);
    expect(data.performance[0].ticker_symbol).toBe('VTI');
  });

  test('get_investment_performance filters by security_id', async () => {
    const result = await server.handleCallTool('get_investment_performance', {
      security_id: 'sec1',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(1);
    expect(data.performance[0].security_id).toBe('sec1');
  });

  test('get_twr_returns returns enriched TWR data', async () => {
    const result = await server.handleCallTool('get_twr_returns', {});
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(mockTwrHoldings.length);
    expect(data.twr_returns).toBeArray();
    // Should be enriched with security data
    const appleTwr = data.twr_returns.find((t: any) => t.security_id === 'sec1');
    expect(appleTwr).toBeDefined();
    expect(appleTwr.ticker_symbol).toBe('AAPL');
    expect(appleTwr.month).toBe('2025-01');
  });

  test('get_twr_returns filters by ticker_symbol', async () => {
    const result = await server.handleCallTool('get_twr_returns', {
      ticker_symbol: 'AAPL',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(1);
    expect(data.twr_returns[0].security_id).toBe('sec1');
  });

  test('get_twr_returns filters by month range', async () => {
    const result = await server.handleCallTool('get_twr_returns', {
      start_month: '2025-01',
      end_month: '2025-01',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    for (const entry of data.twr_returns) {
      expect(entry.month).toBe('2025-01');
    }
  });

  test('get_goal_history returns enriched goal history', async () => {
    const result = await server.handleCallTool('get_goal_history', {});
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(mockGoalHistory.length);
    expect(data.goal_history).toBeArray();
    // Should be enriched with goal names
    const emergencyHistory = data.goal_history.find((h: any) => h.goal_id === 'goal1');
    expect(emergencyHistory).toBeDefined();
    expect(emergencyHistory.goal_name).toBe('Emergency Fund');
    expect(emergencyHistory.current_amount).toBe(6000);
  });

  test('get_goal_history filters by goal_id', async () => {
    const result = await server.handleCallTool('get_goal_history', {
      goal_id: 'goal2',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(1);
    expect(data.goal_history[0].goal_id).toBe('goal2');
    expect(data.goal_history[0].goal_name).toBe('Vacation');
    expect(data.goal_history[0].current_amount).toBe(1200);
  });

  test('get_goal_history returns pagination fields', async () => {
    const result = await server.handleCallTool('get_goal_history', {
      limit: 1,
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(1);
    expect(data.total_count).toBe(mockGoalHistory.length);
    expect(data.has_more).toBe(true);
    expect(data.offset).toBe(0);
  });

  test('get_holdings returns enriched holdings with cost basis', async () => {
    const result = await server.handleCallTool('get_holdings', {});
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(2); // 2 holdings in acc3
    expect(data.holdings).toBeArray();
    const appleHolding = data.holdings.find((h: any) => h.security_id === 'sec1');
    expect(appleHolding).toBeDefined();
    expect(appleHolding.ticker_symbol).toBe('AAPL');
    expect(appleHolding.quantity).toBe(100);
    expect(appleHolding.institution_price).toBe(185.5);
    expect(appleHolding.cost_basis).toBe(15000);
    expect(appleHolding.total_return).toBeDefined();
    expect(appleHolding.account_id).toBe('acc3');
  });

  test('get_holdings filters by ticker_symbol', async () => {
    const result = await server.handleCallTool('get_holdings', {
      ticker_symbol: 'VTI',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(1);
    expect(data.holdings[0].ticker_symbol).toBe('VTI');
  });

  test('get_investment_prices returns price data with tickers', async () => {
    const result = await server.handleCallTool('get_investment_prices', {});
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(mockInvestmentPrices.length);
    expect(data.prices).toBeArray();
    expect(data.tickers).toBeArray();
    expect(data.tickers).toContain('AAPL');
    expect(data.tickers).toContain('VTI');
    expect(data.prices[0].close_price).toBeDefined();
  });

  test('get_investment_prices filters by ticker_symbol', async () => {
    const result = await server.handleCallTool('get_investment_prices', {
      ticker_symbol: 'AAPL',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(1);
    expect(data.prices[0].ticker_symbol).toBe('AAPL');
    expect(data.prices[0].close_price).toBe(185.5);
  });

  test('get_investment_splits returns split data', async () => {
    const result = await server.handleCallTool('get_investment_splits', {});
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(mockInvestmentSplits.length);
    expect(data.splits).toBeArray();
    expect(data.splits[0].ticker_symbol).toBe('AAPL');
    expect(data.splits[0].split_ratio).toBe('4:1');
    expect(data.splits[0].split_date).toBe('2020-08-28');
  });

  test('get_investment_splits filters by ticker_symbol', async () => {
    const result = await server.handleCallTool('get_investment_splits', {
      ticker_symbol: 'AAPL',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(1);
    expect(data.splits[0].ticker_symbol).toBe('AAPL');
  });

  test('get_balance_history with offset skips entries', async () => {
    const result = await server.handleCallTool('get_balance_history', {
      granularity: 'daily',
      limit: 1,
      offset: 1,
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.count).toBe(1);
    expect(data.offset).toBe(1);
    // The returned entry should be different from the first page
    const firstPage = await server.handleCallTool('get_balance_history', {
      granularity: 'daily',
      limit: 1,
    });
    const firstData = parseToolResult(firstPage) as any;
    const secondEntry = data.balance_history[0];
    const firstEntry = firstData.balance_history[0];
    // Entries should differ by date or account_id
    const secondKey = `${secondEntry.account_id}:${secondEntry.date}`;
    const firstKey = `${firstEntry.account_id}:${firstEntry.date}`;
    expect(secondKey).not.toBe(firstKey);
  });
});

// ============================================
// E2E tests for write tools — extended coverage
// ============================================

describe('handleCallTool — write tools (extended)', () => {
  let writeServer: CopilotMoneyServer;
  let db: CopilotDatabase;

  beforeEach(() => {
    db = createMockDb();
    writeServer = new CopilotMoneyServer(FAKE_DB_DIR, undefined, true);
    const writeTools = new CopilotMoneyTools(db, createMockWriteClient());
    writeServer._injectForTesting(db, writeTools);
  });

  // -- Transaction write tools --

  test('review_transactions marks transactions as reviewed', async () => {
    const result = await writeServer.handleCallTool('review_transactions', {
      transaction_ids: ['txn1', 'txn2'],
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.reviewed_count).toBe(2);
    expect(data.transaction_ids).toEqual(['txn1', 'txn2']);
  });

  test('review_transactions can unmark reviewed', async () => {
    const result = await writeServer.handleCallTool('review_transactions', {
      transaction_ids: ['txn1'],
      reviewed: false,
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.reviewed_count).toBe(1);
  });

  // -- Tag write tools --

  test('delete_tag deletes an existing tag', async () => {
    const result = await writeServer.handleCallTool('delete_tag', {
      tag_id: 'tag_vacation',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.tag_id).toBe('tag_vacation');
    expect(data.deleted).toBe(true);
  });

  test('update_tag renames an existing tag', async () => {
    const result = await writeServer.handleCallTool('update_tag', {
      tag_id: 'tag_vacation',
      name: 'Holiday',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.tag_id).toBe('tag_vacation');
    expect(data.updated).toContain('name');
  });

  // -- Category write tools --

  test('create_category creates a new category', async () => {
    const result = await writeServer.handleCallTool('create_category', {
      name: 'Side Projects',
      color_name: 'ORANGE',
      emoji: '🛠️',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.name).toBe('Side Projects');
    expect(data.category_id).toBeString();
  });

  test('update_category updates an existing category', async () => {
    const result = await writeServer.handleCallTool('update_category', {
      category_id: 'custom_cat_1',
      name: 'Updated Dining',
      emoji: '🍕',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.category_id).toBe('custom_cat_1');
    expect(data.updated).toContain('name');
    expect(data.updated).toContain('emoji');
  });

  test('delete_category deletes an existing category', async () => {
    const result = await writeServer.handleCallTool('delete_category', {
      category_id: 'custom_cat_1',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.category_id).toBe('custom_cat_1');
    expect(data.deleted).toBe(true);
  });

  // -- Budget write tool (set_budget) --

  test('set_budget sets an all-months default budget', async () => {
    const result = await writeServer.handleCallTool('set_budget', {
      category_id: 'custom_cat_1',
      amount: '300.00',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.category_id).toBe('custom_cat_1');
    expect(data.amount).toBe('300.00');
    expect(data.cleared).toBe(false);
  });

  test('set_budget with month sets a per-month override', async () => {
    const result = await writeServer.handleCallTool('set_budget', {
      category_id: 'custom_cat_1',
      amount: '100.00',
      month: '2025-03',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.month).toBe('2025-03');
  });

  // -- Recurring write tools --

  test('set_recurring_state pauses a recurring item', async () => {
    const result = await writeServer.handleCallTool('set_recurring_state', {
      recurring_id: 'rec1',
      state: 'PAUSED',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.recurring_id).toBe('rec1');
    expect(data.state).toBe('PAUSED');
  });

  test('delete_recurring deletes a recurring item', async () => {
    const result = await writeServer.handleCallTool('delete_recurring', {
      recurring_id: 'rec1',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.recurring_id).toBe('rec1');
    expect(data.deleted).toBe(true);
  });

  test('create_recurring creates a new recurring item from a transaction', async () => {
    const result = await writeServer.handleCallTool('create_recurring', {
      transaction_id: 'txn1',
      frequency: 'MONTHLY',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.frequency).toBe('MONTHLY');
    expect(data.recurring_id).toBeString();
  });

  test('update_recurring changes state', async () => {
    const result = await writeServer.handleCallTool('update_recurring', {
      recurring_id: 'rec1',
      state: 'PAUSED',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.recurring_id).toBe('rec1');
    expect(data.updated).toContain('state');
  });
});

// ============================================
// E2E tests for write tool validation errors
// ============================================

describe('handleCallTool — write tool validation', () => {
  let writeServer: CopilotMoneyServer;

  beforeEach(() => {
    const db = createMockDb();
    writeServer = new CopilotMoneyServer(FAKE_DB_DIR, undefined, true);
    const writeTools = new CopilotMoneyTools(db, createMockWriteClient());
    writeServer._injectForTesting(db, writeTools);
  });

  test('create_tag with empty name returns error', async () => {
    const result = await writeServer.handleCallTool('create_tag', {
      name: '   ',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('empty');
  });

  test('delete_tag surfaces GraphQL errors', async () => {
    // With the GraphQL migration, tag existence is not pre-validated locally;
    // the backend determines whether the id is valid. We verify here that a
    // server-side error surfaces as an MCP tool error with descriptive text.
    const failingTools = new CopilotMoneyTools(
      createMockDb(),
      createMockGraphQLClient({
        DeleteTag: new Error('tag not found'),
      })
    );
    const failingServer = new CopilotMoneyServer(FAKE_DB_DIR, undefined, true);
    failingServer._injectForTesting(createMockDb(), failingTools);

    const result = await failingServer.handleCallTool('delete_tag', {
      tag_id: 'whatever',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/tag not found/i);
  });

  test('update_category with no fields returns error', async () => {
    const result = await writeServer.handleCallTool('update_category', {
      category_id: 'custom_cat_1',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('at least one field');
  });

  test('create_recurring with invalid frequency returns error', async () => {
    const result = await writeServer.handleCallTool('create_recurring', {
      transaction_id: 'wtxn1',
      frequency: 'hourly',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('frequency must be one of');
  });

  test('set_recurring_state with invalid state returns error', async () => {
    const result = await writeServer.handleCallTool('set_recurring_state', {
      recurring_id: 'rec1',
      state: 'invalid_state',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('state must be one of');
  });

  test('review_transactions with empty array returns error', async () => {
    const result = await writeServer.handleCallTool('review_transactions', {
      transaction_ids: [],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty');
  });
});

// ============================================
// Edge case tests — pagination, cost basis, downsampling
// ============================================

describe('transaction pagination edge cases', () => {
  let tools: CopilotMoneyTools;

  // Explicit pagination test data — 6 transactions with no transfer/excluded categories
  const paginationTransactions: Transaction[] = [
    {
      transaction_id: 'p1',
      amount: 10,
      date: '2025-01-10',
      name: 'Item 1',
      category_id: 'food_dining',
      account_id: 'acc1',
      item_id: 'item1',
    },
    {
      transaction_id: 'p2',
      amount: 20,
      date: '2025-01-11',
      name: 'Item 2',
      category_id: 'food_dining',
      account_id: 'acc1',
      item_id: 'item1',
    },
    {
      transaction_id: 'p3',
      amount: 30,
      date: '2025-01-12',
      name: 'Item 3',
      category_id: 'groceries',
      account_id: 'acc1',
      item_id: 'item1',
    },
    {
      transaction_id: 'p4',
      amount: 40,
      date: '2025-01-13',
      name: 'Item 4',
      category_id: 'groceries',
      account_id: 'acc2',
      item_id: 'item1',
    },
    {
      transaction_id: 'p5',
      amount: 50,
      date: '2025-01-14',
      name: 'Item 5',
      category_id: 'entertainment',
      account_id: 'acc2',
      item_id: 'item1',
    },
    {
      transaction_id: 'p6',
      amount: 60,
      date: '2025-01-15',
      name: 'Item 6',
      category_id: 'entertainment',
      account_id: 'acc2',
      item_id: 'item1',
    },
  ];

  beforeEach(() => {
    const db = new CopilotDatabase(FAKE_DB_DIR);
    db._injectDataForTesting({
      transactions: [...paginationTransactions],
      accounts: [...mockAccounts],
      recurring: [],
      budgets: [],
      goals: [],
      goalHistory: [],
      investmentPrices: [],
      investmentSplits: [],
      items: [],
      userCategories: [],
      userAccounts: [],
      categoryNameMap: new Map<string, string>(),
      accountNameMap: new Map<string, string>(),
    });
    tools = new CopilotMoneyTools(db);
  });

  test('offset greater than total count returns empty', async () => {
    // First get the actual total so we don't hardcode
    const all = await tools.getTransactions({ limit: 10000 });
    const total = all.total_count;
    expect(total).toBe(paginationTransactions.length);

    const result = await tools.getTransactions({ offset: total + 100, limit: 10 });
    expect(result.count).toBe(0);
    expect(result.transactions).toEqual([]);
    expect(result.total_count).toBe(total);
    expect(result.has_more).toBe(false);
  });

  test('limit=1 returns exactly one result with has_more', async () => {
    const result = await tools.getTransactions({ limit: 1 });
    expect(result.count).toBe(1);
    expect(result.transactions.length).toBe(1);
    expect(result.total_count).toBeGreaterThan(1);
    expect(result.has_more).toBe(true);
  });

  test('very large offset with small limit returns empty', async () => {
    const result = await tools.getTransactions({ offset: 100000, limit: 5 });
    expect(result.count).toBe(0);
    expect(result.transactions).toEqual([]);
    expect(result.has_more).toBe(false);
  });

  test('offset + limit exceeding total still returns correct total_count', async () => {
    const all = await tools.getTransactions({ limit: 10000 });
    const total = all.total_count;

    const result = await tools.getTransactions({ offset: 9990, limit: 10 });
    expect(result.count).toBe(0);
    expect(result.transactions).toEqual([]);
    expect(result.total_count).toBe(total);
    expect(result.has_more).toBe(false);
  });

  test('offset exactly at total count returns empty', async () => {
    const all = await tools.getTransactions({ limit: 10000 });
    const total = all.total_count;

    const result = await tools.getTransactions({ offset: total, limit: 10 });
    expect(result.count).toBe(0);
    expect(result.transactions).toEqual([]);
    expect(result.has_more).toBe(false);
  });

  test('offset one less than total count returns exactly one item', async () => {
    const all = await tools.getTransactions({ limit: 10000 });
    const total = all.total_count;

    const result = await tools.getTransactions({ offset: total - 1, limit: 10 });
    expect(result.count).toBe(1);
    expect(result.transactions.length).toBe(1);
    expect(result.has_more).toBe(false);
  });

  test('combined filters with pagination — category + date_range + limit + offset', async () => {
    // First, figure out how many food_dining transactions exist in the date range
    const allFiltered = await tools.getTransactions({
      category: 'food_dining',
      start_date: '2025-01-01',
      end_date: '2025-01-31',
      limit: 10000,
    });
    expect(allFiltered.total_count).toBeGreaterThanOrEqual(2);

    // Page through with limit=1
    const page1 = await tools.getTransactions({
      category: 'food_dining',
      start_date: '2025-01-01',
      end_date: '2025-01-31',
      limit: 1,
      offset: 0,
    });
    expect(page1.count).toBe(1);
    expect(page1.has_more).toBe(true);
    expect(page1.total_count).toBe(allFiltered.total_count);

    const page2 = await tools.getTransactions({
      category: 'food_dining',
      start_date: '2025-01-01',
      end_date: '2025-01-31',
      limit: 1,
      offset: 1,
    });
    expect(page2.count).toBe(1);
    expect(page2.total_count).toBe(allFiltered.total_count);

    // Pages return different transactions
    expect(page1.transactions[0].transaction_id).not.toBe(page2.transactions[0].transaction_id);
  });

  test('limit exceeding MAX_QUERY_LIMIT is clamped', async () => {
    // With only 6 test records we can't exercise the upper-bound clamp path
    // (would need >10000 records). Instead we verify the query still returns
    // all available data, confirming the clamped limit is >= the dataset size.
    const all = await tools.getTransactions({ limit: 10000 });
    const result = await tools.getTransactions({ limit: 99999 });
    expect(result.count).toBe(all.total_count);
    expect(result.count).toBe(result.total_count);
  });

  test('negative offset is clamped to 0', async () => {
    const result = await tools.getTransactions({ offset: -5, limit: 10 });
    expect(result.offset).toBe(0);
    expect(result.count).toBeGreaterThan(0);
  });
});

describe('holdings cost basis edge cases', () => {
  /**
   * Helper to create tools with custom accounts/securities/history for holdings tests.
   */
  function createHoldingsTools(opts: {
    accounts?: Account[];
    securities?: Security[];
    holdingsHistory?: HoldingsHistory[];
  }): CopilotMoneyTools {
    const db = new CopilotDatabase(FAKE_DB_DIR);
    db._injectDataForTesting({
      accounts: opts.accounts ?? [...mockAccounts],
      securities: opts.securities ?? [...mockSecurities],
      holdingsHistory: opts.holdingsHistory ?? [],
      transactions: [],
      recurring: [],
      budgets: [],
      goals: [],
      goalHistory: [],
      investmentPrices: [],
      investmentSplits: [],
      items: [],
      userCategories: [],
      userAccounts: [],
      categoryNameMap: new Map(),
      accountNameMap: new Map(),
    });
    return new CopilotMoneyTools(db);
  }

  test('cost_basis = null does NOT compute average_cost or total_return', async () => {
    const tools = createHoldingsTools({
      accounts: [
        {
          account_id: 'inv1',
          current_balance: 10000,
          name: 'Test Investment',
          account_type: 'investment',
          holdings: [
            {
              security_id: 'sec1',
              account_id: 'inv1',
              // Plaid can return null at runtime even though TS types it as number
              cost_basis: null as unknown as number,
              institution_price: 150,
              institution_value: 15000,
              quantity: 100,
              iso_currency_code: 'USD',
            },
          ],
        },
      ],
    });
    const result = await tools.getHoldings({});
    expect(result.count).toBe(1);
    const holding = result.holdings[0];
    expect(holding.cost_basis).toBeUndefined();
    expect(holding.average_cost).toBeUndefined();
    expect(holding.total_return).toBeUndefined();
    expect(holding.total_return_percent).toBeUndefined();
  });

  test('cost_basis = 0 does NOT compute derived fields', async () => {
    const tools = createHoldingsTools({
      accounts: [
        {
          account_id: 'inv1',
          current_balance: 10000,
          name: 'Test Investment',
          account_type: 'investment',
          holdings: [
            {
              security_id: 'sec1',
              account_id: 'inv1',
              cost_basis: 0,
              institution_price: 150,
              institution_value: 15000,
              quantity: 100,
              iso_currency_code: 'USD',
            },
          ],
        },
      ],
    });
    const result = await tools.getHoldings({});
    expect(result.count).toBe(1);
    const holding = result.holdings[0];
    expect(holding.cost_basis).toBeUndefined();
    expect(holding.average_cost).toBeUndefined();
    expect(holding.total_return).toBeUndefined();
  });

  test('quantity = 0 does NOT compute average_cost (division by zero guard)', async () => {
    const tools = createHoldingsTools({
      accounts: [
        {
          account_id: 'inv1',
          current_balance: 0,
          name: 'Test Investment',
          account_type: 'investment',
          holdings: [
            {
              security_id: 'sec1',
              account_id: 'inv1',
              cost_basis: 5000,
              institution_price: 0,
              institution_value: 0,
              quantity: 0,
              iso_currency_code: 'USD',
            },
          ],
        },
      ],
    });
    const result = await tools.getHoldings({});
    expect(result.count).toBe(1);
    const holding = result.holdings[0];
    // quantity=0 means the cost_basis guard (h.quantity !== 0) should prevent computation
    expect(holding.average_cost).toBeUndefined();
    expect(holding.cost_basis).toBeUndefined();
  });

  test('include_history=true with no history records', async () => {
    const tools = createHoldingsTools({ holdingsHistory: [] });
    const result = await tools.getHoldings({ include_history: true });
    expect(result.count).toBeGreaterThan(0);
    for (const holding of result.holdings) {
      expect(holding.history).toBeUndefined();
    }
  });

  test('include_history=true with matching history records', async () => {
    const tools = createHoldingsTools({
      holdingsHistory: [
        {
          history_id: 'sec1:2025-01',
          security_id: 'sec1',
          account_id: 'acc3',
          month: '2025-01',
          history: {
            '1736899200000': { price: 180.0, quantity: 100 },
            '1736985600000': { price: 182.5, quantity: 100 },
          },
        },
        {
          history_id: 'sec1:2024-12',
          security_id: 'sec1',
          account_id: 'acc3',
          month: '2024-12',
          history: {
            '1735689600000': { price: 175.0, quantity: 95 },
          },
        },
      ],
    });
    const result = await tools.getHoldings({
      include_history: true,
      ticker_symbol: 'AAPL',
    });
    expect(result.count).toBe(1);
    const holding = result.holdings[0];
    expect(holding.history).toBeDefined();
    expect(holding.history!.length).toBe(2);
    // Sorted by month descending
    expect(holding.history![0].month).toBe('2025-01');
    expect(holding.history![1].month).toBe('2024-12');
  });

  test('filter by account_id + ticker_symbol together', async () => {
    const tools = createHoldingsTools({});
    // acc3 has both AAPL and VTI holdings
    const result = await tools.getHoldings({
      account_id: 'acc3',
      ticker_symbol: 'AAPL',
    });
    expect(result.count).toBe(1);
    expect(result.holdings[0].ticker_symbol).toBe('AAPL');
    expect(result.holdings[0].account_id).toBe('acc3');
  });

  test('non-existent account_id returns empty', async () => {
    const tools = createHoldingsTools({});
    const result = await tools.getHoldings({ account_id: 'nonexistent' });
    expect(result.count).toBe(0);
    expect(result.holdings).toEqual([]);
    expect(result.total_count).toBe(0);
  });

  test('non-existent ticker_symbol returns empty', async () => {
    const tools = createHoldingsTools({});
    const result = await tools.getHoldings({ ticker_symbol: 'ZZZZ' });
    expect(result.count).toBe(0);
    expect(result.holdings).toEqual([]);
  });

  test('accounts with no holdings array are skipped', async () => {
    const tools = createHoldingsTools({
      accounts: [
        {
          account_id: 'checking1',
          current_balance: 5000,
          name: 'Checking',
          account_type: 'checking',
          // no holdings property
        },
        {
          account_id: 'inv1',
          current_balance: 10000,
          name: 'Investment',
          account_type: 'investment',
          holdings: [
            {
              security_id: 'sec1',
              account_id: 'inv1',
              cost_basis: 15000,
              institution_price: 185.5,
              institution_value: 18550,
              quantity: 100,
              iso_currency_code: 'USD',
            },
          ],
        },
      ],
    });
    const result = await tools.getHoldings({});
    // Only the investment account's holding should appear
    expect(result.count).toBe(1);
    expect(result.holdings[0].account_id).toBe('inv1');
  });
});

describe('balance history downsampling edge cases', () => {
  /**
   * Helper to create a db + tools with custom balance history data.
   */
  function createBalanceTools(balanceHistory: BalanceHistory[]): CopilotMoneyTools {
    const db = new CopilotDatabase(FAKE_DB_DIR);
    db._injectDataForTesting({
      balanceHistory,
      accounts: [...mockAccounts],
      transactions: [],
      recurring: [],
      budgets: [],
      goals: [],
      goalHistory: [],
      investmentPrices: [],
      investmentSplits: [],
      items: [],
      userCategories: [],
      userAccounts: [],
      securities: [],
      categoryNameMap: new Map(),
      accountNameMap: new Map([
        ['acc1', 'Checking Account'],
        ['acc2', 'Savings Account'],
      ]),
    });
    return new CopilotMoneyTools(db);
  }

  test('weekly downsampling keeps last date per week per account', async () => {
    // Week of 2025-01-13 (Mon) to 2025-01-19 (Sun)
    const history: BalanceHistory[] = [
      {
        balance_id: 'b1',
        date: '2025-01-13',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1000,
      },
      {
        balance_id: 'b2',
        date: '2025-01-15',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1100,
      },
      {
        balance_id: 'b3',
        date: '2025-01-17',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1200,
      },
      // Next week: 2025-01-20 (Mon)
      {
        balance_id: 'b4',
        date: '2025-01-20',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1300,
      },
      {
        balance_id: 'b5',
        date: '2025-01-22',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1400,
      },
    ];
    const tools = createBalanceTools(history);
    const result = await tools.getBalanceHistory({ granularity: 'weekly' });
    // Should keep last date per week: 2025-01-17 (week 3) and 2025-01-22 (week 4)
    expect(result.total_count).toBe(2);
    const dates = result.balance_history.map((r) => r.date);
    expect(dates).toContain('2025-01-17');
    expect(dates).toContain('2025-01-22');
    expect(dates).not.toContain('2025-01-13');
    expect(dates).not.toContain('2025-01-15');
    expect(dates).not.toContain('2025-01-20');
  });

  test('monthly downsampling keeps last date per month per account', async () => {
    const history: BalanceHistory[] = [
      {
        balance_id: 'b1',
        date: '2025-01-05',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1000,
      },
      {
        balance_id: 'b2',
        date: '2025-01-20',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1100,
      },
      {
        balance_id: 'b3',
        date: '2025-01-31',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1200,
      },
      {
        balance_id: 'b4',
        date: '2025-02-10',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1300,
      },
      {
        balance_id: 'b5',
        date: '2025-02-28',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1400,
      },
    ];
    const tools = createBalanceTools(history);
    const result = await tools.getBalanceHistory({ granularity: 'monthly' });
    expect(result.total_count).toBe(2);
    const dates = result.balance_history.map((r) => r.date);
    expect(dates).toContain('2025-01-31');
    expect(dates).toContain('2025-02-28');
  });

  test('downsampling with multiple accounts groups correctly', async () => {
    const history: BalanceHistory[] = [
      {
        balance_id: 'b1',
        date: '2025-01-10',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1000,
      },
      {
        balance_id: 'b2',
        date: '2025-01-20',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1100,
      },
      {
        balance_id: 'b3',
        date: '2025-01-10',
        item_id: 'item1',
        account_id: 'acc2',
        current_balance: 500,
      },
      {
        balance_id: 'b4',
        date: '2025-01-25',
        item_id: 'item1',
        account_id: 'acc2',
        current_balance: 600,
      },
    ];
    const tools = createBalanceTools(history);
    const result = await tools.getBalanceHistory({ granularity: 'monthly' });
    // Each account should keep one entry (last date in January)
    expect(result.total_count).toBe(2);
    const acc1Entry = result.balance_history.find((r) => r.account_id === 'acc1');
    const acc2Entry = result.balance_history.find((r) => r.account_id === 'acc2');
    expect(acc1Entry!.date).toBe('2025-01-20');
    expect(acc2Entry!.date).toBe('2025-01-25');
    expect(result.accounts.sort()).toEqual(['acc1', 'acc2']);
  });

  test('pagination applied AFTER downsampling', async () => {
    const history: BalanceHistory[] = [
      {
        balance_id: 'b1',
        date: '2025-01-15',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1000,
      },
      {
        balance_id: 'b2',
        date: '2025-01-31',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1100,
      },
      {
        balance_id: 'b3',
        date: '2025-02-15',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1200,
      },
      {
        balance_id: 'b4',
        date: '2025-02-28',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1300,
      },
      {
        balance_id: 'b5',
        date: '2025-03-15',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1400,
      },
      {
        balance_id: 'b6',
        date: '2025-03-31',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1500,
      },
    ];
    const tools = createBalanceTools(history);

    // Monthly downsampling → 3 entries (Jan, Feb, Mar). Paginate with limit=2.
    const page1 = await tools.getBalanceHistory({
      granularity: 'monthly',
      limit: 2,
      offset: 0,
    });
    expect(page1.total_count).toBe(3);
    expect(page1.count).toBe(2);
    expect(page1.has_more).toBe(true);

    const page2 = await tools.getBalanceHistory({
      granularity: 'monthly',
      limit: 2,
      offset: 2,
    });
    expect(page2.total_count).toBe(3);
    expect(page2.count).toBe(1);
    expect(page2.has_more).toBe(false);
  });

  test('has_more flag accuracy after downsampling', async () => {
    const history: BalanceHistory[] = [
      {
        balance_id: 'b1',
        date: '2025-01-10',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1000,
      },
      {
        balance_id: 'b2',
        date: '2025-01-20',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1100,
      },
    ];
    const tools = createBalanceTools(history);

    // Monthly downsampling → 1 entry. limit=1 exactly matches.
    const result = await tools.getBalanceHistory({
      granularity: 'monthly',
      limit: 1,
    });
    expect(result.total_count).toBe(1);
    expect(result.count).toBe(1);
    expect(result.has_more).toBe(false);
  });

  test('date filtering combined with downsampling', async () => {
    const history: BalanceHistory[] = [
      {
        balance_id: 'b1',
        date: '2025-01-15',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1000,
      },
      {
        balance_id: 'b2',
        date: '2025-02-15',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1100,
      },
      {
        balance_id: 'b3',
        date: '2025-03-15',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1200,
      },
    ];
    const tools = createBalanceTools(history);

    // Filter to Jan-Feb only, then downsample monthly
    const result = await tools.getBalanceHistory({
      granularity: 'monthly',
      start_date: '2025-01-01',
      end_date: '2025-02-28',
    });
    expect(result.total_count).toBe(2);
    const dates = result.balance_history.map((r) => r.date);
    expect(dates).toContain('2025-01-15');
    expect(dates).toContain('2025-02-15');
    expect(dates).not.toContain('2025-03-15');
  });

  test('empty result set returns zeros', async () => {
    const tools = createBalanceTools([]);
    const result = await tools.getBalanceHistory({ granularity: 'daily' });
    expect(result.count).toBe(0);
    expect(result.total_count).toBe(0);
    expect(result.has_more).toBe(false);
    expect(result.balance_history).toEqual([]);
    expect(result.accounts).toEqual([]);
  });

  test('daily granularity returns all records without downsampling', async () => {
    const history: BalanceHistory[] = [
      {
        balance_id: 'b1',
        date: '2025-01-15',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1000,
      },
      {
        balance_id: 'b2',
        date: '2025-01-16',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1100,
      },
      {
        balance_id: 'b3',
        date: '2025-01-17',
        item_id: 'item1',
        account_id: 'acc1',
        current_balance: 1200,
      },
    ];
    const tools = createBalanceTools(history);
    const result = await tools.getBalanceHistory({ granularity: 'daily' });
    expect(result.total_count).toBe(3);
    expect(result.count).toBe(3);
  });
});
