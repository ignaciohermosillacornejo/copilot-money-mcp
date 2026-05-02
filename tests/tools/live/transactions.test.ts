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

import type { TransactionNode } from '../../../src/core/graphql/queries/transactions.js';

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
      getTransactions: (range: { from: string; to: string }) => Promise<{
        rows: TransactionNode[];
        oldest_fetched_at: number;
        newest_fetched_at: number;
        hit: boolean;
      }>;
    }
  ).getTransactions = async () => ({
    rows: nodes,
    oldest_fetched_at: fetchedAt,
    newest_fetched_at: fetchedAt,
    hit: false,
  });
  return live;
}

describe('LiveTransactionsTools — happy path', () => {
  test('returns envelope with enriched fields', async () => {
    const live = mkLiveReturning([mkNode({ id: 't1', name: 'AMAZON.COM*XYZ' })]);
    (live.getCache().getCategoryNameMap as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(new Map([['c1', 'Shopping']]))
    );
    const tools = new LiveTransactionsTools(live);

    const result = await tools.getTransactions({
      query: 'amazon',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });

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

    const result = await tools.getTransactions({
      limit: 2,
      offset: 1,
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });

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
    const result = await tools.getTransactions({
      min_amount: 10,
      max_amount: 100,
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t2']);
  });

  test('filters by pending flag', async () => {
    const nodes = [mkNode({ id: 't1', isPending: true }), mkNode({ id: 't2', isPending: false })];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const resultP = await tools.getTransactions({
      pending: true,
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    expect(resultP.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
    const resultS = await tools.getTransactions({
      pending: false,
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
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
    const result = await tools.getTransactions({
      transaction_type: 'tagged',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
  });

  test('transaction_type=refunds filters to negative amounts', async () => {
    const nodes = [mkNode({ id: 't1', amount: -25 }), mkNode({ id: 't2', amount: 15 })];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      transaction_type: 'refunds',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
  });

  test('exclude_transfers=true filters out INTERNAL_TRANSFER', async () => {
    const nodes = [
      mkNode({ id: 't1', type: 'REGULAR' }),
      mkNode({ id: 't2', type: 'INTERNAL_TRANSFER' }),
    ];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      exclude_transfers: true,
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
  });
});

describe('LiveTransactionsTools — account resolution', () => {
  test('account_id filter narrows to rows from that account (post-filter)', async () => {
    const nodes = [mkNode({ id: 't1', accountId: 'a1' }), mkNode({ id: 't2', accountId: 'a2' })];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      account_id: 'a2',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t2']);
  });

  test('singleTransactionLookup post-filters by (id, accountId, itemId)', async () => {
    const nodes = [
      mkNode({ id: 't1', accountId: 'aOTHER', itemId: 'i1' }),
      mkNode({ id: 't1', accountId: 'a1', itemId: 'iOTHER' }),
      mkNode({ id: 'tOTHER', accountId: 'a1', itemId: 'i1' }),
      mkNode({ id: 't1', accountId: 'a1', itemId: 'i1', name: 'matched' }),
    ];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);

    const result = await tools.getTransactions({
      transaction_id: 't1',
      account_id: 'a1',
      item_id: 'i1',
      period: 'this_year',
    });

    expect(result.count).toBe(1);
    expect(result.transactions[0]!.transaction_id).toBe('t1');
    expect(result.transactions[0]!.account_id).toBe('a1');
    expect(result.transactions[0]!.item_id).toBe('i1');
    expect(result.transactions[0]!.name).toBe('matched');
  });

  test('singleTransactionLookup returns empty when no match in range', async () => {
    const live = mkLiveReturning([mkNode({ id: 'other', accountId: 'a1', itemId: 'i1' })]);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      transaction_id: 'missing',
      account_id: 'a1',
      item_id: 'i1',
      period: 'this_year',
    });
    expect(result.count).toBe(0);
    expect(result.total_count).toBe(0);
    expect(result.transactions).toEqual([]);
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

  test('oldest and newest are equal when fixture provides a single timestamp', async () => {
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

  test('second identical call hits the window cache and reports _cache_hit: true', async () => {
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
    const liveDb = new LiveDB(client, cache);
    const tools = new LiveTransactionsTools(liveDb);

    // Pick a date range entirely in the cold tier (>14d old) so the second
    // call hits cache. 2024 is well outside the live tier on 2026-05-01.
    const a = await tools.getTransactions({ start_date: '2024-06-01', end_date: '2024-06-30' });
    const b = await tools.getTransactions({ start_date: '2024-06-01', end_date: '2024-06-30' });

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

describe('LiveTransactionsTools — migrated filters', () => {
  test('category filter matches by categoryId', async () => {
    const nodes = [mkNode({ id: 't1', categoryId: 'c1' }), mkNode({ id: 't2', categoryId: 'c2' })];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      category: 'c1',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
  });

  test('tag filter resolves name → id and matches via n.tags[]', async () => {
    const nodes = [
      mkNode({
        id: 't1',
        tags: [{ id: 'tg1', name: 'vacation', colorName: 'BLUE1' }],
      }),
      mkNode({ id: 't2', tags: [] }),
    ];
    const live = mkLiveReturning(nodes);
    (live.getCache().getTags as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([{ tag_id: 'tg1', name: 'Vacation' }])
    );
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      tag: 'Vacation',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
  });

  test('exclude_transfers=false retains INTERNAL_TRANSFER rows', async () => {
    const nodes = [
      mkNode({ id: 't1', type: 'REGULAR' }),
      mkNode({ id: 't2', type: 'INTERNAL_TRANSFER' }),
    ];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      exclude_transfers: false,
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    expect(result.transactions.map((t) => t.transaction_id).sort()).toEqual(['t1', 't2']);
  });

  test('matchString filters case-insensitive substring on name (via query)', async () => {
    const nodes = [
      mkNode({ id: 't1', name: 'Amazon Fresh' }),
      mkNode({ id: 't2', name: 'AMAZON.com' }),
      mkNode({ id: 't3', name: 'Whole Foods' }),
    ];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      query: 'amazon',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    expect(result.transactions.map((t) => t.transaction_id).sort()).toEqual(['t1', 't2']);
  });

  test('matchString filters case-insensitive via merchant when query is unset', async () => {
    const nodes = [
      mkNode({ id: 't1', name: 'Starbucks #123' }),
      mkNode({ id: 't2', name: 'Coffee Bean' }),
    ];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      merchant: 'starbucks',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
  });

  test('query takes precedence over merchant when both are set', async () => {
    const nodes = [
      mkNode({ id: 't1', name: 'foo only' }),
      mkNode({ id: 't2', name: 'bar only' }),
      mkNode({ id: 't3', name: 'foo and bar' }),
    ];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      query: 'foo',
      merchant: 'bar',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    // Only `foo` filter runs; `bar` is ignored.
    expect(result.transactions.map((t) => t.transaction_id).sort()).toEqual(['t1', 't3']);
  });
});

describe('LiveTransactionsTools — date-less query rejection', () => {
  test('throws when query is set without dates or period', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ query: 'amazon' })).rejects.toThrow(
      /require a date range|period|start_date/
    );
  });

  test('throws when merchant is set without dates or period', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ merchant: 'amazon' })).rejects.toThrow(
      /require a date range|period|start_date/
    );
  });

  test('does NOT throw when query is set with period', async () => {
    const live = mkLiveReturning([]);
    const tools = new LiveTransactionsTools(live);
    await expect(
      tools.getTransactions({ query: 'amazon', period: 'this_month' })
    ).resolves.toBeDefined();
  });

  test('does NOT throw when query is set with explicit dates', async () => {
    const live = mkLiveReturning([]);
    const tools = new LiveTransactionsTools(live);
    await expect(
      tools.getTransactions({
        query: 'amazon',
        start_date: '2025-01-01',
        end_date: '2025-12-31',
      })
    ).resolves.toBeDefined();
  });

  test('validate: transaction_id path bypasses query-without-date guard', async () => {
    const live = mkLiveReturning([mkNode({ id: 't1', accountId: 'a1', itemId: 'i1' })]);
    const tools = new LiveTransactionsTools(live);
    // query is set but should NOT cause a date-range error because transaction_id
    // lookup has its own date-range enforcement (transaction_id requires period
    // or start_date/end_date — supplied here via period).
    await expect(
      tools.getTransactions({
        transaction_id: 't1',
        account_id: 'a1',
        item_id: 'i1',
        query: 'foo',
        period: 'this_year',
      })
    ).resolves.toBeDefined();
  });
});
