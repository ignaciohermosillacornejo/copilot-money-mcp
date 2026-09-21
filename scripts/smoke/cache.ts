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
} from '../../src/core/decoder.js';
import { CopilotDatabase } from '../../src/core/database.js';
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
 * The decoder returned rows and the raw side found nothing to compare them
 * against, so checks 1 and 2 never measured this root at all (#763).
 *
 * Both checks read the raw side through {@link nonEmptyRowsUnder}, which is
 * ROOT-anchored: a pattern counts only if it IS the root or sits directly under
 * it. The decoder is LEAF-anchored — `collectionMatches` in
 * `src/core/decoder.ts` accepts `collection === target || endsWith('/'+target)`
 * — so for every collection whose real path is nested, the two never meet. On
 * the cache measured 2026-09-20 that is most of them: account documents live at
 * `items/<id>/accounts`, transactions at `items/<id>/accounts/<id>/transactions`,
 * and budgets, categories, financial_goals and tags all under `users/<uid>/...`.
 * Six of the nine roots came back `raw === 0` with a non-zero decoded count.
 *
 * `isTotalDecodeLoss(0, 21)` is `false`, so check 1 reported PASS for each of
 * them — the same PASS it would report if the decoder were wrong in every way
 * the check exists to catch. That is the #596 vacuity one level up from the
 * classifier already guarding against it, so it gets a name and a status of its
 * own instead of hiding inside another check's pass.
 *
 * WARN, not FAIL, matching this file's convention (check 2, and check 7's
 * `no-account-documents`): rows with no raw counterpart is the HEALTHY
 * direction — the decoder is reading real documents, and it is the check's
 * anchoring that is wrong. Failing would redden `smoke:cache` on every real
 * cache over a coverage gap no cache can clear, which is how a gate gets muted.
 *
 * Disjoint from {@link isTotalDecodeLoss} by construction: that one needs
 * `rawNonEmpty > 0`, this one needs it to be `0`. Neither ever masks the other.
 */
export function isUnmeasuredRoot(rawNonEmpty: number, decodedRows: number): boolean {
  return rawNonEmpty === 0 && decodedRows > 0;
}

/** One row of the decode-loss comparison: a root, its raw side and its decoded side. */
export interface RootComparison {
  root: string;
  raw: number;
  rows: number;
}

/**
 * Check 1b's whole verdict — status, wording, and the coverage count that
 * checks 1 and 2 quote in their own PASS lines (#763).
 *
 * A function rather than an `if` in `main()` so the WARN can be asserted from a
 * test. `main()` needs a real Copilot cache and never runs under `bun test`, so
 * a branch left in there is executed on exactly the machines that have one and
 * on no CI run at all — and a status branch nothing can assert is the shape
 * `docs/bugs/596-vacuous-assertions-bulk-edit.md` is about. Returning the
 * detail string too, rather than only a verdict, is what lets a test pin that
 * the WARN actually names its reason instead of just being yellow.
 *
 * `comparedSummary` is the coverage figure checks 1 and 2 print, phrased here
 * rather than assembled at either call site — both share this blind spot, so
 * both say how much the raw side could see instead of leaving it to a comment
 * the output never shows.
 *
 * It states root-ANCHORING coverage — how many roots had raw documents at all —
 * and deliberately not "how many this check compared", because the two checks
 * compare different sets: conservation adds a `raw > 10` noise floor, so a root
 * with a handful of documents is visible to the anchoring and still unreachable
 * by that filter. One fragment with one definition that is true for both beats a
 * second count per threshold, which would put back the "which number goes in
 * which line" hazard this fragment exists to remove.
 *
 * The numerator is `raw > 0` and NOT "roots that are not unmeasured", which
 * would put a `raw === 0 && rows === 0` root in it: nothing on disk and nothing
 * decoded is consistent rather than vacuous, but the raw side still saw nothing.
 * Returned as a finished fragment, not as two numbers for the caller to divide,
 * because the caller is `main()`: a figure whose whole job is to say how much
 * was seen must not be the one thing in this block that only runs on a machine
 * with a cache, and two fields are two chances to combine them wrongly where one
 * leaves none.
 *
 * SKIP for an empty list, matching {@link reportExtinctDependencies}: "all 0
 * roots decoded rows only where raw documents backed them" is the same
 * true-of-nothing line this whole change exists to remove. Unreachable today —
 * `decoded` in `main()` is a nine-element literal — but a status that would be
 * wrong if it were ever reached is not worth keeping for the sake of a shorter
 * function.
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
    status: 'WARN',
    detail:
      `${unmeasured.length}/${roots.length} roots decoded rows with zero raw documents beneath ` +
      `them: ` +
      unmeasured.map((d) => `${d.root} (0 raw → ${d.rows} rows)`).join(', ') +
      ` — the root name matches no collection pattern on this cache, so the decode-loss and ` +
      `conservation checks are measuring nothing for it. Their PASS for these roots carries no ` +
      `evidence; re-anchor each root to the pattern its documents actually use (the decoder ` +
      `matches by leaf, this counts by root prefix — #778)`,
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
 * Non-empty documents under a normalized collection root.
 *
 * Shared by the decode-loss check and the extinct-candidate report so the two
 * cannot disagree about what "has documents" means. Fieldless Firestore parent
 * pointers are excluded for the reason spelled out on
 * {@link findExtinctDependencies}: they exist for any path with
 * subcollections and would make an extinct collection look alive.
 */
