/**
 * Tier-1 cache smoke — invariants over the REAL local Firestore cache (#622).
 *
 * The conformance ledger and the Tier-0/1 GraphQL smokes cover the *API*
 * boundary. Nothing covered the *decode* boundary, and that is where #622 and
 * #624 both lived: code that reads a data shape reality does not have, with
 * fixtures written from the same wrong assumption, so the suite stays green
 * while every real read is wrong.
 *
 * Synthetic tests cannot catch that class by construction. The only available
 * oracle is the cache itself, so these checks compare what the decoder produces
 * against what is actually on disk.
 *
 * Run: `bun run smoke:cache`
 *
 * READS ONLY — nothing here mutates, and no network request is made. Requires a
 * local Copilot cache; without one it exits 0 with `no-cache-found` rather than
 * failing, so it is safe in CI.
 *
 * PII: logs counts, collection paths, and field NAMES only — never values,
 * document ids, amounts, or names. Field names are taken from processors'
 * `consumed` lists (code, not data) wherever possible. Note that a few
 * collections use dynamic map keys that ARE sensitive, so per-document field
 * names are aggregated and only reported for the allowlisted collections below.
 */

import { iterateDocuments } from '../../src/core/leveldb-reader.js';
import {
  decodeAllCollections,
  decodeTransactions,
  decodeAccounts,
  decodeRecurring,
  decodeBudgets,
  decodeGoals,
  decodeGoalHistory,
  decodeInvestmentPrices,
  decodeItems,
  decodeCategories,
  routeCollection,
  COLLECTION_ROUTES,
  isDecodableTransactionDocument,
  transactionDocumentId,
  getString,
} from '../../src/core/decoder.js';
import type { AllCollectionsResult, CollectionRoute } from '../../src/core/decoder.js';
import { CopilotDatabase, missingDatabaseError } from '../../src/core/database.js';
import type { FirestoreValue } from '../../src/core/protobuf-parser.js';

export type Status = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';

interface Check {
  name: string;
  status: Status;
  detail: string;
}

const results: Check[] = [];

function record(name: string, status: Status, detail: string): void {
  results.push({ name, status, detail });
  console.error(`[cache-smoke] ${status.padEnd(4)} ${name} — ${detail}`);
}

/**
 * Collapse `items/{id}/accounts` to a wildcarded `items/<id>/accounts` so paths group.
 *
 * Firestore paths alternate collection/document, so odd-indexed segments are
 * document ids. Wildcarding them is also what keeps this PII-safe: real
 * document ids never reach the output.
 */
export function normalizeCollection(collection: string): string {
  return collection
    .split('/')
    .map((seg, i) => (i % 2 === 1 ? '*' : seg))
    .join('/');
}

/**
 * The #622 signature: documents exist on disk and the decoder produced none.
 * Distinguished from a genuinely empty collection, which is check 3's job.
 */
export function isTotalDecodeLoss(rawNonEmpty: number, decodedRows: number): boolean {
  return rawNonEmpty > 0 && decodedRows === 0;
}

/**
 * The decoder returned rows and the raw side found no non-empty document to
 * compare them against (#763).
 *
 * Until #778 this was the permanent state of six of the nine roots: the raw
 * side matched by root PREFIX while the decoder routed by LEAF, so every root
 * whose documents live at a nested path (`items/<id>/accounts`,
 * `users/<uid>/tags`, ...) read zero on the raw side and passed vacuously. The
 * raw side now goes through the decoder's own `routeCollection`, so the two
 * cannot disagree about which documents belong to a root, and anchoring can no
 * longer produce this shape.
 *
 * What still can, and why it now FAILs (see {@link reportDecodeLossCoverage}):
 * rows built from fieldless documents — the raw side excludes Firestore parent
 * pointers and a processor that does not is #627's phantom-row bug — or a root
 * in {@link decodedRoots} mapped to the wrong route.
 *
 * Disjoint from {@link isTotalDecodeLoss} by construction: that one needs
 * `rawNonEmpty > 0`, this one needs it to be `0`. Neither ever masks the other.
 */
export function isUnmeasuredRoot(rawNonEmpty: number, decodedRows: number): boolean {
  return rawNonEmpty === 0 && decodedRows > 0;
}

/** One row of the decode-loss comparison: a root, its raw side and its decoded side. */
export interface RootComparison {
  root: CollectionRoute;
  raw: number;
  rows: number;
}

/** Documents per decoder route, as `tallyRoutedDocument` counts them. */
export type RoutedCounts = Map<CollectionRoute, { total: number; empty: number }>;
type ReadonlyRoutedCounts = ReadonlyMap<CollectionRoute, { total: number; empty: number }>;

/**
 * Count one raw document toward the route the decoder would send it to (#778).
 *
 * Takes the RAW collection path, not the normalized pattern, because that is
 * what `decodeAllCollections` routes on: same input, same function, same
 * answer. Unrouted collections are dropped — the decoder skips them too.
 */
export function tallyRoutedDocument(
  routed: RoutedCounts,
  collection: string,
  fieldless: boolean
): void {
  const route = routeCollection(collection);
  if (route === null) return;
  let entry = routed.get(route);
  if (!entry) {
    entry = { total: 0, empty: 0 };
    routed.set(route, entry);
  }
  entry.total++;
  // Firestore parent-pointer documents carry no fields. They are structural,
  // not data, and must not be counted as decodable rows.
  if (fieldless) entry.empty++;
}

/**
 * Non-empty raw documents the decoder routed to `route`.
 *
 * Replaces the root-prefix `nonEmptyRowsUnder` (#778), which read `accounts` as
 * the top-level collection only — zero on a real cache — and `items` as every
 * document beneath every item, so one root was compared against nothing and
 * another against a hundred times its real size.
 */
