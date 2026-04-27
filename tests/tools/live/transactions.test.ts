import { describe, test, expect, mock } from 'bun:test';
import {
  LiveTransactionsTools,
  createLiveToolSchemas,
} from '../../../src/tools/live/transactions.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import type { CopilotDatabase } from '../../../src/core/database.js';

function mkLive(): LiveCopilotDatabase {
  const client = { mutate: mock(), query: mock() } as unknown as GraphQLClient;
  const cache = {
    getAccounts: mock(() => Promise.resolve([])),
    getTags: mock(() => Promise.resolve([])),
    getUserCategories: mock(() => Promise.resolve([])),
    getCategoryNameMap: mock(() => Promise.resolve(new Map<string, string>())),
  } as unknown as CopilotDatabase;
  return new LiveCopilotDatabase(client, cache);
}

describe('LiveTransactionsTools — input validation', () => {
  test('rejects city filter', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ city: 'Brooklyn' } as never)).rejects.toThrow(
      /city.*not supported/i
    );
  });

  test('rejects lat/lon filter', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ lat: 40.7, lon: -74 } as never)).rejects.toThrow(
      /lat.*not supported|lon.*not supported/i
    );
  });

  test('rejects region/country/radius_km filters', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ region: 'NY' } as never)).rejects.toThrow(
      /region.*not supported/i
    );
    await expect(tools.getTransactions({ country: 'US' } as never)).rejects.toThrow(
      /country.*not supported/i
    );
    await expect(tools.getTransactions({ radius_km: 10 } as never)).rejects.toThrow(
      /radius_km.*not supported/i
    );
  });

  test('rejects transaction_type=foreign and =duplicates', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ transaction_type: 'foreign' } as never)).rejects.toThrow(
      /foreign.*not supported/i
    );
    await expect(
      tools.getTransactions({ transaction_type: 'duplicates' } as never)
    ).rejects.toThrow(/duplicates.*not supported/i);
  });

  test('rejects exclude_split_parents=false', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ exclude_split_parents: false } as never)).rejects.toThrow(
      /exclude_split_parents.*not supported/i
    );
  });

  test('rejects transaction_id lookup without account_id+item_id', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ transaction_id: 't1' } as never)).rejects.toThrow(
      /account_id.*item_id/i
    );
  });

  test('rejects transaction_id lookup without a date range (unbounded fetch guard)', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(
      tools.getTransactions({
        transaction_id: 't1',
        account_id: 'a1',
        item_id: 'i1',
      } as never)
    ).rejects.toThrow(/date range|start_date.*end_date.*period/i);
  });
});

import type {
  TransactionNode,
  AccountRef,
} from '../../../src/core/graphql/queries/transactions.js';
import type { Account } from '../../../src/models/index.js';

function mkNode(partial: Partial<TransactionNode>): TransactionNode {
  return {
    id: 't-default',
    accountId: 'a1',
    itemId: 'i1',
    categoryId: 'c1',
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
    ...partial,
  };
}

function mkLiveReturning(nodes: TransactionNode[], fetchedAt = Date.now()): LiveCopilotDatabase {
  const live = mkLive();
  (
    live as unknown as {
      getTransactions: (
        opts: unknown
      ) => Promise<{ rows: TransactionNode[]; fetched_at: number; hit: boolean }>;
    }
  ).getTransactions = async () => ({ rows: nodes, fetched_at: fetchedAt, hit: false });
  return live;
}

describe('LiveTransactionsTools — happy path', () => {
  test('returns envelope with enriched fields', async () => {
    const live = mkLiveReturning([mkNode({ id: 't1', name: 'AMAZON.COM*XYZ' })]);
    (live.getCache().getCategoryNameMap as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(new Map([['c1', 'Shopping']]))
    );
    const tools = new LiveTransactionsTools(live);

    const result = await tools.getTransactions({ query: 'amazon' });

    expect(result.count).toBe(1);
    expect(result.transactions[0]).toMatchObject({
      transaction_id: 't1',
      category_name: 'Shopping',
      normalized_merchant: 'AMAZON',
    });
  });

  test('applies limit and offset client-side', async () => {
    const nodes = [1, 2, 3, 4, 5].map((i) => mkNode({ id: `t${i}` }));
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);

    const result = await tools.getTransactions({ limit: 2, offset: 1 });

    expect(result.count).toBe(2);
    expect(result.total_count).toBe(5);
    expect(result.offset).toBe(1);
    expect(result.has_more).toBe(true);
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t2', 't3']);
  });
});

