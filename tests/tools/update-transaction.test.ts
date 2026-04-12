/**
 * Unit tests for the update_transaction tool.
 *
 * Covers single-field updates, multi-field atomicity, omitted-key
 * preservation, per-field validation, atomicity on validation failure,
 * and in-memory cache patching across all 7 mutable fields:
 * category_id, note, tag_ids, excluded, name, internal_transfer, goal_id.
 */

import { describe, test, expect } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';

interface UpdateCall {
  collection: string;
  docId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fields: any;
  mask: string[];
}

function makeMockFirestoreClient(updateCalls: UpdateCall[]) {
  return {
    requireUserId: async () => 'user123',
    getUserId: () => 'user123',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateDocument: async (collection: string, docId: string, fields: any, mask: string[]) => {
      updateCalls.push({ collection, docId, fields, mask });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createDocument: async () => {},
    deleteDocument: async () => {},
  };
}

function makeTools(overrides?: {
  transactions?: unknown[];
  goals?: unknown[];
  categories?: unknown[];
}) {
  const mockDb = new CopilotDatabase('/nonexistent');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockDb as any).dbPath = '/fake';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockDb as any)._transactions = overrides?.transactions ?? [
    {
      transaction_id: 'txn1',
      amount: 50,
      date: '2024-01-15',
      name: 'Coffee Shop',
      category_id: 'food',
      user_note: 'pre-existing note',
      user_id: 'user123',
      item_id: 'item1',
      account_id: 'acct1',
      tag_ids: [],
    },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockDb as any)._goals = overrides?.goals ?? [
    { goal_id: 'goal1', name: 'Vacation', target_amount: 1000 },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockDb as any)._userCategories = overrides?.categories ?? [
    { category_id: 'food', name: 'Food' },
    { category_id: 'groceries', name: 'Groceries' },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockDb as any)._allCollectionsLoaded = true;

  const updateCalls: UpdateCall[] = [];
  const mockClient = makeMockFirestoreClient(updateCalls);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = new CopilotMoneyTools(mockDb, mockClient as any);

  return { tools, mockDb, updateCalls };
}