export function routedNonEmpty(route: CollectionRoute, routed: ReadonlyRoutedCounts): number {
  const counts = routed.get(route);
  return counts ? counts.total - counts.empty : 0;
}

/**
 * Routes checks 1 and 2 deliberately do not compare, each with its reason.
 *
 * With {@link ROUTE_ROWS} this partitions `CollectionRoute`: the two `Record`
 * types make a route missing from both, or present in both, a compile error,
 * and a test asserts the partition over `COLLECTION_ROUTES` at runtime. So a
 * newly routed collection cannot quietly escape the comparison the way six
 * roots did before #778 — adding one forces a decision about it.
 */
export const ROUTES_NOT_COMPARED = {
  financial_goal_sentinels:
    'routed only so coverage reports count the empty parents of financial_goal_history; ' +
    'it has no processor and decodes no rows, so there is nothing to compare',
  user_accounts:
    'known and deliberately unread since #666: routed so the accounts leaf clause cannot ' +
    'claim it, but it has no processor; check 8 reports its document count instead',
} as const satisfies Partial<Record<CollectionRoute, string>>;

type ComparedRoute = Exclude<CollectionRoute, keyof typeof ROUTES_NOT_COMPARED>;

/**
 * Where each compared route's decoded rows come from in `AllCollectionsResult`.
 *
 * Every route with a processor except the ones {@link ROUTES_NOT_COMPARED}
 * names, not just the nine roots the check started with (#778 review). A route
 * left off both lists would be a collection checks 1 and 2 never look at,
 * which is the #763 gap under another name.
 */
export const ROUTE_ROWS: Record<ComparedRoute, (all: AllCollectionsResult) => number> = {
  holdings_history: (all) => all.holdingsHistory.length,
  holdings_history_meta: (all) => all.holdingsHistoryMeta.length,
  balance_history: (all) => all.balanceHistory.length,
  plaid_accounts: (all) => all.plaidAccounts.length,
  transactions: (all) => all.transactions.length,
  accounts: (all) => all.accounts.length,
  recurring: (all) => all.recurring.length,
  budgets: (all) => all.budgets.length,
  financial_goals: (all) => all.goals.length,
  financial_goal_history: (all) => all.goalHistory.length,
  investment_prices: (all) => all.investmentPrices.length,
  investment_splits: (all) => all.investmentSplits.length,
  items: (all) => all.items.length,
  tags: (all) => all.tags.length,
  categories: (all) => all.categories.length,
  transaction_changes: (all) => all.transactionChanges.length,
  account_changes: (all) => all.accountChanges.length,
  changes: (all) => all.changes.length,
  securities: (all) => all.securities.length,
  users: (all) => all.userProfiles.length,
  amazon_orders: (all) => all.amazonOrders.length,
  amazon: (all) => all.amazonIntegrations.length,
  subscriptions: (all) => all.subscriptions.length,
  invites: (all) => all.invites.length,
  user_items: (all) => all.userItems.length,
  feature_tracking: (all) => all.featureTracking.length,
  support: (all) => all.supportDocs.length,
};

/**
 * The roots checks 1 and 2 compare, each named by the route its rows come from,
 * in the decoder's routing order.
 */
export function decodedRoots(
  all: AllCollectionsResult
): Array<{ root: CollectionRoute; rows: number }> {
  return COLLECTION_ROUTES.filter((r): r is ComparedRoute => r in ROUTE_ROWS).map((root) => ({
    root,
    rows: ROUTE_ROWS[root](all),
  }));
}

/** Pair each decoded root with its routed raw count. */
export function compareRoots(
  decoded: ReadonlyArray<{ root: CollectionRoute; rows: number }>,
  routed: ReadonlyRoutedCounts
): RootComparison[] {
  return decoded.map((d) => ({ ...d, raw: routedNonEmpty(d.root, routed) }));
}

/**
 * Check 1b's whole verdict — status, wording, and the coverage count that
 * checks 1 and 2 quote in their own PASS lines (#763).
 *
 * A function rather than an `if` in `main()` so the verdict can be asserted
 * from a test. `main()` needs a real Copilot cache and never runs under
 * `bun test`, so a branch left in there is executed on exactly the machines
 * that have one and on no CI run at all — and a status branch nothing can
 * assert is the shape `docs/bugs/596-vacuous-assertions-bulk-edit.md` is about.
 *
 * FAIL, not the WARN it was under #763. That WARN fired on every real cache
 * because the raw side was root-anchored — a coverage gap no cache could clear,
 * and so furniture. With the raw side routed through the decoder (#778), a root
 * that decodes rows with no non-empty document behind it is a defect in this
 * repo: a processor building rows from fieldless documents (#627), or a root in
 * {@link decodedRoots} mapped to the wrong route. Either way it is red.
 *
 * `comparedSummary` states how many roots the raw side saw documents for at
 * all (`raw > 0`) — deliberately not "how many this check compared", because
 * conservation narrows further by a `raw > 10` floor. The numerator is
 * `raw > 0` and NOT "roots that are not unmeasured", which would count a
 * `raw === 0 && rows === 0` root: consistent, but the raw side saw nothing.
 *
 * SKIP for an empty list, matching {@link reportExtinctDependencies}.
 */
