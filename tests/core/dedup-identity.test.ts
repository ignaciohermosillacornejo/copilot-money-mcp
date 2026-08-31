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
 * were bought the hard way — eight revisions, each one narrower than its own
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
 *   7. the SCANNER made checkable: `discoverDedupBlocks` reads a
 *      comment-stripped window, so a dead `seen.has(...)` line above a live
 *      block can no longer win the match, and takes a `source` seam, so
 *      revisions 5 and 6 are pinned by committed fixtures instead of a
 *      mutation described in a PR body — but the window it scans was still
 *      bounded only by a character count, so it ran off the end of its own
 *      function, and the collision message it added named a cause the
 *      scanner cannot distinguish
 *   8. the window bounded at the next top-level declaration as well as by
 *      DISCOVERY_WINDOW (18 of 36 real windows overran their function), and
 *      two claims corrected to match what the code can tell: the collision
 *      message, and the non-vacuity floor's stated reason — but attribution
 *      is still top-level-`function`-only, so a Set in an arrow function or
 *      a method is credited to the preceding declaration and bounded by the
 *      following one, and stripComments's string-literal ASSUMPTION (below)
 *      is unchanged
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
 * WHICH shapes can trigger this; the two assertions below are what actually
 * close it — one on SIZE, one on CONTENT — because neither depends on
 * anticipating every shape that can go wrong.
 *
 * SIZE (`minPlausibleLength`): a real body this large does not shrink to a
 * sliver. The real body is ~18,000 characters; the floor is set with a wide
 * margin under that. But size alone is a HEURISTIC, not a content check
 * (review follow-up, round 2 of this exact finding) — it is defeated by
 * padding: `Promise<{ field0: boolean; ...400 more... } & AllCollectionsResult>`
 * produces a slice north of 7,000 characters, clearing the floor, while
 * still being the wrong slice (the type literal's padding, not the
 * function body).
 *
 * CONTENT (below): the slice must contain `const \w+ = new Set<string>\(\)`
 * — the exact construct the scan exists to find. Its absence means the scan
 * cannot possibly do its job, so this assertion fails for the same reason
 * the scan would; its presence is necessary, though (see next paragraph)
 * NOT sufficient, for the slice to be genuine.
 *
 * TRIED TO DEFEAT THIS, both attempts against the padded-type-literal shape
 * above: (1) a bare `marker: 'new Set<string>()'` field embeds the literal
 * SUBSTRING and defeats a naive `.includes()` check — closed by requiring
 * the full `const \w+ = new Set<string>\(\)` shape, not just the bare
 * text. (2) a `marker: 'const attackerVar = new Set<string>();'` field
 * embeds that FULL shape too, as string content, and DOES defeat the
 * content check — confirmed by running it through this exact regex. This
 * is not a tuning gap: a regex has no notion of "inside a string literal,"
 * so any text-based marker, however specific, can be reproduced inside a
 * string-literal-typed field by a sufficiently deliberate payload — the
 * same categorical limit `balanced()`'s own ASSUMPTION documents for
 * unbalanced brackets inside strings. Closing it fully needs a real
 * TypeScript parser, not a bigger regex; out of scope for a test-guard file
 * whose actual adversary is an accidental refactor, not a hostile input.
 * What the content check DOES close: every REALISTIC reshape (an
 * accidental brace in a return type is never accompanied by a hand-forged
 * fake dedup-block string deliberately designed to fool this exact
 * function). And even the maximally-adversarial payload above does not
 * pass silently end to end — the per-block scan in
 * `discoverAggregatePushTargets` still finds no genuine guard for the fake
 * declaration and returns `{}`, so the count-pin and the `AGGREGATE_SET_VAR`
 * pin still catch it, exactly as they did before this fix — only the
 * DIAGNOSTIC quality regresses (caught two layers downstream instead of
 * named here), not correctness.
 */
const MIN_PLAUSIBLE_BODY_LENGTH = 5000;

