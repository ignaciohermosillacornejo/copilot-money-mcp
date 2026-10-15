import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import { CopilotDatabase } from '../../../src/core/database.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import { LiveMonthlySpendTools } from '../../../src/tools/live/monthly-spend.js';

function makeClient(rows: unknown[]): GraphQLClient {
  return {
    query: mock(() => Promise.resolve({ monthlySpending: rows })),
  } as unknown as GraphQLClient;
}

function makeLive(client: GraphQLClient): LiveCopilotDatabase {
  return new LiveCopilotDatabase(client, new CopilotDatabase('/tmp/no-such-db'));
}

const pastRow = { id: 'd1', date: '2026-04-01', totalAmount: 100, comparisonAmount: 90 };
const todayRow = { id: 'd2', date: '2026-04-15', totalAmount: 50, comparisonAmount: 40 };
const futureRow = { id: 'd3', date: '2026-04-20', totalAmount: null, comparisonAmount: null };

describe('LiveMonthlySpendTools.getMonthlySpend', () => {
  test('cold call: fetches and returns rows with cache_hit=false', async () => {
    const client = makeClient([pastRow]);
    const tools = new LiveMonthlySpendTools(makeLive(client));

    const result = await tools.getMonthlySpend({});

    expect(result.count).toBe(1);
    expect(result.daily_spending[0]?.id).toBe('d1');
    expect(result._cache_hit).toBe(false);
    expect(typeof result._cache_oldest_fetched_at).toBe('string');
    expect(typeof result._cache_newest_fetched_at).toBe('string');
  });

  test('warm call: cache hit, no second fetch', async () => {
    const client = makeClient([pastRow]);
    const tools = new LiveMonthlySpendTools(makeLive(client));

    await tools.getMonthlySpend({});
    const second = await tools.getMonthlySpend({});

    expect(second._cache_hit).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('default: filters out placeholder rows with no total_amount', async () => {
    const client = makeClient([pastRow, todayRow, futureRow]);
    const tools = new LiveMonthlySpendTools(makeLive(client));

    const result = await tools.getMonthlySpend({});

    expect(result.count).toBe(2);
    expect(result.daily_spending.map((r) => r.id)).toEqual(['d1', 'd2']);
  });

  test('include_future=true: returns the placeholder rows verbatim', async () => {
    const client = makeClient([pastRow, todayRow, futureRow]);
    const tools = new LiveMonthlySpendTools(makeLive(client));

    const result = await tools.getMonthlySpend({ include_future: true });

    expect(result.count).toBe(3);
    expect(result.daily_spending.map((r) => r.id)).toEqual(['d1', 'd2', 'd3']);
    // Future row preserves null amounts when included.
    const future = result.daily_spending.find((r) => r.id === 'd3');
    expect(future?.total_amount).toBeNull();
    expect(future?.comparison_amount).toBeNull();
  });

  test('output sorted by date ascending', async () => {
    const client = makeClient([
      { id: 'b', date: '2026-04-15', totalAmount: 200, comparisonAmount: 150 },
      { id: 'a', date: '2026-04-01', totalAmount: 100, comparisonAmount: 90 },
      { id: 'c', date: '2026-04-30', totalAmount: 300, comparisonAmount: 250 },
    ]);
    const tools = new LiveMonthlySpendTools(makeLive(client));

    const result = await tools.getMonthlySpend({});

    expect(result.daily_spending.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  // #823: total_amount is cumulative month-to-date, so the per-day figure is
  // the difference between consecutive rows, sorted by date.
  test('daily_amount differences the cumulative series in date order', async () => {
    const client = makeClient([
      { id: 'c', date: '2026-04-03', totalAmount: 175.5, comparisonAmount: 30 },
      { id: 'a', date: '2026-04-01', totalAmount: 100.1, comparisonAmount: 10 },
      { id: 'b', date: '2026-04-02', totalAmount: 100.1, comparisonAmount: 20 },
    ]);
    const tools = new LiveMonthlySpendTools(makeLive(client));

    const result = await tools.getMonthlySpend({});

    expect(result.daily_spending.map((r) => r.daily_amount)).toEqual([100.1, 0, 75.4]);
  });

  test('a null total mid-series yields null and keeps the running baseline', async () => {
    const client = makeClient([
      { id: 'a', date: '2026-04-01', totalAmount: 100, comparisonAmount: 10 },
      { id: 'b', date: '2026-04-02', totalAmount: null, comparisonAmount: null },
      { id: 'c', date: '2026-04-03', totalAmount: 150, comparisonAmount: 30 },
    ]);
    const tools = new LiveMonthlySpendTools(makeLive(client));

    const result = await tools.getMonthlySpend({ include_future: true });

    // A baseline reset on the null row would give 150 for the last day.
    expect(result.daily_spending.map((r) => r.daily_amount)).toEqual([100, null, 50]);
  });

  test('default view keeps a row whose comparison_amount alone is null', async () => {
    const client = makeClient([
      { id: 'a', date: '2026-04-01', totalAmount: 100, comparisonAmount: 90 },
      { id: 'b', date: '2026-04-02', totalAmount: 150, comparisonAmount: null },
      { id: 'c', date: '2026-04-03', totalAmount: 200, comparisonAmount: 80 },
    ]);
    const tools = new LiveMonthlySpendTools(makeLive(client));

    const result = await tools.getMonthlySpend({});

    // The visible daily_amount column sums to the last total_amount. This is
    // also what makes a day's value independent of include_future: it fails
    // on a revert to the either-null filter ([100, 50]) and, combined with
    // differencing after the filter, on [100, 100].
    expect(result.daily_spending.map((r) => r.daily_amount)).toEqual([100, 50, 50]);
    const full = await new LiveMonthlySpendTools(makeLive(client)).getMonthlySpend({
      include_future: true,
    });
    // Belt-and-braces: with this fixture both modes return the same rows, so
    // this only starts to discriminate if a later filter widens (e.g. a date
    // range) — the default-mode assertion above is the detector today.
    expect(full.daily_spending.map((r) => r.daily_amount)).toEqual([100, 50, 50]);
  });

  test('passes numeric wire amounts through as numbers', async () => {
    const client = makeClient([pastRow]);
    const tools = new LiveMonthlySpendTools(makeLive(client));

    const result = await tools.getMonthlySpend({});

    expect(result.daily_spending[0]?.total_amount).toBe(100);
    expect(result.daily_spending[0]?.comparison_amount).toBe(90);
    expect(typeof result.daily_spending[0]?.total_amount).toBe('number');
  });

  test('empty result returns count 0, no throw', async () => {
    const client = makeClient([]);
    const tools = new LiveMonthlySpendTools(makeLive(client));

    const result = await tools.getMonthlySpend({});

    expect(result.count).toBe(0);
    expect(result.daily_spending).toEqual([]);
  });

  test('default filters when only future rows exist (count=0)', async () => {
    const client = makeClient([futureRow, { ...futureRow, id: 'd4', date: '2026-04-21' }]);
    const tools = new LiveMonthlySpendTools(makeLive(client));

    const result = await tools.getMonthlySpend({});

    expect(result.count).toBe(0);
    expect(result.daily_spending).toEqual([]);
  });

  test('row with a null total_amount is treated as future and filtered by default', async () => {
    // Defensive: the captured placeholder pairs both nulls, but a null total
    // alone is enough — there is no spend figure to show.
    const halfNull = {
      id: 'd-half',
      date: '2026-04-19',
      totalAmount: null,
      comparisonAmount: 90,
    };
    const client = makeClient([pastRow, halfNull]);
    const tools = new LiveMonthlySpendTools(makeLive(client));

    const result = await tools.getMonthlySpend({});

    expect(result.daily_spending.map((r) => r.id)).toEqual(['d1']);
  });
});

describe('createLiveMonthlySpendToolSchema', () => {
  test('returns a schema with readOnlyHint=true', async () => {
    const { createLiveMonthlySpendToolSchema } =
      await import('../../../src/tools/live/monthly-spend.js');
    const schema = createLiveMonthlySpendToolSchema();
    expect(schema.name).toBe('get_monthly_spend_live');
    expect(schema.annotations?.readOnlyHint).toBe(true);
  });

  test('declares an optional include_future boolean property', async () => {
    const { createLiveMonthlySpendToolSchema } =
      await import('../../../src/tools/live/monthly-spend.js');
    const schema = createLiveMonthlySpendToolSchema();
    const props = schema.inputSchema.properties as Record<string, { type: string }>;
    expect(props.include_future?.type).toBe('boolean');
    // include_future is opt-in, so it must not appear in `required`.
    expect((schema.inputSchema as { required?: string[] }).required ?? []).not.toContain(
      'include_future'
    );
  });
});
