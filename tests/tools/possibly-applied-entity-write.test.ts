/**
 * A category / tag / recurring / budget write that probably landed is visible
 * on the next live read (#887 review). All eleven such tools are listed.
 *
 * Those tools patch their live snapshot only on success. When the mutation
 * instead throws an error that says the write may have applied (`writeApplied`
 * from an error-free response with an unusable payload, ledger
 * Mutation.*:null-payload-means-applied), the snapshot must be dropped so the
 * next read asks the server, rather than serving the pre-write list until its
 * TTL. A failure that says nothing landed leaves the snapshot alone.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { TransactionMetaStore } from '../../src/core/persistence/transaction-meta-store.js';
import { GraphQLError, unusablePayloadError } from '../../src/core/graphql/client.js';
import type { SnapshotCache } from '../../src/core/cache/index.js';
import { createMockGraphQLClient, localCategories } from '../helpers/mock-graphql.js';

const CAT_ID = 'Lm2xP7rT4uY9bE1cG5hJ';
const TAG_ID = 'Nk6wS3dF8jZ2qV5tR9oA';
const REC_ID = 'Rt4yU9iO2pA7sD1fG6hK';
const TX_ID = 'Zx8cV3bN6mQ1wE4rT7yU';
const ACCOUNT_ID = 'Vq3nR8kT2pX6wL9mZ4yB';
const ITEM_ID = 'Hc7fJ1sD5gK8aQ3vN6tW';

const META_DIR = mkdtempSync(join(tmpdir(), 'possibly-applied-entity-'));
afterAll(() => rmSync(META_DIR, { recursive: true, force: true }));

function makeDb(): CopilotDatabase {
  const db = new CopilotDatabase('/nonexistent');
  (db as any).dbPath = '/fake';
  (db as any)._transactions = [];
  (db as any)._userCategories = localCategories([CAT_ID]);
  (db as any)._tags = [];
  db._markLoadedForTesting();
  return db;
}

type Scope = 'categories' | 'tags' | 'recurring';

function cacheFor(
  live: LiveCopilotDatabase,
  scope: Scope
): SnapshotCache<{ id: string; name: string }> {
  if (scope === 'categories') return live.getCategoriesCache() as never;
  if (scope === 'tags') return live.getTagsCache() as never;
  return live.getRecurringCache() as never;
}

type DerivedKey =
  | (typeof LiveCopilotDatabase.RECURRING_DERIVED_SNAPSHOTS)[number]
  | (typeof LiveCopilotDatabase.CATEGORY_DERIVED_SNAPSHOTS)[number];

/**
 * The snapshots a recurring (#868) or category (#911 review) write derives;
 * a key added to either list without one here is a type error. A
 * possibly-applied write drops its scope's list with its own snapshot.
 */
const DERIVED: Record<DerivedKey, (live: LiveCopilotDatabase) => SnapshotCache<unknown>> = {
  upcoming_recurrings: (live) => live.getUpcomingRecurringsCache() as never,
  monthly_spend: (live) => live.getMonthlySpendCache() as never,
};

/** The derived snapshots each scope's possibly-applied write drops. */
const DERIVED_BY_SCOPE: Record<Scope, readonly DerivedKey[]> = {
  recurring: LiveCopilotDatabase.RECURRING_DERIVED_SNAPSHOTS,
  categories: LiveCopilotDatabase.CATEGORY_DERIVED_SNAPSHOTS,
  tags: [],
};

/** Which derived snapshots are still cached, by key. */
function derivedWarm(live: LiveCopilotDatabase): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(DERIVED).map(([key, get]) => [key, get(live).peek() !== undefined])
  );
}

/** Every derived snapshot warm except the ones `dropped` names. */
function warmExcept(dropped: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(Object.keys(DERIVED).map((key) => [key, !dropped.includes(key)]));
}

