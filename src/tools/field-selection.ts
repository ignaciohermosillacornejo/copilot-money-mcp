/**
 * Shared field-selection engine (#597 v3 base).
 *
 * A single cached document often carries 35-40 fields, most of which go
 * unused for typical queries — pulling result pages at full width wastes an
 * MCP client's context. This module is the one engine every field-selecting
 * tool builds on (cache reshape, live parity, accounts preset): token
 * expansion, order-preserving dedupe, allowlist projection, and unknown-name
 * detection. The core functions are generic over row shape — per-tool
 * presets (like {@link DEFAULT_TRANSACTION_FIELDS}) are plain constants the
 * callers pass in.
 */

/**
 * The default field set for transaction rows: the v3 baseline that
 * `fields: ["default"]` expands to. Covers "what did I spend, where, when,
 * in what category, on which account" plus the flags needed to reason about
 * exclusions and transfers. (Distinct from the 7-field `compact` preset in
 * tools.ts, which predates this engine and is unchanged.)
 */
export const DEFAULT_TRANSACTION_FIELDS = [
  'transaction_id',
  'date',
  'amount',
  'name',
  'category_name',
  'account_id',
  'item_id',
  'pending',
  'excluded',
  'internal_transfer',
] as const;

/**
 * The default field set for investment-price rows (#605).
 *
 * Deliberately excludes `prices` — the nested epoch-millis series that is
 * most of a row (~75-90%, depending on how many points the period carries) —
 * and carries the derived `latest_price`/`latest_at`
 * instead, so a terse row still answers "what is this security worth".
 * `date` and `month` are both listed because a row has exactly one of them
 * (`hf` and `daily` respectively); projection simply omits the absent key.
 */
export const DEFAULT_INVESTMENT_PRICE_FIELDS = [
  'security_id',
  'ticker_symbol',
  'price_type',
  'date',
  'month',
  'latest_price',
  'latest_at',
] as const;

/**
 * JSON-schema fragment for `get_investment_prices`' `fields` param.
 *
 * The description NAMES the expensive token (`prices`) on purpose. A generic
 * selection parameter is otherwise undiscoverable: unlike a boolean called
 * `include_series`, nothing about `fields` tells a caller that a series exists
 * at all, so omitting it from `"default"` would hide the data rather than
 * defer it. Naming what `"default"` leaves out is part of the convention —
 * see the decision note on issue #597.
 */
export const INVESTMENT_PRICE_FIELDS_PARAM_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Return only these fields per row. Default when omitted: a terse row ' +
    '(security_id, ticker_symbol, price_type, date/month, latest_price, latest_at). ' +
    'The full intraday/daily series lives in `prices`, which is EXCLUDED by default ' +
    'because it is most of a row and multiplies response size several-fold — ' +
    'request it explicitly with ' +
    'fields: ["default", "prices"], or use "all" / "*" for full rows. ' +
    'Unknown names are omitted and reported via _field_warning.',
} as const;

/**
 * JSON-schema fragment for the `fields` input param, shared verbatim by
 * get_transactions (cache) and get_transactions_live so the two modes cannot
 * drift — parity is pinned by tests/tools/live/transactions.test.ts, which
 * compares the fragments through the registry defs. Note for live rows: 2 of
 * the 10 `"default"` baseline names (`excluded`, `internal_transfer`) are
 * cache-document-only and are simply absent from live rows.
 */
export const TRANSACTION_FIELDS_PARAM_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Return only these fields per transaction (e.g. ["transaction_id", "date", "name", ' +
    '"amount", "category_name"]). Tokens: "default" expands to a curated baseline of core ' +
    'fields; "all" or "*" returns the full row. Unknown names are omitted and reported via ' +
    '_field_warning.',
} as const;

/**
 * Default fields for top-mover rows (#597 Tier 1).
 *
 * Excludes `price_points` — the intraday {timestamp, price} series that is
 * ~95% of a row. A caller asking "what moved today" wants the name and the
 * change, not the tick data. Unlike get_investment_prices there is nothing to
 * derive: `change` is already the answer and is a top-level field.
 */
export const DEFAULT_TOP_MOVER_FIELDS = [
  'security_id',
  'ticker_symbol',
  'name',
  'type',
  'change',
] as const;

export const TOP_MOVER_FIELDS_PARAM_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Return only these fields per mover. Default when omitted: security_id, ticker_symbol, ' +
    'name, type, change. The intraday tick series (`price_points`: {timestamp, price}) is ' +
    'EXCLUDED by default because it is roughly 95% of a full row — request it with ' +
    'fields: ["default", "price_points"], or "all" / "*" for full rows. ' +
    'Unknown names are omitted and reported via _field_warning.',
} as const;

/** Token that expands to the caller-supplied preset. */
const TOKEN_DEFAULT = 'default';

/** Tokens that disable projection entirely (full documents). */
const ALL_TOKENS: ReadonlySet<string> = new Set(['all', '*']);

/** True for selection tokens the engine interprets (never literal field names). */
function isToken(name: string): boolean {
  return name === TOKEN_DEFAULT || ALL_TOKENS.has(name);
}

/**
 * Guard against a host that skipped JSON-schema validation and handed us a
 * non-array `fields`. Iterating a string with `new Set(...)` would silently
 * project on single characters, so fail loudly instead.
 */
