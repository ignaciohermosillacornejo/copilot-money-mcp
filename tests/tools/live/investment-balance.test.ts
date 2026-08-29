import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import { CopilotDatabase } from '../../../src/core/database.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import { LiveInvestmentBalanceTools } from '../../../src/tools/live/investment-balance.js';

// Dispatch by operation name: InvestmentBalance → timeseries; InvestmentLiveBalance → single dot.
function makeClient(history: unknown[], live: unknown): GraphQLClient {
  return {
    query: mock((op: string) => {
      if (op === 'InvestmentBalance') return Promise.resolve({ investmentBalance: history });
      if (op === 'InvestmentLiveBalance') return Promise.resolve({ investmentLiveBalance: live });
      return Promise.reject(new Error(`unexpected op ${op}`));
    }),
  } as unknown as GraphQLClient;
}
function makeLive(client: GraphQLClient): LiveCopilotDatabase {
  return new LiveCopilotDatabase(client, new CopilotDatabase('/tmp/no-such-db'));
}

const hist = [
  { id: 'b2', date: '2026-07-02', balance: 10200 },
  { id: 'b1', date: '2026-07-01', balance: 10000 },
];
const liveDot = { id: 'live-1', date: '2026-07-15', balance: 10500 };

// 214 ascending daily points ending 2024-08-15, used by the history-capping
// tests (#597 Tier 1) — the point is that the series dominates the row and
// the fixture needs to be wide enough for the default 30-point cap to bite.
function make214DailyPoints(): { id: string; date: string; balance: number }[] {
  const end = Date.UTC(2024, 7, 15); // 2024-08-15 (month is 0-indexed)
  const points: { id: string; date: string; balance: number }[] = [];
  for (let i = 0; i < 214; i++) {
    const d = new Date(end - (213 - i) * 86_400_000);
    points.push({ id: `bal_${i}`, date: d.toISOString().slice(0, 10), balance: 10000 + i });
  }
  return points;
}