export function reportDecodeLossCoverage(roots: readonly RootComparison[]): {
  status: Status;
  detail: string;
  comparedSummary: string;
} {
  const measured = roots.filter((d) => d.raw > 0).length;
  const counts = {
    comparedSummary: `${measured}/${roots.length} roots had raw documents at all`,
  };
  if (roots.length === 0) {
    return {
      ...counts,
      status: 'SKIP',
      detail: 'no roots were compared at all, so there is no coverage to report',
    };
  }
  const unmeasured = roots.filter((d) => isUnmeasuredRoot(d.raw, d.rows));
  if (unmeasured.length === 0) {
    return {
      ...counts,
      status: 'PASS',
      detail: `all ${roots.length} roots decoded rows only where raw documents backed them`,
    };
  }
  return {
    ...counts,
    status: 'FAIL',
    detail:
      `${unmeasured.length}/${roots.length} roots decoded rows with no non-empty document ` +
      `routed to them: ` +
      unmeasured.map((d) => `${d.root} (0 raw → ${d.rows} rows)`).join(', ') +
      ` — the raw side counts through the decoder's own routeCollection, so these rows ` +
      `came from fieldless parent pointers (the #627 phantom-row class, which #797 ` +
      `guarded in every processor, so a hit here is a processor that lost its ` +
      `guard) or the root is mapped to the wrong route in decodedRoots`,
  };
}

/**
 * Check 1's verdict (#778): the #622 signature, documents on disk and zero rows.
 *
 * Extracted from `main()` for the reason {@link reportDecodeLossCoverage} gives.
 * The PASS quotes `comparedSummary` because a decode-loss pass is only as good
 * as the number of roots the raw side could see.
 */
export function reportTotalDecodeLoss(
  roots: readonly RootComparison[],
  comparedSummary: string
): { status: Status; detail: string } {
  const blackHoles = roots.filter((d) => isTotalDecodeLoss(d.raw, d.rows));
  if (blackHoles.length > 0) {
    return {
      status: 'FAIL',
      detail:
        `collections with documents on disk but ZERO decoded rows: ` +
        blackHoles.map((d) => `${d.root} (${d.raw} docs)`).join(', '),
    };
  }
  return {
    status: 'PASS',
    detail:
      `every collection with documents decoded at least one row ` +
      `(${comparedSummary} — see the coverage check below)`,
  };
}

/**
 * Check 2's verdict (#778): large unexplained shrinkage between disk and output.
 *
 * The filter narrows three ways, and the PASS sentence names all three — the
 * invariant that took four review rounds on #777 to get right while it lived
 * in `main()`, where only a sentence-against-predicate read could check it:
 *
 * - `raw > 10` — a noise floor; "10 or fewer documents" in the PASS.
 * - `rows > 0` — a total loss is check 1's, so one root is one finding.
 * - `rows / raw < 0.5` — "more than half".
 *
 * WARN, not FAIL: some loss is legitimate (dedup, tombstones, soft-deletes).
 */
export function reportConservation(
  roots: readonly RootComparison[],
  comparedSummary: string
): { status: Status; detail: string } {
  const lossy = roots.filter((d) => d.raw > 10 && d.rows > 0 && d.rows / d.raw < 0.5);
  if (lossy.length > 0) {
    return {
      status: 'WARN',
      detail:
        `collections losing >50% of documents: ` +
        lossy.map((d) => `${d.root} ${d.raw}→${d.rows}`).join(', ') +
        ` (legitimate for soft-deletes/dedup — confirm each)`,
    };
  }
  return {
    status: 'PASS',
    detail:
      `no collection loses more than half its documents ` +
      `(${comparedSummary}; roots with 10 or fewer documents are below this ` +
      `check's floor, and total losses are the total-decode-loss check's — see the ` +
      `coverage check above)`,
  };
}

/**
 * Which of the collections a caller depends on have no real documents.
 *
 * "Real" excludes Firestore's fieldless parent pointers, which exist for any
 * path with subcollections and say nothing about whether the collection itself
 * holds data — counting them would make an extinct collection look alive.
 *
 * Extracted and tested separately because `DEPENDED_ON` is currently empty
 * (#624 removed its only entry), so the check cannot exercise itself against
 * the real cache. Without this the gate would be documentation-only until
 * someone adds a new entry, and a bug in it would surface only then.
 */
export function findExtinctDependencies(
  dependedOn: readonly string[],
  raw: ReadonlyMap<string, { total: number; empty: number }>
): string[] {
  return dependedOn.filter((pattern) => {
    const counts = raw.get(pattern);
    return !counts || counts.total - counts.empty === 0;
  });
}

/**
 * Check 3's verdict, and the one other place in this file that reported a pass
 * over an empty comparison (#763).
 *
 * `DEPENDED_ON` has been empty since #624 removed its only entry, so
 * `findExtinctDependencies` returns `[]` and the check printed
 * "every depended-on collection has documents" — true of nothing, and
 * indistinguishable from the same line over a populated list. Same defect as
 * check 1's vacuous PASS, so it gets the same treatment rather than being left
 * as the instance the fix did not reach.
 *
 * SKIP, not WARN: an empty maintenance list is the documented state of this
 * check, not a surprise about the cache — and the summary counts skips
 * precisely so a dormant check does not read as one fewer pass.
 */
export function reportExtinctDependencies(
  dependedOn: readonly string[],
  raw: ReadonlyMap<string, { total: number; empty: number }>
): { status: Status; detail: string } {
  if (dependedOn.length === 0) {
    return {
      status: 'SKIP',
      detail:
        'nothing is registered as depended-on, so this check compared nothing — see the ' +
        'MAINTENANCE CONTRACT at its call site before reading the absence as health',
    };
  }
  const extinct = findExtinctDependencies(dependedOn, raw);
  if (extinct.length > 0) {
    return {
      status: 'FAIL',
      detail:
        `code reads collections with zero documents: ${extinct.join(', ')} — ` +
        `any filter built on them is a silent no-op (see #624)`,
    };
  }
  return {
    status: 'PASS',
    detail: `all ${dependedOn.length} depended-on collection(s) have documents`,
  };
}

