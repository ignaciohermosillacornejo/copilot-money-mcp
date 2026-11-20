/**
 * Write → live-read coherence, one case per transaction write tool (#820, #821).
 *
 * In live mode a month whose last day is more than 14 days old is cached for a
 * week (TransactionWindowCache's cold tier). Writes keep that cache coherent by
 * write-through, and two bugs showed the write-through could silently do
 * nothing while every unit test stayed green:
 *
 *  - #821: the patch merged snake_case cache-model keys (`category_id`,
 *    `user_reviewed`, `tag_ids`, …) onto a camelCase GraphQL node, so only the
 *    fields spelled the same in both models (`name`, `date`, `amount`) changed.
 *  - #820: create_transaction and split_transaction never put the new rows into
 *    the cache at all.
 *
 * Both are the same class — the write lands on the server, the cached read
 * disagrees — and the detector is this table: every case seeds a COLD month,
 * performs the write through the tool's registry handler against a mocked
 * mutation that returns a realistic server node, then reads back through
 * get_transactions_live's registry handler (the public path, through the
 * row mapper — never the raw cache object, where #821's dead snake_case keys
 * would sit and look like success) and asserts the read was a cache hit that
 * reflects every field the write changed.
 *
 * The table is exhaustive by construction: a transaction write tool added to
 * WRITE_TOOL_DEFS without a case here fails the first test.
 */

