import { describe, test, expect, mock } from 'bun:test';
import { LiveCopilotDatabase, preflightLiveAuth } from '../../src/core/live-database.js';
import { GraphQLError } from '../../src/core/graphql/client.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import type { CopilotDatabase } from '../../src/core/database.js';
import type { TransactionsPage } from '../../src/core/graphql/queries/transactions.js';

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

function mkClientReturning(pages: TransactionsPage[]): GraphQLClient {
  let i = 0;
  return {
    mutate: mock(),
    query: mock(() => Promise.resolve({ transactions: pages[i++] })),
  } as unknown as GraphQLClient;
}

describe('LiveCopilotDatabase.getTransactions', () => {
  test('paginates through one page and returns rows', async () => {
    const client = mkClientReturning([
      {
        edges: [
          {
            cursor: 'c1',
            node: {
              id: 't1',
              accountId: 'a1',
              itemId: 'i1',
              categoryId: 'c',
              recurringId: null,
              parentId: null,
              isReviewed: false,
              isPending: false,
              amount: 10,
              date: '2025-06-01',
              name: 'Amazon',
              type: 'REGULAR',
              userNotes: null,
              tipAmount: null,
              suggestedCategoryIds: [],
              isoCurrencyCode: 'USD',
              createdAt: 0,
              tags: [],
              goal: null,
            },
          },
        ],
        pageInfo: { endCursor: 'c1', hasNextPage: false },
      },
    ]);
    const live = new LiveCopilotDatabase(client, mkCache());
    const rows = await live.getTransactions({});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('t1');
  });

  test('memoizes identical calls within TTL', async () => {
    const page: TransactionsPage = {
      edges: [],
      pageInfo: { endCursor: null, hasNextPage: false },
    };
    const client = mkClientReturning([page]);
    const live = new LiveCopilotDatabase(client, mkCache());

    await live.getTransactions({ startDate: '2025-01-01' });
    await live.getTransactions({ startDate: '2025-01-01' });

    const qCalls = (client.query as ReturnType<typeof mock>).mock.calls;
    expect(qCalls).toHaveLength(1);
  });

  test('retries once on NETWORK error per page', async () => {
    let calls = 0;
    const page: TransactionsPage = {
      edges: [],
      pageInfo: { endCursor: null, hasNextPage: false },
    };
    const client = {
      mutate: mock(),
      query: mock(() => {
        calls += 1;
        if (calls === 1) throw new GraphQLError('NETWORK', 'blip', 'Transactions');
        return Promise.resolve({ transactions: page });
      }),
    } as unknown as GraphQLClient;
    const live = new LiveCopilotDatabase(client, mkCache());

    const rows = await live.getTransactions({});
    expect(rows).toHaveLength(0);
    expect(calls).toBe(2);
  });
});

describe('preflightLiveAuth', () => {
  test('resolves when probe returns a page', async () => {
    const client = {
      mutate: mock(),
      query: mock(() =>
        Promise.resolve({
          transactions: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } },
        })
      ),
    } as unknown as GraphQLClient;
    await expect(preflightLiveAuth(client)).resolves.toBeUndefined();
  });

  test('rejects with NETWORK code preserved', async () => {
    const client = {
      mutate: mock(),
      query: mock(() => Promise.reject(new GraphQLError('NETWORK', 'down', 'Transactions'))),
    } as unknown as GraphQLClient;
    await expect(preflightLiveAuth(client)).rejects.toMatchObject({ code: 'NETWORK' });
  });

  test('rejects with AUTH_FAILED when token rejected', async () => {
    const client = {
      mutate: mock(),
      query: mock(() => Promise.reject(new GraphQLError('AUTH_FAILED', '401', 'Transactions'))),
    } as unknown as GraphQLClient;
    await expect(preflightLiveAuth(client)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });
});
