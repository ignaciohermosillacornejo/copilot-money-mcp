import { describe, test, expect, mock } from 'bun:test';
import { setBudget } from '../../../src/core/graphql/budgets.js';
import {
  EDIT_BUDGET,
  EDIT_BUDGET_MONTHLY,
} from '../../../src/core/graphql/operations.generated.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';

function createMockClient(response: unknown): GraphQLClient {
  return {
    mutate: mock((_op: string, _q: string, _v: unknown) => Promise.resolve(response)),
  } as unknown as GraphQLClient;
}

describe('setBudget', () => {
  test('dispatches EditBudget when month absent, wire amount is number', async () => {
    const client = createMockClient({ editCategoryBudget: true });
    await setBudget(client, { categoryId: 'cat-1', amount: '250' });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('EditBudget');
    expect(call[1]).toBe(EDIT_BUDGET);
    expect(call[2]).toEqual({ categoryId: 'cat-1', input: { amount: 250 } });
    // Belt-and-suspenders: the amount over the wire must be a Float, not a string.
    expect(typeof (call[2] as { input: { amount: unknown } }).input.amount).toBe('number');
  });

  test('dispatches EditBudgetMonthly when month present, wire amount is number', async () => {
    const client = createMockClient({ editCategoryBudgetMonthly: true });
    await setBudget(client, { categoryId: 'cat-1', amount: '250', month: '2026-04' });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('EditBudgetMonthly');
    expect(call[1]).toBe(EDIT_BUDGET_MONTHLY);
    expect(call[2]).toEqual({
      categoryId: 'cat-1',
      input: [{ amount: 250, month: '2026-04' }],
    });
    expect(typeof (call[2] as { input: Array<{ amount: unknown }> }).input[0].amount).toBe(
      'number'
    );
  });

  test('parses decimal amount strings to Float', async () => {
    const client = createMockClient({ editCategoryBudget: true });
    await setBudget(client, { categoryId: 'cat-1', amount: '250.75' });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[2]).toEqual({ categoryId: 'cat-1', input: { amount: 250.75 } });
  });

  test('amount=0 is valid (clears the budget)', async () => {
    const client = createMockClient({ editCategoryBudget: true });
    await setBudget(client, { categoryId: 'cat-1', amount: '0' });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[2]).toEqual({ categoryId: 'cat-1', input: { amount: 0 } });
  });

  test('rejects non-numeric amount', async () => {
    const client = createMockClient({ editCategoryBudget: true });
    await expect(setBudget(client, { categoryId: 'cat-1', amount: 'abc' })).rejects.toThrow(
      /invalid amount/
    );
  });

  test('rejects negative amount', async () => {
    const client = createMockClient({ editCategoryBudget: true });
    await expect(setBudget(client, { categoryId: 'cat-1', amount: '-5' })).rejects.toThrow(
      /invalid amount/
    );
  });

  test('returns compact { categoryId, amount, month?, cleared }', async () => {
    const client = createMockClient({ editCategoryBudget: true });
    const out = await setBudget(client, { categoryId: 'cat-1', amount: '250' });
    expect(out).toEqual({ categoryId: 'cat-1', amount: '250', cleared: false });

    const client2 = createMockClient({ editCategoryBudget: true });
    const out2 = await setBudget(client2, { categoryId: 'cat-1', amount: '0' });
    expect(out2).toEqual({ categoryId: 'cat-1', amount: '0', cleared: true });
  });
});
