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

  test('budget field on parent and children survives flatten', async () => {
    const sampleBudget = {
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
        id: 'budget-current',
      },
      histories: [],
    };

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
              icon: null,
              budget: sampleBudget,
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
                  budget: sampleBudget,
                },
              ],
            },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchCategories } = await import('../../../../src/core/graphql/queries/categories.js');
    const rows = await fetchCategories(client);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.budget?.current?.amount).toBe('500');
    expect(rows[1]?.budget?.current?.amount).toBe('500');
  });

  test('regression C3: parentId set to null for parents, parent.id for children', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          categories: [
            {
              id: 'home-id',
              name: '🏠 Home',
              templateId: 'Household',
              colorName: 'ORANGE2',
              icon: { __typename: 'EmojiUnicode', unicode: '🏠' },
              isExcluded: false,
              isRolloverDisabled: false,
              canBeDeleted: false,
              budget: null,
              childCategories: [
                {
                  id: 'rent-id',
                  name: 'Rent',
                  templateId: 'Rent',
                  colorName: 'ORANGE2',
                  icon: { __typename: 'EmojiUnicode', unicode: '🔑' },
                  isExcluded: false,
                  isRolloverDisabled: false,
                  canBeDeleted: true,
                  budget: null,
                },
                {
                  id: 'utilities-id',
                  name: 'Utilities',
                  templateId: 'Utilities',
                  colorName: 'ORANGE2',
                  icon: { __typename: 'EmojiUnicode', unicode: '🧹' },
                  isExcluded: false,
                  isRolloverDisabled: false,
                  canBeDeleted: true,
                  budget: null,
                },
              ],
            },
            {
              id: 'standalone-id',
              name: 'Insurance',
              templateId: 'Insurance',
              colorName: 'YELLOW1',
              icon: { __typename: 'EmojiUnicode', unicode: '☂️' },
              isExcluded: false,
              isRolloverDisabled: false,
              canBeDeleted: true,
              budget: null,
              childCategories: [],
            },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchCategories } = await import('../../../../src/core/graphql/queries/categories.js');
    const flat = await fetchCategories(client);

    const home = flat.find((c) => c.id === 'home-id');
    const rent = flat.find((c) => c.id === 'rent-id');
    const utilities = flat.find((c) => c.id === 'utilities-id');
    const insurance = flat.find((c) => c.id === 'standalone-id');

    // Parents and standalone categories: parentId is null.
    expect(home?.parentId).toBeNull();
    expect(insurance?.parentId).toBeNull();

    // Children: parentId points at their parent's id.
    expect(rent?.parentId).toBe('home-id');
    expect(utilities?.parentId).toBe('home-id');

    // No childCategories field on flattened output.
    expect((home as Record<string, unknown>)?.childCategories).toBeUndefined();
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
