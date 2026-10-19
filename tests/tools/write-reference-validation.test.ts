/**
 * Every write that stores a category id validates it, and every write that
 * sends a date validates it as a real calendar date — both before anything is
 * sent (#846, #825).
 *
 * Copilot stores an unknown category id verbatim: bulkEditTransactions does
 * (ledger: Mutation.bulkEditTransactions:no-referential-validation), and so
 * does createTransaction (Mutation.createTransaction:no-referential-validation,
 * the 2026-10-18 parity run). The row then points at no category and the web
 * shows none. A well-formed impossible date (2026-02-30) reached the server,
 * whose 400 was reported as possible API drift.
 *
 * Both tables are keyed by the write tools whose input schema carries the
 * field, derived from WRITE_TOOL_DEFS, so a new write tool that takes a
 * category_id or a date fails the first test until it joins the table (or is
 * exempted with a reason). Each case runs through the tool's registry handler
 * against a real LiveCopilotDatabase, the way the shipped server runs writes
 * (--write implies --live-reads), and pairs the rejection with a control: the
 * same call with a known id / real date must reach the mutation, so a case
 * cannot pass by failing for some other reason.
 */

import { describe, test, expect, afterAll, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { TransactionMetaStore } from '../../src/core/persistence/transaction-meta-store.js';
import { TOOL_REGISTRY, WRITE_TOOL_DEFS } from '../../src/tools/registry/index.js';
import type { LiveToolContext, ToolContext } from '../../src/tools/registry/types.js';
import { createMockGraphQLClient, liveCategoryMocks } from '../helpers/mock-graphql.js';

// Firestore-shaped opaque ids.
const ACCOUNT_ID = 'Qw8eR3tY6uI1oP4aS7dF';
const ITEM_ID = 'Gh2jK5lZ8xC1vB4nM7qW';
const TX_ID = 'Er6tY9uI2oP5aS8dF1gH';
const TX_ID_2 = 'Jk3lZ6xC9vB2nM5qW8eR';
const RECURRING_ID = 'Ty4uI7oP1aS4dF7gH0jK';
const CAT_KNOWN = 'Lz5xC8vB1nM4qW7eR0tY';
/** Well-formed (passes the id-shape check) but in no category list. */
const CAT_UNKNOWN = 'Ui9oP2aS5dF8gH1jK4lZ';
const TAG_IN_LIST = 'Tk4lZ7xC0vB3nM6qW9eR';
const TAG_UNKNOWN = 'Tu7iO0pA3sD6fG9hJ2kL';

const META_DIR = mkdtempSync(join(tmpdir(), 'write-reference-validation-'));
afterAll(() => rmSync(META_DIR, { recursive: true, force: true }));

const routing = { account_id: ACCOUNT_ID, item_id: ITEM_ID };

/** Operations a write may send BEFORE its mutation: reference and window reads. */
const READ_OPS = new Set(['Categories', 'User', 'Tags', 'Transactions', 'Recurrings']);

/** Every mutation answers with an error: the control only needs to see it sent. */
const MUTATION_OPS = [
  'CreateTransaction',
  'SplitTransaction',
  'EditTransaction',
  'BulkEditTransactions',
  'EditRecurring',
  'EditBudget',
  'EditBudgetMonthly',
  'EditCategory',
  'DeleteCategory',
] as const;

function setup() {
  const mutationMocks = Object.fromEntries(
    MUTATION_OPS.map((op) => [op, new Error('synthetic: mutation reached the server')])
  );
  const client = createMockGraphQLClient({
    ...liveCategoryMocks([CAT_KNOWN]),
    Tags: { tags: [{ id: TAG_IN_LIST, name: 'Trip', colorName: 'BLUE1' }] },
    Transactions: {
      transactions: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } },
    },
    ...mutationMocks,
  });
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
  const ctx: ToolContext = {
    tools: new CopilotMoneyTools(db, client, liveDb),
    live: {} as LiveToolContext,
  };
  const call = (name: string, args: Record<string, unknown>) => {
    const def = TOOL_REGISTRY.get(name);
    if (!def) throw new Error(`unknown tool ${name}`);
    return def.handler(ctx, args);
  };
  const mutationsSent = () => client._calls.filter((c) => !READ_OPS.has(c.op)).map((c) => c.op);
  return { call, mutationsSent };
}

