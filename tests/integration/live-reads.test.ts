import { describe, test, expect, mock } from 'bun:test';
import { CopilotMoneyServer } from '../../src/server.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import { LIVE_TOOL_DEFS, WRITE_TOOL_DEFS } from '../../src/tools/registry/index.js';

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

// #640: the db.isAvailable() gate must be scoped to tools whose dispatch
// actually reads the local LevelDB cache. Live tools run entirely on GraphQL,
// and live-mode writes resolve live-first (the cache is only touched via
// null-guarded patchCached* write-through) — so on a machine without the
// native Copilot app, both must dispatch past the gate.
describe('db gate scoping without local cache (#640)', () => {
  const NO_CACHE_PATH = '/nonexistent/no-native-app-installed';
  const DB_GATE_MESSAGE = 'Database not available';

  function firstText(result: { content: { text?: string }[] }): string {
    return result.content[0]?.text ?? '';
  }

  function liveServer(): CopilotMoneyServer {
    const mockClient = {
      mutate: mock(() => Promise.resolve({})),
      query: mock(() => Promise.resolve({ accounts: [] })),
    } as unknown as GraphQLClient;
    return new CopilotMoneyServer(NO_CACHE_PATH, undefined, true, true, mockClient);
  }

  test('get_accounts_live succeeds end-to-end with no local cache', async () => {
    const result = await liveServer().handleCallTool('get_accounts_live', {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(firstText(result)) as { count: number };
    expect(parsed.count).toBe(0);
  });

  test('no live tool is blocked by the db gate (class detector)', async () => {
    const server = liveServer();
    for (const def of LIVE_TOOL_DEFS) {
      const result = await server.handleCallTool(def.name, {});
      // Handlers may reject the stub client's response shape — that's fine;
      // the invariant is that the db gate never fires before dispatch.
      expect(firstText(result)).not.toContain(DB_GATE_MESSAGE);
    }
  });

  test('no write tool is blocked by the db gate in live mode (class detector)', async () => {
    const server = liveServer();
    for (const def of WRITE_TOOL_DEFS) {
      const result = await server.handleCallTool(def.name, {});
      expect(firstText(result)).not.toContain(DB_GATE_MESSAGE);
    }
  });

  test('cache-backed reads remain gated in live mode', async () => {
    const server = liveServer();
    for (const name of ['get_cache_info', 'get_transactions', 'get_goals']) {
      const result = await server.handleCallTool(name, {});
      expect(firstText(result)).toContain(DB_GATE_MESSAGE);
    }
  });

  test('write tools remain gated in degraded mode (no live layer)', async () => {
    const mockClient = { mutate: mock(), query: mock() } as unknown as GraphQLClient;
    const server = new CopilotMoneyServer(NO_CACHE_PATH, undefined, true, false, mockClient);
    const result = await server.handleCallTool('update_transaction', {
      transaction_id: 'txn1',
      category_id: 'cat1',
    });
    expect(firstText(result)).toContain(DB_GATE_MESSAGE);
  });

  test('unknown tool reports "Unknown tool", not the db gate', async () => {
    const server = new CopilotMoneyServer(NO_CACHE_PATH);
    const result = await server.handleCallTool('no_such_tool', {});
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('Unknown tool');
  });
});