import { describe, test, expect, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { monthsCovered } from '../../src/utils/date.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { TransactionMetaStore } from '../../src/core/persistence/transaction-meta-store.js';
import {
  LIVE_TRANSACTION_KNOWN_FIELDS,
  LiveTransactionsTools,
  liveMapperArity,
  liveRowFromMutation,
  mapMutationFields,
  writeRowFields,
  writeRowMapperArities,
  type WriteRowField,
} from '../../src/tools/live/transactions.js';
import { LiveBalanceHistoryTools } from '../../src/tools/live/balance-history.js';
import { GraphQLError, unusablePayloadError } from '../../src/core/graphql/client.js';
import { TOOL_REGISTRY, WRITE_TOOL_DEFS } from '../../src/tools/registry/index.js';
import * as transactionRegistry from '../../src/tools/registry/transactions.js';
import type { LiveToolContext, ToolContext } from '../../src/tools/registry/types.js';
import type { TransactionNode } from '../../src/core/graphql/queries/transactions.js';
import type { AccountNode } from '../../src/core/graphql/queries/accounts.js';
import type { NetworthHistoryNode } from '../../src/core/graphql/queries/networth.js';
import type { DailySpendNode } from '../../src/core/graphql/queries/monthly-spend.js';
import type { UpcomingRecurringNode } from '../../src/core/graphql/queries/upcoming-recurrings.js';
import type { RecurringNode } from '../../src/core/graphql/queries/recurrings.js';
import type {
  CreatedTransaction,
  EditTransactionInput,
  TransactionType,
} from '../../src/core/graphql/transactions.js';
import { createMockGraphQLClient, type MockResponsesByOp } from '../helpers/mock-graphql.js';
import type { Transaction } from '../../src/models/index.js';
import type { TxFixture } from '../helpers/fixtures.js';

/**
 * A seeded local row: field names checked against Transaction, with
 * category_id widened to the null a live row carries for "uncategorized".
 */
type LocalRow = Omit<TxFixture, 'category_id'> & { category_id?: string | null };

// ── Firestore-shaped opaque ids (never id-equals-name fixtures) ─────────────

const ACCOUNT_ID = 'kQ7vN2xR9pL4mW8tY3zB';
const ITEM_ID = 'hT5cJ8wF2nD6sG1qV4xM';
const CAT_OLD = 'gR4tH7jK2lM9nP3qS6vW';
const CAT_NEW = 'zX8cV5bN1mQ4wE7rT2yU';
const TAG_ID = 'pL6kJ3hG9fD2sA5qW8eR';
const RECURRING_ID = 'yU7iO4pA1sD8fG5hJ2kL';

const TX_UPDATE = 'aB3xK9pQ2mN7vR4tY8wZ';
const TX_BATCH_1 = 'cD5yL1rS4oP9wT6uZ0xA';
const TX_BATCH_2 = 'eF7zM3tU6qR1yV8wB2zC';
/** Seeded as an INTERNAL_TRANSFER, so a retype must clear the old flag too. */
const TX_BATCH_3 = 'eG8aN4uV7rS2zW9xC3aD';
/** Seeded as INCOME, retyped REGULAR: the income flag's clear direction. */
const TX_BATCH_4 = 'eH9bO5vW8sT3aX0yD4bE';
const TX_RECURRING = 'gH9aN5vW8sT3aX0yD4bE';
const TX_REVIEW = 'iJ1bO7xY0uV5cZ2aF6dG';
const TX_BULK_1 = 'kL3cP9zA2wX7eB4cH8fI';
const TX_BULK_2 = 'mN5dQ1bC4yZ9gD6eJ0hK';
const TX_DELETE = 'oP7eR3dE6aB1iF8gL2jM';
const TX_SPLIT_PARENT = 'qR9fS5fG8cD3kH0iN4lO';
const TX_CREATED = 'sT1gT7hI0eF5mJ2kP6nQ';
const TX_CHILD_1 = 'uV3hU9jK2gH7oL4mR8pS';
const TX_CHILD_2 = 'wX5iV1lM4iJ9qN6oT0rU';

/** A month far enough back to be in the cold tier (cached, 1-week TTL). */
const COLD_MONTH = { start: '2025-03-01', end: '2025-03-31' };
const SEED_DATE = '2025-03-12';

const TAG_NODE = { id: TAG_ID, name: 'Trip', colorName: 'BLUE1' };

// ── Server-shaped fixtures ──────────────────────────────────────────────────

/** A row as the Transactions QUERY returns it (selects parentId/isoCurrencyCode). */
function seedNode(id: string, overrides: Partial<TransactionNode> = {}): TransactionNode {
  return {
    id,
    accountId: ACCOUNT_ID,
    itemId: ITEM_ID,
    categoryId: CAT_OLD,
    recurringId: null,
    parentId: null,
    isReviewed: true,
    isPending: false,
    amount: 100,
    date: SEED_DATE,
    name: `Merchant ${id.slice(0, 4)}`,
    type: 'REGULAR',
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    isoCurrencyCode: 'USD',
    createdAt: 1000,
    tags: [],
    goal: null,
    ...overrides,
  };
}

const SEED: TransactionNode[] = [
  TX_UPDATE,
  TX_BATCH_1,
  TX_BATCH_2,
  TX_RECURRING,
  TX_REVIEW,
  TX_BULK_1,
  TX_BULK_2,
  TX_DELETE,
  TX_SPLIT_PARENT,
]
  .map((id) => seedNode(id))
  .concat([
    seedNode(TX_BATCH_3, { type: 'INTERNAL_TRANSFER', categoryId: '' }),
    seedNode(TX_BATCH_4, { type: 'INCOME', categoryId: '' }),
  ]);

/**
 * A row as a MUTATION returns it: the mutations' TransactionFields fragment
 * does not select `parentId` or `isoCurrencyCode` (see
 * operations.generated.ts), so a realistic fixture omits both.
 */
function mutationNode(base: TransactionNode, overrides: Partial<CreatedTransaction> = {}) {
  const { parentId: _p, isoCurrencyCode: _c, categoryId, ...rest } = base;
  const node: CreatedTransaction = { ...rest, categoryId: categoryId ?? '', ...overrides };
  return node;
}

/**
 * A split parent that already exists on the server. The Transactions query
 * omits split parents, so it is NOT in the seeded month — but the edit tools
 * accept its id, and their mutation responses do not say it is a parent.
 */
const TX_HIDDEN_PARENT = 'yZ7jW3nO6kL1sR8tV5xY';
const HIDDEN_PARENT = seedNode(TX_HIDDEN_PARENT, { name: 'Split parent', amount: 300 });

function seedById(id: string): TransactionNode {
  const row = [...SEED, HIDDEN_PARENT].find((r) => r.id === id);
  if (!row) throw new Error(`no seed row ${id}`);
  return row;
}

/** EditTransaction echo: apply the requested input to the seed row. */
function applyEdit(id: string, input: EditTransactionInput): CreatedTransaction {
  const base = seedById(id);
  const out = mutationNode(base);
  if (input.name !== undefined) out.name = input.name;
  if (input.categoryId !== undefined) out.categoryId = input.categoryId;
  if (input.userNotes !== undefined) out.userNotes = input.userNotes;
  if (input.isReviewed !== undefined) out.isReviewed = input.isReviewed;
  if (input.date !== undefined) out.date = input.date;
  if (input.amount !== undefined) out.amount = input.amount;
  if (input.tagIds !== undefined) out.tags = input.tagIds.map(() => TAG_NODE);
  if (input.type !== undefined) {
    out.type = input.type;
    // Verified server behaviour: INCOME / INTERNAL_TRANSFER clear the category.
    if (input.type !== 'REGULAR') out.categoryId = '';
  }
  return out;
}

const REFERENCE_MOCKS: MockResponsesByOp = {
  Categories: {
    categories: [CAT_OLD, CAT_NEW].map((id, i) => ({
      id,
      name: i === 0 ? 'Dining' : 'Groceries',
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
  Tags: { tags: [TAG_NODE] },
  User: { user: { id: 'vW2jX8nO5kL0sP7qV1tW', budgetingConfig: null } },
};

// ── Harness ─────────────────────────────────────────────────────────────────

const META_DIR = mkdtempSync(join(tmpdir(), 'live-write-coherence-meta-'));
afterAll(() => rmSync(META_DIR, { recursive: true, force: true }));

const READ_FIELDS = [
  'transaction_id',
  'name',
  'date',
  'amount',
  'type',
  'category_id',
  'user_reviewed',
  'tag_ids',
  'user_notes',
  'recurring_id',
  'parent_transaction_id',
];

type Row = Record<string, unknown>;

interface Case {
  /** Mutation mocks for this write. */
  mocks: MockResponsesByOp;
  /** Registry handler arguments for the write. */
  args: Record<string, unknown>;
  /** Assertions against the post-write live read, keyed by transaction id. */
  verify: (rows: Map<string, Row>) => void;
  /**
   * Transactions fetches the write itself makes. Default 0, so an accidental
   * fetch in any write tool goes red; a tool that fetches by design declares
   * its count.
   */
  expectedWriteFetches?: number;
}

/**
 * Months in the write-resolve window, derived from the source's own window
 * definition. None of them is cached here — the seeded cold month is older
 * than the window — so a window load fetches each one.
 */
function writeResolveWindowMonthCount(): number {
  return monthsCovered(CopilotMoneyTools.writeResolveWindow()).length;
}

function setup(mutationMocks: MockResponsesByOp) {
  let transactionsFetches = 0;
  const client = createMockGraphQLClient({
    ...REFERENCE_MOCKS,
    ...mutationMocks,
    Transactions: () => {
      transactionsFetches += 1;
      return {
        transactions: {
          edges: SEED.map((node) => ({ cursor: `c-${node.id}`, node })),
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      };
    },
  });
  const db = new CopilotDatabase('/fake');
  // The local (LevelDB-model) cache holds the same rows, so a partial batch can
  // be checked against both caches.
  db._injectDataForTesting({
    // The return annotation, not a `satisfies` on the mapped array, is what
    // runs the excess-property check on each row literal.
    transactions: SEED.map((n): LocalRow => ({
      transaction_id: n.id,
      account_id: n.accountId,
      item_id: n.itemId,
      category_id: n.categoryId,
      user_reviewed: n.isReviewed,
      tag_ids: [],
      amount: n.amount,
      date: n.date,
      name: n.name,
      // The decoder's type-derived flags (#864 review).
      ...(n.type === 'INTERNAL_TRANSFER' ? { internal_transfer: true } : {}),
      ...(n.type === 'INCOME' ? { income: true } : {}),
    })) as Transaction[],
  });
  // Persisted routing index in a per-run temp dir — never the user's home.
  const metaStore = new TransactionMetaStore({
    baseDir: mkdtempSync(join(META_DIR, 'store-')),
    uidProvider: () => 'test-uid',
  });
  const liveDb = new LiveCopilotDatabase(client, db, { metaStore });
  const tools = new CopilotMoneyTools(db, client, liveDb);
  const ctx: ToolContext = {
    tools,
    live: { transactions: new LiveTransactionsTools(liveDb) } as unknown as LiveToolContext,
  };
  const call = (name: string, args: Record<string, unknown>) => {
    const def = TOOL_REGISTRY.get(name);
    if (!def) throw new Error(`unknown tool ${name}`);
    return def.handler(ctx, args);
  };
  const read = async () =>
    (await call('get_transactions_live', {
      start_date: COLD_MONTH.start,
      end_date: COLD_MONTH.end,
      exclude_transfers: false,
      exclude_excluded: false,
      limit: 500,
      fields: READ_FIELDS,
    })) as { transactions: Row[]; _cache_hit: boolean };
  const local = (id: string) =>
    (db as unknown as { _transactions: Array<Record<string, unknown>> })._transactions.find(
      (t) => t.transaction_id === id
    );
  return { call, read, local, liveDb, fetches: () => transactionsFetches };
}

const routing = { account_id: ACCOUNT_ID, item_id: ITEM_ID };

// ── The table ───────────────────────────────────────────────────────────────

const CASES: Record<string, Case> = {
  create_transaction: {
    mocks: {
      CreateTransaction: {
        createTransaction: mutationNode(seedNode(TX_CREATED), {
          name: 'Corner Bakery',
          date: '2025-03-20',
          amount: 42,
          categoryId: CAT_NEW,
          type: 'REGULAR',
          isReviewed: false,
          userNotes: 'receipt',
          recurringId: RECURRING_ID,
          tags: [TAG_NODE],
          createdAt: 2000,
        }),
      },
    },
    args: {
      ...routing,
      name: 'Corner Bakery',
      date: '2025-03-20',
      amount: 42,
      category_id: CAT_NEW,
      type: 'REGULAR',
      tag_ids: [TAG_ID],
      note: 'receipt',
      recurring_id: RECURRING_ID,
    },
    verify: (rows) => {
      expect(rows.get(TX_CREATED)).toEqual({
        transaction_id: TX_CREATED,
        name: 'Corner Bakery',
        date: '2025-03-20',
        amount: 42,
        type: 'REGULAR',
        category_id: CAT_NEW,
        user_reviewed: false,
        tag_ids: [TAG_ID],
        user_notes: 'receipt',
        recurring_id: RECURRING_ID,
        parent_transaction_id: null,
      });
    },
  },

  split_transaction: {
    mocks: {
      SplitTransaction: {
        splitTransaction: {
          parentTransaction: mutationNode(seedById(TX_SPLIT_PARENT)),
          splitTransactions: [
            mutationNode(seedNode(TX_CHILD_1), {
              name: 'Part A',
              amount: 60,
              categoryId: CAT_OLD,
              isReviewed: false,
            }),
            mutationNode(seedNode(TX_CHILD_2), {
              name: 'Part B',
              amount: 40,
              categoryId: CAT_NEW,
              isReviewed: false,
            }),
          ],
        },
      },
    },
    args: {
      ...routing,
      transaction_id: TX_SPLIT_PARENT,
      splits: [
        { name: 'Part A', amount: 60, category_id: CAT_OLD },
        { name: 'Part B', amount: 40, category_id: CAT_NEW },
      ],
    },
    verify: (rows) => {
      // The server omits split parents from Transactions; the children carry
      // the parent's id.
      expect(rows.has(TX_SPLIT_PARENT)).toBe(false);
      expect(rows.get(TX_CHILD_1)).toMatchObject({
        name: 'Part A',
        amount: 60,
        date: SEED_DATE,
        category_id: CAT_OLD,
        user_reviewed: false,
        parent_transaction_id: TX_SPLIT_PARENT,
      });
      expect(rows.get(TX_CHILD_2)).toMatchObject({
        name: 'Part B',
        amount: 40,
        date: SEED_DATE,
        category_id: CAT_NEW,
        user_reviewed: false,
        parent_transaction_id: TX_SPLIT_PARENT,
      });
    },
    // The split-parent check (#836) loads the write-resolve window, which also
    // resolves the parent.
    expectedWriteFetches: writeResolveWindowMonthCount(),
  },

  update_transaction: {
    mocks: {
      EditTransaction: (vars) => {
        const v = vars as { id: string; input: EditTransactionInput };
        return { editTransaction: { transaction: applyEdit(v.id, v.input) } };
      },
    },
    args: {
      ...routing,
      transaction_id: TX_UPDATE,
      name: 'Renamed Merchant',
      category_id: CAT_NEW,
      note: 'edited note',
      tag_ids: [TAG_ID],
      reviewed: false,
      date: '2025-03-25',
      amount: 77,
    },
    verify: (rows) => {
      expect(rows.get(TX_UPDATE)).toEqual({
        transaction_id: TX_UPDATE,
        name: 'Renamed Merchant',
        date: '2025-03-25',
        amount: 77,
        type: 'REGULAR',
        category_id: CAT_NEW,
        user_reviewed: false,
        tag_ids: [TAG_ID],
        user_notes: 'edited note',
        recurring_id: null,
        parent_transaction_id: null,
      });
    },
    // It edits date and amount, so the split-parent check (#836) loads the
    // write-resolve window.
    expectedWriteFetches: writeResolveWindowMonthCount(),
  },

  update_transactions: {
    mocks: {
      EditTransaction: (vars) => {
        const v = vars as { id: string; input: EditTransactionInput };
        return { editTransaction: { transaction: applyEdit(v.id, v.input) } };
      },
    },
    args: {
      edits: [
        { ...routing, transaction_id: TX_BATCH_1, type: 'INTERNAL_TRANSFER' as TransactionType },
        {
          ...routing,
          transaction_id: TX_BATCH_2,
          category_id: CAT_NEW,
          reviewed: false,
          note: 'batch note',
          tag_ids: [TAG_ID],
        },
        // transfer → income: clears one derived flag and sets the other.
        { ...routing, transaction_id: TX_BATCH_3, type: 'INCOME' as TransactionType },
        // income → regular: the income flag's clear direction.
        { ...routing, transaction_id: TX_BATCH_4, type: 'REGULAR' as TransactionType },
      ],
    },
    verify: (rows) => {
      expect(rows.get(TX_BATCH_1)).toMatchObject({ type: 'INTERNAL_TRANSFER', category_id: null });
      expect(rows.get(TX_BATCH_3)).toMatchObject({ type: 'INCOME', category_id: null });
      expect(rows.get(TX_BATCH_4)).toMatchObject({ type: 'REGULAR', category_id: null });
      expect(rows.get(TX_BATCH_2)).toMatchObject({
        category_id: CAT_NEW,
        user_reviewed: false,
        user_notes: 'batch note',
        tag_ids: [TAG_ID],
      });
    },
    // One edit sets type, so the split-parent check (#836) loads the window once.
    expectedWriteFetches: writeResolveWindowMonthCount(),
  },

  add_transaction_to_recurring: {
    mocks: {
      AddTransactionToRecurring: {
        addTransactionToRecurring: {
          // Linking also sets the row's category to the recurring's (#848).
          transaction: mutationNode(seedById(TX_RECURRING), {
            recurringId: RECURRING_ID,
            categoryId: CAT_NEW,
          }),
        },
      },
    },
    args: { ...routing, transaction_id: TX_RECURRING, recurring_id: RECURRING_ID },
    verify: (rows) => {
      expect(rows.get(TX_RECURRING)).toMatchObject({
        recurring_id: RECURRING_ID,
        category_id: CAT_NEW,
      });
    },
    // The split-parent check (#836) loads the write-resolve window.
    expectedWriteFetches: writeResolveWindowMonthCount(),
  },

  review_transactions: {
    mocks: {
      BulkEditTransactions: {
        bulkEditTransactions: {
          updated: [
            { ...mutationNode(seedById(TX_REVIEW), { isReviewed: false }), parentId: null },
          ],
          failed: [],
        },
      },
    },
    args: { rows: [{ ...routing, transaction_id: TX_REVIEW }], reviewed: false },
    verify: (rows) => {
      expect(rows.get(TX_REVIEW)).toMatchObject({ user_reviewed: false });
    },
  },

  // Sets a type, not a category: the two cannot be combined in one bulk edit,
  // and the type path is the one the local-mirror table needs. The bulk
  // category patch stays gated by tests/tools/bulk-edit-transactions.test.ts.
  bulk_edit_transactions: {
    mocks: {
      BulkEditTransactions: {
        bulkEditTransactions: {
          updated: [TX_BULK_1, TX_BULK_2].map((id) => ({
            // A type change: the server clears the category (verified).
            ...mutationNode(seedById(id), {
              categoryId: '',
              type: 'INTERNAL_TRANSFER',
              isReviewed: false,
              tags: [TAG_NODE],
            }),
            parentId: null,
          })),
          failed: [],
        },
      },
    },
    args: {
      rows: [TX_BULK_1, TX_BULK_2].map((id) => ({ ...routing, transaction_id: id })),
      type: 'INTERNAL_TRANSFER',
      reviewed: false,
      add_tag_ids: [TAG_ID],
    },
    verify: (rows) => {
      for (const id of [TX_BULK_1, TX_BULK_2]) {
        expect(rows.get(id)).toMatchObject({
          type: 'INTERNAL_TRANSFER',
          category_id: null,
          user_reviewed: false,
          tag_ids: [TAG_ID],
        });
      }
    },
    // A type change on rows: the split-parent check (#836) loads the
    // write-resolve window.
    expectedWriteFetches: writeResolveWindowMonthCount(),
  },

  delete_transaction: {
    mocks: { DeleteTransaction: { deleteTransaction: true } },
    args: { ...routing, transaction_id: TX_DELETE },
    verify: (rows) => {
      expect(rows.has(TX_DELETE)).toBe(false);
    },
    // The split-parent check (#822) loads the write-resolve window: one fetch
    // per window month, none of which is cached in this setup.
    expectedWriteFetches: writeResolveWindowMonthCount(),
  },
};

// ── Tests ───────────────────────────────────────────────────────────────────

/**
 * Every registered write tool that writes transactions, derived structurally:
 * the definitions the transactions domain module (src/tools/registry/
 * transactions.ts) exports that are registered as writes. A transaction write
 * tool defined in another domain module would escape that rule, so any write
 * tool whose name mentions transactions is included as well — the union can
 * only widen the set, never let a tool through.
 */
function transactionWriteToolNames(): string[] {
  const inTransactionsModule = new Set<unknown>(Object.values(transactionRegistry));
  return WRITE_TOOL_DEFS.filter(
    (def) => inTransactionsModule.has(def) || /transaction/.test(def.name)
  )
    .map((def) => def.name)
    .sort();
}

describe('write → live-read coherence (#820, #821)', () => {
  test('every transaction write tool has a case in this table', () => {
    const transactionWriteTools = transactionWriteToolNames();
    expect(transactionWriteTools.length).toBeGreaterThan(0);
    expect(Object.keys(CASES).sort()).toEqual(transactionWriteTools);
  });

  test.each(Object.keys(CASES))(
    '%s: a cached cold month reflects the write on the next live read',
    async (toolName) => {
      const c = CASES[toolName]!;
      const { call, read, fetches } = setup(c.mocks);

      // a. Seed: one read caches the cold month.
      const before = await read();
      expect(before._cache_hit).toBe(false);
      expect(fetches()).toBe(1);

      // b. Write through the tool's public handler. Only a tool that fetches
      // by design (declared per case) may add Transactions fetches.
      await call(toolName, c.args);
      expect(fetches()).toBe(1 + (c.expectedWriteFetches ?? 0));

      // c. Read back through the live tool + mapper. Must be served from the
      // cache (no refetch) — otherwise this would test the server mock, not
      // the write-through.
      const after = await read();
      expect(after._cache_hit).toBe(true);
      expect(fetches()).toBe(1 + (c.expectedWriteFetches ?? 0));

      const rows = new Map(after.transactions.map((r) => [r.transaction_id as string, r]));
      c.verify(rows);
    }
  );
});

// ── The local cache agrees with the server's row too (#848) ─────────────────
//
// Cache mode patches its own (LevelDB-model) copy of an edited row. #848 was a
// patch built from the request alone: add_transaction_to_recurring set only
// recurring_id while the server also changed the category, so cache mode kept
// the old one. Every transaction write tool must leave the local row agreeing
// with the server's returned row (as the live read shows it) on every field
// the local model mirrors — or, for a tool that removes the row from view, no
// local row at all. Same derived key set as the tables above.
//
// Its reach is what the mocks model: a mock that only echoes the request can
// catch a dropped field, not an unrequested server effect. When a server side
// effect becomes known, add it to the case's mutation mock (as
// add_transaction_to_recurring's category and the type change's cleared
// category are) and this table then forces the local patch to mirror it.

/** live read field → local (cache-model) field. */
const MIRRORED_FIELDS: Record<string, string> = {
  name: 'name',
  date: 'date',
  amount: 'amount',
  user_reviewed: 'user_reviewed',
  tag_ids: 'tag_ids',
  user_notes: 'user_note',
  recurring_id: 'recurring_id',
};

/**
 * Per tool: the rows whose local copy must mirror the server, or the rows the
 * write must remove from the local cache. create_transaction inserts nothing
 * locally by design (the next refresh picks the row up), which its `removed`
 * entry for the created id pins.
 */
const LOCAL_MIRROR: Record<string, { mirrored: string[]; removed: string[] }> = {
  create_transaction: { mirrored: [], removed: [TX_CREATED] },
  split_transaction: { mirrored: [], removed: [TX_SPLIT_PARENT, TX_CHILD_1, TX_CHILD_2] },
  delete_transaction: { mirrored: [], removed: [TX_DELETE] },
  update_transaction: { mirrored: [TX_UPDATE], removed: [] },
  update_transactions: { mirrored: [TX_BATCH_1, TX_BATCH_2, TX_BATCH_3, TX_BATCH_4], removed: [] },
  add_transaction_to_recurring: { mirrored: [TX_RECURRING], removed: [] },
  review_transactions: { mirrored: [TX_REVIEW], removed: [] },
  bulk_edit_transactions: { mirrored: [TX_BULK_1, TX_BULK_2], removed: [] },
};

// Absent means "none" for the fields a local row may simply omit (a note, a
// recurring id). category_id is compared on its own, below: there '' is the
// local model's "no category" (#824), and a patch that deleted the key instead
// must not pass as the same thing.
const norm = (v: unknown) => (v === undefined ? null : v);

describe('the local cache agrees with the server after a write (#848)', () => {
  test('every transaction write tool has a local-mirror case', () => {
    expect(Object.keys(LOCAL_MIRROR).sort()).toEqual(transactionWriteToolNames());
  });

  test.each(Object.keys(LOCAL_MIRROR))(
    '%s: the local row mirrors the server row on every mirrored field',
    async (toolName) => {
      const c = CASES[toolName]!;
      const m = LOCAL_MIRROR[toolName]!;
      const { call, read, local } = setup(c.mocks);
      await read();
      await call(toolName, c.args);
      const after = await read();
      const live = new Map(after.transactions.map((r) => [r.transaction_id as string, r]));

      for (const id of m.removed) expect({ id, row: local(id) }).toEqual({ id, row: undefined });
      for (const id of m.mirrored) {
        const server = live.get(id)!;
        const mine = local(id)!;
        for (const [liveKey, localKey] of Object.entries(MIRRORED_FIELDS)) {
          expect({ id, field: localKey, value: norm(mine[localKey]) }).toEqual({
            id,
            field: localKey,
            value: norm(server[liveKey]),
          });
        }
        // category_id: the local value must be a string ('' for none); live
        // reads normalize an empty category to null.
        expect({
          id,
          field: 'category_id',
          isString: typeof mine.category_id === 'string',
          value: mine.category_id === '' ? null : mine.category_id,
        }).toEqual({
          id,
          field: 'category_id',
          isString: true,
          value: server.category_id === '' ? null : server.category_id,
        });
        // Type-derived flags: the local counterparts of the live type. A seeded
        // row may omit them (false); a retype must set the new one and clear
        // the old. Both are derived from `type` because READ_FIELDS does not
        // select the live row's synthesized internal_transfer.
        for (const [flag, type] of [
          ['internal_transfer', 'INTERNAL_TRANSFER'],
          ['income', 'INCOME'],
        ] as const) {
          expect({ id, field: flag, value: mine[flag] === true }).toEqual({
            id,
            field: flag,
            value: server.type === type,
          });
        }
      }
    }
  );
});

// ── Write responses use live row field names (#825) ─────────────────────────
//
// `--write` implies `--live-reads`, so a write caller reads transactions from
// get_transactions_live. A transaction row a write tool returns must use that
// row's field names: v2 returned the cache model's `user_note` (and a
// cache-only `is_manual`) beside live rows spelled `user_notes`, so a caller
// copying a field from one to the other got nothing back. The allowed set is
// LIVE_TRANSACTION_KNOWN_FIELDS, derived from the live row mapper itself, so
// it cannot drift from what get_transactions_live returns.
//
// A transaction row is any object in the response carrying both
// `transaction_id` and `amount`; summaries (`{ transaction_id, updated }`)
// carry no amount. The expected row count per tool keeps the walk from being
// vacuous, and its key set must equal the transaction write tools, so a new
// tool, or one that starts returning rows, has to be classified here.

/** How many transaction rows each transaction write tool's response carries. */
const RESPONSE_ROWS: Record<string, number> = {
  create_transaction: 1,
  add_transaction_to_recurring: 1,
  split_transaction: 3, // the parent and two children
  update_transaction: 0,
  update_transactions: 0,
  review_transactions: 0,
  bulk_edit_transactions: 0,
  delete_transaction: 0,
};

/**
 * How many of each tool's returned rows the next live read shows. A split
 * parent is hidden from reads, so split_transaction twins its two children
 * only. Exact, like RESPONSE_ROWS, so a change that hid a returned row from
 * reads cannot pass with fewer comparisons.
 */
const TWINNED_ROWS: Record<string, number> = {
  create_transaction: 1,
  add_transaction_to_recurring: 1,
  split_transaction: 2,
};

function transactionRowsIn(value: unknown, out: Row[] = []): Row[] {
  if (Array.isArray(value)) {
    for (const v of value) transactionRowsIn(v, out);
  } else if (value !== null && typeof value === 'object') {
    const obj = value as Row;
    if ('transaction_id' in obj && 'amount' in obj) out.push(obj);
    for (const v of Object.values(obj)) transactionRowsIn(v, out);
  }
  return out;
}

describe('write responses use live row field names (#825)', () => {
  test('every transaction write tool is classified', () => {
    expect(Object.keys(RESPONSE_ROWS).sort()).toEqual(transactionWriteToolNames());
    expect(Object.keys(TWINNED_ROWS).sort()).toEqual(
      Object.keys(RESPONSE_ROWS)
        .filter((name) => RESPONSE_ROWS[name]! > 0)
        .sort()
    );
    // A tool whose returned rows are all hidden from reads would make its
    // value comparison loop zero times; none is today, and a 0 must not pass.
    for (const [name, count] of Object.entries(TWINNED_ROWS)) {
      expect({ name, positive: count > 0 }).toEqual({ name, positive: true });
    }
  });

  // The WRITE_ROW_FIELDS admission rule, fixture-independent: a live mapper
  // that reads the category index takes it as a second parameter, so no field
  // a write row may carry has a mapper of arity 2 or more. This holds for
  // every row shape, including a read that only some rows trigger
  // (`category_name` skips the index for an empty category).
  test('no write-row field mapper takes the category index', () => {
    const arities = writeRowMapperArities();
    expect(Object.keys(arities).length).toBeGreaterThan(0);
    expect(Object.entries(arities).filter(([, arity]) => arity >= 2)).toEqual([]);
  });

  // Non-vacuity: the arity rule does tell the index-reading mappers apart.
  test.each(['category_name', 'excluded'] as const)(
    'the %s mapper takes the category index (arity 2)',
    (field) => {
      expect(liveMapperArity(field)).toBe(2);
    }
  );

  // The runtime backstop: the index a write row is mapped with throws on any
  // read. The cast is deliberate — mapMutationFields' type admits only the
  // write-row fields, and this test reaches past it on purpose.
  test.each(['category_name', 'excluded'] as const)(
    'mapping %s from a mutation response throws instead of guessing',
    (field) => {
      const tx = mutationNode(seedNode(TX_CREATED), { categoryId: CAT_OLD });
      const excluded = [field] as unknown as readonly WriteRowField[];
      expect(() => mapMutationFields(tx, excluded)).toThrow(/CategoryIndex/);
    }
  );

  // parent_transaction_id is reachable only with a known parent: without a
  // parentId the value would be a guess, so the type refuses the request.
  test('mapMutationFields cannot request parent_transaction_id without a parentId', () => {
    const tx = mutationNode(seedNode(TX_CHILD_1));
    // @ts-expect-error parent_transaction_id needs tx.parentId (a split child's known parent)
    mapMutationFields(tx, ['parent_transaction_id']);
    expect(
      mapMutationFields({ ...tx, parentId: TX_SPLIT_PARENT }, ['parent_transaction_id'])
    ).toEqual({
      parent_transaction_id: TX_SPLIT_PARENT,
    });
  });

  // "Known" includes known-null: a response that selects parentId (the
  // bulkEditTransactions shape) and gets null back is not guessing, so the
  // type admits it and the row says null.
  test('mapMutationFields maps a selected null parentId to a null parent_transaction_id', () => {
    const selected: CreatedTransaction & { parentId: string | null } = {
      ...mutationNode(seedNode(TX_CHILD_1)),
      parentId: null,
    };
    expect(mapMutationFields(selected, ['parent_transaction_id'])).toEqual({
      parent_transaction_id: null,
    });
  });

  // Split children carry the parent id the split knows; the parent and every
  // other transaction write tool's rows do not carry the key at all.
  test('split children carry parent_transaction_id; no other returned row does', async () => {
    const results: Record<string, Row[]> = {};
    for (const toolName of Object.keys(RESPONSE_ROWS)) {
      const c = CASES[toolName]!;
      const { call, read } = setup(c.mocks);
      await read();
      results[toolName] = transactionRowsIn(await call(toolName, c.args));
    }
    const carrying = Object.entries(results).flatMap(([tool, rows]) =>
      rows
        .filter((r) => 'parent_transaction_id' in r)
        .map((r) => ({ tool, id: r.transaction_id, parent: r.parent_transaction_id }))
    );
    expect(carrying).toEqual([
      { tool: 'split_transaction', id: TX_CHILD_1, parent: TX_SPLIT_PARENT },
      { tool: 'split_transaction', id: TX_CHILD_2, parent: TX_SPLIT_PARENT },
    ]);
  });

  test('the shipped write-row fields never read the category index', () => {
    const tx = mutationNode(seedNode(TX_CREATED), { categoryId: CAT_OLD });
    expect(() => liveRowFromMutation(tx)).not.toThrow();
  });

  // The lower bound's oracle. Every get_transactions_live field is on every
  // write row (WRITE_ROW_FIELDS), on some write rows only, or never on one.
  // These lists name only the fields outside WRITE_ROW_FIELDS, so the
  // required set below is derived from the live read mapper rather than from
  // WRITE_ROW_FIELDS: deleting a field from WRITE_ROW_FIELDS orphans it here,
  // and a new live field must be classified before it ships.
  /** Never on a write row: needs the category index, or the fragment omits it. */
  const NEVER_ON_WRITE_ROWS = ['category_name', 'excluded', 'iso_currency_code'];
  /**
   * On a write row, but only when there are tags to report: mapped by the
   * write path itself (toWriteTransactionRow), outside WRITE_ROW_FIELDS.
   * This label is documentation, not enforcement: the bijection below sees
   * only the union of the three lists. The conditional half is pinned in
   * tests/tools/write-tools.test.ts (present with tags, absent without).
   */
  const CONDITIONAL_ON_WRITE_ROWS = ['tag_ids'];
  /** On a split child's row only (SPLIT_CHILD_FIELD). */
  const SPLIT_CHILD_ONLY = ['parent_transaction_id'];
  const NOT_ON_EVERY_ROW = [
    ...NEVER_ON_WRITE_ROWS,
    ...CONDITIONAL_ON_WRITE_ROWS,
    ...SPLIT_CHILD_ONLY,
  ];
  const REQUIRED_ON_EVERY_ROW = [...LIVE_TRANSACTION_KNOWN_FIELDS].filter(
    (f) => !NOT_ON_EVERY_ROW.includes(f)
  );

  test('every live field is a write-row field, a conditional or split-child field, or left out', () => {
    const unknown = NOT_ON_EVERY_ROW.filter((f) => !LIVE_TRANSACTION_KNOWN_FIELDS.has(f));
    expect(unknown).toEqual([]);
    const classified = [...writeRowFields(), ...NOT_ON_EVERY_ROW];
    const dupes = classified.filter((f, i) => classified.indexOf(f) !== i);
    expect(dupes).toEqual([]);
    expect(classified.sort()).toEqual([...LIVE_TRANSACTION_KNOWN_FIELDS].sort());
    // Non-vacuity: the lower bound below must have fields to require.
    expect(REQUIRED_ON_EVERY_ROW.length).toBeGreaterThan(0);
  });

  // Both bounds on the rows themselves, in one walk: every returned row's
  // keys are get_transactions_live fields (upper), and every row carries
  // every field required on every row (lower). Object.keys keeps a key whose
  // value is undefined, so a misnamed key is caught, and a field the fixture
  // leaves empty still counts as present.
  test.each(Object.keys(RESPONSE_ROWS))(
    '%s: every returned transaction row key is a get_transactions_live field, and none is missing',
    async (toolName) => {
      const c = CASES[toolName]!;
      const { call, read } = setup(c.mocks);
      await read();
      const response = await call(toolName, c.args);
      const rows = transactionRowsIn(response);
      expect(rows).toHaveLength(RESPONSE_ROWS[toolName]!);
      for (const row of rows) {
        const keys = Object.keys(row);
        const foreign = keys.filter((k) => !LIVE_TRANSACTION_KNOWN_FIELDS.has(k));
        const missing = REQUIRED_ON_EVERY_ROW.filter((k) => !keys.includes(k));
        expect({ id: row.transaction_id, foreign, missing }).toEqual({
          id: row.transaction_id,
          foreign: [],
          missing: [],
        });
      }
    }
  );

  // Names alone are not parity: v2 rows also spelled "none" differently
  // (`''` or an absent key where live says null). Every returned row must
  // carry, under every key it has, the value of the live-cache row the same
  // write wrote through, read back through get_transactions_live. Both sides
  // derive from one mutation response, so this pins the write row to the
  // cached row (the #820/#848 surface), not to the server; the independent
  // oracle for the server is `scripts/smoke-graphql.ts`.
  test.each(Object.keys(TWINNED_ROWS))(
    '%s: every returned row value equals the live-cache row the write wrote through',
    async (toolName) => {
      const c = CASES[toolName]!;
      const { call } = setup(c.mocks);
      const readAll = async () =>
        (await call('get_transactions_live', {
          start_date: COLD_MONTH.start,
          end_date: COLD_MONTH.end,
          exclude_transfers: false,
          exclude_excluded: false,
          limit: 500,
          fields: ['all'],
        })) as { transactions: Row[] };
      await readAll();
      const rows = transactionRowsIn(await call(toolName, c.args));
      const live = new Map((await readAll()).transactions.map((r) => [r.transaction_id, r]));
      const twinned = rows.filter((row) => live.has(row.transaction_id));
      expect(twinned).toHaveLength(TWINNED_ROWS[toolName]!);
      for (const row of twinned) {
        const server = live.get(row.transaction_id)!;
        const mismatched = Object.keys(row).filter(
          (k) => JSON.stringify(row[k]) !== JSON.stringify(server[k])
        );
        expect({ id: row.transaction_id, mismatched }).toEqual({
          id: row.transaction_id,
          mismatched: [],
        });
      }
    }
  );
});

// ── Edits must never insert a row the cached month did not have ─────────────
//
// An edit's target can be missing from a cached month for a legitimate reason:
// it is a split parent, which the Transactions query omits. The mutation
// response does not say so (no parentId), so inserting it would put the hidden
// parent back beside its children and double-count the amount. Only creates and
// split children may insert; an edit of an uncached row must leave the month
// to be refetched from the server instead.

const hiddenRouting = { ...routing, transaction_id: TX_HIDDEN_PARENT };
const hiddenEditEcho: MockResponsesByOp = {
  EditTransaction: (vars) => {
    const v = vars as { id: string; input: EditTransactionInput };
    return { editTransaction: { transaction: applyEdit(v.id, v.input) } };
  },
};

/** Every transaction write tool that edits an existing row, with args targeting the hidden parent. */
const EDIT_OF_UNCACHED_ROW: Record<
  string,
  { mocks: MockResponsesByOp; args: Record<string, unknown>; expectedWriteFetches?: number }
> = {
  update_transaction: {
    mocks: hiddenEditEcho,
    args: { ...hiddenRouting, category_id: CAT_NEW },
  },
  update_transactions: {
    mocks: hiddenEditEcho,
    args: { edits: [{ ...hiddenRouting, note: 'parent note' }] },
  },
  add_transaction_to_recurring: {
    mocks: {
      AddTransactionToRecurring: {
        addTransactionToRecurring: {
          transaction: mutationNode(HIDDEN_PARENT, { recurringId: RECURRING_ID }),
        },
      },
    },
    args: { ...hiddenRouting, recurring_id: RECURRING_ID },
    // The split-parent check (#836) loads the write-resolve window.
    expectedWriteFetches: writeResolveWindowMonthCount(),
  },
  review_transactions: {
    mocks: {
      BulkEditTransactions: {
        bulkEditTransactions: {
          updated: [{ ...mutationNode(HIDDEN_PARENT, { isReviewed: false }), parentId: null }],
          failed: [],
        },
      },
    },
    args: { rows: [hiddenRouting], reviewed: false },
  },
  bulk_edit_transactions: {
    mocks: {
      BulkEditTransactions: {
        bulkEditTransactions: {
          updated: [{ ...mutationNode(HIDDEN_PARENT, { categoryId: CAT_NEW }), parentId: null }],
          failed: [],
        },
      },
    },
    args: { rows: [hiddenRouting], category_id: CAT_NEW },
  },
};

/** Write tools that are not edits of an existing row: they create, or remove. */
const NOT_EDITS = ['create_transaction', 'split_transaction', 'delete_transaction'];

describe('an edit of an uncached row never inserts it (rows the query omits, like split parents)', () => {
  test('every editing transaction write tool has a case', () => {
    const editTools = transactionWriteToolNames().filter((name) => !NOT_EDITS.includes(name));
    expect(editTools.length).toBeGreaterThan(0);
    expect(Object.keys(EDIT_OF_UNCACHED_ROW).sort()).toEqual(editTools);
  });

  test.each(Object.keys(EDIT_OF_UNCACHED_ROW))(
    '%s on a row absent from a cached month: the next read comes from the server',
    async (toolName) => {
      const c = EDIT_OF_UNCACHED_ROW[toolName]!;
      const { call, read, fetches } = setup(c.mocks);

      await read();
      expect(fetches()).toBe(1);

      await call(toolName, c.args);

      // The server (mocked by the same Transactions response) still omits the
      // parent. A refetch returns that truth; an insert would serve the parent
      // from the cache beside the rows it was split into.
      const after = await read();
      expect(after.transactions.map((r) => r.transaction_id)).not.toContain(TX_HIDDEN_PARENT);
      expect(fetches()).toBe(2 + (c.expectedWriteFetches ?? 0));
    }
  );
});

// ── A partial batch still writes through the rows that landed ───────────────
//
// The bulk tools throw when the server skips a row (unknown id, no failed[]
// entry) or rejects one (failed[]). Rows the server DID write must still reach
// both caches before that throw, or the caches claim they never changed.

const TX_UNKNOWN = 'zA1kX4oP7lM2tS9uW6yB';

/** Bulk response: TX_REVIEW updated, plus either a silent skip or a failed[] entry. */
function partialBulk(kind: 'skipped' | 'failed', overrides: Partial<CreatedTransaction>) {
  return {
    BulkEditTransactions: {
      bulkEditTransactions: {
        updated: [{ ...mutationNode(seedById(TX_REVIEW), overrides), parentId: null }],
        failed:
          kind === 'failed'
            ? [
                {
                  transaction: mutationNode(seedById(TX_BULK_1)),
                  error: 'synthetic rejection',
                  errorCode: 'SYNTHETIC',
                },
              ]
            : [],
      },
    },
  } satisfies MockResponsesByOp;
}

interface PartialCase {
  label: string;
  tool: string;
  mocks: MockResponsesByOp;
  args: Record<string, unknown>;
  expected: { live: Row; local: Row };
}

const PARTIAL_CASES: PartialCase[] = (['skipped', 'failed'] as const).flatMap((kind) => {
  const second = kind === 'skipped' ? TX_UNKNOWN : TX_BULK_1;
  const rows = [TX_REVIEW, second].map((id) => ({ ...routing, transaction_id: id }));
  return [
    {
      label: `review_transactions, one row ${kind}`,
      tool: 'review_transactions',
      mocks: partialBulk(kind, { isReviewed: false }),
      args: { rows, reviewed: false },
      expected: { live: { user_reviewed: false }, local: { user_reviewed: false } },
    },
    {
      label: `bulk_edit_transactions, one row ${kind}`,
      tool: 'bulk_edit_transactions',
      mocks: partialBulk(kind, { categoryId: CAT_NEW }),
      args: { rows, category_id: CAT_NEW },
      expected: { live: { category_id: CAT_NEW }, local: { category_id: CAT_NEW } },
    },
  ];
});

describe('a partial batch writes through the rows that landed', () => {
  test.each(PARTIAL_CASES.map((c) => [c.label, c] as const))(
    '%s: the landed row is in both caches despite the error',
    async (_label, c) => {
      const { call, read, local, fetches } = setup(c.mocks);
      await read();

      await expect(call(c.tool, c.args)).rejects.toThrow();

      const after = await read();
      expect(fetches()).toBe(1);
      const rows = new Map(after.transactions.map((r) => [r.transaction_id as string, r]));
      expect(rows.get(TX_REVIEW)).toMatchObject(c.expected.live);
      expect(local(TX_REVIEW)).toMatchObject(c.expected.local);
    }
  );

  // The failed edit drops the shared month (#832), so the live read comes from
  // the server; the landed edit is still in the local cache, and the failed
  // one is not.
  test('update_transactions: a failed edit drops its month; the landed one stays patched locally', async () => {
    const { call, read, local, fetches } = setup({
      EditTransaction: (vars) => {
        const v = vars as { id: string; input: EditTransactionInput };
        if (v.id === TX_BATCH_2) return new Error('synthetic failure');
        return { editTransaction: { transaction: applyEdit(v.id, v.input) } };
      },
    });
    await read();

    await expect(
      call('update_transactions', {
        edits: [
          { ...routing, transaction_id: TX_BATCH_1, category_id: CAT_NEW },
          { ...routing, transaction_id: TX_BATCH_2, category_id: CAT_NEW },
        ],
      })
    ).rejects.toThrow();

    const after = await read();
    expect(after._cache_hit).toBe(false);
    expect(fetches()).toBe(2);
    expect(local(TX_BATCH_1)).toMatchObject({ category_id: CAT_NEW });
    expect(local(TX_BATCH_2)).toMatchObject({ category_id: CAT_OLD });
  });

  // A transport timeout or GraphQL error may arrive after the server applied
  // some rows, and says nothing about which. The months holding the targeted
  // rows must be refetched, not served pre-write from the cache for a week.
  test.each(['review_transactions', 'bulk_edit_transactions'])(
    '%s: a bulk edit that throws leaves the next read to the server',
    async (tool) => {
      const { call, read, fetches } = setup({
        BulkEditTransactions: new Error('synthetic transport timeout'),
      });
      await read();

      const rows = [TX_BULK_1, TX_BULK_2].map((id) => ({ ...routing, transaction_id: id }));
      await expect(
        call(tool, tool === 'review_transactions' ? { rows } : { rows, category_id: CAT_NEW })
      ).rejects.toThrow();

      const after = await read();
      expect(after._cache_hit).toBe(false);
      expect(fetches()).toBe(2);
    }
  );
});

// ── A write that throws leaves the next read to the server (#832) ───────────
//
// A transport error or timeout can follow a write the server already applied,
// and nothing in the error says whether it did. Every transaction write tool's
// catch drops the cached month holding its target (create, which has no id
// yet, drops the month of its date), so the next read asks the server instead
// of serving the pre-write row from the cold tier for up to a week. Keyed by
// the same derived tool list as the table above: a new transaction write tool
// fails the first test until it has a case here.

const MUTATION_OP: Record<string, string> = {
  create_transaction: 'CreateTransaction',
  split_transaction: 'SplitTransaction',
  update_transaction: 'EditTransaction',
  update_transactions: 'EditTransaction',
  add_transaction_to_recurring: 'AddTransactionToRecurring',
  review_transactions: 'BulkEditTransactions',
  bulk_edit_transactions: 'BulkEditTransactions',
  delete_transaction: 'DeleteTransaction',
};

describe('a transaction write that throws leaves the next read to the server (#832)', () => {
  test('every transaction write tool names the mutation it throws from', () => {
    expect(Object.keys(MUTATION_OP).sort()).toEqual(transactionWriteToolNames());
  });

  test.each(Object.keys(MUTATION_OP))(
    '%s: the mutation throws, and the cached month is refetched',
    async (toolName) => {
      const c = CASES[toolName]!;
      const { call, read, fetches } = setup({
        [MUTATION_OP[toolName]!]: new Error('synthetic transport timeout'),
      });
      await read();
      expect(fetches()).toBe(1);

      await expect(call(toolName, c.args)).rejects.toThrow(/synthetic transport timeout/);

      const after = await read();
      expect(after._cache_hit).toBe(false);
      expect(fetches()).toBe(2 + (c.expectedWriteFetches ?? 0));
    }
  );

  test.each(Object.keys(MUTATION_OP))(
    '%s: a throw in the month drop still drops the derived snapshots (#911 review)',
    async (toolName) => {
      // invalidateAfterFailedWrite's drops are independent, so each is
      // guarded on its own: the first throwing must not skip the last.
      const { call, read, liveDb } = setup({
        [MUTATION_OP[toolName]!]: new Error('synthetic transport timeout'),
      });
      await read();
      const months = spyOn(liveDb, 'invalidateLiveTransactionMonths').mockImplementation(() => {
        throw new Error('housekeeping boom');
      });
      const derived = spyOn(liveDb, 'invalidateTransactionDerivedSnapshots');
      const log = spyOn(console, 'error').mockImplementation(() => {});
      let derivedCalls: number;
      let monthCalls: number;
      try {
        await expect(call(toolName, CASES[toolName]!.args)).rejects.toThrow(
          /synthetic transport timeout/
        );
      } finally {
        monthCalls = months.mock.calls.length;
        derivedCalls = derived.mock.calls.length;
        months.mockRestore();
        derived.mockRestore();
        log.mockRestore();
      }
      expect(monthCalls).toBeGreaterThan(0);
      expect(derivedCalls).toBeGreaterThan(0);
    }
  );
});

// ── Transaction writes drop the transaction-derived snapshots (#825) ───────
//
// On a manual account Copilot recomputes the balance from its transactions, so
// a transaction write can move it while get_accounts_live keeps serving the
// snapshot (1-hour TTL); the other snapshots that hold transaction-derived
// figures go stale the same way. Every transaction write drops each
// snapshot LiveCopilotDatabase.TRANSACTION_DERIVED_SNAPSHOTS names, on
// success and on a throw alike; same derived tool key set.

/** Every snapshot some write family drops: transaction-, recurring- or category-derived. */
type SnapshotKey =
  | (typeof LiveCopilotDatabase.TRANSACTION_DERIVED_SNAPSHOTS)[number]
  | (typeof LiveCopilotDatabase.RECURRING_DERIVED_SNAPSHOTS)[number]
  | (typeof LiveCopilotDatabase.CATEGORY_DERIVED_SNAPSHOTS)[number];

/**
 * How to warm and inspect each named snapshot. A key added to the list
 * without an entry here fails to compile; a probe pointed at the wrong cache
 * usually does too, through the loader's element type, though not between
 * the two recurring snapshots, whose node types are aliases.
 */
const SNAPSHOT_PROBES: Record<
  SnapshotKey,
  { warm(db: LiveCopilotDatabase): Promise<unknown>; peek(db: LiveCopilotDatabase): unknown }
> = {
  accounts: {
    warm: (db) => db.getAccountsCache().read(async () => [{ id: ACCOUNT_ID } as AccountNode]),
    peek: (db) => db.getAccountsCache().peek(),
  },
  networth: {
    warm: (db) =>
      db.getNetworthCache().read(async () => [{ date: SEED_DATE } as NetworthHistoryNode]),
    peek: (db) => db.getNetworthCache().peek(),
  },
  monthly_spend: {
    warm: (db) => db.getMonthlySpendCache().read(async () => [{ id: 'd1' } as DailySpendNode]),
    peek: (db) => db.getMonthlySpendCache().peek(),
  },
  upcoming_recurrings: {
    warm: (db) =>
      db
        .getUpcomingRecurringsCache()
        .read(async () => [{ id: RECURRING_ID } as UpcomingRecurringNode]),
    peek: (db) => db.getUpcomingRecurringsCache().peek(),
  },
  recurring: {
    warm: (db) => db.getRecurringCache().read(async () => [{ id: RECURRING_ID } as RecurringNode]),
    peek: (db) => db.getRecurringCache().peek(),
  },
  balance_history: {
    warm: async (db) => {
      const now = Date.now();
      db.getBalanceHistoryCache().set('probe', {
        rows: [],
        fetched_at: now,
        expires_at: now + 60_000,
      });
    },
    // Undefined once empty, like a dropped SnapshotCache.
    peek: (db) => (db.getBalanceHistoryCache().size > 0 ? true : undefined),
  },
};

/**
 * Warm the named snapshots (by default every transaction-derived one) so a
 * drop is observable. The one warm path for every test in this file.
 */
async function warmSnapshots(
  liveDb: LiveCopilotDatabase,
  keys: readonly SnapshotKey[] = LiveCopilotDatabase.TRANSACTION_DERIVED_SNAPSHOTS
): Promise<void> {
  for (const key of keys) {
    await SNAPSHOT_PROBES[key].warm(liveDb);
    expect({ key, warm: SNAPSHOT_PROBES[key].peek(liveDb) !== undefined }).toEqual({
      key,
      warm: true,
    });
  }
}

function expectSnapshotsDropped(liveDb: LiveCopilotDatabase): void {
  for (const key of LiveCopilotDatabase.TRANSACTION_DERIVED_SNAPSHOTS) {
    expect({ key, rows: SNAPSHOT_PROBES[key].peek(liveDb) }).toEqual({ key, rows: undefined });
  }
}

describe('a transaction write drops the transaction-derived snapshots (#825)', () => {
  test('every refresh_cache scope is classified: dropped by a transaction write, or exempt with a reason', () => {
    // The scope enum lists every refresh_cache scope; a new scope fails here
    // until it is put in one of the two lists. Scope-level, not cache-level: a
    // cache sharing an existing scope (investment_balance flushes two) is not
    // seen by this test.
    const scopeSchema = TOOL_REGISTRY.get('refresh_cache')!.schema.inputSchema.properties as {
      scope: { enum: string[] };
    };
    const scopes = scopeSchema.scope.enum.filter((sc) => sc !== 'all').sort();
    const dropped: readonly string[] = LiveCopilotDatabase.TRANSACTION_DERIVED_SNAPSHOTS;
    const exempt = Object.keys(LiveCopilotDatabase.SNAPSHOTS_NOT_DROPPED_BY_TRANSACTION_WRITES);
    expect(dropped.filter((k) => exempt.includes(k))).toEqual([]);
    expect([...dropped, ...exempt].sort()).toEqual(scopes);
    for (const reason of Object.values(
      LiveCopilotDatabase.SNAPSHOTS_NOT_DROPPED_BY_TRANSACTION_WRITES
    )) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  test.each(Object.keys(CASES))('%s: success drops them', async (toolName) => {
    const c = CASES[toolName]!;
    const { call, read, liveDb } = setup(c.mocks);
    await read();
    await warmSnapshots(liveDb);

    await call(toolName, c.args);

    expectSnapshotsDropped(liveDb);
  });

  test.each(Object.keys(MUTATION_OP))('%s: a throw drops them', async (toolName) => {
    const { call, read, liveDb } = setup({
      [MUTATION_OP[toolName]!]: new Error('synthetic transport timeout'),
    });
    await read();
    await warmSnapshots(liveDb);

    await expect(call(toolName, CASES[toolName]!.args)).rejects.toThrow(
      /synthetic transport timeout/
    );

    expectSnapshotsDropped(liveDb);
  });
});

// ── A throw also drops the month a write was moving rows INTO (#859 review) ──
//
// The id-keyed drop finds only the month a row is cached in now. A date edit,
// or a split whose children are dated elsewhere, may have landed in another
// cached month before the error; that month is named from the request.

const OTHER_COLD_MONTH = { start: '2025-02-01', end: '2025-02-28' };

describe('a throw drops the destination month too (#832)', () => {
  async function seedBoth(
    read: () => Promise<unknown>,
    call: (n: string, a: Record<string, unknown>) => Promise<unknown>
  ) {
    await read();
    await call('get_transactions_live', {
      start_date: OTHER_COLD_MONTH.start,
      end_date: OTHER_COLD_MONTH.end,
      limit: 10,
    });
  }

  const readOther = (call: (n: string, a: Record<string, unknown>) => Promise<unknown>) =>
    call('get_transactions_live', {
      start_date: OTHER_COLD_MONTH.start,
      end_date: OTHER_COLD_MONTH.end,
      limit: 10,
    }) as Promise<{ _cache_hit: boolean }>;

  /**
   * Every transaction write that can place a row in another month: exactly
   * the ones whose input schema carries a `date` (top level or in an array's
   * items). Derived, so a new date-taking write must join.
   */
  const DESTINATION_CASES: Record<string, Record<string, unknown>> = {
    create_transaction: { ...CASES.create_transaction!.args, date: '2025-02-10' },
    update_transaction: { ...routing, transaction_id: TX_UPDATE, date: '2025-02-10' },
    update_transactions: {
      edits: [{ ...routing, transaction_id: TX_BATCH_1, date: '2025-02-10' }],
    },
    split_transaction: {
      ...routing,
      transaction_id: TX_SPLIT_PARENT,
      splits: [
        { name: 'Part A', date: '2025-02-10', amount: 60, category_id: CAT_OLD },
        { name: 'Part B', date: '2025-02-11', amount: 40, category_id: CAT_NEW },
      ],
    },
  };

  test('every date-taking transaction write tool has a destination case', () => {
    const takesDate = (schema: unknown): boolean => {
      if (!schema || typeof schema !== 'object') return false;
      const sc = schema as { properties?: Record<string, unknown>; items?: unknown };
      if (sc.properties && 'date' in sc.properties) return true;
      return Object.values(sc.properties ?? {}).some(takesDate) || takesDate(sc.items);
    };
    const dateTools = transactionWriteToolNames().filter((name) =>
      takesDate(TOOL_REGISTRY.get(name)!.schema.inputSchema)
    );
    expect(Object.keys(DESTINATION_CASES).sort()).toEqual(dateTools);
  });

  test.each(Object.keys(DESTINATION_CASES))(
    '%s: the month the request moved rows into is refetched',
    async (toolName) => {
      const args = DESTINATION_CASES[toolName]!;
      const { call, read } = setup({
        [MUTATION_OP[toolName]!]: new Error('synthetic transport timeout'),
      });
      await seedBoth(read, call);
      expect((await readOther(call))._cache_hit).toBe(true);

      await expect(call(toolName, args as Record<string, unknown>)).rejects.toThrow(
        /synthetic transport timeout/
      );

      expect((await readOther(call))._cache_hit).toBe(false);
    }
  );
});

// ── A malformed returned row is never cached (#864 review) ─────────────────
//
// Mutation responses are validated warn-only, so a drifted one reaches the
// write path. The write must still report success, but its row must not be
// stored: every live read runs the tag mapper on every row of a month, so one
// stored row with no tags array would make each later read of that month
// throw. The month is dropped instead, and the next read refetches.

type RowDrift = (row: Record<string, unknown>) => Record<string, unknown>;

/**
 * The fields every read of a month dereferences on each of its rows, each
 * with the drift that breaks it: no tags array (the tag mapper and filter),
 * no name (the merchant mapper and name filter), a date that names no month
 * (month placement). Every tool runs every drift, so deleting any one of
 * isCacheableRow's clauses fails a row here.
 */
const ROW_DRIFTS: Record<string, RowDrift> = {
  'no tags array': ({ tags: _tags, ...rest }) => rest,
  'no name': ({ name: _name, ...rest }) => rest,
  'a blank date': (row) => ({ ...row, date: '' }),
};

const DRIFTED_ROW_TOOLS = [
  'create_transaction',
  'update_transaction',
  'update_transactions',
  'add_transaction_to_recurring',
  'split_transaction',
] as const;

/**
 * The tools above whose returned row is ALREADY CACHED: they edit a seeded
 * row, so a refused row has a good copy in the month that must be dropped,
 * and a field the response omits would be filled back from that copy if the
 * check ran after the merge. Every drift runs against these too.
 */
const CACHED_ROW_TOOLS: ReadonlySet<string> = new Set([
  'update_transaction',
  'update_transactions',
  'add_transaction_to_recurring',
]);

/**
 * A deep copy of a mutation response with `drift` applied to every
 * transaction row in it: an object carrying both `id` and `amount` (a tag or
 * a response envelope carries no `amount`).
 */
function withDriftedRows(v: unknown, drift: RowDrift): unknown {
  if (Array.isArray(v)) return v.map((x) => withDriftedRows(x, drift));
  if (v !== null && typeof v === 'object' && !(v instanceof Error)) {
    const copy = Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, withDriftedRows(x, drift)])
    );
    return 'id' in copy && 'amount' in copy ? drift(copy) : copy;
  }
  return v;
}

const driftRows = (mocks: MockResponsesByOp, drift: RowDrift): MockResponsesByOp =>
  Object.fromEntries(
    Object.entries(mocks).map(([op, m]) => [
      op,
      typeof m === 'function'
        ? (vars: unknown) => withDriftedRows((m as (v: unknown) => unknown)(vars), drift)
        : withDriftedRows(m, drift),
    ])
  ) as MockResponsesByOp;

const stripTags = (mocks: MockResponsesByOp): MockResponsesByOp =>
  driftRows(mocks, ROW_DRIFTS['no tags array']!);

describe('a malformed returned row is never cached (#864 review)', () => {
  test('the cached-row tools really edit rows the seeded month holds', () => {
    const seeded = new Set(SEED.map((r) => r.id));
    const cached = DRIFTED_ROW_TOOLS.filter((t) => CACHED_ROW_TOOLS.has(t));
    expect(cached.length).toBeGreaterThan(0);
    for (const tool of cached) {
      const args = CASES[tool]!.args as {
        transaction_id?: string;
        edits?: Array<{ transaction_id: string }>;
      };
      const ids = args.edits?.map((e) => e.transaction_id) ?? [args.transaction_id];
      for (const id of ids) expect(seeded.has(id ?? '')).toBe(true);
    }
  });

  test.each(
    Object.keys(ROW_DRIFTS).flatMap((drift) =>
      DRIFTED_ROW_TOOLS.map(
        (tool) => [tool, drift, CACHED_ROW_TOOLS.has(tool) ? 'a cached' : 'a new'] as const
      )
    )
  )(
    '%s: a response with %s on %s row succeeds, leaves the month uncached, and the next read refetches',
    async (toolName, drift) => {
      const c = CASES[toolName]!;
      const { call, read, fetches } = setup(driftRows(c.mocks, ROW_DRIFTS[drift]!));
      await read();

      // The write is reported as applied: only the live cache refuses the row.
      const result = (await call(toolName, c.args)) as { success?: unknown };
      expect(result.success).toBe(true);

      const after = await read();
      expect(after._cache_hit).toBe(false);
      expect(fetches()).toBe(2 + (c.expectedWriteFetches ?? 0));
    }
  );

  test.each(['', 'garbage'])(
    'update_transaction: a response with date %p succeeds, its month is dropped, and the next read is fresh',
    async (date) => {
      const { call, read, fetches } = setup({
        EditTransaction: (vars) => {
          const v = vars as { id: string; input: EditTransactionInput };
          return { editTransaction: { transaction: { ...applyEdit(v.id, v.input), date } } };
        },
      });
      await read();

      const result = (await call('update_transaction', CASES.update_transaction!.args)) as {
        success: boolean;
      };
      expect(result.success).toBe(true);

      const after = await read();
      expect(after._cache_hit).toBe(false);
      expect(fetches()).toBe(2 + (CASES.update_transaction!.expectedWriteFetches ?? 0));
      // Served from the refetch: the row is present, never silently missing.
      expect(after.transactions.some((r) => r.transaction_id === TX_UPDATE)).toBe(true);
    }
  );

  test('update_transaction: a date move whose response is refused drops the destination month too', async () => {
    // The row leaves March for February; the response drifts to an empty date,
    // so it names neither. February must not keep serving a month that should
    // now hold the row.
    const { call, read, fetches } = setup({
      EditTransaction: (vars) => {
        const v = vars as { id: string; input: EditTransactionInput };
        return { editTransaction: { transaction: { ...applyEdit(v.id, v.input), date: '' } } };
      },
    });
    await read();
    await call('get_transactions_live', {
      start_date: OTHER_COLD_MONTH.start,
      end_date: OTHER_COLD_MONTH.end,
      limit: 10,
    });
    expect(fetches()).toBe(2);

    await call('update_transaction', { ...routing, transaction_id: TX_UPDATE, date: '2025-02-10' });

    const other = (await call('get_transactions_live', {
      start_date: OTHER_COLD_MONTH.start,
      end_date: OTHER_COLD_MONTH.end,
      limit: 10,
    })) as { _cache_hit: boolean };
    expect(other._cache_hit).toBe(false);
    expect((await read())._cache_hit).toBe(false);
  });

  test('update_transaction: a response echoing a date outside the requested month drops both months (#874)', async () => {
    // The request moves the row from March to February; the response is
    // well-formed but still dated in March (a pre-edit echo). Filing it under
    // March would leave the cached February a silent short read.
    const { call, read, fetches } = setup({
      EditTransaction: (vars) => {
        const v = vars as { id: string; input: EditTransactionInput };
        return {
          editTransaction: { transaction: { ...applyEdit(v.id, v.input), date: SEED_DATE } },
        };
      },
    });
    await read();
    await call('get_transactions_live', {
      start_date: OTHER_COLD_MONTH.start,
      end_date: OTHER_COLD_MONTH.end,
      limit: 10,
    });
    expect(fetches()).toBe(2);

    const result = (await call('update_transaction', {
      ...routing,
      transaction_id: TX_UPDATE,
      date: '2025-02-10',
    })) as { success: boolean };
    expect(result.success).toBe(true);

    const other = (await call('get_transactions_live', {
      start_date: OTHER_COLD_MONTH.start,
      end_date: OTHER_COLD_MONTH.end,
      limit: 10,
    })) as { _cache_hit: boolean };
    expect(other._cache_hit).toBe(false);
    expect((await read())._cache_hit).toBe(false);
  });

  test('create_transaction: a row too malformed to cache still has its routing ids indexed', async () => {
    // The routing ids are independent of the fields the read mappers need, so
    // a follow-up write naming the new id resolves without a network fetch.
    const c = CASES.create_transaction!;
    const { call, liveDb } = setup(stripTags(c.mocks));

    await call('create_transaction', c.args);

    expect(liveDb.lookupTransactionMeta([TX_CREATED]).get(TX_CREATED)).toEqual({
      accountId: routing.account_id,
      itemId: routing.item_id,
    });
  });

  test('update_transaction: a response without tags still reports tag_ids as updated; the local cache keeps the requested list', async () => {
    // editTransaction reports the KEY tagIds whenever the request set tags,
    // even when the response carries no usable tags array, so the caller still
    // learns the write changed them. The two caches then differ by design: the
    // local one keeps the requested list (the best guess it has), while the
    // live month is dropped and refetches the server's truth.
    const c = CASES.update_transaction!;
    const { call, read, local } = setup(stripTags(c.mocks));
    await read();

    const result = (await call('update_transaction', c.args)) as {
      success: boolean;
      updated: string[];
    };

    expect(result.success).toBe(true);
    expect(result.updated).toContain('tag_ids');
    expect(local(TX_UPDATE)!.tag_ids).toEqual([TAG_ID]);
    expect((await read())._cache_hit).toBe(false);
  });

  test.each(
    (['review_transactions', 'bulk_edit_transactions'] as const).flatMap((tool) =>
      [
        ['null elements in updated/failed', { updated: [null], failed: [null] }] as const,
        ['updated/failed that are not arrays', { updated: null, failed: null }] as const,
      ].map(([label, payload]) => [tool, label, payload] as const)
    )
  )(
    '%s: a response with %s is reported as not applied, not thrown on, and the month is refetched',
    async (tool, _label, payload) => {
      const { call, read, fetches } = setup({
        BulkEditTransactions: { bulkEditTransactions: payload as never },
      });
      await read();

      const rows = [TX_BULK_1, TX_BULK_2].map((id) => ({ ...routing, transaction_id: id }));
      await expect(
        call(tool, tool === 'review_transactions' ? { rows } : { rows, category_id: CAT_NEW })
      ).rejects.toThrow(/did not apply/);

      const after = await read();
      expect(after._cache_hit).toBe(false);
      expect(fetches()).toBe(2);
    }
  );
});

// ── Every write drops what its family derives (#868, #870) ──────────────────
//
// A write that changes what a live snapshot is computed from must drop that
// snapshot, or the snapshot keeps serving pre-write figures until its TTL.
// #825 fixed it for transaction writes; recurring writes still left
// upcoming_recurrings stale (#868), and no write could reach
// get_balance_history_live's cache (#870). The class is "a write and a
// derived snapshot nobody paired", so the detector pairs them all: every
// write tool in WRITE_TOOL_DEFS is given a family, every family names the
// snapshots it drops, and each case warms EVERY probed snapshot, runs the
// write, and asserts exactly its family's snapshots were dropped. A new write
// tool fails the first test until it is classified; a new derived snapshot
// fails the scope-classification tests until a family list names it or
// exempts it with a reason.

type WriteFamily = 'transaction' | 'recurring' | 'category' | 'category_create' | 'tag';

/**
 * Whether a write reaches transaction rows its response does not name, by a
 * field those rows carry (#911 review). `row` is what a linked cached row
 * looks like; `args` overrides the table's args when only some calls reach
 * them. Required on every write (null = reaches none), so a new write tool is
 * asked this as well as its family.
 */
interface LinkedRows {
  row: Partial<TransactionNode>;
  args?: Record<string, unknown>;
}

const FAMILY_DROPS: Record<WriteFamily, readonly SnapshotKey[]> = {
  transaction: LiveCopilotDatabase.TRANSACTION_DERIVED_SNAPSHOTS,
  recurring: LiveCopilotDatabase.RECURRING_DERIVED_SNAPSHOTS,
  // update_category, delete_category, set_budget: monthly spend's budget
  // comparison and its category-based exclusions (#911 review).
  category: LiveCopilotDatabase.CATEGORY_DERIVED_SNAPSHOTS,
  // A new category holds no rows yet, so no monthly-spend input moves.
  category_create: [],
  // Empty, but a list: a snapshot computed from tags must be classified in
  // SNAPSHOTS_NOT_DROPPED_BY_TAG_WRITES or added here.
  tag: LiveCopilotDatabase.TAG_DERIVED_SNAPSHOTS,
};

const RECURRING_RESPONSE = {
  id: RECURRING_ID,
  name: 'Gym',
  categoryId: CAT_OLD,
  frequency: 'MONTHLY',
  state: 'ACTIVE',
};

/** Success mocks and arguments for every write that is not a transaction write. */
const NON_TRANSACTION_WRITES: Record<
  string,
  {
    family: Exclude<WriteFamily, 'transaction'>;
    mocks: MockResponsesByOp;
    args: Record<string, unknown>;
    linked: LinkedRows | null;
  }
> = {
  create_recurring: {
    family: 'recurring',
    mocks: {
      CreateRecurring: {
        createRecurring: { id: RECURRING_ID, name: 'Gym', state: 'ACTIVE', frequency: 'MONTHLY' },
      },
    },
    args: { ...routing, transaction_id: TX_RECURRING, frequency: 'MONTHLY' },
    // Its seed row is named by id; dropped by its own test above.
    linked: null,
  },
  update_recurring: {
    family: 'recurring',
    mocks: { EditRecurring: { editRecurring: { recurring: RECURRING_RESPONSE } } },
    args: { recurring_id: RECURRING_ID, name: 'Gym' },
    // Only a category change reaches the series' rows.
    linked: {
      row: { recurringId: RECURRING_ID },
      args: { recurring_id: RECURRING_ID, category_id: CAT_NEW },
    },
  },
  set_recurring_state: {
    family: 'recurring',
    mocks: {
      EditRecurring: { editRecurring: { recurring: { ...RECURRING_RESPONSE, state: 'PAUSED' } } },
    },
    args: { recurring_id: RECURRING_ID, state: 'PAUSED' },
    // A state change does not touch the series' rows.
    linked: null,
  },
  delete_recurring: {
    family: 'recurring',
    mocks: { DeleteRecurring: { deleteRecurring: true } },
    args: { recurring_id: RECURRING_ID },
    linked: { row: { recurringId: RECURRING_ID } },
  },
  create_category: {
    // Not 'category': a new category holds no rows, so no monthly-spend input moves.
    family: 'category_create',
    mocks: {
      CreateCategory: {
        createCategory: { id: 'bN4mV7cX1zL8kJ5hG2fD', name: 'Pets', colorName: 'BLUE1' },
      },
    },
    args: { name: 'Pets', color_name: 'BLUE1', emoji: '🐶' },
    // A new category holds no rows.
    linked: null,
  },
  update_category: {
    family: 'category',
    mocks: {
      EditCategory: {
        editCategory: { category: { id: CAT_OLD, name: 'Food', colorName: 'RED1' } },
      },
    },
    args: { category_id: CAT_OLD, name: 'Food' },
    // category_name and excluded are projected from the categories list, not stored.
    linked: null,
  },
  delete_category: {
    family: 'category',
    mocks: { DeleteCategory: { deleteCategory: true } },
    args: { category_id: CAT_NEW },
    linked: { row: { categoryId: CAT_NEW } },
  },
  set_budget: {
    family: 'category',
    mocks: { EditBudget: { editCategoryBudget: true } },
    args: { category_id: CAT_OLD, amount: '100' },
    // A budget lives on the category, not on rows.
    linked: null,
  },
  create_tag: {
    family: 'tag',
    mocks: {
      CreateTag: { createTag: { id: 'dF6gH9jK2lZ5xC8vB1nM', name: 'Work', colorName: 'RED1' } },
    },
    args: { name: 'Work', color_name: 'RED1' },
    // A new tag is on no rows.
    linked: null,
  },
  update_tag: {
    family: 'tag',
    mocks: { EditTag: { editTag: { ...TAG_NODE, name: 'Trip 2' } } },
    args: { tag_id: TAG_ID, name: 'Trip 2' },
    // Rows carry tag ids, which a rename does not change.
    linked: null,
  },
  delete_tag: {
    family: 'tag',
    mocks: { DeleteTag: { deleteTag: true } },
    args: { tag_id: TAG_ID },
    linked: { row: { tags: [TAG_NODE] } },
  },
};

/** Every write tool, its family, and how to run it successfully. */
const WRITE_TABLE: Readonly<
  Record<
    string,
    {
      family: WriteFamily;
      mocks: MockResponsesByOp;
      args: Record<string, unknown>;
      linked: LinkedRows | null;
    }
  >
> = {
  ...NON_TRANSACTION_WRITES,
  ...Object.fromEntries(
    Object.entries(CASES).map(([name, c]) => [
      name,
      // A transaction write names its rows; its own write-through covers them.
      { family: 'transaction' as const, mocks: c.mocks, args: c.args, linked: null },
    ])
  ),
};

describe('every write drops the snapshots its family derives (#868, #870)', () => {
  test('every write tool in the registry is classified, and only those', () => {
    const writeTools = WRITE_TOOL_DEFS.map((def) => def.name).sort();
    expect(writeTools.length).toBeGreaterThan(0);
    expect(Object.keys(WRITE_TABLE).sort()).toEqual(writeTools);
    // No tool in both source tables: the spread would silently make it a
    // transaction write with the key set unchanged.
    expect(Object.keys(WRITE_TABLE).length).toBe(
      Object.keys(NON_TRANSACTION_WRITES).length + Object.keys(CASES).length
    );
  });

  test("every derived snapshot has a probe, and every probe is some family's", () => {
    const derived = new Set<string>(Object.values(FAMILY_DROPS).flat());
    expect(Object.keys(SNAPSHOT_PROBES).sort()).toEqual([...derived].sort());
  });

  test.each([
    [
      'recurring',
      LiveCopilotDatabase.RECURRING_DERIVED_SNAPSHOTS,
      LiveCopilotDatabase.SNAPSHOTS_NOT_DROPPED_BY_RECURRING_WRITES,
    ],
    [
      'category',
      LiveCopilotDatabase.CATEGORY_DERIVED_SNAPSHOTS,
      LiveCopilotDatabase.SNAPSHOTS_NOT_DROPPED_BY_CATEGORY_WRITES,
    ],
    [
      'tag',
      LiveCopilotDatabase.TAG_DERIVED_SNAPSHOTS,
      LiveCopilotDatabase.SNAPSHOTS_NOT_DROPPED_BY_TAG_WRITES,
    ],
  ] as const)(
    'every refresh_cache scope is classified for %s writes too',
    (_family, droppedList, exemptions) => {
      const scopeSchema = TOOL_REGISTRY.get('refresh_cache')!.schema.inputSchema.properties as {
        scope: { enum: string[] };
      };
      const scopes = scopeSchema.scope.enum.filter((sc) => sc !== 'all').sort();
      const dropped: readonly string[] = droppedList;
      const exempt = Object.keys(exemptions);
      expect(dropped.filter((k) => exempt.includes(k))).toEqual([]);
      expect([...dropped, ...exempt].sort()).toEqual(scopes);
      for (const reason of Object.values(exemptions)) {
        expect(reason.length).toBeGreaterThan(0);
      }
    }
  );

  test.each(Object.keys(WRITE_TABLE))(
    "%s: success drops exactly its family's snapshots",
    async (toolName) => {
      const c = WRITE_TABLE[toolName]!;
      const { call, read, liveDb } = setup(c.mocks);
      await read();
      const keys = Object.keys(SNAPSHOT_PROBES) as SnapshotKey[];
      await warmSnapshots(liveDb, keys);

      await call(toolName, c.args);

      const dropped = keys.filter((key) => SNAPSHOT_PROBES[key].peek(liveDb) === undefined);
      expect(dropped.sort()).toEqual([...FAMILY_DROPS[c.family]].sort());
    }
  );

  test("create_recurring drops its seed transaction's cached month (#911 review)", async () => {
    // The seed row joins the series server-side (unverified:
    // Mutation.createRecurring:links-seed-transaction), so the next read of
    // its month goes to the server rather than serving it unlinked.
    const c = WRITE_TABLE.create_recurring!;
    const { call, read, fetches } = setup(c.mocks);
    await read();
    expect((await read())._cache_hit).toBe(true);
    const before = fetches();

    await call('create_recurring', c.args);

    expect((await read())._cache_hit).toBe(false);
    expect(fetches()).toBeGreaterThan(before);
  });

  test('create_recurring links its seed row in the local cache too (#911 review)', async () => {
    const c = WRITE_TABLE.create_recurring!;
    const { call, local } = setup(c.mocks);
    expect(local(TX_RECURRING)?.recurring_id).toBeUndefined();

    await call('create_recurring', c.args);

    expect(local(TX_RECURRING)?.recurring_id).toBe(RECURRING_ID);
  });

  test("a create_recurring that may have applied drops the seed row's month too (#911 review)", async () => {
    const { call, read, fetches } = setup({
      CreateRecurring: unusablePayloadError('CreateRecurring', 'createRecurring', null),
    });
    await read();
    const before = fetches();

    await expect(call('create_recurring', WRITE_TABLE.create_recurring!.args)).rejects.toThrow();

    expect((await read())._cache_hit).toBe(false);
    expect(fetches()).toBeGreaterThan(before);
  });

  test("a create_recurring that cannot have written keeps the seed row's month (#911 review)", async () => {
    const rejected = new GraphQLError('USER_ACTION_REQUIRED', 'nope', 'CreateRecurring', 200, [], {
      requestReachedServer: true,
    });
    const { call, read } = setup({ CreateRecurring: rejected });
    await read();

    await expect(call('create_recurring', WRITE_TABLE.create_recurring!.args)).rejects.toThrow();

    expect((await read())._cache_hit).toBe(true);
  });

  /**
   * Writes whose response names no transactions but whose effect reaches
   * every row linked to the entity (#911 review): each must drop the cached
   * months holding such a row. `link` makes one cached row linked.
   */
  const LINKED_ROW_WRITES: Array<
    [string, MockResponsesByOp, Record<string, unknown>, Partial<TransactionNode>]
  > = Object.entries(WRITE_TABLE).flatMap(([name, c]) =>
    c.linked === null ? [] : [[name, c.mocks, c.linked.args ?? c.args, c.linked.row]]
  );

  test('the linked-row writes are the ones expected (#911 review)', () => {
    expect(LINKED_ROW_WRITES.map(([name]) => name).sort()).toEqual([
      'delete_category',
      'delete_recurring',
      'delete_tag',
      'update_recurring',
    ]);
  });

  /** Warm the cold month, link one cached row, and confirm it is still cached. */
  async function warmLinked(mocks: MockResponsesByOp, link: Partial<TransactionNode>) {
    const env = setup(mocks);
    await env.read();
    // A read-shaped row; the write-through takes the mutation row type.
    env.liveDb.upsertLiveTransaction({ ...seedById(TX_UPDATE), ...link } as never);
    expect((await env.read())._cache_hit).toBe(true);
    return env;
  }

  test.each(LINKED_ROW_WRITES)(
    '%s: success drops the cached months of the rows it links (#911 review)',
    async (toolName, mocks, args, link) => {
      const { call, read } = await warmLinked(mocks, link);
      await call(toolName, args);
      expect((await read())._cache_hit).toBe(false);
    }
  );

  test.each(LINKED_ROW_WRITES)(
    '%s: a failure that may have applied drops them too (#911 review)',
    async (toolName, mocks, args, link) => {
      const op = Object.keys(mocks)[0]!;
      const field = Object.keys((mocks as Record<string, object>)[op]!)[0]!;
      const { call, read } = await warmLinked(
        { [op]: unusablePayloadError(op, field, null) },
        link
      );
      await expect(call(toolName, args)).rejects.toThrow();
      expect((await read())._cache_hit).toBe(false);
    }
  );

  test.each(LINKED_ROW_WRITES)(
    '%s: a rejection that cannot have written keeps them (#911 review)',
    async (toolName, mocks, args, link) => {
      const op = Object.keys(mocks)[0]!;
      const rejected = new GraphQLError('USER_ACTION_REQUIRED', 'nope', op, 200, [], {
        requestReachedServer: true,
      });
      const { call, read } = await warmLinked({ [op]: rejected }, link);
      await expect(call(toolName, args)).rejects.toThrow();
      expect((await read())._cache_hit).toBe(true);
    }
  );

  /**
   * Catch-path housekeeping must not mask the write's own error, which
   * carries the "may have applied" signal (#875/#887). A throw inside the
   * month scan is logged and the GraphQL error still reaches the caller.
   */
  async function rejectionWithFailingHousekeeping(
    run: () => Promise<unknown>,
    liveDb: LiveCopilotDatabase,
    method:
      | 'invalidateLiveMonthsMatching'
      | 'invalidateLiveTransactionMonths'
      | 'invalidateRecurringDerivedSnapshots'
  ): Promise<Error> {
    const scan = spyOn(liveDb, method).mockImplementation(() => {
      throw new Error('housekeeping boom');
    });
    const log = spyOn(console, 'error').mockImplementation(() => {});
    let err: Error | undefined;
    let scanned: number;
    let traced: string[];
    try {
      await run();
    } catch (e) {
      err = e as Error;
    } finally {
      // Restore first, so a failed assertion cannot leave console.error muted.
      scanned = scan.mock.calls.length;
      traced = log.mock.calls.map((c) => String(c[0]));
      scan.mockRestore();
      log.mockRestore();
    }
    // Asserted after the finally, so a write that unexpectedly resolves
    // reports that, rather than a housekeeping assertion standing in for it.
    if (err === undefined) throw new Error('expected the write to throw');
    expect(scanned).toBeGreaterThan(0);
    // The trace is half the wrapper's contract: a swallowed failure is logged.
    expect(
      traced.some((m) => m.includes('live-cache invalidation after a failed write threw'))
    ).toBe(true);
    return err;
  }

  test.each(LINKED_ROW_WRITES)(
    "%s: a throw in the linked-row scan does not mask the write's error (#911 review)",
    async (toolName, mocks, args, link) => {
      const op = Object.keys(mocks)[0]!;
      const field = Object.keys((mocks as Record<string, object>)[op]!)[0]!;
      const { call, liveDb } = await warmLinked(
        { [op]: unusablePayloadError(op, field, null) },
        link
      );
      const err = await rejectionWithFailingHousekeeping(
        () => call(toolName, args),
        liveDb,
        'invalidateLiveMonthsMatching'
      );
      expect(err.message).not.toContain('housekeeping boom');
      expect(err.cause).toBeInstanceOf(GraphQLError);
    }
  );

  test("create_recurring: a throw in the seed-month drop does not mask the write's error (#911 review)", async () => {
    const { call, read, liveDb } = setup({
      CreateRecurring: unusablePayloadError('CreateRecurring', 'createRecurring', null),
    });
    await read();
    const err = await rejectionWithFailingHousekeeping(
      () => call('create_recurring', WRITE_TABLE.create_recurring!.args),
      liveDb,
      'invalidateLiveTransactionMonths'
    );
    expect(err.message).not.toContain('housekeeping boom');
    expect(err.cause).toBeInstanceOf(GraphQLError);
  });

  test("delete_recurring: a throw in the derived-snapshot drop does not mask the write's error (#911 review)", async () => {
    const { call, read, liveDb } = setup({
      DeleteRecurring: unusablePayloadError('DeleteRecurring', 'deleteRecurring', null),
    });
    await read();
    const err = await rejectionWithFailingHousekeeping(
      () => call('delete_recurring', { recurring_id: RECURRING_ID }),
      liveDb,
      'invalidateRecurringDerivedSnapshots'
    );
    expect(err.message).not.toContain('housekeeping boom');
    expect(err.cause).toBeInstanceOf(GraphQLError);
  });

  test('update_recurring without a category keeps the linked rows cached (#911 review)', async () => {
    const { call, read } = await warmLinked(NON_TRANSACTION_WRITES.update_recurring!.mocks, {
      recurringId: RECURRING_ID,
    });
    await call('update_recurring', { recurring_id: RECURRING_ID, name: 'Gym' });
    expect((await read())._cache_hit).toBe(true);
  });

  test('get_balance_history_live refetches after a transaction write (#870)', async () => {
    let historyFetches = 0;
    const { call, read, liveDb } = setup({
      ...CASES.update_transaction!.mocks,
      BalanceHistory: () => {
        historyFetches += 1;
        return { accountBalanceHistory: [{ date: SEED_DATE, balance: 5000 }] };
      },
    });
    await read();
    const history = new LiveBalanceHistoryTools(liveDb);
    const args = { item_id: ITEM_ID, account_id: ACCOUNT_ID };
    expect((await history.getBalanceHistory(args))._cache_hit).toBe(false);
    expect((await history.getBalanceHistory(args))._cache_hit).toBe(true);

    await call('update_transaction', CASES.update_transaction!.args);

    expect((await history.getBalanceHistory(args))._cache_hit).toBe(false);
    expect(historyFetches).toBe(2);
  });
});
