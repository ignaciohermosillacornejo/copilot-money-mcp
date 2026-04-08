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
    securities: [],
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