/**
 * Write tools whose input schema has, at any depth, a property named `key` —
 * or, for a RegExp, any property whose name matches it, so `start_date` or
 * `budget_month` on a future write tool joins the date tables too.
 */
function writeToolsTaking(key: string | RegExp): string[] {
  const matches = (name: string) => (typeof key === 'string' ? name === key : key.test(name));
  const has = (schema: unknown): boolean => {
    if (!schema || typeof schema !== 'object') return false;
    const s = schema as { properties?: Record<string, unknown>; items?: unknown };
    if (s.properties && Object.keys(s.properties).some(matches)) return true;
    return Object.values(s.properties ?? {}).some(has) || has(s.items);
  };
  return WRITE_TOOL_DEFS.filter((def) => has(def.schema.inputSchema))
    .map((def) => def.name)
    .sort();
}

// ── category_id ─────────────────────────────────────────────────────────────

/** Args for one write, with `categoryId` in its category_id position. */
const CATEGORY_CASES: Record<string, (categoryId: string) => Record<string, unknown>> = {
  create_transaction: (categoryId) => ({
    ...routing,
    name: 'Corner Bakery',
    date: '2025-03-20',
    amount: 42,
    category_id: categoryId,
    type: 'REGULAR',
  }),
  split_transaction: (categoryId) => ({
    ...routing,
    transaction_id: TX_ID,
    // Explicit name/date: the parent is not resolvable here, and needs not be.
    splits: [
      { name: 'Part A', date: '2025-03-12', amount: 60, category_id: CAT_KNOWN },
      { name: 'Part B', date: '2025-03-12', amount: 40, category_id: categoryId },
    ],
  }),
  update_transaction: (categoryId) => ({
    ...routing,
    transaction_id: TX_ID,
    category_id: categoryId,
  }),
  update_transactions: (categoryId) => ({
    edits: [
      { ...routing, transaction_id: TX_ID, category_id: CAT_KNOWN },
      { ...routing, transaction_id: TX_ID_2, category_id: categoryId },
    ],
  }),
  bulk_edit_transactions: (categoryId) => ({
    rows: [{ ...routing, transaction_id: TX_ID }],
    category_id: categoryId,
  }),
  update_recurring: (categoryId) => ({ recurring_id: RECURRING_ID, category_id: categoryId }),
  set_budget: (categoryId) => ({ category_id: categoryId, amount: '100' }),
};

/**
 * Write tools whose category_id names the record being written rather than a
 * reference stored on another one. The server resolves the id to find its
 * target, so an unknown id cannot leave a row pointing at nothing.
 */
const CATEGORY_EXEMPT: Record<string, string> = {
  update_category: 'category_id is the category being edited, not a stored reference',
  delete_category: 'category_id is the category being deleted, not a stored reference',
};

describe('category_id is validated on every write that stores one (#846)', () => {
  test('every write tool taking a category_id has a case or a stated exemption', () => {
    const taking = writeToolsTaking(/(^|_)category_id$/);
    expect(taking.length).toBeGreaterThan(0);
    const covered = [...Object.keys(CATEGORY_CASES), ...Object.keys(CATEGORY_EXEMPT)].sort();
    expect(covered).toEqual(taking);
  });

  test.each(Object.keys(CATEGORY_CASES))(
    '%s: an unknown category id is rejected with nothing sent',
    async (tool) => {
      const { call, mutationsSent } = setup();
      await expect(call(tool, CATEGORY_CASES[tool]!(CAT_UNKNOWN))).rejects.toThrow(
        `Category not found: ${CAT_UNKNOWN}`
      );
      expect(mutationsSent()).toEqual([]);
    }
  );

  test.each(Object.keys(CATEGORY_CASES))(
    '%s: control — a known category id reaches the mutation',
    async (tool) => {
      const { call, mutationsSent } = setup();
      await expect(call(tool, CATEGORY_CASES[tool]!(CAT_KNOWN))).rejects.toThrow(
        /mutation reached the server/
      );
      expect(mutationsSent().length).toBeGreaterThan(0);
    }
  );

  test('set_budget: clearing (amount 0) skips the check, so a deleted category can be cleared', async () => {
    const { call, mutationsSent } = setup();
    await expect(call('set_budget', { category_id: CAT_UNKNOWN, amount: '0' })).rejects.toThrow(
      /mutation reached the server/
    );
    expect(mutationsSent()).toEqual(['EditBudget']);
  });
});

