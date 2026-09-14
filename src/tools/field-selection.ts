/**
 * Shared field-selection engine (#597 v3 base).
 *
 * A single cached document often carries dozens of fields, most of which go
 * unused for typical queries — pulling result pages at full width wastes an
 * MCP client's context. This module is the one engine every field-selecting
 * tool builds on (cache reshape, live parity, accounts preset): token
 * expansion, order-preserving dedupe, allowlist projection, and unknown-name
 * detection. The core functions are generic over row shape — per-tool
 * presets (like {@link DEFAULT_TRANSACTION_FIELDS}) are plain constants the
 * callers pass in.
 *
 * Presets carry a `satisfies readonly (keyof Row)[]` clause where the row type
 * is available. That makes a TYPO in a preset a compile error, which it
 * otherwise would not be: `detectUnknownFields` runs before `'default'`
 * expands, so preset members are exempt from the _field_warning path a
 * caller-supplied name goes through — a misspelled entry would silently drop
 * its field with nothing reported anywhere. It does NOT catch a DELETED
 * entry; that is what the verbatim preset-shape tests in
 * tests/tools/field-selection.test.ts are for. Both halves are required.
 *
 * The row-type imports below are `import type` on purpose: the live tool
 * modules import their presets from here, so a value import would close a
 * runtime cycle. Type imports are erased.
 */
import type { GetTopMoversLiveEntry } from './live/top-movers.js';
import type { CategoryLiveRow } from './live/categories.js';
import type { GetRecurringLiveRow } from './live/recurring.js';
import type { GetAccountsLiveRow } from './live/accounts.js';

/**
 * The default field set for transaction rows: the v3 baseline that
 * `fields: ["default"]` expands to, and — since #604 — what BOTH
 * get_transactions and get_transactions_live return when `fields` is
 * omitted. Covers "what did I spend, where, when, in what category, on which
 * account" plus the flags needed to reason about exclusions and transfers.
 * (The 7-field `compact` preset this superseded was deleted in #604 along
 * with the boolean that selected it.)
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
 * most of a row (measured at ~75% on a 100-row page against a real cache;
 * proportionally larger for securities whose period carries more points) —
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
 * compares the fragments through the registry defs.
 *
 * Rewritten for #604, when the default flipped from full documents to
 * `["default"]`: only then did "EXCLUDED by default" become true of this
 * parameter, so the wording that names the exclusions had to wait for the
 * flip rather than ship ahead of it. The same #604 closed the old 10-vs-8
 * gap by synthesizing `excluded` and `internal_transfer` on live rows, so
 * this fragment can now describe one default row for both modes — with the
 * fidelity caveat on the live tool's own description, where it belongs.
 */
export const TRANSACTION_FIELDS_PARAM_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Return only these fields per transaction. Default when omitted: a terse row ' +
    '(transaction_id, date, amount, name, category_name, account_id, item_id, pending, ' +
    'excluded, internal_transfer). That drops ~50 other fields of a cache document. ' +
    'PARTIAL list of what goes, not exhaustive: Plaid metadata (plaid_category_id, ' +
    'plaid_category_strings, plaid_transaction_type, plaid_deleted), internal IDs ' +
    '(category_id, recurring_id, goal_id, parent_transaction_id, children_transaction_ids, ' +
    'pending_transaction_id, user_id), enrichment and intelligence fields ' +
    '(normalized_merchant, intelligence_suggested_category_ids, suggestion_ids, ' +
    'original_name, name_override), tagging (tag_ids), review state (user_reviewed, ' +
    'user_note), location (city, region, country, lat, lon), and flags like is_amazon / ' +
    'from_investment / is_manual. Any of them is requestable by name: ' +
    'fields: ["default", "tag_ids", "user_note"], or "all" / "*" for the full row. ' +
    'Unknown names are omitted and reported via _field_warning.',
} as const;

/**
 * Default fields for top-mover rows (#597 Tier 1).
 *
 * Excludes `price_points` — the intraday {timestamp, price} series measured
 * at ~94.7% of the response on a synthetic fixture (20 movers x 50 price
 * points each; see CHANGELOG). A caller asking "what moved today" wants the
 * name and the change, not the tick data. Unlike get_investment_prices there
 * is nothing to derive: `change` is already the answer and is a top-level
 * field.
 */
export const DEFAULT_TOP_MOVER_FIELDS = [
  'security_id',
  'ticker_symbol',
  'name',
  'type',
  'change',
] as const satisfies readonly (keyof GetTopMoversLiveEntry)[];

