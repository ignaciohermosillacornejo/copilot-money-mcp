/**
 * Writes whose effect on a split transaction is unverified are refused (#836).
 *
 * delete_transaction refuses a split parent because Copilot credits a deleted
 * parent's amount back a second time (#822). Nobody has observed what the
 * server does for these, and a wrong guess corrupts a balance, so they are
 * refused before anything is sent, using the same evidence (splitParentEvidence):
 *
 *  - update_transaction / update_transactions changing amount, date or type on
 *    a known split parent. The children already replaced the parent's amount,
 *    so the balance could move twice.
 *  - add_transaction_to_recurring on a parent: the recurring could count the
 *    parent's amount on top of its children's.
 *  - split_transaction on a parent (a re-split) or on a split child.
 *
 * What stays allowed on a parent: name, category, note, tags and reviewed —
 * none of them moves a balance. The ledger records each server behaviour as
 * unverified (Mutation.editTransaction:splitParentBalanceFields,
 * Mutation.addTransactionToRecurring:splitParent,
 * Mutation.splitTransaction:resplit, Mutation.splitTransaction:splitChild).
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { TransactionMetaStore } from '../../src/core/persistence/transaction-meta-store.js';
import type { TransactionNode } from '../../src/core/graphql/queries/transactions.js';
import type {
  CreatedTransaction,
  EditTransactionInput,
} from '../../src/core/graphql/transactions.js';
import {
  bulkEditEcho,
  createMockGraphQLClient,
  type MockResponsesByOp,
} from '../helpers/mock-graphql.js';
import { monthsCovered } from '../../src/utils/date.js';

// Firestore-shaped opaque ids.
const ACCOUNT_ID = 'Wd4fG7hJ0kL3zX6cV9bN';
const ITEM_ID = 'Mq2wE5rT8yU1iO4pA7sD';
const CAT_A = 'Fg3hJ6kL9zX2cV5bN8mQ';
const CAT_B = 'We1rT4yU7iO0pA3sD6fG';
const PARENT_ID = 'Hj9kL2zX5cV8bN1mQ4wE';
const CHILD_1 = 'Rt7yU0iO3pA6sD9fG2hJ';
const CHILD_2 = 'Kl5zX8cV1bN4mQ7wE0rT';
const PLAIN_ID = 'Yu3iO6pA9sD2fG5hJ8kL';
const RECURRING_ID = 'Zx1cV4bN7mQ0wE3rT6yU';

const META_DIR = mkdtempSync(join(tmpdir(), 'split-target-refusal-'));
afterAll(() => rmSync(META_DIR, { recursive: true, force: true }));

const routing = { account_id: ACCOUNT_ID, item_id: ITEM_ID };

function node(id: string, amount: number, parentId: string | null = null): TransactionNode {
  return {
    id,
    accountId: ACCOUNT_ID,
    itemId: ITEM_ID,
    categoryId: CAT_A,
    recurringId: null,
    parentId,
    isReviewed: false,
    isPending: false,
    amount,
    date: '2025-03-12',
    name: 'Hardware Store',
    type: 'REGULAR',
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    isoCurrencyCode: null,
    createdAt: 1,
    tags: [],
    goal: null,
  };
}

/** What a mutation returns for `id`: the node minus the keys its fragment omits. */
function serverTx(id: string, overrides: Partial<CreatedTransaction> = {}): CreatedTransaction {
  const { parentId: _p, isoCurrencyCode: _c, categoryId, ...rest } = node(id, 100);
  return { ...rest, categoryId: categoryId ?? '', ...overrides };
}

const MUTATIONS: MockResponsesByOp = {
  EditTransaction: (vars) => {
    const v = vars as { id: string; input: EditTransactionInput };
    return {
      editTransaction: {
        transaction: serverTx(v.id, {
          ...(v.input.categoryId !== undefined ? { categoryId: v.input.categoryId } : {}),
          ...(v.input.name !== undefined ? { name: v.input.name } : {}),
        }),
      },
    };
  },
  AddTransactionToRecurring: (vars) => {
    const v = vars as { id: string };
    return {
      addTransactionToRecurring: {
        transaction: serverTx(v.id, { recurringId: RECURRING_ID }),
      },
    };
  },
  SplitTransaction: (vars) => {
    const v = vars as { id: string };
    return {
      splitTransaction: {
        parentTransaction: serverTx(v.id, { categoryId: '' }),
        splitTransactions: [serverTx('Pa1sD4fG7hJ0kL3zX6cV'), serverTx('Pb2sD5fG8hJ1kL4zX7cV')],
      },
    };
  },
  Transactions: {
    transactions: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } },
  },
  // Reference data for the category-only edits.
  Categories: {
    categories: [CAT_A, CAT_B].map((id) => ({
      id,
      name: `Category ${id}`,
      parentId: null,
      templateId: null,
      colorName: 'ORANGE2',
      isExcluded: false,
      isRolloverDisabled: false,
      canBeDeleted: true,
      icon: { __typename: 'EmojiUnicode' as const, unicode: '🛒' },
      budget: null,
    })),
  },
  User: { user: { id: 'Cv6bN9mQ2wE5rT8yU1iO', budgetingConfig: null } },
  BulkEditTransactions: bulkEditEcho,
};

