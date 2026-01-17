/**
 * Protocol tests for the MCP server.
 *
 * Tests the handleListTools and handleCallTool methods which contain
 * the core protocol logic.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyServer, type ToolResponse } from '../../src/server.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import type { Transaction, Account } from '../../src/models/index.js';

// Mock data for testing
// Copilot Money format: positive = expenses, negative = income/refunds
const mockTransactions: Transaction[] = [
  {
    transaction_id: 'txn1',
    amount: 50.0, // Expense (positive in Copilot format)
    date: '2025-01-15',
    name: 'Coffee Shop',
    category_id: 'food_dining',
    account_id: 'acc1',
    merchant_name: 'Starbucks',
  },
  {
    transaction_id: 'txn2',
    amount: 120.5, // Expense (positive in Copilot format)
    date: '2025-01-20',
    name: 'Grocery Store',
    category_id: 'groceries',
    account_id: 'acc1',
    merchant_name: 'Whole Foods',
  },
  {
    transaction_id: 'txn3',
    amount: 10.0, // Expense (positive in Copilot format)
    date: '2024-12-15',
    name: 'Parking',
    category_id: 'transportation',
    account_id: 'acc2',
  },
  {
    transaction_id: 'txn4',
    amount: 25.0, // Refund/Credit (positive = money in)
    date: '2025-01-18',
    name: 'Refund - Fast Food',
    category_id: 'food_dining',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn5',
    amount: 100.0, // Expense (positive in Copilot format)
    date: '2025-01-10',
    name: 'Foreign Purchase',
    category_id: 'shopping',
    account_id: 'acc1',
    iso_currency_code: 'EUR',
    unofficial_currency_code: 'EUR',
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

/**
 * Helper to set up a server with mock data.
 */
function setupServerWithMockData(): CopilotMoneyServer {
  const server = new CopilotMoneyServer('/fake/path');

  // Create a mock database with data
  const db = new CopilotDatabase('/fake/path');
  (db as any)._transactions = [...mockTransactions];
  (db as any)._accounts = [...mockAccounts];
  // Also mock the auxiliary data needed for name resolution
  (db as any)._userCategories = []; // Empty - no user-defined categories
  (db as any)._userAccounts = []; // Empty - no user-defined account names
  (db as any)._categoryNameMap = new Map<string, string>(); // Pre-compute empty map
  (db as any)._accountNameMap = new Map<string, string>(); // Pre-compute empty map
  (db as any)._recurring = []; // Empty recurring transactions
  (db as any)._budgets = []; // Empty budgets
  (db as any)._goals = []; // Empty goals
  // Mock isAvailable to return true since we have mock data
  db.isAvailable = () => true;

  // Inject mock database and tools
  server._injectForTesting(db, new CopilotMoneyTools(db));

  return server;
}

/**
 * Helper to set up a server with unavailable database.
 */
function setupServerWithUnavailableDb(): CopilotMoneyServer {
  return new CopilotMoneyServer('/nonexistent/path/that/does/not/exist');
}

describe('CopilotMoneyServer.handleListTools', () => {
  let server: CopilotMoneyServer;

  beforeEach(() => {
    server = setupServerWithMockData();
  });

  test('returns list of available tools', () => {
    const response = server.handleListTools();

    expect(response.tools).toBeDefined();
    expect(Array.isArray(response.tools)).toBe(true);
    expect(response.tools.length).toBeGreaterThan(0);
  });

  test('includes expected tools in list', () => {
    const response = server.handleListTools();
    const toolNames = response.tools.map((t) => t.name);

    expect(toolNames).toContain('get_transactions');
    expect(toolNames).toContain('get_accounts');
    expect(toolNames).toContain('get_categories');
    expect(toolNames).toContain('get_recurring_transactions');
    expect(toolNames).toContain('get_budgets');
    expect(toolNames).toContain('get_goals');
  });

  test('each tool has required fields', () => {
    const response = server.handleListTools();

    for (const tool of response.tools) {
      expect(tool.name).toBeDefined();
      expect(typeof tool.name).toBe('string');
      expect(tool.description).toBeDefined();
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.inputSchema).toBe('object');
    }
  });

  test('returns all 6 tools', () => {
    const response = server.handleListTools();

    const expectedTools = [
      'get_transactions',
      'get_accounts',
      'get_categories',
      'get_recurring_transactions',
      'get_budgets',
      'get_goals',
    ];

    const actualNames = response.tools.map((t) => t.name);
    for (const expected of expectedTools) {
      expect(actualNames).toContain(expected);
    }
    expect(response.tools.length).toBe(6);
  });

  test('tool schemas have valid JSON schema format', () => {
    const response = server.handleListTools();

    for (const tool of response.tools) {
      expect(tool.inputSchema).toHaveProperty('type');
      expect((tool.inputSchema as any).type).toBe('object');
    }
  });
});

