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
// Standard accounting: negative = expenses, positive = income/refunds
const mockTransactions: Transaction[] = [
  {
    transaction_id: 'txn1',
    amount: -50.0, // Expense
    date: '2025-01-15',
    name: 'Coffee Shop',
    category_id: 'food_dining',
    account_id: 'acc1',
    merchant_name: 'Starbucks',
  },
  {
    transaction_id: 'txn2',
    amount: -120.5, // Expense
    date: '2025-01-20',
    name: 'Grocery Store',
    category_id: 'groceries',
    account_id: 'acc1',
    merchant_name: 'Whole Foods',
  },
  {
    transaction_id: 'txn3',
    amount: -10.0, // Expense
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
    amount: -100.0, // Expense
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
    expect(toolNames).toContain('get_spending');
    expect(toolNames).toContain('get_account_balance');
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

  test('returns all 28 tools', () => {
    const response = server.handleListTools();

    const expectedTools = [
      'get_transactions',
      'get_accounts',
      'get_spending',
      'get_account_balance',
      'get_categories',
      'get_recurring_transactions',
      'get_income',
      'compare_periods',
      'get_trips',
      'get_unusual_transactions',
      'export_transactions',
      'get_data_quality_report',
      'get_budgets',
      'get_goals',
      'get_account_analytics',
      'get_budget_analytics',
      'get_goal_analytics',
      'get_goal_details',
      'get_goal_milestones',
      'get_investment_analytics',
      'get_merchant_analytics',
      'get_investment_prices',
      'get_investment_splits',
      'get_connected_institutions',
      'get_average_transaction_size',
      'get_category_trends',
      'get_portfolio_allocation',
      'get_year_over_year',
    ];

    const actualNames = response.tools.map((t) => t.name);
    for (const expected of expectedTools) {
      expect(actualNames).toContain(expected);
    }
    expect(response.tools.length).toBe(28);
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
  test('returns error message when database is unavailable', () => {
    const server = setupServerWithUnavailableDb();

    const response = server.handleCallTool('get_transactions', {});

    expect(response.content).toBeDefined();
    expect(response.content[0].type).toBe('text');
    expect(response.content[0].text).toContain('Database not available');
  });

  test('database unavailable error works for all tools', () => {
    const server = setupServerWithUnavailableDb();

    const toolsToTest = ['get_transactions', 'get_accounts', 'get_spending'];
    for (const toolName of toolsToTest) {
      const response = server.handleCallTool(toolName, { query: 'test' });
      expect(response.content[0].text).toContain('Database not available');
    }
  });
});

describe('CopilotMoneyServer.handleCallTool - basic tools', () => {
  let server: CopilotMoneyServer;

  beforeEach(() => {
    server = setupServerWithMockData();
  });

  test('get_transactions - routes correctly', () => {
    const response = server.handleCallTool('get_transactions', { limit: 10 });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.transactions).toBeDefined();
    expect(result.count).toBeDefined();
  });

  test('get_transactions - handles empty arguments', () => {
    const response = server.handleCallTool('get_transactions', undefined);

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.transactions).toBeDefined();
  });

  test('get_transactions - handles null-like arguments', () => {
    const response = server.handleCallTool('get_transactions', {});

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.transactions).toBeDefined();
  });

  test('get_spending - routes correctly with group_by', () => {
    const response = server.handleCallTool('get_spending', { group_by: 'category' });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.data).toBeDefined();
    expect(result.group_by).toBe('category');
  });

  test('get_spending - returns error when group_by missing', () => {
    const response = server.handleCallTool('get_spending', {});

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Missing required parameter: group_by');
  });

  test('get_spending - with optional params', () => {
    const response = server.handleCallTool('get_spending', {
      group_by: 'merchant',
      limit: 5,
      period: 'this_month',
    });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });

  test('get_accounts - routes correctly', () => {
    const response = server.handleCallTool('get_accounts', {});

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.accounts).toBeDefined();
    expect(result.count).toBeGreaterThan(0);
  });

  test('get_accounts - with account_type filter', () => {
    const response = server.handleCallTool('get_accounts', { account_type: 'checking' });

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.accounts).toBeDefined();
  });

  test('get_spending with group_by category - routes correctly', () => {
    const response = server.handleCallTool('get_spending', { group_by: 'category' });

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.group_by).toBe('category');
    expect(result.data).toBeDefined();
    expect(result.total_spending).toBeDefined();
  });

  test('get_account_balance - routes correctly', () => {
    const response = server.handleCallTool('get_account_balance', { account_id: 'acc1' });

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.account_id).toBe('acc1');
    expect(result.current_balance).toBeDefined();
  });

  test('get_account_balance - returns error when account_id missing', () => {
    const response = server.handleCallTool('get_account_balance', {});

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Missing required parameter: account_id');
  });

  test('get_account_balance - returns error for nonexistent account', () => {
    const response = server.handleCallTool('get_account_balance', {
      account_id: 'nonexistent_account_123',
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Error:');
  });

  test('get_categories - routes correctly', () => {
    const response = server.handleCallTool('get_categories', {});

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.view).toBe('list');
    expect(result.data.categories).toBeDefined();
    expect(result.count).toBeDefined();
  });

  test('get_recurring_transactions - routes correctly', () => {
    const response = server.handleCallTool('get_recurring_transactions', {});

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result).toBeDefined();
  });

  test('get_income - routes correctly', () => {
    const response = server.handleCallTool('get_income', {});

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result).toBeDefined();
  });

  test('get_spending with group_by merchant - routes correctly', () => {
    const response = server.handleCallTool('get_spending', { group_by: 'merchant' });

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result).toBeDefined();
  });
});

