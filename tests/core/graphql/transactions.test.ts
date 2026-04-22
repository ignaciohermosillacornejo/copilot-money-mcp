import { describe, test, expect, mock } from 'bun:test';
import { editTransaction, createTransaction } from '../../../src/core/graphql/transactions.js';
import {
  EDIT_TRANSACTION,
  CREATE_TRANSACTION,
} from '../../../src/core/graphql/operations.generated.js';
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

describe('createTransaction', () => {
  test('calls mutate with CreateTransaction op name, generated query, and expected variables', async () => {
    const client = createMockClient({
      createTransaction: {
        id: 'new-tx-1',
        name: 'Coffee',
        date: '2026-04-21',
        amount: 5.25,
        categoryId: 'cat1',
        type: 'REGULAR',
        accountId: 'acc1',
        itemId: 'item1',
        isPending: false,
        isReviewed: false,
        createdAt: 1777785600000,
        recurringId: null,
        userNotes: null,
        tipAmount: null,
        suggestedCategoryIds: [],
        tags: [],
        goal: null,
      },
    });

    await createTransaction(client, {
      accountId: 'acc1',
      itemId: 'item1',
      input: {
        name: 'Coffee',
        date: '2026-04-21',
        amount: 5.25,
        categoryId: 'cat1',
        type: 'REGULAR',
      },
    });

    const calls = (client.mutate as ReturnType<typeof mock>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('CreateTransaction');
    expect(calls[0][1]).toBe(CREATE_TRANSACTION);
    expect(calls[0][2]).toEqual({
      accountId: 'acc1',
      itemId: 'item1',
      input: {
        name: 'Coffee',
        date: '2026-04-21',
        amount: 5.25,
        categoryId: 'cat1',
        type: 'REGULAR',
      },
    });
  });

  test('returns the newly-created transaction fields from response', async () => {
    const created = {
      id: 'new-tx-2',
      name: 'Paycheck',
      date: '2026-04-21',
      amount: -2500,
      categoryId: 'cat-income',
      type: 'INCOME' as const,
      accountId: 'acc1',
      itemId: 'item1',
      isPending: false,
      isReviewed: false,
      createdAt: 1777785600000,
      recurringId: null,
      userNotes: null,
      tipAmount: null,
      suggestedCategoryIds: [],
      tags: [],
      goal: null,
    };
    const client = createMockClient({ createTransaction: created });

    const out = await createTransaction(client, {
      accountId: 'acc1',
      itemId: 'item1',
      input: {
        name: 'Paycheck',
        date: '2026-04-21',
        amount: -2500,
        categoryId: 'cat-income',
        type: 'INCOME',
      },
    });

    expect(out.id).toBe('new-tx-2');
    expect(out.transaction).toEqual(created);
  });

  test('propagates errors from the client', async () => {
    const client = {
      mutate: mock(() => Promise.reject(new Error('boom'))),
    } as unknown as GraphQLClient;

    await expect(
      createTransaction(client, {
        accountId: 'acc1',
        itemId: 'item1',
        input: {
          name: 'x',
          date: '2026-04-21',
          amount: 1,
          categoryId: 'cat1',
          type: 'REGULAR',
        },
      })
    ).rejects.toThrow('boom');
  });
});
