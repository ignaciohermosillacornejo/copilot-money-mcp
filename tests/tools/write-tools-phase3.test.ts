/**
 * Unit tests for Phase 3 write tools: updateTag, createRecurring, createGoal.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';

// ============================================
// updateTag
// ============================================

describe('updateTag', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let updateCalls: { collection: string; docId: string; fields: any; mask: string[] }[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any).dbPath = '/fake';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._allCollectionsLoaded = true;
    (mockDb as any)._cacheLoadedAt = Date.now();
    (mockDb as any)._tags = [
      { tag_id: 'vacation', name: 'Vacation' },
      { tag_id: 'business', name: 'Business', color_name: 'blue', hex_color: '#0000FF' },
    ];

    updateCalls = [];
    const mockFirestoreClient = {
      requireUserId: async () => 'user123',
      getUserId: () => 'user123',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createDocument: async (_col: string, docId: string | undefined) =>
        docId ?? 'auto_generated_id',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateDocument: async (collection: string, docId: string, fields: any, mask: string[]) => {
        updateCalls.push({ collection, docId, fields, mask });
      },
      deleteDocument: async () => {},
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools = new CopilotMoneyTools(mockDb, mockFirestoreClient as any);
  });

  test('updates tag name', async () => {
    const result = await tools.updateTag({ tag_id: 'vacation', name: 'Holiday' });
    expect(result.success).toBe(true);
    expect(result.tag_id).toBe('vacation');
    expect(result.updated_fields).toEqual(['name']);
  });

  test('updates tag color', async () => {
    const result = await tools.updateTag({
      tag_id: 'vacation',
      color_name: 'red',
      hex_color: '#FF0000',
    });
    expect(result.success).toBe(true);
    expect(result.updated_fields).toContain('color_name');
    expect(result.updated_fields).toContain('hex_color');
  });

  test('updates all fields at once', async () => {
    const result = await tools.updateTag({
      tag_id: 'vacation',
      name: 'Trip',
      color_name: 'green',
      hex_color: '#00FF00',
    });
    expect(result.success).toBe(true);
    expect(result.updated_fields).toEqual(['name', 'color_name', 'hex_color']);
  });

  test('calls Firestore updateDocument with correct path and mask', async () => {
    await tools.updateTag({ tag_id: 'vacation', name: 'Holiday' });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].collection).toBe('users/user123/tags');
    expect(updateCalls[0].docId).toBe('vacation');
    expect(updateCalls[0].mask).toEqual(['name']);
    expect(updateCalls[0].fields).toEqual({
      name: { stringValue: 'Holiday' },
    });
  });

  test('clears cache after update', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._transactions = [{ transaction_id: 'txn1', amount: 10, date: '2024-01-01' }];
    await tools.updateTag({ tag_id: 'vacation', name: 'Holiday' });
    // clearCache sets _transactions to null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockDb as any)._transactions).toBeNull();
  });

  test('throws when no fields provided', async () => {
    await expect(tools.updateTag({ tag_id: 'vacation' })).rejects.toThrow('No fields to update');
  });

  test('throws on invalid tag_id format', async () => {
    await expect(tools.updateTag({ tag_id: 'bad/id', name: 'test' })).rejects.toThrow(
      'Invalid tag_id format'
    );
  });

  test('throws when tag not found', async () => {
    await expect(tools.updateTag({ tag_id: 'nonexistent', name: 'test' })).rejects.toThrow(
      'Tag not found: nonexistent'
    );
  });

  test('throws on empty name', async () => {
    await expect(tools.updateTag({ tag_id: 'vacation', name: '' })).rejects.toThrow(
      'Tag name must not be empty'
    );
  });

  test('throws on whitespace-only name', async () => {
    await expect(tools.updateTag({ tag_id: 'vacation', name: '   ' })).rejects.toThrow(
      'Tag name must not be empty'
    );
  });

  test('throws on invalid hex_color format', async () => {
    await expect(tools.updateTag({ tag_id: 'vacation', hex_color: 'red' })).rejects.toThrow(
      'Invalid color format'
    );
  });

  test('throws on short hex_color', async () => {
    await expect(tools.updateTag({ tag_id: 'vacation', hex_color: '#FFF' })).rejects.toThrow(
      'Invalid color format'
    );
  });

  test('trims whitespace from name', async () => {
    await tools.updateTag({ tag_id: 'vacation', name: '  Holiday  ' });
    expect(updateCalls[0].fields).toEqual({
      name: { stringValue: 'Holiday' },
    });
  });

  test('throws when no Firestore client configured (read-only mode)', async () => {
    const readOnlyTools = new CopilotMoneyTools(mockDb);
    await expect(readOnlyTools.updateTag({ tag_id: 'vacation', name: 'test' })).rejects.toThrow(
      'Write mode is not enabled'
    );
  });
});

// ============================================
// createRecurring
// ============================================

describe('createRecurring', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createCalls: { collection: string; docId: string; fields: any }[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any).dbPath = '/fake';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._allCollectionsLoaded = true;
    (mockDb as any)._cacheLoadedAt = Date.now();
    (mockDb as any)._recurring = [];

    createCalls = [];
    const mockFirestoreClient = {
      requireUserId: async () => 'user123',
      getUserId: () => 'user123',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createDocument: async (collection: string, docId: string | undefined, fields: any) => {
        createCalls.push({ collection, docId, fields });
        return docId ?? 'auto_generated_id';
      },
      updateDocument: async () => {},
      deleteDocument: async () => {},
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools = new CopilotMoneyTools(mockDb, mockFirestoreClient as any);
  });

  test('creates a recurring item with required fields only', async () => {
    const result = await tools.createRecurring({
      name: 'Netflix',
      amount: 15.99,
      frequency: 'monthly',
    });
    expect(result.success).toBe(true);
    expect(result.recurring_id).toBeDefined();
    expect(result.name).toBe('Netflix');
    expect(result.amount).toBe(15.99);
    expect(result.frequency).toBe('monthly');
  });

  test('creates a recurring item with all fields', async () => {
    const result = await tools.createRecurring({
      name: 'Gym Membership',
      amount: 50,
      frequency: 'monthly',
      category_id: 'fitness',
      account_id: 'acc1',
      merchant_name: 'Planet Fitness',
      start_date: '2024-01-01',
    });
    expect(result.success).toBe(true);
    expect(result.name).toBe('Gym Membership');
    expect(result.amount).toBe(50);
    expect(result.frequency).toBe('monthly');
  });

  test('calls Firestore createDocument with correct path', async () => {
    const result = await tools.createRecurring({
      name: 'Netflix',
      amount: 15.99,
      frequency: 'monthly',
    });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].collection).toBe('users/user123/recurring');
    expect(createCalls[0].docId).toBe(result.recurring_id);
  });

  test('includes optional fields in Firestore document', async () => {
    await tools.createRecurring({
      name: 'Gym',
      amount: 50,
      frequency: 'monthly',
      category_id: 'fitness',
      account_id: 'acc1',
      merchant_name: 'Planet Fitness',
      start_date: '2024-06-01',
    });
    const fields = createCalls[0].fields;
    expect(fields.category_id).toEqual({ stringValue: 'fitness' });
    expect(fields.account_id).toEqual({ stringValue: 'acc1' });
    expect(fields.merchant_name).toEqual({ stringValue: 'Planet Fitness' });
    expect(fields.start_date).toEqual({ stringValue: '2024-06-01' });
    expect(fields.latest_date).toEqual({ stringValue: '2024-06-01' });
  });

  test('sets latest_date to today when no start_date provided', async () => {
    await tools.createRecurring({
      name: 'Netflix',
      amount: 15.99,
      frequency: 'monthly',
    });
    const fields = createCalls[0].fields;
    const today = new Date().toISOString().slice(0, 10);
    expect(fields.latest_date).toEqual({ stringValue: today });
  });

  test('sets is_active and state fields', async () => {
    await tools.createRecurring({
      name: 'Netflix',
      amount: 15.99,
      frequency: 'monthly',
    });
    const fields = createCalls[0].fields;
    expect(fields.is_active).toEqual({ booleanValue: true });
    expect(fields.state).toEqual({ stringValue: 'active' });
  });

  test('clears cache after creating recurring item', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._transactions = [{ transaction_id: 'txn1', amount: 10, date: '2024-01-01' }];
    await tools.createRecurring({ name: 'Netflix', amount: 15.99, frequency: 'monthly' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockDb as any)._transactions).toBeNull();
  });

  test('throws on empty name', async () => {
    await expect(
      tools.createRecurring({ name: '', amount: 15.99, frequency: 'monthly' })
    ).rejects.toThrow('Recurring name must not be empty');
  });

  test('throws on whitespace-only name', async () => {
    await expect(
      tools.createRecurring({ name: '   ', amount: 15.99, frequency: 'monthly' })
    ).rejects.toThrow('Recurring name must not be empty');
  });

  test('throws on zero amount', async () => {
    await expect(
      tools.createRecurring({ name: 'Netflix', amount: 0, frequency: 'monthly' })
    ).rejects.toThrow('Recurring amount must be greater than 0');
  });

  test('throws on negative amount', async () => {
    await expect(
      tools.createRecurring({ name: 'Netflix', amount: -10, frequency: 'monthly' })
    ).rejects.toThrow('Recurring amount must be greater than 0');
  });

  test('throws on invalid frequency', async () => {
    await expect(
      tools.createRecurring({ name: 'Netflix', amount: 15.99, frequency: 'daily' })
    ).rejects.toThrow('Invalid frequency: daily');
  });

  test('throws on invalid category_id format', async () => {
    await expect(
      tools.createRecurring({
        name: 'Netflix',
        amount: 15.99,
        frequency: 'monthly',
        category_id: 'bad/id',
      })
    ).rejects.toThrow('Invalid category_id format');
  });

  test('throws on invalid account_id format', async () => {
    await expect(
      tools.createRecurring({
        name: 'Netflix',
        amount: 15.99,
        frequency: 'monthly',
        account_id: 'bad id',
      })
    ).rejects.toThrow('Invalid account_id format');
  });

  test('trims whitespace from name', async () => {
    const result = await tools.createRecurring({
      name: '  Netflix  ',
      amount: 15.99,
      frequency: 'monthly',
    });
    expect(result.name).toBe('Netflix');
  });

  test('accepts all valid frequencies', async () => {
    for (const freq of ['weekly', 'biweekly', 'monthly', 'yearly']) {
      const result = await tools.createRecurring({ name: 'Test', amount: 10, frequency: freq });
      expect(result.frequency).toBe(freq);
    }
  });

  test('throws on invalid start_date format', async () => {
    await expect(
      tools.createRecurring({
        name: 'Netflix',
        amount: 15.99,
        frequency: 'monthly',
        start_date: 'not-a-date',
      })
    ).rejects.toThrow('Invalid start_date format');
  });

  test('accepts valid start_date format', async () => {
    const result = await tools.createRecurring({
      name: 'Netflix',
      amount: 15.99,
      frequency: 'monthly',
      start_date: '2024-06-15',
    });
    expect(result.success).toBe(true);
  });

  test('throws when no Firestore client configured (read-only mode)', async () => {
    const readOnlyTools = new CopilotMoneyTools(mockDb);
    await expect(
      readOnlyTools.createRecurring({ name: 'Netflix', amount: 15.99, frequency: 'monthly' })
    ).rejects.toThrow('Write mode is not enabled');
  });
});

// ============================================
// createGoal
// ============================================

describe('createGoal', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createCalls: { collection: string; docId: string; fields: any }[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any).dbPath = '/fake';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._allCollectionsLoaded = true;
    (mockDb as any)._cacheLoadedAt = Date.now();
    (mockDb as any)._goals = [];

    createCalls = [];
    const mockFirestoreClient = {
      requireUserId: async () => 'user123',
      getUserId: () => 'user123',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createDocument: async (collection: string, docId: string | undefined, fields: any) => {
        createCalls.push({ collection, docId, fields });
        return docId ?? 'auto_generated_id';
      },
      updateDocument: async () => {},
      deleteDocument: async () => {},
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools = new CopilotMoneyTools(mockDb, mockFirestoreClient as any);
  });

  test('creates a goal with required fields only', async () => {
    const result = await tools.createGoal({
      name: 'Emergency Fund',
      target_amount: 10000,
    });
    expect(result.success).toBe(true);
    expect(result.goal_id).toBeDefined();
    expect(result.name).toBe('Emergency Fund');
    expect(result.target_amount).toBe(10000);
  });

  test('creates a goal with all fields', async () => {
    const result = await tools.createGoal({
      name: 'Vacation',
      target_amount: 5000,
      emoji: '🏖️',
      monthly_contribution: 200,
      start_date: '2024-01-01',
    });
    expect(result.success).toBe(true);
    expect(result.name).toBe('Vacation');
    expect(result.target_amount).toBe(5000);
  });

  test('calls Firestore createDocument with correct path', async () => {
    const result = await tools.createGoal({
      name: 'Emergency Fund',
      target_amount: 10000,
    });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].collection).toBe('users/user123/financial_goals');
    expect(createCalls[0].docId).toBe(result.goal_id);
  });

  test('builds savings sub-object with manual tracking by default', async () => {
    await tools.createGoal({
      name: 'Emergency Fund',
      target_amount: 10000,
    });
    const fields = createCalls[0].fields;
    const savings = fields.savings?.mapValue?.fields;
    expect(savings).toBeDefined();
    expect(savings.type).toEqual({ stringValue: 'savings' });
    expect(savings.status).toEqual({ stringValue: 'active' });
    expect(savings.target_amount).toEqual({ integerValue: '10000' });
    expect(savings.tracking_type).toEqual({ stringValue: 'manual' });
    expect(savings.tracking_type_monthly_contribution).toEqual({ integerValue: '0' });
    expect(savings.is_ongoing).toEqual({ booleanValue: false });
  });

  test('sets tracking_type to monthly_contribution when provided', async () => {
    await tools.createGoal({
      name: 'Vacation',
      target_amount: 5000,
      monthly_contribution: 200,
    });
    const fields = createCalls[0].fields;
    const savings = fields.savings?.mapValue?.fields;
    expect(savings.tracking_type).toEqual({ stringValue: 'monthly_contribution' });
    expect(savings.tracking_type_monthly_contribution).toEqual({ integerValue: '200' });
  });

  test('uses start_date in savings when provided', async () => {
    await tools.createGoal({
      name: 'Vacation',
      target_amount: 5000,
      start_date: '2024-06-01',
    });
    const fields = createCalls[0].fields;
    const savings = fields.savings?.mapValue?.fields;
    expect(savings.start_date).toEqual({ stringValue: '2024-06-01' });
  });

  test('uses today as default start_date in savings', async () => {
    await tools.createGoal({
      name: 'Emergency Fund',
      target_amount: 10000,
    });
    const fields = createCalls[0].fields;
    const savings = fields.savings?.mapValue?.fields;
    const today = new Date().toISOString().slice(0, 10);
    expect(savings.start_date).toEqual({ stringValue: today });
  });

  test('includes emoji in document when provided', async () => {
    await tools.createGoal({
      name: 'Vacation',
      target_amount: 5000,
      emoji: '🏖️',
    });
    const fields = createCalls[0].fields;
    expect(fields.emoji).toEqual({ stringValue: '🏖️' });
  });

  test('omits emoji from document when not provided', async () => {
    await tools.createGoal({
      name: 'Emergency Fund',
      target_amount: 10000,
    });
    const fields = createCalls[0].fields;
    expect(fields.emoji).toBeUndefined();
  });

  test('clears cache after creating goal', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._transactions = [{ transaction_id: 'txn1', amount: 10, date: '2024-01-01' }];
    await tools.createGoal({ name: 'Emergency Fund', target_amount: 10000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockDb as any)._transactions).toBeNull();
  });

  test('throws on empty name', async () => {
    await expect(tools.createGoal({ name: '', target_amount: 10000 })).rejects.toThrow(
      'Goal name must not be empty'
    );
  });

  test('throws on whitespace-only name', async () => {
    await expect(tools.createGoal({ name: '   ', target_amount: 10000 })).rejects.toThrow(
      'Goal name must not be empty'
    );
  });

  test('throws on zero target_amount', async () => {
    await expect(tools.createGoal({ name: 'Emergency Fund', target_amount: 0 })).rejects.toThrow(
      'target_amount must be greater than 0'
    );
  });

  test('throws on negative target_amount', async () => {
    await expect(
      tools.createGoal({ name: 'Emergency Fund', target_amount: -1000 })
    ).rejects.toThrow('target_amount must be greater than 0');
  });

  test('throws on negative monthly_contribution', async () => {
    await expect(
      tools.createGoal({ name: 'Emergency Fund', target_amount: 10000, monthly_contribution: -50 })
    ).rejects.toThrow('monthly_contribution must be >= 0');
  });

  test('allows zero monthly_contribution and sets tracking_type to monthly_contribution', async () => {
    const result = await tools.createGoal({
      name: 'Emergency Fund',
      target_amount: 10000,
      monthly_contribution: 0,
    });
    expect(result.success).toBe(true);
    const fields = createCalls[0].fields;
    const savings = fields.savings?.mapValue?.fields;
    expect(savings.tracking_type).toEqual({ stringValue: 'monthly_contribution' });
    expect(savings.tracking_type_monthly_contribution).toEqual({ integerValue: '0' });
  });

  test('trims whitespace from name', async () => {
    const result = await tools.createGoal({
      name: '  Emergency Fund  ',
      target_amount: 10000,
    });
    expect(result.name).toBe('Emergency Fund');
  });

  test('throws when no Firestore client configured (read-only mode)', async () => {
    const readOnlyTools = new CopilotMoneyTools(mockDb);
    await expect(
      readOnlyTools.createGoal({ name: 'Emergency Fund', target_amount: 10000 })
    ).rejects.toThrow('Write mode is not enabled');
  });

  test('throws on invalid start_date format', async () => {
    await expect(
      tools.createGoal({ name: 'Emergency Fund', target_amount: 10000, start_date: 'not-a-date' })
    ).rejects.toThrow('Invalid start_date format');
  });

  test('accepts valid start_date format', async () => {
    const result = await tools.createGoal({
      name: 'Emergency Fund',
      target_amount: 10000,
      start_date: '2024-06-15',
    });
    expect(result.success).toBe(true);
  });

  test('does not modify cache on Firestore error', async () => {
    const failingClient = {
      requireUserId: async () => 'user123',
      getUserId: () => 'user123',
      createDocument: async () => {
        throw new Error('Firestore create failed (500)');
      },
      updateDocument: async () => {},
      deleteDocument: async () => {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failTools = new CopilotMoneyTools(mockDb, failingClient as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._transactions = [{ transaction_id: 'txn1' }];

    await expect(
      failTools.createGoal({ name: 'Emergency Fund', target_amount: 10000 })
    ).rejects.toThrow('Firestore create failed');
    // Cache should NOT have been cleared since error happened before clearCache
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockDb as any)._transactions).not.toBeNull();
  });
});
