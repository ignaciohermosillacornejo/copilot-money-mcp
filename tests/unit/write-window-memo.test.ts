/**
 * One write-resolve window load serves a burst of deletes (#838).
 *
 * delete_transaction loads the ~13-month write-resolve window to look for a
 * split child of its target (#822). The window cache's live tier (the recent
 * months) has a TTL of 0, so before the memo every delete of an ordinary row
 * refetched them: a cleanup loop deleting N rows paid about N window loads.
 * The load is now reused for CopilotMoneyTools.WINDOW_MEMO_MS across calls
 * with no other write in between.
 */

import { describe, test, expect, afterAll, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { TransactionMetaStore } from '../../src/core/persistence/transaction-meta-store.js';
import type { EditTransactionInput } from '../../src/core/graphql/transactions.js';
import { monthsCovered } from '../../src/utils/date.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';

const ACCOUNT_ID = 'Bv5nM8qW1eR4tY7uI0oP';
const ITEM_ID = 'Sd3fG6hJ9kL2zX5cV8bN';
const IDS = [
  'Aq1wS4eD7rF0tG3yH6uJ',
  'Bw2eD5rF8tG1yH4uJ7iK',
  'Ce3rF6tG9yH2uJ5iK8oL',
  'Dr4tG7yH0uJ3iK6oL9pZ',
  'Et5yH8uJ1iK4oL7pZ0aX',
];
const routing = { account_id: ACCOUNT_ID, item_id: ITEM_ID };

const META_DIR = mkdtempSync(join(tmpdir(), 'write-window-memo-'));
afterAll(() => rmSync(META_DIR, { recursive: true, force: true }));

/**
 * Requests the first window load makes: one per month, none cached yet. A
 * later load refetches only the live-tier months (TTL 0); the older months stay
 * cached for a week, so a reload costs fewer requests but always at least one.
 */
const WINDOW_LOAD = monthsCovered(CopilotMoneyTools.writeResolveWindow()).length;

/** A row as the Transactions query returns it. */
function windowNode(id: string, date: string) {
  return {
    id,
    accountId: ACCOUNT_ID,
    itemId: ITEM_ID,
    categoryId: '',
    recurringId: null,
    parentId: null,
    isReviewed: false,
    isPending: false,
    amount: 3,
    date,
    name: 'Row',
    type: 'REGULAR' as const,
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    isoCurrencyCode: null,
    createdAt: 1,
    tags: [],
    goal: null,
  };
}

function setup(
  opts: { failFirstLoad?: boolean; windowRows?: { id: string; date: string }[] } = {}
) {
  let transactionsCalls = 0;
  const nodes = (opts.windowRows ?? []).map((r) => windowNode(r.id, r.date));
  const client = createMockGraphQLClient({
    Transactions: () => {
      transactionsCalls += 1;
      if (opts.failFirstLoad && transactionsCalls === 1) {
        return new Error('synthetic network failure');
      }
      return {
        transactions: {
          edges: nodes.map((node) => ({ cursor: `c-${node.id}`, node })),
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      };
    },
    DeleteTransaction: { deleteTransaction: true },
    // split_transaction validates its children's categories first (#846).
    Categories: {
      categories: [
        {
          id: 'Cq1wE4rT7yU0iO3pA6sD',
          name: 'Synthetic',
          templateId: null,
          colorName: 'ORANGE2',
          isExcluded: false,
          isRolloverDisabled: false,
          canBeDeleted: true,
          icon: { __typename: 'EmojiUnicode' as const, unicode: '🛒' },
          budget: null,
        },
      ],
    },
    User: { user: { id: 'Cv6bN9mQ2wE5rT8yU1iO', budgetingConfig: null } },
    EditTransaction: (vars) => {
      const v = vars as { id: string; input: EditTransactionInput };
      return {
        editTransaction: {
          transaction: {
            id: v.id,
            ...routing,
            accountId: ACCOUNT_ID,
            itemId: ITEM_ID,
            categoryId: '',
            recurringId: null,
            isReviewed: false,
            isPending: false,
            amount: 1,
            date: '2025-03-12',
            name: 'Row',
            type: 'REGULAR',
            userNotes: v.input.userNotes ?? null,
            tipAmount: null,
            suggestedCategoryIds: [],
            createdAt: 1,
            tags: [],
            goal: null,
          },
        },
      };
    },
  });
  const db = new CopilotDatabase('/nonexistent');
  (db as any).dbPath = '/fake';
  (db as any)._transactions = [];
  db._markLoadedForTesting();
  const liveDb = new LiveCopilotDatabase(client, db, {
    metaStore: new TransactionMetaStore({
      baseDir: mkdtempSync(join(META_DIR, 'store-')),
      uidProvider: () => 'test-uid',
    }),
  });
  const tools = new CopilotMoneyTools(db, client, liveDb);
  const del = (id: string) => tools.deleteTransaction({ transaction_id: id, ...routing });
  return { tools, del, windowRequests: () => transactionsCalls };
}

afterEach(() => {
  // Restores any Date.now spy a test installed.
  (Date.now as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe('a burst of deletes shares one window load (#838)', () => {
  test('N deletes in a burst cause one window fetch', async () => {
    const { del, windowRequests } = setup();
    for (const id of IDS) await del(id);
    expect(windowRequests()).toBe(WINDOW_LOAD);
  });

  test('a write in between makes the next delete load the window again', async () => {
    const { tools, del, windowRequests } = setup();
    await del(IDS[0]!);
    await del(IDS[1]!);
    expect(windowRequests()).toBe(WINDOW_LOAD);

    await tools.updateTransaction({ transaction_id: IDS[2]!, ...routing, note: 'n' });
    await del(IDS[3]!);
    expect(windowRequests()).toBeGreaterThan(WINDOW_LOAD);
  });

  test('the memo expires after WINDOW_MEMO_MS', async () => {
    const { del, windowRequests } = setup();
    const start = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(start);
    await del(IDS[0]!);
    clock.mockReturnValue(start + CopilotMoneyTools.WINDOW_MEMO_MS - 1);
    await del(IDS[1]!);
    expect(windowRequests()).toBe(WINDOW_LOAD);

    clock.mockReturnValue(start + CopilotMoneyTools.WINDOW_MEMO_MS);
    await del(IDS[2]!);
    expect(windowRequests()).toBeGreaterThan(WINDOW_LOAD);
  });

  test('an invalidation of the window cache (refresh_cache, login sweep) forces a reload', async () => {
    const { tools, del, windowRequests } = setup();
    await del(IDS[0]!);
    expect(windowRequests()).toBe(WINDOW_LOAD);
    // What refresh_cache's full flush and the uid-transition sweep both do.
    (tools as any).liveDb.getTransactionsWindowCache().invalidate('all');
    await del(IDS[1]!);
    expect(windowRequests()).toBe(2 * WINDOW_LOAD);
  });

  test('a login change forgets the memo', async () => {
    const { tools, del, windowRequests } = setup();
    await del(IDS[0]!);
    tools.forgetSessionSplitParents();
    await del(IDS[1]!);
    expect(windowRequests()).toBeGreaterThan(WINDOW_LOAD);
  });

  test('a deleted row is dropped from the memo, so split no longer resolves it', async () => {
    // The delete burst's own window load memoizes IDS[0]'s row; once it is
    // deleted, a split of it within the memo window must not find a snapshot.
    const { tools, del } = setup({
      windowRows: [{ id: IDS[0]!, date: new Date().toISOString().slice(0, 10) }],
    });
    await del(IDS[1]!); // loads and memoizes the window, IDS[0] included
    await del(IDS[0]!);
    await expect(
      tools.splitTransaction({
        transaction_id: IDS[0]!,
        ...routing,
        splits: [
          { amount: 1, category_id: 'Cq1wE4rT7yU0iO3pA6sD' },
          { amount: 2, category_id: 'Cq1wE4rT7yU0iO3pA6sD' },
        ],
      })
    ).rejects.toThrow(/not found/);
  });

  test('a failed load is not reused', async () => {
    const { del, windowRequests } = setup({ failFirstLoad: true });
    await del(IDS[0]!); // the failed load does not block the delete
    const afterFailure = windowRequests();
    await del(IDS[1]!);
    expect(windowRequests()).toBeGreaterThan(afterFailure);
  });
});
