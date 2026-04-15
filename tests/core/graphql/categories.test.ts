import { describe, test, expect, mock } from 'bun:test';
import {
  createCategory,
  editCategory,
  deleteCategory,
} from '../../../src/core/graphql/categories.js';
import {
  CREATE_CATEGORY,
  EDIT_CATEGORY,
  DELETE_CATEGORY,
} from '../../../src/core/graphql/operations.generated.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';

function createMockClient(response: unknown): GraphQLClient {
  return {
    mutate: mock((_op: string, _q: string, _v: unknown) => Promise.resolve(response)),
  } as unknown as GraphQLClient;
}

describe('createCategory', () => {
  test('sends CreateCategory mutation with input, spend, budget variables', async () => {
    const client = createMockClient({
      createCategory: { id: 'cat-1', name: 'Snacks', colorName: 'OLIVE1' },
    });
    await createCategory(client, {
      input: { name: 'Snacks', colorName: 'OLIVE1', emoji: '🍿', isExcluded: false },
    });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('CreateCategory');
    expect(call[1]).toBe(CREATE_CATEGORY);
    expect(call[2]).toEqual({
      spend: false,
      budget: false,
      input: { name: 'Snacks', colorName: 'OLIVE1', emoji: '🍿', isExcluded: false },
    });
  });

  test('returns compact { id, name, colorName }', async () => {
    const client = createMockClient({
      createCategory: { id: 'cat-1', name: 'Snacks', colorName: 'OLIVE1' },
    });
    const out = await createCategory(client, {
      input: { name: 'Snacks', colorName: 'OLIVE1', emoji: '🍿', isExcluded: false },
    });
    expect(out).toEqual({ id: 'cat-1', name: 'Snacks', colorName: 'OLIVE1' });
  });
});

describe('editCategory', () => {
  test('sends EditCategory with id + input + spend/budget:false', async () => {
    const client = createMockClient({
      editCategory: { category: { id: 'cat-1', name: 'Treats', colorName: 'OLIVE1' } },
    });
    await editCategory(client, { id: 'cat-1', input: { name: 'Treats' } });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('EditCategory');
    expect(call[1]).toBe(EDIT_CATEGORY);
    expect(call[2]).toEqual({
      id: 'cat-1',
      spend: false,
      budget: false,
      input: { name: 'Treats' },
    });
  });
});

describe('deleteCategory', () => {
  test('sends DeleteCategory with id', async () => {
    const client = createMockClient({ deleteCategory: true });
    await deleteCategory(client, { id: 'cat-1' });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('DeleteCategory');
    expect(call[1]).toBe(DELETE_CATEGORY);
    expect(call[2]).toEqual({ id: 'cat-1' });
  });

  test('returns { id, deleted: true }', async () => {
    const client = createMockClient({ deleteCategory: true });
    const out = await deleteCategory(client, { id: 'cat-1' });
    expect(out).toEqual({ id: 'cat-1', deleted: true });
  });
});
