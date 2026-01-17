/**
 * Tests for hard-to-cover code paths:
 * - Signal handlers in server.ts
 * - Timer callbacks in leveldb-reader.ts
 * - MCP request handler callbacks
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn, jest } from 'bun:test';
import { CopilotMoneyServer } from '../../src/server.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import {
  iterateDocuments,
  createTestDatabase,
  cleanupAllTempDatabases,
  _runScheduledCleanup,
  _getTempDbCache,
} from '../../src/core/leveldb-reader.js';
import type { Transaction, Account } from '../../src/models/index.js';
import path from 'node:path';
import fs from 'node:fs';

// Mock data for testing
const mockTransactions: Transaction[] = [
  {
    transaction_id: 'txn1',
    amount: 50.0,
    date: '2025-01-15',
    name: 'Coffee Shop',
    category_id: 'food_dining',
    account_id: 'acc1',
  },
];

const mockAccounts: Account[] = [
  {
    account_id: 'acc1',
    current_balance: 1500.0,
    name: 'Checking Account',
    account_type: 'checking',
  },
];

/**
 * Helper to set up a server with mock data.
 */
function setupServerWithMockData(): CopilotMoneyServer {
  const server = new CopilotMoneyServer('/fake/path');

  const db = new CopilotDatabase('/fake/path');
  (db as any)._transactions = [...mockTransactions];
  (db as any)._accounts = [...mockAccounts];
  (db as any)._userCategories = [];
  (db as any)._userAccounts = [];
  (db as any)._categoryNameMap = new Map<string, string>();
  (db as any)._accountNameMap = new Map<string, string>();
  (db as any)._recurring = [];
  (db as any)._budgets = [];
  (db as any)._goals = [];
  (db as any)._goalHistory = [];
  (db as any)._investmentPrices = [];
  (db as any)._investmentSplits = [];
  (db as any)._items = [];
  db.isAvailable = () => true;

  server._injectForTesting(db, new CopilotMoneyTools(db));

  return server;
}

describe('server.ts - MCP Request Handler Coverage', () => {
  /**
   * Test the CallToolRequestSchema handler callback (lines 359-360).
   *
   * The handler extracts name and arguments from request.params and calls handleCallTool.
   * We test this by accessing the internal server's request handlers map.
   *
   * The MCP SDK stores handlers in a Map keyed by method name (e.g., 'tools/call').
   */
  test('CallToolRequestSchema handler extracts params correctly', async () => {
    const server = setupServerWithMockData();

    // Access the internal MCP server
    const mcpServer = (server as any).server;

    // Get the registered request handlers - the SDK stores them by method name
    const requestHandlers = (mcpServer as any)._requestHandlers as Map<
      string,
      (request: any, extra: any) => Promise<any>
    >;

    // The handler is stored under 'tools/call' method name
    const callToolHandler = requestHandlers?.get('tools/call');

    expect(callToolHandler).toBeDefined();

    if (callToolHandler) {
      // Simulate a request with the expected structure
      const mockRequest = {
        method: 'tools/call',
        params: {
          name: 'get_transactions',
          arguments: { limit: 5 },
        },
      };

      const result = await callToolHandler(mockRequest, {});

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      // Should not have isError since get_transactions is valid
      expect(result.isError).toBeUndefined();
    }
  });

  test('CallToolRequestSchema handler handles unknown tool', async () => {
    const server = setupServerWithMockData();
    const mcpServer = (server as any).server;
    const requestHandlers = (mcpServer as any)._requestHandlers as Map<
      string,
      (request: any, extra: any) => Promise<any>
    >;

    const callToolHandler = requestHandlers?.get('tools/call');
    expect(callToolHandler).toBeDefined();

    if (callToolHandler) {
      const mockRequest = {
        method: 'tools/call',
        params: {
          name: 'nonexistent_tool',
          arguments: {},
        },
      };

      const result = await callToolHandler(mockRequest, {});

      expect(result).toBeDefined();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    }
  });

  test('CallToolRequestSchema handler passes arguments to handleCallTool', async () => {
    const server = setupServerWithMockData();
    const mcpServer = (server as any).server;
    const requestHandlers = (mcpServer as any)._requestHandlers as Map<
      string,
      (request: any, extra: any) => Promise<any>
    >;

    const callToolHandler = requestHandlers?.get('tools/call');
    expect(callToolHandler).toBeDefined();

    if (callToolHandler) {
      // Test with specific arguments that affect output
      const mockRequest = {
        method: 'tools/call',
        params: {
          name: 'get_spending',
          arguments: { group_by: 'category' },
        },
      };

      const result = await callToolHandler(mockRequest, {});

      expect(result).toBeDefined();
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.group_by).toBe('category');
    }
  });
});

