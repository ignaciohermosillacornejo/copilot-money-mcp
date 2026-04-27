import { describe, expect, test } from 'bun:test';
import {
  RefreshCacheTool,
  createRefreshCacheToolSchema,
} from '../../src/tools/live/refresh-cache.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import type { CopilotDatabase } from '../../src/core/database.js';

const mkLive = () => new LiveCopilotDatabase({} as GraphQLClient, {} as CopilotDatabase);

describe('RefreshCacheTool', () => {
  test('scope: "all" with no months flushes every snapshot', async () => {
    const live = mkLive();
    // Pre-populate snapshots so we can verify they get cleared.
    await live.getAccountsCache().read(async () => [
      {
        id: 'a',
        itemId: 'i',
        name: 'A',
        balance: 0,
        liveBalance: false,
        type: 'depository',
        subType: null,
        mask: null,
        isUserHidden: false,
        isUserClosed: false,
        isManual: false,
        color: null,
        limit: null,
        institutionId: null,
        hasHistoricalUpdates: false,
        hasLiveBalance: false,
        latestBalanceUpdate: null,
      } as never,
    ]);
    await live.getCategoriesCache().read(async () => [{ category_id: 'c' } as never]);

    const tool = new RefreshCacheTool(live);
    const result = await tool.refresh({ scope: 'all' });

    // Reading again should be a miss.
    const a = await live.getAccountsCache().read(async () => [] as never);
    const c = await live.getCategoriesCache().read(async () => [] as never);
    expect(a.hit).toBe(false);
    expect(c.hit).toBe(false);
    expect(result.flushed.accounts).toBe(true);
    expect(result.flushed.categories).toBe(true);
  });

  test('scope: "accounts" flushes only accounts', async () => {
    const live = mkLive();
    await live.getAccountsCache().read(async () => [
      {
        id: 'a',
        itemId: 'i',
        name: 'A',
        balance: 0,
        liveBalance: false,
        type: 'depository',
        subType: null,
        mask: null,
        isUserHidden: false,
        isUserClosed: false,
        isManual: false,
        color: null,
        limit: null,
        institutionId: null,
        hasHistoricalUpdates: false,
        hasLiveBalance: false,
        latestBalanceUpdate: null,
      } as never,
    ]);
    await live.getCategoriesCache().read(async () => [{ category_id: 'c' } as never]);

    const tool = new RefreshCacheTool(live);
    await tool.refresh({ scope: 'accounts' });

    const a = await live.getAccountsCache().read(async () => [] as never);
    const c = await live.getCategoriesCache().read(async () => [{ category_id: 'c' } as never]);
    expect(a.hit).toBe(false);
    expect(c.hit).toBe(true);
  });

  test('scope: "transactions" with months flushes only those months', async () => {
    const live = mkLive();
    live.getTransactionsWindowCache().ingestMonth('2026-03', [], Date.now());
    live.getTransactionsWindowCache().ingestMonth('2026-04', [], Date.now());

    const tool = new RefreshCacheTool(live);
    await tool.refresh({ scope: 'transactions', months: ['2026-03'] });

    expect(live.getTransactionsWindowCache().hasMonth('2026-03')).toBe(false);
    expect(live.getTransactionsWindowCache().hasMonth('2026-04')).toBe(true);
  });

  test('scope: "transactions" with no months flushes every cached month', async () => {
    const live = mkLive();
    live.getTransactionsWindowCache().ingestMonth('2026-03', [], Date.now());
    live.getTransactionsWindowCache().ingestMonth('2026-04', [], Date.now());

    const tool = new RefreshCacheTool(live);
    await tool.refresh({ scope: 'transactions' });

    expect(live.getTransactionsWindowCache().hasMonth('2026-03')).toBe(false);
    expect(live.getTransactionsWindowCache().hasMonth('2026-04')).toBe(false);
  });

  test('unknown scope rejects with an error', async () => {
    const live = mkLive();
    const tool = new RefreshCacheTool(live);
    await expect(tool.refresh({ scope: 'bogus' as never })).rejects.toThrow(/scope/);
  });

  test('schema is registered with name refresh_cache', () => {
    const schema = createRefreshCacheToolSchema();
    expect(schema.name).toBe('refresh_cache');
    expect(schema.inputSchema).toBeDefined();
  });

  test('default scope is "all"', async () => {
    const live = mkLive();
    await live.getCategoriesCache().read(async () => [{ category_id: 'c' } as never]);
    const tool = new RefreshCacheTool(live);
    await tool.refresh({});
    const c = await live.getCategoriesCache().read(async () => [] as never);
    expect(c.hit).toBe(false);
  });
});
