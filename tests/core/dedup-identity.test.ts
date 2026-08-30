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
 * honestly-scoped one: the twin tests exercise the FIVE collections in
 * COLLECTIONS, on both their standalone and aggregate paths — 8 of the
 * decoder's 36 dedup blocks. A green run here says nothing about the other 28.
 *
 * What IS enforced across all 36: the coverage guard discovers every dedup
 * BLOCK — each `new Set<string>()` allocation — and pins the KEY EXPRESSION it
 * tests. A block that is new, removed, or whose key changes from an id to a
 * content field fails there, and every block must be twin-tested, structural,
 * or explicitly listed as untested-by-choice.
 *
 * Note "block", not "comment", and "expression", not "name". Both distinctions
 * were bought the hard way — six revisions, each one narrower than its own
 * comment claimed, each narrowing found by review rather than by the suite:
 *
 *   1. five hand-written tests, claiming "every collection"
 *   2. `// Label: dedupe by` comments — missed the nine standalone decoders
 *   3. both comment forms keyed by label — three blocks share one comment, so
 *      a duplicate label overwrote rather than added
 *   4. blocks, pinning the key — but three pinned the local name `key`, which
 *      pins nothing
 *   5. bare identifiers resolved, and asserted never to appear — but a
 *      RESOLVED expression can still pin nothing (`key = keyFor(row)` is not
 *      a bare word, yet names no field)
 *   6. resolved expressions required to contain a property access, not just
 *      be non-bare
 *
 * Revision 2 could not see `dedupeAndSortInvestmentPrices`, which carries no
 * comment — the site that shipped #622, the previous instance of this exact
 * bug class, invisible to the detector written for it. That is the sharpest
 * argument for why this guard reads code and not prose.
 *
 * Four of the coverage guard's blocks are excluded from the twin tests for a
 * structural reason rather than "not done yet" — two distinct reasons,
 * spanning those four blocks (see STRUCTURAL_KEYS below):
 *
 * - `goal_history` (keyed on goal_id + month, both its standalone
 *   `decodeGoalHistory|seen` block and its aggregate `histSeen` twin) and
 *   `investment_prices` (keyed on security + price_type + period) are
 *   excluded because their keys ARE their identities — those collections
 *   store one document per tuple, and the tuple is what the Firestore path
 *   encodes. "Two documents identical in content but differing by id" is not
 *   expressible for them. Three blocks.
 * - `reconcilePendingTransactions|supersededPendingIds` is not a dedup at
 *   all — it tracks pending rows superseded by a posted twin, not document
 *   identity, and is listed only because the discovery regex finds every
 *   `new Set<string>()` and this one has to be accounted for somewhere. One
 *   block.
 *
 * Separately: the twin tests that DO run prove distinct documents survive,
 * not that true storage duplicates are collapsed. `createTestDb` writes one
 * row per id, so a genuinely double-stored document cannot be built in a
 * fixture — the same limitation #122 had.
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
    standaloneName: 'deduplicateTransactions',
    ids: TWINS.transactions,
    idField: 'transaction_id',
    standalone: () => decodeTransactions(DB_PATH),
    aggregate: (r: Awaited<ReturnType<typeof decodeAllCollections>>) => r.transactions,
  },
  {
    name: 'accounts',
    standaloneName: 'deduplicateAccounts',
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
 * Every dedup BLOCK in the decoder, as `function|setVariable` -> the key
 * expression it dedups on.
 *
 * Four revisions of this guard were each narrower than they claimed, and every
 * narrowing was the bug this file exists to catch. The last keyed discovery on
 * `// dedupe by` COMMENTS, which fails two ways no comment can fix:
 *
 *   - A block with no comment is invisible. `dedupeAndSortInvestmentPrices`
 *     had none — and that is the site that shipped #622, the previous instance
 *     of this exact bug class, sitting outside the detector written for it.
 *   - A comment is not 1:1 with a block. One `// Changes: dedupe by change_id`
 *     sits above THREE blocks (changeSeen, tcSeen, acSeen). Changing
 *     `acSeen.has(ac.change_id)` to `acSeen.has(ac.description)` left the
 *     comment list byte-identical and every check green.
 *
 * So discovery finds the blocks themselves — `new Set<string>()` allocations —
 * and pins the KEY EXPRESSION each tests. That expression IS the identity
 * claim. Prose about a key can go stale; the expression cannot, being the code.
 *
 * MAINTENANCE: a deliberate change means updating the entry in the same commit.
 * That is the point — it cannot happen silently.
 */
const DEDUP_BLOCKS: Record<string, string> = {
  'deduplicateTransactions|seen': 'txn.transaction_id',
  'deduplicateAccounts|seen': 'acc.account_id',
  'reconcilePendingTransactions|supersededPendingIds': 'txn.transaction_id',
  'decodeRecurring|seen': 'rec.recurring_id',
  'decodeBudgets|seen': 'budget.budget_id',
  'decodeGoals|seen': 'goal.goal_id',
  'decodeGoalHistory|seen': 'key = `${history.goal_id}:${history.month}`',
  'dedupeAndSortInvestmentPrices|seen':
    "key = `${price.security_id}/${price.price_type}/${price.date ?? price.month ?? 'unknown'}`",
  'decodeItems|seen': 'item.item_id',
  'decodeCategories|seen': 'category.category_id',
  'decodeUserAccounts|seen': 'userAccount.account_id',
  'decodeAllCollections|recSeen': 'rec.recurring_id',
  'decodeAllCollections|budgetSeen': 'budget.budget_id',
  'decodeAllCollections|goalSeen': 'goal.goal_id',
  'decodeAllCollections|histSeen': 'key = `${history.goal_id}:${history.month}`',
  'decodeAllCollections|splitSeen': 'split.security_id',
  'decodeAllCollections|itemSeen': 'item.item_id',
  'decodeAllCollections|catSeen': 'category.category_id',
  'decodeAllCollections|userAccSeen': 'userAccount.account_id',
  'decodeAllCollections|plaidAccSeen': 'acc.plaid_account_id',
  'decodeAllCollections|bhSeen': 'bh.balance_id',
  'decodeAllCollections|hhMetaSeen': 'hhm.holdings_history_id',
  'decodeAllCollections|hhSeen': 'hh.history_id',
  'decodeAllCollections|changeSeen': 'c.change_id',
  'decodeAllCollections|tcSeen': 'tc.change_id',
  'decodeAllCollections|acSeen': 'ac.change_id',
  'decodeAllCollections|secSeen': 'sec.security_id',
  'decodeAllCollections|profileSeen': 'profile.user_id',
  'decodeAllCollections|tagSeen': 'tag.tag_id',
  'decodeAllCollections|amzIntSeen': 'ai.amazon_id',
  'decodeAllCollections|amzOrdSeen': 'order.order_id',
  'decodeAllCollections|subSeen': 'sub.subscription_id',
  'decodeAllCollections|invSeen': 'inv.invite_id',
  'decodeAllCollections|uiSeen': 'ui.user_items_id',
  'decodeAllCollections|ftSeen': 'ft.feature_tracking_id',
  'decodeAllCollections|supSeen': 'sup.support_id',
};

/**
 * Blocks excluded from the twin tests for a STRUCTURAL reason, not for lack of
 * effort. Three key on a tuple that IS the identity, so "two documents
 * identical in content differing only by id" cannot be expressed for them. The
 * fourth, `reconcilePendingTransactions|supersededPendingIds`, is not a dedup
 * at all — it tracks pending rows superseded by a posted twin, and is listed
 * here because the discovery regex finds every `new Set<string>()` and this one
 * has to be accounted for somewhere.
 */
const STRUCTURAL_KEYS: Record<string, string> = {
  'decodeGoalHistory|seen':
    'keyed on goal_id + month — the tuple IS the identity, one doc per tuple',
  'decodeAllCollections|histSeen': 'goal-history aggregate twin, same tuple identity',
  'dedupeAndSortInvestmentPrices|seen':
    'keyed on security/price_type/period — the tuple IS the identity. This is the site that shipped #622, the previous instance of this very bug class, and it was invisible to the comment-driven revision of this guard',
  'reconcilePendingTransactions|supersededPendingIds':
    'not a dedup — tracks pending rows superseded by a posted twin',
};

/**
 * Blocks with no twin test and no structural excuse — uncovered by CHOICE.
 * Every one keys on a document id today (DEDUP_BLOCKS pins that), so there is
 * no live bug; they are listed so the gap is a decision on the record.
 */
const UNTESTED_BY_CHOICE = new Set([
  'decodeItems|seen',
  'decodeCategories|seen',
  'decodeUserAccounts|seen',
  'decodeAllCollections|splitSeen',
  'decodeAllCollections|itemSeen',
  'decodeAllCollections|catSeen',
  'decodeAllCollections|userAccSeen',
  'decodeAllCollections|plaidAccSeen',
  'decodeAllCollections|bhSeen',
  'decodeAllCollections|hhMetaSeen',
  'decodeAllCollections|hhSeen',
  'decodeAllCollections|changeSeen',
  'decodeAllCollections|tcSeen',
  'decodeAllCollections|acSeen',
  'decodeAllCollections|secSeen',
  'decodeAllCollections|profileSeen',
  'decodeAllCollections|tagSeen',
  'decodeAllCollections|amzIntSeen',
  'decodeAllCollections|amzOrdSeen',
  'decodeAllCollections|subSeen',
  'decodeAllCollections|invSeen',
  'decodeAllCollections|uiSeen',
  'decodeAllCollections|ftSeen',
  'decodeAllCollections|supSeen',
]);

/**
 * Slice out `open`..`close` starting at `openIdx`, counting nesting depth.
 * Mirrors the identically-named helper in decoder-field-completeness.test.ts.
 * Kept local rather than shared — the two discovery scripts read the source
 * independently by design (see discoverAggregatePushTargets's own doc) — but
 * the same bounding requirement applies here: without it, a scan can walk
 * past the guarded block's own closing brace and misattribute a LATER,
 * unrelated `.push(` call, which is exactly the #685 Step 1 defect in the
 * sibling file. Bounding here is what keeps this file from shipping that
 * same class of bug next door to its own fix.
 */
function balanced(text: string, openIdx: number, open: string, close: string): [string, number] {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return [text.slice(openIdx + 1, i), i];
    }
  }
  return ['', text.length];
}

