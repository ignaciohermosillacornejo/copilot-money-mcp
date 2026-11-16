/**
 * Shared helper for the LevelDB decoder. Returns null on Zod failure
 * (preserving caller contract) but emits a structured `console.warn` to
 * stderr so schema drops become auditable instead of silent.
 *
 * Also exports `warnUnreadFields` which catches a different, equally silent
 * class of drops: fields present in the raw Firestore doc that no processor
 * reads (e.g. a new field Copilot adds upstream). Schema-drop logging can't
 * catch those because they never reach Zod — the decoder's allow-list filters
 * them out first.
 *
 * `validateOrWarn` also repairs before it gives up on a document: non-finite
 * numeric leaves (`NaN` / `±Infinity`) are stripped anywhere (#659, see
 * `./non-finite.ts`), and any other value the schema rejects BELOW the top
 * level is removed (#902, see `./nested-repair.ts`), so one bad nested value
 * costs that value instead of the whole document.
 */

import type { ZodType } from 'zod';
import { stripNonFiniteNumbers } from './non-finite.js';
import { repairNestedIssues } from './nested-repair.js';
import type { FirestoreValue } from './protobuf-parser.js';

export type DecodeContext = {
  collection: string;
  docId: string;
};

/**
 * Per-collection decode counters, accumulated during a decode pass.
 *
 * Unlike the warn dedupe sets (which persist for the process lifetime so a
 * refresh doesn't re-flood stderr), these counters are reset at the start of
 * every `decodeAllCollections` pass so they always describe the latest load:
 *   - `decoded`: docs that passed Zod validation (raw, pre-dedup). Includes
 *     repaired docs — they are in the results, so they decoded.
 *   - `dropped`: docs that failed Zod validation and were silently omitted
 *     from results. Counted per document, NOT deduped like the warnings.
 *   - `repaired`: docs that only failed because of a non-finite numeric leaf
 *     (`NaN` / `±Infinity`, #659) or a rejected value below the top level
 *     (#902), and were kept with that value (or the nested element holding
 *     it) removed. A subset of `decoded`: the document is present, part of it
 *     is not.
 *   - `unread_field_warnings`: unique `(collection, field)` pairs present in
 *     raw docs but neither consumed nor explicitly ignored by the processor.
 */
export type CollectionDecodeStats = {
  decoded: number;
  dropped: number;
  repaired: number;
  unread_field_warnings: number;
};

export type DecodeStatsByCollection = Record<string, CollectionDecodeStats>;

const decodeStats = new Map<string, CollectionDecodeStats>();

// Per-pass dedupe for the unread_field_warnings counter. Separate from
// `warnedUnreadKeys` (process-lifetime, governs stderr flood control) so a
// re-decode in the same process still counts fields that are still unread
// even though their stderr warning was already emitted on an earlier pass.
const countedUnreadKeys = new Set<string>();

function statsFor(collection: string): CollectionDecodeStats {
  let stats = decodeStats.get(collection);
  if (!stats) {
    stats = { decoded: 0, dropped: 0, repaired: 0, unread_field_warnings: 0 };
    decodeStats.set(collection, stats);
  }
  return stats;
}

/** Snapshot of the per-collection counters (deep copy, safe to mutate). */
export function getDecodeStats(): DecodeStatsByCollection {
  return Object.fromEntries([...decodeStats].map(([k, v]) => [k, { ...v }]));
}

/** Reset counters. Called at the start of each full decode pass. */
export function resetDecodeStats(): void {
  decodeStats.clear();
  countedUnreadKeys.clear();
}

/**
 * Collapse positional path segments so a dedupe key describes the SHAPE of a
 * failure rather than the document it happened in.
 *
 * Array indices and epoch-ms map keys differ per document, so keying on the
 * raw path defeats flood control: 18 dropped months at
 * `history.<distinct epoch>.price` emit 18 warns that all say the same thing,
 * which is what #659's reporter saw. Only the KEY collapses — the logged path
 * keeps its real indices, because a warn naming `<n>` is not actionable.
 *
 * Non-numeric dynamic keys (a `YYYY-MM-DD` under `daily_data`) still key
 * separately. Collapsing those would need a heuristic for "is this a field
 * name", and no collection has flooded on one yet.
 */
function dedupeShape(path: string): string {
  return path.replace(/(^|\.)\d+(?=\.|$)/g, '$1<n>');
}

/**
 * Dedupe-key form of a list of path shapes: distinct and sorted, so a
 * document with three unpriced holdings keys the same as one with one, and
 * document order does not matter.
 */
function shapeKey(shapes: readonly string[]): string {
  return [...new Set(shapes)].sort().join(',');
}

/** Paths listed in a warn, capped so one large document cannot flood stderr. */
const MAX_LISTED_PATHS = 10;

function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).join(',');
  const rest = paths.length - MAX_LISTED_PATHS;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}