// ── tag ids ─────────────────────────────────────────────────────────────────
//
// The same rule for the other reference type: Copilot drops an unknown tag id
// silently, so every write that takes tag ids validates them first.

/**
 * Args for one write, with `tagId` in one tag-id field. Keyed by
 * `<tool>.<field>`, so a tool taking two tag lists (bulk edit's add and
 * remove) needs a case for each.
 */
const TAG_CASES: Record<string, (tagId: string) => Record<string, unknown>> = {
  'create_transaction.tag_ids': (tagId) => ({
    ...CATEGORY_CASES.create_transaction!(CAT_KNOWN),
    tag_ids: [tagId],
  }),
  'update_transaction.tag_ids': (tagId) => ({
    ...routing,
    transaction_id: TX_ID,
    tag_ids: [tagId],
  }),
  'update_transactions.tag_ids': (tagId) => ({
    edits: [{ ...routing, transaction_id: TX_ID, tag_ids: [TAG_IN_LIST, tagId] }],
  }),
  'bulk_edit_transactions.add_tag_ids': (tagId) => ({
    rows: [{ ...routing, transaction_id: TX_ID }],
    add_tag_ids: [tagId],
  }),
  // Removal is validated like addition today (ledger:
  // Mutation.deleteTag:cascades-to-transactions). If that entry settles that
  // Copilot keeps deleted tags on rows, this is the case to change.
  'bulk_edit_transactions.remove_tag_ids': (tagId) => ({
    rows: [{ ...routing, transaction_id: TX_ID }],
    remove_tag_ids: [tagId],
  }),
};

/** `<tool>.<field>` for every write-tool schema property matching `pattern`, at any depth. */
function writeFieldsMatching(pattern: RegExp): string[] {
  const out = new Set<string>();
  const walk = (tool: string, schema: unknown): void => {
    if (!schema || typeof schema !== 'object') return;
    const sc = schema as { properties?: Record<string, unknown>; items?: unknown };
    for (const [name, sub] of Object.entries(sc.properties ?? {})) {
      if (pattern.test(name)) out.add(`${tool}.${name}`);
      walk(tool, sub);
    }
    walk(tool, sc.items);
  };
  for (const def of WRITE_TOOL_DEFS) walk(def.name, def.schema.inputSchema);
  return [...out].sort();
}

const callTag = (key: string, tagId: string) =>
  [key.slice(0, key.indexOf('.')), TAG_CASES[key]!(tagId)] as const;

describe('tag ids are validated on every write that takes them (#846)', () => {
  test('every tag-id field of every write tool has a case', () => {
    expect(Object.keys(TAG_CASES).sort()).toEqual(writeFieldsMatching(/(^|_)tag_ids$/));
  });

  test.each(Object.keys(TAG_CASES))(
    '%s: an unknown tag id is rejected with nothing sent',
    async (key) => {
      const { call, mutationsSent } = setup();
      await expect(call(...callTag(key, TAG_UNKNOWN))).rejects.toThrow(
        `Tag not found: ${TAG_UNKNOWN}`
      );
      expect(mutationsSent()).toEqual([]);
    }
  );

  test.each(Object.keys(TAG_CASES))(
    '%s: control — a known tag id reaches the mutation',
    async (key) => {
      const { call, mutationsSent } = setup();
      await expect(call(...callTag(key, TAG_IN_LIST))).rejects.toThrow(
        /mutation reached the server/
      );
      expect(mutationsSent().length).toBeGreaterThan(0);
    }
  );
});

// ── reference lists cached for a day ─────────────────────────────────────────
//
// The categories and tags lists are cached for a day. A miss on a cached list
// refetches once before rejecting, so an id created in the app meanwhile is
// accepted; a retried unknown id pays at most one refetch per list per
// REFERENCE_REFETCH_MIN_MS; a refetch that fails still reports "not found".

afterEach(() => {
  (Date.now as unknown as { mockRestore?: () => void }).mockRestore?.();
});

const TAG_KNOWN = 'Tg1hJ4kL7zX0cV3bN6mQ';

