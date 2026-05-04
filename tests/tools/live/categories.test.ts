import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import { CopilotDatabase } from '../../../src/core/database.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import { LiveCategoriesTools } from '../../../src/tools/live/categories.js';
import type { CategoryNode } from '../../../src/core/graphql/queries/categories.js';

function makeClient(rows: unknown[]): GraphQLClient {
  // Single-shape mock: every query (User, Categories, ...) returns the same
  // `{categories: rows}` payload. The `categories` key is ignored by the User
  // query; the User query's `data.user` field is undefined here, which is fine
  // for tests that pre-warm userCache directly (most tests below). For tests
  // that exercise the user-config path, use makeMultiOpClient.
  return {
    query: mock(() => Promise.resolve({ categories: rows })),
  } as unknown as GraphQLClient;
}

function makeLive(client: GraphQLClient): LiveCopilotDatabase {
  return new LiveCopilotDatabase(client, new CopilotDatabase('/tmp/no-such-db'));
}

// Pre-warms userCache with rollovers OFF so tests that don't exercise the
// user-config path can still read categories without hitting the User query.
// The historical hardcoded `rollovers: false` matches this default.
async function prewarmUserCacheRolloversOff(live: LiveCopilotDatabase): Promise<void> {
  await live.getUserCache().read(() =>
    Promise.resolve([
      {
        id: 'test-user',
        budgetingConfig: {
          isEnabled: true,
          rolloversConfig: { isEnabled: false, startDate: null },
        },
      },
    ])
  );
}

const sampleRow = {
  id: 'cat-1',
  name: 'Coffee',
  templateId: 'Coffee',
  colorName: 'ORANGE2',
  isExcluded: false,
  isRolloverDisabled: false,
  canBeDeleted: true,
  icon: { __typename: 'EmojiUnicode', unicode: '☕' },
  budget: null,
};

