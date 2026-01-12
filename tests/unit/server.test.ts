/**
 * Unit tests for the MCP server implementation.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { CopilotMoneyServer, runServer } from '../../src/server.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import type { Transaction, Account } from '../../src/models/index.js';

// Mock data
const mockTransactions: Transaction[] = [
  {
    transaction_id: 'txn1',
    amount: 50.0,
    date: '2026-01-15',
    name: 'Test Transaction',
    category_id: 'food_dining',
    account_id: 'acc1',
  },
];

const mockAccounts: Account[] = [
  {
    account_id: 'acc1',
    current_balance: 1000.0,
    name: 'Test Account',
    account_type: 'checking',
  },
];

describe('CopilotMoneyServer', () => {
  describe('initialization', () => {
    test('initializes with valid database path', () => {
      const server = new CopilotMoneyServer('/fake/path');

      expect(server).toBeDefined();
      // @ts-expect-error - accessing private property for testing
      expect(server.db).toBeDefined();
      // @ts-expect-error - accessing private property for testing
      expect(server.tools).toBeDefined();
      // @ts-expect-error - accessing private property for testing
      expect(server.server).toBeDefined();
    });

    test('initializes without database path (uses default)', () => {
      const server = new CopilotMoneyServer();

      expect(server).toBeDefined();
      // @ts-expect-error - accessing private property for testing
      expect(server.db).toBeDefined();
      // @ts-expect-error - accessing private property for testing
      expect(server.tools).toBeDefined();
    });

    test('initializes with non-existent database', () => {
      const server = new CopilotMoneyServer('/nonexistent/path');

      expect(server).toBeDefined();
      // @ts-expect-error - accessing private property for testing
      expect(server.db.isAvailable()).toBe(false);
    });

    test('has run method', () => {
      const server = new CopilotMoneyServer('/fake/path');
      expect(typeof server.run).toBe('function');
    });

    test('initializes MCP server instance', () => {
      const server = new CopilotMoneyServer('/fake/path');
      // @ts-expect-error - accessing private property for testing
      const mcpServer = server.server;

      expect(mcpServer).toBeDefined();
      // Server should be an instance of Server from MCP SDK
      expect(mcpServer.constructor.name).toBe('Server');
    });
  });

  describe('request handler - list tools', () => {
    test('server can list available tools via tools property', () => {
      const server = new CopilotMoneyServer('/fake/path');
      // @ts-expect-error - accessing private property for testing
      const tools = server.tools;

      // The tools instance should have methods corresponding to available tools
      expect(tools.getTransactions).toBeDefined();
      expect(tools.searchTransactions).toBeDefined();
      expect(tools.getAccounts).toBeDefined();
      expect(tools.getCategories).toBeDefined();
      expect(typeof tools.getTransactions).toBe('function');
    });
  });

  describe('request handler - call tool', () => {
    let server: CopilotMoneyServer;
    let db: CopilotDatabase;

    beforeEach(() => {
      db = new CopilotDatabase('/fake/path');
      // @ts-expect-error - inject mock data
      db._transactions = [...mockTransactions];
      // @ts-expect-error - inject mock data
      db._accounts = [...mockAccounts];

      server = new CopilotMoneyServer('/fake/path');
      // @ts-expect-error - inject mock db
      server.db = db;
      // @ts-expect-error - inject tools with mock db
      server.tools = new CopilotMoneyTools(db);
    });

    test('handles get_transactions tool call', () => {
      // @ts-expect-error - accessing private property
      const tools = server.tools;
      const result = tools.getTransactions({});

      expect(result.count).toBeGreaterThan(0);
      expect(result.transactions).toBeDefined();
    });

    test('handles search_transactions tool call', () => {
      // @ts-expect-error - accessing private property
      const tools = server.tools;
      const result = tools.searchTransactions('Test', 10);

      expect(result.count).toBeDefined();
      expect(result.transactions).toBeDefined();
    });

    test('handles get_accounts tool call', () => {
      // @ts-expect-error - accessing private property
      const tools = server.tools;
      const result = tools.getAccounts();

      expect(result.count).toBeGreaterThan(0);
      expect(result.accounts).toBeDefined();
    });

    test('handles get_spending_by_category tool call', () => {
      // @ts-expect-error - accessing private property
      const tools = server.tools;
      const result = tools.getSpendingByCategory({});

      expect(result.total_spending).toBeDefined();
      expect(result.categories).toBeDefined();
    });

    test('handles get_account_balance tool call', () => {
      // @ts-expect-error - accessing private property
      const tools = server.tools;
      const result = tools.getAccountBalance('acc1');

      expect(result.account_id).toBe('acc1');
      expect(result.current_balance).toBeDefined();
    });

    test('throws error for get_account_balance with invalid ID', () => {
      // @ts-expect-error - accessing private property
      const tools = server.tools;

      expect(() => {
        tools.getAccountBalance('invalid_id');
      }).toThrow('Account not found');
    });

    test('handles get_categories tool call', () => {
      // @ts-expect-error - accessing private property
      const tools = server.tools;
      const result = tools.getCategories();

      expect(result.count).toBeDefined();
      expect(result.categories).toBeDefined();
      expect(Array.isArray(result.categories)).toBe(true);
    });
  });

  describe('database unavailable handling', () => {
    test('returns appropriate message when database unavailable', () => {
      const server = new CopilotMoneyServer('/nonexistent/path');
      // @ts-expect-error - accessing private property
      const db = server.db;

      expect(db.isAvailable()).toBe(false);
    });
  });

  describe('error handling', () => {
    test('handles missing required parameters', () => {
      const server = new CopilotMoneyServer('/fake/path');
      // @ts-expect-error - accessing private property
      const tools = server.tools;

      // get_account_balance requires account_id
      expect(() => {
        // @ts-expect-error - intentionally passing invalid input
        tools.getAccountBalance();
      }).toThrow();
    });

    test('handles invalid tool arguments gracefully', () => {
      const db = new CopilotDatabase('/fake/path');
      // @ts-expect-error - inject mock data
      db._transactions = [...mockTransactions];
      // @ts-expect-error - inject mock data
      db._accounts = [...mockAccounts];

      const server = new CopilotMoneyServer('/fake/path');
      // @ts-expect-error - inject mock db
      server.db = db;
      // @ts-expect-error - inject tools with mock db
      server.tools = new CopilotMoneyTools(db);

      // @ts-expect-error - accessing private property
      const tools = server.tools;

      // Should handle empty/invalid arguments
      const result = tools.getTransactions({});
      expect(result).toBeDefined();
    });
  });
});

describe('runServer function', () => {
  test('creates and runs server instance', async () => {
    // Since runServer calls server.run() which connects to stdio,
    // we can't easily test it without mocking the transport
    // Just verify the function exists and accepts optional path
    expect(typeof runServer).toBe('function');

    // Test that it accepts no arguments
    const serverPromise = runServer();
    expect(serverPromise).toBeInstanceOf(Promise);

    // Test that it accepts a path
    const serverPromise2 = runServer('/test/path');
    expect(serverPromise2).toBeInstanceOf(Promise);

    // Note: We can't await these as they'll hang waiting for stdio
    // In a real test environment, we'd mock the transport
  });
});