describe('updateTransaction — single-field updates', () => {
  test('category_id: sets category and writes correct mask', async () => {
    const { tools, updateCalls } = makeTools();
    const result = await tools.updateTransaction({
      transaction_id: 'txn1',
      category_id: 'groceries',
    });
    expect(result.success).toBe(true);
    expect(result.transaction_id).toBe('txn1');
    expect(result.updated).toEqual(['category_id']);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].collection).toBe('items/item1/accounts/acct1/transactions');
    expect(updateCalls[0].docId).toBe('txn1');
    expect(updateCalls[0].mask).toEqual(['category_id']);
    expect(updateCalls[0].fields).toEqual({ category_id: { stringValue: 'groceries' } });
  });

  test('note: non-empty string sets user_note, updated returns API name "note"', async () => {
    const { tools, updateCalls } = makeTools();
    const result = await tools.updateTransaction({ transaction_id: 'txn1', note: 'hello' });
    expect(result.success).toBe(true);
    expect(result.transaction_id).toBe('txn1');
    // `updated` returns API-facing names (the caller sent `note`, not `user_note`)
    expect(result.updated).toEqual(['note']);
    // Wire-level mask uses the Firestore field name
    expect(updateCalls[0].mask).toEqual(['user_note']);
    expect(updateCalls[0].fields).toEqual({ user_note: { stringValue: 'hello' } });
  });

  test('note: empty string clears the user_note field', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', note: '' });
    expect(updateCalls[0].mask).toEqual(['user_note']);
    expect(updateCalls[0].fields).toEqual({ user_note: { stringValue: '' } });
  });

  test('tag_ids: non-empty array sets tags', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', tag_ids: ['tag1', 'tag2'] });
    expect(updateCalls[0].mask).toEqual(['tag_ids']);
    expect(updateCalls[0].fields).toEqual({
      tag_ids: {
        arrayValue: {
          values: [{ stringValue: 'tag1' }, { stringValue: 'tag2' }],
        },
      },
    });
  });

  test('tag_ids: empty array clears all tags', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', tag_ids: [] });
    expect(updateCalls[0].mask).toEqual(['tag_ids']);
    expect(updateCalls[0].fields).toEqual({ tag_ids: { arrayValue: { values: [] } } });
  });

  test('excluded: true marks excluded', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', excluded: true });
    expect(updateCalls[0].mask).toEqual(['excluded']);
    expect(updateCalls[0].fields).toEqual({ excluded: { booleanValue: true } });
  });

  test('excluded: false un-excludes', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', excluded: false });
    expect(updateCalls[0].fields).toEqual({ excluded: { booleanValue: false } });
  });

  test('name: trims whitespace before writing', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', name: '  Renamed  ' });
    expect(updateCalls[0].mask).toEqual(['name']);
    expect(updateCalls[0].fields).toEqual({ name: { stringValue: 'Renamed' } });
  });

  test('internal_transfer: true marks transfer', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', internal_transfer: true });
    expect(updateCalls[0].mask).toEqual(['internal_transfer']);
    expect(updateCalls[0].fields).toEqual({ internal_transfer: { booleanValue: true } });
  });

  test('internal_transfer: false unmarks transfer', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', internal_transfer: false });
    expect(updateCalls[0].mask).toEqual(['internal_transfer']);
    expect(updateCalls[0].fields).toEqual({ internal_transfer: { booleanValue: false } });
  });

  test('goal_id: links to an existing goal', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', goal_id: 'goal1' });
    expect(updateCalls[0].mask).toEqual(['goal_id']);
    expect(updateCalls[0].fields).toEqual({ goal_id: { stringValue: 'goal1' } });
  });

  test('goal_id: null unlinks (Firestore empty string, cache undefined)', async () => {
    const { tools, mockDb, updateCalls } = makeTools({
      transactions: [
        {
          transaction_id: 'txn1',
          amount: 50,
          date: '2024-01-15',
          name: 'Coffee Shop',
          category_id: 'food',
          user_id: 'user123',
          item_id: 'item1',
          account_id: 'acct1',
          goal_id: 'goal1',
        },
      ],
    });
    await tools.updateTransaction({ transaction_id: 'txn1', goal_id: null });
    // Firestore wire: empty string
    expect(updateCalls[0].mask).toEqual(['goal_id']);
    expect(updateCalls[0].fields).toEqual({ goal_id: { stringValue: '' } });
    // Cache: undefined (goal_id key removed from the in-memory transaction)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedTxn = (mockDb as any)._transactions.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t: any) => t.transaction_id === 'txn1'
    );
    expect(cachedTxn.goal_id).toBeUndefined();
  });
});

describe('updateTransaction — multi-field atomic', () => {
  test('three fields in one patch produce one updateDocument call with merged mask', async () => {
    const { tools, updateCalls } = makeTools();
    const result = await tools.updateTransaction({
      transaction_id: 'txn1',
      category_id: 'groceries',
      note: 'weekly shopping',
      tag_ids: ['tag1'],
    });
    expect(updateCalls).toHaveLength(1);
    // Wire-level mask uses Firestore field names
    expect(updateCalls[0].mask.sort()).toEqual(['category_id', 'tag_ids', 'user_note']);
    expect(updateCalls[0].fields).toEqual({
      category_id: { stringValue: 'groceries' },
      user_note: { stringValue: 'weekly shopping' },
      tag_ids: { arrayValue: { values: [{ stringValue: 'tag1' }] } },
    });
    // Response `updated` uses API-facing names (caller sent `note`, not `user_note`)
    expect(result.updated.sort()).toEqual(['category_id', 'note', 'tag_ids']);
  });

  test('multi-field with goal_id unlink: Firestore empty string, cache undefined', async () => {
    const { tools, mockDb, updateCalls } = makeTools({
      transactions: [
        {
          transaction_id: 'txn1',
          amount: 50,
          date: '2024-01-15',
          name: 'Coffee Shop',
          category_id: 'food',
          user_id: 'user123',
          item_id: 'item1',
          account_id: 'acct1',
          goal_id: 'goal1',
        },
      ],
    });
    await tools.updateTransaction({
      transaction_id: 'txn1',
      category_id: 'groceries',
      goal_id: null,
    });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].mask.sort()).toEqual(['category_id', 'goal_id']);
    expect(updateCalls[0].fields).toEqual({
      category_id: { stringValue: 'groceries' },
      goal_id: { stringValue: '' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedTxn = (mockDb as any)._transactions.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t: any) => t.transaction_id === 'txn1'
    );
    expect(cachedTxn.category_id).toBe('groceries');
    expect(cachedTxn.goal_id).toBeUndefined();
  });
});