describe('CopilotMoneyServer.handleCallTool - compare_periods', () => {
  let server: CopilotMoneyServer;

  beforeEach(() => {
    server = setupServerWithMockData();
  });

  test('compare_periods - routes correctly with required params', () => {
    const response = server.handleCallTool('compare_periods', {
      period1: 'this_month',
      period2: 'last_month',
    });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result).toBeDefined();
  });

  test('compare_periods - returns error when period1 missing', () => {
    const response = server.handleCallTool('compare_periods', { period2: 'last_month' });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Missing required parameters');
  });

  test('compare_periods - returns error when period2 missing', () => {
    const response = server.handleCallTool('compare_periods', { period1: 'this_month' });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Missing required parameters');
  });

  test('compare_periods - returns error when both periods missing', () => {
    const response = server.handleCallTool('compare_periods', {});

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Missing required parameters');
  });

  test('compare_periods - with exclude_transfers', () => {
    const response = server.handleCallTool('compare_periods', {
      period1: 'this_month',
      period2: 'last_month',
      exclude_transfers: true,
    });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });
});

describe('CopilotMoneyServer.handleCallTool - new tools (13-22)', () => {
  let server: CopilotMoneyServer;

  beforeEach(() => {
    server = setupServerWithMockData();
  });

  test('get_transactions with transaction_type foreign - routes correctly', () => {
    const response = server.handleCallTool('get_transactions', { transaction_type: 'foreign' });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });

  test('get_transactions with transaction_type refunds - routes correctly', () => {
    const response = server.handleCallTool('get_transactions', { transaction_type: 'refunds' });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });

  test('get_transactions with transaction_type duplicates - routes correctly', () => {
    const response = server.handleCallTool('get_transactions', { transaction_type: 'duplicates' });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });

  test('get_transactions with transaction_type credits - routes correctly', () => {
    const response = server.handleCallTool('get_transactions', { transaction_type: 'credits' });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });

  test('get_spending with day_of_week - routes correctly', () => {
    const response = server.handleCallTool('get_spending', { group_by: 'day_of_week' });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });

  test('get_trips - routes correctly', () => {
    const response = server.handleCallTool('get_trips', {});

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });

  test('get_transactions with transaction_id - routes correctly', () => {
    const response = server.handleCallTool('get_transactions', { transaction_id: 'txn1' });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });

  test('get_merchant_analytics - routes correctly', () => {
    const response = server.handleCallTool('get_merchant_analytics', { sort_by: 'spending' });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });

  test('get_merchant_analytics - returns error when sort_by missing', () => {
    const response = server.handleCallTool('get_merchant_analytics', {});

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Missing required parameter: sort_by');
  });

  test('get_unusual_transactions - routes correctly', () => {
    const response = server.handleCallTool('get_unusual_transactions', {});

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });

  test('export_transactions - routes correctly', () => {
    const response = server.handleCallTool('export_transactions', {});

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });

  test('get_account_analytics - routes correctly', () => {
    const response = server.handleCallTool('get_account_analytics', { analysis: 'activity' });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });

  test('get_budget_analytics - routes correctly', () => {
    const response = server.handleCallTool('get_budget_analytics', { analysis: 'utilization' });

    expect(response.content).toBeDefined();
    expect(response.isError).toBeUndefined();
  });
});

