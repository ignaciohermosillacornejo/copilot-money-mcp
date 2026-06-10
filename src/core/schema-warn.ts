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
 */

import type { ZodType } from 'zod';
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
 *   - `decoded`: docs that passed Zod validation (raw, pre-dedup).
 *   - `dropped`: docs that failed Zod validation and were silently omitted
 *     from results. Counted per document, NOT deduped like the warnings.
 *   - `unread_field_warnings`: unique `(collection, field)` pairs present in
 *     raw docs but neither consumed nor explicitly ignored by the processor.
 */
export type CollectionDecodeStats = {
  decoded: number;
  dropped: number;
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
    stats = { decoded: 0, dropped: 0, unread_field_warnings: 0 };
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

// Dedupe key = `${collection}::${firstIssue.path.join('.')}::${firstIssue.code}`.
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

export function validateOrWarn<T>(schema: ZodType<T>, data: unknown, ctx: DecodeContext): T | null {
  const result = schema.safeParse(data);
  if (result.success) {
    statsFor(ctx.collection).decoded++;
    return result.data;
  }

  // Count every dropped doc — drops are NOT deduped like the warnings below,
  // so the counters reflect the true number of missing documents.
  statsFor(ctx.collection).dropped++;

  // Zod always provides ≥1 issue on failure; guard is defensive only.
  const first = result.error.issues[0];
  if (first) {
    const pathStr = first.path.join('.');
    const key = `${ctx.collection}::${pathStr}::${first.code}`;
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
  resetDecodeStats();
}
