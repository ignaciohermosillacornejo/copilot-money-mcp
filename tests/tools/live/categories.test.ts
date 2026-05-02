import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import { CopilotDatabase } from '../../../src/core/database.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import { LiveCategoriesTools } from '../../../src/tools/live/categories.js';

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

  test('output sorted by templateId then name', async () => {
    const client = makeClient([
      { ...sampleRow, id: 'a', name: 'Zebra', templateId: 'Food' },
      { ...sampleRow, id: 'b', name: 'Apple', templateId: 'Food' },
      { ...sampleRow, id: 'c', name: 'Cake', templateId: 'Drink' },
    ]);
    const tools = new LiveCategoriesTools(makeLive(client));

    const result = await tools.getCategories({});

    expect(result.categories.map((c) => c.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('createLiveCategoriesToolSchema', () => {
  test('returns a schema with readOnlyHint=true', async () => {
    const { createLiveCategoriesToolSchema } = await import('../../../src/tools/live/categories.js');
    const schema = createLiveCategoriesToolSchema();
    expect(schema.name).toBe('get_categories_live');
    expect(schema.annotations?.readOnlyHint).toBe(true);
  });
});
