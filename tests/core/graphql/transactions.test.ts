import { describe, test, expect, mock } from 'bun:test';
import {
  editTransaction,
  createTransaction,
  deleteTransaction,
  addTransactionToRecurring,
  splitTransaction,
} from '../../../src/core/graphql/transactions.js';
import {
  EDIT_TRANSACTION,
  CREATE_TRANSACTION,
  DELETE_TRANSACTION,
  ADD_TRANSACTION_TO_RECURRING,
  SPLIT_TRANSACTION,
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

    expect(out).toEqual(created);
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

describe('deleteTransaction', () => {
  test('calls mutate with DeleteTransaction op name, generated query, and expected variables', async () => {
    const client = createMockClient({ deleteTransaction: true });

    await deleteTransaction(client, {
      id: 'tx1',
      accountId: 'acc1',
      itemId: 'item1',
    });

    const calls = (client.mutate as ReturnType<typeof mock>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('DeleteTransaction');
    expect(calls[0][1]).toBe(DELETE_TRANSACTION);
    expect(calls[0][2]).toEqual({ id: 'tx1', accountId: 'acc1', itemId: 'item1' });
  });

  test('returns the boolean response unchanged (true)', async () => {
    const client = createMockClient({ deleteTransaction: true });
    const out = await deleteTransaction(client, {
      id: 'tx1',
      accountId: 'acc1',
      itemId: 'item1',
    });
    expect(out).toBe(true);
  });

  test('returns the boolean response unchanged (false)', async () => {
    // Defensive: the server return type is Boolean!, so a `false` would be
    // unusual but the wrapper must not coerce to true. Surfaces any future
    // server-side change where delete can "not-fail-but-not-delete".
    const client = createMockClient({ deleteTransaction: false });
    const out = await deleteTransaction(client, {
      id: 'tx1',
      accountId: 'acc1',
      itemId: 'item1',
    });
    expect(out).toBe(false);
  });

  test('propagates errors from the client', async () => {
    const client = {
      mutate: mock(() => Promise.reject(new Error('Transaction not found'))),
    } as unknown as GraphQLClient;

    await expect(
      deleteTransaction(client, { id: 'tx1', accountId: 'acc1', itemId: 'item1' })
    ).rejects.toThrow('Transaction not found');
  });
});

describe('addTransactionToRecurring', () => {
  // Canned server response — the output is `{ transaction: Transaction }`
  // and the Transaction shape matches TransactionFields (same as
  // createTransaction's output).
  const linkedTx = {
    id: 'tx1',
    name: 'Rent',
    date: '2026-04-01',
    amount: 2500,
    categoryId: 'cat-rent',
    type: 'REGULAR' as const,
    accountId: 'acc1',
    itemId: 'item1',
    isPending: false,
    isReviewed: false,
    createdAt: 1777785600000,
    recurringId: 'rec1',
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    tags: [],
    goal: null,
  };

  test('calls mutate with AddTransactionToRecurring op name, generated query, and expected variables', async () => {
    const client = createMockClient({
      addTransactionToRecurring: { transaction: linkedTx },
    });

    await addTransactionToRecurring(client, {
      id: 'tx1',
      accountId: 'acc1',
      itemId: 'item1',
      input: { recurringId: 'rec1' },
    });

    const calls = (client.mutate as ReturnType<typeof mock>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('AddTransactionToRecurring');
    expect(calls[0][1]).toBe(ADD_TRANSACTION_TO_RECURRING);
    expect(calls[0][2]).toEqual({
      id: 'tx1',
      accountId: 'acc1',
      itemId: 'item1',
      input: { recurringId: 'rec1' },
    });
  });

  test('returns the linked transaction fields from the nested response', async () => {
    const client = createMockClient({
      addTransactionToRecurring: { transaction: linkedTx },
    });

    const out = await addTransactionToRecurring(client, {
      id: 'tx1',
      accountId: 'acc1',
      itemId: 'item1',
      input: { recurringId: 'rec1' },
    });

    // Wrapper unwraps the `transaction` level so callers get the same
    // CreatedTransaction shape they get from createTransaction().
    expect(out).toEqual(linkedTx);
  });

  test('propagates errors from the client', async () => {
    const client = {
      mutate: mock(() => Promise.reject(new Error('Transaction not found'))),
    } as unknown as GraphQLClient;

    await expect(
      addTransactionToRecurring(client, {
        id: 'tx1',
        accountId: 'acc1',
        itemId: 'item1',
        input: { recurringId: 'rec1' },
      })
    ).rejects.toThrow('Transaction not found');
  });
});

describe('splitTransaction', () => {
  // Canned server response — the output type is SplitTransactionOutput
  // with exactly two fields: parentTransaction and splitTransactions.
  // Both follow the TransactionFields shape (same as CreatedTransaction).
  const parentTx = {
    id: 'parent-1',
    name: 'Hotel + Car + Meals',
    date: '2026-04-15',
    amount: 600,
    categoryId: '', // post-split: Copilot blanks this out on the parent
    type: 'REGULAR' as const,
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
  const childA = {
    ...parentTx,
    id: 'child-a',
    name: 'Hotel',
    amount: 400,
    categoryId: 'cat-lodging',
  };
  const childB = {
    ...parentTx,
    id: 'child-b',
    name: 'Car',
    amount: 200,
    categoryId: 'cat-car-rental',
  };

  test('calls mutate with SplitTransaction op name, generated query, and expected variables', async () => {
    const client = createMockClient({
      splitTransaction: {
        parentTransaction: parentTx,
        splitTransactions: [childA, childB],
      },
    });

    await splitTransaction(client, {
      id: 'parent-1',
      accountId: 'acc1',
      itemId: 'item1',
      input: [
        { name: 'Hotel', date: '2026-04-15', amount: 400, categoryId: 'cat-lodging' },
        { name: 'Car', date: '2026-04-15', amount: 200, categoryId: 'cat-car-rental' },
      ],
    });

    const calls = (client.mutate as ReturnType<typeof mock>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('SplitTransaction');
    expect(calls[0][1]).toBe(SPLIT_TRANSACTION);
    expect(calls[0][2]).toEqual({
      id: 'parent-1',
      accountId: 'acc1',
      itemId: 'item1',
      input: [
        { name: 'Hotel', date: '2026-04-15', amount: 400, categoryId: 'cat-lodging' },
        { name: 'Car', date: '2026-04-15', amount: 200, categoryId: 'cat-car-rental' },
      ],
    });
  });

  test('returns unwrapped { parentTransaction, splitTransactions } from the server response', async () => {
    const client = createMockClient({
      splitTransaction: {
        parentTransaction: parentTx,
        splitTransactions: [childA, childB],
      },
    });

    const out = await splitTransaction(client, {
      id: 'parent-1',
      accountId: 'acc1',
      itemId: 'item1',
      input: [
        { name: 'Hotel', date: '2026-04-15', amount: 400, categoryId: 'cat-lodging' },
        { name: 'Car', date: '2026-04-15', amount: 200, categoryId: 'cat-car-rental' },
      ],
    });

    expect(out.parentTransaction).toEqual(parentTx);
    expect(out.splitTransactions).toEqual([childA, childB]);
  });

  test('propagates errors from the client', async () => {
    const client = {
      mutate: mock(() => Promise.reject(new Error('Transaction not found'))),
    } as unknown as GraphQLClient;

    await expect(
      splitTransaction(client, {
        id: 'parent-1',
        accountId: 'acc1',
        itemId: 'item1',
        input: [
          { name: 'Hotel', date: '2026-04-15', amount: 400, categoryId: 'cat-lodging' },
          { name: 'Car', date: '2026-04-15', amount: 200, categoryId: 'cat-car-rental' },
        ],
      })
    ).rejects.toThrow('Transaction not found');
  });
});
