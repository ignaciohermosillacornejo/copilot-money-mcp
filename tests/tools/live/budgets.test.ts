import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import { CopilotDatabase } from '../../../src/core/database.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import { LiveBudgetsTools } from '../../../src/tools/live/budgets.js';

function makeClient(categoriesResponse: unknown[]): GraphQLClient {
  return {
    query: mock(() => Promise.resolve({ categories: categoriesResponse })),
  } as unknown as GraphQLClient;
}

function makeLive(client: GraphQLClient): LiveCopilotDatabase {
  return new LiveCopilotDatabase(client, new CopilotDatabase('/tmp/no-such-db'));
}

// Pre-warms userCache with rollovers OFF so tests that don't exercise the
// user-config path can still read categories without hitting the User query.
// Audit C6: the historical hardcoded `rollovers: false` matches this default.
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

const sampleCategoryWithBudget = {
  id: 'cat-food',
  name: 'Food',
  templateId: 'Food',
  colorName: 'ORANGE2',
  isExcluded: false,
  isRolloverDisabled: false,
  canBeDeleted: true,
  icon: { __typename: 'EmojiUnicode', unicode: '🍱' },
  budget: {
    current: {
      unassignedRolloverAmount: '0',
      childRolloverAmount: '0',
      unassignedAmount: '50',
      resolvedAmount: '450',
      rolloverAmount: '0',
      childAmount: null,
      goalAmount: '500',
      amount: '500',
      month: '2026-05',
      id: 'budget-food-current',
    },
    histories: [
      {
        unassignedRolloverAmount: '0',
        childRolloverAmount: '0',
        unassignedAmount: '0',
        resolvedAmount: '400',
        rolloverAmount: '0',
        childAmount: null,
        goalAmount: '400',
        amount: '400',
        month: '2026-04',
        id: 'budget-food-2026-04',
      },
    ],
  },
};

const sampleCategoryWithoutBudget = {
  id: 'cat-misc',
  name: 'Misc',
  templateId: null,
  colorName: null,
  isExcluded: false,
  isRolloverDisabled: false,
  canBeDeleted: true,
  icon: null,
  budget: null,
};

// Builds a Restaurants category with `monthCount` consecutive months of
// history ending at 2026-05 (inclusive). Used by the C4 regression tests
// to exercise the months_window trim with various input sizes.
function makeRestaurantsCategory(monthCount: number) {
  const months = Array.from({ length: monthCount }, (_, i) => {
    // Date.UTC months are 0-indexed (May = 4). Anchor the last entry at
    // 2026-05; first entry is 2026-05 minus (monthCount - 1) months.
    const d = new Date(Date.UTC(2026, 4 - (monthCount - 1) + i, 1));
    return d.toISOString().slice(0, 7);
  });
  return {
    id: 'cat-restaurants',
    name: 'Restaurants',
    templateId: 'Restaurants',
    colorName: 'PURPLE2',
    icon: { __typename: 'EmojiUnicode', unicode: '🍔' },
    isExcluded: false,
    isRolloverDisabled: false,
    canBeDeleted: true,
    budget: {
      current: null,
      histories: months.map((m, i) => ({
        unassignedRolloverAmount: null,
        childRolloverAmount: null,
        unassignedAmount: null,
        resolvedAmount: '500',
        rolloverAmount: '0',
        childAmount: null,
        goalAmount: '0',
        amount: '500',
        month: m,
        id: `b-${i}`,
      })),
    },
  };
}

