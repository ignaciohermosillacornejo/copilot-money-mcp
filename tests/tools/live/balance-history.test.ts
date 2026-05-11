import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import { CopilotDatabase } from '../../../src/core/database.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import {
  LiveBalanceHistoryTools,
  createLiveBalanceHistoryToolSchema,
} from '../../../src/tools/live/balance-history.js';

const ITEM_ID = 'item-A';
const ACCOUNT_ID = 'acct-A';

const sampleRows = [
  { date: '2026-01-01', balance: 1000 },
  { date: '2026-01-02', balance: 1050 },
  { date: '2026-01-03', balance: 1100 },
];

function makeClient(rowsOrFn: unknown[] | (() => unknown[])): GraphQLClient {
  return {
    query: mock(() => {
      const rows = typeof rowsOrFn === 'function' ? rowsOrFn() : rowsOrFn;
      return Promise.resolve({ accountBalanceHistory: rows });
    }),
  } as unknown as GraphQLClient;
}

function makeLive(client: GraphQLClient): LiveCopilotDatabase {
  return new LiveCopilotDatabase(client, new CopilotDatabase('/tmp/no-such-db'));
}

describe('LiveBalanceHistoryTools.getBalanceHistory — happy path', () => {
  test('projects rows and emits standard cache metadata', async () => {
    const client = makeClient(sampleRows);
    const tools = new LiveBalanceHistoryTools(makeLive(client));

    const result = await tools.getBalanceHistory({
      item_id: ITEM_ID,
      account_id: ACCOUNT_ID,
    });

    expect(result.count).toBe(3);
    expect(result.balance_history).toEqual([
      { date: '2026-01-01', balance: 1000 },
      { date: '2026-01-02', balance: 1050 },
      { date: '2026-01-03', balance: 1100 },
    ]);
    expect(result._cache_hit).toBe(false);
    expect(typeof result._cache_oldest_fetched_at).toBe('string');
    expect(typeof result._cache_newest_fetched_at).toBe('string');
    // Single-fetch — oldest === newest.
    expect(result._cache_oldest_fetched_at).toBe(result._cache_newest_fetched_at);
    expect(result._cache_oldest_fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('empty response returns count=0 with metadata intact', async () => {
    const client = makeClient([]);
    const tools = new LiveBalanceHistoryTools(makeLive(client));

    const result = await tools.getBalanceHistory({
      item_id: ITEM_ID,
      account_id: ACCOUNT_ID,
    });

    expect(result.count).toBe(0);
    expect(result.balance_history).toEqual([]);
    expect(result._cache_hit).toBe(false);
    expect(typeof result._cache_oldest_fetched_at).toBe('string');
  });

  test('out-of-order server rows are sorted ascending defensively', async () => {
    const client = makeClient([
      { date: '2026-01-03', balance: 1100 },
      { date: '2026-01-01', balance: 1000 },
      { date: '2026-01-02', balance: 1050 },
    ]);
    const tools = new LiveBalanceHistoryTools(makeLive(client));

    const result = await tools.getBalanceHistory({
      item_id: ITEM_ID,
      account_id: ACCOUNT_ID,
    });

    expect(result.balance_history.map((r) => r.date)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
    ]);
  });
});

describe('LiveBalanceHistoryTools — cache behavior', () => {
  test('second call with same tuple is a cache hit and skips the network', async () => {
    const client = makeClient(sampleRows);
    const tools = new LiveBalanceHistoryTools(makeLive(client));

    const first = await tools.getBalanceHistory({
      item_id: ITEM_ID,
      account_id: ACCOUNT_ID,
      time_frame: 'ONE_MONTH',
    });
    const second = await tools.getBalanceHistory({
      item_id: ITEM_ID,
      account_id: ACCOUNT_ID,
      time_frame: 'ONE_MONTH',
    });

    expect(first._cache_hit).toBe(false);
    expect(second._cache_hit).toBe(true);
    expect(second.balance_history).toEqual(first.balance_history);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('different time_frame for the same account bypasses the cache', async () => {
    const client = makeClient(sampleRows);
    const tools = new LiveBalanceHistoryTools(makeLive(client));

    await tools.getBalanceHistory({
      item_id: ITEM_ID,
      account_id: ACCOUNT_ID,
      time_frame: 'ONE_MONTH',
    });
    await tools.getBalanceHistory({
      item_id: ITEM_ID,
      account_id: ACCOUNT_ID,
      time_frame: 'ONE_YEAR',
    });

    expect(client.query).toHaveBeenCalledTimes(2);
  });

  test('omitted time_frame uses DEFAULT key — two omitted calls share the cache', async () => {
    const client = makeClient(sampleRows);
    const tools = new LiveBalanceHistoryTools(makeLive(client));

    const first = await tools.getBalanceHistory({
      item_id: ITEM_ID,
      account_id: ACCOUNT_ID,
    });
    const second = await tools.getBalanceHistory({
      item_id: ITEM_ID,
      account_id: ACCOUNT_ID,
    });

    expect(first._cache_hit).toBe(false);
    expect(second._cache_hit).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('omitted vs explicit time_frame are distinct keys (server-default ≠ explicit ALL)', async () => {
    const client = makeClient(sampleRows);
    const tools = new LiveBalanceHistoryTools(makeLive(client));

    await tools.getBalanceHistory({
      item_id: ITEM_ID,
      account_id: ACCOUNT_ID,
    });
    const explicit = await tools.getBalanceHistory({
      item_id: ITEM_ID,
      account_id: ACCOUNT_ID,
      time_frame: 'ALL',
    });

    expect(explicit._cache_hit).toBe(false);
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  test('TTL expiry triggers refetch', async () => {
    const client = makeClient(sampleRows);
    // Tiny TTL: the synthetic delay below clears it.
    const tools = new LiveBalanceHistoryTools(makeLive(client), { ttlMs: 5 });

    const first = await tools.getBalanceHistory({
      item_id: ITEM_ID,
      account_id: ACCOUNT_ID,
    });
    expect(first._cache_hit).toBe(false);

    await new Promise((r) => setTimeout(r, 15));

    const second = await tools.getBalanceHistory({
      item_id: ITEM_ID,
      account_id: ACCOUNT_ID,
    });
    expect(second._cache_hit).toBe(false);
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  test('clearCache() drops every entry — next call refetches', async () => {
    const client = makeClient(sampleRows);
    const tools = new LiveBalanceHistoryTools(makeLive(client));

    await tools.getBalanceHistory({ item_id: ITEM_ID, account_id: ACCOUNT_ID });
    tools.clearCache();
    const after = await tools.getBalanceHistory({
      item_id: ITEM_ID,
      account_id: ACCOUNT_ID,
    });

    expect(after._cache_hit).toBe(false);
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});

describe('LiveBalanceHistoryTools — GraphQL wiring', () => {
  test('passes (operation name, query string, variables) verbatim', async () => {
    const client = makeClient(sampleRows);
    const tools = new LiveBalanceHistoryTools(makeLive(client));

    await tools.getBalanceHistory({
      item_id: ITEM_ID,
      account_id: ACCOUNT_ID,
      time_frame: 'ONE_MONTH',
    });

    expect(client.query).toHaveBeenCalledTimes(1);
    const queryMock = client.query as ReturnType<typeof mock>;
    const callArgs = queryMock.mock.calls[0] as unknown[];
    expect(callArgs[0]).toBe('BalanceHistory');
    expect(typeof callArgs[1]).toBe('string');
    expect(callArgs[2]).toEqual({
      itemId: ITEM_ID,
      accountId: ACCOUNT_ID,
      timeFrame: 'ONE_MONTH',
    });
  });

  test('throws when item_id is missing', async () => {
    const client = makeClient(sampleRows);
    const tools = new LiveBalanceHistoryTools(makeLive(client));

    await expect(
      // @ts-expect-error intentional violation for runtime check
      tools.getBalanceHistory({ account_id: ACCOUNT_ID })
    ).rejects.toThrow(/item_id/);
  });

  test('throws when account_id is missing', async () => {
    const client = makeClient(sampleRows);
    const tools = new LiveBalanceHistoryTools(makeLive(client));

    await expect(
      // @ts-expect-error intentional violation for runtime check
      tools.getBalanceHistory({ item_id: ITEM_ID })
    ).rejects.toThrow(/account_id/);
  });
});

describe('createLiveBalanceHistoryToolSchema', () => {
  test('name is get_balance_history_live, readOnlyHint=true', () => {
    const schema = createLiveBalanceHistoryToolSchema();
    expect(schema.name).toBe('get_balance_history_live');
    expect(schema.annotations?.readOnlyHint).toBe(true);
  });

  test('item_id and account_id are required; time_frame is an enum', () => {
    const schema = createLiveBalanceHistoryToolSchema();
    const props = schema.inputSchema.properties as Record<
      string,
      { type: string; enum?: string[] }
    >;
    expect(props.item_id?.type).toBe('string');
    expect(props.account_id?.type).toBe('string');
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
    expect((schema.inputSchema as { required?: string[] }).required ?? []).toEqual([
      'item_id',
      'account_id',
    ]);
  });
});
