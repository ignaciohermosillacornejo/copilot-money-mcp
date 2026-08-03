import { describe, test, expect, mock } from 'bun:test';
import {
  LiveTransactionsTools,
  createLiveToolSchemas,
  LIVE_TRANSACTION_TYPES,
  LIVE_TRANSACTION_KNOWN_FIELDS,
} from '../../../src/tools/live/transactions.js';
import { getTransactionsTool } from '../../../src/tools/registry/transactions.js';
import { getTransactionsLiveTool } from '../../../src/tools/registry/live.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import type { CopilotDatabase } from '../../../src/core/database.js';

function mkLive(): LiveCopilotDatabase {
  const client = {
    mutate: mock(),
    query: mock(),
  } as unknown as GraphQLClient;
  const cache = {
    getAccounts: mock(() => Promise.resolve([])),
    getTags: mock(() => Promise.resolve([])),
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
    const retryHint = `Retry with one of: ${LIVE_TRANSACTION_TYPES.join(', ')}.`;
    await expect(tools.getTransactions({ transaction_type: 'foreign' } as never)).rejects.toThrow(
      `Parameter 'transaction_type=foreign' is not supported in live mode. ${retryHint}`
    );
    await expect(
      tools.getTransactions({ transaction_type: 'duplicates' } as never)
    ).rejects.toThrow(
      `Parameter 'transaction_type=duplicates' is not supported in live mode. ${retryHint}`
    );
  });

  test('rejects exclude_split_parents=false', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ exclude_split_parents: false } as never)).rejects.toThrow(
      /exclude_split_parents.*not supported/i
    );
  });

  test('rejects exclude_deleted=false (server-side filter cannot be disabled)', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ exclude_deleted: false } as never)).rejects.toThrow(
      /exclude_deleted.*not supported/i
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

async function mkLiveReturning(
  nodes: TransactionNode[],
  fetchedAt = Date.now()
): Promise<LiveCopilotDatabase> {
  const live = mkLive();
  (
    live as unknown as {
      getTransactions: (range: { from: string; to: string }) => Promise<{
        rows: TransactionNode[];
        oldest_fetched_at: number;
        newest_fetched_at: number;
        hit: boolean;
        dropped_invalid_rows: number;
      }>;
    }
  ).getTransactions = async () => ({
    rows: nodes,
    oldest_fetched_at: fetchedAt,
    newest_fetched_at: fetchedAt,
    hit: false,
    dropped_invalid_rows: 0,
  });
  // Pre-warm categoriesCache with empty so tests that don't exercise
  // category-dependent paths never call fetchCategories on the mock client.
  await live.getCategoriesCache().read(() => Promise.resolve([]));
  await live.getTagsCache().read(() => Promise.resolve([]));
  return live;
}

describe('LiveTransactionsTools — happy path', () => {
  test('returns envelope with enriched fields', async () => {
    const live = await mkLiveReturning([mkNode({ id: 't1', name: 'AMAZON.COM*XYZ' })]);
    // mkLiveReturning pre-warms categoriesCache with []; invalidate() to allow
    // the next read() to seed real test data instead of returning the stale [].
    live.getCategoriesCache().invalidate();
    await live.getCategoriesCache().read(() =>
      Promise.resolve([
        {
          id: 'c1',
          name: 'Shopping',
          templateId: 'Shopping',
          colorName: null,
          icon: null,
          isExcluded: false,
          isRolloverDisabled: false,
          canBeDeleted: true,
          budget: null,
        },
      ])
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
    const live = await mkLiveReturning(nodes);
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
    const live = await mkLiveReturning(nodes);
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
    const live = await mkLiveReturning(nodes);
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
    const live = await mkLiveReturning(nodes);
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
    const live = await mkLiveReturning(nodes);
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
    const live = await mkLiveReturning(nodes);
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
    const live = await mkLiveReturning(nodes);
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
    const live = await mkLiveReturning(nodes);
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
    const live = await mkLiveReturning([mkNode({ id: 'other', accountId: 'a1', itemId: 'i1' })]);
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
    const live = await mkLiveReturning([mkNode({ id: 't1' })]);
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
    const live = await mkLiveReturning([]);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      start_date: '2026-04-01',
      end_date: '2026-04-30',
    });
    expect(result._cache_oldest_fetched_at).toBe(result._cache_newest_fetched_at);
  });

  test('_cache_oldest_fetched_at is a valid ISO string', async () => {
    const live = await mkLiveReturning([]);
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
    } as unknown as import('../../../src/core/database.js').CopilotDatabase;
    const liveDb = new LiveDB(client, cache);
    // Pre-warm categoriesCache so exclude_excluded doesn't call fetchCategories
    // on this client (which stubs only the transactions query shape).
    await liveDb.getCategoriesCache().read(() => Promise.resolve([]));
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
    expect(ttype?.enum).toEqual([...LIVE_TRANSACTION_TYPES]);
    expect(ttype?.enum).not.toContain('foreign');
    expect(ttype?.enum).not.toContain('duplicates');
  });

  test('readOnlyHint is true', () => {
    const { annotations } = createLiveToolSchemas()[0]!;
    expect(annotations?.readOnlyHint).toBe(true);
  });
});