describe('updateTransaction — omitted-key preservation', () => {
  test('sending only tag_ids does NOT touch user_note', async () => {
    const { tools, mockDb, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', tag_ids: ['tag1'] });
    expect(updateCalls[0].mask).not.toContain('user_note');
    // Cache preserves pre-existing note
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedTxn = (mockDb as any)._transactions.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t: any) => t.transaction_id === 'txn1'
    );
    expect(cachedTxn.user_note).toBe('pre-existing note');
  });
});

describe('updateTransaction — validation errors', () => {
  test('empty patch (only transaction_id) throws', async () => {
    const { tools, updateCalls } = makeTools();
    await expect(tools.updateTransaction({ transaction_id: 'txn1' })).rejects.toThrow(
      /at least one field/i
    );
    expect(updateCalls).toHaveLength(0);
  });

  test('unknown field throws and no write is issued', async () => {
    const { tools, updateCalls } = makeTools();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools.updateTransaction({ transaction_id: 'txn1', bogus_field: 'x' } as any)
    ).rejects.toThrow(/unknown field/i);
    expect(updateCalls).toHaveLength(0);
  });

  test('whitespace-only name throws', async () => {
    const { tools, updateCalls } = makeTools();
    await expect(tools.updateTransaction({ transaction_id: 'txn1', name: '   ' })).rejects.toThrow(
      /name must not be empty/i
    );
    expect(updateCalls).toHaveLength(0);
  });

  test('non-existent category_id throws', async () => {
    const { tools, updateCalls } = makeTools();
    await expect(
      tools.updateTransaction({ transaction_id: 'txn1', category_id: 'ghost_category' })
    ).rejects.toThrow(/Category not found/i);
    expect(updateCalls).toHaveLength(0);
  });

  test('malformed tag_id throws', async () => {
    const { tools, updateCalls } = makeTools();
    await expect(
      tools.updateTransaction({ transaction_id: 'txn1', tag_ids: ['valid_tag', 'bad/tag'] })
    ).rejects.toThrow();
    expect(updateCalls).toHaveLength(0);
  });

  test('non-existent goal_id throws', async () => {
    const { tools, updateCalls } = makeTools();
    await expect(
      tools.updateTransaction({ transaction_id: 'txn1', goal_id: 'ghost' })
    ).rejects.toThrow(/Goal not found/i);
    expect(updateCalls).toHaveLength(0);
  });

  test('non-existent transaction_id throws', async () => {
    const { tools, updateCalls } = makeTools();
    await expect(
      tools.updateTransaction({ transaction_id: 'missing', category_id: 'food' })
    ).rejects.toThrow(/Transaction not found/i);
    expect(updateCalls).toHaveLength(0);
  });

  test('nonexistent transaction_id + invalid category_id surfaces "Transaction not found"', async () => {
    // Validation order: transaction existence is the primary precondition. If both
    // the transaction and a field are invalid, the caller should see the transaction
    // error first so they know the txn_id is wrong before chasing field issues.
    const { tools, updateCalls } = makeTools();
    await expect(
      tools.updateTransaction({ transaction_id: 'missing', category_id: 'ghost_category' })
    ).rejects.toThrow(/Transaction not found/i);
    expect(updateCalls).toHaveLength(0);
  });

  test('transaction missing item_id or account_id throws', async () => {
    const { tools, updateCalls } = makeTools({
      transactions: [
        {
          transaction_id: 'txn1',
          amount: 50,
          date: '2024-01-15',
          name: 'Orphan',
          category_id: 'food',
          user_id: 'user123',
          // no item_id / account_id
        },
      ],
    });
    await expect(
      tools.updateTransaction({ transaction_id: 'txn1', category_id: 'food' })
    ).rejects.toThrow(/item_id or account_id/i);
    expect(updateCalls).toHaveLength(0);
  });

  test('goal_id: undefined is treated as absent (no silent unlink)', async () => {
    // Medium-priority finding from review: `'goal_id' in args` is true even for
    // explicit `undefined`, which would otherwise silently unlink the goal.
    // We treat explicit undefined as "field not provided" — direct TS callers
    // can't accidentally unlink by passing undefined.
    const { tools, mockDb, updateCalls } = makeTools({
      transactions: [
        {
          transaction_id: 'txn1',
          amount: 50,
          date: '2024-01-15',
          name: 'Coffee Shop',
          category_id: 'food',
          user_id: 'user123',
          item_id: 'item1',
          account_id: 'acct1',
          goal_id: 'goal1',
        },
      ],
    });
    // Only goal_id: undefined, nothing else → should error as empty patch.
    await expect(
      tools.updateTransaction({ transaction_id: 'txn1', goal_id: undefined })
    ).rejects.toThrow(/at least one field/i);
    expect(updateCalls).toHaveLength(0);
    // Cache still has the original goal_id — no silent unlink.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedTxn = (mockDb as any)._transactions.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t: any) => t.transaction_id === 'txn1'
    );
    expect(cachedTxn.goal_id).toBe('goal1');
  });

  test('category_id set + goal_id: undefined writes only category_id', async () => {
    // If another field is present, goal_id: undefined is still skipped —
    // the write is category_id only, and goal_id stays linked.
    const { tools, mockDb, updateCalls } = makeTools({
      transactions: [
        {
          transaction_id: 'txn1',
          amount: 50,
          date: '2024-01-15',
          name: 'Coffee Shop',
          category_id: 'food',
          user_id: 'user123',
          item_id: 'item1',
          account_id: 'acct1',
          goal_id: 'goal1',
        },
      ],
    });
    const result = await tools.updateTransaction({
      transaction_id: 'txn1',
      category_id: 'groceries',
      goal_id: undefined,
    });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].mask).toEqual(['category_id']);
    expect(result.updated).toEqual(['category_id']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedTxn = (mockDb as any)._transactions.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t: any) => t.transaction_id === 'txn1'
    );
    expect(cachedTxn.goal_id).toBe('goal1'); // unchanged
    expect(cachedTxn.category_id).toBe('groceries');
  });
});