function decodeAllCollectionsBody(
  source: string,
  minPlausibleLength: number = MIN_PLAUSIBLE_BODY_LENGTH
): string {
  // Pre-existing brittleness, not introduced by the checks below and not
  // worth fixing: the anchor is literal about the single spaces between
  // `export`/`async`/`function`. A reformatted `export  async  function` (or
  // a linter regression that stops collapsing them) fails to match at all —
  // but that already fails LOUD, via the "could not locate" throw right
  // below, which is the failure mode every check in this function is built
  // to produce. Left as-is rather than generalized to `\s+`, since a
  // silent-partial-slice bug is what this function exists to prevent, and a
  // silent-empty-match bug is not that.
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
  if (!/const \w+ = new Set<string>\(\)/.test(body)) {
    throw new Error(
      "discoverAggregatePushTargets: decodeAllCollectionsBody extracted a body containing no `const X = new Set<string>()` declaration — it cannot be decodeAllCollections's real body, since that construct is what the scan exists to find; the anchor likely matched a brace embedded in the return type instead of the function's own opening brace"
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
  // `Object.create(null)` for the same reason as in discoverDedupBlocks below:
  // on a plain `{}`, `found['__proto__'] = setVar` creates no own property at
  // all, so `Object.hasOwn` never sees it and the target is dropped in silence
  // instead of throwing — the half of the `in` nit that `Object.hasOwn` alone
  // does not close.
  const found: Record<string, string> = Object.create(null);
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
    // `Object.hasOwn`, not `in` (review nit): `in` walks the prototype chain,
    // so a push target named `constructor`/`toString` would throw spuriously.
    // The `__proto__` half of that nit needed the null-prototype `found`
    // above, not this call — `Object.hasOwn` reports the truth there, and the
    // truth on a plain `{}` was that the write never landed. Not reachable
    // with real collection names, but the two lines now agree with each other.
    if (Object.hasOwn(found, pushTarget)) {
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
  COLLECTIONS.filter((c) => Object.hasOwn(AGGREGATE_PUSH_TARGETS, c.name)).map((c) => [
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

/**
 * Discover dedup blocks and their key expressions from the decoder source.
 *
 * `source` defaults to the real decoder so the one production call site below
 * is unaffected; the override exists so a regression fixture can be run
 * through the SAME discovery logic, the way `discoverAggregatePushTargets`
 * above and Step 1's `discoverProcessors(src)` in the sibling file already
 * are. Without the seam, the two narrowings this file is named after —
 * revision 5's `const key = ...` resolution and revision 6's `.field`
 * requirement — could only ever run against real decoder source, which by
 * construction contains no violation, so neither could be shown to fail
 * (review follow-up on #688 review).
 *
 * The window is passed through `stripComments` for the same reason the
 * sibling's is: without it, a commented-out `seen.has(...)` or `const key =`
 * line sitting between the Set declaration and the live guard is matched in
 * preference to the live one — the regexes take the FIRST match in the
 * window, and a dead line above a live block is a normal thing to write. The
 * result is a key pinned to code that no longer runs, which is this file's
 * own documented bug class (revision 3: "prose about a key can go stale")
 * with a comment standing in for the label. No live instance today — none of
 * the comments above the real blocks contain `.has(` — but this function
 * feeds every other test in the file, so it is the worst place to leave it
 * open. Note the enclosing-function scan still reads raw `source`: matching
 * the sibling exactly, only the window is stripped, keeping stripComments's
 * own string-literal ASSUMPTION scoped to a few hundred characters rather
 * than the whole 3 000-line decoder.
 *
 * The window is bounded by the NEXT function declaration as well as by
 * DISCOVERY_WINDOW (second review follow-up on #688 review). A character
 * count is not a syntactic boundary, and 18 of the decoder's 36 blocks have
 * a 3 000-character window that reaches past the end of their own function
 * today — so a Set whose own guard is removed or refactored away would be
 * pinned from the NEXT function's guard instead of reported as unguarded.
 * That is a plausible-looking wrong answer, and it is the same unbounded
 * forward scan this file's sibling closed with `balanced()` and
 * `decodeAllCollectionsBody()`; this was the last instance of it left in
 * either file. Bounding it changed no pin: comparing the char-bounded and
 * declaration-bounded resolution across all 36 real blocks yields 0
 * differences, so it closes a hole rather than moving a pin.
 *
 * ATTRIBUTION LIMIT, shared by `enclosing` and by the bound above, since
 * both read the same `declarations` list: that list comes from
 * `/^(?:export )?(?:async )?function (\w+)/gm`, which matches only
 * TOP-LEVEL `function` declarations. A Set inside an arrow function, a
 * class or object method, or an indented nested `function` is attributed to
 * whichever top-level function precedes it, and its window would extend to
 * the next top-level declaration rather than to the end of its real
 * enclosing scope. Not reachable in the decoder today — all 36 blocks sit
 * at one indent level directly inside a top-level `function` — but it is
 * why the duplicate-block throw below says "the same enclosing declaration"
 * rather than "the same function": the scanner cannot tell the difference.
 */
function discoverDedupBlocks(
  source: string = fs.readFileSync(
    path.join(import.meta.dir, '..', '..', 'src', 'core', 'decoder.ts'),
    'utf-8'
  )
): Record<string, string> {
  const declarations = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map(
    (m) => [m.index as number, m[1] as string] as const
  );
  // `Object.create(null)` for symmetry with discoverAggregatePushTargets —
  // but NOT, unlike there, because it closes anything reachable here, and
  // saying otherwise would be this file's own defect. The `__proto__`
  // silent-drop needs the literal key `__proto__`, and every key this
  // function writes is `${enclosing}|${variable}`, so it always contains a
  // `|` and can never be that string. Mutation-checked: reverting this one
  // line to `{}` leaves all tests green, which is why the pinned fixture for
  // the drop lives on the sibling scanner (whose keys ARE bare identifiers)
  // and not here. Kept so the two scanners read the same way; recorded as
  // unreachable so nobody later mistakes it for a live guard.
  const found: Record<string, string> = Object.create(null);
  for (const m of source.matchAll(/const (\w+) = new Set<string>\(\)/g)) {
    const variable = m[1] as string;
    const enclosing = declarations.filter(([at]) => at < (m.index as number)).pop();
    // Bounded by the next declaration as well as by DISCOVERY_WINDOW — see
    // the docblock above for why a character count alone is not enough.
    const start = (m.index as number) + m[0].length;
    const nextDecl = declarations.find(([at]) => at > (m.index as number));
    const end = Math.min(start + DISCOVERY_WINDOW, nextDecl ? nextDecl[0] : source.length);
    const window = stripComments(source.slice(start, end));
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
    const block = `${enclosing ? enclosing[1] : '?'}|${variable}`;
    // Same collision class discoverAggregatePushTargets now throws on, and
    // for the same reason (review follow-up on #688 review). Two
    // `new Set<string>()` with the same name in two different block scopes of
    // one function is legal TS, and last-write-wins would make one of them
    // invisible here. It IS caught downstream — `discovered` drops a key and
    // the pinned-equality test fails — but a scanner that silently discards
    // half its own input should say so where the discarding happens, not
    // leave a maintainer to infer it from a diff two tests away.
    //
    // The message says "the same enclosing declaration", not "the same
    // function" (second review follow-up): `enclosing` resolves only
    // top-level `function` declarations, so two Sets in two different arrow
    // functions would collide here too, and calling that "one function" would
    // claim more than the scanner can tell — see the ATTRIBUTION LIMIT in the
    // docblock. That matters more now the collision is fatal rather than a
    // silent overwrite: a throw's text is the only thing whoever hits it has.
    if (Object.hasOwn(found, block)) {
      throw new Error(
        `discoverDedupBlocks: block "${block}" discovered twice (keys "${found[block]}" and "${key}") — two same-named Sets under the same enclosing declaration; cannot tell which one the pin refers to`
      );
    }
    found[block] = key;
  }
  return found;
}

/**
 * Blocks whose pinned key expression names no field at all — the "pins
 * nothing" states revisions 4-6 successively narrowed (see the test below for
 * what each of them was and why one dot-check now covers all three).
 *
 * A function rather than an inline filter in the test so the fixture below
 * asserts against the SAME implementation the live invariant runs, instead of
 * a copy of it that could drift from it silently — which is the failure this
 * whole file is a detector for.
 */
function fieldFreeBlocks(blocks: Record<string, string>): string[] {
  return Object.entries(blocks)
    .filter(([, key]) => !/\.\w+/.test(key))
    .map(([block]) => block);
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
    expect(fieldFreeBlocks(discovered)).toEqual([]);
  });

  test('discovery finds the dedup blocks at all', () => {
    // The justification here used to read "the exact comparison below would
    // pass over an empty object." That is false, and saying so was the same
    // defect this file exists to remove: `expect(discovered).toEqual(
    // DEDUP_BLOCKS)` compares against a populated 36-entry literal, so `{}`
    // fails it loudly. Corrected rather than deleted, because the floor does
    // earn its place — for a different reason (second review follow-up).
    //
    // What it actually catches is the two-step workflow: discovery breaks,
    // AND a maintainer regenerates DEDUP_BLOCKS from the broken output to get
    // green again. The pinned comparison cannot see that — the pin and the
    // scan agree, both on nothing — and every downstream test that reads
    // `discovered` (the field-free invariant, the twin-tested check) is
    // vacuously satisfied by an empty map. A floor is the one assertion in
    // this describe that survives regenerating the pin, which is the same
    // argument the `toBe(25)` count pin makes two tests down.
    //
    // `>= 30` against 36 real IS a margin here, unlike that pin: this scan
    // covers blocks the file does not otherwise enumerate one by one, and the
    // exact count is already pinned by DEDUP_BLOCKS itself.
    expect(Object.keys(discovered).length).toBeGreaterThanOrEqual(30);
  });

  test('aggregate push-target discovery finds exactly 25 blocks (count pin, not a loose floor)', () => {
    // Renamed from "...finds blocks at all" (review follow-up): that name
    // described a non-vacuity check, but the value — 25, the real count —
    // behaves as an exact-count PIN with zero headroom.
    //
    // Asserted with `toBe`, not `toBeGreaterThanOrEqual` (second review
    // follow-up): "exactly 25" is a TWO-sided claim and a floor is one-sided,
    // so a 26th aggregate dedup block used to pass this test in silence — a
    // test whose name asserted more than its expression did, which is the
    // exact defect this file exists to remove. Now removing a legitimate
    // collection from decodeAllCollections turns this red at "Expected: 25,
    // Received: 24" and adding one at "Received: 26". That tightness is
    // deliberate, not an oversight — do not "fix" it by loosening back toward
    // a wide margin (contrast the sibling `discovered` floor at `>= 30`
    // against 36 real, which genuinely IS a margin, chosen because that scan
    // covers blocks this file does not otherwise pin one by one). The
    // tightness here is what turns decodeAllCollectionsBody's two
    // silent-partial-slice failure modes — an anchor matching an embedded
    // brace in the return type, or a balanced() run-off — into loud ones:
    // both now throw before this test even runs (see
    // decodeAllCollectionsBody's own assertion), but if that assertion were
    // ever removed, THIS count is the last line of defense, and the floor of
    // 3 this test originally carried (sized only to cover the 3 collections
    // AGGREGATE_SET_VAR filters down to) would not have caught a scan that
    // regressed to finding just those three, silently losing visibility into
    // the other 22.
    expect(Object.keys(AGGREGATE_PUSH_TARGETS).length).toBe(25);
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

  test('a push target named __proto__ collides loudly rather than vanishing', () => {
    // Pins the `Object.create(null)` half of the `in` -> `Object.hasOwn` nit.
    // On a plain `{}` both writes to `found['__proto__']` are silent no-ops:
    // no own property is created, `Object.hasOwn` stays false, nothing
    // throws, and the block is simply absent from the result — the same
    // silence the nit was raised about, one step later. Unreachable with real
    // collection names; pinned anyway, because an unreachable fix that no
    // test can detect being reverted is exactly what this PR exists to stop
    // shipping.
    const FIXTURE_SRC = `
export async function decodeAllCollections(dbPath: string): Promise<unknown> {
  const aSeen = new Set<string>();
  const __proto__: string[] = [];
  if (!aSeen.has(item.id)) {
    aSeen.add(item.id);
    __proto__.push(item);
  }
  const bSeen = new Set<string>();
  if (!bSeen.has(item.id)) {
    bSeen.add(item.id);
    __proto__.push(item);
  }
}
`;
    expect(() => discoverAggregatePushTargets(FIXTURE_SRC, 0)).toThrow(/push target "__proto__"/);
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

// ---------------------------------------------------------------------------
// Regression: padding a type literal past the length floor must still not
// pass silently — the content marker is the second, independent check
// (review follow-up, round 2 of the #688 review)
// ---------------------------------------------------------------------------

describe('decodeAllCollectionsBody rejects a padded-but-content-free slice (#688 review)', () => {
  test('400 fake fields clear the length floor but contain no Set declaration — caught by the content marker', () => {
    // The demonstrated attack: pad the same brace-in-return-type shape with
    // enough harmless fields to clear MIN_PLAUSIBLE_BODY_LENGTH. The slice
    // is now long enough to pass the size check, and is STILL the wrong
    // slice — the type literal's padding, not the function body. Real
    // decodeAllCollections's own body always contains at least one
    // `const X = new Set<string>()`; this padding, by construction, never
    // does.
    const fields = Array.from({ length: 400 }, (_, i) => `field${i}: boolean`).join('; ');
    const FIXTURE_SRC = `
export async function decodeAllCollections(dbPath: string): Promise<{ ${fields} } & AllCollectionsResult> {
  const xSeen = new Set<string>();
}
`;
    expect(() => discoverAggregatePushTargets(FIXTURE_SRC)).toThrow(
      /no `const X = new Set<string>\(\)` declaration/
    );
  });
});

// ---------------------------------------------------------------------------
// Documented, accepted residual: a payload that embeds the content marker
// ITSELF inside a string-literal-typed field defeats decodeAllCollectionsBody's
// checks — the same categorical limit balanced()'s own ASSUMPTION already
// documents for unbalanced brackets inside strings. Not a regression guard
// for a bug this PR fixes; a permanent, executable record that even the
// worst case does not pass silently END TO END, because the downstream
// per-block scan still finds nothing to attribute.
// ---------------------------------------------------------------------------

describe('a maximally-adversarial payload defeats the slicer but not the downstream pins (#688 review)', () => {
  test('embedding the exact marker text as string content clears both slicer checks, yet the scan still finds nothing', () => {
    const fields = Array.from({ length: 400 }, (_, i) => `field${i}: boolean`).join('; ');
    const FIXTURE_SRC = `
export async function decodeAllCollections(dbPath: string): Promise<{ marker: 'const attackerVar = new Set<string>();'; ${fields} } & AllCollectionsResult> {
  const xSeen = new Set<string>();
}
`;
    // decodeAllCollectionsBody does NOT throw — both its checks pass on the
    // wrong slice, exactly as documented above.
    const found = discoverAggregatePushTargets(FIXTURE_SRC);
    // But the per-block scan, run on that wrong slice, finds no genuine
    // `.has(...)`-guarded `.push(` for the fake declaration — the STRING
    // content has the shape of a Set declaration but not of a real guard —
    // so the overall result is still the empty map the count-pin and the
    // AGGREGATE_SET_VAR pin would both catch downstream. Silently WRONG
    // slice, but not silently PASSING.
    expect(found).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Regression: discoverDedupBlocks' OWN scan (review follow-up on #688 review)
//
// Until this round it was the one scanner in either file with no `source`
// seam and no stripComments on its window — so the two narrowings this file
// is named after, revision 5's `const key = ...` resolution and revision 6's
// `.field` requirement, could only ever run against real decoder source,
// which by construction violates neither. Their non-vacuity rested on a
// manual mutation described in a PR body, which is a coverage claim that is
// not in the repo and cannot survive the next refactor. These fixtures make
// both narrowings, and the comment strip they depend on, fail on demand.
// ---------------------------------------------------------------------------

describe('discoverDedupBlocks strips comments before matching (#688 review)', () => {
  test('a commented-out guard above the live one does not win the key', () => {
    // Both regexes take the FIRST match in the window, and a dead line kept
    // above a live block is a normal thing to write. Unstripped, the `.has(`
    // match lands on the comment and the block is pinned to `thing.name` — a
    // key nothing dedups on. A maintainer then updates DEDUP_BLOCKS to match
    // "what the scan found", bakes the dead key in, and from then on changing
    // the LIVE key never moves the pin: revision 3's stale-prose defect with
    // a comment standing in for the label.
    const FIXTURE_SRC = `
export function decodeThings(): unknown {
  const seen = new Set<string>();
  // superseded, kept for context: if (!seen.has(thing.name)) {
  for (const thing of raw) {
    if (!seen.has(thing.thing_id)) {
      seen.add(thing.thing_id);
    }
  }
}
`;
    expect(discoverDedupBlocks(FIXTURE_SRC)).toEqual({ 'decodeThings|seen': 'thing.thing_id' });
  });

  test('a commented-out const key above the live one does not win the resolution', () => {
    // The other half of the same exposure, one layer down: the guard here is
    // unambiguous (`seen.has(key)` appears once), but resolving the bare
    // identifier `key` re-scans the window for `const key = ...;` and,
    // unstripped, finds the superseded line first — resolving to a field the
    // live code never reads.
    const FIXTURE_SRC = `
export function decodeKeyed(): unknown {
  const seen = new Set<string>();
  for (const row of raw) {
    // superseded, kept for context: const key = \`\${row.legacy_name}\`;
    const key = \`\${row.owner_id}:\${row.month}\`;
    if (!seen.has(key)) {
      seen.add(key);
    }
  }
}
`;
    expect(discoverDedupBlocks(FIXTURE_SRC)).toEqual({
      'decodeKeyed|seen': 'key = `${row.owner_id}:${row.month}`',
    });
  });
});

describe('discoverDedupBlocks resolves and grades a bare key (#688 review)', () => {
  // Two blocks whose guards both read a bare `key`, differing only in what
  // that key is built from: one from an opaque call, one from two fields.
  // Between them they exercise revision 5 (resolve the identifier at all) and
  // revision 6 (the resolved text must still name a field) on source that
  // actually contains a violation, which the real decoder never does.
  const FIXTURE_SRC = `
export function decodeOpaque(): unknown {
  const seen = new Set<string>();
  for (const row of raw) {
    const key = keyFor(row);
    if (!seen.has(key)) {
      seen.add(key);
    }
  }
}

export function decodeComposite(): unknown {
  const seen = new Set<string>();
  for (const row of raw) {
    const key = \`\${row.owner_id}:\${row.month}\`;
    if (!seen.has(key)) {
      seen.add(key);
    }
  }
}
`;

  test('a bare identifier is resolved to the expression it is assigned from', () => {
    // Revision 5. Without the resolution both blocks would pin the string
    // "key", and rewriting what the key is built from would not move either.
    expect(discoverDedupBlocks(FIXTURE_SRC)).toEqual({
      'decodeOpaque|seen': 'key = keyFor(row)',
      'decodeComposite|seen': 'key = `${row.owner_id}:${row.month}`',
    });
  });

  test('a resolved-but-field-free key is reported; a field-bearing one is not', () => {
    // Revision 6, run through the SAME fieldFreeBlocks the live invariant
    // above uses. `key = keyFor(row)` is not a bare word, so revision 5's
    // check passed it, yet it names no field: reimplementing `keyFor` to hash
    // a different column changes what gets deduped without moving the pin.
    expect(fieldFreeBlocks(discoverDedupBlocks(FIXTURE_SRC))).toEqual(['decodeOpaque|seen']);
  });
});

describe('discoverDedupBlocks fails loudly on a duplicate block key (#688 review)', () => {
  test('two same-named Sets in one function throw instead of overwriting', () => {
    // Legal TS, and before the check the second simply overwrote the first in
    // `found` — one real dedup block invisible to every test in this file.
    // It was caught downstream (the pinned-equality test would show a missing
    // key), but the collision belongs where the collision happens, which is
    // the standard discoverAggregatePushTargets already holds.
    const FIXTURE_SRC = `
export function decodeTwoScopes(): unknown {
  {
    const seen = new Set<string>();
    if (!seen.has(a.a_id)) {
      seen.add(a.a_id);
    }
  }
  {
    const seen = new Set<string>();
    if (!seen.has(b.b_id)) {
      seen.add(b.b_id);
    }
  }
}
`;
    expect(() => discoverDedupBlocks(FIXTURE_SRC)).toThrow(/block "decodeTwoScopes\|seen"/);
    // And the message says only what the scanner can tell: `enclosing`
    // resolves top-level `function` declarations only, so two Sets in two
    // different arrow functions collide here as well, and calling that "two
    // same-named Sets in one function" — as this message did — would claim
    // more than the code knows. Pinned, because a message that overclaims is
    // the same defect as a test name that overclaims, and this one is fatal.
    expect(() => discoverDedupBlocks(FIXTURE_SRC)).toThrow(/same enclosing declaration/);
  });
});

describe('discoverDedupBlocks bounds its window at the next declaration (#688 review)', () => {
  test('a Set whose own guard is gone reports NONE, not a key from the next function', () => {
    // DISCOVERY_WINDOW is a character count, not a syntactic boundary, and 18
    // of the decoder's 36 real blocks have a 3 000-character window that
    // reaches past the end of their own function. So a Set whose guard was
    // removed or refactored away does not come back as unguarded — the scan
    // walks into the NEXT function and pins it to a guard that belongs to
    // something else. `decodeUnguarded|seen` would be pinned to `row.row_id`,
    // which looks like a perfectly good answer and is the wrong one; the
    // field-free invariant would pass it, and the maintainer who regenerates
    // DEDUP_BLOCKS from it bakes in a claim about code that does not exist.
    // Same unbounded-forward-scan class `balanced()` and
    // decodeAllCollectionsBody() close for the sibling scanner.
    const FIXTURE_SRC = `
export function decodeUnguarded(): unknown {
  const seen = new Set<string>();
  const ids = raw.map((r) => r.thing_id);
}

export function decodeGuarded(): unknown {
  const seen = new Set<string>();
  if (!seen.has(row.row_id)) {
    seen.add(row.row_id);
  }
}
`;
    expect(discoverDedupBlocks(FIXTURE_SRC)).toEqual({
      'decodeUnguarded|seen': 'NONE',
      'decodeGuarded|seen': 'row.row_id',
    });
  });

  test('an unguarded Set is then reported by the field-free invariant', () => {
    // The bound is only useful because `NONE` is a state the live invariant
    // rejects: bounding the window turns a plausible wrong key into a loud
    // one rather than into a different kind of silence.
    const FIXTURE_SRC = `
export function decodeUnguarded(): unknown {
  const seen = new Set<string>();
  const ids = raw.map((r) => r.thing_id);
}

export function decodeGuarded(): unknown {
  const seen = new Set<string>();
  if (!seen.has(row.row_id)) {
    seen.add(row.row_id);
  }
}
`;
    expect(fieldFreeBlocks(discoverDedupBlocks(FIXTURE_SRC))).toEqual(['decodeUnguarded|seen']);
  });
});
