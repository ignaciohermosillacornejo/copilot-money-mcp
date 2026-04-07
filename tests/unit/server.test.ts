/**
 * Unit tests for the MCP server implementation.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { CopilotMoneyServer, runServer } from '../../src/server.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { createWriteToolSchemas } from '../../src/tools/index.js';
import type { Transaction, Account } from '../../src/models/index.js';

// Mock data
// Copilot Money format: positive = expenses, negative = income
const mockTransactions: Transaction[] = [
  {
    transaction_id: 'txn1',
    amount: 50.0, // Expense (positive in Copilot format)
    date: '2025-01-15',
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
      expect(tools.getAccounts).toBeDefined();
      expect(tools.getCategories).toBeDefined();
      expect(tools.getRecurringTransactions).toBeDefined();
      expect(tools.getBudgets).toBeDefined();
      expect(tools.getGoals).toBeDefined();
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
      // @ts-expect-error - inject auxiliary data for name resolution
      db._userCategories = [];
      // @ts-expect-error - inject auxiliary data
      db._userAccounts = [];
      // @ts-expect-error - inject auxiliary data
      db._categoryNameMap = new Map<string, string>();
      // @ts-expect-error - inject auxiliary data
      db._accountNameMap = new Map<string, string>();
      // @ts-expect-error - inject auxiliary data
      db._recurring = [];
      // @ts-expect-error - inject auxiliary data
      db._budgets = [];
      // @ts-expect-error - inject auxiliary data
      db._goals = [];

      server = new CopilotMoneyServer('/fake/path');
      // @ts-expect-error - inject mock db
      server.db = db;
      // @ts-expect-error - inject tools with mock db
      server.tools = new CopilotMoneyTools(db);
    });

    test('handles get_transactions tool call', async () => {
      // @ts-expect-error - accessing private property
      const tools = server.tools;
      const result = await tools.getTransactions({});

      expect(result.count).toBeGreaterThan(0);
      expect(result.transactions).toBeDefined();
    });

    test('handles get_accounts tool call', async () => {
      // @ts-expect-error - accessing private property
      const tools = server.tools;
      const result = await tools.getAccounts();

      expect(result.count).toBeGreaterThan(0);
      expect(result.accounts).toBeDefined();
    });

    test('handles get_categories tool call', async () => {
      // @ts-expect-error - accessing private property
      const tools = server.tools;
      const result = await tools.getCategories();

      expect(result.view).toBe('list');
      expect(result.count).toBeDefined();
      expect((result.data as { categories: unknown[] }).categories).toBeDefined();
      expect(Array.isArray((result.data as { categories: unknown[] }).categories)).toBe(true);
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
    test('handles invalid tool arguments gracefully', async () => {
      const db = new CopilotDatabase('/fake/path');
      // @ts-expect-error - inject mock data
      db._transactions = [...mockTransactions];
      // @ts-expect-error - inject mock data
      db._accounts = [...mockAccounts];
      // @ts-expect-error - inject auxiliary data
      db._userCategories = [];
      // @ts-expect-error - inject auxiliary data
      db._userAccounts = [];
      // @ts-expect-error - inject auxiliary data
      db._categoryNameMap = new Map<string, string>();
      // @ts-expect-error - inject auxiliary data
      db._accountNameMap = new Map<string, string>();
      // @ts-expect-error - inject auxiliary data
      db._recurring = [];
      // @ts-expect-error - inject auxiliary data
      db._budgets = [];
      // @ts-expect-error - inject auxiliary data
      db._goals = [];

      const server = new CopilotMoneyServer('/fake/path');
      // @ts-expect-error - inject mock db
      server.db = db;
      // @ts-expect-error - inject tools with mock db
      server.tools = new CopilotMoneyTools(db);

      // @ts-expect-error - accessing private property
      const tools = server.tools;

      // Should handle empty/invalid arguments
      const result = await tools.getTransactions({});
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

describe('CopilotMoneyServer write mode', () => {
  test('handleListTools returns only read tools by default', () => {
    const server = new CopilotMoneyServer();
    const result = server.handleListTools();
    const toolNames = result.tools.map((t) => t.name);

    expect(toolNames).toContain('get_transactions');
    expect(toolNames).not.toContain('set_transaction_category');
    expect(toolNames).not.toContain('set_transaction_note');
    expect(toolNames).not.toContain('create_tag');
    expect(toolNames).not.toContain('delete_tag');
  });

  test('handleListTools returns read + write tools when writeEnabled', () => {
    const server = new CopilotMoneyServer(undefined, undefined, true);
    const result = server.handleListTools();
    const toolNames = result.tools.map((t) => t.name);

    expect(toolNames).toContain('get_transactions');
    expect(toolNames).toContain('set_transaction_category');
    expect(toolNames).toContain('set_transaction_note');
    expect(toolNames).toContain('set_transaction_excluded');
    expect(toolNames).toContain('set_transaction_name');
    expect(toolNames).toContain('set_internal_transfer');
    expect(toolNames).toContain('set_transaction_goal');
    expect(toolNames).toContain('create_tag');
    expect(toolNames).toContain('delete_tag');
    expect(toolNames).toContain('create_category');
    expect(toolNames).toContain('update_category');
    expect(toolNames).toContain('delete_category');
    expect(toolNames).toContain('create_budget');
    expect(toolNames).toContain('update_budget');
    expect(toolNames).toContain('delete_budget');
    expect(toolNames).toContain('set_recurring_state');
    expect(toolNames).toContain('delete_recurring');
    expect(toolNames).toContain('update_goal');
    expect(toolNames).toContain('delete_goal');
  });

  test('write tool has correct annotations', () => {
    const server = new CopilotMoneyServer(undefined, undefined, true);
    const result = server.handleListTools();
    const writeTool = result.tools.find((t) => t.name === 'set_transaction_category');

    expect(writeTool).toBeDefined();
    expect(writeTool!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  test('create_tag has correct annotations', () => {
    const server = new CopilotMoneyServer(undefined, undefined, true);
    const result = server.handleListTools();
    const tool = result.tools.find((t) => t.name === 'create_tag');

    expect(tool).toBeDefined();
    expect(tool!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  test('delete_tag has destructiveHint set', () => {
    const server = new CopilotMoneyServer(undefined, undefined, true);
    const result = server.handleListTools();
    const tool = result.tools.find((t) => t.name === 'delete_tag');

    expect(tool).toBeDefined();
    expect(tool!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  });

  test('create_category has correct annotations', () => {
    const server = new CopilotMoneyServer(undefined, undefined, true);
    const result = server.handleListTools();
    const tool = result.tools.find((t) => t.name === 'create_category');

    expect(tool).toBeDefined();
    expect(tool!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  test('handleCallTool rejects write tool when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('set_transaction_category', {
      transaction_id: 'txn1',
      category_id: 'food',
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleCallTool rejects set_transaction_note when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('set_transaction_note', {
      transaction_id: 'txn1',
      note: 'test',
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleCallTool rejects create_tag when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('create_tag', { name: 'test' });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleCallTool rejects delete_tag when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('delete_tag', { tag_id: 'test' });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleCallTool rejects create_category when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('create_category', {
      name: 'Test',
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleCallTool rejects set_transaction_excluded when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('set_transaction_excluded', {
      transaction_id: 'txn1',
      excluded: true,
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleCallTool rejects set_transaction_name when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('set_transaction_name', {
      transaction_id: 'txn1',
      name: 'New Name',
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleCallTool rejects set_internal_transfer when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('set_internal_transfer', {
      transaction_id: 'txn1',
      internal_transfer: true,
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleCallTool rejects set_transaction_goal when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('set_transaction_goal', {
      transaction_id: 'txn1',
      goal_id: 'goal1',
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleCallTool rejects update_category when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('update_category', {
      category_id: 'test',
      name: 'New Name',
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleCallTool rejects delete_category when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('delete_category', { category_id: 'test' });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleCallTool rejects create_budget when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('create_budget', {
      category_id: 'food',
      amount: 500,
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleCallTool rejects update_budget when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('update_budget', {
      budget_id: 'budget_123',
      amount: 600,
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleCallTool rejects delete_budget when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('delete_budget', { budget_id: 'budget_123' });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleCallTool rejects set_recurring_state when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('set_recurring_state', {
      recurring_id: 'rec_123',
      state: 'paused',
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleCallTool rejects delete_recurring when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('delete_recurring', { recurring_id: 'rec_123' });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleCallTool rejects update_goal when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('update_goal', {
      goal_id: 'goal_123',
      name: 'New Name',
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleCallTool rejects delete_goal when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('delete_goal', { goal_id: 'goal_123' });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });

  test('handleListTools includes create_category when writeEnabled', () => {
    const server = new CopilotMoneyServer(undefined, undefined, true);
    const result = server.handleListTools();
    const toolNames = result.tools.map((t) => t.name);

    expect(toolNames).toContain('create_category');
  });
});

describe('createWriteToolSchemas', () => {
  test('returns write tool schemas with proper annotations', () => {
    const schemas = createWriteToolSchemas();
    expect(schemas.length).toBeGreaterThanOrEqual(20);

    const setCat = schemas.find((s) => s.name === 'set_transaction_category');
    expect(setCat).toBeDefined();
    expect(setCat!.annotations?.readOnlyHint).toBe(false);
    expect(setCat!.inputSchema.required).toContain('transaction_id');
    expect(setCat!.inputSchema.required).toContain('category_id');

    const setNote = schemas.find((s) => s.name === 'set_transaction_note');
    expect(setNote).toBeDefined();
    expect(setNote!.annotations?.readOnlyHint).toBe(false);
    expect(setNote!.annotations?.idempotentHint).toBe(true);
    expect(setNote!.inputSchema.required).toContain('transaction_id');
    expect(setNote!.inputSchema.required).toContain('note');
  });

  test('create_tag schema requires name', () => {
    const schemas = createWriteToolSchemas();
    const createTag = schemas.find((s) => s.name === 'create_tag');
    expect(createTag).toBeDefined();
    expect(createTag!.inputSchema.required).toEqual(['name']);
    expect(createTag!.inputSchema.properties).toHaveProperty('name');
    expect(createTag!.inputSchema.properties).toHaveProperty('color_name');
    expect(createTag!.inputSchema.properties).toHaveProperty('hex_color');
  });

  test('delete_tag schema requires tag_id', () => {
    const schemas = createWriteToolSchemas();
    const deleteTag = schemas.find((s) => s.name === 'delete_tag');
    expect(deleteTag).toBeDefined();
    expect(deleteTag!.inputSchema.required).toEqual(['tag_id']);
    expect(deleteTag!.inputSchema.properties).toHaveProperty('tag_id');
  });

  test('includes create_category schema', () => {
    const schemas = createWriteToolSchemas();
    const createCat = schemas.find((s) => s.name === 'create_category');
    expect(createCat).toBeDefined();
    expect(createCat!.annotations?.readOnlyHint).toBe(false);
    expect(createCat!.annotations?.idempotentHint).toBe(false);
    expect(createCat!.inputSchema.required).toEqual(['name']);
  });
});
