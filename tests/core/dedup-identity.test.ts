/**
 * Class-level detector for issue #662.
 *
 * Every collection the decoder returns passes through a dedup step, because
 * LevelDB can hold the same Firestore document more than once. The question
 * each dedup answers is "are these two rows the same document?" — and the only
 * safe answer is the document's identity, never its contents.
 *
 * #662 was an account dedup keyed on `${name ?? official_name}|${mask ?? ''}`.
 * Two accounts at one institution can share a provider name and carry no mask,
 * so one of them was discarded before any caller could see it — no error, no
 * warning, no count mismatch. A real cache decoded two fewer accounts than the
 * live GraphQL surface returned. Accounts were the only content-keyed dedup in
 * the decoder; every sibling already keyed on its id.
 *
 * This test makes each COVERED dedup prove it. For those collections it seeds
 * TWO documents that are byte-for-byte identical in content and differ only by
 * id, then asserts both survive — on the standalone decoder AND on the
 * single-pass aggregate, since #662 shipped two independent copies of the same
 * bad key.
 *
 * SCOPE, stated precisely because an overclaiming detector is worse than an
 * honestly-scoped one: this exercises the FIVE primary collections listed in
 * COLLECTIONS below, not all ~26 dedup sites in decodeAllCollections. The rest
 * all key on a document id today, so there is no live bug — but a future
 * content-keyed dedup in, say, `categories` would NOT fail this test.
 *
 * What is enforced instead of that claim: `dedupSiteCoverage` below discovers
 * every `dedupe by` site in the decoder source and requires each one to be
 * either covered here or listed in OMITTED with a reason. So the coverage gap
 * cannot widen silently, and a new dedup site added tomorrow fails until
 * someone makes a decision about it. That is the checkable version of the
 * claim this comment used to make.
 *
 * Two of the omissions are structural rather than "not done yet":
 *
 * - `goal_history` (keyed on goal_id + month) and `investment_prices` (keyed on
 *   security + price_type + period) are excluded because their keys ARE their
 *   identities — those collections store one document per tuple, and the tuple
 *   is what the Firestore path encodes. "Two documents identical in content but
 *   differing by id" is not expressible for them.
 * - This proves distinct documents survive, not that true storage duplicates are
 *   collapsed. `createTestDb` writes one row per id, so a genuinely double-stored
 *   document cannot be built in a fixture — the same limitation #122 had.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  decodeTransactions,
  decodeAccounts,
  decodeRecurring,
  decodeBudgets,
  decodeGoals,
  decodeAllCollections,
} from '../../src/core/decoder.js';
import { createCombinedDb } from '../helpers/test-db.js';

const FIXTURES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-identity-'));
const DB_PATH = path.join(FIXTURES_DIR, 'combined');

/**
 * `decodeAllCollections` reads every collection in one pass, so it is decoded
 * once here rather than per assertion.
 */
let aggregate: Awaited<ReturnType<typeof decodeAllCollections>>;

/**
 * Each pair is identical in every content field a dedup might reach for and
 * differs only by id. Ids are Firestore-shaped so a dedup can't accidentally
 * succeed by pattern-matching a test-only `_001` suffix.
 */
const TWINS = {
  transactions: ['txn_9dK3mQ7xLp2RwN8vBz4T', 'txn_5hJ1nP4yMk6SxT2uCw9R'],
  accounts: ['acc_kPZ8nRvqLm3TdWxYb6Ac', 'acc_wQ4mBtXjS9fHeNzUr2Kd'],
  recurring: ['rec_2fGh7JkLm9NpQr4StUv6', 'rec_8xYz3AbCd5EfGh1IjKl7'],
  budgets: ['bud_6MnOp2QrSt8UvWx4YzAb', 'bud_4CdEf9GhIj3KlMn7OpQr'],
  goals: ['goal_7StUv5WxYz1AbCd3EfGh', 'goal_3IjKl8MnOp6QrSt2UvWx'],
} as const;

