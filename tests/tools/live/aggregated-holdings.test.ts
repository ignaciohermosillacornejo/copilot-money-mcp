import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import { CopilotDatabase } from '../../../src/core/database.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import { LiveAggregatedHoldingsTools } from '../../../src/tools/live/aggregated-holdings.js';

function makeClient(rows: unknown[]): GraphQLClient {
  return {
    query: mock(() => Promise.resolve({ aggregatedHoldings: rows })),
  } as unknown as GraphQLClient;
}
function makeLive(client: GraphQLClient): LiveCopilotDatabase {
  return new LiveCopilotDatabase(client, new CopilotDatabase('/tmp/no-such-db'));
}

const holding = {
  security: {
    id: 'sec-1',
    name: 'Acme Corp',
    symbol: 'ACME',
    type: 'EQUITY',
    lastUpdate: '2026-07-14',
    marketInfo: { closeTime: null, openTime: null },
  },
  value: 12500,
  change: 300,
};

describe('LiveAggregatedHoldingsTools.getAggregatedHoldings', () => {
  test('projects rows to {security_id, ticker_symbol, name, type, value, change}', async () => {
    const client = makeClient([holding]);
    const tools = new LiveAggregatedHoldingsTools(makeLive(client));
    const result = await tools.getAggregatedHoldings({});
    expect(result.count).toBe(1);
    expect(result.time_frame).toBe('ONE_MONTH');
    expect(result.holdings[0]).toEqual({
      security_id: 'sec-1',
      ticker_symbol: 'ACME',
      name: 'Acme Corp',
      type: 'EQUITY',
      value: 12500,
      change: 300,
    });
  });

  test('empty result returns count=0 without throwing', async () => {
    const client = makeClient([]);
    const tools = new LiveAggregatedHoldingsTools(makeLive(client));
    const result = await tools.getAggregatedHoldings({});
    expect(result.count).toBe(0);
    expect(result.holdings).toEqual([]);
  });

  test('default time_frame ONE_MONTH; no scope → passes timeFrame only', async () => {
    const client = makeClient([holding]);
    const tools = new LiveAggregatedHoldingsTools(makeLive(client));
    await tools.getAggregatedHoldings({});
    const q = client.query as ReturnType<typeof mock>;
    const callArgs = q.mock.calls[0] as unknown[];
    expect(callArgs[0]).toBe('AggregatedHoldings');
    expect(callArgs[2]).toEqual({
      timeFrame: 'ONE_MONTH',
      accountId: undefined,
      itemId: undefined,
    });
  });

  test('explicit time_frame + account_id build the query variables', async () => {
    const client = makeClient([holding]);
    const tools = new LiveAggregatedHoldingsTools(makeLive(client));
    const result = await tools.getAggregatedHoldings({
      time_frame: 'ONE_YEAR',
      account_id: 'acct-1',
    });
    expect(result.time_frame).toBe('ONE_YEAR');
    const q = client.query as ReturnType<typeof mock>;
    expect((q.mock.calls[0] as unknown[])[2]).toEqual({
      timeFrame: 'ONE_YEAR',
      accountId: 'acct-1',
      itemId: undefined,
    });
  });

  test('warm call returns cached data with _cache_hit=true and no second fetch', async () => {
    const client = makeClient([holding]);
    const tools = new LiveAggregatedHoldingsTools(makeLive(client));
    const first = await tools.getAggregatedHoldings({});
    const second = await tools.getAggregatedHoldings({});
    expect(first._cache_hit).toBe(false);
    expect(second._cache_hit).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('changing time_frame invalidates the cache and refetches', async () => {
    const client = makeClient([holding]);
    const tools = new LiveAggregatedHoldingsTools(makeLive(client));
    await tools.getAggregatedHoldings({ time_frame: 'ONE_MONTH' });
    await tools.getAggregatedHoldings({ time_frame: 'ONE_YEAR' });
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  test('changing scope (account_id) invalidates the cache and refetches', async () => {
    const client = makeClient([holding]);
    const tools = new LiveAggregatedHoldingsTools(makeLive(client));
    await tools.getAggregatedHoldings({});
    await tools.getAggregatedHoldings({ account_id: 'acct-1' });
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  test('cache metadata: ISO strings, oldest === newest', async () => {
    const client = makeClient([holding]);
    const tools = new LiveAggregatedHoldingsTools(makeLive(client));
    const result = await tools.getAggregatedHoldings({});
    expect(result._cache_oldest_fetched_at).toBe(result._cache_newest_fetched_at);
    expect(result._cache_oldest_fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('createLiveAggregatedHoldingsToolSchema', () => {
  test('schema: name, readOnlyHint, time_frame enum = ALL_TIME_FRAMES, no required', async () => {
    const { createLiveAggregatedHoldingsToolSchema } =
      await import('../../../src/tools/live/aggregated-holdings.js');
    const { ALL_TIME_FRAMES } = await import('../../../src/core/graphql/queries/_shared.js');
    const schema = createLiveAggregatedHoldingsToolSchema();
    expect(schema.name).toBe('get_aggregated_holdings_live');
    expect(schema.annotations?.readOnlyHint).toBe(true);
    const props = schema.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.time_frame?.enum).toEqual([...ALL_TIME_FRAMES]);
    expect((schema.inputSchema as { required?: string[] }).required ?? []).toEqual([]);
  });
});