export function nonEmptyRowsUnder(
  root: string,
  raw: ReadonlyMap<string, { total: number; empty: number }>
): number {
  let n = 0;
  for (const [pattern, counts] of raw) {
    if (pattern === root || pattern.startsWith(`${root}/`)) n += counts.total - counts.empty;
  }
  return n;
}

/**
 * Is this normalized pattern the ACCOUNT-document collection?
 *
 * `users/<uid>/accounts` also ends in `/accounts` and is a different collection
 * with a different field vocabulary (`hidden`, not `user_hidden`) — the
 * ambiguity `docs/firestore-collections.md` warns about, and the reason this
 * is a named predicate rather than an inline `endsWith`.
 *
 * The exclusion is `includes('users/')`, not `startsWith`, to match the
 * decoder's own routing verbatim (`decodeAllCollections` in
 * `src/core/decoder.ts`, and `decodeUserAccounts` beside it). Real paths are
 * top-level today, so the two spellings agree — but this check's whole value
 * is that its row set is the one `processAccount` sees, and the permissive
 * spelling is the one that would quietly admit rows whose visibility
 * vocabulary this file cannot read.
 *
 * NOT the same definition check 1 uses: that one measures accounts as
 * `rawRows('accounts')`, root-anchored to the top-level collection, while this
 * admits every pattern whose leaf is `accounts`. Deliberate — check 1 compares a decoder's
 * output against the collection it names, this one wants every document the
 * account processor would route. Left asymmetric rather than unified.
 */
