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

describe('LiveBudgetsTools.getBudgets', () => {
  test('cold call: projects per-category budgets from categoriesCache', async () => {
    const client = makeClient([sampleCategoryWithBudget, sampleCategoryWithoutBudget]);
    const tools = new LiveBudgetsTools(makeLive(client));

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
    const tools = new LiveBudgetsTools(makeLive(client));

    await tools.getBudgets({});
    const second = await tools.getBudgets({});

    expect(second._cache_hit).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('empty categoriesCache returns count 0, no throw', async () => {
    const client = makeClient([]);
    const tools = new LiveBudgetsTools(makeLive(client));

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
    const tools = new LiveBudgetsTools(makeLive(client));

    const result = await tools.getBudgets({});

    expect(result.count).toBe(1);
    expect(result.budgets[0]?.amount).toBeUndefined(); // no current
    expect(result.budgets[0]?.amounts).toEqual({ '2026-04': 400 });
  });

  test('regression C4: default months_window=12 trims amounts to 12 entries', async () => {
    // Build a category with budget history spanning 24 months ending on
    // 2026-05. Default behavior should return only the trailing 12.
    const months = Array.from({ length: 24 }, (_, i) => {
      const d = new Date(Date.UTC(2024, 5 + i, 1)); // 2024-06 through 2026-05
      return d.toISOString().slice(0, 7);
    });
    const fixtureCategory = {
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
    const client = makeClient([fixtureCategory]);
    const tools = new LiveBudgetsTools(makeLive(client));

    const result = await tools.getBudgets({});

    const restaurants = result.budgets.find((b) => b.category_id === 'cat-restaurants');
    expect(restaurants?.amounts).toBeDefined();
    expect(Object.keys(restaurants?.amounts ?? {}).length).toBeLessThanOrEqual(12);
  });

  test('regression C4: months_window=0 returns all amounts', async () => {
    // 24 months in fixture; opt-out should return all 24.
    const months = Array.from({ length: 24 }, (_, i) => {
      const d = new Date(Date.UTC(2024, 5 + i, 1));
      return d.toISOString().slice(0, 7);
    });
    const fixtureCategory = {
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
    const client = makeClient([fixtureCategory]);
    const tools = new LiveBudgetsTools(makeLive(client));

    const result = await tools.getBudgets({ months_window: 0 });

    const restaurants = result.budgets.find((b) => b.category_id === 'cat-restaurants');
    expect(Object.keys(restaurants?.amounts ?? {}).length).toBe(24);
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
    const tools = new LiveBudgetsTools(makeLive(client));

    const result = await tools.getBudgets({});

    // current.amount=null → parseAmount returns undefined → neither `amount` nor
    // an `amounts` entry is produced for the current month; histories is empty too.
    // projectCategory drops the row entirely (no current amount AND no history amounts).
    expect(result.count).toBe(0);
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