/**
 * For each dedup block, the name of the array its guarded `.push()` feeds.
 * `decodeAllCollections` builds every inline-block collection with the
 * identical shape — `if (!XSeen.has(id)) { XSeen.add(id); arr.push(item); }`
 * — and returns `arr` under the field name that shape's own
 * `const arr: T[] = []` declares, so the push target names the collection as
 * reliably as `standaloneName` (below) names the standalone decoder's
 * function. Read independently of `discoverDedupBlocks`, on its own pass over
 * the source, so a bug in one discovery function cannot mask a bug in the
 * other.
 *
 * The `.push(` search is bounded to the guard's OWN braced body via
 * `balanced()`, not a forward scan across the whole window — a forward scan
 * for the next `.push(` anywhere ahead can cross the guard's closing brace
 * and credit an unrelated later block's push to this Set variable.
 */
function discoverAggregatePushTargets(): Record<string, string> {
  const source = fs.readFileSync(
    path.join(import.meta.dir, '..', '..', 'src', 'core', 'decoder.ts'),
    'utf-8'
  );
  const found: Record<string, string> = {};
  for (const m of source.matchAll(/const (\w+) = new Set<string>\(\)/g)) {
    const setVar = m[1] as string;
    const window = source.slice(
      (m.index as number) + m[0].length,
      (m.index as number) + m[0].length + 3000
    );
    const guard = new RegExp(`if \\(!${setVar}\\.has\\([^)]*\\)\\)\\s*\\{`).exec(window);
    if (!guard) continue;
    const braceIdx = guard.index + guard[0].length - 1;
    const [guardBody] = balanced(window, braceIdx, '{', '}');
    const push = /(\w+)\.push\(/.exec(guardBody);
    if (push) found[push[1] as string] = setVar;
  }
  return found;
}

/**
 * Blocks the twin tests exercise, DERIVED from COLLECTIONS rather than listed.
 *
 * `standaloneName` existed on each entry and nothing read it — the vestige of
 * the join this was always meant to be. A hand-written set here would be one
 * more coverage claim nobody checks: add a collection to COLLECTIONS and
 * forget the set, and its blocks read as untested-by-choice while actually
 * being tested; remove one and the set silently over-claims.
 *
 * The aggregate half is keyed by the `<name>Seen` variable in
 * decodeAllCollections, DERIVED via discoverAggregatePushTargets rather than
 * hand-written (review follow-up on #688) — a hand-written map here could
 * only ever be checked for EXISTENCE downstream (a wrong-but-real variable
 * name still "names a live block" in the staleness test below); it could
 * never be checked for whether it names the RIGHT variable, and swapping two
 * entries (`goals: 'budgetSeen'`, `budgets: 'goalSeen'`) produces the exact
 * same TWIN_TESTED set either way, so nothing would have noticed. Transactions
 * and accounts route through the shared helpers instead of their own Set, so
 * their aggregate coverage IS the helper block, and they never appear as a
 * push target here — which is why AGGREGATE_SET_VAR has no entry for them.
 */
const AGGREGATE_PUSH_TARGETS = discoverAggregatePushTargets();
const AGGREGATE_SET_VAR: Record<string, string> = Object.fromEntries(
  COLLECTIONS.filter((c) => c.name in AGGREGATE_PUSH_TARGETS).map((c) => [
    c.name,
    AGGREGATE_PUSH_TARGETS[c.name] as string,
  ])
);

const TWIN_TESTED = new Set(
  COLLECTIONS.flatMap((c) => {
    const standalone = `${c.standaloneName}|seen`;
    const aggregateVar = AGGREGATE_SET_VAR[c.name];
    return aggregateVar === undefined
      ? [standalone]
      : [standalone, `decodeAllCollections|${aggregateVar}`];
  })
);

/** Discover dedup blocks and their key expressions from the decoder source. */
function discoverDedupBlocks(): Record<string, string> {
  const source = fs.readFileSync(
    path.join(import.meta.dir, '..', '..', 'src', 'core', 'decoder.ts'),
    'utf-8'
  );
  const declarations = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map(
    (m) => [m.index, m[1] as string] as const
  );
  const found: Record<string, string> = {};
  for (const m of source.matchAll(/const (\w+) = new Set<string>\(\)/g)) {
    const variable = m[1] as string;
    const enclosing = declarations.filter(([at]) => at < (m.index as number)).pop();
    const after = source.slice((m.index as number) + m[0].length);
    const window = after.slice(0, 3000);
    const use = new RegExp(`${variable}\\.has\\(([^;]*?)\\)\\s*\\)`).exec(window);
    let key = use ? (use[1] as string).replace(/\s+/g, ' ').trim() : 'NONE';
    // Resolve a bare identifier to the expression it is assigned from. Three
    // blocks dedup on `const key = \`${a}:${b}\``, and pinning the string
    // "key" pins NOTHING — changing what key is built from would not move it.
    // That is this file's own bug class yet again: a guard recording a name
    // where it means a value.
    if (/^\w+$/.test(key)) {
      const assigned = new RegExp(`const ${key} = ([^;]+);`).exec(window);
      if (assigned) key = `${key} = ${(assigned[1] as string).replace(/\s+/g, ' ').trim()}`;
    }
    found[`${enclosing ? enclosing[1] : '?'}|${variable}`] = key;
  }
  return found;
}

describe('dedup coverage is declared, not assumed (#668 review)', () => {
  const discovered = discoverDedupBlocks();

  test('no block is pinned to a bare identifier or a field-free expression', () => {
    // The `key` resolution repaired three instances, but both of its fallbacks
    // land on a bare word — and a bare word is the "pins nothing" state that
    // repair removed. Recording it as an invariant turns a state a maintainer
    // could accidentally re-enter into one the suite rejects, which is the
    // ritual this repo runs on its own bugs.
    //
    // A resolved-but-opaque call is the same failure one layer down: `const
    // key = keyFor(row);` is not a bare word, so it survived the check above,
    // but pins the literal STRING "key = keyFor(row)" rather than any field —
    // reimplementing `keyFor` to hash `row.name` instead of `row.account_id`
    // changes what gets deduped without moving this string at all. Require at
    // least one property access (`.someField`) in the resolved expression, so
    // a pin has to name the field it claims to key on.
    const unpinned = Object.entries(DEDUP_BLOCKS)
      .filter(([, key]) => key === 'NONE' || /^\w+$/.test(key) || !/\.\w+/.test(key))
      .map(([block]) => block);
    expect(unpinned).toEqual([]);
  });

  test('discovery finds the dedup blocks at all', () => {
    // Non-vacuity: the exact comparison below would pass over an empty object.
    expect(Object.keys(discovered).length).toBeGreaterThanOrEqual(30);
  });

  test('aggregate push-target discovery finds blocks at all', () => {
    // Same non-vacuity concern one level down: if the push-target regex ever
    // stops matching, AGGREGATE_PUSH_TARGETS silently becomes `{}`,
    // AGGREGATE_SET_VAR silently becomes `{}` too, and the aggregate half of
    // TWIN_TESTED silently drops to nothing — the exact "hand-written and
    // unverified" state this derivation exists to close, just reintroduced
    // one layer down instead of fixed.
    expect(Object.keys(AGGREGATE_PUSH_TARGETS).length).toBeGreaterThanOrEqual(3);
  });

  test('derived AGGREGATE_SET_VAR is unchanged', () => {
    // Pinned like PASSTHROUGH_PROCESSORS in the sibling file: a collection's
    // aggregate dedup block entering or leaving derivation's view is a
    // visible diff, not a silent one.
    expect(AGGREGATE_SET_VAR).toEqual({
      recurring: 'recSeen',
      budgets: 'budgetSeen',
      goals: 'goalSeen',
    });
  });

  test('every dedup block and its key expression are unchanged', () => {
    // Both directions at once: a new block, a removed block, or a key changing
    // from an id to a content field all fail here.
    expect(discovered).toEqual(DEDUP_BLOCKS);
  });

  test('every block is twin-tested, structural, or listed as untested', () => {
    const unexplained = Object.keys(discovered).filter(
      (b) => !TWIN_TESTED.has(b) && !(b in STRUCTURAL_KEYS) && !UNTESTED_BY_CHOICE.has(b)
    );
    expect(unexplained).toEqual([]);
  });

  test('every stated reason still names a live block', () => {
    const stale = [...Object.keys(STRUCTURAL_KEYS), ...UNTESTED_BY_CHOICE, ...TWIN_TESTED].filter(
      (b) => !(b in discovered)
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
