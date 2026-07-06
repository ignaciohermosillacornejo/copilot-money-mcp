/**
 * Live-mode reference-data validation (#510). category_id/tag_ids on write
 * paths validate against the live categories/tags caches when liveDb is
 * present — the local LevelDB cache is only the source in degraded mode.
 * Messages are unchanged; only the source moved.
 */

import { describe, test, expect, mock } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import type { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';

function echoEdit(vars: any) {
  return {
    editTransaction: {
      transaction: {
        id: vars.id,
        name: 'n',
        categoryId: vars.input.categoryId ?? 'c1',
        userNotes: null,
        isReviewed: false,
        type: 'REGULAR',
        tags: (vars.input.tagIds ?? []).map((id: string) => ({ id })),
      },
    },
  };
}

function makeDb(overrides?: { categories?: unknown[]; tags?: unknown[]; recurring?: unknown[] }) {
  const db = new CopilotDatabase('/nonexistent');
  (db as any).dbPath = '/fake';
  (db as any)._transactions = [];
  (db as any)._userCategories = overrides?.categories ?? [];
  (db as any)._tags = overrides?.tags ?? [];
  (db as any)._recurring = overrides?.recurring ?? [];
  (db as any)._goals = [];
  // Suppress decoder initialization for test mocks
  (db as any)._allCollectionsPromise = Promise.resolve(null);
  return db;
}

/** Stub liveDb for validation: the snapshot caches execute the fetch closure
 *  directly (`read: (fn) => ...fn()`), so validation flows through the real
 *  fetchCategories/fetchTags against the mock GraphQL client. Transaction
 *  meta is pre-indexed so updateTransaction's routing resolution never
 *  fetches. */
function stubLiveDb(graphqlClient: unknown) {
  const readThrough = {
    read: async (fn: () => Promise<unknown[]>) => ({
      rows: await fn(),
      fetched_at: 0,
      hit: false,
    }),
  };
  return {
    lookupTransactionMeta: (ids: string[]) => {
      const out = new Map<string, { accountId: string; itemId: string }>();
      for (const id of ids) out.set(id, { accountId: 'acct-1', itemId: 'item-1' });
      return out;
    },
    getCategoriesCache: () => readThrough,
    getTagsCache: () => readThrough,
    getRecurringCache: () => ({ peek: () => null }),
    resolveRolloversFlag: async () => false,
    getClient: () => graphqlClient,
    getTransactions: mock(() =>
      Promise.resolve({ rows: [], oldest_fetched_at: 0, newest_fetched_at: 0, hit: false })
    ),
    patchLiveTransaction: () => {},
    patchLiveRecurringUpsert: () => {},
  } as unknown as LiveCopilotDatabase;
}

// Mock response envelopes mirror the exact shapes from tests/tools/live/categories.test.ts
// and tests/tools/live/tags.test.ts
const LIVE_REFS = {
  Categories: {
    categories: [
      {
        id: 'cat-live',
        name: 'Live Category',
        parentId: null,
        templateId: null,
        colorName: 'ORANGE2',
        isExcluded: false,
        isRolloverDisabled: false,
        canBeDeleted: true,
        icon: { __typename: 'EmojiUnicode' as const, unicode: '☕' },
        budget: null,
      },
    ],
  },
  Tags: {
    tags: [{ id: 'tag-live', name: 'live-tag', colorName: 'BLUE1' }],
  },
};

describe('live-mode reference validation (#510)', () => {
  test('category created since last local sync validates (live source wins)', async () => {
    // LevelDB does NOT know cat-live; the live surface does. Old code
    // rejected this with "Category not found".
    const client = createMockGraphQLClient({ EditTransaction: echoEdit as any, ...LIVE_REFS });
    const tools = new CopilotMoneyTools(makeDb({ categories: [] }), client, stubLiveDb(client));

    await tools.updateTransaction({ transaction_id: 't1', category_id: 'cat-live' });
    expect(client._calls.some((c) => c.op === 'EditTransaction')).toBe(true);
  });

  test('stale local-only category is rejected in live mode (LevelDB bypass)', async () => {
    // LevelDB still holds cat-stale; the live surface no longer does.
    const client = createMockGraphQLClient({ ...LIVE_REFS });
    const tools = new CopilotMoneyTools(
      makeDb({ categories: [{ category_id: 'cat-stale', name: 'Stale' }] }),
      client,
      stubLiveDb(client)
    );

    await expect(
      tools.updateTransaction({ transaction_id: 't1', category_id: 'cat-stale' })
    ).rejects.toThrow('Category not found: cat-stale');
    expect(client._calls.some((c) => c.op === 'EditTransaction')).toBe(false);
  });

  test('tags validate against the live surface on update_transaction', async () => {
    const client = createMockGraphQLClient({ EditTransaction: echoEdit as any, ...LIVE_REFS });
    const tools = new CopilotMoneyTools(makeDb(), client, stubLiveDb(client));

    await tools.updateTransaction({ transaction_id: 't1', tag_ids: ['tag-live'] });
    expect(client._calls.some((c) => c.op === 'EditTransaction')).toBe(true);

    await expect(
      tools.updateTransaction({ transaction_id: 't1', tag_ids: ['tag-ghost'] })
    ).rejects.toThrow('Tag not found: tag-ghost');
  });

  test('create_transaction validates tags live; update_recurring validates category live', async () => {
    // create_transaction: live tag unknown to LevelDB is accepted.
    const client = createMockGraphQLClient({
      ...LIVE_REFS,
      CreateTransaction: {
        createTransaction: {
          id: 'tNew',
          accountId: 'acct-1',
          itemId: 'item-1',
          categoryId: 'cat-live',
          recurringId: null,
          isReviewed: true,
          isPending: false,
          amount: 100,
          date: '2026-07-01',
          name: 'Synthetic',
          type: 'REGULAR',
          userNotes: null,
          tipAmount: null,
          suggestedCategoryIds: [],
          createdAt: 1,
          tags: [{ id: 'tag-live', name: 'live-tag', colorName: 'BLUE1' }],
          goal: null,
        },
      },
      EditRecurring: {
        editRecurring: {
          recurring: {
            id: 'rec-1',
            name: 'Monthly Sub',
            categoryId: 'cat-live',
            frequency: 'MONTHLY',
            state: 'ACTIVE',
          },
        },
      },
    });
    const liveDb = stubLiveDb(client);
    (liveDb as any).indexTransactionMeta = () => {};
    const tools = new CopilotMoneyTools(
      makeDb({
        recurring: [
          {
            recurring_id: 'rec-1',
            name: 'Monthly Sub',
            state: 'ACTIVE',
            category_id: 'entertainment',
          },
        ],
      }),
      client,
      liveDb
    );

    // create_transaction validates tags live.
    await tools.createTransaction({
      account_id: 'acct-1',
      item_id: 'item-1',
      name: 'Synthetic',
      date: '2026-07-01',
      amount: 100,
      category_id: 'c1',
      type: 'REGULAR',
      tag_ids: ['tag-live'],
    });

    // update_recurring: live category accepted.
    const result = await tools.updateRecurring({
      recurring_id: 'rec-1',
      category_id: 'cat-live',
    });
    expect(result.success).toBe(true);
    expect(client._calls.some((c) => c.op === 'EditRecurring')).toBe(true);
  });

  test('degraded mode still validates from LevelDB with unchanged messages', async () => {
    const client = createMockGraphQLClient({ EditTransaction: echoEdit as any });
    const db = makeDb({
      categories: [{ category_id: 'cat-local', name: 'Local' }],
      tags: [{ tag_id: 'tag-local', name: 'local' }],
    });
    (db as any)._transactions = [
      { transaction_id: 'txn-degraded', account_id: 'acct-1', item_id: 'item-1' },
    ];
    // Mock data accessors to prevent decoder initialization in degraded mode
    // All validation should use the seeded categories/tags without DB access
    (db as any).getAccounts = async () => [];
    (db as any).getTransactions = async () => [];
    (db as any).getItems = async () => [];
    (db as any).getRecurring = async () => [];
    (db as any).getBudgets = async () => [];
    (db as any).getTags = async () => (db as any)._tags;
    (db as any).getCategories = async () => (db as any)._userCategories;
    const tools = new CopilotMoneyTools(db, client); // no liveDb — degraded

    // Known local ids pass through to the mutation.
    await tools.updateTransaction({
      transaction_id: 'txn-degraded',
      category_id: 'cat-local',
      tag_ids: ['tag-local'],
    });
    expect(client._calls.some((c) => c.op === 'EditTransaction')).toBe(true);

    // Unknown ids fail with the exact unchanged messages from the LevelDB leg.
    await expect(
      tools.updateTransaction({ transaction_id: 'txn-degraded', category_id: 'cat-ghost' })
    ).rejects.toThrow('Category not found: cat-ghost');
    await expect(
      tools.updateTransaction({ transaction_id: 'txn-degraded', tag_ids: ['tag-ghost'] })
    ).rejects.toThrow('Tag not found: tag-ghost');
  });
});
