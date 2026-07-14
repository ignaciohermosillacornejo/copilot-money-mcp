import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import { CopilotDatabase } from '../../../src/core/database.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import { LiveTopMoversTools } from '../../../src/tools/live/top-movers.js';

function makeClient(rows: unknown[]): GraphQLClient {
  return {
    query: mock(() => Promise.resolve({ topMovers: rows })),
  } as unknown as GraphQLClient;
}
function makeLive(client: GraphQLClient): LiveCopilotDatabase {
  return new LiveCopilotDatabase(client, new CopilotDatabase('/tmp/no-such-db'));
}

const mover = {
  security: {
    id: 'sec-1',
    name: 'Acme Corp',
    symbol: 'ACME',
    type: 'EQUITY',
    currentPrice: 100,
    lastUpdate: '2026-07-13',
    marketInfo: { closeTime: null, openTime: null },
  },
  values: [
    { id: 'p1', timestamp: 1752000000000, price: 98 },
    { id: 'p2', timestamp: 1752086400000, price: 100 },
  ],
  change: 2.5,
};

describe('LiveTopMoversTools.getTopMovers', () => {
  test('projects rows to {security_id, ticker_symbol, name, type, change, price_points}', async () => {
    const client = makeClient([mover]);
    const tools = new LiveTopMoversTools(makeLive(client));
    const result = await tools.getTopMovers({});
    expect(result.count).toBe(1);
    expect(result.filter).toBe('MY_EQUITY_CHANGE');
    expect(result.movers[0]).toEqual({
      security_id: 'sec-1',
      ticker_symbol: 'ACME',
      name: 'Acme Corp',
      type: 'EQUITY',
      change: 2.5,
      price_points: [
        { timestamp: 1752000000000, price: 98 },
        { timestamp: 1752086400000, price: 100 },
      ],
    });
  });

  test('empty result returns count=0 without throwing', async () => {
    const client = makeClient([]);
    const tools = new LiveTopMoversTools(makeLive(client));
    const result = await tools.getTopMovers({});
    expect(result.count).toBe(0);
    expect(result.movers).toEqual([]);
  });

  test('default filter is MY_EQUITY_CHANGE; passed as the query variable', async () => {
    const client = makeClient([mover]);
    const tools = new LiveTopMoversTools(makeLive(client));
    await tools.getTopMovers({});
    const q = client.query as ReturnType<typeof mock>;
    const callArgs = q.mock.calls[0] as unknown[];
    expect(callArgs[0]).toBe('TopMovers');
    expect(callArgs[2]).toEqual({ filter: 'MY_EQUITY_CHANGE' });
  });

  test('explicit filter PRICE_CHANGE is passed through', async () => {
    const client = makeClient([mover]);
    const tools = new LiveTopMoversTools(makeLive(client));
    const result = await tools.getTopMovers({ filter: 'PRICE_CHANGE' });
    expect(result.filter).toBe('PRICE_CHANGE');
    const q = client.query as ReturnType<typeof mock>;
    expect((q.mock.calls[0] as unknown[])[2]).toEqual({ filter: 'PRICE_CHANGE' });
  });

  test('warm call returns cached data with _cache_hit=true and no second fetch', async () => {
    const client = makeClient([mover]);
    const tools = new LiveTopMoversTools(makeLive(client));
    const first = await tools.getTopMovers({});
    const second = await tools.getTopMovers({});
    expect(first._cache_hit).toBe(false);
    expect(second._cache_hit).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('changing filter invalidates the cache and refetches', async () => {
    const client = makeClient([mover]);
    const tools = new LiveTopMoversTools(makeLive(client));
    await tools.getTopMovers({ filter: 'MY_EQUITY_CHANGE' });
    await tools.getTopMovers({ filter: 'PRICE_CHANGE' });
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  test('cache metadata: ISO strings, oldest === newest', async () => {
    const client = makeClient([mover]);
    const tools = new LiveTopMoversTools(makeLive(client));
    const result = await tools.getTopMovers({});
    expect(result._cache_oldest_fetched_at).toBe(result._cache_newest_fetched_at);
    expect(result._cache_oldest_fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('createLiveTopMoversToolSchema', () => {
  test('schema: name, readOnlyHint, filter enum, no required', async () => {
    const { createLiveTopMoversToolSchema } = await import('../../../src/tools/live/top-movers.js');
    const schema = createLiveTopMoversToolSchema();
    expect(schema.name).toBe('get_top_movers_live');
    expect(schema.annotations?.readOnlyHint).toBe(true);
    const props = schema.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.filter?.enum).toEqual(['PRICE_CHANGE', 'MY_EQUITY_CHANGE']);
    expect((schema.inputSchema as { required?: string[] }).required ?? []).toEqual([]);
  });
});