describe('updateTransaction — atomicity on validation failure', () => {
  test('valid category_id + invalid goal_id: no Firestore write, no cache mutation', async () => {
    const { tools, mockDb, updateCalls } = makeTools();
    await expect(
      tools.updateTransaction({
        transaction_id: 'txn1',
        category_id: 'groceries',
        goal_id: 'ghost',
      })
    ).rejects.toThrow(/Goal not found/i);
    expect(updateCalls).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedTxn = (mockDb as any)._transactions.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t: any) => t.transaction_id === 'txn1'
    );
    expect(cachedTxn.category_id).toBe('food'); // unchanged
  });

  test('valid note + invalid category_id: no write, no cache mutation', async () => {
    const { tools, mockDb, updateCalls } = makeTools();
    await expect(
      tools.updateTransaction({
        transaction_id: 'txn1',
        note: 'this should not persist',
        category_id: 'ghost_category',
      })
    ).rejects.toThrow(/Category not found/i);
    expect(updateCalls).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedTxn = (mockDb as any)._transactions.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t: any) => t.transaction_id === 'txn1'
    );
    expect(cachedTxn.user_note).toBe('pre-existing note'); // unchanged
  });
});

describe('updateTransaction — cache patching', () => {
  test('successful update patches the in-memory cache with cacheFields', async () => {
    const { tools, mockDb } = makeTools();
    await tools.updateTransaction({
      transaction_id: 'txn1',
      category_id: 'groceries',
      note: 'new note',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedTxn = (mockDb as any)._transactions.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t: any) => t.transaction_id === 'txn1'
    );
    expect(cachedTxn.category_id).toBe('groceries');
    expect(cachedTxn.user_note).toBe('new note');
  });
});