/**
 * Live mode, the way the shipped server runs writes. The parent is known the
 * way a read leaves it known: its two children are cached with parentId set
 * (the Transactions query omits the parent itself). PLAIN_ID is an ordinary
 * cached row.
 */
function setup(overrides: MockResponsesByOp = {}) {
  const client = createMockGraphQLClient({ ...MUTATIONS, ...overrides });
  const db = new CopilotDatabase('/nonexistent');
  (db as any).dbPath = '/fake';
  (db as any)._transactions = [];
  (db as any)._userCategories = [];
  db._markLoadedForTesting();
  const liveDb = new LiveCopilotDatabase(client, db, {
    metaStore: new TransactionMetaStore({
      baseDir: mkdtempSync(join(META_DIR, 'store-')),
      uidProvider: () => 'test-uid',
    }),
  });
  liveDb
    .getTransactionsWindowCache()
    .ingestMonth(
      '2025-03',
      [node(CHILD_1, 60, PARENT_ID), node(CHILD_2, 40, PARENT_ID), node(PLAIN_ID, 25)],
      1
    );
  const tools = new CopilotMoneyTools(db, client, liveDb);
  const sent = (op: string) => client._calls.filter((c) => c.op === op);
  return { tools, sent };
}

const UNVERIFIED = /unverified/;

describe('update_transaction(s) on a split parent (#836)', () => {
  test.each([
    ['amount', { amount: 150 }],
    ['date', { date: '2025-03-20' }],
    ['type', { type: 'INCOME' as const }],
  ])('a %s edit is refused, nothing sent', async (_field, edit) => {
    const { tools, sent } = setup();
    await expect(
      tools.updateTransaction({ transaction_id: PARENT_ID, ...routing, ...edit })
    ).rejects.toThrow(UNVERIFIED);
    expect(sent('EditTransaction')).toHaveLength(0);
  });

  test('category-only edit on the parent still goes through', async () => {
    const { tools, sent } = setup();
    await tools.updateTransaction({ transaction_id: PARENT_ID, ...routing, category_id: CAT_B });
    expect(sent('EditTransaction')).toHaveLength(1);
  });

  test('name, note, tags and reviewed edits on the parent still go through', async () => {
    const { tools, sent } = setup();
    await tools.updateTransaction({
      transaction_id: PARENT_ID,
      ...routing,
      name: 'Renamed',
      note: 'n',
      tag_ids: [],
      reviewed: true,
    });
    expect(sent('EditTransaction')).toHaveLength(1);
  });

  test('an amount edit on an ordinary row still goes through', async () => {
    const { tools, sent } = setup();
    await tools.updateTransaction({ transaction_id: PLAIN_ID, ...routing, amount: 30 });
    expect(sent('EditTransaction')).toHaveLength(1);
  });

  test('update_transactions: one amount edit on a parent refuses the whole batch, nothing sent', async () => {
    const { tools, sent } = setup();
    await expect(
      tools.updateTransactions({
        edits: [
          { transaction_id: PLAIN_ID, ...routing, amount: 30 },
          { transaction_id: PARENT_ID, ...routing, amount: 150 },
        ],
      })
    ).rejects.toThrow(/edits\[1\].*split parent.*unverified/s);
    expect(sent('EditTransaction')).toHaveLength(0);
  });

  test('update_transactions: a category-only edit on a parent goes through', async () => {
    const { tools, sent } = setup();
    await tools.updateTransactions({
      edits: [
        { transaction_id: PLAIN_ID, ...routing, amount: 30 },
        { transaction_id: PARENT_ID, ...routing, category_id: CAT_B },
      ],
    });
    expect(sent('EditTransaction')).toHaveLength(2);
  });

  test('update_transactions: one window load serves every edit checked', async () => {
    const { tools, sent } = setup();
    const before = sent('Transactions').length;
    await tools.updateTransactions({
      edits: [
        { transaction_id: PLAIN_ID, ...routing, amount: 30 },
        { transaction_id: CHILD_1, ...routing, amount: 61 },
      ],
    });
    // One load of the whole window (one request per month, none cached here),
    // not one per edit checked.
    expect(sent('Transactions').length - before).toBe(
      monthsCovered(CopilotMoneyTools.writeResolveWindow()).length
    );
  });
});

