import { describe, expect, test, mock } from 'bun:test';
import {
  RefreshCacheTool,
  createRefreshCacheToolSchema,
} from '../../../src/tools/live/refresh-cache.js';
import type { LiveCopilotDatabase } from '../../../src/core/live-database.js';

function makeInvalidateCache() {
  return { invalidate: mock(() => {}) };
}

function makeMockLive(): {
  live: LiveCopilotDatabase;
  mocks: {
    accounts: ReturnType<typeof makeInvalidateCache>;
    categories: ReturnType<typeof makeInvalidateCache>;
    tags: ReturnType<typeof makeInvalidateCache>;
    recurring: ReturnType<typeof makeInvalidateCache>;
    upcomingRecurrings: ReturnType<typeof makeInvalidateCache>;
    user: ReturnType<typeof makeInvalidateCache>;
    networth: ReturnType<typeof makeInvalidateCache>;
    monthlySpend: ReturnType<typeof makeInvalidateCache>;
    transactions: { invalidate: ReturnType<typeof mock> };
  };
} {
  const accounts = makeInvalidateCache();
  const categories = makeInvalidateCache();
  const tags = makeInvalidateCache();
  const recurring = makeInvalidateCache();
  const upcomingRecurrings = makeInvalidateCache();
  const user = makeInvalidateCache();
  const networth = makeInvalidateCache();
  const monthlySpend = makeInvalidateCache();
  const transactions = { invalidate: mock((_arg: string[] | 'all') => {}) };

  const live = {
    getAccountsCache: mock(() => accounts),
    getCategoriesCache: mock(() => categories),
    getTagsCache: mock(() => tags),
    getRecurringCache: mock(() => recurring),
    getUpcomingRecurringsCache: mock(() => upcomingRecurrings),
    getUserCache: mock(() => user),
    getNetworthCache: mock(() => networth),
    getMonthlySpendCache: mock(() => monthlySpend),
    getTransactionsWindowCache: mock(() => transactions),
  } as unknown as LiveCopilotDatabase;

  return {
    live,
    mocks: {
      accounts,
      categories,
      tags,
      recurring,
      upcomingRecurrings,
      user,
      networth,
      monthlySpend,
      transactions,
    },
  };
}

describe('RefreshCacheTool — scope: all', () => {
  test('flushes all snapshot caches and transactions', async () => {
    const { live, mocks } = makeMockLive();
    const tool = new RefreshCacheTool(live);

    const result = await tool.refresh({ scope: 'all' });

    expect(mocks.accounts.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.categories.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.tags.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.recurring.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.upcomingRecurrings.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.user.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.networth.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.monthlySpend.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.transactions.invalidate).toHaveBeenCalledTimes(1);
    expect(result.flushed.accounts).toBe(true);
    expect(result.flushed.categories).toBe(true);
    expect(result.flushed.tags).toBe(true);
    expect(result.flushed.budgets).toBe(true);
    expect(result.flushed.recurring).toBe(true);
    expect(result.flushed.upcoming_recurrings).toBe(true);
    expect(result.flushed.user).toBe(true);
    expect(result.flushed.networth).toBe(true);
    expect(result.flushed.monthly_spend).toBe(true);
    expect(result.flushed.transactions_months).toBe('all');
  });

  test('respects months filter for transactions', async () => {
    const { live, mocks } = makeMockLive();
    const tool = new RefreshCacheTool(live);

    const result = await tool.refresh({ scope: 'all', months: ['2026-04', '2026-05'] });

    expect(mocks.transactions.invalidate).toHaveBeenCalledWith(['2026-04', '2026-05']);
    expect(result.flushed.transactions_months).toEqual(['2026-04', '2026-05']);
  });
});

describe('RefreshCacheTool — scope: categories', () => {
  test('invalidates only categoriesCache', async () => {
    const { live, mocks } = makeMockLive();
    const tool = new RefreshCacheTool(live);

    const result = await tool.refresh({ scope: 'categories' });

    expect(mocks.categories.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.accounts.invalidate).not.toHaveBeenCalled();
    expect(result.flushed.categories).toBe(true);
    expect(result.flushed.budgets).toBeUndefined();
  });
});

