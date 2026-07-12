import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import { GraphQLError } from '../../../src/core/graphql/client.js';
import { CopilotDatabase } from '../../../src/core/database.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import {
  LiveInvestmentPricesTools,
  createLiveInvestmentPricesToolSchema,
} from '../../../src/tools/live/investment-prices.js';

const SECURITY_ID = 'sec-A';

const dailyRows = [
  { id: SECURITY_ID, price: 100, date: '2026-01-01' },
  { id: SECURITY_ID, price: 101, date: '2026-01-02' },
  { id: SECURITY_ID, price: 102, date: '2026-01-03' },
  { id: SECURITY_ID, price: 103, date: '2026-01-04' },
  { id: SECURITY_ID, price: 104, date: '2026-01-05' },
];

const intradayRows = [
  { id: SECURITY_ID, price: 100, timestamp: 1_700_000_000_000 },
  { id: SECURITY_ID, price: 101, timestamp: 1_700_000_060_000 },
  { id: SECURITY_ID, price: 102, timestamp: 1_700_000_120_000 },
];

interface FakeQueryConfig {
  daily?: unknown[];
  intraday?: unknown[];
  /** When set, the next call to either operation throws this error. */
  throwOnce?: Error;
}

function makeClient(config: FakeQueryConfig): GraphQLClient {
  let pending = config.throwOnce;
  return {
    query: mock((operationName: string) => {
      if (pending) {
        const e = pending;
        pending = undefined;
        return Promise.reject(e);
      }
      if (operationName === 'SecurityPrices') {
        return Promise.resolve({ securityPrices: config.daily ?? [] });
      }
      if (operationName === 'SecurityPricesHighFrequency') {
        return Promise.resolve({ securityPricesHighFrequency: config.intraday ?? [] });
      }
      return Promise.reject(new Error(`unexpected operation: ${operationName}`));
    }),
  } as unknown as GraphQLClient;
}

function makeLive(client: GraphQLClient): LiveCopilotDatabase {
  return new LiveCopilotDatabase(client, new CopilotDatabase('/tmp/no-such-db'));
}

