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

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { monthsCovered } from '../../src/utils/date.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { TransactionMetaStore } from '../../src/core/persistence/transaction-meta-store.js';
import { LiveTransactionsTools } from '../../src/tools/live/transactions.js';
import { TOOL_REGISTRY, WRITE_TOOL_DEFS } from '../../src/tools/registry/index.js';
import * as transactionRegistry from '../../src/tools/registry/transactions.js';
import type { LiveToolContext, ToolContext } from '../../src/tools/registry/types.js';
import type { TransactionNode } from '../../src/core/graphql/queries/transactions.js';
import type {
  CreatedTransaction,
  EditTransactionInput,
  TransactionType,
} from '../../src/core/graphql/transactions.js';
import { createMockGraphQLClient, type MockResponsesByOp } from '../helpers/mock-graphql.js';

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
].map((id) => seedNode(id));

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
  const db = new CopilotDatabase('/nonexistent');
  (db as any).dbPath = '/fake';
  // The local (LevelDB-model) cache holds the same rows, so a partial batch can
  // be checked against both caches.
  (db as any)._transactions = SEED.map((n) => ({
    transaction_id: n.id,
    account_id: n.accountId,
    item_id: n.itemId,
    category_id: n.categoryId,
    user_reviewed: n.isReviewed,
    tag_ids: [],
    amount: n.amount,
    date: n.date,
    name: n.name,
  }));
  (db as any)._allCollectionsLoaded = true;
  (db as any)._cacheLoadedAt = Date.now();
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
    ((db as any)._transactions as Array<Record<string, unknown>>).find(
      (t) => t.transaction_id === id
    );
  return { call, read, local, fetches: () => transactionsFetches };
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
        { ...routing, transaction_id: TX_BATCH_1, type: 'INCOME' as TransactionType },
        {
          ...routing,
          transaction_id: TX_BATCH_2,
          category_id: CAT_NEW,
          reviewed: false,
          note: 'batch note',
          tag_ids: [TAG_ID],
        },
      ],
    },
    verify: (rows) => {
      expect(rows.get(TX_BATCH_1)).toMatchObject({ type: 'INCOME', category_id: null });
      expect(rows.get(TX_BATCH_2)).toMatchObject({
        category_id: CAT_NEW,
        user_reviewed: false,
        user_notes: 'batch note',
        tag_ids: [TAG_ID],
      });
    },
  },

  add_transaction_to_recurring: {
    mocks: {
      AddTransactionToRecurring: {
        addTransactionToRecurring: {
          transaction: mutationNode(seedById(TX_RECURRING), { recurringId: RECURRING_ID }),
        },
      },
    },
    args: { ...routing, transaction_id: TX_RECURRING, recurring_id: RECURRING_ID },
    verify: (rows) => {
      expect(rows.get(TX_RECURRING)).toMatchObject({ recurring_id: RECURRING_ID });
    },
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

  bulk_edit_transactions: {
    mocks: {
      BulkEditTransactions: {
        bulkEditTransactions: {
          updated: [TX_BULK_1, TX_BULK_2].map((id) => ({
            ...mutationNode(seedById(id), {
              categoryId: CAT_NEW,
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
      category_id: CAT_NEW,
      reviewed: false,
      add_tag_ids: [TAG_ID],
    },
    verify: (rows) => {
      for (const id of [TX_BULK_1, TX_BULK_2]) {
        expect(rows.get(id)).toMatchObject({
          category_id: CAT_NEW,
          user_reviewed: false,
          tag_ids: [TAG_ID],
        });
      }
    },
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
  { mocks: MockResponsesByOp; args: Record<string, unknown> }
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

describe('an edit of an uncached row never inserts it (split parents)', () => {
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
      expect(fetches()).toBe(2);
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

  test('update_transactions: a failed edit does not stop a landed one being written through', async () => {
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
    expect(fetches()).toBe(1);
    const rows = new Map(after.transactions.map((r) => [r.transaction_id as string, r]));
    expect(rows.get(TX_BATCH_1)).toMatchObject({ category_id: CAT_NEW });
    expect(rows.get(TX_BATCH_2)).toMatchObject({ category_id: CAT_OLD });
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
