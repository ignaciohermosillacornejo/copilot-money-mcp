import { describe, test, expect, mock } from 'bun:test';
import { LiveCopilotDatabase, preflightLiveAuth } from '../../src/core/live-database.js';
import { GraphQLError } from '../../src/core/graphql/client.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import type { CopilotDatabase } from '../../src/core/database.js';
import type { TransactionsPage } from '../../src/core/graphql/queries/transactions.js';
import { SnapshotCache, TransactionWindowCache } from '../../src/core/cache/index.js';
import type { Tag, Category, Budget, Recurring } from '../../src/models/index.js';

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
    expect(a.result).toEqual({ value: 1 });
    expect(b.result).toEqual({ value: 1 });
    expect(calls).toBe(1);
  });

  test('hit=false on first call, hit=true on second call within TTL', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache(), { memoTtlMs: 60_000 });
    const loader = async () => 42;
    const a = await live.memoize('key-hit', loader);
    const b = await live.memoize('key-hit', loader);
    expect(a.hit).toBe(false);
    expect(b.hit).toBe(true);
  });

  test('fetched_at is stable across cache hits', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache(), { memoTtlMs: 60_000 });
    const loader = async () => 'x';
    const a = await live.memoize('key-ts', loader);
    const b = await live.memoize('key-ts', loader);
    expect(b.fetched_at).toBe(a.fetched_at);
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
    expect(b.result).toBe(2);
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
    const { rows } = await live.getTransactions({});
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

    const { rows } = await live.getTransactions({});
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

// ── Cache accessor smoke tests ──────────────────────────────────────────────

describe('LiveCopilotDatabase — cache accessors', () => {
  function mkLive() {
    return new LiveCopilotDatabase(mkClient(), mkCache());
  }

  test('getAccountsCache returns a SnapshotCache instance', () => {
    expect(mkLive().getAccountsCache()).toBeInstanceOf(SnapshotCache);
  });

  test('getCategoriesCache returns a SnapshotCache instance', () => {
    expect(mkLive().getCategoriesCache()).toBeInstanceOf(SnapshotCache);
  });

  test('getTagsCache returns a SnapshotCache instance', () => {
    expect(mkLive().getTagsCache()).toBeInstanceOf(SnapshotCache);
  });

  test('getBudgetsCache returns a SnapshotCache instance', () => {
    expect(mkLive().getBudgetsCache()).toBeInstanceOf(SnapshotCache);
  });

  test('getRecurringCache returns a SnapshotCache instance', () => {
    expect(mkLive().getRecurringCache()).toBeInstanceOf(SnapshotCache);
  });

  test('getTransactionsWindowCache returns a TransactionWindowCache instance', () => {
    expect(mkLive().getTransactionsWindowCache()).toBeInstanceOf(TransactionWindowCache);
  });

  test('each call returns the same instance (not a new one)', () => {
    const live = mkLive();
    expect(live.getTagsCache()).toBe(live.getTagsCache());
    expect(live.getTransactionsWindowCache()).toBe(live.getTransactionsWindowCache());
  });
});

// ── patchLiveTransaction ────────────────────────────────────────────────────

describe('LiveCopilotDatabase.patchLiveTransaction', () => {
  function mkLive() {
    return new LiveCopilotDatabase(mkClient(), mkCache());
  }

  test('updates matching row in cached month', () => {
    const live = mkLive();
    const wc = live.getTransactionsWindowCache();
    // Seed a warm/cold month (2024-01) with one row.
    wc.ingestMonth('2024-01', [{ id: 'tx1', date: '2024-01-15', name: 'Old' }], Date.now());

    live.patchLiveTransaction('tx1', { name: 'New' } as Record<string, unknown>);

    const rows = wc.entriesForMonth('2024-01');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('New');
    expect(rows[0]!.id).toBe('tx1');
  });

  test('no-op when transaction id is not cached', () => {
    const live = mkLive();
    const wc = live.getTransactionsWindowCache();
    wc.ingestMonth('2024-01', [{ id: 'tx1', date: '2024-01-15' }], Date.now());

    // Should not throw; cache unchanged
    live.patchLiveTransaction('missing', { name: 'Ghost' } as Record<string, unknown>);

    expect(wc.entriesForMonth('2024-01')).toHaveLength(1);
  });

  test('no-op when cache is empty', () => {
    const live = mkLive();
    // No error thrown
    live.patchLiveTransaction('tx99', { name: 'X' } as Record<string, unknown>);
  });

  test('id field is preserved from the patch argument', () => {
    const live = mkLive();
    const wc = live.getTransactionsWindowCache();
    wc.ingestMonth('2024-01', [{ id: 'tx1', date: '2024-01-10' }], Date.now());

    live.patchLiveTransaction('tx1', { id: 'should-be-ignored', name: 'Z' } as Record<
      string,
      unknown
    >);

    expect(wc.entriesForMonth('2024-01')[0]!.id).toBe('tx1');
  });
});