/** A live setup whose Categories / Tags responses are read from mutable lists. */
function referenceSetup() {
  const categories = [CAT_KNOWN];
  const tags = [TAG_KNOWN];
  const fetches = { categories: 0, tags: 0 };
  const failNext = { categories: false };
  const client = createMockGraphQLClient({
    ...liveCategoryMocks([]),
    Categories: () => {
      fetches.categories += 1;
      if (failNext.categories) {
        failNext.categories = false;
        return new Error('synthetic network failure');
      }
      return liveCategoryMocks(categories).Categories;
    },
    Tags: () => {
      fetches.tags += 1;
      return { tags: tags.map((id) => ({ id, name: `Tag ${id}`, colorName: 'BLUE1' })) };
    },
    EditTransaction: new Error('synthetic: mutation reached the server'),
    EditBudget: new Error('synthetic: mutation reached the server'),
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
  const edit = (fields: { category_id?: string; tag_ids?: string[] }) =>
    tools.updateTransaction({ ...routing, transaction_id: TX_ID, ...fields });
  const edits = () => client._calls.filter((c) => c.op === 'EditTransaction').length;
  const mutationsSent = () => client._calls.filter((c) => !READ_OPS.has(c.op)).map((c) => c.op);
  return { tools, categories, tags, fetches, failNext, edit, edits, mutationsSent };
}

describe('reference lists: a miss on a cached list refetches once (#846)', () => {
  test('a category created since the list was cached is accepted after one refetch', async () => {
    const r = referenceSetup();
    await expect(r.edit({ category_id: CAT_KNOWN })).rejects.toThrow(/mutation reached/);
    expect(r.fetches.categories).toBe(1);

    r.categories.push(CAT_UNKNOWN); // created in the app after the list was cached
    await expect(r.edit({ category_id: CAT_UNKNOWN })).rejects.toThrow(/mutation reached/);
    expect(r.fetches.categories).toBe(2);
  });

  test('two categories created since the list was cached are both accepted back to back', async () => {
    // A refetch that FINDS the id must not arm the throttle for the next one.
    const r = referenceSetup();
    spyOn(Date, 'now').mockReturnValue(Date.now());
    await expect(r.edit({ category_id: CAT_KNOWN })).rejects.toThrow(/mutation reached/);
    r.categories.push(CAT_UNKNOWN);
    await expect(r.edit({ category_id: CAT_UNKNOWN })).rejects.toThrow(/mutation reached/);
    r.categories.push('Ct3fG6hJ9kL2zX5cV8bN');
    await expect(r.edit({ category_id: 'Ct3fG6hJ9kL2zX5cV8bN' })).rejects.toThrow(
      /mutation reached/
    );
    expect(r.fetches.categories).toBe(3);
  });

  test("clearing a deleted category's budget neither fetches nor arms the throttle", async () => {
    const r = referenceSetup();
    spyOn(Date, 'now').mockReturnValue(Date.now());
    await expect(r.edit({ category_id: CAT_KNOWN })).rejects.toThrow(/mutation reached/);
    // The clear reaches the mutation.
    await expect(
      r.tools.setBudget({ category_id: 'Dd4fG7hJ0kL3zX6cV9bN', amount: '0' })
    ).rejects.toThrow(/mutation reached/);
    expect(r.mutationsSent()).toEqual(['EditTransaction', 'EditBudget']);
    expect(r.fetches.categories).toBe(1);
    // A category created in the app right after is still accepted.
    r.categories.push(CAT_UNKNOWN);
    await expect(r.edit({ category_id: CAT_UNKNOWN })).rejects.toThrow(/mutation reached/);
    expect(r.fetches.categories).toBe(2);
  });

  test('a tag created since the list was cached is accepted after one refetch', async () => {
    const r = referenceSetup();
    await expect(r.edit({ tag_ids: [TAG_KNOWN] })).rejects.toThrow(/mutation reached/);
    expect(r.fetches.tags).toBe(1);

    const newTag = 'Tn8mQ1wE4rT7yU0iO3pA';
    r.tags.push(newTag);
    await expect(r.edit({ tag_ids: [TAG_KNOWN, newTag] })).rejects.toThrow(/mutation reached/);
    expect(r.fetches.tags).toBe(2);
  });

  test('a retried unknown id pays one refetch per REFERENCE_REFETCH_MIN_MS', async () => {
    const r = referenceSetup();
    const start = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(start);
    const ghost = 'Op3aS6dF9gH2jK5lZ8xC';

    await expect(r.edit({ category_id: ghost })).rejects.toThrow(`Category not found: ${ghost}`);
    expect(r.fetches.categories).toBe(1); // a cold list: the load itself is fresh

    await expect(r.edit({ category_id: ghost })).rejects.toThrow(`Category not found: ${ghost}`);
    expect(r.fetches.categories).toBe(2); // cached list missed: one refetch

    for (let i = 0; i < 3; i++) {
      await expect(r.edit({ category_id: ghost })).rejects.toThrow('Category not found');
    }
    expect(r.fetches.categories).toBe(2); // throttled

    clock.mockReturnValue(start + CopilotMoneyTools.REFERENCE_REFETCH_MIN_MS);
    await expect(r.edit({ category_id: ghost })).rejects.toThrow('Category not found');
    expect(r.fetches.categories).toBe(3);
    expect(r.edits()).toBe(0);
  });

  test('a refetch that fails still reports the id as not found', async () => {
    const r = referenceSetup();
    await expect(r.edit({ category_id: CAT_KNOWN })).rejects.toThrow(/mutation reached/);
    const ghost = 'Op3aS6dF9gH2jK5lZ8xC';
    r.failNext.categories = true;
    await expect(r.edit({ category_id: ghost })).rejects.toThrow(`Category not found: ${ghost}`);
    expect(r.fetches.categories).toBe(2);
    expect(r.edits()).toBe(1);
  });
});

// ── dates ───────────────────────────────────────────────────────────────────

/** Args for one write, with `date` (YYYY-MM-DD) in its date position. */
const DATE_CASES: Record<string, (date: string) => Record<string, unknown>> = {
  create_transaction: (date) => ({ ...CATEGORY_CASES.create_transaction!(CAT_KNOWN), date }),
  split_transaction: (date) => ({
    ...routing,
    transaction_id: TX_ID,
    splits: [
      { name: 'Part A', date: '2025-03-12', amount: 60, category_id: CAT_KNOWN },
      { name: 'Part B', date, amount: 40, category_id: CAT_KNOWN },
    ],
  }),
  update_transaction: (date) => ({ ...routing, transaction_id: TX_ID, date }),
  update_transactions: (date) => ({
    edits: [
      { ...routing, transaction_id: TX_ID, date: '2025-03-12' },
      { ...routing, transaction_id: TX_ID_2, date },
    ],
  }),
};

/** Write tools taking a YYYY-MM `month`, with an impossible and a real value. */
const MONTH_CASES: Record<
  string,
  { args: (month: string) => Record<string, unknown>; bad: string; good: string }
> = {
  set_budget: {
    args: (month) => ({ category_id: CAT_KNOWN, amount: '100', month }),
    bad: '2026-13',
    good: '2026-12',
  },
};

describe('write dates must be real calendar dates (#825)', () => {
  test('every write tool taking a date or month has a case', () => {
    expect(Object.keys(DATE_CASES).sort()).toEqual(writeToolsTaking(/(^|_)date$/));
    expect(Object.keys(MONTH_CASES).sort()).toEqual(writeToolsTaking(/(^|_)month$/));
  });

  test.each(Object.keys(DATE_CASES))(
    '%s: 2026-02-30 is rejected with nothing sent',
    async (tool) => {
      const { call, mutationsSent } = setup();
      await expect(call(tool, DATE_CASES[tool]!('2026-02-30'))).rejects.toThrow(
        /2026-02-30 is not a real calendar date/
      );
      expect(mutationsSent()).toEqual([]);
    }
  );

  test.each(Object.keys(DATE_CASES))(
    '%s: control — a leap day reaches the mutation',
    async (tool) => {
      const { call, mutationsSent } = setup();
      await expect(call(tool, DATE_CASES[tool]!('2028-02-29'))).rejects.toThrow(
        /mutation reached the server/
      );
      expect(mutationsSent().length).toBeGreaterThan(0);
    }
  );

  test.each(Object.keys(MONTH_CASES))(
    '%s: month 13 is rejected with nothing sent',
    async (tool) => {
      const c = MONTH_CASES[tool]!;
      const { call, mutationsSent } = setup();
      await expect(call(tool, c.args(c.bad))).rejects.toThrow(/not a real calendar month/);
      expect(mutationsSent()).toEqual([]);

      const control = setup();
      await expect(control.call(tool, c.args(c.good))).rejects.toThrow(/mutation reached/);
      expect(control.mutationsSent().length).toBeGreaterThan(0);
    }
  );
});
