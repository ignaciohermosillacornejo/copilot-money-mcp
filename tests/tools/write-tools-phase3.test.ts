/**
 * Tests for updateTag and createRecurring (GraphQL-migrated).
 *
 * Goal-tool tests removed; goal tools no longer exist.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { RECURRING_FREQUENCIES } from '../../src/core/graphql/recurrings.js';
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
      EditTag: { editTag: { id: 'vacation', name: 'Trip', colorName: 'GREEN1' } },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.updateTag({
      tag_id: 'vacation',
      name: 'Trip',
      color_name: 'GREEN1',
    });
    expect(result.success).toBe(true);
    expect(result.updated).toEqual(['name', 'colorName']);
    expect(client._calls[0].variables).toEqual({
      id: 'vacation',
      input: { name: 'Trip', colorName: 'GREEN1' },
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

  test('rejects a color_name outside the ColorName enum (no dispatch)', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(tools.updateTag({ tag_id: 'vacation', color_name: 'BLUE2' })).rejects.toThrow(
      /color_name must be one of/
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
    ).rejects.toThrow('frequency must be one of:');
    expect(client._calls).toHaveLength(0);
  });

  test('rejects YEARLY locally (regression: not a valid RecurringFrequency)', async () => {
    // YEARLY is NOT a server-valid RecurringFrequency value (issue #419). It must
    // be rejected LOCALLY — never forwarded to fail at the server with SCHEMA_ERROR.
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.createRecurring({ transaction_id: 'txn-abc', frequency: 'YEARLY' })
    ).rejects.toThrow('frequency must be one of:');
    expect(client._calls).toHaveLength(0);
  });

  test('accepts ANNUALLY (previously wrongly rejected)', async () => {
    const client = createMockGraphQLClient({
      CreateRecurring: {
        createRecurring: {
          id: 'rec-annual',
          name: 'Netflix',
          state: 'ACTIVE',
          frequency: 'ANNUALLY',
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.createRecurring({
      transaction_id: 'txn-abc',
      frequency: 'ANNUALLY',
    });

    expect(result.frequency).toBe('ANNUALLY');
    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('CreateRecurring');
    expect((client._calls[0].variables as any).input.frequency).toBe('ANNUALLY');
  });

  test('throws when transaction is not found in local cache', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.createRecurring({ transaction_id: 'txn-missing', frequency: 'MONTHLY' })
    ).rejects.toThrow('Transaction not found: txn-missing');
    expect(client._calls).toHaveLength(0);
  });

  test('locally-incomplete transaction is unresolved (no live fallback here) and throws not-found', async () => {
    // txn-orphan lacks account_id/item_id and there is no liveDb, so
    // resolution finds nothing — the old "missing account_id or item_id"
    // message is retired in favor of the resolver's not-found contract.
    (mockDb as any)._transactions = [
      { transaction_id: 'txn-orphan', amount: 10, date: '2024-01-01', name: 'Orphan' },
    ];

    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.createRecurring({ transaction_id: 'txn-orphan', frequency: 'MONTHLY' })
    ).rejects.toThrow('Transaction not found: txn-orphan');
    expect(client._calls).toHaveLength(0);
  });

  test('accepts all 8 valid frequencies including BIMONTHLY/QUARTERLY/etc', async () => {
    // The full server-verified set (issue #419) — includes the 5 values
    // (BIMONTHLY, QUARTERLY, QUADMONTHLY, SEMIANNUALLY, ANNUALLY) that the
    // old WEEKLY/BIWEEKLY/MONTHLY/YEARLY allowlist wrongly rejected.
    // Iterate the source of truth so a 9th value added later is covered automatically.
    for (const freq of RECURRING_FREQUENCIES) {
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

  describe('routing bypass (account_id + item_id)', () => {
    const okClient = () =>
      createMockGraphQLClient({
        CreateRecurring: {
          createRecurring: {
            id: 'rec-out',
            name: 'Old Sub',
            state: 'ACTIVE',
            frequency: 'MONTHLY',
          },
        },
      });

    test('cache miss + both ids: dispatches with the caller-supplied routing ids', async () => {
      // 'txn-out' is nowhere in the local cache — without the bypass this is
      // a guaranteed "Transaction not found". The caller-supplied pair (from
      // a live read) routes the nested transaction ref directly.
      (mockDb as any)._transactions = [];
      const client = okClient();
      tools = new CopilotMoneyTools(mockDb, client);

      const result = await tools.createRecurring({
        transaction_id: 'txn-out',
        account_id: 'acct9',
        item_id: 'item9',
        frequency: 'MONTHLY',
      });

      expect(result.success).toBe(true);
      expect(result.recurring_id).toBe('rec-out');
      expect(client._calls).toHaveLength(1);
      expect(client._calls[0].variables).toEqual({
        input: {
          frequency: 'MONTHLY',
          transaction: { accountId: 'acct9', itemId: 'item9', transactionId: 'txn-out' },
        },
      });
    });

    test('caller-supplied ids are forwarded verbatim even when the row is cached', async () => {
      // Same "no re-resolution of a caller-supplied triple" contract as
      // update_transaction: explicit ids win over the cached acc-1/item-1.
      const client = okClient();
      tools = new CopilotMoneyTools(mockDb, client);

      await tools.createRecurring({
        transaction_id: 'txn-abc',
        account_id: 'acct9',
        item_id: 'item9',
        frequency: 'MONTHLY',
      });

      expect((client._calls[0].variables as any).input.transaction).toEqual({
        accountId: 'acct9',
        itemId: 'item9',
        transactionId: 'txn-abc',
      });
    });

    test('cache miss without ids: not-found error points at the bypass', async () => {
      const client = createMockGraphQLClient({});
      tools = new CopilotMoneyTools(mockDb, client);

      await expect(
        tools.createRecurring({ transaction_id: 'txn-missing', frequency: 'MONTHLY' })
      ).rejects.toThrow(/Transaction not found.*pass account_id and item_id/i);
      expect(client._calls).toHaveLength(0);
    });

    test('half a pair throws, no write', async () => {
      const client = createMockGraphQLClient({});
      tools = new CopilotMoneyTools(mockDb, client);

      await expect(
        tools.createRecurring({
          transaction_id: 'txn-abc',
          account_id: 'acct9',
          frequency: 'MONTHLY',
        })
      ).rejects.toThrow(/account_id and item_id must be passed together/i);
      await expect(
        tools.createRecurring({
          transaction_id: 'txn-abc',
          item_id: 'item9',
          frequency: 'MONTHLY',
        })
      ).rejects.toThrow(/account_id and item_id must be passed together/i);
      expect(client._calls).toHaveLength(0);
    });

    test('malformed bypass ids throw, no write', async () => {
      const client = createMockGraphQLClient({});
      tools = new CopilotMoneyTools(mockDb, client);

      await expect(
        tools.createRecurring({
          transaction_id: 'txn-abc',
          account_id: 'bad/acct',
          item_id: 'item9',
          frequency: 'MONTHLY',
        })
      ).rejects.toThrow(/Invalid account_id/i);
      await expect(
        tools.createRecurring({
          transaction_id: 'txn-abc',
          account_id: 'acct9',
          item_id: 'bad/item',
          frequency: 'MONTHLY',
        })
      ).rejects.toThrow(/Invalid item_id/i);
      expect(client._calls).toHaveLength(0);
    });

    test('malformed transaction_id throws before resolution or write', async () => {
      // The triple is forwarded verbatim on the bypass path, so all three ids
      // get the same doc-id shape gate update_transaction applies.
      const client = createMockGraphQLClient({});
      tools = new CopilotMoneyTools(mockDb, client);

      await expect(
        tools.createRecurring({
          transaction_id: 'bad/txn',
          account_id: 'acct9',
          item_id: 'item9',
          frequency: 'MONTHLY',
        })
      ).rejects.toThrow(/Invalid transaction_id/i);
      expect(client._calls).toHaveLength(0);
    });
  });
});