describe('add_transaction_to_recurring on a split parent (#836)', () => {
  test('a parent is refused, nothing sent', async () => {
    const { tools, sent } = setup();
    await expect(
      tools.addTransactionToRecurring({
        transaction_id: PARENT_ID,
        ...routing,
        recurring_id: RECURRING_ID,
      })
    ).rejects.toThrow(UNVERIFIED);
    expect(sent('AddTransactionToRecurring')).toHaveLength(0);
  });

  test('a split child and an ordinary row still link', async () => {
    const { tools, sent } = setup();
    for (const id of [CHILD_1, PLAIN_ID]) {
      await tools.addTransactionToRecurring({
        transaction_id: id,
        ...routing,
        recurring_id: RECURRING_ID,
      });
    }
    expect(sent('AddTransactionToRecurring')).toHaveLength(2);
  });
});

describe('split_transaction on a split parent or child (#836)', () => {
  const splits = [
    { name: 'A', date: '2025-03-12', amount: 30, category_id: CAT_A },
    { name: 'B', date: '2025-03-12', amount: 70, category_id: CAT_B },
  ];

  test('re-splitting a known parent is refused, nothing sent', async () => {
    const { tools, sent } = setup();
    await expect(
      tools.splitTransaction({ transaction_id: PARENT_ID, ...routing, splits })
    ).rejects.toThrow(/already a split parent.*unverified/s);
    expect(sent('SplitTransaction')).toHaveLength(0);
  });

  test('a parent this server just split is refused a second split', async () => {
    const { tools, sent } = setup();
    await tools.splitTransaction({
      transaction_id: PLAIN_ID,
      ...routing,
      splits: [
        { amount: 10, category_id: CAT_A },
        { amount: 15, category_id: CAT_B },
      ],
    });
    await expect(
      tools.splitTransaction({ transaction_id: PLAIN_ID, ...routing, splits })
    ).rejects.toThrow(/already a split parent/);
    expect(sent('SplitTransaction')).toHaveLength(1);
  });

  test('splitting a split child is refused, nothing sent', async () => {
    const { tools, sent } = setup();
    await expect(
      tools.splitTransaction({
        transaction_id: CHILD_1,
        ...routing,
        splits: [
          { amount: 20, category_id: CAT_A },
          { amount: 40, category_id: CAT_B },
        ],
      })
    ).rejects.toThrow(/is a split child.*unverified/s);
    expect(sent('SplitTransaction')).toHaveLength(0);
  });

  test('an ordinary row still splits', async () => {
    const { tools, sent } = setup();
    await tools.splitTransaction({
      transaction_id: PLAIN_ID,
      ...routing,
      splits: [
        { amount: 10, category_id: CAT_A },
        { amount: 15, category_id: CAT_B },
      ],
    });
    expect(sent('SplitTransaction')).toHaveLength(1);
  });
});

describe('bulk_edit_transactions with a type on a split parent (#836)', () => {
  test('a type change targeting a parent refuses the whole call, nothing sent', async () => {
    const { tools, sent } = setup();
    await expect(
      tools.bulkEditTransactions({
        rows: [PLAIN_ID, PARENT_ID].map((transaction_id) => ({ transaction_id, ...routing })),
        type: 'INCOME',
      })
    ).rejects.toThrow(/split parent.*unverified/s);
    expect(sent('BulkEditTransactions')).toHaveLength(0);
  });

  test('a category change targeting a parent still goes through', async () => {
    const { tools, sent } = setup();
    await tools.bulkEditTransactions({
      rows: [PLAIN_ID, PARENT_ID].map((transaction_id) => ({ transaction_id, ...routing })),
      category_id: CAT_B,
    });
    expect(sent('BulkEditTransactions')).toHaveLength(1);
  });

  test('a type change on ordinary rows still goes through', async () => {
    const { tools, sent } = setup();
    await tools.bulkEditTransactions({
      rows: [PLAIN_ID, CHILD_1].map((transaction_id) => ({ transaction_id, ...routing })),
      type: 'INTERNAL_TRANSFER',
    });
    expect(sent('BulkEditTransactions')).toHaveLength(1);
  });
});

