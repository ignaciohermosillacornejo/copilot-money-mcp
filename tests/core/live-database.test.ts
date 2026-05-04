import { describe, test, expect, mock } from 'bun:test';
import { LiveCopilotDatabase, preflightLiveAuth } from '../../src/core/live-database.js';
import { GraphQLError } from '../../src/core/graphql/client.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import type { CopilotDatabase } from '../../src/core/database.js';
import type { TransactionsPage } from '../../src/core/graphql/queries/transactions.js';
import { SnapshotCache, TransactionWindowCache } from '../../src/core/cache/index.js';
import type { Tag } from '../../src/models/index.js';
import type { CategoryNode } from '../../src/core/graphql/queries/categories.js';
import type { RecurringNode } from '../../src/core/graphql/queries/recurrings.js';
import type { UserNode } from '../../src/core/graphql/queries/user.js';

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

describe('LiveCopilotDatabase.getTransactions (windowed)', () => {
  function mkClientReturning(pages: TransactionsPage[]): GraphQLClient {
    let i = 0;
    return {
      mutate: mock(),
      query: mock(() => Promise.resolve({ transactions: pages[i++] })),
    } as unknown as GraphQLClient;
  }

  function mkPage(rows: Array<{ id: string; date: string; createdAt?: number }>): TransactionsPage {
    return {
      edges: rows.map((r) => ({
        cursor: `c-${r.id}`,
        node: {
          id: r.id,
          accountId: 'a1',
          itemId: 'i1',
          categoryId: 'c1',
          recurringId: null,
          parentId: null,
          isReviewed: false,
          isPending: false,
          amount: 10,
          date: r.date,
          name: `tx-${r.id}`,
          type: 'REGULAR',
          userNotes: null,
          tipAmount: null,
          suggestedCategoryIds: [],
          isoCurrencyCode: 'USD',
          createdAt: r.createdAt ?? 0,
          tags: [],
          goal: null,
        },
      })),
      pageInfo: { endCursor: null, hasNextPage: false },
    };
  }

  test('throws on missing or inverted range', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    await expect(live.getTransactions({ from: '', to: '2025-12-31' })).rejects.toThrow();
    await expect(live.getTransactions({ from: '2025-01-01', to: '' })).rejects.toThrow();
    await expect(live.getTransactions({ from: '2025-12-31', to: '2025-01-01' })).rejects.toThrow();
  });

  test('pure cache miss fetches every month and ingests', async () => {
    const client = mkClientReturning([
      mkPage([{ id: 't1', date: '2025-01-15' }]),
      mkPage([{ id: 't2', date: '2025-02-15' }]),
    ]);
    const live = new LiveCopilotDatabase(client, mkCache());
    const result = await live.getTransactions({ from: '2025-01-01', to: '2025-02-28' });
    expect(result.rows.map((r) => r.id).sort()).toEqual(['t1', 't2']);
    expect(result.hit).toBe(false);
    const wc = live.getTransactionsWindowCache();
    expect(wc.hasMonth('2025-01')).toBe(true);
    expect(wc.hasMonth('2025-02')).toBe(true);
  });

  test('pure cache hit returns cached rows with no network', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    const wc = live.getTransactionsWindowCache();
    const ts = Date.now();
    wc.ingestMonth(
      '2024-06',
      [
        {
          id: 't1',
          date: '2024-06-10',
          accountId: 'a1',
          itemId: 'i1',
          categoryId: null,
          recurringId: null,
          parentId: null,
          isReviewed: false,
          isPending: false,
          amount: 10,
          name: 'cached',
          type: 'REGULAR',
          userNotes: null,
          tipAmount: null,
          suggestedCategoryIds: [],
          isoCurrencyCode: 'USD',
          createdAt: 0,
          tags: [],
          goal: null,
        },
      ],
      ts
    );

    const result = await live.getTransactions({ from: '2024-06-01', to: '2024-06-30' });
    expect(result.rows.map((r) => r.id)).toEqual(['t1']);
    expect(result.hit).toBe(true);
    expect(result.oldest_fetched_at).toBe(ts);
    expect(result.newest_fetched_at).toBe(ts);
  });

  test('returns rows sorted DESC by (date, createdAt, id)', async () => {
    const client = mkClientReturning([
      mkPage([
        { id: 'a', date: '2025-01-15', createdAt: 100 },
        { id: 'b', date: '2025-01-15', createdAt: 200 },
        { id: 'c', date: '2025-01-20', createdAt: 50 },
      ]),
    ]);
    const live = new LiveCopilotDatabase(client, mkCache());
    const result = await live.getTransactions({ from: '2025-01-01', to: '2025-01-31' });
    expect(result.rows.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  test('rows outside the requested range are trimmed after merge', async () => {
    const client = mkClientReturning([
      mkPage([
        { id: 'in', date: '2025-01-15' },
        { id: 'out', date: '2024-12-31' },
      ]),
    ]);
    const live = new LiveCopilotDatabase(client, mkCache());
    const result = await live.getTransactions({ from: '2025-01-01', to: '2025-01-31' });
    expect(result.rows.map((r) => r.id)).toEqual(['in']);
  });

  test('one failing month rejects the entire call but ingests successes', async () => {
    let i = 0;
    const client = {
      mutate: mock(),
      query: mock(() => {
        i += 1;
        if (i === 2) throw new GraphQLError('AUTH_FAILED', '401', 'Transactions');
        return Promise.resolve({ transactions: mkPage([{ id: `t${i}`, date: '2025-01-15' }]) });
      }),
    } as unknown as GraphQLClient;
    const live = new LiveCopilotDatabase(client, mkCache());
    await expect(live.getTransactions({ from: '2025-01-01', to: '2025-02-28' })).rejects.toThrow(
      /Failed to fetch/
    );
    const wc = live.getTransactionsWindowCache();
    expect(wc.cachedMonths().length).toBe(1);
  });

  test('cross-month leakage is filtered before ingest (no cache pollution)', async () => {
    // Page returns Feb rows AND a January row (paginate's tail).
    const client = mkClientReturning([
      mkPage([
        { id: 'feb1', date: '2025-02-15' },
        { id: 'jan-leak', date: '2025-01-30' }, // outside Feb's range
      ]),
    ]);
    const live = new LiveCopilotDatabase(client, mkCache());
    await live.getTransactions({ from: '2025-02-01', to: '2025-02-28' });

    // The leaked January row must NOT have polluted Feb's cache bucket.
    const wc = live.getTransactionsWindowCache();
    const febRows = wc.entriesForMonth('2025-02');
    expect(febRows.map((r) => r.id)).toEqual(['feb1']);
    expect(wc.entriesForMonth('2025-01')).toEqual([]);
  });

  test('shared concurrency cap across concurrent calls', async () => {
    // 8 distinct months across 2 callers; only 4 should be in-flight at once.
    let active = 0;
    let peak = 0;
    let resolveAll!: () => void;
    const gate = new Promise<void>((r) => {
      resolveAll = r;
    });
    let queryNum = 0;
    const client = {
      mutate: mock(),
      query: mock(async () => {
        active += 1;
        peak = Math.max(peak, active);
        queryNum += 1;
        const num = queryNum;
        await gate;
        active -= 1;
        return { transactions: mkPage([{ id: `t${num}`, date: '2025-01-15' }]) };
      }),
    } as unknown as GraphQLClient;
    const live = new LiveCopilotDatabase(client, mkCache());

    // Caller A wants 4 distinct months, caller B wants 4 different distinct months.
    const a = live.getTransactions({ from: '2025-01-01', to: '2025-04-30' });
    const b = live.getTransactions({ from: '2025-05-01', to: '2025-08-31' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(4);
    resolveAll();
    await Promise.all([a, b]);
    expect(peak).toBeLessThanOrEqual(4);
  });

  test('concurrent calls coalesce per-month via InFlightRegistry', async () => {
    let queryCalls = 0;
    let resolveAll!: () => void;
    const gate = new Promise<void>((r) => {
      resolveAll = r;
    });
    const client = {
      mutate: mock(),
      query: mock(async () => {
        queryCalls += 1;
        await gate;
        return { transactions: mkPage([{ id: `t${queryCalls}`, date: '2025-01-15' }]) };
      }),
    } as unknown as GraphQLClient;
    const live = new LiveCopilotDatabase(client, mkCache());

    const a = live.getTransactions({ from: '2025-01-01', to: '2025-01-31' });
    const b = live.getTransactions({ from: '2025-01-01', to: '2025-01-31' });
    await Promise.resolve();
    await Promise.resolve();
    resolveAll();
    await Promise.all([a, b]);
    expect(queryCalls).toBe(1);
  });

  test('single-day range works (from === to)', async () => {
    const client = mkClientReturning([mkPage([{ id: 't1', date: '2025-01-15' }])]);
    const live = new LiveCopilotDatabase(client, mkCache());
    const result = await live.getTransactions({ from: '2025-01-15', to: '2025-01-15' });
    expect(result.rows.map((r) => r.id)).toEqual(['t1']);
    expect(result.hit).toBe(false);
    expect(result.oldest_fetched_at).toBe(result.newest_fetched_at);
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

  test('getRecurringCache returns a SnapshotCache instance', () => {
    expect(mkLive().getRecurringCache()).toBeInstanceOf(SnapshotCache);
  });

  test('getUpcomingRecurringsCache returns a SnapshotCache instance', () => {
    expect(mkLive().getUpcomingRecurringsCache()).toBeInstanceOf(SnapshotCache);
  });

  test('getUpcomingRecurringsCache returns the same instance across calls', () => {
    const live = mkLive();
    expect(live.getUpcomingRecurringsCache()).toBe(live.getUpcomingRecurringsCache());
  });

  test('upcomingRecurringsCache stores UpcomingRecurringNode shape and serves cached reads', async () => {
    const live = mkLive();
    const cache = live.getUpcomingRecurringsCache();
    const fetcher = mock(() =>
      Promise.resolve([
        {
          id: 'r1',
          name: 'Subscription A',
          state: 'ACTIVE',
          frequency: 'MONTHLY',
          nextPaymentAmount: 100,
          nextPaymentDate: '2026-05-10',
          categoryId: 'cat-1',
          emoji: 'A',
          icon: { __typename: 'EmojiUnicode' as const, unicode: 'A' },
          rule: null,
          payments: [{ amount: 100, isPaid: false, date: '2026-05-10' }],
        },
      ])
    );

    const first = await cache.read(fetcher);
    const second = await cache.read(fetcher);

    expect(first.rows[0]?.id).toBe('r1');
    expect(first.hit).toBe(false);
    expect(second.hit).toBe(true);
    // Loader runs only on cold; second call hits cache (1h TTL).
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('getTransactionsWindowCache returns a TransactionWindowCache instance', () => {
    expect(mkLive().getTransactionsWindowCache()).toBeInstanceOf(TransactionWindowCache);
  });

  test('getUserCache returns a SnapshotCache instance', () => {
    expect(mkLive().getUserCache()).toBeInstanceOf(SnapshotCache);
  });

  test('getNetworthCache returns a SnapshotCache instance', () => {
    expect(mkLive().getNetworthCache()).toBeInstanceOf(SnapshotCache);
  });

  test('getMonthlySpendCache returns a SnapshotCache instance', () => {
    expect(mkLive().getMonthlySpendCache()).toBeInstanceOf(SnapshotCache);
  });

  test('each call returns the same instance (not a new one)', () => {
    const live = mkLive();
    expect(live.getTagsCache()).toBe(live.getTagsCache());
    expect(live.getTransactionsWindowCache()).toBe(live.getTransactionsWindowCache());
    expect(live.getUserCache()).toBe(live.getUserCache());
    expect(live.getNetworthCache()).toBe(live.getNetworthCache());
    expect(live.getMonthlySpendCache()).toBe(live.getMonthlySpendCache());
  });
});

describe('LiveCopilotDatabase — userCache', () => {
  function mkLive() {
    return new LiveCopilotDatabase(mkClient(), mkCache());
  }

  test('userCache stores UserNode shape and serves cached reads', async () => {
    const live = mkLive();
    const fixture: UserNode = {
      id: 'u-1',
      budgetingConfig: {
        isEnabled: true,
        rolloversConfig: { isEnabled: true, startDate: '2026-01' },
      },
    };
    const cache = live.getUserCache();
    const fetcher = mock(() => Promise.resolve([fixture]));

    const first = await cache.read(fetcher);
    const second = await cache.read(fetcher);

    expect(first.rows[0]).toEqual(fixture);
    expect(first.hit).toBe(false);
    expect(second.rows[0]).toEqual(fixture);
    expect(second.hit).toBe(true);
    // Loader runs only on cold; second call hits cache.
    expect(fetcher).toHaveBeenCalledTimes(1);
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

// ── patchLiveTagUpsert / patchLiveTagDelete ─────────────────────────────────

describe('LiveCopilotDatabase.patchLiveTagUpsert (TagNode shape)', () => {
  test('upserts a TagNode into tagsCache', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());

    const cache = live.getTagsCache();
    await cache.read(() => Promise.resolve([{ id: 'tag-1', name: 'travel', colorName: 'BLUE1' }]));

    live.patchLiveTagUpsert({ id: 'tag-1', name: 'travel-2026', colorName: 'BLUE1' });

    const after = await cache.read(() => Promise.resolve([]));
    expect(after.rows.find((t) => t.id === 'tag-1')?.name).toBe('travel-2026');
  });
});

describe('LiveCopilotDatabase.patchLiveTagDelete (TagNode shape)', () => {
  test('removes a TagNode from tagsCache by id', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());

    const cache = live.getTagsCache();
    await cache.read(() =>
      Promise.resolve([
        { id: 'tag-1', name: 'travel', colorName: 'BLUE1' },
        { id: 'tag-2', name: 'work', colorName: 'PINK1' },
      ])
    );

    live.patchLiveTagDelete('tag-1');

    const after = await cache.read(() => Promise.resolve([]));
    expect(after.rows.map((t) => t.id)).toEqual(['tag-2']);
  });
});

// ── patchLiveCategoryUpsert / patchLiveCategoryDelete ──────────────────────

describe('LiveCopilotDatabase.patchLiveCategoryUpsert (CategoryNode shape)', () => {
  test('upserts a CategoryNode into categoriesCache', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());

    // Warm cache via a fake fetch
    const cache = live.getCategoriesCache();
    await cache.read(() =>
      Promise.resolve([
        {
          id: 'cat-1',
          parentId: null,
          name: 'Old Name',
          templateId: 'Food',
          colorName: 'ORANGE2',
          icon: null,
          isExcluded: false,
          isRolloverDisabled: false,
          canBeDeleted: true,
          budget: null,
        },
      ])
    );

    live.patchLiveCategoryUpsert({
      id: 'cat-1',
      parentId: null,
      name: 'New Name',
      templateId: 'Food',
      colorName: 'ORANGE2',
      icon: null,
      isExcluded: false,
      isRolloverDisabled: false,
      canBeDeleted: true,
      budget: null,
    });

    const after = await cache.read(() => Promise.resolve([]));
    expect(after.rows.find((c) => c.id === 'cat-1')?.name).toBe('New Name');
  });

  test('patchLiveCategoryDelete removes category by id', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    const catNode1: CategoryNode = {
      id: 'cat-1',
      parentId: null,
      name: 'Dining',
      templateId: 'Food',
      colorName: 'ORANGE2',
      icon: null,
      isExcluded: false,
      isRolloverDisabled: false,
      canBeDeleted: true,
      budget: null,
    };
    const catNode2: CategoryNode = {
      id: 'cat-2',
      parentId: null,
      name: 'Travel',
      templateId: 'Travel',
      colorName: 'BLUE1',
      icon: null,
      isExcluded: false,
      isRolloverDisabled: false,
      canBeDeleted: true,
      budget: null,
    };
    await live.getCategoriesCache().read(() => Promise.resolve([catNode1, catNode2]));
    live.patchLiveCategoryDelete('cat-1');
    const result = await live.getCategoriesCache().read(() => Promise.resolve([]));
    expect(result.rows.map((c) => c.id)).toEqual(['cat-2']);
  });
});

// ── patchLiveCategoryBudget ────────────────────────────────────────────────

describe('LiveCopilotDatabase.patchLiveCategoryBudget', () => {
  test('updates budget.current.amount on a cached category for the current month', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    const cache = live.getCategoriesCache();

    // Seed a category with no budget
    await cache.read(() =>
      Promise.resolve([
        {
          id: 'cat-1',
          parentId: null,
          name: 'Food',
          templateId: 'Food',
          colorName: null,
          icon: null,
          isExcluded: false,
          isRolloverDisabled: false,
          canBeDeleted: true,
          budget: null,
        },
      ])
    );

    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM (UTC)
    live.patchLiveCategoryBudget('cat-1', 250, currentMonth);

    const after = await cache.read(() => Promise.resolve([]));
    const cat = after.rows.find((c) => c.id === 'cat-1');
    expect(cat?.budget?.current?.amount).toBe('250');
    expect(cat?.budget?.current?.month).toBe(currentMonth);
    // The patch went to `current`, not `histories` — histories must stay empty.
    expect(cat?.budget?.histories).toEqual([]);
  });

  test('patching current month with no existing current synthesizes ONLY current (not both current+history)', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    const cache = live.getCategoriesCache();

    // Seed a category with budget.current=null and empty histories
    await cache.read(() =>
      Promise.resolve([
        {
          id: 'cat-1',
          parentId: null,
          name: 'Food',
          templateId: 'Food',
          colorName: null,
          icon: null,
          isExcluded: false,
          isRolloverDisabled: false,
          canBeDeleted: true,
          budget: { current: null, histories: [] },
        },
      ])
    );

    // Patch the current UTC month
    const todayMonth = (() => {
      const d = new Date();
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    })();
    live.patchLiveCategoryBudget('cat-1', 250, todayMonth);

    const after = await cache.read(() => Promise.resolve([]));
    const cat = after.rows.find((c) => c.id === 'cat-1');
    expect(cat?.budget?.current?.amount).toBe('250');
    expect(cat?.budget?.current?.month).toBe(todayMonth);
    // Critical: histories should remain empty — current month went to `current`, not `histories`
    expect(cat?.budget?.histories).toEqual([]);
  });

  test('updates a historical month via budget.histories', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    const cache = live.getCategoriesCache();

    await cache.read(() =>
      Promise.resolve([
        {
          id: 'cat-1',
          parentId: null,
          name: 'Food',
          templateId: 'Food',
          colorName: null,
          icon: null,
          isExcluded: false,
          isRolloverDisabled: false,
          canBeDeleted: true,
          budget: {
            current: null,
            histories: [
              {
                unassignedRolloverAmount: '0',
                childRolloverAmount: '0',
                unassignedAmount: '0',
                resolvedAmount: '100',
                rolloverAmount: '0',
                childAmount: null,
                goalAmount: '100',
                amount: '100',
                month: '2026-04',
                id: 'b-existing',
              },
            ],
          },
        },
      ])
    );

    live.patchLiveCategoryBudget('cat-1', 175, '2026-04');

    const after = await cache.read(() => Promise.resolve([]));
    const hist = after.rows.find((c) => c.id === 'cat-1')?.budget?.histories ?? [];
    expect(hist).toHaveLength(1);
    expect(hist[0]?.amount).toBe('175');
  });

  test('inserts a new history entry when month not present', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    const cache = live.getCategoriesCache();

    await cache.read(() =>
      Promise.resolve([
        {
          id: 'cat-1',
          parentId: null,
          name: 'Food',
          templateId: 'Food',
          colorName: null,
          icon: null,
          isExcluded: false,
          isRolloverDisabled: false,
          canBeDeleted: true,
          budget: { current: null, histories: [] },
        },
      ])
    );

    live.patchLiveCategoryBudget('cat-1', 75, '2025-12');

    const after = await cache.read(() => Promise.resolve([]));
    const hist = after.rows.find((c) => c.id === 'cat-1')?.budget?.histories ?? [];
    expect(hist).toHaveLength(1);
    expect(hist[0]?.month).toBe('2025-12');
    expect(hist[0]?.amount).toBe('75');
  });

  test('no-op when category not in cache', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    const cache = live.getCategoriesCache();
    await cache.read(() => Promise.resolve([])); // empty cache

    // Does not throw
    expect(() => live.patchLiveCategoryBudget('cat-missing', 100)).not.toThrow();

    const after = await cache.read(() => Promise.resolve([]));
    expect(after.rows.find((c) => c.id === 'cat-missing')).toBeUndefined();
  });
});

