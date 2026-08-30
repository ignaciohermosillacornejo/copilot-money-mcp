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
    standaloneName: 'decodeTransactions',
    ids: TWINS.transactions,
    idField: 'transaction_id',
    standalone: () => decodeTransactions(DB_PATH),
    aggregate: (r: Awaited<ReturnType<typeof decodeAllCollections>>) => r.transactions,
  },
  {
    name: 'accounts',
    standaloneName: 'decodeAccounts',
    ids: TWINS.accounts,
    idField: 'account_id',
    standalone: () => decodeAccounts(DB_PATH),
    aggregate: (r: Awaited<ReturnType<typeof decodeAllCollections>>) => r.accounts,
  },
  {
    name: 'recurring',
    standaloneName: 'decodeRecurring',
    ids: TWINS.recurring,
    idField: 'recurring_id',
    standalone: () => decodeRecurring(DB_PATH),
    aggregate: (r: Awaited<ReturnType<typeof decodeAllCollections>>) => r.recurring,
  },
  {
    name: 'budgets',
    standaloneName: 'decodeBudgets',
    ids: TWINS.budgets,
    idField: 'budget_id',
    standalone: () => decodeBudgets(DB_PATH),
    aggregate: (r: Awaited<ReturnType<typeof decodeAllCollections>>) => r.budgets,
  },
  {
    name: 'goals',
    standaloneName: 'decodeGoals',
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
 * Every dedup site in the decoder, as `enclosingFunction|label` -> dedup key.
 *
 * Three earlier revisions of this guard were each narrower than they claimed,
 * and each narrowing was the bug this file exists to catch:
 *
 *   1. It matched only `// <Label>: dedupe by`, the convention
 *      decodeAllCollections uses. The NINE standalone decoders write
 *      `// Deduplicate by <field>` and were invisible — including
 *      decodeItems, decodeCategories and decodeUserAccounts, which are
 *      exported, called directly by database.ts, and hold dedup blocks
 *      INDEPENDENT of their aggregate twins. One collection, two
 *      implementations, a guard watching one of them: #662's exact shape.
 *   2. Identity was the label alone, so adding a second
 *      `// Changes: dedupe by name + date` beside the existing one kept the
 *      count at 26 and passed every check — a content-keyed dedup landing
 *      green.
 *   3. The dedup KEY lived only in OMITTED's prose ("keys on category_id
 *      today"), which nothing verified.
 *
 * Pinning function+label -> key closes all three: a new site anywhere fails
 * forward, a removed one fails backward, and changing a key from an id to a
 * content field is a visible diff here rather than a claim in a comment.
 */
const DEDUP_SITES: string[] = [
  'decodeTransactions||transaction_id (Firestore document ID)',
  'decodeRecurring||recurring_id',
  'decodeBudgets||budget_id',
  'decodeGoals||goal_id',
  'decodeGoalHistory||goal_id + month',
  'decodeItems||item_id',
  'decodeCategories||category_id',
  'decodeUserAccounts||account_id',
  'decodeAllCollections|transactions|transaction_id, reconcile pending',
  'decodeAllCollections|accounts|account_id (see deduplicateAccounts',
  'decodeAllCollections|recurring|recurring_id',
  'decodeAllCollections|budgets|budget_id',
  'decodeAllCollections|goals|goal_id',
  'decodeAllCollections|goal history|goal_id + month, sort by goal_id then month desc',
  'decodeAllCollections|investment prices|(security, price_type, period)',
  'decodeAllCollections|investment splits|security_id (one doc per security)',
  'decodeAllCollections|items|item_id',
  'decodeAllCollections|categories|category_id',
  'decodeAllCollections|user accounts|account_id',
  'decodeAllCollections|plaid accounts|plaid_account_id',
  'decodeAllCollections|balance history|balance_id, sort by account then date desc',
  'decodeAllCollections|holdings history meta|holdings_history_id',
  'decodeAllCollections|holdings history|history_id',
  'decodeAllCollections|changes|change_id',
  'decodeAllCollections|securities|security_id',
  'decodeAllCollections|user profiles|user_id',
  'decodeAllCollections|tags|tag_id',
  'decodeAllCollections|amazon integrations|amazon_id',
  'decodeAllCollections|amazon orders|order_id, sort by date descending',
  'decodeAllCollections|subscriptions|subscription_id',
  'decodeAllCollections|invites|invite_id',
  'decodeAllCollections|user items|user_items_id',
  'decodeAllCollections|feature tracking|feature_tracking_id',
  'decodeAllCollections|support docs|support_id',
];

/**
 * Sites with no twin test and no structural excuse — uncovered by CHOICE.
 *
 * Every one keys on a document id today (see DEDUP_SITES, which pins that), so
 * there is no live bug. They are listed rather than silently uncovered so the
 * gap is a decision on the record. Note decodeItems / decodeCategories /
 * decodeUserAccounts are the standalone twins the earlier revision of this
 * guard could not even see.
 */
const UNTESTED_BY_CHOICE = new Set([
  'decodeAllCollections|amazon integrations',
  'decodeAllCollections|amazon orders',
  'decodeAllCollections|balance history',
  'decodeAllCollections|categories',
  'decodeAllCollections|changes',
  'decodeAllCollections|feature tracking',
  'decodeAllCollections|holdings history',
  'decodeAllCollections|holdings history meta',
  'decodeAllCollections|investment splits',
  'decodeAllCollections|invites',
  'decodeAllCollections|items',
  'decodeAllCollections|plaid accounts',
  'decodeAllCollections|securities',
  'decodeAllCollections|subscriptions',
  'decodeAllCollections|support docs',
  'decodeAllCollections|tags',
  'decodeAllCollections|user accounts',
  'decodeAllCollections|user items',
  'decodeAllCollections|user profiles',
  'decodeCategories|',
  'decodeItems|',
  'decodeUserAccounts|',
]);

/** Sites NOT exercised by the twin tests below, each with a reason. */
const OMITTED_REASON: Record<string, string> = {
  'decodeAllCollections|goal history':
    'structural — keyed on goal_id + month, and the tuple IS the identity (one doc per tuple)',
  'decodeGoalHistory|': 'structural — same tuple identity as its aggregate twin',
  'decodeAllCollections|investment prices':
    'structural — keyed on security + price_type + period, the tuple IS the identity',
};

/**
 * Discover every dedup site as an ORDERED LIST of `function|label|key`.
 *
 * A list, not a map. Keying by `function|label` let a SECOND
 * `// Changes: dedupe by name + date` overwrite the first entry instead of
 * adding one — so a content-keyed dedup could be added beside an existing
 * site and every check stayed green. Order and multiplicity are part of the
 * identity here.
 */
function discoverDedupSites(): string[] {
  const source = fs.readFileSync(
    path.join(import.meta.dir, '..', '..', 'src', 'core', 'decoder.ts'),
    'utf-8'
  );
  const declarations = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map(
    (m) => [m.index, m[1] as string] as const
  );
  const found: string[] = [];
  // Both phrasings: decodeAllCollections writes `// Label: dedupe by x`, the
  // standalone decoders write `// Deduplicate by x`. Matching only the first
  // is what hid nine sites. The key charset must allow parens and commas —
  // one key is `(security, price_type, period)`, and a narrower charset made
  // that whole site invisible rather than merely mis-parsing its key.
  for (const m of source.matchAll(
    /\/\/\s*(?:([A-Z][\w ]*?):\s*)?dedup(?:e|licate) by\s+([\w +(),]+)/gi
  )) {
    const enclosing = declarations.filter(([at]) => at < (m.index as number)).pop();
    const fnName = enclosing ? enclosing[1] : '?';
    found.push(`${fnName}|${(m[1] ?? '').trim().toLowerCase()}|${(m[2] ?? '').trim()}`);
  }
  return found;
}

describe('dedup coverage is declared, not assumed (#668 review)', () => {
  const discovered = discoverDedupSites();
  const covered = new Set(
    COLLECTIONS.flatMap((c) => [
      `decodeAllCollections|${c.name.toLowerCase()}`,
      `${c.standaloneName}|`,
    ])
  );

  test('discovery finds the dedup sites at all', () => {
    // Non-vacuity. The exact comparison below would pass over an empty list.
    expect(discovered.length).toBeGreaterThanOrEqual(30);
  });

  test('every dedup site and its key are unchanged', () => {
    // Exact, both directions at once: a new site, a removed site, or a key
    // changing from an id to a content field all fail here. Update
    // DEDUP_SITES in the same commit as any deliberate change.
    expect(discovered).toEqual(DEDUP_SITES);
  });

  test('every site is either twin-tested or has a stated reason', () => {
    const siteKeys = [...new Set(discovered.map((d) => d.split('|').slice(0, 2).join('|')))];
    const unexplained = siteKeys.filter(
      (site) => !covered.has(site) && !(site in OMITTED_REASON) && !UNTESTED_BY_CHOICE.has(site)
    );
    expect(unexplained).toEqual([]);
  });

  test('every stated reason still names a live site', () => {
    const siteKeys = new Set(discovered.map((d) => d.split('|').slice(0, 2).join('|')));
    const stale = [...Object.keys(OMITTED_REASON), ...UNTESTED_BY_CHOICE].filter(
      (site) => !siteKeys.has(site)
    );
    expect(stale.sort()).toEqual([]);
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