describe('LiveBudgetsTools.getBudgets', () => {
  test('cold call: projects per-category budgets from categoriesCache', async () => {
    const client = makeClient([sampleCategoryWithBudget, sampleCategoryWithoutBudget]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveBudgetsTools(live);

    const result = await tools.getBudgets({});

    expect(result.count).toBe(1); // only categories with budget data are returned
    expect(result.budgets[0]?.budget_id).toBe('cat-food');
    expect(result.budgets[0]?.category_id).toBe('cat-food');
    expect(result.budgets[0]?.category_name).toBe('Food');
    expect(result.budgets[0]?.amount).toBe(500);
    expect(result.budgets[0]?.amounts).toEqual({ '2026-05': 500, '2026-04': 400 });
    expect(result.total_budgeted).toBe(500);
    expect(result._cache_hit).toBe(false);
  });

  test('warm call: cache hit, no second fetch', async () => {
    const client = makeClient([sampleCategoryWithBudget]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveBudgetsTools(live);

    await tools.getBudgets({});
    const second = await tools.getBudgets({});

    expect(second._cache_hit).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('empty categoriesCache returns count 0, no throw', async () => {
    const client = makeClient([]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveBudgetsTools(live);

    const result = await tools.getBudgets({});

    expect(result.count).toBe(0);
    expect(result.budgets).toEqual([]);
    expect(result.total_budgeted).toBe(0);
  });

  test('handles category with budget.current=null but non-empty histories', async () => {
    const cat = {
      ...sampleCategoryWithBudget,
      budget: {
        current: null,
        histories: [sampleCategoryWithBudget.budget.histories[0]],
      },
    };
    const client = makeClient([cat]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveBudgetsTools(live);

    const result = await tools.getBudgets({});

    expect(result.count).toBe(1);
    expect(result.budgets[0]?.amount).toBeUndefined(); // no current
    expect(result.budgets[0]?.amounts).toEqual({ '2026-04': 400 });
  });

  test('regression C4: default months_window=12 trims amounts to exactly 12 entries', async () => {
    // 24-month fixture; default trim should return exactly the trailing 12.
    const client = makeClient([makeRestaurantsCategory(24)]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveBudgetsTools(live);

    const result = await tools.getBudgets({});

    const restaurants = result.budgets.find((b) => b.category_id === 'cat-restaurants');
    expect(restaurants?.amounts).toBeDefined();
    expect(Object.keys(restaurants?.amounts ?? {}).length).toBe(12);
  });

  test('regression C4: months_window=0 returns all amounts', async () => {
    // 24-month fixture; opt-out should return all 24.
    const client = makeClient([makeRestaurantsCategory(24)]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveBudgetsTools(live);

    const result = await tools.getBudgets({ months_window: 0 });

    const restaurants = result.budgets.find((b) => b.category_id === 'cat-restaurants');
    expect(Object.keys(restaurants?.amounts ?? {}).length).toBe(24);
  });

  test('regression C4: explicit months_window trims to that exact count', async () => {
    // 24-month fixture, custom window of 3 — covers a non-boundary value
    // (neither the default 12 nor the opt-out sentinel 0).
    const client = makeClient([makeRestaurantsCategory(24)]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveBudgetsTools(live);

    const result = await tools.getBudgets({ months_window: 3 });

    const restaurants = result.budgets.find((b) => b.category_id === 'cat-restaurants');
    const keys = Object.keys(restaurants?.amounts ?? {}).sort();
    expect(keys.length).toBe(3);
    // The trailing 3 months ending at 2026-05 are 2026-03, 2026-04, 2026-05.
    expect(keys).toEqual(['2026-03', '2026-04', '2026-05']);
  });

  test('handles category with budget.current present but current.amount=null', async () => {
    const cat = {
      id: 'cat-misc',
      name: 'Misc',
      templateId: null,
      colorName: null,
      icon: null,
      isExcluded: false,
      isRolloverDisabled: false,
      canBeDeleted: true,
      budget: {
        current: {
          unassignedRolloverAmount: null,
          childRolloverAmount: null,
          unassignedAmount: null,
          resolvedAmount: null,
          rolloverAmount: null,
          childAmount: null,
          goalAmount: null,
          amount: null,
          month: '2026-05',
          id: 'budget-misc-null',
        },
        histories: [],
      },
    };
    const client = makeClient([cat]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveBudgetsTools(live);

    const result = await tools.getBudgets({});

    // current.amount=null → parseAmount returns undefined → neither `amount` nor
    // an `amounts` entry is produced for the current month; histories is empty too.
    // projectCategory drops the row entirely (no current amount AND no history amounts).
    expect(result.count).toBe(0);
  });

  test('regression C2: total_budgeted sums only top-level categories (parents + standalones), not children', async () => {
    // Parent with amount 200 and one child with amount 100. Pre-fix the
    // headline summed 300, double-counting because the parent's amount
    // already includes the child's base via the GraphQL `childAmount` field.
    // Post-fix: only the parent (200) contributes; the child is skipped.
    // Fixture mirrors the GraphQL tree shape so fetchCategories synthesizes
    // child.parentId = parent.id during flatten.
    const childRow = {
      id: 'child-rent',
      name: 'Rent',
      templateId: 'Rent',
      colorName: 'ORANGE2',
      isExcluded: false,
      isRolloverDisabled: false,
      canBeDeleted: true,
      icon: { __typename: 'EmojiUnicode', unicode: '🔑' },
      budget: {
        current: {
          unassignedRolloverAmount: null,
          childRolloverAmount: null,
          unassignedAmount: null,
          resolvedAmount: '100',
          rolloverAmount: '0',
          childAmount: null,
          goalAmount: '0',
          amount: '100',
          month: '2026-05',
          id: 'b-child-current',
        },
        histories: [],
      },
    };
    const parentRow = {
      id: 'parent-home',
      name: 'Home',
      templateId: null,
      colorName: 'ORANGE2',
      isExcluded: false,
      isRolloverDisabled: false,
      canBeDeleted: true,
      icon: null,
      budget: {
        current: {
          unassignedRolloverAmount: '50',
          childRolloverAmount: '0',
          unassignedAmount: '100',
          resolvedAmount: '200',
          rolloverAmount: '50',
          childAmount: '100',
          goalAmount: '0',
          amount: '200',
          month: '2026-05',
          id: 'b-parent-current',
        },
        histories: [],
      },
      childCategories: [childRow],
    };

    const client = makeClient([parentRow]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveBudgetsTools(live);

    const result = await tools.getBudgets({});

    expect(result.count).toBe(2);
    expect(result.total_budgeted).toBe(200);
  });

  test('regression C2: standalones are still counted in total_budgeted', async () => {
    // Standalone (no children) + parent (with one child). Headline = standalone + parent.
    const standalone = {
      id: 'standalone-sub',
      name: 'Subscriptions',
      templateId: 'Subscriptions',
      colorName: 'PINK1',
      isExcluded: false,
      isRolloverDisabled: false,
      canBeDeleted: true,
      icon: { __typename: 'EmojiUnicode', unicode: '💳' },
      budget: {
        current: {
          unassignedRolloverAmount: null,
          childRolloverAmount: null,
          unassignedAmount: null,
          resolvedAmount: '50',
          rolloverAmount: '0',
          childAmount: null,
          goalAmount: '0',
          amount: '50',
          month: '2026-05',
          id: 'b-standalone-current',
        },
        histories: [],
      },
    };
    const parentWithChild = {
      id: 'parent-home',
      name: 'Home',
      templateId: null,
      colorName: 'ORANGE2',
      isExcluded: false,
      isRolloverDisabled: false,
      canBeDeleted: true,
      icon: null,
      budget: {
        current: {
          unassignedRolloverAmount: '50',
          childRolloverAmount: '0',
          unassignedAmount: '100',
          resolvedAmount: '200',
          rolloverAmount: '50',
          childAmount: '100',
          goalAmount: '0',
          amount: '200',
          month: '2026-05',
          id: 'b-parent-current2',
        },
        histories: [],
      },
      childCategories: [
        {
          id: 'child-rent',
          name: 'Rent',
          templateId: 'Rent',
          colorName: 'ORANGE2',
          isExcluded: false,
          isRolloverDisabled: false,
          canBeDeleted: true,
          icon: { __typename: 'EmojiUnicode', unicode: '🔑' },
          budget: {
            current: {
              unassignedRolloverAmount: null,
              childRolloverAmount: null,
              unassignedAmount: null,
              resolvedAmount: '100',
              rolloverAmount: '0',
              childAmount: null,
              goalAmount: '0',
              amount: '100',
              month: '2026-05',
              id: 'b-child-current2',
            },
            histories: [],
          },
        },
      ],
    };

    const client = makeClient([standalone, parentWithChild]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveBudgetsTools(live);

    const result = await tools.getBudgets({});

    expect(result.count).toBe(3);
    expect(result.total_budgeted).toBe(250); // 50 standalone + 200 parent
  });
});

describe('createLiveBudgetsToolSchema', () => {
  test('returns a schema with readOnlyHint=true', async () => {
    const { createLiveBudgetsToolSchema } = await import('../../../src/tools/live/budgets.js');
    const schema = createLiveBudgetsToolSchema();
    expect(schema.name).toBe('get_budgets_live');
    expect(schema.annotations?.readOnlyHint).toBe(true);
  });
});
