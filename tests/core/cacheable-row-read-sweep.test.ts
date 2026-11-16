/**
 * Class-level gate for LiveCopilotDatabase.isCacheableRow (#874).
 *
 * The predicate decides which rows a MUTATION returned may be stored in the
 * live window cache. Once stored, a row is served to every later read of its
 * month, and that read runs every enrichment mapper, the name/tag/category
 * filters and the transaction-type rules over it. So the predicate's real
 * contract is "any row I accept survives the read path", and it has two
 * halves:
 *
 *  1. no read dereference throws on it (a row with no `name` or no `tags`
 *     array once made every later read of its month throw), and
 *  2. it lands in the month its date names (a date that names no month would
 *     take the row out of its real month and place it nowhere).
 *
 * Testing the fields the predicate checks today would only restate it. This
 * gate instead WEAKENS a full row one field at a time — deleting the field,
 * nulling it, emptying it, giving it a malformed date — and sends every
 * weakened row the predicate accepts through the public read path. A new
 * unguarded dereference on that path (`n.goal.id`, `n.suggestedCategoryIds.map`
 * on a field the predicate lets go missing), or a predicate clause deleted,
 * turns into an accepted row that throws or goes missing here.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import type { CopilotDatabase } from '../../src/core/database.js';
import { TransactionMetaStore } from '../../src/core/persistence/transaction-meta-store.js';
import type { TransactionNode } from '../../src/core/graphql/queries/transactions.js';
import type { CreatedTransaction } from '../../src/core/graphql/transactions.js';
import {
  LIVE_TRANSACTION_KNOWN_FIELDS,
  LIVE_TRANSACTION_TYPES,
  LiveTransactionsTools,
  liveRowFromMutation,
} from '../../src/tools/live/transactions.js';
import { getMonthRange, isCalendarMonth } from '../../src/utils/date.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';

const ACCOUNT_ID = 'kQ7vN2xR9pL4mW8tY3zB';
const ITEM_ID = 'hT5cJ8wF2nD6sG1qV4xM';
const CATEGORY_ID = 'gR4tH7jK2lM9nP3qS6vW';
const TAG_ID = 'pL6kJ3hG9fD2sA5qW8eR';
const SEED_ID = 'aB3xK9pQ2mN7vR4tY8wZ';
const NEW_ID = 'sT1gT7hI0eF5mJ2kP6nQ';

/** Two cold months, both warmed before the write, so a row can move between them. */
const WARM = { start: '2025-02-01', end: '2025-03-31' };
const BASE_DATE = '2025-03-12';

const SEED: TransactionNode = {
  id: SEED_ID,
  accountId: ACCOUNT_ID,
  itemId: ITEM_ID,
  categoryId: CATEGORY_ID,
  recurringId: null,
  parentId: null,
  isReviewed: true,
  isPending: false,
  amount: 100,
  date: BASE_DATE,
  name: 'Merchant aB3x',
  type: 'REGULAR',
  userNotes: null,
  tipAmount: null,
  suggestedCategoryIds: [],
  isoCurrencyCode: 'USD',
  createdAt: 1000,
  tags: [],
  goal: null,
};

/** A complete, well-formed row as a create mutation returns it. */
const FULL_ROW: CreatedTransaction = {
  id: NEW_ID,
  accountId: ACCOUNT_ID,
  itemId: ITEM_ID,
  categoryId: CATEGORY_ID,
  recurringId: null,
  isReviewed: false,
  isPending: false,
  amount: 42,
  date: BASE_DATE,
  name: 'Corner Bakery',
  type: 'REGULAR',
  userNotes: 'receipt',
  tipAmount: 2,
  suggestedCategoryIds: [CATEGORY_ID],
  createdAt: 2000,
  tags: [{ id: TAG_ID, name: 'Trip', colorName: 'BLUE1' }],
  goal: null,
};

/**
 * Kept intact: without both routing ids a returned row is never inserted
 * (upsertLiveTransaction's own guard, tested elsewhere), and without an id it
 * cannot be placed at all — weakening them would only exercise those guards.
 */
const NOT_WEAKENED = new Set(['id', 'accountId', 'itemId']);

/** `undefined` means the key is deleted, not set to undefined. */
const WEAK_VALUES: readonly unknown[] = [
  undefined,
  null,
  '',
  0,
  Number.NaN,
  false,
  [],
  {},
  [{}],
  [{ id: TAG_ID }],
  'garbage',
];