const CASES: Array<[string, string, Scope, (t: CopilotMoneyTools) => Promise<unknown>]> = [
  ['create_tag', 'CreateTag', 'tags', (t) => t.createTag({ name: 'Trip' })],
  ['update_tag', 'EditTag', 'tags', (t) => t.updateTag({ tag_id: TAG_ID, name: 'Trip 2' })],
  ['delete_tag', 'DeleteTag', 'tags', (t) => t.deleteTag({ tag_id: TAG_ID })],
  [
    'create_category',
    'CreateCategory',
    'categories',
    (t) => t.createCategory({ name: 'Pets', color_name: 'BLUE1', emoji: '🐶' }),
  ],
  [
    'update_category',
    'EditCategory',
    'categories',
    (t) => t.updateCategory({ category_id: CAT_ID, name: 'Pets 2' }),
  ],
  [
    'delete_category',
    'DeleteCategory',
    'categories',
    (t) => t.deleteCategory({ category_id: CAT_ID }),
  ],
  [
    'set_budget',
    'EditBudget',
    'categories',
    (t) => t.setBudget({ category_id: CAT_ID, amount: '100' }),
  ],
  [
    'set_recurring_state',
    'EditRecurring',
    'recurring',
    (t) => t.setRecurringState({ recurring_id: REC_ID, state: 'PAUSED' }),
  ],
  [
    'update_recurring',
    'EditRecurring',
    'recurring',
    (t) => t.updateRecurring({ recurring_id: REC_ID, name: 'Gym' }),
  ],
  [
    // Routing passed explicitly; its split-parent check loads the (empty)
    // live window, mocked in setup().
    'create_recurring',
    'CreateRecurring',
    'recurring',
    (t) =>
      t.createRecurring({
        transaction_id: TX_ID,
        account_id: ACCOUNT_ID,
        item_id: ITEM_ID,
        frequency: 'MONTHLY',
      }),
  ],
  [
    'delete_recurring',
    'DeleteRecurring',
    'recurring',
    (t) => t.deleteRecurring({ recurring_id: REC_ID }),
  ],
];

async function setup(op: string, error: Error) {
  const client = createMockGraphQLClient({
    [op]: error,
    Transactions: {
      transactions: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } },
    },
  } as never);
  const db = makeDb();
  const live = new LiveCopilotDatabase(client, db, {
    metaStore: new TransactionMetaStore({
      baseDir: mkdtempSync(join(META_DIR, 'store-')),
      uidProvider: () => 'test-uid',
    }),
  });
  for (const scope of ['categories', 'tags', 'recurring'] as const) {
    // The ids the calls name, so a tool's own existence check passes.
    const id = scope === 'categories' ? CAT_ID : scope === 'tags' ? TAG_ID : REC_ID;
    await cacheFor(live, scope).read(async () => [{ id, name: 'Seed' }]);
  }
  for (const get of Object.values(DERIVED)) await get(live).read(async () => []);
  expect(derivedWarm(live)).toEqual(warmExcept([]));
  return { tools: new CopilotMoneyTools(db, client, live), live };
}

describe('a probably-landed entity write drops its live snapshot (#887)', () => {
  test.each(CASES)('%s: a writeApplied error drops the snapshot', async (_n, op, scope, call) => {
    const { tools, live } = await setup(op, unusablePayloadError(op, 'data', null));
    await expect(call(tools)).rejects.toThrow(/PROBABLY landed/);
    expect(cacheFor(live, scope).peek()).toBeUndefined();
    // Only the entity's own snapshot goes.
    for (const other of (['categories', 'tags', 'recurring'] as const).filter((s) => s !== scope)) {
      expect(cacheFor(live, other).peek()).toBeDefined();
    }
    // It also drops what its scope derives (#868, #911 review), and only that.
    expect(derivedWarm(live)).toEqual(warmExcept(DERIVED_BY_SCOPE[scope]));
  });

  test.each(CASES)(
    '%s: an ambiguous failure that may have written (5xx, not writeApplied) drops it too',
    async (_n, op, scope, call) => {
      // The helper gates on writeMayHaveApplied, which is broader than
      // writeApplied: a write a 5xx may or may not have applied is refetched too.
      const ambiguous = new GraphQLError('SERVER_ERROR', '502', op, 502, undefined, {
        requestReachedServer: true,
        writeMayHaveApplied: true,
      });
      expect(ambiguous.writeApplied).toBe(false);
      const { tools, live } = await setup(op, ambiguous);
      await expect(call(tools)).rejects.toThrow(/may or may not have applied/);
      expect(cacheFor(live, scope).peek()).toBeUndefined();
      expect(derivedWarm(live)).toEqual(warmExcept(DERIVED_BY_SCOPE[scope]));
    }
  );

  test.each(CASES)(
    '%s: a rejection that cannot have written leaves the snapshot',
    async (_n, op, scope, call) => {
      const rejected = new GraphQLError('USER_ACTION_REQUIRED', 'not found', op, 200, [], {
        requestReachedServer: true,
      });
      const { tools, live } = await setup(op, rejected);
      await expect(call(tools)).rejects.toThrow(/rejected the request/);
      expect(cacheFor(live, scope).peek()).toBeDefined();
      expect(derivedWarm(live)).toEqual(warmExcept([]));
    }
  );
});
