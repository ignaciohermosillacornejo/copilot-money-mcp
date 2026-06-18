/**
 * Unit tests for the update_transaction tool (GraphQL-based).
 *
 * Supported fields: name, category_id, note, tag_ids, type, and reviewed via
 * GraphQL's EditTransaction mutation. Legacy fields (excluded,
 * internal_transfer, goal_id) were removed from the schema when the backend
 * was migrated to GraphQL; they now hit the defense-in-depth "unknown field"
 * check in updateTransaction.
 *
 * Covers: per-field mapping, multi-field atomic dispatch, argument
 * validation, referential integrity checks, unknown-field rejection.
 */

import { describe, test, expect } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';

type EditTxnResponse = {
  editTransaction: {
    transaction: {
      id: string;
      name: string;
      categoryId: string;
      userNotes: string | null;
      isReviewed: boolean;
      type: string;
      tags: Array<{ id: string }>;
    };
  };
};

function makeEchoResponse(): (vars: any) => EditTxnResponse {
  return (vars: any) => ({
    editTransaction: {
      transaction: {
        id: vars.id,
        name: vars.input.name ?? 'Coffee Shop',
        // Mirror the verified server behavior: INCOME/INTERNAL_TRANSFER clears
        // the category; REGULAR keeps whatever category was sent.
        categoryId:
          vars.input.type === 'INCOME' || vars.input.type === 'INTERNAL_TRANSFER'
            ? ''
            : (vars.input.categoryId ?? 'food'),
        userNotes: vars.input.userNotes ?? null,
        isReviewed: vars.input.isReviewed ?? false,
        type: vars.input.type ?? 'REGULAR',
        tags: (vars.input.tagIds ?? []).map((id: string) => ({ id })),
      },
    },
  });
}

function makeTools(overrides?: {
  transactions?: unknown[];
  goals?: unknown[];
  categories?: unknown[];
  tags?: unknown[];
  responses?: Record<string, unknown>;
}) {
  const mockDb = new CopilotDatabase('/nonexistent');
  (mockDb as any).dbPath = '/fake';
  (mockDb as any)._transactions = overrides?.transactions ?? [
    {
      transaction_id: 'txn1',
      amount: 50,
      date: '2024-01-15',
      name: 'Coffee Shop',
      category_id: 'food',
      user_note: 'pre-existing note',
      item_id: 'item1',
      account_id: 'acct1',
      tag_ids: [],
    },
  ];
  (mockDb as any)._goals = overrides?.goals ?? [
    { goal_id: 'goal1', name: 'Vacation', target_amount: 1000 },
  ];
  (mockDb as any)._userCategories = overrides?.categories ?? [
    { category_id: 'food', name: 'Food' },
    { category_id: 'groceries', name: 'Groceries' },
  ];
  (mockDb as any)._tags = overrides?.tags ?? [
    { tag_id: 'tag1', name: 'Important' },
    { tag_id: 'tag2', name: 'Recurring' },
  ];
  (mockDb as any)._allCollectionsLoaded = true;
  (mockDb as any)._cacheLoadedAt = Date.now();

  const client = createMockGraphQLClient(
    overrides?.responses ?? { EditTransaction: makeEchoResponse() }
  );
  const tools = new CopilotMoneyTools(mockDb, client);

  return { tools, mockDb, client };
}

