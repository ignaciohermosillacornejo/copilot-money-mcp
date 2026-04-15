/**
 * Tests for domain write tools that dispatch per-domain GraphQL:
 *   updateCategory, deleteCategory, set_budget, setRecurringState,
 *   deleteRecurring.
 *
 * Goals tools are gone. Budget tools (create/update/delete) collapsed
 * into set_budget.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';

describe('updateCategory', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._userCategories = [
      { category_id: 'cat1', name: 'Food', excluded: false },
      { category_id: 'cat2', name: 'Transport', excluded: false },
    ];
    (mockDb as any)._allCollectionsLoaded = true;
  });

  test('throws when no fields provided', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(tools.updateCategory({ category_id: 'cat1' })).rejects.toThrow(
      'update_category requires at least one field to update'
    );
    expect(client._calls).toHaveLength(0);
  });

  test('dispatches EditCategory with mapped input', async () => {
    const client = createMockGraphQLClient({
      EditCategory: {
        editCategory: {
          category: { id: 'cat1', name: 'Dining', colorName: 'RED' },
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.updateCategory({
      category_id: 'cat1',
      name: 'Dining',
      color_name: 'RED',
    });

    expect(result.success).toBe(true);
    expect(result.category_id).toBe('cat1');
    expect(result.updated).toEqual(['name', 'colorName']);

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('EditCategory');
    expect(client._calls[0].variables).toEqual({
      id: 'cat1',
      spend: false,
      budget: false,
      input: { name: 'Dining', colorName: 'RED' },
    });
  });

  test('supports parent_id null to ungroup', async () => {
    const client = createMockGraphQLClient({
      EditCategory: {
        editCategory: {
          category: { id: 'cat1', name: 'Food', colorName: 'BLUE' },
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.updateCategory({ category_id: 'cat1', parent_id: null });
    expect(result.success).toBe(true);
    expect(client._calls[0].variables).toEqual({
      id: 'cat1',
      spend: false,
      budget: false,
      input: { parentId: null },
    });
  });
});

describe('deleteCategory', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._allCollectionsLoaded = true;
  });

  test('dispatches DeleteCategory with id', async () => {
    const client = createMockGraphQLClient({ DeleteCategory: { deleteCategory: true } });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.deleteCategory({ category_id: 'cat1' });
    expect(result.success).toBe(true);
    expect(result.category_id).toBe('cat1');
    expect(result.deleted).toBe(true);

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('DeleteCategory');
    expect(client._calls[0].variables).toEqual({ id: 'cat1' });
  });
});

describe('set_budget', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._allCollectionsLoaded = true;
  });

  test('dispatches EditBudget for all-months default (no month)', async () => {
    const client = createMockGraphQLClient({ EditBudget: { editCategoryBudget: true } });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.setBudget({ category_id: 'cat1', amount: '250.00' });
    expect(result.success).toBe(true);
    expect(result.category_id).toBe('cat1');
    expect(result.amount).toBe('250.00');
    expect(result.cleared).toBe(false);
    expect(result.month).toBeUndefined();

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('EditBudget');
    expect(client._calls[0].variables).toEqual({
      categoryId: 'cat1',
      input: { amount: '250.00' },
    });
  });

  test('amount="0" clears the budget (cleared=true)', async () => {
    const client = createMockGraphQLClient({ EditBudget: { editCategoryBudget: true } });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.setBudget({ category_id: 'cat1', amount: '0' });
    expect(result.cleared).toBe(true);
    expect(client._calls[0].op).toBe('EditBudget');
  });

  test('dispatches EditBudgetMonthly when month="YYYY-MM" is provided', async () => {
    const client = createMockGraphQLClient({
      EditBudgetMonthly: { editCategoryBudgetMonthly: true },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.setBudget({
      category_id: 'cat1',
      amount: '100.00',
      month: '2025-03',
    });
    expect(result.success).toBe(true);
    expect(result.month).toBe('2025-03');
    expect(client._calls[0].op).toBe('EditBudgetMonthly');
    expect(client._calls[0].variables).toEqual({
      categoryId: 'cat1',
      input: [{ amount: '100.00', month: '2025-03' }],
    });
  });

  test('rejects malformed month', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.setBudget({ category_id: 'cat1', amount: '100', month: '03-2025' })
    ).rejects.toThrow('month must be "YYYY-MM"');
    expect(client._calls).toHaveLength(0);
  });

  test('rejects non-string amount', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.setBudget({ category_id: 'cat1', amount: 100 as any })).rejects.toThrow(
      'amount must be a string'
    );
    expect(client._calls).toHaveLength(0);
  });

  test('rejects empty category_id', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.setBudget({ category_id: '', amount: '100' })).rejects.toThrow(
      'category_id is required'
    );
    expect(client._calls).toHaveLength(0);
  });
});

describe('setRecurringState', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._recurring = [
      { recurring_id: 'rec1', name: 'Netflix', state: 'ACTIVE', is_active: true },
    ];
    (mockDb as any)._allCollectionsLoaded = true;
  });

  test('dispatches EditRecurring with state=PAUSED', async () => {
    const client = createMockGraphQLClient({
      EditRecurring: {
        editRecurring: { recurring: { id: 'rec1', state: 'PAUSED' } },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.setRecurringState({ recurring_id: 'rec1', state: 'PAUSED' });
    expect(result.success).toBe(true);
    expect(result.recurring_id).toBe('rec1');
    expect(result.state).toBe('PAUSED');

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('EditRecurring');
    expect(client._calls[0].variables).toEqual({
      id: 'rec1',
      input: { state: 'PAUSED' },
    });
  });

  test('rejects invalid state', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.setRecurringState({ recurring_id: 'rec1', state: 'deleted' as any })
    ).rejects.toThrow('state must be one of: ACTIVE, PAUSED, ARCHIVED');
    expect(client._calls).toHaveLength(0);
  });
});

describe('deleteRecurring', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._recurring = [{ recurring_id: 'rec1', name: 'Netflix' }];
    (mockDb as any)._allCollectionsLoaded = true;
  });

  test('dispatches DeleteRecurring with deleteRecurringId variable', async () => {
    const client = createMockGraphQLClient({ DeleteRecurring: { deleteRecurring: true } });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.deleteRecurring({ recurring_id: 'rec1' });
    expect(result.success).toBe(true);
    expect(result.recurring_id).toBe('rec1');
    expect(result.deleted).toBe(true);

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('DeleteRecurring');
    expect(client._calls[0].variables).toEqual({ deleteRecurringId: 'rec1' });
  });
});
