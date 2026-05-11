import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import { CopilotDatabase } from '../../../src/core/database.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import { LiveHoldingsTools } from '../../../src/tools/live/holdings.js';

function makeClient(rows: unknown[]): GraphQLClient {
  return {
    query: mock(() => Promise.resolve({ holdings: rows })),
  } as unknown as GraphQLClient;
}

function makeLive(client: GraphQLClient): LiveCopilotDatabase {
  return new LiveCopilotDatabase(client, new CopilotDatabase('/tmp/no-such-db'));
}

const equityHolding = {
  id: 'h-equity',
  accountId: 'acct-1',
  itemId: 'item-1',
  quantity: 10,
  security: {
    id: 'sec-equity',
    name: 'Acme Corp',
    symbol: 'ACME',
    type: 'EQUITY',
    currentPrice: 100,
    lastUpdate: '2026-05-04',
    marketInfo: { closeTime: null, openTime: null },
  },
  metrics: {
    averageCost: 80,
    costBasis: 800,
    totalReturn: 200,
  },
};

const mutualFundHolding = {
  id: 'h-mf',
  accountId: 'acct-1',
  itemId: 'item-1',
  quantity: 5,
  security: {
    id: 'sec-mf',
    name: 'Index Fund',
    symbol: 'IDX',
    type: 'MUTUAL_FUND',
    currentPrice: 200,
    lastUpdate: '2026-05-04',
    marketInfo: { closeTime: null, openTime: null },
  },
  metrics: {
    averageCost: 150,
    costBasis: 750,
    totalReturn: 250,
  },
};

const cashHolding = {
  id: 'h-cash',
  accountId: 'acct-2',
  itemId: 'item-2',
  quantity: 562.5,
  security: {
    id: 'sec-cash',
    name: 'USD Cash',
    symbol: 'USD',
    type: 'CASH',
    currentPrice: 1,
    lastUpdate: '2026-05-04',
    marketInfo: { closeTime: null, openTime: null },
  },
  metrics: null,
};