export const TOP_MOVER_FIELDS_PARAM_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Return only these fields per mover. Default when omitted: security_id, ticker_symbol, ' +
    'name, type, change. The intraday tick series (`price_points`: {timestamp, price}) is ' +
    'EXCLUDED by default — measured at ~94.7% of the response on a synthetic fixture (20 ' +
    'movers x 50 price points each) — request it with ' +
    'fields: ["default", "price_points"], or "all" / "*" for full rows. ' +
    'Unknown names are omitted and reported via _field_warning.',
} as const;

/**
 * Default fields for live category rows (#597 Tier 1).
 *
 * Excludes the embedded `budget` object ({current, histories} — a full
 * monthly series per category, the #597 audit estimated ~62% of a row, and a
 * duplicate of what get_budgets_live returns). The one number callers
 * actually read, `budget.current.amount`, is derived onto the row as
 * `budget_amount` so the terse row still answers "what is this category
 * budgeted at".
 */
export const DEFAULT_CATEGORY_LIVE_FIELDS = [
  'id',
  'parentId',
  'name',
  'colorName',
  'isExcluded',
  'budget_amount',
] as const satisfies readonly (keyof CategoryLiveRow)[];

export const CATEGORY_LIVE_FIELDS_PARAM_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Return only these fields per category. Default when omitted: id, parentId, name, ' +
    'colorName, isExcluded, budget_amount. The embedded `budget` object (`{current, ' +
    'histories}` — a full monthly series) is EXCLUDED by default because the #597 audit ' +
    'estimated it at ~62% of a row, and it duplicates get_budgets_live — the single number ' +
    'most callers want, `budget.current.amount`, is already on the row as `budget_amount`. ' +
    'Request the full object with fields: ["default", "budget"], or "all" / "*" for full rows. ' +
    'Unknown names are omitted and reported via _field_warning.',
} as const;

/**
 * Default fields for live recurring rows (#597 Tier 1).
 *
 * Excludes `rule` (the server-side matcher config: min/max amount, match
 * strings — operational detail no caller reasons about) and `payments` (the
 * full payment history, which duplicates what get_transactions returns).
 * Together they are ~45% of a row. `icon` goes too: `emoji` already carries
 * the display character without the union wrapper.
 */
export const DEFAULT_RECURRING_LIVE_FIELDS = [
  'id',
  'name',
  'state',
  'frequency',
  'nextPaymentAmount',
  'nextPaymentDate',
  'categoryId',
  'category_name',
  'emoji',
] as const satisfies readonly (keyof GetRecurringLiveRow)[];

/**
 * Default fields for cache-mode get_recurring_transactions rows (#606).
 *
 * Excludes the embedded `transactions` array (date/amount pairs already
 * reachable via get_transactions, ~29% of a row) and `confidence_reason`
 * (explanatory prose, ~15%). `confidence` itself stays: it is the part a
 * caller acts on.
 */
export const DEFAULT_RECURRING_CACHE_FIELDS = [
  'merchant',
  'normalized_merchant',
  'occurrences',
  'average_amount',
  'total_amount',
  'frequency',
  'confidence',
  'category_name',
  'last_date',
  'next_expected_date',
] as const;

/**
 * JSON-schema fragment for `get_recurring_live` and `get_upcoming_recurrings_live`'s
 * `fields` param — shared verbatim by both so their two `fields` descriptions
 * cannot drift (same row shape, same excluded tokens).
 */
export const RECURRING_FIELDS_PARAM_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Return only these fields per recurring row. Default when omitted: id, name, state, ' +
    'frequency, nextPaymentAmount, nextPaymentDate, categoryId, category_name, emoji. ' +
    'EXCLUDED by default because together they are roughly half of a full row: `rule` ' +
    "(Copilot's server-side matcher config) and `payments` (full payment history — the same " +
    'charges are queryable via get_transactions). Request them with ' +
    'fields: ["default", "rule", "payments"], or use "all" / "*" for full rows. ' +
    'Unknown names are omitted and reported via _field_warning.',
} as const;

/**
 * JSON-schema fragment for cache-mode `get_recurring_transactions`' `fields` param.
 */
export const RECURRING_CACHE_FIELDS_PARAM_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Return only these fields per detected recurring merchant. Default when omitted omits ' +
    'two expensive fields: `transactions` (the matched date/amount pairs, ~29% of a row) and ' +
    '`confidence_reason` (prose explaining the confidence score, ~15%). `confidence` itself ' +
    'is always in the default. Request the rest with ' +
    'fields: ["default", "transactions", "confidence_reason"], or "all" / "*" for full rows. ' +
    'Unknown names are omitted and reported via _field_warning.',
} as const;

