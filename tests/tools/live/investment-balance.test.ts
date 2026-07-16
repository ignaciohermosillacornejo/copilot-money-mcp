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
});
