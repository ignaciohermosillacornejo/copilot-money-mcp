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
});

describe('createLiveBudgetsToolSchema', () => {
  test('returns a schema with readOnlyHint=true', async () => {
    const { createLiveBudgetsToolSchema } = await import('../../../src/tools/live/budgets.js');
    const schema = createLiveBudgetsToolSchema();
    expect(schema.name).toBe('get_budgets_live');
    expect(schema.annotations?.readOnlyHint).toBe(true);
  });
});