describe('LiveInvestmentPricesTools.getInvestmentPrices — happy daily path', () => {
  test('returns granularity=daily with `date` populated and `timestamp` absent', async () => {
    const client = makeClient({ daily: dailyRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    const result = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_MONTH',
    });

    expect(result.granularity).toBe('daily');
    expect(result.count).toBe(5);
    expect(result.total_rows).toBe(5);
    expect(result.truncated).toBe(false);
    expect(result.prices).toHaveLength(5);
    for (const row of result.prices) {
      expect(typeof row.price).toBe('number');
      expect(typeof row.date).toBe('string');
      expect(row.timestamp).toBeUndefined();
    }
    expect(result._cache_hit).toBe(false);
    expect(result._cache_oldest_fetched_at).toBe(result._cache_newest_fetched_at);
    expect(result._cache_oldest_fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('default time_frame routes to daily SecurityPrices', async () => {
    const client = makeClient({ daily: dailyRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    const result = await tools.getInvestmentPrices({ security_id: SECURITY_ID });

    expect(result.granularity).toBe('daily');
    const queryMock = client.query as ReturnType<typeof mock>;
    expect(queryMock.mock.calls[0]?.[0]).toBe('SecurityPrices');
  });

  test('daily: null-price points are dropped from the series (#534)', async () => {
    const client = makeClient({
      daily: [
        { id: SECURITY_ID, price: null, date: '2026-01-01' }, // un-priceable gap day
        { id: SECURITY_ID, price: 101, date: '2026-01-02' },
        { id: SECURITY_ID, price: 102, date: '2026-01-03' },
      ],
    });
    const tools = new LiveInvestmentPricesTools(makeLive(client));
    const result = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_MONTH',
    });
    expect(result.granularity).toBe('daily');
    expect(result.count).toBe(2);
    expect(result.total_rows).toBe(2);
    expect(result.prices.every((p) => p.price !== null)).toBe(true);
    expect(result.prices.map((p) => p.date)).toEqual(['2026-01-02', '2026-01-03']);
  });
});

describe('LiveInvestmentPricesTools.getInvestmentPrices — happy intraday path', () => {
  test('returns granularity=intraday with `timestamp` populated and `date` absent', async () => {
    const client = makeClient({ intraday: intradayRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    const result = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_DAY',
    });

    expect(result.granularity).toBe('intraday');
    expect(result.count).toBe(3);
    expect(result.total_rows).toBe(3);
    expect(result.truncated).toBe(false);
    for (const row of result.prices) {
      expect(typeof row.price).toBe('number');
      expect(typeof row.timestamp).toBe('number');
      expect(row.date).toBeUndefined();
    }
  });

  test('ONE_WEEK also routes to intraday', async () => {
    const client = makeClient({ intraday: intradayRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    const result = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_WEEK',
    });

    expect(result.granularity).toBe('intraday');
    const queryMock = client.query as ReturnType<typeof mock>;
    expect(queryMock.mock.calls[0]?.[0]).toBe('SecurityPricesHighFrequency');
  });
});

describe('LiveInvestmentPricesTools — routing', () => {
  test('ONE_MONTH routes to SecurityPrices (daily)', async () => {
    const client = makeClient({ daily: dailyRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    await tools.getInvestmentPrices({ security_id: SECURITY_ID, time_frame: 'ONE_MONTH' });

    const queryMock = client.query as ReturnType<typeof mock>;
    expect(queryMock.mock.calls[0]?.[0]).toBe('SecurityPrices');
  });

  test('ONE_DAY routes to SecurityPricesHighFrequency (intraday)', async () => {
    const client = makeClient({ intraday: intradayRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    await tools.getInvestmentPrices({ security_id: SECURITY_ID, time_frame: 'ONE_DAY' });

    const queryMock = client.query as ReturnType<typeof mock>;
    expect(queryMock.mock.calls[0]?.[0]).toBe('SecurityPricesHighFrequency');
  });

  test('THREE_MONTHS, YTD, ONE_YEAR, ALL all route to SecurityPrices', async () => {
    for (const tf of ['THREE_MONTHS', 'YTD', 'ONE_YEAR', 'ALL'] as const) {
      const client = makeClient({ daily: dailyRows });
      const tools = new LiveInvestmentPricesTools(makeLive(client));
      await tools.getInvestmentPrices({ security_id: SECURITY_ID, time_frame: tf });
      const queryMock = client.query as ReturnType<typeof mock>;
      expect(queryMock.mock.calls[0]?.[0]).toBe('SecurityPrices');
    }
  });
});

describe('LiveInvestmentPricesTools — NOT_FOUND error translation', () => {
  test('translates the ownership-gated GraphQL error into a clean message (daily)', async () => {
    const client = makeClient({
      throwOnce: new GraphQLError(
        'USER_ACTION_REQUIRED',
        'No holdings found for this security',
        'SecurityPrices',
        200
      ),
    });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    await expect(
      tools.getInvestmentPrices({ security_id: SECURITY_ID, time_frame: 'ONE_MONTH' })
    ).rejects.toThrow(/sec-A.*not currently in your linked accounts/);
  });

  test('translates the ownership-gated GraphQL error into a clean message (intraday)', async () => {
    const client = makeClient({
      throwOnce: new GraphQLError(
        'USER_ACTION_REQUIRED',
        'No holdings found for this security',
        'SecurityPricesHighFrequency',
        200
      ),
    });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    await expect(
      tools.getInvestmentPrices({ security_id: SECURITY_ID, time_frame: 'ONE_DAY' })
    ).rejects.toThrow(/sec-A.*not currently in your linked accounts/);
  });

  test('non-matching GraphQL errors are NOT translated (pass through)', async () => {
    const client = makeClient({
      throwOnce: new GraphQLError(
        'USER_ACTION_REQUIRED',
        'Some other server-side error',
        'SecurityPrices',
        200
      ),
    });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    await expect(tools.getInvestmentPrices({ security_id: SECURITY_ID })).rejects.toThrow(
      /Some other server-side error/
    );
  });
});

describe('LiveInvestmentPricesTools — cache behavior', () => {
  test('second call with same (security_id, time_frame) is a cache hit', async () => {
    const client = makeClient({ daily: dailyRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    const first = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_MONTH',
    });
    const second = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_MONTH',
    });

    expect(first._cache_hit).toBe(false);
    expect(second._cache_hit).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('different granularity bypasses the cache (intraday vs daily are separate maps)', async () => {
    const client = makeClient({ daily: dailyRows, intraday: intradayRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    await tools.getInvestmentPrices({ security_id: SECURITY_ID, time_frame: 'ONE_DAY' });
    await tools.getInvestmentPrices({ security_id: SECURITY_ID, time_frame: 'ONE_MONTH' });

    expect(client.query).toHaveBeenCalledTimes(2);
  });

  test('different daily time_frames for the same security bypass each other', async () => {
    const client = makeClient({ daily: dailyRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    await tools.getInvestmentPrices({ security_id: SECURITY_ID, time_frame: 'ONE_MONTH' });
    await tools.getInvestmentPrices({ security_id: SECURITY_ID, time_frame: 'ONE_YEAR' });

    expect(client.query).toHaveBeenCalledTimes(2);
  });

  test('intraday TTL expires faster than daily TTL', async () => {
    const client = makeClient({ daily: dailyRows, intraday: intradayRows });
    // intradayTtl=5ms (expires before second call), dailyTtl=1h (still warm).
    const tools = new LiveInvestmentPricesTools(makeLive(client), {
      intradayTtlMs: 5,
      dailyTtlMs: 60 * 60 * 1000,
    });

    const firstIntra = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_DAY',
    });
    const firstDaily = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_MONTH',
    });

    await new Promise((r) => setTimeout(r, 15));

    const secondIntra = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_DAY',
    });
    const secondDaily = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_MONTH',
    });

    expect(firstIntra._cache_hit).toBe(false);
    expect(firstDaily._cache_hit).toBe(false);
    // intraday expired → refetch (no cache hit).
    expect(secondIntra._cache_hit).toBe(false);
    // daily still warm → cache hit.
    expect(secondDaily._cache_hit).toBe(true);
  });

  test('clearCache() drops every entry across both maps — next call refetches', async () => {
    const client = makeClient({ daily: dailyRows, intraday: intradayRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    await tools.getInvestmentPrices({ security_id: SECURITY_ID, time_frame: 'ONE_MONTH' });
    await tools.getInvestmentPrices({ security_id: SECURITY_ID, time_frame: 'ONE_DAY' });

    tools.clearCache();

    const refetchDaily = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_MONTH',
    });
    const refetchIntra = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_DAY',
    });

    expect(refetchDaily._cache_hit).toBe(false);
    expect(refetchIntra._cache_hit).toBe(false);
    expect(client.query).toHaveBeenCalledTimes(4);
  });

  test('omitted time_frame uses DEFAULT sentinel key, distinct from explicit ONE_MONTH', async () => {
    // Both default to ONE_MONTH semantics, but they use different cache keys:
    // explicit ONE_MONTH uses the enum value; omitted uses the DEFAULT sentinel.
    const client = makeClient({ daily: dailyRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    await tools.getInvestmentPrices({ security_id: SECURITY_ID });
    const explicit = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_MONTH',
    });

    expect(explicit._cache_hit).toBe(false);
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});

describe('LiveInvestmentPricesTools — max_rows truncation', () => {
  test('caps at max_rows and reports `truncated: true` with original total_rows', async () => {
    const bigDaily = Array.from({ length: 1500 }, (_, i) => ({
      id: SECURITY_ID,
      price: 100 + i,
      // generate ascending date-like strings; localeCompare keeps them ordered.
      date: `2025-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 30) + 1).padStart(2, '0')}`,
    }));
    const client = makeClient({ daily: bigDaily });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    const result = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_YEAR',
      max_rows: 500,
    });

    expect(result.total_rows).toBe(1500);
    expect(result.count).toBe(500);
    expect(result.truncated).toBe(true);
    // Sliced to MOST RECENT (tail of ascending series).
    expect(result.prices[0]!.price).toBe(100 + 1000);
    expect(result.prices[499]!.price).toBe(100 + 1499);
  });

  test('default max_rows is 500', async () => {
    const bigDaily = Array.from({ length: 600 }, (_, i) => ({
      id: SECURITY_ID,
      price: 100 + i,
      date: `2025-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 30) + 1).padStart(2, '0')}`,
    }));
    const client = makeClient({ daily: bigDaily });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    const result = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_YEAR',
    });

    expect(result.count).toBe(500);
    expect(result.truncated).toBe(true);
  });

  test('max_rows above MAX cap (5000) is clamped down', async () => {
    const client = makeClient({ daily: dailyRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    // Should not throw — clamped to 5000 internally, well above our 5 rows.
    const result = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      max_rows: 50_000,
    });
    expect(result.count).toBe(5);
    expect(result.truncated).toBe(false);
  });

  test('max_rows below MIN floor (0) is clamped up to 1', async () => {
    // 5 daily rows on the server; max_rows=0 must clamp to MIN_MAX_ROWS (=1)
    // rather than producing an empty/error response. The most-recent row
    // (tail of ascending series) should be returned.
    const client = makeClient({ daily: dailyRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    const result = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_MONTH',
      max_rows: 0,
    });

    expect(result.count).toBe(1);
    expect(result.total_rows).toBe(5);
    expect(result.truncated).toBe(true);
    // Tail of ascending series — most recent.
    expect(result.prices[0]!.date).toBe('2026-01-05');
  });

  test('no truncation when total_rows <= max_rows', async () => {
    const client = makeClient({ daily: dailyRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    const result = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_MONTH',
      max_rows: 10,
    });

    expect(result.count).toBe(5);
    expect(result.total_rows).toBe(5);
    expect(result.truncated).toBe(false);
  });

  test('offset=max_rows returns the next-most-recent batch', async () => {
    const bigDaily = Array.from({ length: 1500 }, (_, i) => ({
      id: SECURITY_ID,
      price: 100 + i,
      date: `2025-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 30) + 1).padStart(2, '0')}`,
    }));
    const client = makeClient({ daily: bigDaily });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    const result = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_YEAR',
      max_rows: 500,
      offset: 500,
    });

    expect(result.count).toBe(500);
    expect(result.total_rows).toBe(1500);
    expect(result.truncated).toBe(true);
    expect(result.prices[0]!.price).toBe(100 + 500);
    expect(result.prices[499]!.price).toBe(100 + 999);
  });

  test('offset beyond total returns empty rows without throwing', async () => {
    const client = makeClient({ daily: dailyRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    const result = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_MONTH',
      max_rows: 100,
      offset: 5000,
    });

    expect(result.count).toBe(0);
    expect(result.total_rows).toBe(5);
    expect(result.prices).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});