describe('RefreshCacheTool — scope: budgets', () => {
  test('aliases to categoriesCache.invalidate() (budgets are a projection of categories)', async () => {
    const { live, mocks } = makeMockLive();
    const tool = new RefreshCacheTool(live);

    const result = await tool.refresh({ scope: 'budgets' });

    // budgets piggyback on categoriesCache
    expect(mocks.categories.invalidate).toHaveBeenCalledTimes(1);
    // output parity: flushed.budgets must be set
    expect(result.flushed.budgets).toBe(true);
  });

  test('does NOT flush accounts, tags, recurring, or transactions', async () => {
    const { live, mocks } = makeMockLive();
    const tool = new RefreshCacheTool(live);

    const result = await tool.refresh({ scope: 'budgets' });

    expect(mocks.accounts.invalidate).not.toHaveBeenCalled();
    expect(mocks.tags.invalidate).not.toHaveBeenCalled();
    expect(mocks.recurring.invalidate).not.toHaveBeenCalled();
    expect(mocks.transactions.invalidate).not.toHaveBeenCalled();
    expect(result.flushed.accounts).toBeUndefined();
    expect(result.flushed.tags).toBeUndefined();
    expect(result.flushed.recurring).toBeUndefined();
    expect(result.flushed.transactions_months).toBeUndefined();
  });
});

describe('RefreshCacheTool — scope: accounts', () => {
  test('invalidates only accountsCache', async () => {
    const { live, mocks } = makeMockLive();
    const tool = new RefreshCacheTool(live);

    const result = await tool.refresh({ scope: 'accounts' });

    expect(mocks.accounts.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.categories.invalidate).not.toHaveBeenCalled();
    expect(result.flushed.accounts).toBe(true);
  });
});

describe('RefreshCacheTool — scope: tags', () => {
  test('invalidates only tagsCache', async () => {
    const { live, mocks } = makeMockLive();
    const tool = new RefreshCacheTool(live);

    const result = await tool.refresh({ scope: 'tags' });

    expect(mocks.tags.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.categories.invalidate).not.toHaveBeenCalled();
    expect(result.flushed.tags).toBe(true);
  });
});

describe('RefreshCacheTool — scope: networth', () => {
  test('invalidates only networthCache', async () => {
    const { live, mocks } = makeMockLive();
    const tool = new RefreshCacheTool(live);

    const result = await tool.refresh({ scope: 'networth' });

    expect(mocks.networth.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.categories.invalidate).not.toHaveBeenCalled();
    expect(mocks.accounts.invalidate).not.toHaveBeenCalled();
    expect(result.flushed.networth).toBe(true);
  });
});

describe('RefreshCacheTool — scope: recurring', () => {
  test('invalidates only recurringCache', async () => {
    const { live, mocks } = makeMockLive();
    const tool = new RefreshCacheTool(live);

    const result = await tool.refresh({ scope: 'recurring' });

    expect(mocks.recurring.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.categories.invalidate).not.toHaveBeenCalled();
    expect(mocks.upcomingRecurrings.invalidate).not.toHaveBeenCalled();
    expect(result.flushed.recurring).toBe(true);
  });
});

describe('RefreshCacheTool — scope: upcoming_recurrings', () => {
  test('invalidates only upcomingRecurringsCache', async () => {
    const { live, mocks } = makeMockLive();
    const tool = new RefreshCacheTool(live);

    const result = await tool.refresh({ scope: 'upcoming_recurrings' });

    expect(mocks.upcomingRecurrings.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.recurring.invalidate).not.toHaveBeenCalled();
    expect(mocks.categories.invalidate).not.toHaveBeenCalled();
    expect(result.flushed.upcoming_recurrings).toBe(true);
  });
});

describe('RefreshCacheTool — scope: user (audit C6)', () => {
  test('cascades to categoriesCache so rollover changes surface immediately', async () => {
    // The user setting (rolloversConfig.isEnabled) is read inside
    // categoriesCache.read() — so flushing user alone wouldn't surface new
    // rollover data until categoriesCache also expires (up to 24h). The
    // 'user' scope cascades to categoriesCache to make the documented
    // "use after toggling rollover" advice actually work.
    const { live, mocks } = makeMockLive();
    const tool = new RefreshCacheTool(live);

    const result = await tool.refresh({ scope: 'user' });

    expect(mocks.user.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.categories.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.accounts.invalidate).not.toHaveBeenCalled();
    expect(mocks.tags.invalidate).not.toHaveBeenCalled();
    expect(mocks.recurring.invalidate).not.toHaveBeenCalled();
    expect(mocks.transactions.invalidate).not.toHaveBeenCalled();
    expect(result.flushed.user).toBe(true);
    expect(result.flushed.categories).toBe(true);
    expect(result.flushed.accounts).toBeUndefined();
  });
});