// Dedupe key = `${collection}::${shape(firstIssue.path)}::${firstIssue.code}`.
// One warn per unique key per process. Prevents log flood when Copilot ships
// a new field shape that affects every doc in a collection. Note: only the
// first docId that hits a given key is logged — all subsequent docs with the
// same issue are silently dropped. If you need every offending docId, grep
// the cache with the logged path/code.
const warnedKeys = new Set<string>();

// Dedupe set for warnUnreadFields — separate namespace from schema-drop keys
// so a `validateOrWarn(collection=X, path=Y)` and an unread-field warn on the
// same `(X, Y)` don't collide. Reset by __resetWarnedKeys.
const warnedUnreadKeys = new Set<string>();

// Dedupe set for the non-finite repair warn, keyed by `(collection, paths)`.
// Same namespace rules as the two sets above.
const warnedNonFiniteKeys = new Set<string>();

// Dedupe set for the nested-value repair warn (#902), keyed by
// `(collection, path shapes + issue codes)`.
const warnedNestedKeys = new Set<string>();

export function validateOrWarn<T>(schema: ZodType<T>, data: unknown, ctx: DecodeContext): T | null {
  const result = schema.safeParse(data);
  if (result.success) {
    statsFor(ctx.collection).decoded++;
    return result.data;
  }

  // Before giving up on the document, try two repairs. Both only ever REMOVE
  // values, and a document is kept only if it validates afterwards.
  //
  // 1. Non-finite numeric leaves, anywhere (#659). Firestore stores IEEE-754
  //    doubles, so `NaN` / `±Infinity` are legal on the wire and reach us
  //    verbatim — Copilot writes an `Infinity` price for a holding whose
  //    quantity is 0 — but Zod v4 rejects all three from `z.number()`.
  // 2. Any other rejected value BELOW the top level (#902): a `null` price on
  //    one holding of an MX-linked 401k removed the whole account from
  //    `get_accounts`. Nested containers are copied verbatim by the decoder,
  //    so Zod is the only type check their leaves get; one bad leaf now costs
  //    that leaf (or, for a required nested field, the one element holding
  //    it) instead of the document. See `./nested-repair.ts`.
  //
  // Top-level failures are not repaired — those fields come from the
  // decoder's typed getters, so a mismatch there is real shape drift and still
  // drops and warns below.
  //
  // `stripNonFiniteNumbers` returns the input reference when nothing was
  // stripped, so in that case the parse above already holds round 0's issues
  // and the repair need not re-parse.
  const stripped = stripNonFiniteNumbers(data);
  const repair = repairNestedIssues(
    schema,
    stripped.value,
    stripped.paths.length === 0 ? result.error.issues : undefined
  );
  if (repair.ok) {
    const stats = statsFor(ctx.collection);
    stats.decoded++;
    stats.repaired++;

    if (stripped.paths.length > 0) {
      const key = `${ctx.collection}::${shapeKey(stripped.paths.map(dedupeShape))}`;
      if (!warnedNonFiniteKeys.has(key)) {
        warnedNonFiniteKeys.add(key);
        console.warn(
          `[copilot-money-mcp] non-finite field: collection=${ctx.collection} docId=${ctx.docId} paths=${listPaths(stripped.paths)} — value was NaN or ±Infinity in the cache; field dropped, document kept`
        );
      }
    }

    if (repair.removed.length > 0) {
      const key = `${ctx.collection}::${shapeKey(repair.removed.map((r) => `${dedupeShape(r.path)}:${r.code}`))}`;
      if (!warnedNestedKeys.has(key)) {
        warnedNestedKeys.add(key);
        const firstRemoval = repair.removed[0];
        // `message` is Zod's issue text. For the issue codes a nested repair
        // removes it names TYPES and bounds ("expected number, received
        // null"), not the received value — same reasoning as the schema-drop
        // warn below — and the paths are field names, indices and map keys
        // (dates / epoch-ms), never amounts.
        console.warn(
          `[copilot-money-mcp] invalid nested field: collection=${ctx.collection} docId=${ctx.docId} paths=${listPaths(repair.removed.map((r) => r.path))} code=${firstRemoval?.code} message="${firstRemoval?.message}" — value did not match the schema; removed, document kept`
        );
      }
    }
    return repair.data;
  }

  // The repair giving up after its round bound is NOT the expected refusal of
  // a top-level failure: without this line it would look exactly like the
  // pre-#902 drop, a nested path in a `schema drop` warn with no hint that a
  // repair ran. Say so separately.
  if (repair.reason === 'exhausted') {
    const key = `${ctx.collection}::exhausted`;
    if (!warnedNestedKeys.has(key)) {
      warnedNestedKeys.add(key);
      console.warn(
        `[copilot-money-mcp] nested repair exhausted: collection=${ctx.collection} docId=${ctx.docId} — the nested-value repair hit its round limit before the document validated; it is dropped (see the schema drop warn). This is a bug in copilot-money-mcp, please report it.`
      );
    }
  }

  // Count every dropped doc — drops are NOT deduped like the warnings below,
  // so the counters reflect the true number of missing documents.
  statsFor(ctx.collection).dropped++;

  // Zod always provides ≥1 issue on failure; guard is defensive only.
  const first = result.error.issues[0];
  if (first) {
    const pathStr = first.path.join('.');
    const key = `${ctx.collection}::${dedupeShape(pathStr)}::${first.code}`;
    if (!warnedKeys.has(key)) {
      warnedKeys.add(key);
      // console.warn writes to stderr in Node, safe for MCP stdio transport.
      // console.log would corrupt the JSON-RPC protocol on stdout.
      // `message` may include the received value for enum issues; current
      // schemas only enum over system-controlled strings (account_type,
      // frequency, etc.), and stderr stays local to the user's machine.
      console.warn(
        `[copilot-money-mcp] schema drop: collection=${ctx.collection} docId=${ctx.docId} path=${pathStr} code=${first.code} message="${first.message}"`
      );
    }
  }
  return null;
}