describe('an unchecked split target is not written (#836)', () => {
  // The window fetch fails, so an ordinary-looking id cannot be shown not to
  // be a split parent. delete_transaction proceeds on what it holds; these
  // writes refuse.
  const failingWindow = { Transactions: new Error('synthetic network failure') };

  test('an amount edit is refused when the window cannot be loaded', async () => {
    const { tools, sent } = setup(failingWindow);
    await expect(
      tools.updateTransaction({ transaction_id: PLAIN_ID, ...routing, amount: 30 })
    ).rejects.toThrow(/could not check.*nothing was sent/s);
    expect(sent('EditTransaction')).toHaveLength(0);
  });

  test('add_transaction_to_recurring and split_transaction are refused too', async () => {
    const { tools, sent } = setup(failingWindow);
    await expect(
      tools.addTransactionToRecurring({
        transaction_id: PLAIN_ID,
        ...routing,
        recurring_id: RECURRING_ID,
      })
    ).rejects.toThrow(/could not check/);
    await expect(
      tools.splitTransaction({
        transaction_id: PLAIN_ID,
        ...routing,
        splits: [
          { name: 'A', date: '2025-03-12', amount: 10, category_id: CAT_A },
          { name: 'B', date: '2025-03-12', amount: 15, category_id: CAT_B },
        ],
      })
    ).rejects.toThrow(/could not check/);
    expect(sent('AddTransactionToRecurring')).toHaveLength(0);
    expect(sent('SplitTransaction')).toHaveLength(0);
  });

  test('an edit that needs no split check is unaffected', async () => {
    const { tools, sent } = setup(failingWindow);
    await tools.updateTransaction({ transaction_id: PLAIN_ID, ...routing, note: 'n' });
    expect(sent('EditTransaction')).toHaveLength(1);
  });
});

describe('resolution and the split check share one window load (#836)', () => {
  test('update_transaction without routing ids: one load resolves the id and checks it', async () => {
    // The id is not indexed, so resolution loads the window; the split check
    // must reuse that load instead of refetching the live-tier months.
    const today = new Date().toISOString().slice(0, 10);
    const target = { ...node('Ux2iO5pA8sD1fG4hJ7kL', 25), date: today };
    const { tools, sent } = setup({
      Transactions: {
        transactions: {
          edges: [{ cursor: 'c-1', node: target }],
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      },
    });
    await tools.updateTransaction({ transaction_id: target.id, amount: 30 });
    expect(sent('Transactions')).toHaveLength(
      monthsCovered(CopilotMoneyTools.writeResolveWindow()).length
    );
    expect(sent('EditTransaction')).toHaveLength(1);
  });
});

describe('cache-only mode: no window to check, so nothing is refused for it (#836)', () => {
  // windowChecked is a tri-state; only `false` (a FAILED load) refuses. With no
  // live layer there is no window at all, and an ordinary row must still write.
  test('an amount edit without a live layer still writes', async () => {
    const client = createMockGraphQLClient(MUTATIONS);
    const db = new CopilotDatabase('/nonexistent');
    (db as any).dbPath = '/fake';
    (db as any)._transactions = [
      { transaction_id: PLAIN_ID, account_id: ACCOUNT_ID, item_id: ITEM_ID, amount: 25 },
    ];
    db._markLoadedForTesting();
    const tools = new CopilotMoneyTools(db, client);
    await tools.updateTransaction({ transaction_id: PLAIN_ID, ...routing, amount: 30 });
    expect(client._calls.filter((c) => c.op === 'EditTransaction')).toHaveLength(1);
  });

  test('a cache-only split parent (local children) is still refused', async () => {
    const client = createMockGraphQLClient(MUTATIONS);
    const db = new CopilotDatabase('/nonexistent');
    (db as any).dbPath = '/fake';
    (db as any)._transactions = [
      { transaction_id: CHILD_1, parent_transaction_id: PARENT_ID, amount: 60 },
    ];
    db._markLoadedForTesting();
    const tools = new CopilotMoneyTools(db, client);
    await expect(
      tools.updateTransaction({ transaction_id: PARENT_ID, ...routing, amount: 150 })
    ).rejects.toThrow(UNVERIFIED);
  });
});