beforeAll(async () => {
  await createCombinedDb(DB_PATH, {
    // Identical merchant, amount, date and account — only the id differs.
    transactions: TWINS.transactions.map((id) => ({
      transaction_id: id,
      name: 'Corner Store',
      amount: 12,
      date: '2024-03-01',
      account_id: TWINS.accounts[0],
    })),
    // Identical name, no mask — the exact shape that collapsed in #662.
    // current_balance is load-bearing: processAccount returns null without it.
    accounts: TWINS.accounts.map((id) => ({
      account_id: id,
      name: 'Stock Plan',
      account_type: 'investment',
      current_balance: 100,
    })),
    recurring: TWINS.recurring.map((id) => ({
      recurring_id: id,
      name: 'Streaming Service',
      amount: 9.99,
      frequency: 'monthly',
    })),
    budgets: TWINS.budgets.map((id) => ({
      budget_id: id,
      category_id: 'cat_1AbCd5EfGh9IjKl3MnOp',
      amount: 400,
    })),
    goals: TWINS.goals.map((id) => ({
      goal_id: id,
      name: 'Emergency Fund',
      target_amount: 5000,
    })),
  });

  aggregate = await decodeAllCollections(DB_PATH);
});

afterAll(() => {
  fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

/**
 * `id` names the identity field on the decoded row, so a failure reports which
 * document went missing rather than just a count.
 */
const COLLECTIONS = [
  {
    name: 'transactions',
    ids: TWINS.transactions,
    idField: 'transaction_id',
    standalone: () => decodeTransactions(DB_PATH),
    aggregate: (r: Awaited<ReturnType<typeof decodeAllCollections>>) => r.transactions,
  },
  {
    name: 'accounts',
    ids: TWINS.accounts,
    idField: 'account_id',
    standalone: () => decodeAccounts(DB_PATH),
    aggregate: (r: Awaited<ReturnType<typeof decodeAllCollections>>) => r.accounts,
  },
  {
    name: 'recurring',
    ids: TWINS.recurring,
    idField: 'recurring_id',
    standalone: () => decodeRecurring(DB_PATH),
    aggregate: (r: Awaited<ReturnType<typeof decodeAllCollections>>) => r.recurring,
  },
  {
    name: 'budgets',
    ids: TWINS.budgets,
    idField: 'budget_id',
    standalone: () => decodeBudgets(DB_PATH),
    aggregate: (r: Awaited<ReturnType<typeof decodeAllCollections>>) => r.budgets,
  },
  {
    name: 'goals',
    ids: TWINS.goals,
    idField: 'goal_id',
    standalone: () => decodeGoals(DB_PATH),
    aggregate: (r: Awaited<ReturnType<typeof decodeAllCollections>>) => r.goals,
  },
] as const;

function idsOf(rows: readonly unknown[], idField: string): Set<string> {
  return new Set(
    rows.map((row, i) => {
      const value = (row as Record<string, unknown>)[idField];
      // Without this a renamed id field yields `Set { undefined }` and the
      // failure reads as "the document vanished" rather than "the field moved".
      if (typeof value !== 'string') {
        throw new Error(
          `row ${i} has no string "${idField}" (got ${typeof value}) — did the field get renamed?`
        );
      }
      return value;
    })
  );
}

// ---------------------------------------------------------------------------
// Coverage guard (review follow-up on #668)
// ---------------------------------------------------------------------------

/**
 * Dedup sites in decodeAllCollections that this file does NOT exercise, each
 * with the reason. Checked in BOTH directions below, so an entry naming a site
 * that no longer exists fails too — otherwise this becomes one more
 * hand-maintained list quietly protecting nothing.
 */
const OMITTED: Record<string, string> = {
  // Structural — the key IS the identity, so "two documents identical in
  // content differing only by id" is not expressible for these.
  'goal history': 'keyed on goal_id + month — the tuple IS the identity, one doc per tuple',
  'investment prices':
    'keyed on security + price_type + period — the tuple IS the identity, per the Firestore path',

  // Not yet exercised. Every one keys on a document id today, so there is no
  // live bug; they are listed rather than silently uncovered so the gap is a
  // decision on the record instead of an accident. Seeding them needs
  // createCombinedDb support, which is follow-up work.
  'amazon integrations': 'not seeded by createCombinedDb; keys on amazon_id today',
  'amazon orders': 'not seeded by createCombinedDb; keys on order_id today',
  'balance history': 'not seeded by createCombinedDb; keys on balance_id today',
  categories:
    'seedable today (createCombinedDb accepts it) — uncovered by choice, not by blocker; keys on category_id',
  changes: 'not seeded by createCombinedDb; keys on change_id today',
  'feature tracking': 'not seeded by createCombinedDb; keys on its document id today',
  'holdings history': 'not seeded by createCombinedDb; keys on history_id today',
  'holdings history meta': 'not seeded by createCombinedDb; keys on holdings_history_id today',
  'investment splits': 'not seeded by createCombinedDb; keys on security_id today',
  invites: 'not seeded by createCombinedDb; keys on invite_id today',
  items:
    'seedable today (createItemDb exists) — uncovered by choice, not by blocker; keys on item_id',
  'plaid accounts': 'not seeded by createCombinedDb; keys on plaid_account_id today',
  securities: 'not seeded by createCombinedDb; keys on security_id today',
  subscriptions: 'not seeded by createCombinedDb; keys on subscription_id today',
  'support docs': 'not seeded by createCombinedDb; keys on its document id today',
  tags: 'not seeded by createCombinedDb; keys on tag_id today',
  'user accounts': 'not seeded by createCombinedDb; keys on account_id today',
  'user items': 'not seeded by createCombinedDb; keys on its document id today',
  'user profiles': 'not seeded by createCombinedDb; keys on user_id today',
};

/** Every `<Label>: dedupe by ...` site the decoder documents, lowercased. */
function discoverDedupSites(): string[] {
  const src = fs.readFileSync(
    path.join(import.meta.dir, '..', '..', 'src', 'core', 'decoder.ts'),
    'utf-8'
  );
  return [...src.matchAll(/\/\/\s*([A-Z][\w ]*?):\s*dedupe by/g)]
    .map((m) => (m[1] as string).trim().toLowerCase())
    .filter((name, i, all) => all.indexOf(name) === i)
    .sort();
}

describe('dedup coverage is declared, not assumed (#668 review)', () => {
  const sites = discoverDedupSites();
  const covered = new Set(COLLECTIONS.map((c) => c.name.toLowerCase()));

  // Without this, a regex that stopped matching would make the forward check
  // below pass over an empty list — the failure shape this whole file is about.
  test('discovery finds every dedup site (exact, not a floor)', () => {
    // EXACT, deliberately. Discovery is anchored on the `// Label: dedupe by`
    // comments, so deleting a comment while reintroducing a content key would
    // drop that site from the ledger — a floor of 20 would not notice. Pinning
    // the count means removing a comment fails here and someone has to look.
    //
    // If you legitimately add or remove a dedup site, update this number and
    // the OMITTED table in the same commit. That is the intended workflow: the
    // point is that coverage cannot change silently.
    expect(sites.length).toBe(26);
  });

  test('forward: every dedup site is either exercised here or listed as omitted', () => {
    expect(sites.filter((site) => !covered.has(site) && !(site in OMITTED))).toEqual([]);
  });

  test('backward: every omission still names a live dedup site', () => {
    expect(
      Object.keys(OMITTED)
        .filter((site) => !sites.includes(site))
        .sort()
    ).toEqual([]);
  });
});

describe('dedup keys on identity, not content (#662)', () => {
  for (const collection of COLLECTIONS) {
    test(`${collection.name}: standalone decode keeps both identical-content documents`, async () => {
      const rows = await collection.standalone();

      expect(idsOf(rows, collection.idField)).toEqual(new Set(collection.ids));
    });
  }

  for (const collection of COLLECTIONS) {
    test(`${collection.name}: aggregate decode keeps both identical-content documents`, () => {
      expect(idsOf(collection.aggregate(aggregate), collection.idField)).toEqual(
        new Set(collection.ids)
      );
    });
  }
});
