/**
 * Unit tests for the MCP server implementation.
 */

import { describe, test, expect } from 'bun:test';
import { CopilotMoneyServer } from '../../src/server.js';

describe('CopilotMoneyServer', () => {
  test('initializes with valid database path', () => {
    // Use a fake path - server should initialize even if DB doesn't exist
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
    // Should use default Copilot Money location
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
});
