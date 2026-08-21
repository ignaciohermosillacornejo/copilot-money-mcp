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
 * `validateOrWarn` also performs one repair before it gives up on a document:
 * non-finite numeric leaves (`NaN` / `±Infinity`) are stripped and the parse
 * retried, so a value Firestore can hold but Zod cannot costs one field
 * instead of the whole document (#659). See `./non-finite.ts`.
 */

import type { ZodType } from 'zod';
import { stripNonFiniteNumbers } from './non-finite.js';
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
 *     (`NaN` / `±Infinity`) and were kept with that field removed (#659).
 *     A subset of `decoded`: the document is present, one field is not.
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

export function validateOrWarn<T>(schema: ZodType<T>, data: unknown, ctx: DecodeContext): T | null {
  const result = schema.safeParse(data);
  if (result.success) {
    statsFor(ctx.collection).decoded++;
    return result.data;
  }

  // Before giving up on the document, try the one repair that is always safe:
  // remove non-finite numeric leaves (#659). Firestore stores IEEE-754
  // doubles, so `NaN` / `±Infinity` are legal on the wire and reach us
  // verbatim — Copilot writes an `Infinity` price for a holding whose
  // quantity is 0 — but Zod v4 rejects all three from `z.number()`. Dropping
  // the whole document over one unusable price is the failure mode of #302
  // all over again: an entire investment account disappeared from
  // `get_accounts`, and 18 months of holdings history from `get_holdings`.
  //
  // Only documents that become VALID once the leaf is gone are kept, so this
  // cannot mask an unrelated schema mismatch — those still drop and warn below.
  const stripped = stripNonFiniteNumbers(data);
  if (stripped.paths.length > 0) {
    const retry = schema.safeParse(stripped.value);
    if (retry.success) {
      const stats = statsFor(ctx.collection);
      stats.decoded++;
      stats.repaired++;

      const pathList = stripped.paths.join(',');
      const key = `${ctx.collection}::${stripped.paths.map(dedupeShape).join(',')}`;
      if (!warnedNonFiniteKeys.has(key)) {
        warnedNonFiniteKeys.add(key);
        console.warn(
          `[copilot-money-mcp] non-finite field: collection=${ctx.collection} docId=${ctx.docId} paths=${pathList} — value was NaN or ±Infinity in the cache; field dropped, document kept`
        );
      }
      return retry.data;
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
 *   - Any raw key not in either set emits one `console.warn` per process.
 *   - Consumed and ignored may overlap freely (e.g. if a field is read in
 *     some branches and ignored in others).
 */
export function warnUnreadFields(
  fields: Map<string, FirestoreValue>,
  options: { consumed: readonly string[]; ignored: readonly string[] },
  ctx: DecodeContext
): void {
  const known = new Set<string>([...options.consumed, ...options.ignored]);
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
  resetDecodeStats();
}
