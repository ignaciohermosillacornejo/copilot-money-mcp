import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

describe('fetchCategories', () => {
  test('flattens childCategories into a single flat list', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          categories: [
            {
              id: 'parent-1',
              name: 'Food',
              templateId: 'Food',
              colorName: 'ORANGE2',
              isExcluded: false,
              isRolloverDisabled: false,
              canBeDeleted: true,
              icon: { __typename: 'EmojiUnicode', unicode: '🍱' },
              childCategories: [
                {
                  id: 'child-1',
                  name: 'Coffee',
                  templateId: 'Coffee',
                  colorName: 'ORANGE2',
                  isExcluded: false,
                  isRolloverDisabled: false,
                  canBeDeleted: true,
                  icon: { __typename: 'EmojiUnicode', unicode: '☕' },
                },
              ],
              budget: null,
            },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchCategories } = await import('../../../../src/core/graphql/queries/categories.js');
    const rows = await fetchCategories(client);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(['parent-1', 'child-1']);
    // Child does not duplicate as parent's childCategories field
    expect(rows.find((r) => r.id === 'child-1')?.childCategories).toBeUndefined();
  });

  test('handles multiple parents with mixed children/empty children, preserving order', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          categories: [
            {
              id: 'parent-1',
              name: 'Food',
              templateId: 'Food',
              colorName: null,
              isExcluded: false,
              isRolloverDisabled: false,
              canBeDeleted: true,
              icon: null,
              childCategories: [
                {
                  id: 'child-1',
                  name: 'Coffee',
                  templateId: null,
                  colorName: null,
                  isExcluded: false,
                  isRolloverDisabled: false,
                  canBeDeleted: true,
                  icon: null,
                },
              ],
              budget: null,
            },
            {
              id: 'parent-2',
              name: 'Rent',
              templateId: 'Rent',
              colorName: null,
              isExcluded: false,
              isRolloverDisabled: false,
              canBeDeleted: true,
              icon: null,
              childCategories: [],
              budget: null,
            },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchCategories } = await import('../../../../src/core/graphql/queries/categories.js');
    const rows = await fetchCategories(client);

    expect(rows.map((r) => r.id)).toEqual(['parent-1', 'child-1', 'parent-2']);
  });

  test('passes {spend:false, budget:true, rollovers:false} variables', async () => {
    const client = {
      query: mock(() => Promise.resolve({ categories: [] })),
    } as unknown as GraphQLClient;

    const { fetchCategories } = await import('../../../../src/core/graphql/queries/categories.js');
    await fetchCategories(client);

    expect(client.query).toHaveBeenCalledWith('Categories', expect.any(String), {
      spend: false,
      budget: true,
      rollovers: false,
    });
  });
});