describe('updateTransaction — single-field mapping to EditTransaction', () => {
  test('name: dispatches with name input', async () => {
    const { tools, client } = makeTools();
    const result = await tools.updateTransaction({
      transaction_id: 'txn1',
      name: 'Renamed Transaction',
    });
    expect(result.success).toBe(true);
    expect(result.transaction_id).toBe('txn1');
    expect(result.updated).toEqual(['name']);

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].variables).toEqual({
      id: 'txn1',
      accountId: 'acct1',
      itemId: 'item1',
      input: { name: 'Renamed Transaction' },
    });
  });

  test('name: trims whitespace', async () => {
    const { tools, client } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', name: '  Padded Name  ' });
    expect(client._calls[0].variables).toMatchObject({
      input: { name: 'Padded Name' },
    });
  });

  test('name: empty string throws', async () => {
    const { tools, client } = makeTools();
    await expect(tools.updateTransaction({ transaction_id: 'txn1', name: '' })).rejects.toThrow(
      /name must not be empty/i
    );
    expect(client._calls).toHaveLength(0);
  });

  test('name: whitespace-only string throws', async () => {
    const { tools, client } = makeTools();
    await expect(tools.updateTransaction({ transaction_id: 'txn1', name: '   ' })).rejects.toThrow(
      /name must not be empty/i
    );
    expect(client._calls).toHaveLength(0);
  });

  test('category_id: dispatches with categoryId input', async () => {
    const { tools, client } = makeTools();
    const result = await tools.updateTransaction({
      transaction_id: 'txn1',
      category_id: 'groceries',
    });
    expect(result.success).toBe(true);
    expect(result.transaction_id).toBe('txn1');
    expect(result.updated).toEqual(['category_id']);

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('EditTransaction');
    expect(client._calls[0].variables).toEqual({
      id: 'txn1',
      accountId: 'acct1',
      itemId: 'item1',
      input: { categoryId: 'groceries' },
    });
  });

  test('note: non-empty string dispatches with userNotes input, response maps back to "note"', async () => {
    const { tools, client } = makeTools();
    const result = await tools.updateTransaction({ transaction_id: 'txn1', note: 'hello' });
    expect(result.success).toBe(true);
    expect(result.updated).toEqual(['note']);

    expect(client._calls[0].variables).toMatchObject({
      input: { userNotes: 'hello' },
    });
  });

  test('note: empty string clears userNotes', async () => {
    const { tools, client } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', note: '' });
    expect(client._calls[0].variables).toMatchObject({
      input: { userNotes: '' },
    });
  });

  test('tag_ids: non-empty array dispatches as tagIds', async () => {
    const { tools, client } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', tag_ids: ['tag1', 'tag2'] });
    expect(client._calls[0].variables).toMatchObject({
      input: { tagIds: ['tag1', 'tag2'] },
    });
  });

  test('tag_ids: empty array clears tags', async () => {
    const { tools, client } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', tag_ids: [] });
    expect(client._calls[0].variables).toMatchObject({
      input: { tagIds: [] },
    });
  });
});

describe('updateTransaction — multi-field atomic dispatch', () => {
  test('three fields in one patch produce one EditTransaction call with merged input', async () => {
    const { tools, client } = makeTools();
    const result = await tools.updateTransaction({
      transaction_id: 'txn1',
      category_id: 'groceries',
      note: 'weekly shopping',
      tag_ids: ['tag1'],
    });
    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].variables).toEqual({
      id: 'txn1',
      accountId: 'acct1',
      itemId: 'item1',
      input: {
        categoryId: 'groceries',
        userNotes: 'weekly shopping',
        tagIds: ['tag1'],
      },
    });
    expect(result.updated.sort()).toEqual(['category_id', 'note', 'tag_ids']);
  });
});

describe('updateTransaction — legacy-field rejection', () => {
  test.each(['excluded', 'internal_transfer', 'goal_id'])(
    'rejects legacy (non-GraphQL) field: %s',
    async (field) => {
      const { tools, client } = makeTools();
      const args: Record<string, unknown> = { transaction_id: 'txn1' };
      if (field === 'excluded') args.excluded = true;
      if (field === 'internal_transfer') args.internal_transfer = true;
      if (field === 'goal_id') args.goal_id = 'goal1';
      await expect(tools.updateTransaction(args as any)).rejects.toThrow(/unknown field/i);
      expect(client._calls).toHaveLength(0);
    }
  );
});