function assertFieldsArray(fields: unknown): asserts fields is readonly string[] | undefined {
  if (fields !== undefined && !Array.isArray(fields)) {
    throw new Error(`fields must be an array of field-name strings; got ${typeof fields}`);
  }
}

/**
 * Expand a requested field list into a concrete allowlist.
 *
 * - `"default"` expands (in place, once) to `preset`, order-preserving and
 *   deduped — e.g. `["default", "plaid_category_id"]` is the preset plus one.
 * - `"all"` or `"*"` anywhere in the list disables projection entirely:
 *   returns `undefined` (full documents).
 * - Empty array or `undefined` returns `undefined` — the caller decides the
 *   default (in 2.x that means no projection).
 */
export function expandFieldSelection(
  fields: readonly string[] | undefined,
  preset: readonly string[]
): string[] | undefined {
  assertFieldsArray(fields);
  if (!fields || fields.length === 0) return undefined;
  if (fields.some((name) => ALL_TOKENS.has(name))) return undefined;

  const expanded: string[] = [];
  const seen = new Set<string>();
  const push = (name: string): void => {
    if (!seen.has(name)) {
      seen.add(name);
      expanded.push(name);
    }
  };
  for (const name of fields) {
    if (name === TOKEN_DEFAULT) {
      for (const presetName of preset) push(presetName);
    } else {
      push(name);
    }
  }
  // A non-empty input can only expand to nothing when it consisted solely of
  // "default" tokens and no preset was supplied. Silently projecting every
  // row to `{}` would be a data-loss footgun for a mis-wired consumer, so
  // fail loudly instead.
  if (expanded.length === 0) {
    throw new Error(
      'fields requested the "default" preset, but no default preset is configured for this tool'
    );
  }
  return expanded;
}

/** Options for {@link projectRows}. */
export interface ProjectRowsOptions {
  /** Per-tool preset the `"default"` token expands to. Defaults to none. */
  preset?: readonly string[];
  /**
   * The complete set of valid field names for this tool's rows. When given,
   * unknown-name detection checks requested names against it; without it,
   * detection falls back to warning only on names absent from every row
   * (which cannot distinguish a typo from an optional field that happens to
   * be unset on this result page).
   */
  knownFields?: ReadonlySet<string>;
  /**
   * Short phrase describing where valid names come from, spliced into the
   * unknown-name warning (e.g. "the transaction document fields plus the
   * enrichment fields category_name and normalized_merchant").
   */
  validFieldsHint?: string;
}

/**
 * Project each row down to the expanded allowlist and report requested names
 * that match nothing. Original document key order is preserved; input rows
 * are never mutated. `fields` of `undefined` (or empty, or containing
 * `"all"`/`"*"`) returns the rows unchanged.
 */
export function projectRows<T extends Record<string, unknown>>(
  rows: readonly T[],
  fields: readonly string[] | undefined,
  opts: ProjectRowsOptions = {}
): { rows: T[]; warning?: string } {
  // expandFieldSelection runs first: its non-array guard also protects
  // detectUnknownFields below (single guard, no double validation).
  const expanded = expandFieldSelection(fields, opts.preset ?? []);
  // Deliberate: detection runs on the ORIGINAL list even when a token like
  // "all" disables projection, so `["all", "a_typo"]` still reports the typo
  // — every unknown requested name is surfaced, whether or not projection
  // made it consequential.
  const warning = detectUnknownFields(rows, fields, opts);
  if (!expanded) {
    return { rows: [...rows], ...(warning && { warning }) };
  }
  const fieldSet = new Set(expanded);
  const projected = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(row)) {
      // A hostile own '__proto__' key (e.g. from JSON.parse'd input) would
      // assign through the inherited setter and mutate the projected
      // object's prototype instead of copying data — skip it. The engine is
      // generic; future consumers' rows are not guaranteed decoder-shaped.
      if (key === '__proto__') continue;
      if (fieldSet.has(key)) out[key] = row[key];
    }
    // Deliberate widening: projected rows keep type T even though they carry
    // only the selected keys — `Partial<T>` would force every caller (who
    // already knows exactly what it asked for) to null-check each field.
    return out as T;
  });
  return { rows: projected, ...(warning && { warning }) };
}

/**
 * Build the unknown-name warning for a requested field list, or `undefined`
 * when every non-token name is accounted for. See
 * {@link ProjectRowsOptions.knownFields} for the two detection modes.
 */
function detectUnknownFields(
  rows: readonly Record<string, unknown>[],
  fields: readonly string[] | undefined,
  opts: ProjectRowsOptions
): string | undefined {
  if (!fields || fields.length === 0) return undefined;
  const requested = fields.filter((name) => !isToken(name));
  let unknown: string[];
  if (opts.knownFields) {
    const known = opts.knownFields;
    unknown = requested.filter((name) => !known.has(name));
  } else {
    // Fallback: a name is unknown only if no row carries it as an OWN key —
    // `in` would also match inherited prototype properties like `toString`,
    // masking the warning while the projection still yields empty rows. With
    // zero rows there is nothing to compare against, so stay silent rather
    // than flag every requested name.
    if (rows.length === 0) return undefined;
    unknown = requested.filter((name) => rows.every((row) => !Object.hasOwn(row, name)));
  }
  if (unknown.length === 0) return undefined;
  const hint = opts.validFieldsHint ?? 'the fields of the returned documents';
  return `Unknown field name(s) ignored: ${unknown.join(', ')}. Valid names are ${hint}.`;
}
