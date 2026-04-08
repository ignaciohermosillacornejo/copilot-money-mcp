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
} from '../../src/models/index.js';
import type { FirestoreClient } from '../../src/core/firestore-client.js';

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
    investmentPrices: [],
    investmentSplits: [],
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

/** No-op Firestore client for write-tool tests. */
function createMockFirestoreClient(): FirestoreClient {
  const mock: Pick<
    FirestoreClient,
    'requireUserId' | 'getUserId' | 'updateDocument' | 'createDocument' | 'deleteDocument'
  > = {
    requireUserId: async () => 'test-user-123',
    getUserId: () => 'test-user-123',
    updateDocument: async () => {},
    createDocument: async () => {},
    deleteDocument: async () => {},
  };
  return mock as unknown as FirestoreClient;
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
    const writeTools = new CopilotMoneyTools(db, createMockFirestoreClient());
    writeServer._injectForTesting(db, writeTools);
  });

  test('set_transaction_category updates category', async () => {
    const result = await writeServer.handleCallTool('set_transaction_category', {
      transaction_id: 'txn1',
      category_id: 'custom_cat_1',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.transaction_id).toBe('txn1');
    expect(data.new_category_id).toBe('custom_cat_1');
    expect(data.old_category_id).toBe('food_dining');
  });

  test('create_tag creates a new tag', async () => {
    const result = await writeServer.handleCallTool('create_tag', {
      name: 'Business Trip',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.tag_id).toBe('business_trip');
    expect(data.name).toBe('Business Trip');
  });

  test('create_budget creates a new budget', async () => {
    const result = await writeServer.handleCallTool('create_budget', {
      category_id: 'custom_cat_1',
      amount: 300,
      period: 'monthly',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.category_id).toBe('custom_cat_1');
    expect(data.amount).toBe(300);
    expect(data.period).toBe('monthly');
    expect(data.budget_id).toBeString();
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

    const result = await server.handleCallTool('set_transaction_category', {
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
    writeServer._injectForTesting(db, new CopilotMoneyTools(db, createMockFirestoreClient()));

    const result = await writeServer.handleCallTool('set_transaction_category', {
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

  test('get_holdings returns holdings data', async () => {
    // With empty holdings data, should return empty array
    const result = await server.handleCallTool('get_holdings', {});
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(typeof data.count).toBe('number');
    expect(data.holdings).toBeArray();
  });

  test('get_investment_prices returns price data', async () => {
    const result = await server.handleCallTool('get_investment_prices', {});
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(typeof data.count).toBe('number');
    expect(data.prices).toBeArray();
  });

  test('get_investment_splits returns split data', async () => {
    const result = await server.handleCallTool('get_investment_splits', {});
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(typeof data.count).toBe('number');
    expect(data.splits).toBeArray();
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
    const writeTools = new CopilotMoneyTools(db, createMockFirestoreClient());
    writeServer._injectForTesting(db, writeTools);
  });

  // -- Transaction write tools --

  test('set_transaction_note sets a note', async () => {
    const result = await writeServer.handleCallTool('set_transaction_note', {
      transaction_id: 'txn1',
      note: 'Lunch with team',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.transaction_id).toBe('txn1');
    expect(data.new_note).toBe('Lunch with team');
  });

  test('set_transaction_tags assigns tags to a transaction', async () => {
    const result = await writeServer.handleCallTool('set_transaction_tags', {
      transaction_id: 'txn1',
      tag_ids: ['tag_vacation', 'tag_work'],
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.transaction_id).toBe('txn1');
    expect(data.new_tag_ids).toEqual(['tag_vacation', 'tag_work']);
  });

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

  test('set_transaction_excluded excludes a transaction', async () => {
    const result = await writeServer.handleCallTool('set_transaction_excluded', {
      transaction_id: 'txn1',
      excluded: true,
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.transaction_id).toBe('txn1');
    expect(data.excluded).toBe(true);
  });

  test('set_transaction_name renames a transaction', async () => {
    const result = await writeServer.handleCallTool('set_transaction_name', {
      transaction_id: 'txn1',
      name: 'Morning Coffee',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.transaction_id).toBe('txn1');
    expect(data.old_name).toBe('Coffee Shop');
    expect(data.new_name).toBe('Morning Coffee');
  });

  test('set_internal_transfer marks as internal transfer', async () => {
    const result = await writeServer.handleCallTool('set_internal_transfer', {
      transaction_id: 'txn1',
      internal_transfer: true,
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.transaction_id).toBe('txn1');
    expect(data.internal_transfer).toBe(true);
  });

  test('set_transaction_goal links a transaction to a goal', async () => {
    const result = await writeServer.handleCallTool('set_transaction_goal', {
      transaction_id: 'txn1',
      goal_id: 'goal1',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.transaction_id).toBe('txn1');
    expect(data.new_goal_id).toBe('goal1');
  });

  test('set_transaction_goal unlinks a goal with null', async () => {
    const result = await writeServer.handleCallTool('set_transaction_goal', {
      transaction_id: 'txn1',
      goal_id: null,
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.new_goal_id).toBeNull();
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
    expect(data.deleted_name).toBe('Vacation');
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
    expect(data.updated_fields).toContain('name');
  });

  // -- Category write tools --

  test('create_category creates a new category', async () => {
    const result = await writeServer.handleCallTool('create_category', {
      name: 'Side Projects',
      emoji: '🛠️',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.name).toBe('Side Projects');
    expect(data.emoji).toBe('🛠️');
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
    expect(data.updated_fields).toContain('name');
    expect(data.updated_fields).toContain('emoji');
  });

  test('delete_category deletes an existing category', async () => {
    const result = await writeServer.handleCallTool('delete_category', {
      category_id: 'custom_cat_1',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.category_id).toBe('custom_cat_1');
    expect(data.deleted_name).toBe('Custom Dining');
  });

  // -- Budget write tools --

  test('update_budget updates an existing budget', async () => {
    const result = await writeServer.handleCallTool('update_budget', {
      budget_id: 'budget1',
      amount: 600,
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.budget_id).toBe('budget1');
    expect(data.updated_fields).toContain('amount');
  });

  test('delete_budget deletes an existing budget', async () => {
    const result = await writeServer.handleCallTool('delete_budget', {
      budget_id: 'budget1',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.budget_id).toBe('budget1');
    expect(data.deleted_name).toBeString();
  });

  // -- Recurring write tools --

  test('set_recurring_state pauses a recurring item', async () => {
    const result = await writeServer.handleCallTool('set_recurring_state', {
      recurring_id: 'rec1',
      state: 'paused',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.recurring_id).toBe('rec1');
    expect(data.old_state).toBe('active');
    expect(data.new_state).toBe('paused');
    expect(data.name).toBeString();
  });

  test('delete_recurring deletes a recurring item', async () => {
    const result = await writeServer.handleCallTool('delete_recurring', {
      recurring_id: 'rec1',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.recurring_id).toBe('rec1');
    expect(data.deleted_name).toBeString();
  });

  test('create_recurring creates a new recurring item', async () => {
    const result = await writeServer.handleCallTool('create_recurring', {
      name: 'Spotify',
      amount: 9.99,
      frequency: 'monthly',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.name).toBe('Spotify');
    expect(data.amount).toBe(9.99);
    expect(data.frequency).toBe('monthly');
    expect(data.recurring_id).toBeString();
  });

  test('update_recurring updates a recurring item', async () => {
    const result = await writeServer.handleCallTool('update_recurring', {
      recurring_id: 'rec1',
      name: 'Netflix Premium',
      amount: 22.99,
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.recurring_id).toBe('rec1');
    expect(data.updated_fields).toContain('name');
    expect(data.updated_fields).toContain('amount');
  });

  // -- Goal write tools --

  test('create_goal creates a new goal', async () => {
    const result = await writeServer.handleCallTool('create_goal', {
      name: 'New Car',
      target_amount: 30000,
      monthly_contribution: 1000,
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.name).toBe('New Car');
    expect(data.target_amount).toBe(30000);
    expect(data.goal_id).toBeString();
  });

  test('update_goal updates a goal', async () => {
    const result = await writeServer.handleCallTool('update_goal', {
      goal_id: 'goal1',
      name: 'Emergency Fund V2',
      target_amount: 15000,
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.goal_id).toBe('goal1');
    expect(data.updated_fields).toContain('name');
    expect(data.updated_fields).toContain('savings');
  });

  test('delete_goal deletes a goal', async () => {
    const result = await writeServer.handleCallTool('delete_goal', {
      goal_id: 'goal1',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.goal_id).toBe('goal1');
    expect(data.deleted_name).toBe('Emergency Fund');
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
    const writeTools = new CopilotMoneyTools(db, createMockFirestoreClient());
    writeServer._injectForTesting(db, writeTools);
  });

  test('set_transaction_category with nonexistent transaction returns error', async () => {
    const result = await writeServer.handleCallTool('set_transaction_category', {
      transaction_id: 'nonexistent',
      category_id: 'food_dining',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  test('create_tag with empty name returns error', async () => {
    const result = await writeServer.handleCallTool('create_tag', {
      name: '   ',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('empty');
  });

  test('delete_tag with nonexistent tag returns error', async () => {
    const result = await writeServer.handleCallTool('delete_tag', {
      tag_id: 'nonexistent',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  test('update_category with no fields returns error', async () => {
    const result = await writeServer.handleCallTool('update_category', {
      category_id: 'custom_cat_1',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No fields');
  });

  test('create_recurring with invalid frequency returns error', async () => {
    const result = await writeServer.handleCallTool('create_recurring', {
      name: 'Bad Recurring',
      amount: 10,
      frequency: 'hourly',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid frequency');
  });

  test('create_goal with zero target returns error', async () => {
    const result = await writeServer.handleCallTool('create_goal', {
      name: 'Bad Goal',
      target_amount: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('greater than 0');
  });

  test('update_goal with nonexistent goal returns error', async () => {
    const result = await writeServer.handleCallTool('update_goal', {
      goal_id: 'nonexistent',
      name: 'Updated Name',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  test('set_recurring_state with invalid state returns error', async () => {
    const result = await writeServer.handleCallTool('set_recurring_state', {
      recurring_id: 'rec1',
      state: 'invalid_state',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid state');
  });

  test('review_transactions with empty array returns error', async () => {
    const result = await writeServer.handleCallTool('review_transactions', {
      transaction_ids: [],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty');
  });

  test('set_transaction_name with empty name returns error', async () => {
    const result = await writeServer.handleCallTool('set_transaction_name', {
      transaction_id: 'txn1',
      name: '   ',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('empty');
  });

  test('set_transaction_goal with nonexistent goal returns error', async () => {
    const result = await writeServer.handleCallTool('set_transaction_goal', {
      transaction_id: 'txn1',
      goal_id: 'nonexistent_goal',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });
});
