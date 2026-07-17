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

const sampleRow = { date: '2026-01-01', assets: 100000, debt: 5000 };

describe('LiveNetworthTools.getNetworth', () => {
  test('cold call: fetches and returns rows with cache_hit=false', async () => {
    const client = makeClient([sampleRow]);
    const tools = new LiveNetworthTools(makeLive(client));

    const result = await tools.getNetworth({});

    expect(result.count).toBe(1);
    expect(result.total_rows).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.networth_history[0]?.date).toBe('2026-01-01');
    expect(result.networth_history[0]?.assets).toBe(100000);
    expect(result.networth_history[0]?.debt).toBe(5000);
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
      { date: '2026-03-01', assets: 300, debt: 30 },
      { date: '2026-01-01', assets: 100, debt: 10 },
      { date: '2026-02-01', assets: 200, debt: 20 },
    ]);
    const tools = new LiveNetworthTools(makeLive(client));

    const result = await tools.getNetworth({});

    expect(result.networth_history.map((n) => n.date)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ]);
  });

  test('default timeFrame is "YTD" when not provided', async () => {
    // Tightened on 2026-05 from ALL → YTD so the default response stays
    // under the MCP single-tool-result token cap (issue #380). Callers
    // wanting full history must pass time_frame: 'ALL' explicitly.
    const client = makeClient([]);
    const tools = new LiveNetworthTools(makeLive(client));

    await tools.getNetworth({});

    expect(client.query).toHaveBeenCalledWith('Networth', expect.any(String), {
      timeFrame: 'YTD',
    });
  });

  test('explicit time_frame=ALL still works (opt-in to full history)', async () => {
    const client = makeClient([]);
    const tools = new LiveNetworthTools(makeLive(client));

    await tools.getNetworth({ time_frame: 'ALL' });

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

  test('caps at default max_rows=500 and reports truncated=true', async () => {
    const bigRows = Array.from({ length: 1500 }, (_, i) => ({
      date: `2025-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 30) + 1).padStart(2, '0')}`,
      assets: 100 + i,
      debt: 10 + i,
    }));
    const client = makeClient(bigRows);
    const tools = new LiveNetworthTools(makeLive(client));

    const result = await tools.getNetworth({ time_frame: 'ALL' });

    expect(result.total_rows).toBe(1500);
    expect(result.count).toBe(500);
    expect(result.truncated).toBe(true);
    // Sliced to MOST RECENT (tail of ascending series).
    expect(result.networth_history[0]?.assets).toBe(100 + 1000);
    expect(result.networth_history[499]?.assets).toBe(100 + 1499);
  });

  test('offset=500 returns the next-most-recent batch', async () => {
    const bigRows = Array.from({ length: 1500 }, (_, i) => ({
      date: `2025-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 30) + 1).padStart(2, '0')}`,
      assets: 100 + i,
      debt: 10 + i,
    }));
    const client = makeClient(bigRows);
    const tools = new LiveNetworthTools(makeLive(client));

    const result = await tools.getNetworth({
      time_frame: 'ALL',
      max_rows: 500,
      offset: 500,
    });

    expect(result.count).toBe(500);
    expect(result.total_rows).toBe(1500);
    expect(result.truncated).toBe(true);
    expect(result.networth_history[0]?.assets).toBe(100 + 500);
  });

  test('offset beyond total returns empty rows without throwing', async () => {
    const client = makeClient([sampleRow]);
    const tools = new LiveNetworthTools(makeLive(client));

    const result = await tools.getNetworth({ max_rows: 100, offset: 5000 });

    expect(result.count).toBe(0);
    expect(result.networth_history).toEqual([]);
    expect(result.total_rows).toBe(1);
  });

  test('preserves null assets/debt in passthrough (early dates)', async () => {
    const client = makeClient([{ date: '2022-09-13', assets: null, debt: 500 }]);
    const tools = new LiveNetworthTools(makeLive(client));

    const result = await tools.getNetworth({});

    expect(result.networth_history[0]?.assets).toBeNull();
    expect(result.networth_history[0]?.debt).toBe(500);
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

  test('time_frame default is "YTD" (tightened from ALL on 2026-05)', async () => {
    const { createLiveNetworthToolSchema } = await import('../../../src/tools/live/networth.js');
    const schema = createLiveNetworthToolSchema();
    const props = schema.inputSchema.properties as Record<
      string,
      { type: string; default?: string | number; enum?: string[] }
    >;
    expect(props.time_frame?.default).toBe('YTD');
    // Description should explain the change so callers can find context.
    expect(schema.description).toMatch(/YTD/);
  });

  test('time_frame enum equals the canonical TimeFrame set and excludes bogus MONTH/YEAR (#494)', async () => {
    const { createLiveNetworthToolSchema } = await import('../../../src/tools/live/networth.js');
    const { ALL_TIME_FRAMES } = await import('../../../src/core/graphql/queries/_shared.js');
    const schema = createLiveNetworthToolSchema();
    const props = schema.inputSchema.properties as Record<string, { enum?: string[] }>;
    // Networth uses the same canonical TimeFrame GraphQL enum as the other
    // live time-series tools — bare MONTH/YEAR are not members and 400 on use.
    expect(props.time_frame?.enum).toEqual([...ALL_TIME_FRAMES]);
    expect(props.time_frame?.enum).not.toContain('MONTH');
    expect(props.time_frame?.enum).not.toContain('YEAR');
  });

  test('exposes max_rows and offset pagination args', async () => {
    const { createLiveNetworthToolSchema } = await import('../../../src/tools/live/networth.js');
    const schema = createLiveNetworthToolSchema();
    const props = schema.inputSchema.properties as Record<
      string,
      { type: string; default?: number }
    >;
    expect(props.max_rows?.type).toBe('integer');
    expect(props.max_rows?.default).toBe(500);
    expect(props.offset?.type).toBe('integer');
    expect(props.offset?.default).toBe(0);
  });
});