// ── patchLiveRecurringUpsert / patchLiveRecurringDelete ────────────────────

describe('LiveCopilotDatabase — recurring cache patches', () => {
  test('patchLiveRecurringUpsert inserts a new recurring item (RecurringNode shape)', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    await live.getRecurringCache().read(async () => []);
    const rec: RecurringNode = {
      id: 'r1',
      name: 'Netflix',
      state: 'ACTIVE',
      frequency: 'MONTHLY',
      nextPaymentAmount: 15.99,
      nextPaymentDate: '2026-06-01',
      categoryId: 'cat-streaming',
      emoji: '🎬',
      icon: { __typename: 'EmojiUnicode', unicode: '🎬' },
      rule: null,
      payments: [],
    };
    live.patchLiveRecurringUpsert(rec);
    const result = await live.getRecurringCache().read(async () => []);
    expect(result.rows.find((r) => r.id === 'r1')?.name).toBe('Netflix');
  });

  test('patchLiveRecurringDelete removes recurring item by id', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    const r1: RecurringNode = {
      id: 'r1',
      name: 'Netflix',
      state: 'ACTIVE',
      frequency: 'MONTHLY',
      nextPaymentAmount: null,
      nextPaymentDate: null,
      categoryId: null,
      emoji: null,
      icon: null,
      rule: null,
      payments: [],
    };
    const r2: RecurringNode = { ...r1, id: 'r2', name: 'Spotify' };
    await live.getRecurringCache().read(async () => [r1, r2]);
    live.patchLiveRecurringDelete('r1');
    const result = await live.getRecurringCache().read(async () => []);
    expect(result.rows.map((r) => r.id)).toEqual(['r2']);
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

  test('logReadCall emits from_to_months and fetched_months when set', () => {
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
        latencyMs: 2843,
        rows: 2412,
        cache_hit: false,
        from_to_months: 12,
        fetched_months: 2,
      });
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('from_to_months=12');
      expect(lines[0]).toContain('fetched_months=2');
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