/**
 * Date shapes that name no calendar day (or not in the canonical form), plus
 * a real date in the OTHER warmed month, so the landing assertion is never
 * vacuous: an accepted row must be read back from Feb, not March.
 */
const DATE_SHAPES: readonly string[] = [
  '2025-02-28',
  '2025-02-30',
  '2025-02-31',
  '2025-2-28',
  '2025-02',
  '2025-02-28T12:00:00Z',
  ' 2025-02-28',
  '2025-02-28 ',
  '28/02/2025',
];

interface Variant {
  label: string;
  row: Record<string, unknown>;
}

/** A unique, readable label for a weakened value (NaN and null both stringify to "null"). */
function show(value: unknown): string {
  if (value === undefined) return 'deleted';
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  return JSON.stringify(value);
}

function variants(): Variant[] {
  const out: Variant[] = [{ label: 'the full row', row: { ...FULL_ROW } }];
  for (const key of Object.keys(FULL_ROW)) {
    if (NOT_WEAKENED.has(key)) continue;
    const values = key === 'date' ? [...WEAK_VALUES, ...DATE_SHAPES] : WEAK_VALUES;
    for (const value of values) {
      const row: Record<string, unknown> = { ...FULL_ROW };
      if (value === undefined) delete row[key];
      else row[key] = value;
      out.push({
        label: `${key} ${show(value)}`,
        row,
      });
    }
  }
  return out;
}

const META_DIR = mkdtempSync(join(tmpdir(), 'cacheable-row-sweep-meta-'));
afterAll(() => rmSync(META_DIR, { recursive: true, force: true }));

/** FULL_ROW as the Transactions query returns it, for the cached-copy pass. */
const CACHED_COPY: TransactionNode = { ...FULL_ROW, parentId: null, isoCurrencyCode: 'USD' };

