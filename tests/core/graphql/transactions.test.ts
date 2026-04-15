import { describe, test, expect, mock } from 'bun:test';
import { editTransaction } from '../../../src/core/graphql/transactions.js';
import { EDIT_TRANSACTION } from '../../../src/core/graphql/operations.generated.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';

function createMockClient(response: unknown): GraphQLClient {
  return {
    mutate: mock((_op: string, _q: string, _v: unknown) => Promise.resolve(response)),
  } as unknown as GraphQLClient;
}

describe('editTransaction', () => {
  test('calls mutate with EditTransaction op name, generated query, and expected variables', async () => {
    const client = createMockClient({
      editTransaction: {
        transaction: {
          id: 't1',
          categoryId: 'c1',
          userNotes: null,
          isReviewed: false,
          tags: [],
        },
      },
    });

    await editTransaction(client, {
      id: 't1',
      accountId: 'a1',
      itemId: 'i1',
      input: { categoryId: 'c1' },
    });

    const calls = (client.mutate as ReturnType<typeof mock>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('EditTransaction');
    expect(calls[0][1]).toBe(EDIT_TRANSACTION);
    expect(calls[0][2]).toEqual({
      id: 't1',
      accountId: 'a1',
      itemId: 'i1',
      input: { categoryId: 'c1' },
    });
  });

  test('returns compact { id, changed } from full response', async () => {
    const client = createMockClient({
      editTransaction: {
        transaction: {
          id: 't1',
          categoryId: 'c2',
          userNotes: 'hello',
          isReviewed: true,
          tags: [{ id: 'tag1', name: 'food', colorName: 'RED1' }],
        },
      },
    });

    const out = await editTransaction(client, {
      id: 't1',
      accountId: 'a1',
      itemId: 'i1',
      input: { categoryId: 'c2', userNotes: 'hello', isReviewed: true, tagIds: ['tag1'] },
    });

    expect(out.id).toBe('t1');
    expect(out.changed).toEqual({
      categoryId: 'c2',
      userNotes: 'hello',
      isReviewed: true,
      tagIds: ['tag1'],
    });
  });

  test('omits unchanged fields from compact response', async () => {
    const client = createMockClient({
      editTransaction: {
        transaction: { id: 't1', categoryId: 'c2', userNotes: null, isReviewed: false, tags: [] },
      },
    });

    const out = await editTransaction(client, {
      id: 't1',
      accountId: 'a1',
      itemId: 'i1',
      input: { categoryId: 'c2' },
    });

    expect(Object.keys(out.changed)).toEqual(['categoryId']);
  });
});