describe('LiveTransactionsTools — migrated filters', () => {
  test('category filter matches by categoryId', async () => {
    const nodes = [mkNode({ id: 't1', categoryId: 'c1' }), mkNode({ id: 't2', categoryId: 'c2' })];
    const live = await mkLiveReturning(nodes);
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
    const live = await mkLiveReturning(nodes);
    live.getTagsCache().invalidate();
    await live
      .getTagsCache()
      .read(() => Promise.resolve([{ id: 'tg1', name: 'vacation', colorName: 'BLUE1' }]));
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
    const live = await mkLiveReturning(nodes);
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
    const live = await mkLiveReturning(nodes);
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
    const live = await mkLiveReturning(nodes);
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
    const live = await mkLiveReturning(nodes);
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

describe('LiveTransactionsTools — exclude_excluded filter', () => {
  test('exclude_excluded=true (default) filters out transactions in excluded categories', async () => {
    const nodes = [
      mkNode({ id: 't1', categoryId: 'cat-excluded' }),
      mkNode({ id: 't2', categoryId: 'cat-normal' }),
      mkNode({ id: 't3', categoryId: null }),
    ];
    const live = await mkLiveReturning(nodes);
    // Invalidate the empty pre-warm so we can seed real category data.
    live.getCategoriesCache().invalidate();
    await live.getCategoriesCache().read(() =>
      Promise.resolve([
        {
          id: 'cat-excluded',
          name: 'Transfer',
          templateId: null,
          colorName: null,
          icon: null,
          isExcluded: true,
          isRolloverDisabled: false,
          canBeDeleted: true,
          budget: null,
        },
        {
          id: 'cat-normal',
          name: 'Food',
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
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    // t1 (cat-excluded) should be filtered out; t2 (cat-normal) and t3 (no category) should remain
    expect(result.transactions.map((t) => t.transaction_id).sort()).toEqual(['t2', 't3']);
  });

  test('exclude_excluded=false retains transactions in excluded categories', async () => {
    const nodes = [
      mkNode({ id: 't1', categoryId: 'cat-excluded' }),
      mkNode({ id: 't2', categoryId: 'cat-normal' }),
    ];
    const live = await mkLiveReturning(nodes);
    // Invalidate the empty pre-warm so we can seed real category data.
    live.getCategoriesCache().invalidate();
    await live.getCategoriesCache().read(() =>
      Promise.resolve([
        {
          id: 'cat-excluded',
          name: 'Transfer',
          templateId: null,
          colorName: null,
          icon: null,
          isExcluded: true,
          isRolloverDisabled: false,
          canBeDeleted: true,
          budget: null,
        },
        {
          id: 'cat-normal',
          name: 'Food',
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
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      exclude_excluded: false,
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    // Both should be returned when exclude_excluded=false
    expect(result.transactions.map((t) => t.transaction_id).sort()).toEqual(['t1', 't2']);
  });

  test('exclude_excluded=true returns all transactions when no categories are excluded', async () => {
    const nodes = [
      mkNode({ id: 't1', categoryId: 'cat-normal' }),
      mkNode({ id: 't2', categoryId: 'cat-other' }),
      mkNode({ id: 't3', categoryId: null }),
    ];
    const live = await mkLiveReturning(nodes);
    // Invalidate the empty pre-warm and seed only non-excluded categories.
    live.getCategoriesCache().invalidate();
    await live.getCategoriesCache().read(() =>
      Promise.resolve([
        {
          id: 'cat-normal',
          name: 'Food',
          templateId: 'Food',
          colorName: 'ORANGE2',
          icon: null,
          isExcluded: false,
          isRolloverDisabled: false,
          canBeDeleted: true,
          budget: null,
        },
        {
          id: 'cat-other',
          name: 'Shopping',
          templateId: 'Shopping',
          colorName: 'BLUE1',
          icon: null,
          isExcluded: false,
          isRolloverDisabled: false,
          canBeDeleted: true,
          budget: null,
        },
      ])
    );
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    // No categories are excluded, so all transactions should be returned.
    expect(result.transactions.map((t) => t.transaction_id).sort()).toEqual(['t1', 't2', 't3']);
  });
});

describe('LiveTransactionsTools — hsa_eligible filter', () => {
  test('transaction_type=hsa_eligible retains transactions in health/medical categories', async () => {
    const nodes = [
      mkNode({ id: 't1', categoryId: 'cat-health' }),
      mkNode({ id: 't2', categoryId: 'cat-food' }),
      mkNode({ id: 't3', categoryId: null }),
    ];
    const live = await mkLiveReturning(nodes);
    // Seed categoriesCache so getCategoryNameMap() resolves category names.
    live.getCategoriesCache().invalidate();
    await live.getCategoriesCache().read(() =>
      Promise.resolve([
        {
          id: 'cat-health',
          name: 'Health & Medical',
          templateId: 'Health',
          colorName: null,
          icon: null,
          isExcluded: false,
          isRolloverDisabled: false,
          canBeDeleted: true,
          budget: null,
        },
        {
          id: 'cat-food',
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
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      transaction_type: 'hsa_eligible',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    // Only t1 (Health & Medical) should match; t2 (Food) and t3 (no category) should be filtered out.
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
  });

  test('transaction_type=hsa_eligible matches "medical" in category name', async () => {
    const nodes = [
      mkNode({ id: 't1', categoryId: 'cat-medical' }),
      mkNode({ id: 't2', categoryId: 'cat-shopping' }),
    ];
    const live = await mkLiveReturning(nodes);
    live.getCategoriesCache().invalidate();
    await live.getCategoriesCache().read(() =>
      Promise.resolve([
        {
          id: 'cat-medical',
          name: 'Medical Expenses',
          templateId: null,
          colorName: null,
          icon: null,
          isExcluded: false,
          isRolloverDisabled: false,
          canBeDeleted: true,
          budget: null,
        },
        {
          id: 'cat-shopping',
          name: 'Shopping',
          templateId: 'Shopping',
          colorName: null,
          icon: null,
          isExcluded: false,
          isRolloverDisabled: false,
          canBeDeleted: true,
          budget: null,
        },
      ])
    );
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      transaction_type: 'hsa_eligible',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
  });

  test('transaction_type=hsa_eligible returns empty when categoriesCache is empty', async () => {
    const nodes = [mkNode({ id: 't1', categoryId: 'cat-health' })];
    // mkLiveReturning pre-warms categoriesCache with [] — no category name resolution possible.
    const live = await mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      transaction_type: 'hsa_eligible',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    // With no categories in the cache, the name map is empty → no matches.
    expect(result.transactions).toEqual([]);
  });
});

describe('LiveTransactionsTools — _dropped_invalid_rows field', () => {
  test('get_transactions_live surfaces _dropped_invalid_rows only when > 0 (#512)', async () => {
    const { LiveCopilotDatabase: LiveDB } = await import('../../../src/core/live-database.js');
    type GQLClient = import('../../../src/core/graphql/client.js').GraphQLClient;
    type CopilotDB = import('../../../src/core/database.js').CopilotDatabase;

    // ── Dirty page: one valid node + one node with empty accountId ──────────
    const dirtyPage = {
      edges: [
        {
          cursor: 'c1',
          node: mkNode({ id: 'valid-1', date: '2025-01-15', accountId: 'a1', itemId: 'i1' }),
        },
        {
          cursor: 'c2',
          node: mkNode({ id: 'bad-1', date: '2025-01-16', accountId: '', itemId: 'i1' }),
        },
      ],
      pageInfo: { endCursor: null, hasNextPage: false },
    };
    const dirtyClient = {
      mutate: mock(),
      query: mock(() => Promise.resolve({ transactions: dirtyPage })),
    } as unknown as GQLClient;
    const sharedCache = {
      getAccounts: mock(() => Promise.resolve([])),
      getTags: mock(() => Promise.resolve([])),
    } as unknown as CopilotDB;
    const dirtyLive = new LiveDB(dirtyClient, sharedCache);
    await dirtyLive.getCategoriesCache().read(() => Promise.resolve([]));
    await dirtyLive.getTagsCache().read(() => Promise.resolve([]));
    const dirtyTools = new LiveTransactionsTools(dirtyLive);

    const result = await dirtyTools.getTransactions({
      start_date: '2025-01-01',
      end_date: '2025-01-31',
    });
    expect(result._dropped_invalid_rows).toBe(1);

    // ── Clean page: only valid nodes ────────────────────────────────────────
    const cleanPage = {
      edges: [
        {
          cursor: 'c1',
          node: mkNode({ id: 'ok-1', date: '2025-02-15', accountId: 'a1', itemId: 'i1' }),
        },
      ],
      pageInfo: { endCursor: null, hasNextPage: false },
    };
    const cleanClient = {
      mutate: mock(),
      query: mock(() => Promise.resolve({ transactions: cleanPage })),
    } as unknown as GQLClient;
    const cleanLive = new LiveDB(cleanClient, sharedCache);
    await cleanLive.getCategoriesCache().read(() => Promise.resolve([]));
    await cleanLive.getTagsCache().read(() => Promise.resolve([]));
    const cleanTools = new LiveTransactionsTools(cleanLive);

    const cleanResult = await cleanTools.getTransactions({
      start_date: '2025-02-01',
      end_date: '2025-02-28',
    });
    expect('_dropped_invalid_rows' in cleanResult).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Field selection (#597 live parity). Firestore-shaped opaque IDs on purpose —
// trivial id-equals-name fixtures mask resolution bugs.
// ---------------------------------------------------------------------------

const FS_TXN = 'txn_3hWq6MzNkP9RvX2cTb7D';
const FS_ACC = 'acc_2mVx7QpLcK9TzR4wNb8Y';
const FS_ITEM = 'item_5cJn3WfHbD8XqS1kMt6Z';
const FS_CAT = 'cat_9fKq2LmXbT7RwZ0pVsN1';

function mkFsNode(partial: Partial<TransactionNode> = {}): TransactionNode {
  return mkNode({
    id: FS_TXN,
    accountId: FS_ACC,
    itemId: FS_ITEM,
    categoryId: FS_CAT,
    amount: 100,
    name: 'Synthetic Grocer',
    ...partial,
  });
}

/** The 8 cache-preset names live rows actually carry (excluded and
 *  internal_transfer are cache-document-only — the v3 parity gap). */
const LIVE_PRESET_INTERSECTION = [
  'transaction_id',
  'date',
  'amount',
  'name',
  'category_name',
  'account_id',
  'item_id',
  'pending',
];

describe('LiveTransactionsTools — field selection (fields param)', () => {
  const range = { start_date: '2025-01-01', end_date: '2025-12-31' };

  test('fields omitted → full-width rows, no _field_warning key', async () => {
    const live = await mkLiveReturning([mkFsNode()]);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({ ...range });
    expect(result.count).toBe(1);
    expect(new Set(Object.keys(result.transactions[0]!))).toEqual(
      new Set([...LIVE_TRANSACTION_KNOWN_FIELDS])
    );
    expect('_field_warning' in result).toBe(false);
  });

  test('explicit fields list → only those keys, in original row-key order', async () => {
    const live = await mkLiveReturning([mkFsNode()]);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      ...range,
      fields: ['date', 'transaction_id', 'amount'],
    });
    // Engine preserves ORIGINAL row key order, not request order.
    expect(Object.keys(result.transactions[0]!)).toEqual(['transaction_id', 'amount', 'date']);
    expect(result.transactions[0]).toEqual({
      transaction_id: FS_TXN,
      amount: 100,
      date: '2025-06-01',
    } as never);
    expect('_field_warning' in result).toBe(false);
  });

  test('"default" token → the 8 preset names live rows carry, no warning for the 2 cache-only ones', async () => {
    const live = await mkLiveReturning([mkFsNode()]);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({ ...range, fields: ['default'] });
    expect(Object.keys(result.transactions[0]!).sort()).toEqual(
      [...LIVE_PRESET_INTERSECTION].sort()
    );
    // excluded/internal_transfer come from the preset (token expansion), not
    // an explicit request — their absence must NOT warn.
    expect('_field_warning' in result).toBe(false);
  });

  test('"default" plus an extra name → preset intersection + the extra', async () => {
    const live = await mkLiveReturning([mkFsNode()]);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      ...range,
      fields: ['default', 'user_notes'],
    });
    expect(Object.keys(result.transactions[0]!).sort()).toEqual(
      [...LIVE_PRESET_INTERSECTION, 'user_notes'].sort()
    );
  });

  test('"all" and "*" tokens → full rows (projection disabled)', async () => {
    const live = await mkLiveReturning([mkFsNode()]);
    const tools = new LiveTransactionsTools(live);
    for (const token of ['all', '*']) {
      const result = await tools.getTransactions({ ...range, fields: [token] });
      expect(new Set(Object.keys(result.transactions[0]!))).toEqual(
        new Set([...LIVE_TRANSACTION_KNOWN_FIELDS])
      );
      expect('_field_warning' in result).toBe(false);
    }
  });

  test('unknown name → _field_warning names it, rows omit it', async () => {
    const live = await mkLiveReturning([mkFsNode()]);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      ...range,
      fields: ['transaction_id', 'not_a_real_field'],
    });
    expect(result._field_warning).toContain('not_a_real_field');
    expect(Object.keys(result.transactions[0]!)).toEqual(['transaction_id']);
  });

  test('explicitly requesting cache-only preset names (excluded/internal_transfer) warns', async () => {
    // Pins the v3 parity gap: these 2 of the 10 DEFAULT_TRANSACTION_FIELDS
    // names are cache-document fields with no live-row equivalent, so an
    // EXPLICIT request for them is honestly reported as unknown here.
    const live = await mkLiveReturning([mkFsNode()]);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      ...range,
      fields: ['transaction_id', 'excluded', 'internal_transfer'],
    });
    // Assert the ignored-list itself (not just substring presence — the hint
    // below also mentions both names) AND the cache-mode redirect, so a
    // mode-switching caller is told these are real fields elsewhere.
    expect(result._field_warning).toContain(
      'Unknown field name(s) ignored: excluded, internal_transfer'
    );
    expect(result._field_warning).toContain(
      'excluded and internal_transfer exist only in cache-mode get_transactions'
    );
    expect(Object.keys(result.transactions[0]!)).toEqual(['transaction_id']);
  });

  test('empty fields array → no projection (engine semantics, matches cache mode)', async () => {
    const live = await mkLiveReturning([mkFsNode()]);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({ ...range, fields: [] });
    expect(new Set(Object.keys(result.transactions[0]!))).toEqual(
      new Set([...LIVE_TRANSACTION_KNOWN_FIELDS])
    );
  });

  test('category_name is selectable and resolves through the category map', async () => {
    const live = await mkLiveReturning([mkFsNode()]);
    live.getCategoriesCache().invalidate();
    await live.getCategoriesCache().read(() =>
      Promise.resolve([
        {
          id: FS_CAT,
          name: 'Groceries',
          templateId: 'Groceries',
          colorName: null,
          icon: null,
          isExcluded: false,
          isRolloverDisabled: false,
          canBeDeleted: true,
          budget: null,
        },
      ])
    );
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      ...range,
      fields: ['transaction_id', 'category_name'],
    });
    expect(result.transactions[0]).toEqual({
      transaction_id: FS_TXN,
      category_name: 'Groceries',
    } as never);
  });

  test('transaction_id lookup path applies projection', async () => {
    const live = await mkLiveReturning([mkFsNode()]);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      transaction_id: FS_TXN,
      account_id: FS_ACC,
      item_id: FS_ITEM,
      ...range,
      fields: ['transaction_id', 'amount'],
    });
    expect(result.count).toBe(1);
    expect(Object.keys(result.transactions[0]!)).toEqual(['transaction_id', 'amount']);
  });

  test('transaction_id lookup path surfaces _field_warning on unknown names', async () => {
    const live = await mkLiveReturning([mkFsNode()]);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      transaction_id: FS_TXN,
      account_id: FS_ACC,
      item_id: FS_ITEM,
      ...range,
      fields: ['transaction_id', 'zzz_typo'],
    });
    expect(result._field_warning).toContain('zzz_typo');
    expect(Object.keys(result.transactions[0]!)).toEqual(['transaction_id']);
  });

  test('transaction_id lookup not-found → empty result, no _field_warning (matches cache mode)', async () => {
    const live = await mkLiveReturning([mkFsNode()]);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      transaction_id: 'txn_0MissingMissingMiss0',
      account_id: FS_ACC,
      item_id: FS_ITEM,
      ...range,
      fields: ['transaction_id', 'zzz_typo'],
    });
    expect(result.count).toBe(0);
    expect('_field_warning' in result).toBe(false);
  });
});

describe('LIVE_TRANSACTION_KNOWN_FIELDS — derived from the enrichment mapper', () => {
  test('exactly matches the keys of a full enriched row', async () => {
    const live = await mkLiveReturning([mkFsNode()]);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({
      start_date: '2025-01-01',
      end_date: '2025-12-31',
    });
    expect(new Set(Object.keys(result.transactions[0]!))).toEqual(
      new Set([...LIVE_TRANSACTION_KNOWN_FIELDS])
    );
  });

  test('covers 8 of the 10 DEFAULT_TRANSACTION_FIELDS preset names (the v3 parity gap)', () => {
    for (const name of LIVE_PRESET_INTERSECTION) {
      expect(LIVE_TRANSACTION_KNOWN_FIELDS.has(name)).toBe(true);
    }
    // Cache-document-only flags — live rows model transfers via type ===
    // 'INTERNAL_TRANSFER' and exclusion via Category.isExcluded instead.
    expect(LIVE_TRANSACTION_KNOWN_FIELDS.has('excluded')).toBe(false);
    expect(LIVE_TRANSACTION_KNOWN_FIELDS.has('internal_transfer')).toBe(false);
  });
});

describe('get_transactions_live fields param — parity with get_transactions', () => {
  // Compare through the REGISTRY defs (what the server actually lists), not
  // the shared constant, so forking either side back to a private copy that
  // then drifts fails here.
  const cacheFragment = getTransactionsTool.schema.inputSchema.properties.fields as {
    type: string;
    items: { type: string };
    description: string;
  };
  const liveFragment = getTransactionsLiveTool.schema.inputSchema.properties.fields as {
    type: string;
    items: { type: string };
    description: string;
  };

  test('both tools expose a fields param', () => {
    expect(cacheFragment).toBeDefined();
    expect(liveFragment).toBeDefined();
  });

  test('fields param fragment (type + items + description) is IDENTICAL across modes', () => {
    expect(JSON.parse(JSON.stringify(liveFragment))).toEqual(
      JSON.parse(JSON.stringify(cacheFragment))
    );
  });

  test('fragment is non-vacuous: array of strings, description covers tokens and _field_warning', () => {
    expect(cacheFragment.type).toBe('array');
    expect(cacheFragment.items).toEqual({ type: 'string' });
    expect(cacheFragment.description).toContain('"default"');
    expect(cacheFragment.description).toContain('"all"');
    expect(cacheFragment.description).toContain('"*"');
    expect(cacheFragment.description).toContain('_field_warning');
  });

  test('live tool does NOT grow a compact param (retired in v3; tokens cover it)', () => {
    expect(getTransactionsLiveTool.schema.inputSchema.properties.compact).toBeUndefined();
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
    const live = await mkLiveReturning([]);
    const tools = new LiveTransactionsTools(live);
    await expect(
      tools.getTransactions({ query: 'amazon', period: 'this_month' })
    ).resolves.toBeDefined();
  });

  test('does NOT throw when query is set with explicit dates', async () => {
    const live = await mkLiveReturning([]);
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
    const live = await mkLiveReturning([mkNode({ id: 't1', accountId: 'a1', itemId: 'i1' })]);
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