// ── patchLiveTransactionDelete ──────────────────────────────────────────────

describe('LiveCopilotDatabase.patchLiveTransactionDelete', () => {
  test('removes matching row from cached month', () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    const wc = live.getTransactionsWindowCache();
    wc.ingestMonth('2024-02', [{ id: 'tx2', date: '2024-02-01' }], Date.now());

    live.patchLiveTransactionDelete('tx2');

    expect(wc.entriesForMonth('2024-02')).toHaveLength(0);
  });

  test('no-op when id not found', () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    const wc = live.getTransactionsWindowCache();
    wc.ingestMonth('2024-02', [{ id: 'tx2', date: '2024-02-01' }], Date.now());

    live.patchLiveTransactionDelete('unknown');

    expect(wc.entriesForMonth('2024-02')).toHaveLength(1);
  });
});

// ── patchLiveBudget ─────────────────────────────────────────────────────────

describe('LiveCopilotDatabase.patchLiveBudget', () => {
  async function seedAndRead(live: LiveCopilotDatabase): Promise<Budget[]> {
    // Seed cache so upsert has somewhere to write.
    return (await live.getBudgetsCache().read(async () => [])).rows;
  }

  test('upserts synthetic budget into cache by category_id', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    await seedAndRead(live);

    live.patchLiveBudget('cat-42', 500, '2025-03');

    const result = await live.getBudgetsCache().read(async () => []);
    expect(result.rows).toHaveLength(1);
    const b = result.rows[0]!;
    expect(b.category_id).toBe('cat-42');
    expect(b.amounts?.['2025-03']).toBe(500);
  });

  test('defaults month to current YYYY-MM', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    await seedAndRead(live);

    live.patchLiveBudget('cat-1', 100);

    const result = await live.getBudgetsCache().read(async () => []);
    const b = result.rows[0]!;
    const now = new Date();
    const expectedMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    expect(Object.keys(b.amounts ?? {})[0]).toBe(expectedMonth);
  });

  test('updates existing budget by category_id', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    // Seed with an existing budget for the same category.
    await live
      .getBudgetsCache()
      .read(async () => [{ budget_id: 'b1', category_id: 'cat-5', amounts: { '2025-01': 200 } }]);

    live.patchLiveBudget('cat-5', 999, '2025-02');

    const result = await live.getBudgetsCache().read(async () => []);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.amounts?.['2025-02']).toBe(999);
  });
});

// ── patchLiveTagUpsert / patchLiveTagDelete ─────────────────────────────────

describe('LiveCopilotDatabase — tag cache patches', () => {
  async function mkSeeded() {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    await live.getTagsCache().read(async () => []);
    return live;
  }

  test('patchLiveTagUpsert inserts a new tag', async () => {
    const live = await mkSeeded();
    const tag: Tag = { tag_id: 't1', name: 'Vacation' };
    live.patchLiveTagUpsert(tag);
    const result = await live.getTagsCache().read(async () => []);
    expect(result.rows.find((t) => t.tag_id === 't1')?.name).toBe('Vacation');
  });

  test('patchLiveTagUpsert updates existing tag', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    await live.getTagsCache().read(async () => [{ tag_id: 't1', name: 'Old' }]);
    live.patchLiveTagUpsert({ tag_id: 't1', name: 'Updated' });
    const result = await live.getTagsCache().read(async () => []);
    expect(result.rows.find((t) => t.tag_id === 't1')?.name).toBe('Updated');
  });

  test('patchLiveTagDelete removes tag by id', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    await live.getTagsCache().read(async () => [{ tag_id: 't1' }, { tag_id: 't2' }]);
    live.patchLiveTagDelete('t1');
    const result = await live.getTagsCache().read(async () => []);
    expect(result.rows.map((t) => t.tag_id)).toEqual(['t2']);
  });
});