describe('updateTransaction — validation errors', () => {
  test('empty patch (only transaction_id) throws', async () => {
    const { tools, client } = makeTools();
    await expect(tools.updateTransaction({ transaction_id: 'txn1' })).rejects.toThrow(
      /at least one field/i
    );
    expect(client._calls).toHaveLength(0);
  });

  test('unknown field throws and no write is issued', async () => {
    const { tools, client } = makeTools();
    await expect(
      tools.updateTransaction({ transaction_id: 'txn1', bogus_field: 'x' } as any)
    ).rejects.toThrow(/unknown field/i);
    expect(client._calls).toHaveLength(0);
  });

  test('non-existent category_id throws', async () => {
    const { tools, client } = makeTools();
    await expect(
      tools.updateTransaction({ transaction_id: 'txn1', category_id: 'ghost_category' })
    ).rejects.toThrow(/Category not found/i);
    expect(client._calls).toHaveLength(0);
  });

  test('non-existent tag_id throws', async () => {
    const { tools, client } = makeTools();
    await expect(
      tools.updateTransaction({ transaction_id: 'txn1', tag_ids: ['tag1', 'ghost_tag'] })
    ).rejects.toThrow(/Tag not found.*ghost_tag/i);
    expect(client._calls).toHaveLength(0);
  });

  test('malformed tag_id throws', async () => {
    const { tools, client } = makeTools();
    await expect(
      tools.updateTransaction({ transaction_id: 'txn1', tag_ids: ['valid_tag', 'bad/tag'] })
    ).rejects.toThrow();
    expect(client._calls).toHaveLength(0);
  });

  test('non-existent transaction_id throws', async () => {
    const { tools, client } = makeTools();
    await expect(
      tools.updateTransaction({ transaction_id: 'missing', category_id: 'food' })
    ).rejects.toThrow(/Transaction not found/i);
    expect(client._calls).toHaveLength(0);
  });

  test('transaction present locally but missing item_id/account_id is unresolved (no live fallback) and throws', async () => {
    // The local row lacks account_id/item_id, so it can't supply the mutation
    // metadata. With no live DB to fall back to, resolution finds nothing and
    // the write is rejected before any GraphQL call.
    const { tools, client } = makeTools({
      transactions: [
        {
          transaction_id: 'txn1',
          amount: 50,
          date: '2024-01-15',
          name: 'Orphan',
          category_id: 'food',
          // no item_id / account_id
        },
      ],
    });
    await expect(
      tools.updateTransaction({ transaction_id: 'txn1', category_id: 'food' })
    ).rejects.toThrow(/Transaction not found/i);
    expect(client._calls).toHaveLength(0);
  });
});

describe('updateTransaction — atomicity on validation failure', () => {
  test('valid category_id + invalid tag_id: no GraphQL write', async () => {
    const { tools, client } = makeTools();
    await expect(
      tools.updateTransaction({
        transaction_id: 'txn1',
        category_id: 'groceries',
        tag_ids: ['tag1', 'ghost_tag'],
      })
    ).rejects.toThrow(/Tag not found/i);
    expect(client._calls).toHaveLength(0);
  });

  test('valid note + invalid category_id: no GraphQL write', async () => {
    const { tools, client } = makeTools();
    await expect(
      tools.updateTransaction({
        transaction_id: 'txn1',
        note: 'this should not persist',
        category_id: 'ghost_category',
      })
    ).rejects.toThrow(/Category not found/i);
    expect(client._calls).toHaveLength(0);
  });
});