export function isAccountDocumentPattern(pattern: string): boolean {
  if (pattern.includes('users/')) return false;
  return pattern === 'accounts' || pattern.endsWith('/accounts');
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
  | 'independent'
  | 'indistinguishable'
  | 'no-negatives'
  | 'absent'
  | 'no-account-documents';

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

export function countDashboardActive(
  rows: readonly AccountVisibilityRow[]
): DashboardActiveCounts {
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
  const dbPath = db.getDbPath();

  if (!dbPath || !db.isAvailable()) {
    console.error('[cache-smoke] no-cache-found — no local Copilot cache; nothing to check.');
    console.error('[cache-smoke] This is not a failure. Run on a machine with Copilot Money synced.');
    process.exit(0);
  }

  console.error(`[cache-smoke] scanning real cache`);

  // ---------------------------------------------------------------------
  // Raw scan: what is actually on disk, by normalized collection path.
  // ---------------------------------------------------------------------
  const raw = new Map<string, { total: number; empty: number }>();
  // `${collection}:${path}` → how many documents carry a non-finite value there.
  const nonFinite = new Map<string, number>();
  // Account documents reduced to two booleans for check 7. PII-safe by
  // construction: nothing but flags is kept, and only counts are reported.
  const accountRows: AccountVisibilityRow[] = [];
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

    for (const leafPath of nonFiniteLeafPaths(doc.fields)) {
      const key = `${pattern}:${leafPath}`;
      nonFinite.set(key, (nonFinite.get(key) ?? 0) + 1);
    }

    if (doc.fields.size > 0 && isAccountDocumentPattern(pattern)) {
      accountRows.push(readAccountVisibilityRow(doc.fields));
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  record(
    'raw scan',
    'PASS',
    `${scanned} documents across ${raw.size} collection patterns in ${elapsed}s`
  );

  /** Non-empty raw documents under a collection root. */
  const rawRows = (root: string): number => nonEmptyRowsUnder(root, raw);

  const all = await decodeAllCollections(dbPath);

  // ---------------------------------------------------------------------
  // Check 1 — total decode loss.
  //
  // The #622 signature: a collection has real documents on disk and the
  // decoder produces zero rows. Nothing else in the suite notices, because a
  // fixture-backed test only proves the decoder agrees with its author.
  // ---------------------------------------------------------------------
  const decoded: Array<{ root: string; rows: number }> = [
    { root: 'transactions', rows: all.transactions.length },
    { root: 'accounts', rows: all.accounts.length },
    { root: 'items', rows: all.items.length },
    { root: 'categories', rows: all.categories.length },
    { root: 'budgets', rows: all.budgets.length },
    { root: 'financial_goals', rows: all.goals.length },
    { root: 'investment_prices', rows: all.investmentPrices.length },
    { root: 'securities', rows: all.securities.length },
    { root: 'tags', rows: all.tags.length },
  ];

  const withRaw = decoded.map((d) => ({ ...d, raw: rawRows(d.root) }));
  // Computed before check 1 reports, because check 1's own PASS quotes how many
  // roots it compared and that count belongs to one tested function (#763).
  const coverage = reportDecodeLossCoverage(withRaw);
  const blackHoles = withRaw.filter((d) => isTotalDecodeLoss(d.raw, d.rows));
  if (blackHoles.length > 0) {
    record(
      'total decode loss',
      'FAIL',
      `collections with documents on disk but ZERO decoded rows: ` +
        blackHoles.map((d) => `${d.root} (${d.raw} docs)`).join(', ')
    );
  } else {
    record(
      'total decode loss',
      'PASS',
      `every collection with documents decoded at least one row ` +
        `(${coverage.comparedSummary} — see the coverage check below)`
    );
  }

  // ---------------------------------------------------------------------
  // Check 1b — decode-loss coverage (#763).
  //
  // What checks 1 and 2 could not see. Both read the raw side root-anchored
  // while the decoder routes leaf-anchored, so a root whose documents live at
  // a nested path is compared against nothing and passes vacuously. Reported
  // as its own line rather than folded into check 1's detail: a caveat inside
  // another check's PASS is read as part of the pass.
  //
  // This WARNs on every real cache today, which is its own hazard — a
  // permanently-yellow line is read as furniture, and a SEVENTH root joining
  // the set would move 6/9 to 7/9 unnoticed. Re-anchoring the roots, and
  // ratcheting this on growth until that lands, are #778.
  // ---------------------------------------------------------------------
  record('decode-loss coverage', coverage.status, coverage.detail);

  // ---------------------------------------------------------------------
  // Check 2 — conservation.
  //
  // Large unexplained shrinkage between disk and output. Some loss is
  // legitimate (dedup, tombstones, soft-deletes), so this warns rather than
  // fails; #622 discarded 91% of investment_prices and would have shown here
  // long before anyone read the output.
  //
  // Shares check 1's blind spot, and for the same reason: `d.raw > 10` is
  // never true for a root the raw side cannot find, so check 1b's WARN is the
  // coverage statement for this check too (#763) — which is why its PASS
  // quotes the same figure rather than leaving the caveat in this comment,
  // where the output never shows it. The figure is anchoring coverage, not
  // this check's own comparison count: the `> 10` floor below is a second,
  // deliberate narrowing on top of it.
  // ---------------------------------------------------------------------
  const lossy = withRaw.filter((d) => d.raw > 10 && d.rows > 0 && d.rows / d.raw < 0.5);

  if (lossy.length > 0) {
    record(
      'conservation',
      'WARN',
      `collections losing >50% of documents: ` +
        lossy.map((d) => `${d.root} ${d.raw}→${d.rows}`).join(', ') +
        ` (legitimate for soft-deletes/dedup — confirm each)`
    );
  } else {
    record(
      'conservation',
      'PASS',
      `no collection loses more than half its documents ` +
        `(${coverage.comparedSummary}; roots with 10 or fewer documents are below this ` +
        `check's floor — see the coverage check above)`
    );
  }

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
  // puts those customizations. The collection is still decoded, so the data is
  // there if it ever comes back, but no behaviour depends on it. It is not
  // unwatched: check 8 below reports its document count as an extinct
  // CANDIDATE, which is the question that replaced this one (#666).
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
    { name: 'transactions', standalone: () => decodeTransactions(dbPath), aggregate: all.transactions.length },
    { name: 'accounts', standalone: () => decodeAccounts(dbPath), aggregate: all.accounts.length },
    { name: 'recurring', standalone: () => decodeRecurring(dbPath), aggregate: all.recurring.length },
    { name: 'budgets', standalone: () => decodeBudgets(dbPath), aggregate: all.budgets.length },
    { name: 'financial_goals', standalone: () => decodeGoals(dbPath), aggregate: all.goals.length },
    { name: 'goal_history', standalone: () => decodeGoalHistory(dbPath), aggregate: all.goalHistory.length },
    {
      name: 'investment_prices',
      standalone: () => decodeInvestmentPrices(dbPath),
      aggregate: all.investmentPrices.length,
    },
    { name: 'items', standalone: () => decodeItems(dbPath), aggregate: all.items.length },
    { name: 'categories', standalone: () => decodeCategories(dbPath), aggregate: all.categories.length },
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
    record('decode-path parity', 'PASS', `all ${parity.length} collections agree across both paths`);
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
          `collection path over an empty cache, and compare isAccountDocumentPattern ` +
          `against the decoder's routing`
      );
      break;
  }

  // ---------------------------------------------------------------------
  // Check 8 — extinct candidate: users/<uid>/accounts (#624, #666).
  //
  // The inverse of check 3, and deliberately not part of it: check 3 fails
  // when code DEPENDS on an empty collection. Nothing depends on this one any
  // more — #624 moved the hidden filter and #660 moved the name map onto the
  // account documents — so the question is not "is a filter a no-op" but "may
  // the decoder, the model and the fixtures be deleted yet".
  //
  // One cache cannot answer that (#622's sampling-bias trap, which #624
  // attached to exactly this deletion). What this check does is make every
  // run on every machine a recorded data point, so the evidence accumulates
  // instead of being re-derived by the next person who notices the dead code.
  // ---------------------------------------------------------------------
  const EXTINCT_CANDIDATES = ['users/*/accounts'] as const;
  for (const pattern of EXTINCT_CANDIDATES) {
    const rows = nonEmptyRowsUnder(pattern, raw);
    if (rows === 0) {
      record(
        `extinct candidate: ${pattern}`,
        'PASS',
        `zero documents on this cache — one more data point for deleting the decoder, ` +
          `the model and the fixtures (#666). Deletion still waits on independent caches`
      );
    } else {
      record(
        `extinct candidate: ${pattern}`,
        'WARN',
        `${rows} document(s) — NOT extinct on this cache, and nothing in src/ reads them. ` +
          `Do not delete the path; re-open #666 with this cache as the counter-example`
      );
    }
  }

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