describe('CopilotMoneyServer.handleCallTool - database unavailable', () => {
  test('returns error message when database is unavailable', async () => {
    const server = setupServerWithUnavailableDb();

    const response = await server.handleCallTool('get_transactions', {});

    expect(response.content).toBeDefined();
    expect(response.content[0].type).toBe('text');
    expect(response.content[0].text).toContain('Database not available');
  });

  test('database unavailable error works for all tools', async () => {
    const server = setupServerWithUnavailableDb();

    const toolsToTest = ['get_transactions', 'get_accounts', 'get_categories'];
    for (const toolName of toolsToTest) {
      const response = await server.handleCallTool(toolName, {});
      expect(response.content[0].text).toContain('Database not available');
    }
  });
});

describe('CopilotMoneyServer.handleCallTool - basic tools', () => {
  let server: CopilotMoneyServer;

  beforeEach(() => {
    server = setupServerWithMockData();
  });

  test('get_transactions - routes correctly', async () => {
    const response = await server.handleCallTool('get_transactions', { limit: 10 });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.transactions).toBeDefined();
    expect(result.count).toBeDefined();
  });

  test('get_transactions - handles empty arguments', async () => {
    const response = await server.handleCallTool('get_transactions', undefined);

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.transactions).toBeDefined();
  });

  test('get_transactions - handles null-like arguments', async () => {
    const response = await server.handleCallTool('get_transactions', {});

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.transactions).toBeDefined();
  });

  test('get_accounts - routes correctly', async () => {
    const response = await server.handleCallTool('get_accounts', {});

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.accounts).toBeDefined();
    expect(result.count).toBeGreaterThan(0);
  });

  test('get_accounts - with account_type filter', async () => {
    const response = await server.handleCallTool('get_accounts', { account_type: 'checking' });

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.accounts).toBeDefined();
  });

  test('get_categories - routes correctly', async () => {
    const response = await server.handleCallTool('get_categories', {});

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.view).toBe('list');
    expect(result.data.categories).toBeDefined();
    expect(result.count).toBeDefined();
  });

  test('get_recurring_transactions - routes correctly', async () => {
    const response = await server.handleCallTool('get_recurring_transactions', {});

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result).toBeDefined();
  });
});

describe('CopilotMoneyServer.handleCallTool - transaction types', () => {
  let server: CopilotMoneyServer;

  beforeEach(() => {
    server = setupServerWithMockData();
  });

  test('get_transactions with transaction_type foreign - routes correctly', async () => {
    const response = await server.handleCallTool('get_transactions', {
      transaction_type: 'foreign',
    });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });

  test('get_transactions with transaction_type refunds - routes correctly', async () => {
    const response = await server.handleCallTool('get_transactions', {
      transaction_type: 'refunds',
    });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });

  test('get_transactions with transaction_type duplicates - routes correctly', async () => {
    const response = await server.handleCallTool('get_transactions', {
      transaction_type: 'duplicates',
    });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });

  test('get_transactions with transaction_type credits - routes correctly', async () => {
    const response = await server.handleCallTool('get_transactions', {
      transaction_type: 'credits',
    });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });

  test('get_transactions with transaction_id - routes correctly', async () => {
    const response = await server.handleCallTool('get_transactions', { transaction_id: 'txn1' });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });
});

