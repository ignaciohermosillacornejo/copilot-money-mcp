import { describe, test, expect, mock } from 'bun:test';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { GraphQLError } from '../../src/core/graphql/client.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import type { CopilotDatabase } from '../../src/core/database.js';

function mkClient(): GraphQLClient {
  return { mutate: mock(), query: mock() } as unknown as GraphQLClient;
}
function mkCache(): CopilotDatabase {
  return { getAccounts: mock() } as unknown as CopilotDatabase;
}

describe('LiveCopilotDatabase — withRetry', () => {
  test('succeeds on first try without retry', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    let calls = 0;
    const result = await live.withRetry(async () => {
      calls += 1;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  test('retries once on NETWORK error and succeeds', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    let calls = 0;
    const result = await live.withRetry(async () => {
      calls += 1;
      if (calls === 1) throw new GraphQLError('NETWORK', 'boom', 'Op');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  test('does not retry on AUTH_FAILED', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    let calls = 0;
    await expect(
      live.withRetry(async () => {
        calls += 1;
        throw new GraphQLError('AUTH_FAILED', '401', 'Op');
      })
    ).rejects.toThrow('401');
    expect(calls).toBe(1);
  });

  test('surfaces error after second NETWORK failure', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    let calls = 0;
    await expect(
      live.withRetry(async () => {
        calls += 1;
        throw new GraphQLError('NETWORK', 'still broken', 'Op');
      })
    ).rejects.toThrow('still broken');
    expect(calls).toBe(2);
  });
});

describe('LiveCopilotDatabase — memo', () => {
  test('returns cached value within TTL', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache(), { memoTtlMs: 60_000 });
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { value: calls };
    };
    const a = await live.memoize('key-1', loader);
    const b = await live.memoize('key-1', loader);
    expect(a).toEqual({ value: 1 });
    expect(b).toEqual({ value: 1 });
    expect(calls).toBe(1);
  });

  test('re-loads after TTL expires', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache(), { memoTtlMs: 1 });
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return calls;
    };
    await live.memoize('k', loader);
    await new Promise((r) => setTimeout(r, 5));
    await live.memoize('k', loader);
    expect(calls).toBe(2);
  });

  test('distinguishes different keys', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    await live.memoize('a', async () => 1);
    const b = await live.memoize('b', async () => 2);
    expect(b).toBe(2);
  });
});