describe('RefreshCacheTool — scope: monthly_spend', () => {
  test('invalidates only monthlySpendCache', async () => {
    const { live, mocks } = makeMockLive();
    const tool = new RefreshCacheTool(live);

    const result = await tool.refresh({ scope: 'monthly_spend' });

    expect(mocks.monthlySpend.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.accounts.invalidate).not.toHaveBeenCalled();
    expect(mocks.categories.invalidate).not.toHaveBeenCalled();
    expect(mocks.tags.invalidate).not.toHaveBeenCalled();
    expect(mocks.recurring.invalidate).not.toHaveBeenCalled();
    expect(mocks.transactions.invalidate).not.toHaveBeenCalled();
    expect(result.flushed.monthly_spend).toBe(true);
    expect(result.flushed.accounts).toBeUndefined();
  });
});

describe('RefreshCacheTool — scope: transactions', () => {
  test('flushes all transaction months by default', async () => {
    const { live, mocks } = makeMockLive();
    const tool = new RefreshCacheTool(live);

    const result = await tool.refresh({ scope: 'transactions' });

    expect(mocks.transactions.invalidate).toHaveBeenCalledWith('all');
    expect(result.flushed.transactions_months).toBe('all');
    expect(mocks.categories.invalidate).not.toHaveBeenCalled();
  });

  test('flushes specific months when provided', async () => {
    const { live, mocks } = makeMockLive();
    const tool = new RefreshCacheTool(live);

    const result = await tool.refresh({ scope: 'transactions', months: ['2026-03'] });

    expect(mocks.transactions.invalidate).toHaveBeenCalledWith(['2026-03']);
    expect(result.flushed.transactions_months).toEqual(['2026-03']);
  });
});

describe('RefreshCacheTool — validation', () => {
  test('rejects unknown scope', async () => {
    const { live } = makeMockLive();
    const tool = new RefreshCacheTool(live);

    await expect(tool.refresh({ scope: 'unknown' as 'all' })).rejects.toThrow(/Unknown scope/);
  });

  test('rejects invalid month format', async () => {
    const { live } = makeMockLive();
    const tool = new RefreshCacheTool(live);

    await expect(tool.refresh({ scope: 'transactions', months: ['26-04'] })).rejects.toThrow(
      /Invalid month format/
    );
  });

  test('default scope (omitted) behaves as all', async () => {
    const { live, mocks } = makeMockLive();
    const tool = new RefreshCacheTool(live);

    const result = await tool.refresh({});

    expect(mocks.accounts.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.categories.invalidate).toHaveBeenCalledTimes(1);
    expect(result.flushed.transactions_months).toBe('all');
  });
});

describe('createRefreshCacheToolSchema', () => {
  test('schema name is refresh_cache', () => {
    const schema = createRefreshCacheToolSchema();
    expect(schema.name).toBe('refresh_cache');
  });

  test('budgets scope is listed in enum', () => {
    const schema = createRefreshCacheToolSchema();
    const scopeProp = schema.inputSchema.properties.scope as { enum: string[] };
    expect(scopeProp.enum).toContain('budgets');
  });

  test('user scope is listed in enum (audit C6)', () => {
    const schema = createRefreshCacheToolSchema();
    const scopeProp = schema.inputSchema.properties.scope as { enum: string[] };
    expect(scopeProp.enum).toContain('user');
  });

  test('upcoming_recurrings scope is listed in enum', () => {
    const schema = createRefreshCacheToolSchema();
    const scopeProp = schema.inputSchema.properties.scope as { enum: string[] };
    expect(scopeProp.enum).toContain('upcoming_recurrings');
  });

  test('monthly_spend scope is listed in enum', () => {
    const schema = createRefreshCacheToolSchema();
    const scopeProp = schema.inputSchema.properties.scope as { enum: string[] };
    expect(scopeProp.enum).toContain('monthly_spend');
  });

  test('schema description mentions budgets piggyback on categories', () => {
    const schema = createRefreshCacheToolSchema();
    const scopeProp = schema.inputSchema.properties.scope as { description: string };
    expect(scopeProp.description.toLowerCase()).toMatch(/budget|categor/);
  });
});