// ── patchLiveCategoryUpsert / patchLiveCategoryDelete ──────────────────────

describe('LiveCopilotDatabase — category cache patches', () => {
  test('patchLiveCategoryUpsert inserts a new category', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    await live.getCategoriesCache().read(async () => []);
    const cat: Category = { category_id: 'c1', name: 'Dining' };
    live.patchLiveCategoryUpsert(cat);
    const result = await live.getCategoriesCache().read(async () => []);
    expect(result.rows.find((c) => c.category_id === 'c1')?.name).toBe('Dining');
  });

  test('patchLiveCategoryDelete removes category by id', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    await live.getCategoriesCache().read(async () => [
      { category_id: 'c1', name: 'Dining' },
      { category_id: 'c2', name: 'Travel' },
    ]);
    live.patchLiveCategoryDelete('c1');
    const result = await live.getCategoriesCache().read(async () => []);
    expect(result.rows.map((c) => c.category_id)).toEqual(['c2']);
  });
});

// ── patchLiveRecurringUpsert / patchLiveRecurringDelete ────────────────────

describe('LiveCopilotDatabase — recurring cache patches', () => {
  test('patchLiveRecurringUpsert inserts a new recurring item', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    await live.getRecurringCache().read(async () => []);
    const rec: Recurring = { recurring_id: 'r1', name: 'Netflix' };
    live.patchLiveRecurringUpsert(rec);
    const result = await live.getRecurringCache().read(async () => []);
    expect(result.rows.find((r) => r.recurring_id === 'r1')?.name).toBe('Netflix');
  });

  test('patchLiveRecurringDelete removes recurring item by id', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    await live.getRecurringCache().read(async () => [
      { recurring_id: 'r1', name: 'Netflix' },
      { recurring_id: 'r2', name: 'Spotify' },
    ]);
    live.patchLiveRecurringDelete('r1');
    const result = await live.getRecurringCache().read(async () => []);
    expect(result.rows.map((r) => r.recurring_id)).toEqual(['r2']);
  });
});

// ── logReadCall structured fields ──────────────────────────────────────────

describe('LiveCopilotDatabase — logReadCall', () => {
  test('logReadCall with structured fields emits ttl_tier and cache_hit', () => {
    const lines: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const live = new LiveCopilotDatabase({} as GraphQLClient, {} as CopilotDatabase, {
        verbose: true,
      });
      live.logReadCall({
        op: 'Accounts',
        pages: 1,
        latencyMs: 320,
        rows: 12,
        ttl_tier: 'cold',
        cache_hit: false,
      });
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('op=Accounts');
      expect(lines[0]).toContain('ttl_tier=cold');
      expect(lines[0]).toContain('cache_hit=false');
      expect(lines[0]).toContain('pages=1');
      expect(lines[0]).toContain('latency=320ms');
      expect(lines[0]).toContain('rows=12');
    } finally {
      console.error = origError;
    }
  });

  test('logReadCall is silent when verbose is off', () => {
    const lines: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const live = new LiveCopilotDatabase({} as GraphQLClient, {} as CopilotDatabase, {
        verbose: false,
      });
      live.logReadCall({ op: 'Transactions', pages: 1, latencyMs: 100, rows: 0, cache_hit: true });
      expect(lines.length).toBe(0);
    } finally {
      console.error = origError;
    }
  });

  test('logReadCall optional fields (month, staleness_ms) appear when set', () => {
    const lines: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const live = new LiveCopilotDatabase({} as GraphQLClient, {} as CopilotDatabase, {
        verbose: true,
      });
      live.logReadCall({
        op: 'Transactions',
        pages: 8,
        latencyMs: 2810,
        rows: 210,
        ttl_tier: 'cold',
        cache_hit: false,
        month: '2026-03',
        staleness_ms: null,
      });
      expect(lines[0]).toContain('month=2026-03');
      expect(lines[0]).toContain('staleness_ms=null');
    } finally {
      console.error = origError;
    }
  });
});