/**
 * Is this raw collection path the ACCOUNT-document collection?
 *
 * `users/<uid>/accounts` also ends in `/accounts` and is a different collection
 * with a different field vocabulary (`hidden`, not `user_hidden`) — the
 * ambiguity `docs/firestore-collections.md` warns about.
 *
 * Delegates to the decoder's `routeCollection` (#778). It used to restate the
 * rule (`includes('users/')` plus a leaf match) beside a second, root-prefix
 * definition of "accounts" in checks 1 and 2; two spellings of one routing
 * decision is the drift #778 fixed, so there is now one, and check 7's row set
 * is by construction the one `processAccount` sees.
 */
export function isAccountDocumentCollection(collection: string): boolean {
  return routeCollection(collection) === 'accounts';
}

/**
 * Check 8's verdict for one known-but-unread collection (#666), extracted from
 * `main()` (#778) for the reason {@link reportDecodeLossCoverage} gives.
 */
export function reportUnreadCollection(
  pattern: string,
  rows: number
): { status: Status; detail: string } {
  if (rows === 0) {
    return {
      status: 'PASS',
      detail: `zero documents on this cache — consistent with the decoder's deletion (#666)`,
    };
  }
  return {
    status: 'WARN',
    detail:
      `${rows} document(s) — NOT extinct on this cache (${pattern}), and the decoder skips ` +
      `them unread since #666. Open an issue with this cache as the counter-example and ` +
      `decide whether the data needs a reader again`,
  };
}

/**
 * One account document reduced to the two facts check 7 needs (#666).
 *
 * `invisible` is the cache-document visibility rule (`isVisibleAccount`
 * inverted) read straight off the raw fields, deliberately NOT by importing
 * the predicate: the check exists to test whether a THIRD flag belongs in that
 * rule, so it must not inherit the rule's current definition.
 */
export interface AccountVisibilityRow {
  dashboardActive?: boolean;
  invisible: boolean;
}

export function readAccountVisibilityRow(
  fields: Map<string, FirestoreValue>
): AccountVisibilityRow {
  const bool = (key: string): boolean | undefined => {
    const value = fields.get(key);
    return value?.type === 'boolean' ? value.value : undefined;
  };
  return {
    dashboardActive: bool('dashboard_active'),
    invisible: bool('user_hidden') === true || bool('user_deleted') === true,
  };
}

/**
 * Does this cache still show `dashboard_active` to be independent of
 * visibility? (#666)
 *
 * #624 filed `dashboard_active` as the third of three account customizations
 * Copilot migrated onto the account document, next to `nickname` and
 * `user_hidden`, and #666 proposed adding it to the default `get_accounts`
 * filter on that reading. A 2026-09-16 measurement said otherwise: every
 * account with `dashboard_active: false` was an investment account, most of
 * them carried no `user_hidden` at all, and a live `Accounts` round-trip
 * reported those same accounts as neither hidden nor closed. So the flag is
 * decoded and deliberately NOT filtered on.
 *
 * That decision rests on a property of real data, which is the kind of claim
 * that goes quietly false. This is the re-check:
 *
 * - `independent`        — at least one `dashboard_active: false` account is
 *                          visible. The evidence still holds.
 * - `indistinguishable`  — there are `false` accounts and EVERY one of them is
 *                          hidden or deleted. On this cache the flag cannot be
 *                          told apart from "invisible", which is what #666
 *                          assumed; worth re-deciding, not an error.
 * - `no-negatives`       — the field is present but nothing is `false`, so
 *                          there is nothing to distinguish. Reported rather
 *                          than folded into `indistinguishable`, where it
 *                          would pass vacuously (#596).
 * - `absent`             — account documents exist and none carries the field.
 *                          Copilot may have retired it.
 * - `no-account-documents`
 *                        — nothing was measured at all. Split out from
 *                          `absent` because they support opposite conclusions
 *                          ("the field is gone" vs "the check stopped seeing
 *                          accounts", e.g. a collection path that moved), and
 *                          because a detector that quietly stops measuring is
 *                          the vacuity of `no-negatives` one level up: the
 *                          empty-`negatives` set is guarded, so guard the
 *                          empty-`rows` set too.
 */
export type DashboardActiveEvidence =
  'independent' | 'indistinguishable' | 'no-negatives' | 'absent' | 'no-account-documents';

/**
 * The three counts the verdict turns on, and the only numbers the check logs.
 *
 * Separate from {@link classifyDashboardActive} so the reported counts and the
 * reported verdict cannot disagree: computing them twice is how a detail line
 * ends up describing a state the classifier did not reach.
 */
export interface DashboardActiveCounts {
  accounts: number;
  carrying: number;
  negatives: number;
  visibleNegatives: number;
}

export function countDashboardActive(rows: readonly AccountVisibilityRow[]): DashboardActiveCounts {
  const carrying = rows.filter((row) => row.dashboardActive !== undefined);
  const negatives = carrying.filter((row) => row.dashboardActive === false);
  return {
    accounts: rows.length,
    carrying: carrying.length,
    negatives: negatives.length,
    visibleNegatives: negatives.filter((row) => !row.invisible).length,
  };
}

export function classifyDashboardActive(
  rows: readonly AccountVisibilityRow[]
): DashboardActiveEvidence {
  const { accounts, carrying, negatives, visibleNegatives } = countDashboardActive(rows);
  if (accounts === 0) return 'no-account-documents';
  if (carrying === 0) return 'absent';
  if (negatives === 0) return 'no-negatives';
  return visibleNegatives > 0 ? 'independent' : 'indistinguishable';
}

