import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../src/core/graphql/client.js';

/**
 * A synthetic cache path, so the harness never discovers the user's real
 * Copilot container from inside `bun test` (#756). Nothing here reads the cache.
 */
const SYNTHETIC_DB_PATH = '/nonexistent/copilot-money-mcp/smoke-harness.test';

describe('setupLiveSmoke', () => {
  test('assembles auth + client + live db and runs preflight', async () => {
    const fakeClient = {
      query: mock(() =>
        Promise.resolve({
          transactions: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
        })
      ),
    } as unknown as GraphQLClient;

    const { setupLiveSmoke } = await import('../../scripts/smoke/_harness.js');
    const ctx = await setupLiveSmoke({
      verbose: false,
      injectedClient: fakeClient,
      dbPath: SYNTHETIC_DB_PATH,
    });

    expect(ctx.live).toBeDefined();
    expect(ctx.graphql).toBe(fakeClient);
    expect(typeof ctx.log).toBe('function');
    expect(fakeClient.query).toHaveBeenCalledTimes(1); // preflight
  });

  test('throws clear message when preflight fails', async () => {
    const failingClient = {
      query: mock(() => Promise.reject(new Error('UNAUTHENTICATED'))),
    } as unknown as GraphQLClient;

    const { setupLiveSmoke } = await import('../../scripts/smoke/_harness.js');
    await expect(
      setupLiveSmoke({
        verbose: false,
        injectedClient: failingClient,
        dbPath: SYNTHETIC_DB_PATH,
      })
    ).rejects.toThrow('UNAUTHENTICATED');
  });
});
