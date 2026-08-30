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
 *      be non-bare — but the check is on the call SITE's text: `key =
 *      keyFor(row.id)` contains `.id` and passes, though `keyFor` could
 *      compute anything from that argument; narrows the opaque-call class
 *      rather than closing it
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
 * ASSUMPTION: no string literal in a scanned region contains `//` or a block
 * comment opener. Mirrors the identically-named helper in
 * decoder-field-completeness.test.ts. Applied to the WINDOW below before
 * `balanced()` ever sees it — an unstripped comment containing an unbalanced
 * `{` or `}` would otherwise shift where `balanced()` thinks the guard body
 * ends, in either direction.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Slice out `open`..`close` starting at `openIdx`, counting nesting depth.
 *
 * ASSUMPTION: no string literal inside the region contains an unbalanced
 * bracket or brace. True for guard bodies today — zero of the 36 real dedup
 * blocks contain one — but unlike the comment half of this same risk (closed
 * outright by stripComments above, applied to the window before balanced()
 * ever sees it), the string half is not fixed here, only unexercised so far.
 * The failure direction is NOT symmetric: a stray `{` inside a string FAILS
 * OPEN — depth never returns to 0 where the real guard closes, the boundary
 * shifts outward, and a later unrelated `.push(` can be mis-credited to this
 * Set variable, the exact class Step 1 fixed in the sibling file (and that
 * this file's own fixture above pins for the comment-free case). A stray `}`
 * FAILS CLOSED — depth reaches 0 early, the guard body truncates, and a real
 * push inside it goes missing, which is loud rather than silent: the dropped
 * block fails the `discoverAggregatePushTargets` non-vacuity floor and the
 * pinned-equality test below. Same class of assumption as stripComments
 * above.
 *
 * Mirrors the identically-named helper in decoder-field-completeness.test.ts,
 * including this same ASSUMPTION, carried here rather than left to diverge
 * from it. One place the two DO differ: the sibling's own `functionBody()`
 * calls `balanced()` on raw, UNSTRIPPED `src` to find a `process*` function's
 * outer body extent, stripping only the RESULT afterward — so "the sibling
 * never runs balanced() on raw source" is not true of it in general. This
 * copy is narrower: `discoverAggregatePushTargets` strips the window before
 * `balanced()` ever runs on it, so THIS copy never sees raw text at all.
 *
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
 * How far past a `new Set<string>()` declaration a discovery scan looks for
 * its `.has(` guard (and, below, the guarded block's `.push(`). Shared by
 * both discovery functions in this file so the assumption is stated once
 * instead of twice: a guard further than this from its Set declaration is
 * skipped in silence, not reported. Every real block today sits within a
 * few dozen characters of its Set — this is a generous margin, not a tight
 * one.
 */
const DISCOVERY_WINDOW = 3000;

/**
 * The body of `decodeAllCollections`, sliced out of `source` so
 * `discoverAggregatePushTargets` only ever scans that one function — not the
 * whole file, which an earlier revision did despite documenting itself as
 * scoped to `decodeAllCollections`. That mismatch was not just inaccurate
 * prose: the file-wide scan already collides today. Ten standalone
 * decode-prefixed/dedupe-prefixed functions each build their own local
 * `seen` guard pushing into a locally-scoped array every one of them names
 * `unique` — ten functions, one shared array name, silently overwriting
 * `found['unique']` nine times over (harmless only because no `COLLECTIONS`
 * name is `'unique'`). Scoping to `decodeAllCollections` removes that
 * collision class outright rather than merely tolerating it.
 *
 * Two failure modes, both closed HERE rather than left for the floor test or
 * the AGGREGATE_SET_VAR pin two layers downstream to catch by accident
 * (review follow-up — mutation-verified both were only caught that far away
 * before this fix):
 *
 *   - The anchor requires a `:` before the first `{`, so it needs an actual
 *     return type annotation — but that alone does NOT rule out a return
 *     type whose own annotation contains a brace, e.g.
 *     `Promise<{ ok: boolean } & AllCollectionsResult>`. The anchor would
 *     then match early, on the TYPE LITERAL's own `{`, and `balanced()`
 *     would faithfully return that bracket's contents: short, non-empty,
 *     structurally plausible-looking text containing none of
 *     `decodeAllCollections`'s real dedup blocks.
 *   - A `balanced()` run-off (no matching close found before the source
 *     ends) fails the same way one level further: an EMPTY string.
 *
 * Both are "a parser silently returns an empty or partial slice" — the exact
 * construct the sibling PR (#685/#688 test-guard cleanup) has spent several
 * revisions closing elsewhere in this repo. The regex tightening narrows
 * WHICH shapes can trigger this; the length assertion is what actually
 * closes it, because it does not depend on anticipating every shape that
 * can go wrong — only on the fact that a real function body this large does
 * not shrink to a sliver. The real body is ~18,000 characters; the floor
 * below is set with a wide margin under that, wide enough to never trip on
 * a legitimate edit, tight enough that no degenerate slice can sneak under
 * it undetected.
 */
const MIN_PLAUSIBLE_BODY_LENGTH = 5000;

function decodeAllCollectionsBody(
  source: string,
  minPlausibleLength: number = MIN_PLAUSIBLE_BODY_LENGTH
): string {
  const decl = /^export async function decodeAllCollections\([^)]*\)\s*:[^{]*\{/m.exec(source);
  if (!decl) {
    throw new Error(
      'discoverAggregatePushTargets: could not locate `decodeAllCollections` in the given source — the scan is scoped to its body and cannot run without it'
    );
  }
  const braceIdx = (decl.index as number) + decl[0].length - 1;
  const [body] = balanced(source, braceIdx, '{', '}');
  if (body.length < minPlausibleLength) {
    throw new Error(
      `discoverAggregatePushTargets: decodeAllCollectionsBody extracted an implausibly short body (${body.length} chars, expected at least ${minPlausibleLength}) — the anchor likely matched a brace embedded in the return type instead of the function's own opening brace, or balanced() ran off the end of the source without finding a match`
    );
  }
  return body;
}

/**
 * For each dedup block INSIDE `decodeAllCollections`, the name of the array
 * its guarded `.push()` feeds. `decodeAllCollections` builds every
 * inline-block collection with the identical shape — `if (!XSeen.has(id)) {
 * XSeen.add(id); arr.push(item); }` — and returns `arr` under the field name
 * that shape's own `const arr: T[] = []` declares, so the push target names
 * the collection as reliably as `standaloneName` (below) names the
 * standalone decoder's function. Read independently of `discoverDedupBlocks`,
 * on its own pass over the source, so a bug in one discovery function cannot
 * mask a bug in the other.
 *
 * Scoped via `decodeAllCollectionsBody` above (review follow-up: an earlier
 * revision scanned the whole file, which both misdescribed itself and
 * depended on no two blocks anywhere in decoder.ts ever sharing a push-target
 * name — untrue today, see that function's doc). A push target seen twice
 * WITHIN the scoped body still throws rather than silently overwriting —
 * belt and suspenders against a future block inside `decodeAllCollections`
 * colliding with another, the way `deduplicateAccounts` and
 * `deduplicateTransactions` already route their standalone dedup logic in
 * from outside; if a collection's dedup were ever inlined the same way,
 * a name collision here should fail the run, not the wrong test pass.
 *
 * The `.push(` search is bounded to the guard's OWN braced body via
 * `balanced()`, not a forward scan across the whole window — a forward scan
 * for the next `.push(` anywhere ahead can cross the guard's closing brace
 * and credit an unrelated later block's push to this Set variable. `source`
 * defaults to the real decoder so the one production call site below is
 * unaffected; the override exists so a regression fixture (a synthetic
 * source snippet reproducing exactly this hazard) can be run through the
 * SAME discovery logic, the way Step 1's `discoverProcessors(src)` does in
 * the sibling file. A fixture's synthetic source must wrap its guard in a
 * `decodeAllCollections`-shaped declaration, the same way real source is
 * scoped — see the fixtures below.
 */
function discoverAggregatePushTargets(
  source: string = fs.readFileSync(
    path.join(import.meta.dir, '..', '..', 'src', 'core', 'decoder.ts'),
    'utf-8'
  ),
  // Passed through to decodeAllCollectionsBody. Defaults to the real
  // production floor; fixtures below that are testing something OTHER than
  // the length assertion itself override it down, since a synthetic snippet
  // a few hundred characters long is not — and should not have to
  // pretend to be — a plausible decodeAllCollections body.
  minPlausibleLength: number = MIN_PLAUSIBLE_BODY_LENGTH
): Record<string, string> {
  const scoped = decodeAllCollectionsBody(source, minPlausibleLength);
  const found: Record<string, string> = {};
  for (const m of scoped.matchAll(/const (\w+) = new Set<string>\(\)/g)) {
    const setVar = m[1] as string;
    const window = stripComments(
      scoped.slice(
        (m.index as number) + m[0].length,
        (m.index as number) + m[0].length + DISCOVERY_WINDOW
      )
    );
    const guard = new RegExp(`if \\(!${setVar}\\.has\\([^;]*?\\)\\)\\s*\\{`).exec(window);
    if (!guard) continue;
    const braceIdx = guard.index + guard[0].length - 1;
    const [guardBody] = balanced(window, braceIdx, '{', '}');
    const push = /(\w+)\.push\(/.exec(guardBody);
    if (!push) continue;
    const pushTarget = push[1] as string;
    if (pushTarget in found) {
      throw new Error(
        `discoverAggregatePushTargets: push target "${pushTarget}" already attributed to Set variable "${found[pushTarget]}"; also matched by "${setVar}" — cannot tell which one owns it`
      );
    }
    found[pushTarget] = setVar;
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
// Runs at MODULE SCOPE, not inside a test — so any of the throws inside
// discoverAggregatePushTargets / decodeAllCollectionsBody (missing
// declaration, implausibly short slice, duplicate push target) fails to
// even LOAD this file, taking down every test in it, not just the
// aggregate-specific ones below. That is the intended behavior — a throw
// here means the guard cannot do its job at all, and a module that fails to
// load is about as loud as a failure can get — but it should not surprise
// whoever hits it and sees the whole file red instead of one test.
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
    const window = after.slice(0, DISCOVERY_WINDOW);
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
    // key = keyFor(row);` is not a bare word, but pins the literal STRING
    // "key = keyFor(row)" rather than any field — reimplementing `keyFor` to
    // hash `row.name` instead of `row.account_id` changes what gets deduped
    // without moving this string at all. Requiring a property access
    // (`.someField`) in the resolved expression subsumes the two earlier,
    // narrower checks this test used to spell out as separate disjuncts —
    // `key === 'NONE'` and a bare `/^\w+$/` word — since neither ever
    // contains a dot; a single check now covers all three revisions' worth
    // of "pins nothing" shapes.
    //
    // Filters `discovered`, the LIVE scan, not `DEDUP_BLOCKS`, the pin: on a
    // genuinely new field-free block, `DEDUP_BLOCKS` hasn't been told about
    // it yet, so filtering the pin would pass here and fail only in the
    // separate sync test below — a two-step ratchet a maintainer could stop
    // partway through. Filtering `discovered` makes it fail here directly,
    // in the test whose name actually describes the invariant.
    const unpinned = Object.entries(discovered)
      .filter(([, key]) => !/\.\w+/.test(key))
      .map(([block]) => block);
    expect(unpinned).toEqual([]);
  });

  test('discovery finds the dedup blocks at all', () => {
    // Non-vacuity: the exact comparison below would pass over an empty object.
    expect(Object.keys(discovered).length).toBeGreaterThanOrEqual(30);
  });

  test('aggregate push-target discovery finds exactly 25 blocks (count pin, not a loose floor)', () => {
    // Renamed from "...finds blocks at all" (review follow-up): that name
    // described a non-vacuity check, but the value — 25, the real count —
    // behaves as an exact-count PIN with zero headroom. Removing one
    // legitimate collection from decodeAllCollections turns this red at
    // "Expected >= 25, Received 24", not just at total collapse. That is
    // deliberate, not an oversight — do not "fix" the apparent tightness by
    // loosening it back toward a wide margin (contrast the sibling
    // `discovered` floor at `>= 30` against 36 real, which genuinely IS a
    // margin, chosen because that scan covers blocks this file does not
    // otherwise pin one by one). The tightness here is what turns
    // decodeAllCollectionsBody's two silent-partial-slice failure modes —
    // an anchor matching an embedded brace in the return type, or a
    // balanced() run-off — into loud ones: both now throw before this test
    // even runs (see decodeAllCollectionsBody's own assertion), but if that
    // assertion were ever removed, THIS floor is the last line of defense,
    // and a floor of 3 (this test's original value, sized only to cover the
    // 3 collections AGGREGATE_SET_VAR filters down to) would not have
    // caught a scan that regressed to finding just those three, silently
    // losing visibility into the other 22.
    expect(Object.keys(AGGREGATE_PUSH_TARGETS).length).toBeGreaterThanOrEqual(25);
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

// ---------------------------------------------------------------------------
// Regression: the aggregate push-target scan must not cross the guard's brace
// ---------------------------------------------------------------------------

describe('aggregate push-target scan does not cross the guard boundary (#688 review)', () => {
  // A guard whose OWN braced body has no `.push(` call at all, immediately
  // followed by an UNRELATED `.push(` outside it. The pre-bound scanner
  // searched forward for the next `.push(` anywhere in the window and would
  // credit `unrelatedArray` to `xSeen` even though `xSeen`'s own guard never
  // pushes anything. Wrapped in a synthetic decodeAllCollections — the real
  // scan is scoped to it (see decodeAllCollectionsBody), so a fixture must
  // supply one too.
  const FIXTURE_SRC = `
export async function decodeAllCollections(dbPath: string): Promise<unknown> {
  const xSeen = new Set<string>();
  const unrelatedArray: string[] = [];
  for (const item of rawItems) {
    if (!xSeen.has(item.id)) {
      xSeen.add(item.id);
    }
  }
  unrelatedArray.push(item);
}
`;

  test('the unrelated later push is not credited to the bounded guard', () => {
    expect(discoverAggregatePushTargets(FIXTURE_SRC, 0)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Documented, accepted residual: string-literal braces (not comments) in a
// guard body are still unhandled — see balanced()'s ASSUMPTION above. These
// are NOT regression guards for a bug this PR fixes; they are a permanent,
// executable record of the two failure directions that ASSUMPTION names,
// verified against the real scanner rather than left as prose alone.
// ---------------------------------------------------------------------------

describe('string-literal braces in a guard body are an accepted, open residual (#688 review)', () => {
  test('a stray { inside a string literal fails OPEN: the boundary can shift past the guard and mis-credit a later push', () => {
    // The extra unmatched `{` inside `'{'` leaves balanced() one level of
    // depth short when it reaches the guard's real closing `}`, so it keeps
    // scanning — and the next `}` in the source (here, an enclosing block's)
    // closes it one level too late, sweeping in the unrelated push between.
    // Wrapped in a synthetic decodeAllCollections (same reason as above),
    // with one further trailing `}`: decodeAllCollectionsBody's OWN scan
    // starts even further back, at the function's own brace, so IT also
    // needs one extra close to reach depth 0 before running off the fixture
    // — the same shift, one level further out, and the same fix.
    const FIXTURE_SRC = `
export async function decodeAllCollections(dbPath: string): Promise<unknown> {
  const ySeen = new Set<string>();
  const unrelatedY: string[] = [];
  {
    if (!ySeen.has(item.id)) {
      const legacyShape = '{';
      ySeen.add(item.id);
    }
    unrelatedY.push(item);
  }
}
}
`;
    expect(discoverAggregatePushTargets(FIXTURE_SRC, 0)).toEqual({ unrelatedY: 'ySeen' });
  });

  test('a stray } inside a string literal fails CLOSED: the guard body truncates and a real push goes missing rather than misattributed', () => {
    // The extra unmatched `}` inside `'}'` satisfies balanced()'s depth
    // check early, before the guard's own real close — the returned body is
    // truncated mid-string, and the genuine push after it is never seen.
    // Wrapped in a synthetic decodeAllCollections, same reason as above.
    const FIXTURE_SRC = `
export async function decodeAllCollections(dbPath: string): Promise<unknown> {
  const zSeen = new Set<string>();
  if (!zSeen.has(item.id)) {
    const legacyShape = '}';
    zSeen.add(item.id);
    zArray.push(item);
  }
}
`;
    expect(discoverAggregatePushTargets(FIXTURE_SRC, 0)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Regression: scope and collision safety (review follow-up on #688 review)
// ---------------------------------------------------------------------------

describe('discoverAggregatePushTargets fails loudly rather than silently (#688 review)', () => {
  test('a push target seen twice in the scoped body throws instead of overwriting', () => {
    // Two independent guards, both feeding an array named `shared`. Before
    // scoping + this check, `found['shared']` would just silently end up
    // pointing at whichever Set variable came last in file order.
    const FIXTURE_SRC = `
export async function decodeAllCollections(dbPath: string): Promise<unknown> {
  const aSeen = new Set<string>();
  const shared: string[] = [];
  if (!aSeen.has(item.id)) {
    aSeen.add(item.id);
    shared.push(item);
  }
  const bSeen = new Set<string>();
  if (!bSeen.has(item.id)) {
    bSeen.add(item.id);
    shared.push(item);
  }
}
`;
    expect(() => discoverAggregatePushTargets(FIXTURE_SRC, 0)).toThrow(/push target "shared"/);
  });

  test('a source with no decodeAllCollections throws rather than silently scanning nothing (or everything)', () => {
    const FIXTURE_SRC = `
export async function someOtherFunction(): Promise<unknown> {
  const aSeen = new Set<string>();
  const arr: string[] = [];
  if (!aSeen.has(item.id)) {
    aSeen.add(item.id);
    arr.push(item);
  }
}
`;
    expect(() => discoverAggregatePushTargets(FIXTURE_SRC)).toThrow(
      /could not locate `decodeAllCollections`/
    );
  });
});

// ---------------------------------------------------------------------------
// Regression: the guard regex must survive a nested paren in `.has(...)`
// (review follow-up on #688 review — aligning the two `.has(` patterns)
// ---------------------------------------------------------------------------

describe('guard regex handles a nested paren in .has(...) (#688 review)', () => {
  test('if (!seen.has(String(x))) is still matched, not silently skipped', () => {
    // Before aligning with discoverDedupBlocks's `[^;]*?` shape, the guard
    // regex used `[^)]*`, which cannot consume the inner `)` of `String(x)`
    // at all — the whole guard match failed, and the block was skipped in
    // silence rather than reported.
    const FIXTURE_SRC = `
export async function decodeAllCollections(dbPath: string): Promise<unknown> {
  const nestedSeen = new Set<string>();
  const nestedArr: string[] = [];
  if (!nestedSeen.has(String(x))) {
    nestedSeen.add(String(x));
    nestedArr.push(x);
  }
}
`;
    expect(discoverAggregatePushTargets(FIXTURE_SRC, 0)).toEqual({ nestedArr: 'nestedSeen' });
  });
});

// ---------------------------------------------------------------------------
// Regression: an embedded brace in the return type must not silently
// produce a partial slice (review follow-up on #688 review)
// ---------------------------------------------------------------------------

describe('decodeAllCollectionsBody rejects an implausibly short slice (#688 review)', () => {
  test('a return type containing a brace makes the anchor match early — caught by the length assertion, not silently returning zero targets', () => {
    // `Promise<{ ok: boolean } & AllCollectionsResult>` — the anchor's
    // `[^{]*` stops at the type literal's OWN `{`, not the function body's,
    // so balanced() faithfully extracts just the few characters of ` ok:
    // boolean ` as `scoped` if nothing catches it. Before the length
    // assertion, this returned `{}` silently, detected only two layers
    // downstream by the non-vacuity floor and the AGGREGATE_SET_VAR pin.
    // No override on the call below — this fixture exercises the REAL
    // production default (5000), not a relaxed one, since the whole point
    // is proving that default actually protects the real call site.
    const FIXTURE_SRC = `
export async function decodeAllCollections(dbPath: string): Promise<{ ok: boolean } & AllCollectionsResult> {
  const xSeen = new Set<string>();
  const arr: string[] = [];
  if (!xSeen.has(item.id)) {
    xSeen.add(item.id);
    arr.push(item);
  }
}
`;
    expect(() => discoverAggregatePushTargets(FIXTURE_SRC)).toThrow(/implausibly short body/);
  });
});