describe('LiveInvestmentPricesTools — sorting', () => {
  test('out-of-order daily rows are sorted ascending defensively', async () => {
    const client = makeClient({
      daily: [
        { id: SECURITY_ID, price: 103, date: '2026-01-04' },
        { id: SECURITY_ID, price: 100, date: '2026-01-01' },
        { id: SECURITY_ID, price: 102, date: '2026-01-03' },
        { id: SECURITY_ID, price: 101, date: '2026-01-02' },
      ],
    });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    const result = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_MONTH',
    });

    expect(result.prices.map((r) => r.date)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
  });

  test('out-of-order intraday rows are sorted ascending defensively', async () => {
    const client = makeClient({
      intraday: [
        { id: SECURITY_ID, price: 102, timestamp: 3000 },
        { id: SECURITY_ID, price: 100, timestamp: 1000 },
        { id: SECURITY_ID, price: 101, timestamp: 2000 },
      ],
    });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    const result = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_DAY',
    });

    expect(result.prices.map((r) => r.timestamp)).toEqual([1000, 2000, 3000]);
  });
});

describe('LiveInvestmentPricesTools — empty + validation', () => {
  test('empty server response: count=0, prices=[], metadata still populated', async () => {
    const client = makeClient({ daily: [] });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    const result = await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_MONTH',
    });

    expect(result.count).toBe(0);
    expect(result.total_rows).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.prices).toEqual([]);
    expect(typeof result._cache_oldest_fetched_at).toBe('string');
  });

  test('throws when security_id is missing', async () => {
    const client = makeClient({ daily: dailyRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    await expect(
      // @ts-expect-error intentional violation for runtime check
      tools.getInvestmentPrices({ time_frame: 'ONE_MONTH' })
    ).rejects.toThrow(/security_id/);
  });
});

