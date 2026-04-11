/**
 * E2E tests for write tools added in Phase 2.
 *
 * Covers: updateCategory, deleteCategory, createBudget,
 * updateBudget, deleteBudget, setRecurringState, deleteRecurring,
 * updateGoal, deleteGoal.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';

// ============================================
// Shared mock Firestore client helpers
// ============================================

interface UpdateCall {
  collection: string;
  docId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fields: any;
  mask: string[];
}

interface CreateCall {
  collection: string;
  docId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fields: any;
}

interface DeleteCall {
  collection: string;
  docId: string;
}

function makeMockFirestoreClient(opts?: {
  updateCalls?: UpdateCall[];
  createCalls?: CreateCall[];
  deleteCalls?: DeleteCall[];
}) {
  const updateCalls = opts?.updateCalls ?? [];
  const createCalls = opts?.createCalls ?? [];
  const deleteCalls = opts?.deleteCalls ?? [];

  return {
    requireUserId: async () => 'user123',
    getUserId: () => 'user123',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateDocument: async (collection: string, docId: string, fields: any, mask: string[]) => {
      updateCalls.push({ collection, docId, fields, mask });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createDocument: async (collection: string, docId: string, fields: any) => {
      createCalls.push({ collection, docId, fields });
    },
    deleteDocument: async (collection: string, docId: string) => {
      deleteCalls.push({ collection, docId });
    },
  };
}

// ============================================
// Category Write Tools
// ============================================

describe('updateCategory', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  let updateCalls: UpdateCall[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._userCategories = [
      { category_id: 'cat1', name: 'Food', user_id: 'user123', emoji: '🍕', excluded: false },
      { category_id: 'cat2', name: 'Transport', user_id: 'user123', excluded: false },
      { category_id: 'cat3', name: 'Shopping', user_id: 'user123', excluded: false },
    ];
    (mockDb as any)._allCollectionsLoaded = true;

    updateCalls = [];
    const mockClient = makeMockFirestoreClient({ updateCalls });
    tools = new CopilotMoneyTools(mockDb, mockClient as any);
  });

  test('updates name and emoji', async () => {
    const result = await tools.updateCategory({
      category_id: 'cat1',
      name: 'Dining',
      emoji: '🍔',
    });
    expect(result.success).toBe(true);
    expect(result.category_id).toBe('cat1');
    expect(result.updated_fields).toEqual(['name', 'emoji']);
  });

  test('rejects duplicate name (case-insensitive)', async () => {
    await expect(tools.updateCategory({ category_id: 'cat1', name: 'transport' })).rejects.toThrow(
      'Category with name "transport" already exists'
    );
  });

  test('throws when category not found', async () => {
    await expect(tools.updateCategory({ category_id: 'nonexistent', name: 'X' })).rejects.toThrow(
      'Category not found: nonexistent'
    );
  });

  test('rejects self-reference parent', async () => {
    await expect(
      tools.updateCategory({ category_id: 'cat1', parent_category_id: 'cat1' })
    ).rejects.toThrow('A category cannot be its own parent');
  });

  test('throws when no fields provided', async () => {
    await expect(tools.updateCategory({ category_id: 'cat1' })).rejects.toThrow(
      'No fields to update'
    );
  });

  test('validates color as #RRGGBB', async () => {
    await expect(tools.updateCategory({ category_id: 'cat1', color: 'red' })).rejects.toThrow(
      'Invalid color format'
    );

    await expect(tools.updateCategory({ category_id: 'cat1', color: '#GGG000' })).rejects.toThrow(
      'Invalid color format'
    );

    // Valid color should succeed
    const result = await tools.updateCategory({ category_id: 'cat1', color: '#FF5733' });
    expect(result.success).toBe(true);
    expect(result.updated_fields).toEqual(['color']);
  });

  test('updates excluded field', async () => {
    const result = await tools.updateCategory({ category_id: 'cat1', excluded: true });
    expect(result.success).toBe(true);
    expect(result.updated_fields).toEqual(['excluded']);
    expect(updateCalls[0].fields).toEqual({ excluded: { booleanValue: true } });
  });

  test('calls Firestore with correct collection path', async () => {
    await tools.updateCategory({ category_id: 'cat1', name: 'Dining' });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].collection).toBe('users/user123/categories');
    expect(updateCalls[0].docId).toBe('cat1');
    expect(updateCalls[0].mask).toEqual(['name']);
  });

  test('clears cache after successful write', async () => {
    await tools.updateCategory({ category_id: 'cat1', name: 'Dining' });
    expect((mockDb as any)._userCategories).toBeNull();
  });
});

describe('deleteCategory', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  let deleteCalls: DeleteCall[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._userCategories = [
      { category_id: 'cat1', name: 'Food', user_id: 'user123' },
      { category_id: 'cat2', name: 'Transport', user_id: 'user123' },
    ];
    (mockDb as any)._allCollectionsLoaded = true;

    deleteCalls = [];
    const mockClient = makeMockFirestoreClient({ deleteCalls });
    tools = new CopilotMoneyTools(mockDb, mockClient as any);
  });

  test('deletes a category successfully', async () => {
    const result = await tools.deleteCategory({ category_id: 'cat1' });
    expect(result.success).toBe(true);
    expect(result.category_id).toBe('cat1');
    expect(result.deleted_name).toBe('Food');
  });

  test('throws when category not found', async () => {
    await expect(tools.deleteCategory({ category_id: 'nonexistent' })).rejects.toThrow(
      'Category not found: nonexistent'
    );
  });

  test('calls Firestore deleteDocument with correct path', async () => {
    await tools.deleteCategory({ category_id: 'cat1' });
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].collection).toBe('users/user123/categories');
    expect(deleteCalls[0].docId).toBe('cat1');
  });
});

// ============================================
// Budget Write Tools
// ============================================

describe('createBudget', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  let createCalls: CreateCall[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._userCategories = [
      { category_id: 'food', name: 'Food', user_id: 'user123' },
      { category_id: 'transport', name: 'Transport', user_id: 'user123' },
    ];
    (mockDb as any)._budgets = [
      { budget_id: 'bgt1', category_id: 'food', amount: 500, period: 'monthly', is_active: true },
    ];
    (mockDb as any)._allCollectionsLoaded = true;

    createCalls = [];
    const mockClient = makeMockFirestoreClient({ createCalls });
    tools = new CopilotMoneyTools(mockDb, mockClient as any);
  });

  test('creates a budget successfully', async () => {
    const result = await tools.createBudget({
      category_id: 'transport',
      amount: 200,
    });
    expect(result.success).toBe(true);
    expect(result.budget_id).toMatch(/^budget_/);
    expect(result.category_id).toBe('transport');
    expect(result.amount).toBe(200);
    expect(result.period).toBe('monthly'); // default
  });

  test('rejects invalid period', async () => {
    await expect(
      tools.createBudget({ category_id: 'transport', amount: 200, period: 'biweekly' })
    ).rejects.toThrow('Invalid period: biweekly');
  });

  test('rejects amount <= 0', async () => {
    await expect(tools.createBudget({ category_id: 'transport', amount: 0 })).rejects.toThrow(
      'Budget amount must be greater than 0'
    );
    await expect(tools.createBudget({ category_id: 'transport', amount: -5 })).rejects.toThrow(
      'Budget amount must be greater than 0'
    );
  });

  test('rejects duplicate category budget', async () => {
    await expect(tools.createBudget({ category_id: 'food', amount: 300 })).rejects.toThrow(
      'A budget already exists for category "food"'
    );
  });

  test('throws when category not found', async () => {
    await expect(tools.createBudget({ category_id: 'nonexistent', amount: 100 })).rejects.toThrow(
      'Category not found: nonexistent'
    );
  });

  test('calls Firestore createDocument with correct path', async () => {
    await tools.createBudget({ category_id: 'transport', amount: 200 });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].collection).toBe('users/user123/budgets');
    expect(createCalls[0].docId).toMatch(/^budget_/);
  });

  test('clears cache after successful write', async () => {
    await tools.createBudget({ category_id: 'transport', amount: 200 });
    expect((mockDb as any)._budgets).toBeNull();
  });
});

describe('updateBudget', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  let updateCalls: UpdateCall[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._budgets = [
      {
        budget_id: 'bgt1',
        category_id: 'food',
        amount: 500,
        period: 'monthly',
        name: 'Food Budget',
        is_active: true,
      },
    ];
    (mockDb as any)._allCollectionsLoaded = true;

    updateCalls = [];
    const mockClient = makeMockFirestoreClient({ updateCalls });
    tools = new CopilotMoneyTools(mockDb, mockClient as any);
  });

  test('updates budget amount', async () => {
    const result = await tools.updateBudget({ budget_id: 'bgt1', amount: 600 });
    expect(result.success).toBe(true);
    expect(result.budget_id).toBe('bgt1');
    expect(result.updated_fields).toEqual(['amount']);
  });

  test('throws when no fields provided', async () => {
    await expect(tools.updateBudget({ budget_id: 'bgt1' })).rejects.toThrow('No fields to update');
  });

  test('rejects amount <= 0', async () => {
    await expect(tools.updateBudget({ budget_id: 'bgt1', amount: 0 })).rejects.toThrow(
      'Budget amount must be greater than 0'
    );
  });

  test('rejects empty name', async () => {
    await expect(tools.updateBudget({ budget_id: 'bgt1', name: '   ' })).rejects.toThrow(
      'Budget name must not be empty'
    );
  });

  test('throws when budget not found', async () => {
    await expect(tools.updateBudget({ budget_id: 'nonexistent', amount: 100 })).rejects.toThrow(
      'Budget not found: nonexistent'
    );
  });

  test('calls Firestore with correct collection path', async () => {
    await tools.updateBudget({ budget_id: 'bgt1', amount: 600 });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].collection).toBe('users/user123/budgets');
    expect(updateCalls[0].docId).toBe('bgt1');
    expect(updateCalls[0].mask).toEqual(['amount']);
  });
});

describe('deleteBudget', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  let deleteCalls: DeleteCall[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._budgets = [
      { budget_id: 'bgt1', category_id: 'food', amount: 500, name: 'Food Budget' },
    ];
    (mockDb as any)._allCollectionsLoaded = true;

    deleteCalls = [];
    const mockClient = makeMockFirestoreClient({ deleteCalls });
    tools = new CopilotMoneyTools(mockDb, mockClient as any);
  });

  test('deletes a budget successfully', async () => {
    const result = await tools.deleteBudget({ budget_id: 'bgt1' });
    expect(result.success).toBe(true);
    expect(result.budget_id).toBe('bgt1');
    expect(result.deleted_name).toBe('Food Budget');
  });

  test('throws when budget not found', async () => {
    await expect(tools.deleteBudget({ budget_id: 'nonexistent' })).rejects.toThrow(
      'Budget not found: nonexistent'
    );
  });

  test('calls Firestore deleteDocument with correct path', async () => {
    await tools.deleteBudget({ budget_id: 'bgt1' });
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].collection).toBe('users/user123/budgets');
    expect(deleteCalls[0].docId).toBe('bgt1');
  });
});

// ============================================
// Recurring Write Tools
// ============================================

describe('setRecurringState', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  let updateCalls: UpdateCall[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._recurring = [
      {
        recurring_id: 'rec1',
        name: 'Netflix',
        amount: 15.99,
        state: 'active',
        is_active: true,
      },
      {
        recurring_id: 'rec2',
        name: 'Gym',
        amount: 50,
        is_active: false,
        // No state field — tests fallback derivation from is_active
      },
    ];
    (mockDb as any)._allCollectionsLoaded = true;

    updateCalls = [];
    const mockClient = makeMockFirestoreClient({ updateCalls });
    tools = new CopilotMoneyTools(mockDb, mockClient as any);
  });

  test('pauses an active recurring item', async () => {
    const result = await tools.setRecurringState({
      recurring_id: 'rec1',
      state: 'paused',
    });
    expect(result.success).toBe(true);
    expect(result.recurring_id).toBe('rec1');
    expect(result.name).toBe('Netflix');
    expect(result.old_state).toBe('active');
    expect(result.new_state).toBe('paused');
  });

  test('rejects invalid state', async () => {
    // `as any` needed because TypeScript's union type won't accept 'deleted'
    await expect(
      tools.setRecurringState({ recurring_id: 'rec1', state: 'deleted' as any })
    ).rejects.toThrow('Invalid state: deleted');
  });

  test('throws when recurring not found', async () => {
    await expect(
      tools.setRecurringState({ recurring_id: 'nonexistent', state: 'active' })
    ).rejects.toThrow('Recurring item not found: nonexistent');
  });

  test('derives old state from is_active when state field is missing', async () => {
    const result = await tools.setRecurringState({
      recurring_id: 'rec2',
      state: 'active',
    });
    expect(result.old_state).toBe('paused'); // is_active was false
    expect(result.new_state).toBe('active');
  });

  test('calls Firestore with both state and is_active (archived → false)', async () => {
    await tools.setRecurringState({ recurring_id: 'rec1', state: 'archived' });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].collection).toBe('users/user123/recurring');
    expect(updateCalls[0].docId).toBe('rec1');
    expect(updateCalls[0].mask).toEqual(['state', 'is_active']);
    expect(updateCalls[0].fields).toEqual({
      state: { stringValue: 'archived' },
      is_active: { booleanValue: false },
    });
  });

  test('calls Firestore with is_active: true when activating', async () => {
    await tools.setRecurringState({ recurring_id: 'rec2', state: 'active' });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].fields).toEqual({
      state: { stringValue: 'active' },
      is_active: { booleanValue: true },
    });
  });

  test('clears cache after successful write', async () => {
    await tools.setRecurringState({ recurring_id: 'rec1', state: 'paused' });
    expect((mockDb as any)._recurring).toBeNull();
  });
});

describe('deleteRecurring', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  let deleteCalls: DeleteCall[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._recurring = [
      { recurring_id: 'rec1', name: 'Netflix', amount: 15.99, is_active: true },
    ];
    (mockDb as any)._allCollectionsLoaded = true;

    deleteCalls = [];
    const mockClient = makeMockFirestoreClient({ deleteCalls });
    tools = new CopilotMoneyTools(mockDb, mockClient as any);
  });

  test('deletes a recurring item successfully', async () => {
    const result = await tools.deleteRecurring({ recurring_id: 'rec1' });
    expect(result.success).toBe(true);
    expect(result.recurring_id).toBe('rec1');
    expect(result.deleted_name).toBe('Netflix');
  });

  test('throws when recurring not found', async () => {
    await expect(tools.deleteRecurring({ recurring_id: 'nonexistent' })).rejects.toThrow(
      'Recurring item not found: nonexistent'
    );
  });

  test('calls Firestore deleteDocument with correct path', async () => {
    await tools.deleteRecurring({ recurring_id: 'rec1' });
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].collection).toBe('users/user123/recurring');
    expect(deleteCalls[0].docId).toBe('rec1');
  });
});

// ============================================
// Goal Write Tools
// ============================================

describe('updateGoal', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  let updateCalls: UpdateCall[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._goals = [
      {
        goal_id: 'goal1',
        name: 'Emergency Fund',
        emoji: '🏦',
        savings: {
          status: 'active',
          target_amount: 10000,
          tracking_type_monthly_contribution: 500,
        },
      },
    ];
    (mockDb as any)._allCollectionsLoaded = true;

    updateCalls = [];
    const mockClient = makeMockFirestoreClient({ updateCalls });
    tools = new CopilotMoneyTools(mockDb, mockClient as any);
  });

  test('updates goal name', async () => {
    const result = await tools.updateGoal({ goal_id: 'goal1', name: 'Rainy Day Fund' });
    expect(result.success).toBe(true);
    expect(result.goal_id).toBe('goal1');
    expect(result.updated_fields).toEqual(['name']);
  });

  test('savings fields use single savings mask entry', async () => {
    const result = await tools.updateGoal({
      goal_id: 'goal1',
      target_amount: 20000,
      monthly_contribution: 1000,
    });
    expect(result.success).toBe(true);
    expect(result.updated_fields).toEqual(['savings']);
  });

  test('throws when no fields provided', async () => {
    await expect(tools.updateGoal({ goal_id: 'goal1' })).rejects.toThrow('No fields to update');
  });

  test('allows monthly_contribution of 0', async () => {
    const result = await tools.updateGoal({ goal_id: 'goal1', monthly_contribution: 0 });
    expect(result.success).toBe(true);
    expect(result.updated_fields).toEqual(['savings']);
  });

  test('rejects target_amount <= 0', async () => {
    await expect(tools.updateGoal({ goal_id: 'goal1', target_amount: 0 })).rejects.toThrow(
      'target_amount must be greater than 0'
    );
    await expect(tools.updateGoal({ goal_id: 'goal1', target_amount: -100 })).rejects.toThrow(
      'target_amount must be greater than 0'
    );
  });

  test('throws when goal not found', async () => {
    await expect(tools.updateGoal({ goal_id: 'nonexistent', name: 'X' })).rejects.toThrow(
      'Goal not found: nonexistent'
    );
  });

  test('calls Firestore with correct collection path', async () => {
    await tools.updateGoal({ goal_id: 'goal1', name: 'New Name' });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].collection).toBe('users/user123/financial_goals');
    expect(updateCalls[0].docId).toBe('goal1');
    expect(updateCalls[0].mask).toEqual(['name']);
  });

  test('maps monthly_contribution to tracking_type_monthly_contribution in savings', async () => {
    await tools.updateGoal({ goal_id: 'goal1', monthly_contribution: 750 });
    expect(updateCalls).toHaveLength(1);
    // The savings sub-object should contain the mapped field name
    const savingsField = updateCalls[0].fields.savings;
    expect(savingsField).toBeDefined();
    // Verify the nested mapValue contains tracking_type_monthly_contribution
    expect(savingsField.mapValue.fields.tracking_type_monthly_contribution).toEqual({
      integerValue: '750',
    });
  });

  test('clears cache after successful write', async () => {
    await tools.updateGoal({ goal_id: 'goal1', name: 'Updated' });
    expect((mockDb as any)._goals).toBeNull();
  });
});

describe('deleteGoal', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  let deleteCalls: DeleteCall[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._goals = [
      { goal_id: 'goal1', name: 'Emergency Fund', savings: { status: 'active' } },
    ];
    (mockDb as any)._allCollectionsLoaded = true;

    deleteCalls = [];
    const mockClient = makeMockFirestoreClient({ deleteCalls });
    tools = new CopilotMoneyTools(mockDb, mockClient as any);
  });

  test('deletes a goal successfully', async () => {
    const result = await tools.deleteGoal({ goal_id: 'goal1' });
    expect(result.success).toBe(true);
    expect(result.goal_id).toBe('goal1');
    expect(result.deleted_name).toBe('Emergency Fund');
  });

  test('throws when goal not found', async () => {
    await expect(tools.deleteGoal({ goal_id: 'nonexistent' })).rejects.toThrow(
      'Goal not found: nonexistent'
    );
  });

  test('calls Firestore deleteDocument with correct path', async () => {
    await tools.deleteGoal({ goal_id: 'goal1' });
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].collection).toBe('users/user123/financial_goals');
    expect(deleteCalls[0].docId).toBe('goal1');
  });
});