/**
 * Default fields for account rows, shared by get_accounts (cache) and
 * get_accounts_live (#597 Tier 2). Field NAMES differ between the two
 * surfaces (cache documents are snake_case, live nodes are camelCase), so
 * each tool passes its own preset built from this intent: identity, name,
 * type, balance, institution, currency, item, plus the visibility flags.
 *
 * The visibility flags are in the preset on purpose, and they are the one
 * part of this intent that is not "what a caller reads every time". Both
 * tools hide these rows by default and both take `include_hidden: true` to
 * bring them back — so a caller who opts in is asking to see exactly the
 * rows the flags discriminate. Projecting the flags away left the opt-in
 * caller with hidden/closed/merged rows shape-identical to live ones, with
 * `total_balance` counting them and nothing on the row to tell them apart.
 * Cost is near zero: all three are optional on the cache document, so an
 * ordinary active row still projects without them.
 *
 * Cut from the cache row: the embedded `holdings` array (~20%, and
 * get_holdings covers it), `official_name` / `original_*` denormalized dupes
 * of `name`, and `user_id` (constant across every row of a single-user cache).
 * Cut from the live row: sync machinery (`hasHistoricalUpdates`,
 * `hasLiveBalance`, `liveBalance`, `latestBalanceUpdate`, `isManual`) — ~23%
 * of a row describing Plaid plumbing, not the account. The live row has no
 * currency field at all, so that part of the intent applies to cache mode
 * only.
 */
export const DEFAULT_ACCOUNT_FIELDS = [
  'account_id',
  'name',
  'account_type',
  'subtype',
  'current_balance',
  'institution_name',
  'iso_currency_code',
  'item_id',
  'user_hidden',
  'user_deleted',
] as const;

export const DEFAULT_ACCOUNT_LIVE_FIELDS = [
  'id',
  'name',
  'type',
  'subType',
  'balance',
  'institutionId',
  'itemId',
  'isUserHidden',
  'isUserClosed',
] as const satisfies readonly (keyof GetAccountsLiveRow)[];

/**
 * JSON-schema fragment for the `fields` input param, shared verbatim by
 * get_accounts (cache) and get_accounts_live so the two modes cannot drift —
 * parity is pinned by a schema-equality test in
 * tests/tools/live/accounts.test.ts. Deliberately generic (unlike e.g.
 * RECURRING_FIELDS_PARAM_SCHEMA above): the two presets don't share field
 * names, so this fragment can't name a token both rows recognize — each
 * tool's own description does that naming instead.
 */
export const ACCOUNT_FIELDS_PARAM_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Return only these fields per account row (e.g. ["account_id", "name", "current_balance"] ' +
    'for get_accounts, or ["id", "name", "balance"] for get_accounts_live — field names differ ' +
    'between the two modes). "default" expands to a terse baseline covering identity, name, ' +
    "type, balance, institution, and item — see each tool's own description for its exact " +
    'field list and what "default" excludes. "all" or "*" returns the full row. Unknown names ' +
    'are omitted and reported via _field_warning.',
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
 * Drop an EMPTY `fields` array from a tool call's arguments, so `fields: []`
 * means exactly what OMITTING `fields` means — for whichever tool was called.
 *
 * Why this cannot live in {@link projectRows}: by the time the engine is
 * called, each handler has already folded "omitted" into its own default —
 * `args.fields ?? ['default']` for a terse-by-default tool, `undefined` for a
 * tool that still returns full rows when `fields` is omitted. An explicit
 * `[]` survives `??` untouched, so the engine receives `[]` from both kinds
 * of tool and has no way to tell which default it should stand in for.
 * Deleting `fields` BEFORE the handler's `??` runs reuses each tool's own
 * omitted-path instead of guessing one. Since #604 every field-selecting read
 * tool is terse-by-default, so `fields: []` now projects the preset
 * everywhere — but the normalization stays where it is: it is what keeps
 * `[] == omitted` true for whatever the next tool's default turns out to be.
 *
 * Applied once, in `defineTool` (src/tools/registry/types.ts), so every tool
 * inherits it and no call site changes — in particular the literal
 * `x.fields ?? ['default']` idiom stays intact, which
 * tests/tools/registry/diet-fields-disclosure.test.ts discovers diet tools by.
 *
 * Non-mutating: returns a copy without the key, never edits the caller's
 * object. A non-array `fields` is passed through untouched so
 * {@link assertFieldsArray} still throws on it downstream.
 */
export function dropEmptyFieldSelection(
  args: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!args || !Array.isArray(args.fields) || args.fields.length > 0) return args;
  const rest = { ...args };
  delete rest.fields;
  return rest;
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
 *   default (in 2.x that means no projection). Note that a dispatched tool
 *   call never arrives with an empty array: {@link dropEmptyFieldSelection}
 *   removes it in `defineTool` so `fields: []` takes the same path as an
 *   omitted `fields` for whichever tool was called.
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
