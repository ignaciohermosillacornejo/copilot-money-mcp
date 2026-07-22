/**
 * Tests for domain write tools that dispatch per-domain GraphQL:
 *   updateCategory, deleteCategory, set_budget, setRecurringState,
 *   deleteRecurring.
 *
 * Goals tools are gone. Budget tools (create/update/delete) collapsed
 * into set_budget.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';
import type {
  CreatedTransaction,
  CreateTransactionResponse,
} from '../../src/core/graphql/transactions.js';
import type { LiveCopilotDatabase } from '../../src/core/live-database.js';

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
          category: { id: 'cat1', name: 'Dining', colorName: 'RED1' },
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.updateCategory({
      category_id: 'cat1',
      name: 'Dining',
      color_name: 'RED1',
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
      input: { name: 'Dining', colorName: 'RED1' },
    });
  });

  test('requires at least one field when parent_id is silently omitted', async () => {
    // parent_id is no longer part of the tool signature (Copilot GraphQL doesn't
    // accept parentId on EditCategoryInput). An empty update should reject.
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(tools.updateCategory({ category_id: 'cat1' })).rejects.toThrow(
      /requires at least one field/
    );
    expect(client._calls).toHaveLength(0);
  });

  test('rejects a color_name outside the ColorName enum (no dispatch)', async () => {
    // 'GREEN2' is plausible (five palette bases have a *2 variant) but not a
    // real server value — the local guard must reject before any round-trip.
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(
      tools.updateCategory({ category_id: 'cat1', color_name: 'GREEN2' })
    ).rejects.toThrow(/color_name must be one of/);
    expect(client._calls).toHaveLength(0);
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
      input: { amount: 250 },
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
      input: [{ amount: 100, month: '2025-03' }],
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

  test('accepts integer and zero-decimal amount strings', async () => {
    // "250" (no decimals) and "250.00" should both validate.
    const client = createMockGraphQLClient({ EditBudget: { editCategoryBudget: true } });
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.setBudget({ category_id: 'cat1', amount: '250' })).resolves.toMatchObject({
      success: true,
    });
    await expect(tools.setBudget({ category_id: 'cat1', amount: '250.00' })).resolves.toMatchObject(
      { success: true }
    );
    await expect(tools.setBudget({ category_id: 'cat1', amount: '0' })).resolves.toMatchObject({
      success: true,
      cleared: true,
    });
  });

  test('rejects malformed amount strings (non-numeric, empty, negative, >2 decimals)', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    for (const bad of ['abc', '', '-50', '250.123', '1.', '.5', '1,000']) {
      await expect(tools.setBudget({ category_id: 'cat1', amount: bad })).rejects.toThrow(
        /amount must be a non-negative decimal/
      );
    }
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
        editRecurring: {
          recurring: {
            id: 'rec1',
            name: 'Netflix',
            categoryId: 'cat1',
            frequency: 'MONTHLY',
            state: 'PAUSED',
          },
        },
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

  test('accepts uppercase ACTIVE; rejects lowercase active with clear error', async () => {
    // Regression: the MCP tool schema previously exposed lowercase enum values,
    // while the implementation validates uppercase. This test locks in the
    // uppercase contract so the schema and implementation stay aligned.
    const activeClient = createMockGraphQLClient({
      EditRecurring: {
        editRecurring: {
          recurring: {
            id: 'rec1',
            name: 'Netflix',
            categoryId: 'cat1',
            frequency: 'MONTHLY',
            state: 'ACTIVE',
          },
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, activeClient);
    const result = await tools.setRecurringState({ recurring_id: 'rec1', state: 'ACTIVE' });
    expect(result.state).toBe('ACTIVE');

    const badClient = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, badClient);
    await expect(
      tools.setRecurringState({ recurring_id: 'rec1', state: 'active' as any })
    ).rejects.toThrow('state must be one of: ACTIVE, PAUSED, ARCHIVED. Got: active');
    expect(badClient._calls).toHaveLength(0);
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

describe('createTransaction', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;

  // Canned server response used across several happy-path tests.
  const createdTx: CreatedTransaction = {
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
  };

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._allCollectionsLoaded = true;
  });

  const validArgs = {
    account_id: 'acc1',
    item_id: 'item1',
    name: 'Coffee',
    date: '2026-04-21',
    amount: 5.25,
    category_id: 'cat1',
    type: 'REGULAR' as const,
  };

  test('dispatches CreateTransaction with mapped input', async () => {
    const client = createMockGraphQLClient({ CreateTransaction: { createTransaction: createdTx } });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.createTransaction(validArgs);

    expect(result.success).toBe(true);
    expect(result.transaction_id).toBe('new-tx-1');
    expect(result.transaction.transaction_id).toBe('new-tx-1');
    expect(result.transaction.name).toBe('Coffee');
    expect(result.transaction.date).toBe('2026-04-21');
    expect(result.transaction.amount).toBe(5.25);
    expect(result.transaction.category_id).toBe('cat1');
    expect(result.transaction.account_id).toBe('acc1');
    expect(result.transaction.item_id).toBe('item1');

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('CreateTransaction');
    expect(client._calls[0].variables).toEqual({
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

  test('trims whitespace on name before sending', async () => {
    const client = createMockGraphQLClient({ CreateTransaction: { createTransaction: createdTx } });
    tools = new CopilotMoneyTools(mockDb, client);

    await tools.createTransaction({ ...validArgs, name: '  Coffee  ' });

    expect((client._calls[0].variables as any).input.name).toBe('Coffee');
  });

  test('rejects empty name after trim', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.createTransaction({ ...validArgs, name: '   ' })).rejects.toThrow(
      /name.*empty/i
    );
    expect(client._calls).toHaveLength(0);
  });

  test('rejects malformed date', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.createTransaction({ ...validArgs, date: '2026-4-21' })).rejects.toThrow(
      /date.*YYYY-MM-DD/i
    );
    expect(client._calls).toHaveLength(0);
  });

  test('rejects non-finite amount (NaN / Infinity)', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.createTransaction({ ...validArgs, amount: Number.NaN })).rejects.toThrow(
      /amount.*finite/i
    );
    await expect(
      tools.createTransaction({ ...validArgs, amount: Number.POSITIVE_INFINITY })
    ).rejects.toThrow(/amount.*finite/i);
    expect(client._calls).toHaveLength(0);
  });

  test('rejects invalid type enum', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.createTransaction({ ...validArgs, type: 'EXPENSE' as any })).rejects.toThrow(
      /type.*REGULAR.*INCOME.*INTERNAL_TRANSFER/
    );
    expect(client._calls).toHaveLength(0);
  });

  test('rejects invalid document ids', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.createTransaction({ ...validArgs, account_id: 'bad id!' })).rejects.toThrow(
      /Invalid account_id/
    );
    await expect(tools.createTransaction({ ...validArgs, item_id: 'bad/item' })).rejects.toThrow(
      /Invalid item_id/
    );
    await expect(tools.createTransaction({ ...validArgs, category_id: 'bad.id' })).rejects.toThrow(
      /Invalid category_id/
    );
    expect(client._calls).toHaveLength(0);
  });

  test('wraps GraphQL errors with graphQLErrorToMcpError', async () => {
    const { GraphQLError } = await import('../../src/core/graphql/client.js');
    const client = createMockGraphQLClient({
      CreateTransaction: new GraphQLError(
        'USER_ACTION_REQUIRED',
        "Resource id 'bad' is invalid",
        'CreateTransaction',
        200
      ),
    });
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.createTransaction(validArgs)).rejects.toThrow(/Resource id/);
  });

  test('accepts INCOME and INTERNAL_TRANSFER as valid types', async () => {
    const client = createMockGraphQLClient({ CreateTransaction: { createTransaction: createdTx } });
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.createTransaction({ ...validArgs, type: 'INCOME', amount: -1000 })
    ).resolves.toMatchObject({ success: true });
    await expect(
      tools.createTransaction({ ...validArgs, type: 'INTERNAL_TRANSFER' })
    ).resolves.toMatchObject({ success: true });

    expect((client._calls[0].variables as any).input.type).toBe('INCOME');
    expect((client._calls[1].variables as any).input.type).toBe('INTERNAL_TRANSFER');
  });

  test('sets internal_transfer=true on returned transaction when type is INTERNAL_TRANSFER', async () => {
    const serverTx: CreatedTransaction = { ...createdTx, type: 'INTERNAL_TRANSFER' };
    const client = createMockGraphQLClient({ CreateTransaction: { createTransaction: serverTx } });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.createTransaction({ ...validArgs, type: 'INTERNAL_TRANSFER' });
    expect(result.transaction.internal_transfer).toBe(true);
  });

  test('sets internal_transfer=false for REGULAR transactions', async () => {
    const client = createMockGraphQLClient({ CreateTransaction: { createTransaction: createdTx } });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.createTransaction(validArgs);
    expect(result.transaction.internal_transfer).toBe(false);
  });

  test('rejects amount exceeding MAX_VALID_AMOUNT', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.createTransaction({ ...validArgs, amount: 10_000_001 })).rejects.toThrow(
      /amount exceeds maximum/i
    );
    await expect(tools.createTransaction({ ...validArgs, amount: -10_000_001 })).rejects.toThrow(
      /amount exceeds maximum/i
    );
    expect(client._calls).toHaveLength(0);
  });

  // Echoes the create input back into a CreatedTransaction shape so the
  // returned transaction reflects the optional metadata we sent.
  const echoCreate = (vars: any): CreateTransactionResponse => ({
    createTransaction: {
      ...createdTx,
      recurringId: vars.input.recurringId ?? null,
      userNotes: vars.input.userNotes ?? null,
      tags: (vars.input.tagIds ?? []).map((id: string) => ({
        id,
        name: id,
        colorName: 'blue',
      })),
    },
  });

  // Tags must exist in getTags() for the tag-validation path to pass.
  // _cacheLoadedAt keeps the in-memory cache from being treated as stale
  // (which would otherwise clear _tags and try to hit the real DB).
  const seedTags = () => {
    (mockDb as any)._tags = [
      { tag_id: 'tag1', name: 'Important' },
      { tag_id: 'tag2', name: 'Recurring' },
    ];
    (mockDb as any)._cacheLoadedAt = Date.now();
  };

  test('create_transaction with tag_ids dispatches tagIds', async () => {
    seedTags();
    const client = createMockGraphQLClient({ CreateTransaction: echoCreate });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.createTransaction({ ...validArgs, tag_ids: ['tag1', 'tag2'] });

    expect((client._calls[0].variables as any).input.tagIds).toEqual(['tag1', 'tag2']);
    expect(result.transaction.tag_ids).toEqual(['tag1', 'tag2']);
  });

  test('create_transaction with note dispatches userNotes', async () => {
    const client = createMockGraphQLClient({ CreateTransaction: echoCreate });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.createTransaction({ ...validArgs, note: 'reimbursable' });

    expect((client._calls[0].variables as any).input.userNotes).toBe('reimbursable');
    expect(result.transaction.user_note).toBe('reimbursable');
  });

  test('create_transaction with tag_ids:[] sends empty tagIds and skips existence check', async () => {
    // No seedTags(): an empty array must skip the getTags() existence lookup
    // entirely (the length > 0 guard), so this passes without any seeded tags.
    const client = createMockGraphQLClient({ CreateTransaction: echoCreate });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.createTransaction({ ...validArgs, tag_ids: [] });

    expect((client._calls[0].variables as any).input.tagIds).toEqual([]);
    expect(result.transaction.tag_ids).toEqual([]);
  });

  test('create_transaction with recurring_id dispatches recurringId', async () => {
    const client = createMockGraphQLClient({ CreateTransaction: echoCreate });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.createTransaction({ ...validArgs, recurring_id: 'rec1' });

    expect((client._calls[0].variables as any).input.recurringId).toBe('rec1');
    expect(result.transaction.recurring_id).toBe('rec1');
  });

  test('create_transaction rejects unknown tag_id', async () => {
    seedTags();
    const client = createMockGraphQLClient({ CreateTransaction: echoCreate });
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.createTransaction({ ...validArgs, tag_ids: ['tag1', 'ghost_tag'] })
    ).rejects.toThrow(/Tag not found.*ghost_tag/i);
    expect(client._calls).toHaveLength(0);
  });

  test('response routing ids feed the live meta index', async () => {
    const client = createMockGraphQLClient({ CreateTransaction: { createTransaction: createdTx } });
    const indexTransactionMeta = mock();
    tools = new CopilotMoneyTools(mockDb, client, {
      indexTransactionMeta,
    } as unknown as LiveCopilotDatabase);

    await tools.createTransaction(validArgs);

    expect(indexTransactionMeta).toHaveBeenCalledTimes(1);
    expect(indexTransactionMeta).toHaveBeenCalledWith('new-tx-1', {
      accountId: 'acc1',
      itemId: 'item1',
    });
  });

  test('drifted response with empty routing ids is not fed to the index (#518)', async () => {
    // Mutation responses are validated WARN-ONLY (response-validation.ts never
    // strips), so a drifted CreateTransaction response reaches this feed
    // as-is. Same guard as the split_transaction feed.
    const client = createMockGraphQLClient({
      CreateTransaction: { createTransaction: { ...createdTx, accountId: '' } },
    });
    const indexTransactionMeta = mock();
    tools = new CopilotMoneyTools(mockDb, client, {
      indexTransactionMeta,
    } as unknown as LiveCopilotDatabase);

    await tools.createTransaction(validArgs);

    expect(indexTransactionMeta).not.toHaveBeenCalled();
  });

  test('drifted response with empty itemId is not fed to the index (#518)', async () => {
    // Symmetric case: the guard must check both routing ids.
    const client = createMockGraphQLClient({
      CreateTransaction: { createTransaction: { ...createdTx, itemId: '' } },
    });
    const indexTransactionMeta = mock();
    tools = new CopilotMoneyTools(mockDb, client, {
      indexTransactionMeta,
    } as unknown as LiveCopilotDatabase);

    await tools.createTransaction(validArgs);

    expect(indexTransactionMeta).not.toHaveBeenCalled();
  });
});

describe('deleteTransaction', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;

  const validArgs = {
    transaction_id: 'tx1',
    account_id: 'acc1',
    item_id: 'item1',
  };

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._transactions = [
      {
        transaction_id: 'tx1',
        amount: 12.5,
        date: '2026-04-21',
        name: 'Coffee',
        account_id: 'acc1',
        item_id: 'item1',
        category_id: 'cat1',
      },
      {
        transaction_id: 'tx2',
        amount: 20,
        date: '2026-04-20',
        name: 'Lunch',
        account_id: 'acc1',
        item_id: 'item1',
        category_id: 'cat1',
      },
    ];
    (mockDb as any)._allCollectionsLoaded = true;
  });

  test('dispatches DeleteTransaction with all three IDs and returns success', async () => {
    const client = createMockGraphQLClient({ DeleteTransaction: { deleteTransaction: true } });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.deleteTransaction(validArgs);

    expect(result.success).toBe(true);
    expect(result.transaction_id).toBe('tx1');
    expect(result.deleted).toBe(true);

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('DeleteTransaction');
    expect(client._calls[0].variables).toEqual({
      id: 'tx1',
      accountId: 'acc1',
      itemId: 'item1',
    });
  });

  test('mirrors the server Boolean in `deleted` (false stays false)', async () => {
    // Defensive: Copilot normally returns true on success. If it ever returns
    // false (no error, no delete), the tool should surface that honestly rather
    // than coerce to true and hide the drift.
    const client = createMockGraphQLClient({ DeleteTransaction: { deleteTransaction: false } });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.deleteTransaction(validArgs);
    expect(result.deleted).toBe(false);
    // success still reflects "no error thrown"; deleted reports the server's
    // actual boolean.
    expect(result.success).toBe(true);
  });

  test('evicts the transaction from the in-memory cache on success', async () => {
    const client = createMockGraphQLClient({ DeleteTransaction: { deleteTransaction: true } });
    tools = new CopilotMoneyTools(mockDb, client);

    await tools.deleteTransaction(validArgs);

    const remaining = (mockDb as any)._transactions as Array<{ transaction_id: string }>;
    expect(remaining.map((t) => t.transaction_id)).toEqual(['tx2']);
  });

  test('does NOT evict the cache when the server returns false (deleted=false)', async () => {
    // If the server says "I did not delete", we should not silently remove the
    // row from the local cache — that would desync from reality.
    const client = createMockGraphQLClient({ DeleteTransaction: { deleteTransaction: false } });
    tools = new CopilotMoneyTools(mockDb, client);

    await tools.deleteTransaction(validArgs);

    const remaining = (mockDb as any)._transactions as Array<{ transaction_id: string }>;
    expect(remaining.map((t) => t.transaction_id).sort()).toEqual(['tx1', 'tx2']);
  });

  test('rejects invalid transaction_id format before dispatch', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.deleteTransaction({ ...validArgs, transaction_id: 'bad id!' })
    ).rejects.toThrow(/Invalid transaction_id/);
    expect(client._calls).toHaveLength(0);
  });

  test('rejects invalid account_id format before dispatch', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.deleteTransaction({ ...validArgs, account_id: 'bad/account' })
    ).rejects.toThrow(/Invalid account_id/);
    expect(client._calls).toHaveLength(0);
  });

  test('rejects invalid item_id format before dispatch', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.deleteTransaction({ ...validArgs, item_id: 'bad.item' })).rejects.toThrow(
      /Invalid item_id/
    );
    expect(client._calls).toHaveLength(0);
  });

  test('does NOT look up account_id/item_id from the cache via transaction_id', async () => {
    // The destructive-tool contract requires all three IDs. If we looked up
    // account_id/item_id from the cached tx1, we'd quietly "fix" a typo in
    // account_id and delete a different transaction. Assert we forward the
    // caller's account_id/item_id verbatim even when they would disagree with
    // the cache.
    const client = createMockGraphQLClient({ DeleteTransaction: { deleteTransaction: true } });
    tools = new CopilotMoneyTools(mockDb, client);

    await tools.deleteTransaction({
      transaction_id: 'tx1',
      account_id: 'wrong_account',
      item_id: 'wrong_item',
    });

    expect(client._calls[0].variables).toEqual({
      id: 'tx1',
      accountId: 'wrong_account',
      itemId: 'wrong_item',
    });
  });

  test('wraps GraphQL errors with graphQLErrorToMcpError', async () => {
    const { GraphQLError } = await import('../../src/core/graphql/client.js');
    const client = createMockGraphQLClient({
      DeleteTransaction: new GraphQLError(
        'USER_ACTION_REQUIRED',
        'Transaction not found',
        'DeleteTransaction',
        200
      ),
    });
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.deleteTransaction(validArgs)).rejects.toThrow(/Transaction not found/);

    // On error, the cache is untouched.
    const remaining = (mockDb as any)._transactions as Array<{ transaction_id: string }>;
    expect(remaining.map((t) => t.transaction_id).sort()).toEqual(['tx1', 'tx2']);
  });

  test('eviction is a no-op if the id is absent from the cache (does not throw)', async () => {
    const client = createMockGraphQLClient({ DeleteTransaction: { deleteTransaction: true } });
    tools = new CopilotMoneyTools(mockDb, client);

    // Caller passes a real server id, but the local cache doesn't have it —
    // e.g. the cache was loaded before the tx was created elsewhere.
    const result = await tools.deleteTransaction({
      transaction_id: 'tx_not_in_cache',
      account_id: 'acc1',
      item_id: 'item1',
    });

    expect(result.deleted).toBe(true);
    // Existing rows unchanged.
    const remaining = (mockDb as any)._transactions as Array<{ transaction_id: string }>;
    expect(remaining.map((t) => t.transaction_id).sort()).toEqual(['tx1', 'tx2']);
  });
});

describe('addTransactionToRecurring', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;

  // Server response shape: { addTransactionToRecurring: { transaction: {...} } }.
  // recurringId is populated because linking the tx succeeded.
  const linkedTx: CreatedTransaction = {
    id: 'tx1',
    name: 'Rent',
    date: '2026-04-01',
    amount: 2500,
    categoryId: 'cat-rent',
    type: 'REGULAR',
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

  const validArgs = {
    transaction_id: 'tx1',
    account_id: 'acc1',
    item_id: 'item1',
    recurring_id: 'rec1',
  };

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._transactions = [
      {
        transaction_id: 'tx1',
        amount: 2500,
        date: '2026-04-01',
        name: 'Rent',
        account_id: 'acc1',
        item_id: 'item1',
        category_id: 'cat-rent',
        recurring_id: undefined,
      },
      {
        transaction_id: 'tx2',
        amount: 10,
        date: '2026-04-02',
        name: 'Coffee',
        account_id: 'acc1',
        item_id: 'item1',
        category_id: 'cat-food',
      },
    ];
    (mockDb as any)._allCollectionsLoaded = true;
  });

  test('links a transaction absent from the local cache — ids forwarded verbatim, no lookup', async () => {
    // Cache-bypass contract for the recurring seed: the caller-supplied
    // triple is all the mutation needs, so out-of-window transactions work.
    // Poison the cache accessor to prove no lookup happens.
    (mockDb as any)._transactions = [];
    (mockDb as any).getAllTransactions = async () => {
      throw new Error('local cache must not be consulted');
    };
    const client = createMockGraphQLClient({
      AddTransactionToRecurring: { addTransactionToRecurring: { transaction: linkedTx } },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.addTransactionToRecurring(validArgs);
    expect(result.success).toBe(true);
    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].variables).toEqual({
      id: 'tx1',
      accountId: 'acc1',
      itemId: 'item1',
      input: { recurringId: 'rec1' },
    });
  });

  test('dispatches AddTransactionToRecurring with mapped input and returns the linked transaction', async () => {
    const client = createMockGraphQLClient({
      AddTransactionToRecurring: { addTransactionToRecurring: { transaction: linkedTx } },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.addTransactionToRecurring(validArgs);

    expect(result.success).toBe(true);
    expect(result.transaction_id).toBe('tx1');
    expect(result.transaction.transaction_id).toBe('tx1');
    expect(result.transaction.recurring_id).toBe('rec1');
    expect(result.transaction.name).toBe('Rent');
    expect(result.transaction.internal_transfer).toBe(false);

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('AddTransactionToRecurring');
    expect(client._calls[0].variables).toEqual({
      id: 'tx1',
      accountId: 'acc1',
      itemId: 'item1',
      input: { recurringId: 'rec1' },
    });
  });

  test('patches recurring_id on the cached transaction row on success', async () => {
    const client = createMockGraphQLClient({
      AddTransactionToRecurring: { addTransactionToRecurring: { transaction: linkedTx } },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    await tools.addTransactionToRecurring(validArgs);

    const cached = (
      (mockDb as any)._transactions as Array<{
        transaction_id: string;
        recurring_id?: string;
      }>
    ).find((t) => t.transaction_id === 'tx1');
    expect(cached?.recurring_id).toBe('rec1');
  });

  test('does NOT look up account_id/item_id from the cache via transaction_id', async () => {
    // Same defensive contract as delete_transaction — a typo in account_id
    // or item_id must not be silently "fixed" from the cache; forward
    // verbatim so the server rejects the wrong-tuple rather than linking
    // a different transaction.
    const client = createMockGraphQLClient({
      AddTransactionToRecurring: { addTransactionToRecurring: { transaction: linkedTx } },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    await tools.addTransactionToRecurring({
      transaction_id: 'tx1',
      account_id: 'wrong_account',
      item_id: 'wrong_item',
      recurring_id: 'rec1',
    });

    expect(client._calls[0].variables).toEqual({
      id: 'tx1',
      accountId: 'wrong_account',
      itemId: 'wrong_item',
      input: { recurringId: 'rec1' },
    });
  });

  test('rejects invalid transaction_id format before dispatch', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.addTransactionToRecurring({ ...validArgs, transaction_id: 'bad id!' })
    ).rejects.toThrow(/Invalid transaction_id/);
    expect(client._calls).toHaveLength(0);
  });

  test('rejects invalid account_id format before dispatch', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.addTransactionToRecurring({ ...validArgs, account_id: 'bad/account' })
    ).rejects.toThrow(/Invalid account_id/);
    expect(client._calls).toHaveLength(0);
  });

  test('rejects invalid item_id format before dispatch', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.addTransactionToRecurring({ ...validArgs, item_id: 'bad.item' })
    ).rejects.toThrow(/Invalid item_id/);
    expect(client._calls).toHaveLength(0);
  });

  test('rejects invalid recurring_id format before dispatch', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.addTransactionToRecurring({ ...validArgs, recurring_id: 'bad.recurring' })
    ).rejects.toThrow(/Invalid recurring_id/);
    expect(client._calls).toHaveLength(0);
  });

  test('wraps GraphQL errors with graphQLErrorToMcpError and does not patch the cache', async () => {
    const { GraphQLError } = await import('../../src/core/graphql/client.js');
    const client = createMockGraphQLClient({
      AddTransactionToRecurring: new GraphQLError(
        'USER_ACTION_REQUIRED',
        'Transaction not found',
        'AddTransactionToRecurring',
        200
      ),
    });
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.addTransactionToRecurring(validArgs)).rejects.toThrow(
      /Transaction not found/
    );

    // On error, the cache row is untouched.
    const cached = (
      (mockDb as any)._transactions as Array<{
        transaction_id: string;
        recurring_id?: string;
      }>
    ).find((t) => t.transaction_id === 'tx1');
    expect(cached?.recurring_id).toBeUndefined();
  });

  test('flips internal_transfer to true if the linked transaction is an INTERNAL_TRANSFER', async () => {
    // Mirrors the createTransaction load-bearing mapping — the response's
    // `type` field drives local `internal_transfer`, independent of what
    // the cache had before.
    const serverTx: CreatedTransaction = { ...linkedTx, type: 'INTERNAL_TRANSFER' };
    const client = createMockGraphQLClient({
      AddTransactionToRecurring: { addTransactionToRecurring: { transaction: serverTx } },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.addTransactionToRecurring(validArgs);
    expect(result.transaction.internal_transfer).toBe(true);
  });
});

describe('splitTransaction', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;

  // Parent: $600 "Hotel + Car + Meals" charge on 2026-04-15.
  // Mirrors what the local cache would hold after decoder read.
  const parentCacheRow = {
    transaction_id: 'parent-1',
    amount: 600,
    date: '2026-04-15',
    name: 'Hotel + Car + Meals',
    account_id: 'acc1',
    item_id: 'item1',
    category_id: 'cat-travel',
  };

  // Server response rows (TransactionFields shape, same as createTransaction).
  const parentServer = {
    id: 'parent-1',
    name: 'Hotel + Car + Meals',
    date: '2026-04-15',
    amount: 600,
    categoryId: '', // blanked by server after split
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
  const childHotel = {
    ...parentServer,
    id: 'child-hotel',
    name: 'Hotel',
    amount: 400,
    categoryId: 'cat-lodging',
  };
  const childCar = {
    ...parentServer,
    id: 'child-car',
    name: 'Car',
    amount: 200,
    categoryId: 'cat-car-rental',
  };

  const validArgs = {
    transaction_id: 'parent-1',
    account_id: 'acc1',
    item_id: 'item1',
    splits: [
      { name: 'Hotel', date: '2026-04-15', amount: 400, category_id: 'cat-lodging' },
      { name: 'Car', date: '2026-04-15', amount: 200, category_id: 'cat-car-rental' },
    ],
  };

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._transactions = [
      { ...parentCacheRow },
      {
        transaction_id: 'tx-other',
        amount: 10,
        date: '2026-04-16',
        name: 'Coffee',
        account_id: 'acc1',
        item_id: 'item1',
        category_id: 'cat-food',
      },
    ];
    (mockDb as any)._allCollectionsLoaded = true;
  });

  test('dispatches SplitTransaction with mapped input array and returns parent + children', async () => {
    const client = createMockGraphQLClient({
      SplitTransaction: {
        splitTransaction: {
          parentTransaction: parentServer,
          splitTransactions: [childHotel, childCar],
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.splitTransaction(validArgs);

    expect(result.success).toBe(true);
    expect(result.parent_transaction_id).toBe('parent-1');
    expect(result.child_transaction_ids).toEqual(['child-hotel', 'child-car']);
    expect(result.parent.transaction_id).toBe('parent-1');
    expect(result.parent.category_id).toBe(''); // mirrors server's post-split blank
    expect(result.children).toHaveLength(2);
    expect(result.children[0].transaction_id).toBe('child-hotel');
    expect(result.children[0].amount).toBe(400);
    expect(result.children[0].category_id).toBe('cat-lodging');
    expect(result.children[1].transaction_id).toBe('child-car');
    expect(result.children[1].amount).toBe(200);
    expect(result.children[1].category_id).toBe('cat-car-rental');

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('SplitTransaction');
    expect(client._calls[0].variables).toEqual({
      id: 'parent-1',
      accountId: 'acc1',
      itemId: 'item1',
      input: [
        { name: 'Hotel', date: '2026-04-15', amount: 400, categoryId: 'cat-lodging' },
        { name: 'Car', date: '2026-04-15', amount: 200, categoryId: 'cat-car-rental' },
      ],
    });
  });

  test('evicts the parent transaction from the in-memory cache on success', async () => {
    // The parent is hidden from Copilot's UI after a split — cached reads
    // should stop surfacing it. (Children are NOT inserted here; the next
    // refresh_database picks them up.)
    const client = createMockGraphQLClient({
      SplitTransaction: {
        splitTransaction: {
          parentTransaction: parentServer,
          splitTransactions: [childHotel, childCar],
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    await tools.splitTransaction(validArgs);

    const remaining = (mockDb as any)._transactions as Array<{ transaction_id: string }>;
    expect(remaining.map((t) => t.transaction_id)).toEqual(['tx-other']);
  });

  test('defaults missing name/date on a split entry to the parent values', async () => {
    const client = createMockGraphQLClient({
      SplitTransaction: {
        splitTransaction: {
          parentTransaction: parentServer,
          splitTransactions: [childHotel, childCar],
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    await tools.splitTransaction({
      transaction_id: 'parent-1',
      account_id: 'acc1',
      item_id: 'item1',
      splits: [
        // name omitted → parent name. date omitted → parent date.
        { amount: 400, category_id: 'cat-lodging' },
        // explicit name/date — not overridden.
        { name: 'Car', date: '2026-04-16', amount: 200, category_id: 'cat-car-rental' },
      ],
    });

    const sentInput = (client._calls[0].variables as { input: SplitTransactionInputShape[] }).input;
    expect(sentInput[0]).toEqual({
      name: 'Hotel + Car + Meals',
      date: '2026-04-15',
      amount: 400,
      categoryId: 'cat-lodging',
    });
    expect(sentInput[1]).toEqual({
      name: 'Car',
      date: '2026-04-16',
      amount: 200,
      categoryId: 'cat-car-rental',
    });
  });

  test('supports a 3-way split happy path', async () => {
    const childMeals = {
      ...parentServer,
      id: 'child-meals',
      name: 'Meals',
      amount: 100,
      categoryId: 'cat-food',
    };
    const childHotel2 = { ...childHotel, amount: 300 };
    const childCar2 = { ...childCar, amount: 200 };
    const client = createMockGraphQLClient({
      SplitTransaction: {
        splitTransaction: {
          parentTransaction: parentServer,
          splitTransactions: [childHotel2, childCar2, childMeals],
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.splitTransaction({
      transaction_id: 'parent-1',
      account_id: 'acc1',
      item_id: 'item1',
      splits: [
        { name: 'Hotel', date: '2026-04-15', amount: 300, category_id: 'cat-lodging' },
        { name: 'Car', date: '2026-04-15', amount: 200, category_id: 'cat-car-rental' },
        { name: 'Meals', date: '2026-04-15', amount: 100, category_id: 'cat-food' },
      ],
    });

    expect(result.children).toHaveLength(3);
    expect(result.child_transaction_ids).toEqual(['child-hotel', 'child-car', 'child-meals']);
    expect(
      (client._calls[0].variables as { input: SplitTransactionInputShape[] }).input
    ).toHaveLength(3);
  });

  test('rejects splits.length < 2 (zero or one)', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.splitTransaction({ ...validArgs, splits: [] })).rejects.toThrow(
      /at least 2|minimum.*2|splits.*2/i
    );
    await expect(
      tools.splitTransaction({
        ...validArgs,
        splits: [{ name: 'Hotel', date: '2026-04-15', amount: 600, category_id: 'cat-lodging' }],
      })
    ).rejects.toThrow(/at least 2|minimum.*2|splits.*2/i);
    expect(client._calls).toHaveLength(0);
  });

  test('rejects sum mismatch with parent amount and names parent amount, sum, and diff', async () => {
    // Parent is 600; splits sum to 500 → diff 100. Must surface those numbers.
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.splitTransaction({
        ...validArgs,
        splits: [
          { name: 'Hotel', date: '2026-04-15', amount: 300, category_id: 'cat-lodging' },
          { name: 'Car', date: '2026-04-15', amount: 200, category_id: 'cat-car-rental' },
        ],
      })
    ).rejects.toThrow(/600.*500.*100|parent.*600/);
    expect(client._calls).toHaveLength(0);
  });

  test('accepts sum within a tiny floating-point epsilon', async () => {
    // 0.1 + 0.2 = 0.30000000000000004 in IEEE 754; this should NOT trip the sum check.
    (mockDb as any)._transactions[0].amount = 0.3;
    const client = createMockGraphQLClient({
      SplitTransaction: {
        splitTransaction: {
          parentTransaction: { ...parentServer, amount: 0.3 },
          splitTransactions: [
            { ...childHotel, amount: 0.1 },
            { ...childCar, amount: 0.2 },
          ],
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.splitTransaction({
        ...validArgs,
        splits: [
          { name: 'Hotel', date: '2026-04-15', amount: 0.1, category_id: 'cat-lodging' },
          { name: 'Car', date: '2026-04-15', amount: 0.2, category_id: 'cat-car-rental' },
        ],
      })
    ).resolves.toMatchObject({ success: true });
  });

  test('rejects when the parent is unresolvable and a split needs a parent-derived default', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.splitTransaction({
        ...validArgs,
        transaction_id: 'nonexistent-tx',
        splits: [
          { amount: 400, category_id: 'cat-lodging' },
          { name: 'Car', date: '2026-04-15', amount: 200, category_id: 'cat-car-rental' },
        ],
      })
    ).rejects.toThrow(/Transaction not found.*explicit name and date on every split/);
    expect(client._calls).toHaveLength(0);
  });

  test('unresolvable parent + explicit name/date on every split: dispatches, sum check deferred to server', async () => {
    // Cache-bypass path: the parent is outside the resolution window, but no
    // parent-derived defaults are needed and the amount-sum validation is the
    // server's job — the mutation goes out with the caller-supplied triple.
    // The split amounts deliberately do NOT sum to any locally-known parent.
    const client = createMockGraphQLClient({
      SplitTransaction: {
        splitTransaction: {
          parentTransaction: { ...parentServer, id: 'nonexistent-tx' },
          splitTransactions: [childHotel, childCar],
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.splitTransaction({
      ...validArgs,
      transaction_id: 'nonexistent-tx',
      splits: [
        { name: 'Hotel', date: '2026-04-15', amount: 123, category_id: 'cat-lodging' },
        { name: 'Car', date: '2026-04-16', amount: 456, category_id: 'cat-car-rental' },
      ],
    });

    expect(result.success).toBe(true);
    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('SplitTransaction');
    expect(client._calls[0].variables).toMatchObject({
      id: 'nonexistent-tx',
      accountId: 'acc1',
      itemId: 'item1',
      input: [
        { name: 'Hotel', date: '2026-04-15', amount: 123, categoryId: 'cat-lodging' },
        { name: 'Car', date: '2026-04-16', amount: 456, categoryId: 'cat-car-rental' },
      ],
    });
  });

  test('rejects invalid transaction_id format before any cache lookup', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.splitTransaction({ ...validArgs, transaction_id: 'bad id!' })
    ).rejects.toThrow(/Invalid transaction_id/);
    expect(client._calls).toHaveLength(0);
  });

  test('rejects invalid account_id format', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.splitTransaction({ ...validArgs, account_id: 'bad/account' })
    ).rejects.toThrow(/Invalid account_id/);
    expect(client._calls).toHaveLength(0);
  });

  test('rejects invalid item_id format', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.splitTransaction({ ...validArgs, item_id: 'bad.item' })).rejects.toThrow(
      /Invalid item_id/
    );
    expect(client._calls).toHaveLength(0);
  });

  test('rejects invalid category_id on a split entry', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.splitTransaction({
        ...validArgs,
        splits: [
          { name: 'Hotel', date: '2026-04-15', amount: 400, category_id: 'bad id!' },
          { name: 'Car', date: '2026-04-15', amount: 200, category_id: 'cat-car-rental' },
        ],
      })
    ).rejects.toThrow(/Invalid category_id/);
    expect(client._calls).toHaveLength(0);
  });

  test('rejects non-finite amount on a split entry (NaN, Infinity)', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.splitTransaction({
        ...validArgs,
        splits: [
          { name: 'Hotel', date: '2026-04-15', amount: Number.NaN, category_id: 'cat-lodging' },
          { name: 'Car', date: '2026-04-15', amount: 200, category_id: 'cat-car-rental' },
        ],
      })
    ).rejects.toThrow(/amount.*finite/i);

    await expect(
      tools.splitTransaction({
        ...validArgs,
        splits: [
          {
            name: 'Hotel',
            date: '2026-04-15',
            amount: Number.POSITIVE_INFINITY,
            category_id: 'cat-lodging',
          },
          { name: 'Car', date: '2026-04-15', amount: 200, category_id: 'cat-car-rental' },
        ],
      })
    ).rejects.toThrow(/amount.*finite/i);
    expect(client._calls).toHaveLength(0);
  });

  test('rejects amount exceeding MAX_VALID_AMOUNT (both signs)', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.splitTransaction({
        ...validArgs,
        splits: [
          { name: 'Hotel', date: '2026-04-15', amount: 10_000_001, category_id: 'cat-lodging' },
          { name: 'Car', date: '2026-04-15', amount: 1, category_id: 'cat-car-rental' },
        ],
      })
    ).rejects.toThrow(/amount exceeds maximum/i);

    await expect(
      tools.splitTransaction({
        ...validArgs,
        splits: [
          { name: 'Hotel', date: '2026-04-15', amount: -10_000_001, category_id: 'cat-lodging' },
          { name: 'Car', date: '2026-04-15', amount: 1, category_id: 'cat-car-rental' },
        ],
      })
    ).rejects.toThrow(/amount exceeds maximum/i);
    expect(client._calls).toHaveLength(0);
  });

  test('rejects malformed date on a split entry', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.splitTransaction({
        ...validArgs,
        splits: [
          { name: 'Hotel', date: '2026-4-15', amount: 400, category_id: 'cat-lodging' },
          { name: 'Car', date: '2026-04-15', amount: 200, category_id: 'cat-car-rental' },
        ],
      })
    ).rejects.toThrow(/date.*YYYY-MM-DD/i);
    expect(client._calls).toHaveLength(0);
  });

  test('rejects empty name on a split entry after trim', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.splitTransaction({
        ...validArgs,
        splits: [
          { name: '   ', date: '2026-04-15', amount: 400, category_id: 'cat-lodging' },
          { name: 'Car', date: '2026-04-15', amount: 200, category_id: 'cat-car-rental' },
        ],
      })
    ).rejects.toThrow(/name.*empty/i);
    expect(client._calls).toHaveLength(0);
  });

  test('wraps GraphQL errors and does NOT evict the cache on error', async () => {
    const { GraphQLError } = await import('../../src/core/graphql/client.js');
    const client = createMockGraphQLClient({
      SplitTransaction: new GraphQLError(
        'USER_ACTION_REQUIRED',
        'Split amounts do not match parent',
        'SplitTransaction',
        200
      ),
    });
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.splitTransaction(validArgs)).rejects.toThrow(/Split amounts/);

    // Parent still in cache — local state tracks whatever the server thinks is real.
    const remaining = (mockDb as any)._transactions as Array<{ transaction_id: string }>;
    expect(remaining.map((t) => t.transaction_id).sort()).toEqual(['parent-1', 'tx-other']);
  });

  test('does NOT look up account_id/item_id from the cache via transaction_id', async () => {
    // Same destructive-safe contract as delete_transaction / add_transaction_to_recurring —
    // a typo in account_id/item_id must not be silently fixed from the cache.
    const client = createMockGraphQLClient({
      SplitTransaction: {
        splitTransaction: {
          parentTransaction: parentServer,
          splitTransactions: [childHotel, childCar],
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    await tools.splitTransaction({
      ...validArgs,
      account_id: 'wrong_account',
      item_id: 'wrong_item',
    });

    expect(client._calls[0].variables).toMatchObject({
      id: 'parent-1',
      accountId: 'wrong_account',
      itemId: 'wrong_item',
    });
  });
});

// Local narrow shape to help tests assert the outbound variables structure.
interface SplitTransactionInputShape {
  name: string;
  date: string;
  amount: number;
  categoryId: string;
}