describe('server.ts - Signal Handler Coverage', () => {
  let originalProcessOn: typeof process.on;
  let signalHandlers: Map<string, () => void>;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Store original process.on
    originalProcessOn = process.on.bind(process);

    // Create a map to capture signal handlers
    signalHandlers = new Map();

    // Mock process.on to capture handlers
    (process as any).on = (signal: string, handler: () => void) => {
      if (signal === 'SIGINT' || signal === 'SIGTERM') {
        signalHandlers.set(signal, handler);
      }
      return process;
    };

    // Mock process.exit
    exitSpy = spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    // Restore original process.on
    (process as any).on = originalProcessOn;
    exitSpy.mockRestore();
  });

  test('SIGINT handler calls server.close and process.exit', async () => {
    const server = setupServerWithMockData();
    const mcpServer = (server as any).server;

    // Mock the server.close method
    let closeWasCalled = false;
    mcpServer.close = mock(() => {
      closeWasCalled = true;
      return Promise.resolve();
    });

    // Mock the connect method to avoid stdio issues
    mcpServer.connect = mock(() => Promise.resolve());

    // Call run to register the signal handlers
    await server.run();

    // Get the SIGINT handler
    const sigintHandler = signalHandlers.get('SIGINT');
    expect(sigintHandler).toBeDefined();

    // Invoke the SIGINT handler
    if (sigintHandler) {
      sigintHandler();

      // Wait for the async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(closeWasCalled).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(0);
    }
  });

  test('SIGTERM handler calls server.close and process.exit', async () => {
    const server = setupServerWithMockData();
    const mcpServer = (server as any).server;

    // Mock the server.close method
    let closeWasCalled = false;
    mcpServer.close = mock(() => {
      closeWasCalled = true;
      return Promise.resolve();
    });

    // Mock the connect method to avoid stdio issues
    mcpServer.connect = mock(() => Promise.resolve());

    // Call run to register the signal handlers
    await server.run();

    // Get the SIGTERM handler
    const sigtermHandler = signalHandlers.get('SIGTERM');
    expect(sigtermHandler).toBeDefined();

    // Invoke the SIGTERM handler
    if (sigtermHandler) {
      sigtermHandler();

      // Wait for the async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(closeWasCalled).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(0);
    }
  });
});

// TTL for temp database cache (must match the value in leveldb-reader.ts)
const TEMP_DB_CACHE_TTL = 5 * 60 * 1000;
const FIXTURES_DIR = path.join(__dirname, '../fixtures/timer-coverage-tests');

describe('leveldb-reader.ts - Timer Callback Coverage', () => {
  beforeEach(() => {
    // Ensure fixtures directory exists
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  });

  afterEach(() => {
    // Restore real timers if fake timers were used
    jest.useRealTimers();

    // Cleanup temp databases
    cleanupAllTempDatabases();

    // Clean up fixtures
    if (fs.existsSync(FIXTURES_DIR)) {
      fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
    }
  });

  test('scheduledCleanupCallback cleans up entry after TTL', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'cleanup-callback-test-db');

    // Create a test database
    await createTestDatabase(dbPath, [{ collection: 'test', id: 'doc1', fields: { value: 1 } }]);

    // Iterate through the database (this creates a temp copy and releases it)
    const docs = [];
    for await (const doc of iterateDocuments(dbPath)) {
      docs.push(doc);
    }
    expect(docs.length).toBe(1);

    // The cache should have an entry now
    const cache = _getTempDbCache();
    expect(cache.has(dbPath)).toBe(true);

    // Run the scheduled cleanup callback directly
    // This bypasses the setTimeout and tests the callback logic
    _runScheduledCleanup(dbPath);

    // After cleanup, the entry should be removed
    expect(cache.has(dbPath)).toBe(false);
  });

  test('scheduledCleanupCallback does not clean up when entry is missing', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'missing-entry-test-db');

    // Run cleanup on a non-existent path - should not throw
    _runScheduledCleanup(dbPath);

    // No error should occur
    expect(true).toBe(true);
  });

  test('scheduledCleanupCallback does not clean up when refCount > 0', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'refcount-positive-test-db');

    // Create a test database
    await createTestDatabase(dbPath, [{ collection: 'test', id: 'doc1', fields: { value: 1 } }]);

    // Start iterating but don't finish (simulated by manually adding to cache)
    const docs = [];
    for await (const doc of iterateDocuments(dbPath)) {
      docs.push(doc);
    }
    expect(docs.length).toBe(1);

    // Manually increment refCount to simulate an active reference
    const cache = _getTempDbCache();
    const entry = cache.get(dbPath);
    if (entry) {
      entry.refCount = 1; // Simulate active reference
    }

    // Run cleanup - should NOT clean up because refCount > 0
    _runScheduledCleanup(dbPath);

    // Entry should still exist
    expect(cache.has(dbPath)).toBe(true);

    // Reset refCount for proper cleanup in afterEach
    if (entry) {
      entry.refCount = 0;
    }
  });

  test('scheduledCleanupCallback does not clean up before TTL', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'ttl-not-elapsed-test-db');

    // Create a test database
    await createTestDatabase(dbPath, [{ collection: 'test', id: 'doc1', fields: { value: 1 } }]);

    // Iterate through the database
    const docs = [];
    for await (const doc of iterateDocuments(dbPath)) {
      docs.push(doc);
    }
    expect(docs.length).toBe(1);

    // The cache should have an entry
    const cache = _getTempDbCache();
    expect(cache.has(dbPath)).toBe(true);

    // Run cleanup with a recent scheduledTime (not enough time elapsed)
    // This simulates the case where the timer fires but not enough real time has passed
    _runScheduledCleanup(dbPath, Date.now());

    // Entry should still exist because TTL hasn't elapsed
    expect(cache.has(dbPath)).toBe(true);
  });

  test('scheduledCleanupCallback cleans up temp directory', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'temp-cleanup-test-db');

    // Create a test database
    await createTestDatabase(dbPath, [{ collection: 'test', id: 'doc1', fields: { value: 1 } }]);

    // Iterate through the database
    const docs = [];
    for await (const doc of iterateDocuments(dbPath)) {
      docs.push(doc);
    }
    expect(docs.length).toBe(1);

    // Get the temp path before cleanup
    const cache = _getTempDbCache();
    const entry = cache.get(dbPath);
    const tempPath = entry?.tempPath;

    // The temp directory should exist
    expect(tempPath).toBeDefined();
    if (tempPath) {
      expect(fs.existsSync(tempPath)).toBe(true);
    }

    // Run cleanup
    _runScheduledCleanup(dbPath);

    // The temp directory should be removed
    if (tempPath) {
      expect(fs.existsSync(tempPath)).toBe(false);
    }
  });
});