describe('LiveHoldingsTools.getHoldings', () => {
  test('projects equity/mutual-fund metrics and computes institution_value + return %', async () => {
    const client = makeClient([equityHolding, mutualFundHolding, cashHolding]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({});

    expect(result.count).toBe(3);
    expect(result.total_count).toBe(3);
    expect(result.has_more).toBe(false);
    expect(result.holdings).toHaveLength(3);

    const equity = result.holdings.find((h) => h.security_id === 'sec-equity');
    expect(equity).toBeDefined();
    expect(equity?.ticker_symbol).toBe('ACME');
    expect(equity?.type).toBe('EQUITY');
    expect(equity?.account_id).toBe('acct-1');
    expect(equity?.item_id).toBe('item-1');
    expect(equity?.quantity).toBe(10);
    expect(equity?.institution_price).toBe(100);
    // 10 * 100 = 1000
    expect(equity?.institution_value).toBe(1000);
    expect(equity?.cost_basis).toBe(800);
    expect(equity?.average_cost).toBe(80);
    expect(equity?.total_return).toBe(200);
    // (200 / 800) * 100 = 25
    expect(equity?.total_return_percent).toBe(25);
    expect(equity?.is_cash_equivalent).toBe(false);

    const mf = result.holdings.find((h) => h.security_id === 'sec-mf');
    expect(mf?.institution_value).toBe(1000); // 5 * 200
    expect(mf?.cost_basis).toBe(750);
    // (250 / 750) * 100 = 33.33
    expect(mf?.total_return_percent).toBe(33.33);
  });

  test('CASH holding has is_cash_equivalent=true and omits metric-derived fields', async () => {
    const client = makeClient([cashHolding]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({});

    expect(result.count).toBe(1);
    const cash = result.holdings[0];
    expect(cash?.is_cash_equivalent).toBe(true);
    expect(cash?.institution_value).toBe(562.5);
    expect(cash?.cost_basis).toBeUndefined();
    expect(cash?.average_cost).toBeUndefined();
    expect(cash?.total_return).toBeUndefined();
    expect(cash?.total_return_percent).toBeUndefined();
  });

  test('filters by account_id (exact match)', async () => {
    const client = makeClient([equityHolding, mutualFundHolding, cashHolding]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({ account_id: 'acct-2' });

    expect(result.count).toBe(1);
    expect(result.total_count).toBe(1);
    expect(result.holdings[0]?.security_id).toBe('sec-cash');
  });

  test('filters by ticker_symbol case-insensitively', async () => {
    const client = makeClient([equityHolding, mutualFundHolding, cashHolding]);
    const tools = new LiveHoldingsTools(makeLive(client));

    // Lowercase input must match uppercase server symbol.
    const result = await tools.getHoldings({ ticker_symbol: 'acme' });

    expect(result.count).toBe(1);
    expect(result.holdings[0]?.ticker_symbol).toBe('ACME');
  });

  test('pagination: limit + offset produce correct count / total_count / has_more', async () => {
    const client = makeClient([equityHolding, mutualFundHolding, cashHolding]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({ limit: 2, offset: 0 });

    expect(result.count).toBe(2);
    expect(result.total_count).toBe(3);
    expect(result.offset).toBe(0);
    expect(result.has_more).toBe(true);

    const next = await tools.getHoldings({ limit: 2, offset: 2 });
    expect(next.count).toBe(1);
    expect(next.total_count).toBe(3);
    expect(next.offset).toBe(2);
    expect(next.has_more).toBe(false);
  });

  test('warm call returns same data with _cache_hit=true and no second fetch', async () => {
    const client = makeClient([equityHolding]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const first = await tools.getHoldings({});
    const second = await tools.getHoldings({});

    expect(first._cache_hit).toBe(false);
    expect(second._cache_hit).toBe(true);
    expect(second.holdings[0]?.security_id).toBe('sec-equity');
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('cache metadata: ISO strings, oldest === newest on a single-snapshot fetch', async () => {
    const client = makeClient([equityHolding]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({});

    expect(typeof result._cache_oldest_fetched_at).toBe('string');
    expect(typeof result._cache_newest_fetched_at).toBe('string');
    expect(result._cache_oldest_fetched_at).toBe(result._cache_newest_fetched_at);
    // ISO 8601 sanity check.
    expect(result._cache_oldest_fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('degenerate cost_basis=0 does not produce Infinity/NaN total_return_percent', async () => {
    const zeroBasis = {
      ...equityHolding,
      id: 'h-zero',
      metrics: { averageCost: 0, costBasis: 0, totalReturn: 10 },
    };
    const client = makeClient([zeroBasis]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({});

    const entry = result.holdings[0];
    expect(entry?.cost_basis).toBe(0);
    expect(entry?.total_return).toBe(10);
    expect(entry?.total_return_percent).toBeUndefined();
  });

  test('passes correct operation name and empty variables to GraphQLClient.query', async () => {
    const client = makeClient([equityHolding]);
    const tools = new LiveHoldingsTools(makeLive(client));

    await tools.getHoldings({});

    expect(client.query).toHaveBeenCalledTimes(1);
    const queryMock = client.query as ReturnType<typeof mock>;
    const callArgs = queryMock.mock.calls[0] as unknown[];
    expect(callArgs[0]).toBe('Holdings');
    expect(typeof callArgs[1]).toBe('string');
    expect(callArgs[2]).toEqual({});
  });

  test('empty result returns count=0 without throwing', async () => {
    const client = makeClient([]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({});

    expect(result.count).toBe(0);
    expect(result.total_count).toBe(0);
    expect(result.holdings).toEqual([]);
    expect(result.has_more).toBe(false);
  });
});

describe('createLiveHoldingsToolSchema', () => {
  test('returns a schema with readOnlyHint=true and the expected tool name', async () => {
    const { createLiveHoldingsToolSchema } = await import(
      '../../../src/tools/live/holdings.js'
    );
    const schema = createLiveHoldingsToolSchema();
    expect(schema.name).toBe('get_holdings_live');
    expect(schema.annotations?.readOnlyHint).toBe(true);
  });

  test('declares optional account_id, ticker_symbol, limit, offset (no required)', async () => {
    const { createLiveHoldingsToolSchema } = await import(
      '../../../src/tools/live/holdings.js'
    );
    const schema = createLiveHoldingsToolSchema();
    const props = schema.inputSchema.properties as Record<string, { type: string }>;
    expect(props.account_id?.type).toBe('string');
    expect(props.ticker_symbol?.type).toBe('string');
    expect(props.limit?.type).toBe('number');
    expect(props.offset?.type).toBe('number');
    // All filters are opt-in.
    expect((schema.inputSchema as { required?: string[] }).required ?? []).toEqual([]);
  });
});