/**
 * How many references resolve against a target id set.
 *
 * Returns counts as well as the rate so callers never have to divide and
 * re-multiply to recover the orphan count — that roundtrip leans on rounding to
 * absorb float error, which is a poor foundation for a number the gate reports.
 *
 * An empty reference list is vacuously fine (rate 1) regardless of the target;
 * the runner reports SKIP for it rather than a suspicious 100%.
 */
export function joinStats(
  refs: readonly string[],
  target: ReadonlySet<string>
): { total: number; matched: number; orphans: number; rate: number } {
  const total = refs.length;
  const matched = refs.filter((id) => target.has(id)).length;
  return { total, matched, orphans: total - matched, rate: total === 0 ? 1 : matched / total };
}

/**
 * Dotted paths of every non-finite numeric leaf in a raw document (#659).
 *
 * Firestore stores IEEE-754 doubles, so `NaN` / `±Infinity` are legal on the
 * wire; Zod cannot represent any of them. The decoder now strips such leaves
 * and keeps the document, but only the real cache can answer whether the class
 * occurs at all — and where.
 *
 * PII: map keys are user data in several collections (dates, ids, epoch-ms
 * timestamps), and these paths get logged. Only keys shaped like a declared
 * Firestore field name survive; everything else collapses to `<key>`, and
 * array indices to `<n>`, which also makes paths group across documents.
 */
export function nonFiniteLeafPaths(fields: Map<string, FirestoreValue>): string[] {
  const found: string[] = [];

  function walk(value: FirestoreValue, path: string): void {
    if (value.type === 'double' || value.type === 'integer') {
      if (!Number.isFinite(value.value)) found.push(path);
      return;
    }
    if (value.type === 'map') {
      for (const [key, child] of value.value) walk(child, `${path}.${safeKey(key)}`);
      return;
    }
    if (value.type === 'array') {
      for (const child of value.value) walk(child, `${path}.<n>`);
    }
  }

  for (const [key, value] of fields) walk(value, safeKey(key));
  return found;
}

/**
 * Check 9's raw side (#824): does this RAW transaction document carry a
 * category on a row Copilot treats as uncategorizable — `type` income or
 * internal_transfer, or the `internal_transfer` boolean set — on a document
 * the decoder turns into a row? Reads the disk, not decoder output, because
 * the decoder is what clears the field: a check on decoded rows alone could
 * never fail. Strings are read with the decoder's own reader, so a value
 * stored as a Firestore reference counts here exactly as it does there.
 */
export function hasCategoryOnIncomeOrTransfer(fields: Map<string, FirestoreValue>): boolean {
  // A document the decoder drops (soft-deleted, zero amount, no date) would
  // only ever count as "not compared" and hold the check at WARN. Asked of the
  // decoder's own predicate, so this cannot drift from what it drops. Two
  // later drops are not covered and stay WARN-shaped: a row that fails schema
  // validation, and a pending row superseded by its posted twin.
  if (!isDecodableTransactionDocument(fields)) return false;
  const typeName = getString(fields, 'type')?.toLowerCase() ?? '';
  const flag = fields.get('internal_transfer');
  const isTransferFlag = flag?.type === 'boolean' && flag.value === true;
  if (typeName !== 'income' && typeName !== 'internal_transfer' && !isTransferFlag) return false;
  return (getString(fields, 'category_id') ?? '') !== '';
}

/**
 * Check 9's verdict (#824): every raw income/transfer document that carries a
 * category must decode to a row with no category. `decoded` maps transaction
 * id → decoded category_id for the rows the decoder produced.
 */
export function reportIncomeTransferCategory(
  staleIds: readonly string[],
  decoded: ReadonlyMap<string, string | undefined>
): { status: Status; detail: string } {
  if (staleIds.length === 0) {
    return {
      status: 'SKIP',
      detail:
        'no income/transfer document carries a category on this cache, so the decoder rule ' +
        'has nothing to clear and this check measures nothing',
    };
  }
  const missing = staleIds.filter((id) => !decoded.has(id));
  const leaked = staleIds.filter((id) => decoded.has(id) && (decoded.get(id) ?? '') !== '');
  const compared = staleIds.length - missing.length;
  if (leaked.length > 0) {
    return {
      status: 'FAIL',
      detail:
        `${leaked.length} of ${compared} income/transfer document(s) with a category on disk ` +
        `still decode with that category — cache mode attributes a category the app does not`,
    };
  }
  if (compared === 0) {
    return {
      status: 'WARN',
      detail:
        `${staleIds.length} income/transfer document(s) carry a category on disk, but none ` +
        `of them decoded to a row, so nothing was compared`,
    };
  }
  return {
    status: 'PASS',
    detail:
      `${compared} income/transfer document(s) carry a category on disk; all decode with none` +
      (missing.length > 0 ? ` (${missing.length} not decoded, not compared)` : ''),
  };
}

/**
 * Field names in this cache are lowercase snake_case. Anything else — an epoch
 * timestamp, a `YYYY-MM-DD`, a Firestore id — is a dynamic key and is redacted.
 *
 * The 40-char ceiling is a backstop, not a spec: the longest declared field
 * name in the decoder is well under it, while Firestore ids are 20+ chars of
 * mixed case, so a key that is both long and lowercase is far more likely to
 * be user data than a field nobody has seen. Raise it only alongside a real
 * field name that needs the room.
 */
function safeKey(key: string): string {
  return /^[a-z][a-z0-9_]{0,39}$/.test(key) ? key : '<key>';
}

const normalize = normalizeCollection;