describe('CopilotMoneyServer.handleCallTool - error handling', () => {
  let server: CopilotMoneyServer;

  beforeEach(() => {
    server = setupServerWithMockData();
  });

  test('returns error for unknown tool', async () => {
    const response = await server.handleCallTool('unknown_tool_that_does_not_exist', {});

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Unknown tool');
    expect(response.content[0].text).toContain('unknown_tool_that_does_not_exist');
  });

  test('handles tool execution errors gracefully', async () => {
    // Create server with mock that throws
    const db = new CopilotDatabase('/fake/path');
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
    db.isAvailable = () => true;
    const tools = new CopilotMoneyTools(db);
    tools.getAccounts = () => {
      throw new Error('Test error from tool');
    };
    server._injectForTesting(db, tools);

    const response = await server.handleCallTool('get_accounts', {});

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Error:');
    expect(response.content[0].text).toContain('Test error from tool');
  });

  test('handles non-Error exceptions', async () => {
    const db = new CopilotDatabase('/fake/path');
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
    db.isAvailable = () => true;
    const tools = new CopilotMoneyTools(db);
    tools.getCategories = () => {
      throw 'string error';
    };
    server._injectForTesting(db, tools);

    const response = await server.handleCallTool('get_categories', {});

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Error:');
    expect(response.content[0].text).toContain('string error');
  });

  test('handles number exceptions', async () => {
    const db = new CopilotDatabase('/fake/path');
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
    db.isAvailable = () => true;
    const tools = new CopilotMoneyTools(db);
    tools.getCategories = () => {
      throw 42;
    };
    server._injectForTesting(db, tools);

    const response = await server.handleCallTool('get_categories', {});

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Error:');
    expect(response.content[0].text).toContain('42');
  });
});

describe('CopilotMoneyServer.handleCallTool - response format', () => {
  let server: CopilotMoneyServer;

  beforeEach(() => {
    server = setupServerWithMockData();
  });

  test('successful response has correct structure', async () => {
    const response = await server.handleCallTool('get_transactions', {});

    expect(response.content).toBeDefined();
    expect(Array.isArray(response.content)).toBe(true);
    expect(response.content.length).toBe(1);
    expect(response.content[0].type).toBe('text');
    expect(typeof response.content[0].text).toBe('string');
    expect(response.isError).toBeUndefined();
  });

  test('error response has isError flag', async () => {
    const response = await server.handleCallTool('unknown_tool', {});

    expect(response.isError).toBe(true);
    expect(response.content).toBeDefined();
  });

  test('successful response is valid JSON', async () => {
    const response = await server.handleCallTool('get_accounts', {});

    expect(() => JSON.parse(response.content[0].text)).not.toThrow();
  });

  test('response JSON is properly formatted with indentation', async () => {
    const response = await server.handleCallTool('get_accounts', {});
    const text = response.content[0].text;

    // Should contain newlines indicating formatting
    expect(text).toContain('\n');
    // Parse and verify structure
    const parsed = JSON.parse(text);
    expect(parsed).toBeDefined();
  });
});

describe('CopilotMoneyServer - constructor and initialization', () => {
  test('creates server with custom database path', () => {
    const server = new CopilotMoneyServer('/custom/path');
    expect(server).toBeDefined();
    expect(server.handleListTools).toBeDefined();
    expect(server.handleCallTool).toBeDefined();
  });

  test('creates server with default path', () => {
    const server = new CopilotMoneyServer();
    expect(server).toBeDefined();
  });

  test('has run method', () => {
    const server = new CopilotMoneyServer('/fake/path');
    expect(typeof server.run).toBe('function');
  });

  test('_injectForTesting method works correctly', async () => {
    const server = new CopilotMoneyServer('/fake/path');
    const db = new CopilotDatabase('/test/path');
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
    // Also mock auxiliary data for name resolution
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
    (db as any)._categoryNameMap = new Map<string, string>();
    (db as any)._accountNameMap = new Map<string, string>();
    (db as any)._recurring = [];
    (db as any)._budgets = [];
    (db as any)._goals = [];
    db.isAvailable = () => true;
    const tools = new CopilotMoneyTools(db);

    server._injectForTesting(db, tools);

    // Verify injection worked by calling a tool
    const response = await server.handleCallTool('get_transactions', {});
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.transactions.length).toBeGreaterThan(0);
  });
});

describe('CopilotMoneyServer - tool arguments edge cases', () => {
  let server: CopilotMoneyServer;

  beforeEach(() => {
    server = setupServerWithMockData();
  });

  test('handles undefined arguments gracefully', async () => {
    const response = await server.handleCallTool('get_transactions', undefined);
    expect(response.isError).toBeUndefined();
  });

  test('handles empty object arguments', async () => {
    const response = await server.handleCallTool('get_transactions', {});
    expect(response.isError).toBeUndefined();
  });
});
