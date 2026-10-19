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

function setup(opts: { failFirstLoad?: boolean } = {}) {
  let transactionsCalls = 0;
  const client = createMockGraphQLClient({
    Transactions: () => {
      transactionsCalls += 1;
      if (opts.failFirstLoad && transactionsCalls === 1) {
        return new Error('synthetic network failure');
      }
      return { transactions: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } } };
    },
    DeleteTransaction: { deleteTransaction: true },
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

  test('a failed load is not reused', async () => {
    const { del, windowRequests } = setup({ failFirstLoad: true });
    await del(IDS[0]!); // the failed load does not block the delete
    const afterFailure = windowRequests();
    await del(IDS[1]!);
    expect(windowRequests()).toBeGreaterThan(afterFailure);
  });
});