describe('LiveTransactionsTools — post-filters', () => {
  test('filters by min_amount and max_amount (absolute value)', async () => {
    const nodes = [
      mkNode({ id: 't1', amount: -5 }),
      mkNode({ id: 't2', amount: 50 }),
      mkNode({ id: 't3', amount: 150 }),
    ];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({ min_amount: 10, max_amount: 100 });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t2']);
  });

  test('filters by pending flag', async () => {
    const nodes = [mkNode({ id: 't1', isPending: true }), mkNode({ id: 't2', isPending: false })];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const resultP = await tools.getTransactions({ pending: true });
    expect(resultP.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
    const resultS = await tools.getTransactions({ pending: false });
    expect(resultS.transactions.map((t) => t.transaction_id)).toEqual(['t2']);
  });

  test('transaction_type=tagged filters to rows with tags[] non-empty', async () => {
    const nodes = [
      mkNode({
        id: 't1',
        tags: [{ id: 'tg1', name: 'vacation', colorName: 'BLUE1' }],
      }),
      mkNode({ id: 't2', tags: [] }),
    ];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({ transaction_type: 'tagged' });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
  });

  test('transaction_type=refunds filters to negative amounts', async () => {
    const nodes = [mkNode({ id: 't1', amount: -25 }), mkNode({ id: 't2', amount: 15 })];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({ transaction_type: 'refunds' });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
  });

  test('exclude_transfers=true filters out INTERNAL_TRANSFER', async () => {
    const nodes = [
      mkNode({ id: 't1', type: 'REGULAR' }),
      mkNode({ id: 't2', type: 'INTERNAL_TRANSFER' }),
    ];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({ exclude_transfers: true });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
  });
});

describe('LiveTransactionsTools — account resolution', () => {
  test('resolves account_id to AccountRef via cache', async () => {
    const live = mkLiveReturning([]);
    const accounts: Account[] = [
      { account_id: 'a1', item_id: 'i-1' } as Account,
      { account_id: 'a2', item_id: 'i-2' } as Account,
    ];
    (live.getCache().getAccounts as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(accounts)
    );
    const spy = mock((_opts: unknown) =>
      Promise.resolve({ rows: [] as TransactionNode[], fetched_at: Date.now(), hit: false })
    );
    (live as unknown as { getTransactions: typeof spy }).getTransactions = spy;

    const tools = new LiveTransactionsTools(live);
    await tools.getTransactions({ account_id: 'a2' });

    const args = spy.mock.calls[0]![0] as { accountRefs?: AccountRef[] };
    expect(args.accountRefs).toEqual([{ accountId: 'a2', itemId: 'i-2' }]);
  });

  test('surfaces error when account_id is not in cache', async () => {
    const live = mkLiveReturning([]);
    (live.getCache().getAccounts as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([])
    );
    const tools = new LiveTransactionsTools(live);
    await expect(tools.getTransactions({ account_id: 'nope' })).rejects.toThrow(
      /account.*not found/i
    );
  });

  test('singleTransactionLookup resolves period → bounded startDate/endDate', async () => {
    const live = mkLiveReturning([]);
    const accounts: Account[] = [{ account_id: 'a1', item_id: 'i1' } as Account];
    (live.getCache().getAccounts as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(accounts)
    );
    const spy = mock((_opts: unknown) =>
      Promise.resolve({ rows: [] as TransactionNode[], fetched_at: Date.now(), hit: false })
    );
    (live as unknown as { getTransactions: typeof spy }).getTransactions = spy;

    const tools = new LiveTransactionsTools(live);
    await tools.getTransactions({
      transaction_id: 't1',
      account_id: 'a1',
      item_id: 'i1',
      period: 'this_year',
    });

    const args = spy.mock.calls[0]![0] as { startDate?: string; endDate?: string };
    // parsePeriod('this_year') returns concrete YYYY-MM-DD bounds; assert both are set.
    expect(args.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(args.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('LiveTransactionsTools — freshness envelope', () => {
  test('response includes _cache_oldest_fetched_at, _cache_newest_fetched_at, and _cache_hit', async () => {
    const live = mkLiveReturning([mkNode({ id: 't1' })]);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      start_date: '2026-04-01',
      end_date: '2026-04-30',
    });
    expect(typeof result._cache_oldest_fetched_at).toBe('string');
    expect(typeof result._cache_newest_fetched_at).toBe('string');
    expect(typeof result._cache_hit).toBe('boolean');
    expect(result._cache_hit).toBe(false);
  });

  test('oldest and newest are equal (single memo bucket in Phase 2)', async () => {
    const live = mkLiveReturning([]);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      start_date: '2026-04-01',
      end_date: '2026-04-30',
    });
    expect(result._cache_oldest_fetched_at).toBe(result._cache_newest_fetched_at);
  });

  test('_cache_oldest_fetched_at is a valid ISO string', async () => {
    const live = mkLiveReturning([]);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      start_date: '2026-04-01',
      end_date: '2026-04-30',
    });
    expect(new Date(result._cache_oldest_fetched_at).toISOString()).toBe(
      result._cache_oldest_fetched_at
    );
  });

  test('second identical call has _cache_hit: true and same timestamps', async () => {
    // Use the real LiveCopilotDatabase memoize by constructing a live instance
    // whose underlying GraphQL call returns a fixed page.
    const { LiveCopilotDatabase: LiveDB } = await import('../../../src/core/live-database.js');
    const client = {
      mutate: mock(),
      query: mock(() =>
        Promise.resolve({
          transactions: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } },
        })
      ),
    } as unknown as import('../../../src/core/graphql/client.js').GraphQLClient;
    const cache = {
      getAccounts: mock(() => Promise.resolve([])),
      getTags: mock(() => Promise.resolve([])),
      getUserCategories: mock(() => Promise.resolve([])),
      getCategoryNameMap: mock(() => Promise.resolve(new Map<string, string>())),
    } as unknown as import('../../../src/core/database.js').CopilotDatabase;
    const liveDb = new LiveDB(client, cache, { memoTtlMs: 60_000 });
    const tools = new LiveTransactionsTools(liveDb);

    const a = await tools.getTransactions({ start_date: '2026-04-01', end_date: '2026-04-30' });
    const b = await tools.getTransactions({ start_date: '2026-04-01', end_date: '2026-04-30' });

    expect(a._cache_hit).toBe(false);
    expect(b._cache_hit).toBe(true);
    expect(b._cache_oldest_fetched_at).toBe(a._cache_oldest_fetched_at);
    expect(b._cache_newest_fetched_at).toBe(a._cache_newest_fetched_at);
  });
});

