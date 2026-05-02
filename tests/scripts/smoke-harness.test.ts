import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../src/core/graphql/client.js';

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
    const ctx = await setupLiveSmoke({ verbose: false, injectedClient: fakeClient });

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
    await expect(setupLiveSmoke({ verbose: false, injectedClient: failingClient })).rejects.toThrow(
      'UNAUTHENTICATED'
    );
  });
});