describe('updateTransaction — type (#415)', () => {
  test('type: dispatches with type input, response maps back to "type"', async () => {
    const { tools, client } = makeTools();
    const result = await tools.updateTransaction({ transaction_id: 'txn1', type: 'INCOME' });
    expect(client._calls).toHaveLength(1);
    const call = client._calls[0] as any;
    expect(call.op).toBe('EditTransaction');
    expect(call.variables.input.type).toBe('INCOME');
    expect(result.updated).toContain('type');
  });

  test('type: REGULAR together with category_id is allowed (both dispatched)', async () => {
    const { tools, client } = makeTools();
    await tools.updateTransaction({
      transaction_id: 'txn1',
      type: 'REGULAR',
      category_id: 'groceries',
    });
    expect(client._calls).toHaveLength(1);
    const input = (client._calls[0] as any).variables.input;
    expect(input.type).toBe('REGULAR');
    expect(input.categoryId).toBe('groceries');
  });

  test('type: invalid value throws, no write', async () => {
    const { tools, client } = makeTools();
    await expect(
      tools.updateTransaction({ transaction_id: 'txn1', type: 'SPENDING' as any })
    ).rejects.toThrow(/REGULAR.*INCOME.*INTERNAL_TRANSFER/);
    expect(client._calls).toHaveLength(0);
  });

  test('type INCOME + category_id together throws (server clears category), no write', async () => {
    const { tools, client } = makeTools();
    await expect(
      tools.updateTransaction({ transaction_id: 'txn1', type: 'INCOME', category_id: 'groceries' })
    ).rejects.toThrow(/clears the category|cannot be combined/i);
    expect(client._calls).toHaveLength(0);
  });

  test('type INTERNAL_TRANSFER + category_id together throws, no write', async () => {
    const { tools, client } = makeTools();
    await expect(
      tools.updateTransaction({
        transaction_id: 'txn1',
        type: 'INTERNAL_TRANSFER',
        category_id: 'groceries',
      })
    ).rejects.toThrow(/clears the category|cannot be combined/i);
    expect(client._calls).toHaveLength(0);
  });

  test('type INCOME alone: optimistic cache reflects the server-side category clear', async () => {
    const { tools, mockDb } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', type: 'INCOME' });
    const cached = (await mockDb.getTransactions()).find((t) => t.transaction_id === 'txn1');
    expect(cached?.category_id).toBe('');
  });
});

describe('updateTransaction — reviewed (#416)', () => {
  test('reviewed=true: dispatches with isReviewed input, response maps back to "reviewed"', async () => {
    const { tools, client } = makeTools();
    const result = await tools.updateTransaction({ transaction_id: 'txn1', reviewed: true });
    expect(client._calls).toHaveLength(1);
    const call = client._calls[0] as any;
    expect(call.op).toBe('EditTransaction');
    expect(call.variables.input.isReviewed).toBe(true);
    expect(result.updated).toEqual(['reviewed']);
  });

  test('reviewed=false: dispatches with isReviewed=false (un-review a single transaction)', async () => {
    const { tools, client } = makeTools();
    const result = await tools.updateTransaction({ transaction_id: 'txn1', reviewed: false });
    expect(client._calls).toHaveLength(1);
    expect((client._calls[0] as any).variables.input.isReviewed).toBe(false);
    expect(result.updated).toEqual(['reviewed']);
  });

  test('reviewed: optimistic cache patches user_reviewed', async () => {
    const { tools, mockDb } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', reviewed: true });
    const cached = (await mockDb.getTransactions()).find((t) => t.transaction_id === 'txn1');
    expect(cached?.user_reviewed).toBe(true);
  });

  test('reviewed combined with category_id: one merged EditTransaction call', async () => {
    const { tools, client } = makeTools();
    const result = await tools.updateTransaction({
      transaction_id: 'txn1',
      reviewed: true,
      category_id: 'groceries',
    });
    expect(client._calls).toHaveLength(1);
    const input = (client._calls[0] as any).variables.input;
    expect(input.isReviewed).toBe(true);
    expect(input.categoryId).toBe('groceries');
    expect(result.updated.sort()).toEqual(['category_id', 'reviewed']);
  });

  test('reviewed: non-boolean value throws, no write', async () => {
    const { tools, client } = makeTools();
    await expect(
      tools.updateTransaction({ transaction_id: 'txn1', reviewed: 'yes' as any })
    ).rejects.toThrow(/reviewed must be a boolean/i);
    expect(client._calls).toHaveLength(0);
  });

  test('reviewed combined with type: both merge into one call, neither blocks the other', async () => {
    const { tools, client } = makeTools();
    const result = await tools.updateTransaction({
      transaction_id: 'txn1',
      type: 'INCOME',
      reviewed: true,
    });
    expect(client._calls).toHaveLength(1);
    const input = (client._calls[0] as any).variables.input;
    expect(input.type).toBe('INCOME');
    expect(input.isReviewed).toBe(true);
    expect(result.updated.sort()).toEqual(['reviewed', 'type']);
  });
});