function setup(opts: { cachedCopy?: boolean } = {}) {
  const seeds = opts.cachedCopy ? [SEED, CACHED_COPY] : [SEED];
  const client = createMockGraphQLClient({
    Transactions: {
      transactions: {
        edges: seeds.map((node) => ({ cursor: `c-${node.id}`, node })),
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    },
    Categories: {
      categories: [
        {
          id: CATEGORY_ID,
          name: 'Dining',
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
    Tags: { tags: [{ id: TAG_ID, name: 'Trip', colorName: 'BLUE1' }] },
    User: { user: { id: 'vW2jX8nO5kL0sP7qV1tW', budgetingConfig: null } },
  });
  const metaStore = new TransactionMetaStore({
    baseDir: mkdtempSync(join(META_DIR, 'store-')),
    uidProvider: () => 'test-uid',
  });
  const live = new LiveCopilotDatabase(client, {} as CopilotDatabase, { metaStore });
  return { live, tools: new LiveTransactionsTools(live) };
}

/** The month a date names, or null when its first seven characters are not one. */
function namedMonth(date: unknown): string | null {
  if (typeof date !== 'string') return null;
  const month = date.slice(0, 7);
  return isCalendarMonth(month) ? month : null;
}

/**
 * Every row-level dereference on the read path over one month: each
 * enrichment mapper (via `fields`), the name, tag, category and amount
 * filters, the transaction-type rules, and the single-row lookup.
 */
async function readEverything(
  tools: LiveTransactionsTools,
  base: Record<string, unknown>
): Promise<void> {
  const reads: Array<Record<string, unknown>> = [
    { query: 'bakery' },
    { merchant: 'corner' },
    { tag: 'Trip' },
    { category: CATEGORY_ID },
    { min_amount: 0, max_amount: 1000 },
    { pending: false },
    { exclude_transfers: true, exclude_excluded: true },
    ...LIVE_TRANSACTION_TYPES.map((t) => ({ transaction_type: t })),
    { transaction_id: NEW_ID, account_id: ACCOUNT_ID, item_id: ITEM_ID },
  ];
  for (const extra of reads) {
    await tools.getTransactions({
      ...base,
      fields: [...LIVE_TRANSACTION_KNOWN_FIELDS],
      ...extra,
    } as Parameters<LiveTransactionsTools['getTransactions']>[0]);
  }
}

/** The read arguments for the whole month `month` (YYYY-MM). */
function monthRead(month: string) {
  const [start, end] = getMonthRange(Number(month.slice(0, 4)), Number(month.slice(5, 7)));
  return {
    start_date: start,
    end_date: end,
    exclude_transfers: false,
    exclude_excluded: false,
    limit: 500,
  };
}

describe('every row isCacheableRow accepts survives the live read path (#874)', () => {
  const all = variants();
  const accepted = all.filter((v) => LiveCopilotDatabase.isCacheableRow(v.row));

  test('the sweep is not vacuous', () => {
    // Every weakened field is varied, some variants are refused (the
    // predicate is doing work), and some are accepted beyond the full row —
    // including a date in the other warmed month, so the landing check bites.
    const varied = new Set(all.slice(1).map((v) => v.label.split(' ')[0]));
    for (const key of Object.keys(FULL_ROW)) {
      if (!NOT_WEAKENED.has(key)) expect(varied.has(key)).toBe(true);
    }
    expect(accepted.length).toBeGreaterThan(1);
    expect(accepted.length).toBeLessThan(all.length);
    expect(accepted.some((v) => v.row.date === '2025-02-28')).toBe(true);
  });

  // One test per variant, refused ones included, so the test count does not
  // depend on the predicate: a clause deleted turns a passing test red rather
  // than adding a new one (the mutation-guard runner compares counts).
  test.each(all.map((v) => [v.label, v] as const))(
    '%s: if accepted, it lands in the month its date names and no read over it throws',
    async (_label, { row }) => {
      if (!LiveCopilotDatabase.isCacheableRow(row)) return;
      const { live, tools } = setup();
      await tools.getTransactions({ start_date: WARM.start, end_date: WARM.end, limit: 10 });

      live.upsertLiveTransaction(row as unknown as CreatedTransaction, { insert: true });

      // Half 2: the date names a calendar month, and a read of that month is
      // still a cache hit that serves the row (not dropped, not misfiled).
      const month = namedMonth(row.date);
      expect(month).not.toBeNull();
      const base = monthRead(month!);
      const plain = await tools.getTransactions({
        ...base,
        fields: [...LIVE_TRANSACTION_KNOWN_FIELDS],
      });
      expect(plain._cache_hit).toBe(true);
      expect(
        plain.transactions.map((t) => (t as { transaction_id: string }).transaction_id)
      ).toContain(NEW_ID);

      // Half 1: every row-level dereference on the read path.
      await readEverything(tools, base);
    }
  );
});

describe('an EDIT of a cached row: whatever upsert stores survives the live read path (#874)', () => {
  // The pass above inserts a new id, so the cached-copy branch never runs.
  // Here the row is already cached, so an edit response is checked with the
  // fields no write sets filled from the cached copy. Every variant is
  // upserted; the month is either dropped (refused) or, still cached, must
  // serve the row where its date says and survive every read.
  test.each(variants().map((v) => [v.label, v] as const))(
    '%s: a stored edit lands in the month its date names and no read over it throws',
    async (_label, { row }) => {
      const { live, tools } = setup({ cachedCopy: true });
      await tools.getTransactions({ start_date: WARM.start, end_date: WARM.end, limit: 10 });

      live.upsertLiveTransaction(row as unknown as CreatedTransaction);

      const month = namedMonth(row.date) ?? BASE_DATE.slice(0, 7);
      const base = monthRead(month);
      const plain = await tools.getTransactions({
        ...base,
        fields: [...LIVE_TRANSACTION_KNOWN_FIELDS],
      });
      if (plain._cache_hit) {
        expect(
          plain.transactions.map((t) => (t as { transaction_id: string }).transaction_id)
        ).toContain(NEW_ID);
      }
      await readEverything(tools, base);
    }
  );
});

describe('no write-row mapper throws on a drifted mutation row (#874)', () => {
  // A write tool maps its returned row for the caller whether or not the live
  // cache stores it, and it does so AFTER the write committed: a throw there
  // reports a landed write as a failure. So every weakened row, accepted or
  // refused, must map, as a plain row and as a split child.
  test.each(variants().map((v) => [v.label, v] as const))('%s', (_label, { row }) => {
    const tx = row as unknown as CreatedTransaction;
    expect(() => liveRowFromMutation(tx)).not.toThrow();
    expect(() => liveRowFromMutation(tx, SEED_ID)).not.toThrow();
  });
});