/**
 * Fields Copilot's BACKEND stamps on documents across the whole database,
 * ignored by every processor rather than by 11 of them (#718, closing #611).
 *
 * `_migration_backfill` marks a document rewritten by a server-side backfill;
 * `_replicated_at` marks when a replication pass last copied it. Neither says
 * anything about the money in the document, and no processor reads either.
 *
 * WHY THIS IS NOT ELEVEN `ignored:` ENTRIES. A `bun run smoke:cache` against
 * a real cache on 2026-09-16 found `_migration_backfill` on 11 collections
 * (amazon_orders, investment_prices, items, accounts, balance_history,
 * transactions, budgets, categories, goals, goal_history, recurring) and
 * `_replicated_at` on 7 (investment_prices, accounts, items, balance_history,
 * securities, user_profile, recurring). Issue #718's body recorded 10 and 8
 * two days earlier. NEITHER SPLIT IS A PROPERTY OF THOSE COLLECTIONS — it is
 * a record of which documents a backend job happened to touch before the
 * snapshot, and it moved between two runs of the same command. Encoding it
 * per-processor would bake a measurement that is already stale into eleven
 * places and guarantee a fresh warning the next time the backfill reaches a
 * twelfth collection.
 *
 * THE COST OF CENTRALISING, stated plainly: a field with one of these two
 * names is now unreportable everywhere, including on a collection where it
 * has never been seen. That is acceptable only because the names are the
 * backend's own underscore-prefixed namespace rather than anything Copilot
 * would use for user data — the risk a future `_replicated_at` carries
 * spendable information is what this comment is wagering against. Membership
 * is pinned verbatim by tests/core/schema-warn.test.ts, so adding a third
 * name is a deliberate edit to a failing test rather than a quiet widening.
 */
export const FIRESTORE_BACKEND_MARKERS: readonly string[] = [
  '_migration_backfill',
  '_replicated_at',
];

/**
 * Warn once per `(collection, fieldName)` when a raw Firestore doc contains a
 * field that is neither consumed nor explicitly ignored by the processor.
 *
 * Why this exists: `validateOrWarn` protects the Zod boundary. It fires when
 * a value we attempted to read fails validation. But the allow-list in every
 * `process*` function drops unknown fields before Zod ever sees them — if
 * Copilot ships a new field, we'd never know. This helper closes that gap.
 *
 * Rules:
 *   - `consumed`: fields the processor actively reads (e.g. `stringFields`).
 *   - `ignored`: fields we know about but deliberately drop (e.g. denormalized
 *     nested objects where we read the flat equivalents, or noisy intelligence
 *     scores). Entries here document intent.
 *   - {@link FIRESTORE_BACKEND_MARKERS}: ignored on every collection without
 *     any processor listing them. See that constant for why.
 *   - Any raw key in none of the three emits one `console.warn` per process.
 *   - Consumed and ignored may overlap freely (e.g. if a field is read in
 *     some branches and ignored in others).
 */
export function warnUnreadFields(
  fields: Map<string, FirestoreValue>,
  options: { consumed: readonly string[]; ignored: readonly string[] },
  ctx: DecodeContext
): void {
  const known = new Set<string>([
    ...options.consumed,
    ...options.ignored,
    ...FIRESTORE_BACKEND_MARKERS,
  ]);
  for (const key of fields.keys()) {
    if (known.has(key)) continue;
    const dedupeKey = `unread::${ctx.collection}::${key}`;
    if (!countedUnreadKeys.has(dedupeKey)) {
      countedUnreadKeys.add(dedupeKey);
      statsFor(ctx.collection).unread_field_warnings++;
    }
    if (warnedUnreadKeys.has(dedupeKey)) continue;
    warnedUnreadKeys.add(dedupeKey);
    console.warn(
      `[copilot-money-mcp] unread field: collection=${ctx.collection} docId=${ctx.docId} field=${key}`
    );
  }
}

// Exposed for tests only. Clears dedupe sets AND the per-pass counters so
// each test starts from a clean slate.
export function __resetWarnedKeys(): void {
  warnedKeys.clear();
  warnedUnreadKeys.clear();
  warnedNonFiniteKeys.clear();
  warnedNestedKeys.clear();
  resetDecodeStats();
}
