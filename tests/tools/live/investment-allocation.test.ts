import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import { CopilotDatabase } from '../../../src/core/database.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import { LiveInvestmentAllocationTools } from '../../../src/tools/live/investment-allocation.js';

function makeClient(rows: unknown[]): GraphQLClient {
  return {
    query: mock(() => Promise.resolve({ investmentAllocation: rows })),
  } as unknown as GraphQLClient;
}

function makeLive(client: GraphQLClient): LiveCopilotDatabase {
  return new LiveCopilotDatabase(client, new CopilotDatabase('/tmp/no-such-db'));
}

// percentage values are percent (0–100), matching the live-verified server
// scale (#539) — they sum to 100, not 1.
const equity = { id: 'a-eq', type: 'EQUITY', amount: 8000, percentage: 80 };
const cash = { id: 'a-cash', type: 'CASH', amount: 2000, percentage: 20 };

describe('LiveInvestmentAllocationTools.getInvestmentAllocation', () => {
  test('projects rows to {type, amount, percentage} pass-through and counts them', async () => {
    const client = makeClient([equity, cash]);
    const tools = new LiveInvestmentAllocationTools(makeLive(client));

    const result = await tools.getInvestmentAllocation({});

    expect(result.count).toBe(2);
    expect(result.allocation).toEqual([
      { type: 'EQUITY', amount: 8000, percentage: 80 },
      { type: 'CASH', amount: 2000, percentage: 20 },
    ]);
  });

  test('empty result returns count=0 without throwing', async () => {
    const client = makeClient([]);
    const tools = new LiveInvestmentAllocationTools(makeLive(client));

    const result = await tools.getInvestmentAllocation({});

    expect(result.count).toBe(0);
    expect(result.allocation).toEqual([]);
  });

  test('no filter → passes empty variables to the query', async () => {
    const client = makeClient([equity]);
    const tools = new LiveInvestmentAllocationTools(makeLive(client));

    await tools.getInvestmentAllocation({});

    const queryMock = client.query as ReturnType<typeof mock>;
    const callArgs = queryMock.mock.calls[0] as unknown[];
    expect(callArgs[0]).toBe('InvestmentAllocation');
    expect(callArgs[2]).toEqual({ filter: undefined });
  });

  test('account_id builds a server-side filter variable', async () => {
    const client = makeClient([equity]);
    const tools = new LiveInvestmentAllocationTools(makeLive(client));

    await tools.getInvestmentAllocation({ account_id: 'acct-1' });

    const queryMock = client.query as ReturnType<typeof mock>;
    const callArgs = queryMock.mock.calls[0] as unknown[];
    expect(callArgs[2]).toEqual({ filter: { accountId: 'acct-1', itemId: undefined } });
  });

  test('item_id builds a server-side filter variable', async () => {
    const client = makeClient([equity]);
    const tools = new LiveInvestmentAllocationTools(makeLive(client));

    await tools.getInvestmentAllocation({ item_id: 'item-1' });

    const queryMock = client.query as ReturnType<typeof mock>;
    const callArgs = queryMock.mock.calls[0] as unknown[];
    expect(callArgs[2]).toEqual({ filter: { accountId: undefined, itemId: 'item-1' } });
  });

  test('warm call returns cached data with _cache_hit=true and no second fetch', async () => {
    const client = makeClient([equity]);
    const tools = new LiveInvestmentAllocationTools(makeLive(client));

    const first = await tools.getInvestmentAllocation({});
    const second = await tools.getInvestmentAllocation({});

    expect(first._cache_hit).toBe(false);
    expect(second._cache_hit).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('changing scope invalidates the cache and refetches', async () => {
    const client = makeClient([equity]);
    const tools = new LiveInvestmentAllocationTools(makeLive(client));

    await tools.getInvestmentAllocation({}); // scope ""
    await tools.getInvestmentAllocation({ account_id: 'acct-1' }); // scope changed → refetch

    expect(client.query).toHaveBeenCalledTimes(2);
  });

  test('cache metadata: ISO strings, oldest === newest on a single-snapshot fetch', async () => {
    const client = makeClient([equity]);
    const tools = new LiveInvestmentAllocationTools(makeLive(client));

    const result = await tools.getInvestmentAllocation({});

    expect(result._cache_oldest_fetched_at).toBe(result._cache_newest_fetched_at);
    expect(result._cache_oldest_fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('createLiveInvestmentAllocationToolSchema', () => {
  test('returns a schema with readOnlyHint=true and the expected tool name', async () => {
    const { createLiveInvestmentAllocationToolSchema } =
      await import('../../../src/tools/live/investment-allocation.js');
    const schema = createLiveInvestmentAllocationToolSchema();
    expect(schema.name).toBe('get_investment_allocation_live');
    expect(schema.annotations?.readOnlyHint).toBe(true);
    expect((schema.inputSchema as { required?: string[] }).required ?? []).toEqual([]);
  });
});
