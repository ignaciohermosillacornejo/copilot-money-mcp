import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import { CopilotDatabase } from '../../../src/core/database.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import { LiveNetworthTools } from '../../../src/tools/live/networth.js';

function makeClient(rows: unknown[]): GraphQLClient {
  return {
    query: mock(() => Promise.resolve({ networthHistory: rows })),
  } as unknown as GraphQLClient;
}

function makeLive(client: GraphQLClient): LiveCopilotDatabase {
  return new LiveCopilotDatabase(client, new CopilotDatabase('/tmp/no-such-db'));
}

const sampleRow = { date: '2026-01-01', assets: '100000', debt: '5000' };

describe('LiveNetworthTools.getNetworth', () => {
  test('cold call: fetches and returns rows with cache_hit=false', async () => {
    const client = makeClient([sampleRow]);
    const tools = new LiveNetworthTools(makeLive(client));

    const result = await tools.getNetworth({});

    expect(result.count).toBe(1);
    expect(result.networth_history[0]?.date).toBe('2026-01-01');
    expect(result.networth_history[0]?.assets).toBe('100000');
    expect(result.networth_history[0]?.debt).toBe('5000');
    expect(result._cache_hit).toBe(false);
    expect(typeof result._cache_oldest_fetched_at).toBe('string');
    expect(typeof result._cache_newest_fetched_at).toBe('string');
  });

  test('warm call with same timeFrame: cache hit, no second fetch', async () => {
    const client = makeClient([sampleRow]);
    const tools = new LiveNetworthTools(makeLive(client));

    await tools.getNetworth({});
    const second = await tools.getNetworth({});

    expect(second._cache_hit).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('empty result returns count 0, no throw', async () => {
    const client = makeClient([]);
    const tools = new LiveNetworthTools(makeLive(client));

    const result = await tools.getNetworth({});

    expect(result.count).toBe(0);
    expect(result.networth_history).toEqual([]);
  });

  test('output sorted oldest→newest by date', async () => {
    const client = makeClient([
      { date: '2026-03-01', assets: '300', debt: '30' },
      { date: '2026-01-01', assets: '100', debt: '10' },
      { date: '2026-02-01', assets: '200', debt: '20' },
    ]);
    const tools = new LiveNetworthTools(makeLive(client));

    const result = await tools.getNetworth({});

    expect(result.networth_history.map((n) => n.date)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ]);
  });

  test('default timeFrame is "ALL" when not provided', async () => {
    const client = makeClient([]);
    const tools = new LiveNetworthTools(makeLive(client));

    await tools.getNetworth({});

    expect(client.query).toHaveBeenCalledWith('Networth', expect.any(String), {
      timeFrame: 'ALL',
    });
  });

  test('passes through caller-supplied timeFrame', async () => {
    const client = makeClient([]);
    const tools = new LiveNetworthTools(makeLive(client));

    await tools.getNetworth({ time_frame: 'YEAR' });

    expect(client.query).toHaveBeenCalledWith('Networth', expect.any(String), {
      timeFrame: 'YEAR',
    });
  });

  test('different timeFrame triggers a fresh fetch (cache invalidated)', async () => {
    const client = makeClient([sampleRow]);
    const tools = new LiveNetworthTools(makeLive(client));

    await tools.getNetworth({ time_frame: 'ALL' });
    const second = await tools.getNetworth({ time_frame: 'YEAR' });

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(second._cache_hit).toBe(false);
  });

  test('preserves null assets/debt in passthrough (early dates)', async () => {
    const client = makeClient([{ date: '2022-09-13', assets: null, debt: '500' }]);
    const tools = new LiveNetworthTools(makeLive(client));

    const result = await tools.getNetworth({});

    expect(result.networth_history[0]?.assets).toBeNull();
    expect(result.networth_history[0]?.debt).toBe('500');
  });
});

describe('createLiveNetworthToolSchema', () => {
  test('returns a schema with readOnlyHint=true and time_frame arg', async () => {
    const { createLiveNetworthToolSchema } = await import('../../../src/tools/live/networth.js');
    const schema = createLiveNetworthToolSchema();
    expect(schema.name).toBe('get_networth_live');
    expect(schema.annotations?.readOnlyHint).toBe(true);
    expect(schema.inputSchema.properties).toHaveProperty('time_frame');
  });
});