describe('CopilotMoneyServer.handleCallTool - error handling', () => {
  let server: CopilotMoneyServer;

  beforeEach(() => {
    server = setupServerWithMockData();
  });

  test('returns error for unknown tool', () => {
    const response = server.handleCallTool('unknown_tool_that_does_not_exist', {});

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Unknown tool');
    expect(response.content[0].text).toContain('unknown_tool_that_does_not_exist');
  });

  test('handles tool execution errors gracefully', () => {
    // Create server with mock that throws
    const db = new CopilotDatabase('/fake/path');
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
    db.isAvailable = () => true;
    const tools = new CopilotMoneyTools(db);
    tools.getAccountBalance = () => {
      throw new Error('Test error from tool');
    };
    server._injectForTesting(db, tools);

    const response = server.handleCallTool('get_account_balance', { account_id: 'acc1' });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Error:');
    expect(response.content[0].text).toContain('Test error from tool');
  });

  test('handles non-Error exceptions', () => {
    const db = new CopilotDatabase('/fake/path');
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
    db.isAvailable = () => true;
    const tools = new CopilotMoneyTools(db);
    tools.getCategories = () => {
      throw 'string error';
    };
    server._injectForTesting(db, tools);

    const response = server.handleCallTool('get_categories', {});

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Error:');
    expect(response.content[0].text).toContain('string error');
  });

  test('handles number exceptions', () => {
    const db = new CopilotDatabase('/fake/path');
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
    db.isAvailable = () => true;
    const tools = new CopilotMoneyTools(db);
    tools.getCategories = () => {
      throw 42;
    };
    server._injectForTesting(db, tools);

    const response = server.handleCallTool('get_categories', {});

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

  test('successful response has correct structure', () => {
    const response = server.handleCallTool('get_transactions', {});

    expect(response.content).toBeDefined();
    expect(Array.isArray(response.content)).toBe(true);
    expect(response.content.length).toBe(1);
    expect(response.content[0].type).toBe('text');
    expect(typeof response.content[0].text).toBe('string');
    expect(response.isError).toBeUndefined();
  });

  test('error response has isError flag', () => {
    const response = server.handleCallTool('unknown_tool', {});

    expect(response.isError).toBe(true);
    expect(response.content).toBeDefined();
  });

  test('successful response is valid JSON', () => {
    const response = server.handleCallTool('get_accounts', {});

    expect(() => JSON.parse(response.content[0].text)).not.toThrow();
  });

  test('response JSON is properly formatted with indentation', () => {
    const response = server.handleCallTool('get_accounts', {});
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

  test('_injectForTesting method works correctly', () => {
    const server = new CopilotMoneyServer('/fake/path');
    const db = new CopilotDatabase('/test/path');
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
    db.isAvailable = () => true;
    const tools = new CopilotMoneyTools(db);

    server._injectForTesting(db, tools);

    // Verify injection worked by calling a tool
    const response = server.handleCallTool('get_transactions', {});
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

  test('handles undefined arguments gracefully', () => {
    const response = server.handleCallTool('get_transactions', undefined);
    expect(response.isError).toBeUndefined();
  });

  test('handles empty object arguments', () => {
    const response = server.handleCallTool('get_transactions', {});
    expect(response.isError).toBeUndefined();
  });

  test('get_spending - group_by parameter validation', () => {
    // Number group_by should fail
    const response = server.handleCallTool('get_spending', { group_by: 123 as any });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Missing required parameter: group_by');
  });

  test('get_account_balance - account_id parameter validation', () => {
    // Number account_id should fail
    const response = server.handleCallTool('get_account_balance', { account_id: 123 as any });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Missing required parameter: account_id');
  });

  test('get_merchant_analytics - sort_by parameter validation', () => {
    // Number sort_by should fail
    const response = server.handleCallTool('get_merchant_analytics', { sort_by: 123 as any });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Missing required parameter: sort_by');
  });

  test('compare_periods - non-string period validation', () => {
    const response = server.handleCallTool('compare_periods', {
      period1: 123 as any,
      period2: 'last_month',
    });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Missing required parameters');
  });
});