describe('LiveCategoriesTools.getCategories', () => {
  test('cold call: fetches and returns rows with cache_hit=false', async () => {
    const client = makeClient([sampleRow]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveCategoriesTools(live);

    const result = await tools.getCategories({});

    expect(result.count).toBe(1);
    expect(result.categories[0]?.id).toBe('cat-1');
    expect(result._cache_hit).toBe(false);
    expect(typeof result._cache_oldest_fetched_at).toBe('string');
  });

  test('warm call: cache hit, no second fetch', async () => {
    const client = makeClient([sampleRow]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveCategoriesTools(live);

    await tools.getCategories({});
    const second = await tools.getCategories({});

    expect(second._cache_hit).toBe(true);
    // userCache pre-warmed (so no User query); only the Categories query fires.
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('excluded_only=true filters to isExcluded categories', async () => {
    const client = makeClient([
      sampleRow,
      { ...sampleRow, id: 'cat-2', name: 'Excluded', isExcluded: true },
    ]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveCategoriesTools(live);

    const result = await tools.getCategories({ excluded_only: true });

    expect(result.count).toBe(1);
    expect(result.categories[0]?.id).toBe('cat-2');
  });

  test('empty result returns count 0, no throw', async () => {
    const client = makeClient([]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveCategoriesTools(live);

    const result = await tools.getCategories({});

    expect(result.count).toBe(0);
    expect(result.categories).toEqual([]);
  });

  test('output sorted by templateId then name; null templateId sorts last', async () => {
    const client = makeClient([
      { ...sampleRow, id: 'a', name: 'Zebra', templateId: 'Food' },
      { ...sampleRow, id: 'b', name: 'Apple', templateId: 'Food' },
      { ...sampleRow, id: 'c', name: 'Cake', templateId: 'Drink' },
      { ...sampleRow, id: 'd', name: 'Custom', templateId: null },
    ]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveCategoriesTools(live);

    const result = await tools.getCategories({});

    // Drink < Food < null-sentinel; within Food, Apple < Zebra
    expect(result.categories.map((c) => c.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  test('regression C1: default include_history=false strips budget.histories', async () => {
    const fixture: CategoryNode = {
      id: 'cat-1',
      parentId: null,
      name: 'Restaurants',
      templateId: 'Restaurants',
      colorName: 'PURPLE2',
      icon: { __typename: 'EmojiUnicode', unicode: '🍔' },
      isExcluded: false,
      isRolloverDisabled: false,
      canBeDeleted: true,
      budget: {
        current: {
          unassignedRolloverAmount: null,
          childRolloverAmount: null,
          unassignedAmount: null,
          resolvedAmount: '500',
          rolloverAmount: '0',
          childAmount: null,
          goalAmount: '0',
          amount: '500',
          month: '2026-05',
          id: 'budget-current-id',
        },
        histories: [
          {
            unassignedRolloverAmount: null,
            childRolloverAmount: null,
            unassignedAmount: null,
            resolvedAmount: '500',
            rolloverAmount: '0',
            childAmount: null,
            goalAmount: '0',
            amount: '500',
            month: '2026-04',
            id: 'budget-history-1',
          },
          {
            unassignedRolloverAmount: null,
            childRolloverAmount: null,
            unassignedAmount: null,
            resolvedAmount: '500',
            rolloverAmount: '0',
            childAmount: null,
            goalAmount: '0',
            amount: '500',
            month: '2026-03',
            id: 'budget-history-2',
          },
        ],
      },
    };
    const live = makeLive(makeClient([fixture]));
    const tools = new LiveCategoriesTools(live);

    const result = await tools.getCategories({});

    expect(result.count).toBe(1);
    // Default behavior: histories must be stripped to keep response small.
    expect(result.categories[0]?.budget?.histories).toEqual([]);
    // Current month is preserved.
    expect(result.categories[0]?.budget?.current?.amount).toBe('500');

    // Cache must NOT be mutated — second read should still see histories
    // (verifies the projection clones rather than mutates).
    const cached = live.getCategoriesCache().peek();
    expect(cached?.[0]?.budget?.histories).toHaveLength(2);
  });

  test('regression C1: include_history=true preserves budget.histories', async () => {
    const fixture: CategoryNode = {
      id: 'cat-1',
      parentId: null,
      name: 'Restaurants',
      templateId: 'Restaurants',
      colorName: 'PURPLE2',
      icon: { __typename: 'EmojiUnicode', unicode: '🍔' },
      isExcluded: false,
      isRolloverDisabled: false,
      canBeDeleted: true,
      budget: {
        current: null,
        histories: [
          {
            unassignedRolloverAmount: null,
            childRolloverAmount: null,
            unassignedAmount: null,
            resolvedAmount: '500',
            rolloverAmount: '0',
            childAmount: null,
            goalAmount: '0',
            amount: '500',
            month: '2026-04',
            id: 'budget-history-1',
          },
        ],
      },
    };
    const live = makeLive(makeClient([fixture]));
    const tools = new LiveCategoriesTools(live);

    const result = await tools.getCategories({ include_history: true });

    expect(result.categories[0]?.budget?.histories).toHaveLength(1);
    expect(result.categories[0]?.budget?.histories[0]?.month).toBe('2026-04');
  });
});

describe('LiveCategoriesTools.getCategories — audit C6 regression', () => {
  // Multi-op mock client: discriminates by op name so we can capture the
  // Categories variables while also returning a User payload.
  function makeMultiOpClient(opts: {
    user: {
      id: string;
      budgetingConfig: {
        isEnabled: boolean;
        rolloversConfig: { isEnabled: boolean; startDate: string | null } | null;
      } | null;
    };
    categories?: unknown[];
  }): { client: GraphQLClient; calls: Array<{ op: string; vars: Record<string, unknown> }> } {
    const calls: Array<{ op: string; vars: Record<string, unknown> }> = [];
    const client = {
      query: mock((op: string, _q: string, vars: Record<string, unknown>) => {
        calls.push({ op, vars });
        if (op === 'User') return Promise.resolve({ user: opts.user });
        if (op === 'Categories') return Promise.resolve({ categories: opts.categories ?? [] });
        return Promise.resolve({});
      }),
    } as unknown as GraphQLClient;
    return { client, calls };
  }

  test('rollovers flag mirrors user.budgetingConfig.rolloversConfig.isEnabled (true)', async () => {
    const { client, calls } = makeMultiOpClient({
      user: {
        id: 'u-1',
        budgetingConfig: {
          isEnabled: true,
          rolloversConfig: { isEnabled: true, startDate: '2026-01' },
        },
      },
    });
    const tools = new LiveCategoriesTools(makeLive(client));

    await tools.getCategories({});

    const categoriesCall = calls.find((c) => c.op === 'Categories');
    expect(categoriesCall?.vars.rollovers).toBe(true);
    // Sanity: User query also fired.
    expect(calls.some((c) => c.op === 'User')).toBe(true);
  });

  test('rollovers flag is false when rolloversConfig.isEnabled is false', async () => {
    const { client, calls } = makeMultiOpClient({
      user: {
        id: 'u-2',
        budgetingConfig: {
          isEnabled: true,
          rolloversConfig: { isEnabled: false, startDate: null },
        },
      },
    });
    const tools = new LiveCategoriesTools(makeLive(client));

    await tools.getCategories({});

    const categoriesCall = calls.find((c) => c.op === 'Categories');
    expect(categoriesCall?.vars.rollovers).toBe(false);
  });

  test('rollovers flag is false when budgetingConfig.isEnabled is false (defensive)', async () => {
    const { client, calls } = makeMultiOpClient({
      user: {
        id: 'u-3',
        budgetingConfig: {
          isEnabled: false,
          rolloversConfig: { isEnabled: true, startDate: '2026-01' },
        },
      },
    });
    const tools = new LiveCategoriesTools(makeLive(client));

    await tools.getCategories({});

    const categoriesCall = calls.find((c) => c.op === 'Categories');
    expect(categoriesCall?.vars.rollovers).toBe(false);
  });

  test('rollovers flag is false when budgetingConfig is null', async () => {
    const { client, calls } = makeMultiOpClient({
      user: { id: 'u-4', budgetingConfig: null },
    });
    const tools = new LiveCategoriesTools(makeLive(client));

    await tools.getCategories({});

    const categoriesCall = calls.find((c) => c.op === 'Categories');
    expect(categoriesCall?.vars.rollovers).toBe(false);
  });

  test('userCache shields callers: a second getCategories call does not refetch User', async () => {
    const { client, calls } = makeMultiOpClient({
      user: {
        id: 'u-1',
        budgetingConfig: {
          isEnabled: true,
          rolloversConfig: { isEnabled: true, startDate: '2026-01' },
        },
      },
    });
    const live = makeLive(client);
    const tools = new LiveCategoriesTools(live);

    await tools.getCategories({});
    // Force a second cold Categories fetch by invalidating only categoriesCache.
    live.getCategoriesCache().invalidate();
    await tools.getCategories({});

    const userCalls = calls.filter((c) => c.op === 'User');
    const categoryCalls = calls.filter((c) => c.op === 'Categories');
    expect(userCalls).toHaveLength(1);
    expect(categoryCalls).toHaveLength(2);
  });
});

describe('createLiveCategoriesToolSchema', () => {
  test('returns a schema with readOnlyHint=true', async () => {
    const { createLiveCategoriesToolSchema } =
      await import('../../../src/tools/live/categories.js');
    const schema = createLiveCategoriesToolSchema();
    expect(schema.name).toBe('get_categories_live');
    expect(schema.annotations?.readOnlyHint).toBe(true);
  });
});