async function main(): Promise<void> {
  const db = new CopilotDatabase();
  const { available, lookupError } = db.availability();
  const dbPath = db.getDbPath();

  // "Could not look" is not "nothing there" (#774): a cache this smoke failed
  // to read must not report a green "nothing to check".
  if (lookupError) {
    console.error(`[cache-smoke] cache-unreadable — ${missingDatabaseError(lookupError).message}`);
    process.exit(1);
  }
  if (!dbPath || !available) {
    console.error('[cache-smoke] no-cache-found — no local Copilot cache; nothing to check.');
    console.error(
      '[cache-smoke] This is not a failure. Run on a machine with Copilot Money synced.'
    );
    process.exit(0);
  }

  console.error(`[cache-smoke] scanning real cache`);

  // ---------------------------------------------------------------------
  // Raw scan: what is actually on disk, by normalized collection path and by
  // the decoder route each document takes.
  // ---------------------------------------------------------------------
  const raw = new Map<string, { total: number; empty: number }>();
  // Per decoder route, counted through `routeCollection` on the RAW path — the
  // same function on the same input as `decodeAllCollections`, so checks 1, 2,
  // 7 and 8 compare against exactly the documents the decoder routed (#778).
  const routed: RoutedCounts = new Map();
  // `${collection}:${path}` → how many documents carry a non-finite value there.
  const nonFinite = new Map<string, number>();
  // Account documents reduced to two booleans for check 7. PII-safe by
  // construction: nothing but flags is kept, and only counts are reported.
  const accountRows: AccountVisibilityRow[] = [];
  // Ids only, for check 9 — no values are kept.
  // A Set: the decoder dedupes same-id documents, so the counts must too.
  const incomeTransferWithCategory = new Set<string>();
  let scanned = 0;
  const started = Date.now();

  for await (const doc of iterateDocuments(dbPath)) {
    scanned++;
    const pattern = normalize(doc.collection);
    let entry = raw.get(pattern);
    if (!entry) {
      entry = { total: 0, empty: 0 };
      raw.set(pattern, entry);
    }
    entry.total++;
    // Firestore parent-pointer documents carry no fields. They are structural,
    // not data, and must not be counted as decodable rows.
    if (doc.fields.size === 0) entry.empty++;
    tallyRoutedDocument(routed, doc.collection, doc.fields.size === 0);

    for (const leafPath of nonFiniteLeafPaths(doc.fields)) {
      const key = `${pattern}:${leafPath}`;
      nonFinite.set(key, (nonFinite.get(key) ?? 0) + 1);
    }

    if (doc.fields.size > 0 && isAccountDocumentCollection(doc.collection)) {
      accountRows.push(readAccountVisibilityRow(doc.fields));
    }
    if (
      routeCollection(doc.collection) === 'transactions' &&
      hasCategoryOnIncomeOrTransfer(doc.fields)
    ) {
      // The decoder's identity, not the document id: the two can differ.
      incomeTransferWithCategory.add(transactionDocumentId(doc.fields, doc.documentId));
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  record(
    'raw scan',
    'PASS',
    `${scanned} documents across ${raw.size} collection patterns in ${elapsed}s`
  );

  const all = await decodeAllCollections(dbPath);

  // ---------------------------------------------------------------------
  // Check 1 — total decode loss.
  //
  // The #622 signature: a collection has real documents on disk and the
  // decoder produces zero rows. Nothing else in the suite notices, because a
  // fixture-backed test only proves the decoder agrees with its author.
  // ---------------------------------------------------------------------
  const withRaw = compareRoots(decodedRoots(all), routed);
  // Computed before check 1 reports, because check 1's own PASS quotes how many
  // roots it compared and that count belongs to one tested function (#763).
  const coverage = reportDecodeLossCoverage(withRaw);
  const totalLoss = reportTotalDecodeLoss(withRaw, coverage.comparedSummary);
  record('total decode loss', totalLoss.status, totalLoss.detail);

  // ---------------------------------------------------------------------
  // Check 1b — decode-loss coverage (#763, #778).
  //
  // Rows with no non-empty document behind them. Under #763 this WARNed on
  // every real cache, because the raw side was root-anchored and six roots read
  // zero. #778 routes the raw side through the decoder, so on a healthy cache
  // this PASSes and a hit is a phantom-row or root-mapping defect — see
  // `reportDecodeLossCoverage`. Reported as its own line rather than folded
  // into check 1's detail: a caveat inside another check's PASS is read as part
  // of the pass.
  // ---------------------------------------------------------------------
  record('decode-loss coverage', coverage.status, coverage.detail);

  // ---------------------------------------------------------------------
  // Check 2 — conservation.
  //
  // Large unexplained shrinkage between disk and output. Some loss is
  // legitimate (dedup, tombstones, soft-deletes), so this warns rather than
  // fails; #622 discarded 91% of investment_prices and would have shown here
  // long before anyone read the output. The three narrowings of its filter, and
  // the sentence that must name them, live in `reportConservation`.
  // ---------------------------------------------------------------------
  const conservation = reportConservation(withRaw, coverage.comparedSummary);
  record('conservation', conservation.status, conservation.detail);

  // ---------------------------------------------------------------------
  // Check 3 — extinct dependencies.
  //
  // The #624 signature, and the inverse of check 1: the code reads a
  // collection that no longer has any documents, so a filter built on it is
  // silently a no-op. Both decode paths agree there is nothing there, so
  // parity testing cannot see it.
  // ---------------------------------------------------------------------
  // MAINTENANCE CONTRACT: add a normalized path here whenever code starts
  // depending on a collection existing. This list is what makes an extinct
  // collection loud instead of silent, and nothing derives it automatically —
  // a new decoder that reads a collection Copilot has since retired will pass
  // every other check in this file. The mirror gap (fields a processor
  // declares that no real document has) is a separate follow-up.
  //
  // `users/*/accounts` was the founding entry and has been removed: #624
  // resolved by moving the two things that read it — the hidden-account filter
  // and the account name map — onto the account documents, where Copilot now
  // puts those customizations. Its decoder was then deleted (#666); the path
  // is still named in the decoder so its documents are skipped rather than
  // misrouted. It is not unwatched: check 8 below reports its document count.
  const DEPENDED_ON: string[] = [];
  const dependencies = reportExtinctDependencies(DEPENDED_ON, raw);
  record('extinct dependencies', dependencies.status, dependencies.detail);

  // ---------------------------------------------------------------------
  // Check 4 — identity joins.
  //
  // Foreign keys must actually resolve. #622's rows carried a month where a
  // security id belonged: a 0% join rate, invisible to every schema check
  // because a month is a perfectly valid string.
  // ---------------------------------------------------------------------
  const securityIds = new Set(all.securities.map((s) => s.security_id));
  const accountIds = new Set(all.accounts.map((a) => a.account_id));
  const goalIds = new Set(all.goals.map((g) => g.goal_id));

  const joins: Array<{ name: string; refs: string[]; target: Set<string> }> = [
    {
      name: 'investment_prices.security_id → securities',
      refs: all.investmentPrices.map((p) => p.security_id),
      target: securityIds,
    },
    {
      name: 'transactions.account_id → accounts',
      refs: all.transactions.map((t) => t.account_id).filter((v): v is string => !!v),
      target: accountIds,
    },
    {
      name: 'financial_goal_history.goal_id → financial_goals',
      refs: all.goalHistory.map((h) => h.goal_id),
      target: goalIds,
    },
  ];

  for (const join of joins) {
    if (join.refs.length === 0) {
      record(`join: ${join.name}`, 'SKIP', 'no rows to check');
      continue;
    }
    if (join.target.size === 0) {
      record(`join: ${join.name}`, 'SKIP', 'target collection empty');
      continue;
    }
    const { total, orphans, rate } = joinStats(join.refs, join.target);
    const pct = rate * 100;
    if (orphans > 0) {
      record(
        `join: ${join.name}`,
        pct < 50 ? 'FAIL' : 'WARN',
        `${orphans}/${total} references do not resolve (${pct.toFixed(1)}% join rate)`
      );
    } else {
      record(`join: ${join.name}`, 'PASS', `all ${total} references resolve`);
    }
  }

  // ---------------------------------------------------------------------
  // Check 5 — decode-path parity on real data.
  //
  // The unit-test version of this runs on fixtures. This is the real-data
  // edition: #622 was a 0-vs-863 disagreement that only appeared against a
  // real cache, because the fixtures did not have the nesting that broke it.
  // ---------------------------------------------------------------------
  const parity: Array<{ name: string; standalone: () => Promise<unknown[]>; aggregate: number }> = [
    {
      name: 'transactions',
      standalone: () => decodeTransactions(dbPath),
      aggregate: all.transactions.length,
    },
    { name: 'accounts', standalone: () => decodeAccounts(dbPath), aggregate: all.accounts.length },
    {
      name: 'recurring',
      standalone: () => decodeRecurring(dbPath),
      aggregate: all.recurring.length,
    },
    { name: 'budgets', standalone: () => decodeBudgets(dbPath), aggregate: all.budgets.length },
    { name: 'financial_goals', standalone: () => decodeGoals(dbPath), aggregate: all.goals.length },
    {
      name: 'goal_history',
      standalone: () => decodeGoalHistory(dbPath),
      aggregate: all.goalHistory.length,
    },
    {
      name: 'investment_prices',
      standalone: () => decodeInvestmentPrices(dbPath),
      aggregate: all.investmentPrices.length,
    },
    { name: 'items', standalone: () => decodeItems(dbPath), aggregate: all.items.length },
    {
      name: 'categories',
      standalone: () => decodeCategories(dbPath),
      aggregate: all.categories.length,
    },
  ];

  const mismatches: string[] = [];
  for (const p of parity) {
    // Sequential: concurrent iterations over the same temp copy collide.
    const rows = await p.standalone();
    if (rows.length !== p.aggregate) {
      mismatches.push(`${p.name} standalone=${rows.length} aggregate=${p.aggregate}`);
    }
  }

  if (mismatches.length > 0) {
    record(
      'decode-path parity',
      'FAIL',
      `paths disagree on real data: ${mismatches.join('; ')} — ` +
        `which one runs depends on load order`
    );
  } else {
    record(
      'decode-path parity',
      'PASS',
      `all ${parity.length} collections agree across both paths`
    );
  }

  // ---------------------------------------------------------------------
  // Check 6 — non-finite numeric leaves (#659).
  //
  // A `NaN` / `±Infinity` double is legal in Firestore and illegal in Zod, and
  // before the repair in `validateOrWarn` one of them discarded the whole
  // document. The repair means these no longer cost data, so this WARNS: it
  // exists to say the class is live in reality and where, which is the part no
  // synthetic fixture can establish.
  // ---------------------------------------------------------------------
  if (nonFinite.size > 0) {
    const docs = [...nonFinite.values()].reduce((a, b) => a + b, 0);
    const repaired = Object.values(all.decodeStats).reduce((a, s) => a + s.repaired, 0);
    record(
      'non-finite values',
      'WARN',
      `${docs} document(s) carry a NaN/±Infinity number at: ` +
        [...nonFinite].map(([k, n]) => `${k} (${n})`).join(', ') +
        ` — decoder repaired ${repaired} document(s), field dropped, document kept`
    );
  } else {
    record('non-finite values', 'PASS', 'no NaN/±Infinity numbers anywhere in the cache');
  }

  // ---------------------------------------------------------------------
  // Check 7 — `dashboard_active` is not a visibility flag (#666).
  //
  // #624 recorded three account customizations Copilot migrated onto the
  // account document. Two of them had a consumer to restore (`user_hidden`
  // in #624, `nickname` in #660); the third was assumed to be one and never
  // was. Measurement, not symmetry, settled it — and measurement is the kind
  // of evidence that expires, so this re-runs it. See
  // `classifyDashboardActive` for the outcomes and what each means — the
  // count is deliberately not written here, since a tally in a comment goes
  // silently false the next time one is added (it already did once).
  // ---------------------------------------------------------------------
  const tally = countDashboardActive(accountRows);
  const counts =
    `${tally.accounts} account document(s), ${tally.carrying} carrying the field, ` +
    `${tally.negatives} false, ${tally.visibleNegatives} of those visible`;

  switch (classifyDashboardActive(accountRows)) {
    case 'independent':
      record(
        'dashboard_active is not visibility',
        'PASS',
        `${counts} — a false flag on a visible account, so the flag is still independent ` +
          `of user_hidden/user_deleted and stays out of isVisibleAccount`
      );
      break;
    case 'indistinguishable':
      record(
        'dashboard_active is not visibility',
        'WARN',
        `${counts} — every false flag is on a hidden/deleted account, so this cache cannot ` +
          `tell the flag apart from invisibility (the #666 reading). Re-probe before ` +
          `trusting the note on Account.dashboard_active`
      );
      break;
    case 'no-negatives':
      record(
        'dashboard_active is not visibility',
        'SKIP',
        `${counts} — nothing is false, so this cache distinguishes nothing either way`
      );
      break;
    case 'absent':
      record(
        'dashboard_active is not visibility',
        'SKIP',
        `${counts} — no account document carries the field; Copilot may have retired it`
      );
      break;
    case 'no-account-documents':
      record(
        'dashboard_active is not visibility',
        'WARN',
        `${counts} — no account documents were collected at all, so the check is ` +
          `measuring nothing. ` +
          `Zero accounts on a real cache is itself surprising, so suspect a moved ` +
          `collection path over an empty cache, and check the decoder's routeCollection ` +
          `still sends account documents to 'accounts'`
      );
      break;
  }

  // ---------------------------------------------------------------------
  // Check 8 — known-but-unread collection: users/<uid>/accounts (#624, #666).
  //
  // The inverse of check 3, and deliberately not part of it: check 3 fails
  // when code DEPENDS on an empty collection. Nothing depends on this one —
  // #624 moved the hidden filter and #660 moved the name map onto the account
  // documents — and #666 deleted its decoder, model and fixtures. The decoder
  // still NAMES the path (`isUserAccountCustomizationCollection`, the first
  // clause of `routeCollection`, route `user_accounts`) so that its documents
  // are skipped rather than routed as accounts.
  //
  // One cache cannot prove a collection extinct (#622's sampling-bias trap,
  // which #624 attached to exactly this deletion). The deletion was taken on
  // the grounds that nothing read the code, not on proof of extinction, so this
  // check keeps watching: a cache where the collection is populated again
  // turns WARN, and that is the cue to decide whether the data needs a reader.
  // ---------------------------------------------------------------------
  // Counted by decoder route (#778), not by root prefix, so it counts exactly
  // the documents the decoder recognises as this collection and skips.
  const UNREAD_COLLECTIONS = [{ pattern: 'users/*/accounts', route: 'user_accounts' }] as const;
  for (const { pattern, route } of UNREAD_COLLECTIONS) {
    const unread = reportUnreadCollection(pattern, routedNonEmpty(route, routed));
    record(`unread collection: ${pattern}`, unread.status, unread.detail);
  }

  // ---------------------------------------------------------------------
  // Check 9 — income and transfer rows decode with no category (#824).
  //
  // Copilot clears the category of an income or transfer row; a document can
  // still carry the old one. The raw side is read from disk during the scan,
  // so this fails if the decoder ever stops clearing it. SKIP on a cache with
  // no such document — the app's own rows already carry an empty category, so
  // a cache with none is the common case, not a fault.
  // ---------------------------------------------------------------------
  const decodedCategory = new Map(all.transactions.map((t) => [t.transaction_id, t.category_id]));
  const incomeTransfer = reportIncomeTransferCategory(
    [...incomeTransferWithCategory],
    decodedCategory
  );
  record('income/transfer rows have no category', incomeTransfer.status, incomeTransfer.detail);

  // ---------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------
  const failed = results.filter((r) => r.status === 'FAIL');
  const warned = results.filter((r) => r.status === 'WARN');
  // Skips are in the tally on purpose: a check that has stopped measuring
  // anything shows up as one fewer pass and nothing else, which reads exactly
  // like a check that was never there.
  const skipped = results.filter((r) => r.status === 'SKIP');

  console.error('');
  console.error(
    `[cache-smoke] ${results.filter((r) => r.status === 'PASS').length} pass, ` +
      `${warned.length} warn, ${skipped.length} skip, ${failed.length} fail`
  );

  if (failed.length > 0) {
    console.error('[cache-smoke] FAILURES:');
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

// Only run when invoked directly. Without this guard, importing the module to
// unit-test its predicates kicks off a full scan of the real cache — which is
// both slow and a surprising side effect inside `bun test`.
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error('[cache-smoke] crashed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