describe('createLiveToolSchemas', () => {
  test('registers exactly one tool named get_transactions_live', () => {
    const schemas = createLiveToolSchemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0]!.name).toBe('get_transactions_live');
  });

  test('description enumerates unsupported filters and 3-ID rule', () => {
    const { description } = createLiveToolSchemas()[0]!;
    expect(description).toMatch(/city|lat|lon|region|country/);
    expect(description).toMatch(/foreign|duplicates/);
    expect(description).toMatch(/account_id.*item_id/);
  });

  test('input schema omits unsupported filters', () => {
    const { inputSchema } = createLiveToolSchemas()[0]!;
    const props = (inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.city).toBeUndefined();
    expect(props.lat).toBeUndefined();
    expect(props.lon).toBeUndefined();
    expect(props.radius_km).toBeUndefined();
    expect(props.region).toBeUndefined();
    expect(props.country).toBeUndefined();
  });

  test('transaction_type enum excludes foreign and duplicates', () => {
    const { inputSchema } = createLiveToolSchemas()[0]!;
    const ttype = (inputSchema as { properties: { transaction_type?: { enum?: string[] } } })
      .properties.transaction_type;
    expect(ttype?.enum).toEqual(['refunds', 'credits', 'hsa_eligible', 'tagged']);
  });

  test('readOnlyHint is true', () => {
    const { annotations } = createLiveToolSchemas()[0]!;
    expect(annotations?.readOnlyHint).toBe(true);
  });
});
