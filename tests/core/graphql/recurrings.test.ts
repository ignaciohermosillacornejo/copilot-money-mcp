import { describe, test, expect, mock } from 'bun:test';
import {
  createRecurring,
  editRecurring,
  deleteRecurring,
} from '../../../src/core/graphql/recurrings.js';
import {
  CREATE_RECURRING,
  EDIT_RECURRING,
  DELETE_RECURRING,
} from '../../../src/core/graphql/operations.generated.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';

function createMockClient(response: unknown): GraphQLClient {
  return {
    mutate: mock((_op: string, _q: string, _v: unknown) => Promise.resolve(response)),
  } as unknown as GraphQLClient;
}

describe('createRecurring', () => {
  test('sends CreateRecurring with input containing frequency + transaction', async () => {
    const client = createMockClient({
      createRecurring: { id: 'r1', name: 'Netflix', state: 'ACTIVE', frequency: 'MONTHLY' },
    });
    await createRecurring(client, {
      input: {
        frequency: 'MONTHLY',
        transaction: { accountId: 'a1', itemId: 'i1', transactionId: 't1' },
      },
    });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('CreateRecurring');
    expect(call[1]).toBe(CREATE_RECURRING);
    expect(call[2]).toEqual({
      input: {
        frequency: 'MONTHLY',
        transaction: { accountId: 'a1', itemId: 'i1', transactionId: 't1' },
      },
    });
  });

  test('returns compact { id, name, state, frequency }', async () => {
    const client = createMockClient({
      createRecurring: { id: 'r1', name: 'Netflix', state: 'ACTIVE', frequency: 'MONTHLY' },
    });
    const out = await createRecurring(client, {
      input: {
        frequency: 'MONTHLY',
        transaction: { accountId: 'a1', itemId: 'i1', transactionId: 't1' },
      },
    });
    expect(out).toEqual({ id: 'r1', name: 'Netflix', state: 'ACTIVE', frequency: 'MONTHLY' });
  });
});

describe('editRecurring', () => {
  test('sends EditRecurring with id + input (state change)', async () => {
    // Captured wire shape: { editRecurring: { recurring: { id, state, ... } } }
    const client = createMockClient({
      editRecurring: { recurring: { id: 'r1', state: 'PAUSED' } },
    });
    await editRecurring(client, { id: 'r1', input: { state: 'PAUSED' } });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('EditRecurring');
    expect(call[1]).toBe(EDIT_RECURRING);
    expect(call[2]).toEqual({ id: 'r1', input: { state: 'PAUSED' } });
  });

  test('converts rule.minAmount/maxAmount string to Float on the wire', async () => {
    // Server response shape: editRecurring.recurring no longer selects `rule`
    // (see issue #288 — RecurringRule.nameContains is non-nullable in the
    // schema but the server returns null for amount-only rules, which made
    // every EditRecurring throw). The mock omits rule deliberately.
    const client = createMockClient({
      editRecurring: {
        recurring: { id: 'r1', state: 'ACTIVE' },
      },
    });
    await editRecurring(client, {
      id: 'r1',
      input: { rule: { minAmount: '5.00', maxAmount: '100' } },
    });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    // Wire variables use Float, not String.
    expect(call[2]).toEqual({
      id: 'r1',
      input: {
        rule: {
          minAmount: 5,
          maxAmount: 100,
        },
      },
    });
    expect(typeof call[2].input.rule.minAmount).toBe('number');
    expect(typeof call[2].input.rule.maxAmount).toBe('number');
  });

  test('changed.rule echoes the caller input as strings (not the wire Float values)', async () => {
    const client = createMockClient({
      editRecurring: { recurring: { id: 'r1', state: 'ACTIVE' } },
    });
    const out = await editRecurring(client, {
      id: 'r1',
      input: { rule: { nameContains: 'netflix', minAmount: '5.00', maxAmount: '100', days: [1] } },
    });
    expect(out).toEqual({
      id: 'r1',
      changed: {
        rule: { nameContains: 'netflix', minAmount: '5.00', maxAmount: '100', days: [1] },
      },
    });
  });

  test('regression: server omits rule entirely → editRecurring still resolves', async () => {
    // Pre-#288, editRecurring read rule.nameContains off the response. When
    // the server returned null nameContains for amount-only rules the call
    // threw. The fix stops reading the field; this test pins that behavior
    // by giving the mock response no rule at all.
    const client = createMockClient({
      editRecurring: { recurring: { id: 'r1', state: 'PAUSED' } },
    });
    const out = await editRecurring(client, {
      id: 'r1',
      input: { state: 'PAUSED', rule: { minAmount: '10' } },
    });
    expect(out.id).toBe('r1');
    expect(out.changed.state).toBe('PAUSED');
    expect(out.changed.rule).toEqual({ minAmount: '10' });
  });

  test('throws for invalid amount string', async () => {
    const client = createMockClient({});
    await expect(
      editRecurring(client, {
        id: 'r1',
        input: { rule: { minAmount: '10abc' } },
      })
    ).rejects.toThrow(/invalid rule\.minAmount/);
  });
});

describe('deleteRecurring', () => {
  test('sends DeleteRecurring with deleteRecurringId variable name', async () => {
    const client = createMockClient({ deleteRecurring: true });
    const out = await deleteRecurring(client, { id: 'r1' });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('DeleteRecurring');
    expect(call[1]).toBe(DELETE_RECURRING);
    expect(call[2]).toEqual({ deleteRecurringId: 'r1' });
    expect(out).toEqual({ id: 'r1', deleted: true });
  });
});
