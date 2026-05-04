import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import { CopilotDatabase } from '../../../src/core/database.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import { LiveCategoriesTools } from '../../../src/tools/live/categories.js';
import type { CategoryNode } from '../../../src/core/graphql/queries/categories.js';

function makeClient(rows: unknown[]): GraphQLClient {
  return {
    query: mock(() => Promise.resolve({ categories: rows })),
  } as unknown as GraphQLClient;
}

function makeLive(client: GraphQLClient): LiveCopilotDatabase {
  return new LiveCopilotDatabase(client, new CopilotDatabase('/tmp/no-such-db'));
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
    const tools = new LiveCategoriesTools(makeLive(client));

    const result = await tools.getCategories({});

    expect(result.count).toBe(1);
    expect(result.categories[0]?.id).toBe('cat-1');
    expect(result._cache_hit).toBe(false);
    expect(typeof result._cache_oldest_fetched_at).toBe('string');
  });

  test('warm call: cache hit, no second fetch', async () => {
    const client = makeClient([sampleRow]);
    const tools = new LiveCategoriesTools(makeLive(client));

    await tools.getCategories({});
    const second = await tools.getCategories({});

    expect(second._cache_hit).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('excluded_only=true filters to isExcluded categories', async () => {
    const client = makeClient([
      sampleRow,
      { ...sampleRow, id: 'cat-2', name: 'Excluded', isExcluded: true },
    ]);
    const tools = new LiveCategoriesTools(makeLive(client));

    const result = await tools.getCategories({ excluded_only: true });

    expect(result.count).toBe(1);
    expect(result.categories[0]?.id).toBe('cat-2');
  });

  test('empty result returns count 0, no throw', async () => {
    const client = makeClient([]);
    const tools = new LiveCategoriesTools(makeLive(client));

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
    const tools = new LiveCategoriesTools(makeLive(client));

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

describe('createLiveCategoriesToolSchema', () => {
  test('returns a schema with readOnlyHint=true', async () => {
    const { createLiveCategoriesToolSchema } =
      await import('../../../src/tools/live/categories.js');
    const schema = createLiveCategoriesToolSchema();
    expect(schema.name).toBe('get_categories_live');
    expect(schema.annotations?.readOnlyHint).toBe(true);
  });
});
