import { describe, test, expect, mock } from 'bun:test';
import { CopilotMoneyServer } from '../../src/server.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';

describe('CopilotMoneyServer with --live-reads', () => {
  test('swaps get_transactions for get_transactions_live in handleListTools', () => {
    const mockClient = {
      mutate: mock(),
      query: mock(() =>
        Promise.resolve({
          transactions: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } },
        })
      ),
    } as unknown as GraphQLClient;

    const server = new CopilotMoneyServer(undefined, undefined, false, true, mockClient);
    const { tools } = server.handleListTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('get_transactions_live');
    expect(names).not.toContain('get_transactions');
  });

  test('registers get_transactions (not _live) when --live-reads is off', () => {
    const server = new CopilotMoneyServer();
    const { tools } = server.handleListTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('get_transactions');
    expect(names).not.toContain('get_transactions_live');
  });

  test('handleCallTool returns isError when live tool not registered', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('get_transactions_live', {});
    expect(result.isError).toBe(true);
  });
});
