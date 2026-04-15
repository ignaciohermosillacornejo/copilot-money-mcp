/**
 * Tests for updateTag and createRecurring (GraphQL-migrated).
 *
 * Goal-tool tests removed; goal tools no longer exist.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';

describe('updateTag', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._allCollectionsLoaded = true;
    (mockDb as any)._cacheLoadedAt = Date.now();
    (mockDb as any)._tags = [
      { tag_id: 'vacation', name: 'Vacation' },
      { tag_id: 'business', name: 'Business' },
    ];
  });

  test('dispatches EditTag with name', async () => {
    const client = createMockGraphQLClient({
      EditTag: { editTag: { id: 'vacation', name: 'Holiday', colorName: 'PURPLE2' } },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.updateTag({ tag_id: 'vacation', name: 'Holiday' });
    expect(result.success).toBe(true);
    expect(result.tag_id).toBe('vacation');
    expect(result.updated).toEqual(['name']);

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('EditTag');
    expect(client._calls[0].variables).toEqual({
      id: 'vacation',
      input: { name: 'Holiday' },
    });
  });

  test('dispatches EditTag with name and colorName', async () => {
    const client = createMockGraphQLClient({
      EditTag: { editTag: { id: 'vacation', name: 'Trip', colorName: 'GREEN' } },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.updateTag({
      tag_id: 'vacation',
      name: 'Trip',
      color_name: 'GREEN',
    });
    expect(result.success).toBe(true);
    expect(result.updated).toEqual(['name', 'colorName']);
    expect(client._calls[0].variables).toEqual({
      id: 'vacation',
      input: { name: 'Trip', colorName: 'GREEN' },
    });
  });

  test('throws when no fields provided', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.updateTag({ tag_id: 'vacation' })).rejects.toThrow(
      'update_tag requires at least one field to update'
    );
    expect(client._calls).toHaveLength(0);
  });
});

describe('createRecurring', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._allCollectionsLoaded = true;
    (mockDb as any)._cacheLoadedAt = Date.now();
    (mockDb as any)._recurring = [];
    (mockDb as any)._transactions = [
      {
        transaction_id: 'txn-abc',
        amount: 15.99,
        date: '2024-06-15',
        name: 'Netflix',
        account_id: 'acc-1',
        item_id: 'item-1',
      },
    ];
  });

  test('dispatches CreateRecurring with transaction/frequency shape', async () => {
    const client = createMockGraphQLClient({
      CreateRecurring: {
        createRecurring: {
          id: 'rec-new',
          name: 'Netflix',
          state: 'ACTIVE',
          frequency: 'MONTHLY',
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.createRecurring({
      transaction_id: 'txn-abc',
      frequency: 'MONTHLY',
    });

    expect(result.success).toBe(true);
    expect(result.recurring_id).toBe('rec-new');
    expect(result.name).toBe('Netflix');
    expect(result.state).toBe('ACTIVE');
    expect(result.frequency).toBe('MONTHLY');

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('CreateRecurring');
    expect(client._calls[0].variables).toEqual({
      input: {
        frequency: 'MONTHLY',
        transaction: {
          accountId: 'acc-1',
          itemId: 'item-1',
          transactionId: 'txn-abc',
        },
      },
    });
  });

  test('throws on invalid frequency', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.createRecurring({ transaction_id: 'txn-abc', frequency: 'daily' })
    ).rejects.toThrow('frequency must be one of: WEEKLY, BIWEEKLY, MONTHLY, YEARLY');
    expect(client._calls).toHaveLength(0);
  });

  test('throws when transaction is not found in local cache', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.createRecurring({ transaction_id: 'txn-missing', frequency: 'MONTHLY' })
    ).rejects.toThrow('Transaction not found: txn-missing');
    expect(client._calls).toHaveLength(0);
  });

  test('throws when transaction is missing account_id or item_id', async () => {
    (mockDb as any)._transactions = [
      { transaction_id: 'txn-orphan', amount: 10, date: '2024-01-01', name: 'Orphan' },
    ];

    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.createRecurring({ transaction_id: 'txn-orphan', frequency: 'MONTHLY' })
    ).rejects.toThrow('missing account_id or item_id');
    expect(client._calls).toHaveLength(0);
  });

  test('accepts all valid frequencies', async () => {
    for (const freq of ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'YEARLY']) {
      const client = createMockGraphQLClient({
        CreateRecurring: {
          createRecurring: { id: `rec-${freq}`, name: 'Netflix', state: 'ACTIVE', frequency: freq },
        },
      });
      tools = new CopilotMoneyTools(mockDb, client);
      const result = await tools.createRecurring({
        transaction_id: 'txn-abc',
        frequency: freq,
      });
      expect(result.frequency).toBe(freq);
    }
  });
});