describe('LiveInvestmentBalanceTools.getInvestmentBalance', () => {
  test('combines current (live dot) + history (sorted ascending by date)', async () => {
    const client = makeClient(hist, liveDot);
    const tools = new LiveInvestmentBalanceTools(makeLive(client));
    const result = await tools.getInvestmentBalance({});
    expect(result.time_frame).toBe('YTD');
    expect(result.current).toEqual({ date: '2026-07-15', balance: 10500 });
    expect(result.history).toEqual([
      { date: '2026-07-01', balance: 10000 },
      { date: '2026-07-02', balance: 10200 },
    ]);
  });

  test('default time_frame YTD → passes timeFrame to InvestmentBalance, no vars to live', async () => {
    const client = makeClient(hist, liveDot);
    const tools = new LiveInvestmentBalanceTools(makeLive(client));
    await tools.getInvestmentBalance({});
    const q = client.query as ReturnType<typeof mock>;
    const calls = q.mock.calls as unknown[][];
    const balCall = calls.find((c) => c[0] === 'InvestmentBalance')!;
    const liveCall = calls.find((c) => c[0] === 'InvestmentLiveBalance')!;
    expect(balCall[2]).toEqual({ timeFrame: 'YTD' });
    expect(liveCall[2]).toEqual({});
  });

  test('explicit time_frame is passed through', async () => {
    const client = makeClient(hist, liveDot);
    const tools = new LiveInvestmentBalanceTools(makeLive(client));
    const result = await tools.getInvestmentBalance({ time_frame: 'ONE_YEAR' });
    expect(result.time_frame).toBe('ONE_YEAR');
    const q = client.query as ReturnType<typeof mock>;
    const balCall = (q.mock.calls as unknown[][]).find((c) => c[0] === 'InvestmentBalance')!;
    expect(balCall[2]).toEqual({ timeFrame: 'ONE_YEAR' });
  });

  test('empty history → history=[], current still present', async () => {
    const client = makeClient([], liveDot);
    const tools = new LiveInvestmentBalanceTools(makeLive(client));
    const result = await tools.getInvestmentBalance({});
    expect(result.history).toEqual([]);
    expect(result.current).toEqual({ date: '2026-07-15', balance: 10500 });
  });

  test('absent live dot → current is null, history still resolves (defensive branch)', async () => {
    // The wrapper types the live balance non-null, but the tool guards a null
    // dot (`currentNode ? ... : null`); exercise that branch explicitly.
    const client = makeClient(hist, null);
    const tools = new LiveInvestmentBalanceTools(makeLive(client));
    const result = await tools.getInvestmentBalance({});
    expect(result.current).toBeNull();
    expect(result.history).toHaveLength(2);
  });

  test('warm call: both caches hit, no re-fetch (2 queries total across two calls)', async () => {
    const client = makeClient(hist, liveDot);
    const tools = new LiveInvestmentBalanceTools(makeLive(client));
    const first = await tools.getInvestmentBalance({});
    const second = await tools.getInvestmentBalance({});
    expect(first._cache_hit).toBe(false);
    expect(second._cache_hit).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(2); // one per op, first call only
  });

  test('changing time_frame refetches history only (live dot stays cached)', async () => {
    const client = makeClient(hist, liveDot);
    const tools = new LiveInvestmentBalanceTools(makeLive(client));
    await tools.getInvestmentBalance({ time_frame: 'YTD' }); // 2 queries
    await tools.getInvestmentBalance({ time_frame: 'ONE_YEAR' }); // history refetch only → +1
    const q = client.query as ReturnType<typeof mock>;
    const balCalls = (q.mock.calls as unknown[][]).filter((c) => c[0] === 'InvestmentBalance');
    const liveCalls = (q.mock.calls as unknown[][]).filter((c) => c[0] === 'InvestmentLiveBalance');
    expect(balCalls.length).toBe(2);
    expect(liveCalls.length).toBe(1);
  });

  test('cache metadata are ISO strings', async () => {
    const client = makeClient(hist, liveDot);
    const tools = new LiveInvestmentBalanceTools(makeLive(client));
    const result = await tools.getInvestmentBalance({});
    expect(result._cache_oldest_fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result._cache_newest_fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  describe('history capping (#597 Tier 1)', () => {
    test('history defaults to the last 30 points and reports truncation', async () => {
      const client = makeClient(make214DailyPoints(), liveDot);
      const tools = new LiveInvestmentBalanceTools(makeLive(client));
      const result = await tools.getInvestmentBalance({});
      expect(result.history).toHaveLength(30);
      expect(result.history.at(-1)?.date).toBe('2024-08-15'); // newest retained
      expect(result.history_total_count).toBe(214);
      expect(result.history_truncated).toBe(true);
    });

    test('history_limit: 0 returns the full series untruncated', async () => {
      const client = makeClient(make214DailyPoints(), liveDot);
      const tools = new LiveInvestmentBalanceTools(makeLive(client));
      const result = await tools.getInvestmentBalance({ history_limit: 0 });
      expect(result.history).toHaveLength(214);
      expect(result.history_truncated).toBe(false);
    });

    test('current (the live dot) survives truncation — resolved from a separate query, not history', async () => {
      const client = makeClient(make214DailyPoints(), liveDot);
      const tools = new LiveInvestmentBalanceTools(makeLive(client));
      const result = await tools.getInvestmentBalance({});
      expect(result.current).toEqual({ date: '2026-07-15', balance: 10500 });
    });

    test('an explicit history_limit smaller than the series caps at that count', async () => {
      const client = makeClient(make214DailyPoints(), liveDot);
      const tools = new LiveInvestmentBalanceTools(makeLive(client));
      const result = await tools.getInvestmentBalance({ history_limit: 5 });
      expect(result.history).toHaveLength(5);
      expect(result.history.at(-1)?.date).toBe('2024-08-15');
      expect(result.history_truncated).toBe(true);
    });

    test('history_limit larger than the series returns everything, untruncated', async () => {
      const client = makeClient(hist, liveDot); // only 2 points
      const tools = new LiveInvestmentBalanceTools(makeLive(client));
      const result = await tools.getInvestmentBalance({ history_limit: 30 });
      expect(result.history).toHaveLength(2);
      expect(result.history_total_count).toBe(2);
      expect(result.history_truncated).toBe(false);
    });

    test('history_limit exactly equal to the series length returns everything, untruncated', async () => {
      // Boundary distinct from strictly-less and strictly-greater: if the
      // `>` comparison inside paginate() regressed to `>=`, this exact-match
      // case would still return correct data but silently mis-report
      // truncated: true.
      const client = makeClient(make214DailyPoints(), liveDot);
      const tools = new LiveInvestmentBalanceTools(makeLive(client));
      const result = await tools.getInvestmentBalance({ history_limit: 214 });
      expect(result.history).toHaveLength(214);
      expect(result.history_total_count).toBe(214);
      expect(result.history_truncated).toBe(false);
    });

    test('a negative history_limit clamps to 1 rather than throwing or slicing backwards', async () => {
      // Mirrors clampMaxRows' convention (src/utils/pagination.ts): a
      // malformed value degrades to "as few as possible", not to unlimited.
      const client = makeClient(make214DailyPoints(), liveDot);
      const tools = new LiveInvestmentBalanceTools(makeLive(client));
      const result = await tools.getInvestmentBalance({ history_limit: -5 });
      expect(result.history).toHaveLength(1);
      expect(result.history[0]?.date).toBe('2024-08-15');
      expect(result.history_truncated).toBe(true);
    });

    test("a non-finite history_limit falls back to the 30-point default, not paginate()'s own 500-row default", async () => {
      // Distinct from the negative-limit case above: paginate()'s internal
      // clampMaxRows() would ALSO floor a defined negative/fractional value
      // to the same result even if this tool's own clamp were removed, so
      // that test alone cannot prove this outer clamp does anything. NaN is
      // the one input where it matters: `NaN ?? 30` is still NaN (`??` only
      // replaces null/undefined), so without this tool's own
      // Number.isFinite check, NaN would reach paginate() as `max_rows`,
      // which falls back to ITS default of 500 — not this tool's 30. With a
      // 214-point fixture, 500 would return everything untruncated; 30
      // truncates. That's what this test tells apart.
      const client = makeClient(make214DailyPoints(), liveDot);
      const tools = new LiveInvestmentBalanceTools(makeLive(client));
      const result = await tools.getInvestmentBalance({ history_limit: NaN });
      expect(result.history).toHaveLength(30);
      expect(result.history_truncated).toBe(true);
    });

    test('the capped default is smaller than the full series', async () => {
      const client = makeClient(make214DailyPoints(), liveDot);
      const tools = new LiveInvestmentBalanceTools(makeLive(client));
      const capped = await tools.getInvestmentBalance({});
      const client2 = makeClient(make214DailyPoints(), liveDot);
      const tools2 = new LiveInvestmentBalanceTools(makeLive(client2));
      const full = await tools2.getInvestmentBalance({ history_limit: 0 });

      const cappedSize = JSON.stringify(capped).length;
      const fullSize = JSON.stringify(full).length;
      expect(cappedSize).toBeLessThan(fullSize);
    });
  });
});

describe('createLiveInvestmentBalanceToolSchema', () => {
  test('schema: name, readOnlyHint, time_frame enum = ALL_TIME_FRAMES, no required', async () => {
    const { createLiveInvestmentBalanceToolSchema } =
      await import('../../../src/tools/live/investment-balance.js');
    const { ALL_TIME_FRAMES } = await import('../../../src/core/graphql/queries/_shared.js');
    const schema = createLiveInvestmentBalanceToolSchema();
    expect(schema.name).toBe('get_investment_balance_live');
    expect(schema.annotations?.readOnlyHint).toBe(true);
    const props = schema.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.time_frame?.enum).toEqual([...ALL_TIME_FRAMES]);
    expect((schema.inputSchema as { required?: string[] }).required ?? []).toEqual([]);
  });

  test('history_limit param: integer, default 30, names `history` as the excluded/capped token', async () => {
    const { createLiveInvestmentBalanceToolSchema } =
      await import('../../../src/tools/live/investment-balance.js');
    const schema = createLiveInvestmentBalanceToolSchema();
    const props = schema.inputSchema.properties as Record<
      string,
      { type?: string; default?: unknown; description?: string }
    >;
    expect(props.history_limit?.type).toBe('integer');
    expect(props.history_limit?.default).toBe(30);
    expect(props.history_limit?.description).toContain('history');
  });
});