describe('LiveInvestmentPricesTools — GraphQL wiring', () => {
  test('passes (operation name, query string, variables) verbatim for daily', async () => {
    const client = makeClient({ daily: dailyRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_MONTH',
    });

    const queryMock = client.query as ReturnType<typeof mock>;
    const callArgs = queryMock.mock.calls[0] as unknown[];
    expect(callArgs[0]).toBe('SecurityPrices');
    expect(typeof callArgs[1]).toBe('string');
    expect(callArgs[2]).toEqual({ id: SECURITY_ID, timeFrame: 'ONE_MONTH' });
  });

  test('passes (operation name, query string, variables) verbatim for intraday', async () => {
    const client = makeClient({ intraday: intradayRows });
    const tools = new LiveInvestmentPricesTools(makeLive(client));

    await tools.getInvestmentPrices({
      security_id: SECURITY_ID,
      time_frame: 'ONE_DAY',
    });

    const queryMock = client.query as ReturnType<typeof mock>;
    const callArgs = queryMock.mock.calls[0] as unknown[];
    expect(callArgs[0]).toBe('SecurityPricesHighFrequency');
    expect(typeof callArgs[1]).toBe('string');
    expect(callArgs[2]).toEqual({ id: SECURITY_ID, timeFrame: 'ONE_DAY' });
  });
});

