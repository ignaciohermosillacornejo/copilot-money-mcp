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

type Status = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';

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
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  record(
    'raw scan',
    'PASS',
    `${scanned} documents across ${raw.size} collection patterns in ${elapsed}s`
  );

  /** Non-empty raw documents under a collection root. */
  function rawRows(root: string): number {
    let n = 0;
    for (const [pattern, counts] of raw) {
      if (pattern === root || pattern.startsWith(`${root}/`)) n += counts.total - counts.empty;
    }
    return n;
  }

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
  const blackHoles = withRaw.filter((d) => isTotalDecodeLoss(d.raw, d.rows));
  if (blackHoles.length > 0) {
    record(
      'total decode loss',
      'FAIL',
      `collections with documents on disk but ZERO decoded rows: ` +
        blackHoles.map((d) => `${d.root} (${d.raw} docs)`).join(', ')
    );
  } else {
    record('total decode loss', 'PASS', 'every collection with documents decoded at least one row');
  }

  // ---------------------------------------------------------------------
  // Check 2 — conservation.
  //
  // Large unexplained shrinkage between disk and output. Some loss is
  // legitimate (dedup, tombstones, soft-deletes), so this warns rather than
  // fails; #622 discarded 91% of investment_prices and would have shown here
  // long before anyone read the output.
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
    record('conservation', 'PASS', 'no collection loses more than half its documents');
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
  // there if it ever comes back, but no behaviour depends on it.
  const DEPENDED_ON: string[] = [];
  const extinct = findExtinctDependencies(DEPENDED_ON, raw);

  if (extinct.length > 0) {
    record(
      'extinct dependencies',
      'FAIL',
      `code reads collections with zero documents: ${extinct.join(', ')} — ` +
        `any filter built on them is a silent no-op (see #624)`
    );
  } else {
    record('extinct dependencies', 'PASS', 'every depended-on collection has documents');
  }

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
  // Summary
  // ---------------------------------------------------------------------
  const failed = results.filter((r) => r.status === 'FAIL');
  const warned = results.filter((r) => r.status === 'WARN');

  console.error('');
  console.error(
    `[cache-smoke] ${results.filter((r) => r.status === 'PASS').length} pass, ` +
      `${warned.length} warn, ${failed.length} fail`
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