describe('createLiveInvestmentPricesToolSchema', () => {
  test('name is get_investment_prices_live, readOnlyHint=true', () => {
    const schema = createLiveInvestmentPricesToolSchema();
    expect(schema.name).toBe('get_investment_prices_live');
    expect(schema.annotations?.readOnlyHint).toBe(true);
  });

  test('security_id is required; time_frame is an enum; max_rows is integer', () => {
    const schema = createLiveInvestmentPricesToolSchema();
    const props = schema.inputSchema.properties as Record<
      string,
      { type: string; enum?: string[]; default?: number }
    >;
    expect(props.security_id?.type).toBe('string');
    expect(props.time_frame?.type).toBe('string');
    expect(props.time_frame?.enum).toEqual([
      'ONE_DAY',
      'ONE_WEEK',
      'ONE_MONTH',
      'THREE_MONTHS',
      'YTD',
      'ONE_YEAR',
      'ALL',
    ]);
    expect(props.max_rows?.type).toBe('integer');
    expect(props.max_rows?.default).toBe(500);
    expect((schema.inputSchema as { required?: string[] }).required ?? []).toEqual(['security_id']);
  });

  test('exposes offset pagination arg matching the shared shape', () => {
    const schema = createLiveInvestmentPricesToolSchema();
    const props = schema.inputSchema.properties as Record<
      string,
      { type: string; default?: number }
    >;
    expect(props.offset?.type).toBe('integer');
    expect(props.offset?.default).toBe(0);
  });

  test('description mentions the ownership gate', () => {
    const schema = createLiveInvestmentPricesToolSchema();
    expect(schema.description.toLowerCase()).toMatch(/ownership|currently hold|linked account/);
  });
});
