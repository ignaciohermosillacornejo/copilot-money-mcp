/**
 * MCP tool definitions for Copilot Money data.
 *
 * Exposes database functionality through the Model Context Protocol.
 */

import { CopilotDatabase, type DecodeHealth } from '../core/database.js';
import {
  BALANCE_HISTORY_GRANULARITIES,
  type TransactionTypeFilter,
  type CategoryView,
  type BalanceHistoryGranularity,
} from './constants.js';
// All tool schemas live in the registry (E1, #446); the factories below are
// pure projections of its ordered definition lists.
import { READ_TOOL_DEFS, WRITE_TOOL_DEFS } from './registry/index.js';
import { normalizeMerchantName } from '../utils/merchant.js';
import { resolveCategoryFilter } from './category-filter.js';
import { isCashSecurityType, tickerMatches } from '../utils/ticker.js';
import {
  DEFAULT_TRANSACTION_FIELDS,
  DEFAULT_INVESTMENT_PRICE_FIELDS,
  DEFAULT_RECURRING_CACHE_FIELDS,
  DEFAULT_ACCOUNT_FIELDS,
  CACHE_TRANSACTION_FIELD_ALIASES,
  applyFieldAliases,
  projectRows,
} from './field-selection.js';
import type { LiveCopilotDatabase } from '../core/live-database.js';
import type { SplitParentStore } from '../core/persistence/split-parent-store.js';
import type { SnapshotCache } from '../core/cache/snapshot-cache.js';
import type { GraphQLClient } from '../core/graphql/client.js';
import { GraphQLError } from '../core/graphql/client.js';
import {
  editTransaction,
  createTransaction as gqlCreateTransaction,
  deleteTransaction as gqlDeleteTransaction,
  addTransactionToRecurring as gqlAddTransactionToRecurring,
  splitTransaction as gqlSplitTransaction,
  bulkEditTransactions as gqlBulkEditTransactions,
  type BulkEditTransactionInput,
  type BulkEditTransactionsResult,
  type CreatedTransaction,
  type CreateTransactionInput,
  type EditTransactionInput,
  type TransactionType,
  TRANSACTION_TYPES,
  returnedTagIds,
} from '../core/graphql/transactions.js';
import {
  createCategory as gqlCreateCategory,
  editCategory as gqlEditCategory,
  deleteCategory as gqlDeleteCategory,
  type EditCategoryInput,
} from '../core/graphql/categories.js';
import { fetchCategories } from '../core/graphql/queries/categories.js';
import type { CategoryNode } from '../core/graphql/queries/categories.js';
import type { TagNode } from '../core/graphql/queries/tags.js';
import type { TransactionNode } from '../core/graphql/queries/transactions.js';
import {
  liveRowFromMutation,
  type EnrichedTransaction,
  type WriteRowField,
} from './live/transactions.js';
import type { RecurringNode } from '../core/graphql/queries/recurrings.js';
import {
  createTag as gqlCreateTag,
  editTag as gqlEditTag,
  deleteTag as gqlDeleteTag,
  type EditTagInput,
} from '../core/graphql/tags.js';
import { fetchTags } from '../core/graphql/queries/tags.js';
import { COLOR_NAMES, type ColorName } from '../core/graphql/colors.js';
import {
  createRecurring as gqlCreateRecurring,
  editRecurring as gqlEditRecurring,
  deleteRecurring as gqlDeleteRecurring,
  RECURRING_FREQUENCIES,
  RECURRING_STATE_VALUES,
  type RecurringFrequency,
  type RecurringStateValue,
} from '../core/graphql/recurrings.js';
import { setBudget as gqlSetBudget } from '../core/graphql/budgets.js';
import {
  graphQLErrorToMcpError,
  rejectRemovedArgs,
  REMOVED_ACCOUNT_ARGS,
  REMOVED_TRANSACTION_ARGS,
} from './errors.js';
import {
  isCalendarDate,
  isCalendarMonth,
  parsePeriod,
  // Read-filter dates: `YYYY-MM-DD` and a real calendar day, one message in
  // both modes (#825).
  validateDateArg as validateDate,
} from '../utils/date.js';
import {
  readScheduledSmokeStatus,
  type ScheduledSmokeStatus,
} from '../utils/scheduled-smoke-status.js';
import { computeTotalReturnPercent, roundAmount } from '../utils/round.js';
import { pLimit } from '../utils/concurrency.js';
import {
  getCategoryName,
  isTransferCategory,
  isKnownPlaidCategory,
  lookupKnownCategoryName,
} from '../utils/categories.js';
import {
  TRANSACTION_TYPE_RULES,
  cacheTypeRuleRow,
  type SharedTransactionType,
} from './transaction-type-rules.js';
import type {
  Transaction,
  Account,
  InvestmentPrice,
  Tag,
  Recurring,
  PriceType,
} from '../models/index.js';
import {
  getTransactionDisplayName,
  getRecurringDisplayName,
  formatSplitRatio,
  TransactionSchema,
  InvestmentPriceSchema,
  getLatestPricePoint,
  AccountSchema,
  isVisibleAccount,
  preferredAccountName,
} from '../models/index.js';
import type { GoalHistory } from '../models/goal-history.js';
import { isItemHealthy, itemNeedsAttention, getItemDisplayName } from '../models/item.js';
import { type Category, getCategoryDisplayName } from '../models/category.js';
import { redactUserPaths } from '../utils/redact-paths.js';

// ============================================
// Category Constants
// ============================================

// ============================================
// Date Helpers
// ============================================

/**
 * Returns the ISO 8601 week key (YYYY-Www) for a given YYYY-MM-DD date string.
 * Used for downsampling daily balance history to weekly granularity.
 */
function getISOWeekKey(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dayOfWeek = d.getUTCDay() || 7; // Mon=1, Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek); // Thursday of the week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// ============================================
// Shared Validation Helpers
// ============================================

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Validate that a document ID is a string of safe characters. The `string`
 * parameter type is not enough: MCP arguments arrive unvalidated and are
 * cast, and RegExp.test coerces, so 42 or null would pass as "42" / "null"
 * and reach the wire (#836 review).
 */
function validateDocId(id: string, label: string): void {
  // mutation-guard: a non-string id is never coerced into a valid one
  if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) {
    throw new Error(`Invalid ${label} format: ${String(id)}`);
  }
}

/**
 * Validate a `color_name` argument against the server's `ColorName` enum
 * (issue #439, same pattern as the RECURRING_FREQUENCIES guard) and narrow
 * it to the wire type. Rejecting locally gives a clear MCP error instead of
 * a server-side GRAPHQL_VALIDATION_FAILED round-trip.
 */
function validateColorName(value: string): ColorName {
  if (!(COLOR_NAMES as readonly string[]).includes(value)) {
    throw new Error(`color_name must be one of: ${COLOR_NAMES.join(', ')}. Got: ${value}`);
  }
  return value as ColorName;
}

/**
 * Plaid category ID for foreign transaction fees (snake_case format).
 * @see https://plaid.com/docs/api/products/transactions/#categoriesget
 */
const CATEGORY_FOREIGN_TX_FEE_SNAKE = 'bank_fees_foreign_transaction_fees';

/**
 * Plaid category ID for foreign transaction fees (numeric legacy format).
 * Format: 10005000 where 10 = Bank Fees, 005 = Foreign Transaction
 * @see https://plaid.com/docs/api/products/transactions/#categoriesget
 */
const CATEGORY_FOREIGN_TX_FEE_NUMERIC = '10005000';

// ============================================
// Validation Constants
// ============================================

/** Maximum allowed limit for transaction queries */
const MAX_QUERY_LIMIT = 10000;

/** Default limit for transaction queries */
const DEFAULT_QUERY_LIMIT = 100;

/** Minimum allowed limit */
const MIN_QUERY_LIMIT = 1;

/**
 * Valid field names for investment-price rows: the document's own fields plus
 * the two derived by getInvestmentPrices. Without the derived names here, a
 * caller asking for `latest_price` would be told it does not exist.
 */
const INVESTMENT_PRICE_KNOWN_FIELDS: ReadonlySet<string> = new Set([
  ...Object.keys(InvestmentPriceSchema.shape),
  'latest_price',
  'latest_at',
]);

/**
 * Decoded transaction fields that exist for this server's own use and are never
 * returned to a caller. `income` (#825) is derived from the document `type` so
 * the shared transaction_type rules can tell an INCOME row apart in cache mode;
 * live rows carry the same fact as `type`, which the cache row does not have.
 * Surfacing `income` would add a cache-only field name, the cross-mode
 * divergence #843 removed, so it is stripped from every row and is not a
 * selectable name (#854 review).
 */
const INTERNAL_TRANSACTION_FIELDS: ReadonlySet<string> = new Set(['income']);

/**
 * Every selectable field name on a get_transactions row: the Transaction
 * document schema keys plus the two enrichment fields synthesized at read
 * time. Derived from the zod schema so model drift cannot desync this set.
 */
export const TRANSACTION_KNOWN_FIELDS: ReadonlySet<string> = new Set([
  ...Object.keys(TransactionSchema.shape).filter((k) => !INTERNAL_TRANSACTION_FIELDS.has(k)),
  'category_name',
  'normalized_merchant',
]);

/**
 * Every selectable field name on a get_accounts row: the Account document
 * schema keys, read off the zod shape at runtime. Derived rather than
 * hand-listed as a `{ [K in keyof Account]-?: true }` mapped type (the shape
 * the live-mode row types in src/tools/live/ use) because a derived set needs
 * no maintenance at all: it can neither forget a field nor misspell one, and a
 * schema rename propagates on its own. Same reasoning as
 * TRANSACTION_KNOWN_FIELDS above.
 *
 * The mapped type would also be weaker here — but not in the way an earlier
 * revision of this comment claimed. `AccountSchema` is `.passthrough()`
 * (src/models/account.ts), so `Account` carries an implicit string index
 * signature; under `--strict` that still rejects a typo
 * (`{ totally_bogus: true }` fails TS2740, every real key missing) and only
 * stops rejecting an EXTRA key — i.e. a stale entry for a field the schema no
 * longer has would typecheck.
 */
export const ACCOUNT_KNOWN_FIELDS: ReadonlySet<string> = new Set(Object.keys(AccountSchema.shape));

/**
 * One pattern-detected recurring merchant row, as built by
 * `getRecurringTransactions`'s pattern-analysis pass (#606). Named — rather
 * than left as the inline object literal repeated in that method's return
 * type and local variable declaration — so `RECURRING_CACHE_FIELD_NAMES`
 * below can derive the known-field set from the type itself via
 * `[K in keyof ...]-?: true`, the same self-maintaining trick as
 * CATEGORY_LIVE_FIELD_NAMES in src/tools/live/categories.ts: a forgotten or
 * renamed field is a compile error instead of a silent runtime desync.
 */
type DetectedRecurringRow = {
  merchant: string;
  normalized_merchant: string;
  occurrences: number;
  average_amount: number;
  total_amount: number;
  frequency: string;
  confidence: 'high' | 'medium' | 'low';
  confidence_reason: string;
  category_name?: string;
  last_date: string;
  next_expected_date?: string;
  transactions: Array<{ date: string; amount: number }>;
};

const RECURRING_CACHE_FIELD_NAMES: { [K in keyof DetectedRecurringRow]-?: true } = {
  merchant: true,
  normalized_merchant: true,
  occurrences: true,
  average_amount: true,
  total_amount: true,
  frequency: true,
  confidence: true,
  confidence_reason: true,
  category_name: true,
  last_date: true,
  next_expected_date: true,
  transactions: true,
};
export const RECURRING_CACHE_KNOWN_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(RECURRING_CACHE_FIELD_NAMES)
);

/**
 * Built FROM the known-field set rather than hand-listed — see the identical
 * reasoning on CATEGORY_LIVE_VALID_FIELDS_HINT in src/tools/live/categories.ts.
 */
const RECURRING_CACHE_VALID_FIELDS_HINT = `the pattern-detected recurring row fields (${[...RECURRING_CACHE_KNOWN_FIELDS].join(', ')})`;

/**
 * Project each transaction down to a `fields` allowlist. Applied after
 * category_name/normalized_merchant enrichment so both are selectable.
 * Delegates to the shared field-selection engine
 * (src/tools/field-selection.ts), which also reports requested names that
 * match nothing — surfaced to callers as `_field_warning`.
 *
 * The caller decides what an omitted `fields` means; since #604 both call
 * sites in getTransactions pass `options.fields ?? ['default']`, so a
 * dispatched call with no `fields` gets the terse preset.
 */
function projectTransactionFields<T extends Record<string, unknown>>(
  txns: T[],
  fields: string[] | undefined
): { rows: T[]; warning?: string } {
  return projectRows(txns, applyFieldAliases(fields, CACHE_TRANSACTION_FIELD_ALIASES), {
    preset: DEFAULT_TRANSACTION_FIELDS,
    knownFields: TRANSACTION_KNOWN_FIELDS,
    validFieldsHint:
      'the transaction document fields plus the enrichment fields category_name and normalized_merchant',
  });
}

// ============================================
// Tool Value-Set Constants
// ============================================
// Moved to ./constants.ts (a leaf module) so the tool registry can share
// them without a runtime import cycle. Re-exported here for compatibility.

export {
  TRANSACTION_TYPE_FILTERS,
  CATEGORY_VIEWS,
  BALANCE_HISTORY_GRANULARITIES,
  type TransactionTypeFilter,
  type CategoryView,
  type BalanceHistoryGranularity,
} from './constants.js';

// ============================================
// Amount Validation Constants
// ============================================

/**
 * Threshold for large transactions worth noting (but still normal).
 * $10,000 is a common threshold for personal finance.
 */
export const LARGE_TRANSACTION_THRESHOLD = 10_000;

/**
 * Threshold for extremely large transactions that should be flagged for review.
 * $100,000 is unusual for typical personal finance transactions.
 */
export const EXTREMELY_LARGE_THRESHOLD = 100_000;

/**
 * Threshold for unrealistic amounts that are likely data quality issues.
 * $1,000,000 is almost certainly an error in personal finance data.
 */
export const UNREALISTIC_AMOUNT_THRESHOLD = 1_000_000;

/**
 * Maximum valid transaction amount (matches TransactionSchema validation).
 * Amounts above this are rejected at the schema level.
 */
export const MAX_VALID_AMOUNT = 10_000_000;

// ============================================
// Validation Helpers
// ============================================

/**
 * Validates and constrains a limit parameter within allowed bounds.
 *
 * @param limit - The requested limit
 * @param defaultValue - Default value if limit is undefined
 * @returns Validated limit within MIN_QUERY_LIMIT and MAX_QUERY_LIMIT
 */
function validateLimit(
  limit: number | undefined,
  defaultValue: number = DEFAULT_QUERY_LIMIT
): number {
  if (limit === undefined) return defaultValue;
  return Math.max(MIN_QUERY_LIMIT, Math.min(MAX_QUERY_LIMIT, Math.floor(limit)));
}

/**
 * An amount in an error message without float noise (#825): `100.00999999999999`
 * reads as 100.01. Rounded to six places rather than to cents, so a sub-cent
 * difference that still fails a check is not printed as 0.00.
 */
function formatAmountForMessage(n: number): string {
  return String(Number(n.toFixed(6)));
}

/**
 * Validate a date a WRITE sends to Copilot (#825): `YYYY-MM-DD` and a day that
 * exists. A well-formed impossible date (`2026-02-30`) otherwise reaches the
 * server, whose 400 is reported as possible API drift. `formatMessage` keeps
 * each tool's existing wording for a malformed string; only the impossible
 * date gets the new message. Read filters use validateDate, which applies
 * the same calendar check.
 */
function validateWriteDate(date: string, label: string, formatMessage: string): void {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(formatMessage);
  }
  if (!isCalendarDate(date)) {
    throw new Error(`${label}: ${date} is not a real calendar date`);
  }
}

/**
 * Validates that a month string matches YYYY-MM format.
 *
 * @param month - The month string to validate
 * @param paramName - Parameter name for error messages
 * @throws Error if month format is invalid
 */
function validateMonth(month: string | undefined, paramName: string): void {
  if (month === undefined) return;
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`Invalid ${paramName}: "${month}". Expected format: YYYY-MM`);
  }
  if (!isCalendarMonth(month)) {
    throw new Error(`Invalid ${paramName}: ${month} is not a real month (01-12)`);
  }
}

/**
 * Validates offset parameter for pagination.
 *
 * @param offset - The requested offset
 * @returns Validated offset (non-negative integer)
 */
function validateOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  return Math.max(0, Math.floor(offset));
}

// ============================================
// Common Helpers
// ============================================

/**
 * Default category ID for uncategorized transactions.
 */
const DEFAULT_CATEGORY_ID = 'uncategorized';

/**
 * Gets the category ID or returns the default 'uncategorized'.
 *
 * @param categoryId - The category ID (may be null or undefined)
 * @returns The category ID or 'uncategorized'
 */
function getCategoryIdOrDefault(categoryId: string | null | undefined): string {
  return categoryId || DEFAULT_CATEGORY_ID;
}

export { normalizeMerchantName };

/**
 * A single investment holding enriched with security metadata and computed returns.
 */
export interface HoldingEntry {
  security_id: string;
  ticker_symbol?: string;
  name?: string;
  type?: string;
  account_id: string;
  account_name?: string;
  quantity: number;
  institution_price: number;
  institution_value: number;
  cost_basis?: number;
  average_cost?: number;
  total_return?: number;
  total_return_percent?: number;
  is_cash_equivalent?: boolean;
  iso_currency_code?: string;
  history?: Array<{
    month: string;
    snapshots: Record<string, { price?: number; quantity?: number }>;
  }>;
}

/**
 * Ceiling on targets per bulk_edit_transactions call.
 *
 * Unlike a client-side fan-out, the whole batch is ONE server request, so this
 * bounds the size of the request body and the blast radius of a mistaken call
 * rather than any concurrency. Copilot's own web UI has no documented cap;
 * this is ours, chosen to keep a misfire recoverable by hand.
 */
const MAX_BULK_EDIT_TARGETS = 500;

/**
 * Drop split-transaction parents from a list. Each split parent's amount
 * equals the sum of its children's amounts, so any aggregation (category
 * totals, merchant grouping, recurring detection) double-counts if parents
 * are included alongside their children. Copilot hides parents in its own
 * UI for the same reason.
 */
function filterSplitParents<T extends { children_transaction_ids?: string[] }>(txns: T[]): T[] {
  return txns.filter((t) => !t.children_transaction_ids || t.children_transaction_ids.length === 0);
}

/**
 * One transaction edit — the payload shape shared by `update_transaction`
 * (exactly one) and `update_transactions` (an array of them). Both tools run
 * the same validation, the same field→GraphQL mapping, and the same optimistic
 * cache patch; the only difference is arity. Keep them that way: a field that
 * lands on one tool and not the other is the drift this shared type exists to
 * prevent.
 */
// A `type` alias, not an `interface`: TS only synthesizes an implicit index
// signature for the former, and the registry's dispatch layer casts from
// `Record<string, unknown>`. An interface here fails that cast.
export type TransactionEdit = {
  transaction_id: string;
  account_id?: string;
  item_id?: string;
  name?: string;
  category_id?: string;
  note?: string;
  tag_ids?: string[];
  type?: TransactionType;
  reviewed?: boolean;
  date?: string;
  amount?: number;
};

/**
 * Ceiling on writes in flight at once, shared by every bulk write path.
 *
 * Deliberately low: Copilot's API drops offline under sustained load (a
 * sustained unthrottled cleanup run logs timeouts by the dozen), so a wider fan-out
 * buys a failed batch, not a faster one. The win from bulk tools is agent
 * turns, not wall-clock — 200 edits at 5-wide is still ONE tool call. Do not
 * raise without evidence from a live run.
 */
const BULK_WRITE_CONCURRENCY = 5;

/**
 * Ceiling on edits per update_transactions call.
 *
 * Bounds three things at once: how long one MCP call can block, how large the
 * response can get, and the blast radius of a mistaken batch. At 5-wide and
 * ~2 writes/sec observed, a full batch runs ~100s. Callers with more work
 * chunk it — a thousand edits becomes five calls instead of a thousand.
 */
const MAX_BULK_EDITS = 200;

/** Fields of a TransactionEdit that actually change the transaction. */
const EDIT_MUTABLE_KEYS = [
  'name',
  'category_id',
  'note',
  'tag_ids',
  'type',
  'reviewed',
  'date',
  'amount',
] as const;

/**
 * Edit fields whose effect on a SPLIT PARENT is unverified (#836): they can
 * move the account balance, and the parent's amount is already replaced by its
 * children's, so the balance might move twice. Refused on a known split parent;
 * name, category, note, tags and reviewed stay editable.
 */
const SPLIT_PARENT_REFUSED_EDIT_KEYS = ['amount', 'date', 'type'] as const;

/** The SPLIT_PARENT_REFUSED_EDIT_KEYS an edit sets. */
function splitParentRefusedKeys(
  edit: TransactionEdit
): Array<(typeof SPLIT_PARENT_REFUSED_EDIT_KEYS)[number]> {
  return SPLIT_PARENT_REFUSED_EDIT_KEYS.filter((k) => edit[k] !== undefined);
}

/**
 * Every accepted key. The routing ids (account_id/item_id) address the write —
 * they are not edits, which is why they sit outside EDIT_MUTABLE_KEYS.
 */
const EDIT_ALLOWED_KEYS: ReadonlySet<string> = new Set<string>([
  'transaction_id',
  'account_id',
  'item_id',
  ...EDIT_MUTABLE_KEYS,
]);

/** GraphQL EditTransactionInput field name → the MCP name we report back. */
const EDIT_GRAPHQL_TO_API_NAME: Record<string, string> = {
  name: 'name',
  categoryId: 'category_id',
  userNotes: 'note',
  tagIds: 'tag_ids',
  isReviewed: 'reviewed',
  type: 'type',
  date: 'date',
  amount: 'amount',
};

/**
 * Reject unknown fields (equivalent to JSON Schema additionalProperties:
 * false, but re-checked here as defense in depth in case a method is called
 * directly without going through the MCP dispatch layer).
 */
function rejectUnknownEditKeys(edit: object, label: string): void {
  for (const key of Object.keys(edit)) {
    if (!EDIT_ALLOWED_KEYS.has(key)) {
      throw new Error(`${label}: unknown field "${key}"`);
    }
  }
}

/** Mutable fields the caller actually set (present and not undefined). */
function mutableEditKeys(edit: TransactionEdit): string[] {
  return EDIT_MUTABLE_KEYS.filter((k) => edit[k] !== undefined);
}

/**
 * A local cache patch: never the split fields, which CopilotMoneyTools'
 * split-evidence index (#836) assumes no patch rewrites in place. Typed so a
 * builder that tried would not compile. Not `Omit<Transaction, ...>`: the
 * model is a passthrough schema with an index signature, and Omit over one
 * keeps only the index signature, so every key (the split fields included)
 * would type as `unknown` and still be assignable.
 */
type LocalTransactionPatch = Partial<Transaction> & {
  parent_transaction_id?: never;
  children_transaction_ids?: never;
};

/**
 * Map MCP fields → EditTransaction input shape. Keyed by presence so an
 * explicit `note: ""` clears the note and `tag_ids: []` clears all tags.
 */
function buildEditInput(edit: TransactionEdit): EditTransactionInput {
  const input: EditTransactionInput = {};
  if ('name' in edit && edit.name !== undefined) input.name = edit.name.trim();
  if ('category_id' in edit && edit.category_id !== undefined) input.categoryId = edit.category_id;
  if ('note' in edit && edit.note !== undefined) input.userNotes = edit.note;
  if ('tag_ids' in edit && edit.tag_ids !== undefined) input.tagIds = edit.tag_ids;
  if ('type' in edit && edit.type !== undefined) input.type = edit.type;
  if ('reviewed' in edit && edit.reviewed !== undefined) input.isReviewed = edit.reviewed;
  if ('date' in edit && edit.date !== undefined) input.date = edit.date;
  if ('amount' in edit && edit.amount !== undefined) input.amount = edit.amount;
  return input;
}

/**
 * The cache-model fields the decoder derives from Copilot's `type`: the two
 * booleans `internal_transfer` and `income` (#864 review). Patched together so
 * a retype clears the old flag as well as setting the new one.
 */
function typeFlagsPatch(type: TransactionType): Pick<Transaction, 'internal_transfer' | 'income'> {
  return { internal_transfer: type === 'INTERNAL_TRANSFER', income: type === 'INCOME' };
}

/**
 * `type` when it is one of Copilot's known TransactionType values, else
 * undefined. Response validation is warn-only, so a drifted spelling must not
 * be trusted over the request (it would clear both flags).
 */
function knownTransactionType(type: unknown): TransactionType | undefined {
  return typeof type === 'string' && (TRANSACTION_TYPES as readonly string[]).includes(type)
    ? (type as TransactionType)
    : undefined;
}

/**
 * A transaction row as a write tool returns it (create_transaction,
 * add_transaction_to_recurring, split_transaction). `--write` implies
 * `--live-reads`, so a write caller reads rows from get_transactions_live, and
 * a write row is a subset of that row: the same field names (`user_notes`,
 * not the cache model's `user_note`; no cache-only `is_manual`) and the same
 * value spellings (`null` for no category, note or recurring), #825. The type
 * is a Pick of {@link EnrichedTransaction}, so a key or value type that is not
 * the live row's does not compile. The runtime detector is
 * tests/tools/live-write-coherence.test.ts ("write responses use live row
 * field names").
 */
export type WriteTransactionRow = Pick<EnrichedTransaction, WriteRowField> &
  Partial<Pick<EnrichedTransaction, 'tag_ids' | 'parent_transaction_id'>>;

/**
 * Map a mutation's TransactionFields shape to a {@link WriteTransactionRow}.
 * The one mapper every write tool that returns a row uses: every field but
 * `tag_ids` goes through get_transactions_live's own mappers
 * (`liveRowFromMutation`). `tag_ids` is the returned tags, or
 * `fallbackTagIds` when the response carries no usable tags array
 * (create_transaction passes the requested list, the best guess a create has;
 * a link or a split asked for no tags, so they pass nothing and the key is
 * absent). `parentId` is passed for a split child only, which then carries
 * `parent_transaction_id`.
 */
function toWriteTransactionRow(
  tx: CreatedTransaction,
  fallbackTagIds?: string[],
  parentId?: string
): WriteTransactionRow {
  const row: WriteTransactionRow = liveRowFromMutation(tx, parentId);
  const tagIds = returnedTagIds(tx.tags) ?? fallbackTagIds;
  if (tagIds !== undefined) row.tag_ids = tagIds;
  return row;
}

/**
 * The server's word for the category a write left on a row, when a field the
 * write touched can change it (category_id, or a type change, which clears it
 * for INCOME/INTERNAL_TRANSFER): the returned `categoryId` when it is a string
 * (`''` is Copilot's "no category"), else the request-derived fallback.
 */
function serverCategory(
  server: { categoryId?: unknown } | undefined,
  fallback: string | undefined
): string | undefined {
  return typeof server?.categoryId === 'string' ? server.categoryId : fallback;
}

/**
 * Build the optimistic cache patch for one applied edit: writes to the
 * in-memory cache so a subsequent read returns the new value without needing
 * refresh_database + re-decode.
 *
 * `server` is the row the server returned, and is required so a call site
 * cannot silently fall back to the request (#864 review). When the edit set
 * tags, the list follows that row; when it set a type or a category, both
 * follow it:
 *  - the type's two local counterparts, `internal_transfer` and `income`
 *    (the decoder derives them from Copilot's type; the model's
 *    `transaction_type` is Plaid's), via typeFlagsPatch, from the returned
 *    type when it is a known value, else the requested one;
 *  - the category, from the returned `categoryId` when it is a string
 *    (serverCategory), else the request-derived value, which includes the
 *    INCOME/INTERNAL_TRANSFER clear (verified live).
 */
export function buildEditCachePatch(
  edit: TransactionEdit,
  server: { type?: unknown; categoryId?: unknown; tags?: unknown }
): LocalTransactionPatch {
  const patch: LocalTransactionPatch = {};
  if ('name' in edit && edit.name !== undefined) patch.name = edit.name.trim();
  if ('category_id' in edit && edit.category_id !== undefined) patch.category_id = edit.category_id;
  if ('note' in edit && edit.note !== undefined) patch.user_note = edit.note;
  if ('tag_ids' in edit && edit.tag_ids !== undefined) {
    // The server's list, like bulk edit's (#864 review); the request's only
    // when the response carries no tags array.
    patch.tag_ids = returnedTagIds(server.tags) ?? edit.tag_ids;
  }
  if ('reviewed' in edit && edit.reviewed !== undefined) patch.user_reviewed = edit.reviewed;
  if ('date' in edit && edit.date !== undefined) patch.date = edit.date;
  if ('amount' in edit && edit.amount !== undefined) patch.amount = edit.amount;
  if (edit.type === 'INCOME' || edit.type === 'INTERNAL_TRANSFER') {
    patch.category_id = '';
  }
  // Category and type both follow the server's returned row when it carries
  // them (#864 review): one provenance for the whole patch. This deliberately
  // prefers the response over the verified INCOME/INTERNAL_TRANSFER clear: if
  // a response ever kept the category on such a row, the local cache agrees
  // with the live cache (which stores that same row) rather than with the
  // inference.
  if (edit.category_id !== undefined || edit.type !== undefined) {
    const category = serverCategory(server, patch.category_id);
    if (category !== undefined) patch.category_id = category;
  }
  // The local model's counterparts of Copilot's type (internal_transfer,
  // income): the decoder derives them from it and get_transactions' type
  // filters read them (#864 review).
  if (edit.type !== undefined) {
    Object.assign(patch, typeFlagsPatch(knownTransactionType(server.type) ?? edit.type));
  }
  return patch;
}

/**
 * The local cache patch for one row a bulk edit landed: the request's fields
 * the local model mirrors, with category, the type-derived flags and the tag
 * list taken from the row the SERVER returned (add/remove is applied by the
 * server, not recomputed here). Exported so a test can pin that neither
 * patch builder ever writes a split field (#836 index).
 */
export function buildBulkEditCachePatch(
  edit: {
    category_id?: string;
    reviewed?: boolean;
    type?: TransactionType;
    add_tag_ids?: string[];
    remove_tag_ids?: string[];
  },
  tx: { type?: unknown; categoryId?: unknown; tags?: unknown }
): LocalTransactionPatch {
  const patch: LocalTransactionPatch = {};
  if (edit.category_id !== undefined) patch.category_id = edit.category_id;
  if (edit.reviewed !== undefined) patch.user_reviewed = edit.reviewed;
  if (edit.type === 'INCOME' || edit.type === 'INTERNAL_TRANSFER') patch.category_id = '';
  // Category and the type-derived flags from the server's row (#864 review).
  if (edit.category_id !== undefined || edit.type !== undefined) {
    const category = serverCategory(tx, patch.category_id);
    if (category !== undefined) patch.category_id = category;
  }
  if (edit.type !== undefined) {
    Object.assign(patch, typeFlagsPatch(knownTransactionType(tx.type) ?? edit.type));
  }
  if (edit.add_tag_ids !== undefined || edit.remove_tag_ids !== undefined) {
    // No tags array (drift): leave the cached list alone.
    const tags = returnedTagIds(tx.tags);
    if (tags !== undefined) patch.tag_ids = tags;
  }
  return patch;
}

/**
 * Collection of MCP tools for querying Copilot Money data.
 */
export class CopilotMoneyTools {
  private db: CopilotDatabase;
  private graphqlClient: GraphQLClient | null;
  private liveDb: LiveCopilotDatabase | undefined;
  private _userCategoryMap: Map<string, string> | null = null;
  private _excludedCategoryIds: Set<string> | null = null;
  /**
   * Split-parent ids this server has learned about (#822): every parent
   * split_transaction split, and the parent of every split child
   * delete_transaction was asked to delete (recorded before the delete is
   * sent). The second source is what still knows a parent after both of its
   * children are gone, when no cached row points at it any more.
   *
   * Never retired (#842). Once all of its children are deleted, Copilot
   * returns the ex-parent as an ordinary row (ledger:
   * Transaction.parentId:childlessParentReappears), and deleting it still
   * credits its amount back a second time — so no row the server returns can
   * show that the id has become safe to delete.
   *
   * Mirrored to `splitParentStore` when one is configured (the server always
   * configures one), so a restart does not forget a parent split through this
   * server. The local cache's soft-deleted children cover splits made
   * elsewhere — see splitParentEvidence().
   */
  private readonly knownSplitParents = new Set<string>();
  private readonly splitParentStore: SplitParentStore | null;

  /** Record a split parent (#822); see knownSplitParents. */
  private recordSplitParent(id: string): void {
    this.knownSplitParents.add(id);
    this.splitParentStore?.record(id);
  }

  /**
   * Drop the in-memory split record on a mid-session login change (#852
   * review), so it tells the same story as the uid-scoped persisted record:
   * the new login's file is what `splitParentStore` reads from then on.
   * Called from the server's uid-transition sweep.
   */
  forgetSessionSplitParents(): void {
    this.knownSplitParents.clear();
    // The local cache's accumulated evidence is the previous login's too.
    this.db.forgetSplitParentIds();
    // So is a memoized window (#838).
    this.windowMemo = null;
  }

  /**
   * After a transaction mutation THREW (#832). A transport error or timeout can
   * follow a write the server already applied, and the error says nothing about
   * whether it did. So the live months holding `ids` (and any `months` named
   * outright, for a row the cache cannot find by id) are dropped, and the next
   * read asks the server instead of serving the pre-write row from the cold
   * tier for up to a week. The snapshots in
   * LiveCopilotDatabase.TRANSACTION_DERIVED_SNAPSHOTS go too, since the write
   * may have moved what they hold. A GraphQL validation error cannot have written
   * anything, so there this costs one refetch for nothing; the catch cannot
   * tell the two apart without guessing, so it accepts the cost.
   */
  private invalidateAfterFailedWrite(ids: readonly string[], months: readonly string[] = []): void {
    try {
      // mutation-guard: a failed transaction write drops its live months
      this.liveDb?.invalidateLiveTransactionMonths(ids);
      if (months.length > 0) this.liveDb?.invalidateLiveMonthKeys(months);
      this.liveDb?.invalidateTransactionDerivedSnapshots();
    } catch (e) {
      // Never let cache housekeeping mask the write's own error, which the
      // caller rethrows next and is the one that matters; but leave a trace,
      // since a failure here is the stale-cache bug this exists to prevent.
      console.error(
        `[copilot-money-mcp] live-cache invalidation after a failed write threw: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }

  /**
   * After a category / tag / recurring / budget write THREW in a way that may
   * have applied it (#887 review): `writeMayHaveApplied`, which every
   * `writeApplied` error (an error-free response with an unusable payload,
   * ledger Mutation.*:null-payload-means-applied) also carries. Those tools
   * patch their live snapshot only on success, so without this a write that
   * probably landed stays invisible until the snapshot's TTL. Dropping it makes
   * the next read ask the server, which is harmless if the write did not land.
   */
  private afterPossiblyAppliedEntityWrite(
    e: unknown,
    scope: 'categories' | 'tags' | 'recurring'
  ): void {
    if (!(e instanceof GraphQLError) || !e.writeMayHaveApplied || !this.liveDb) return;
    const live = this.liveDb;
    // A Record, so a new scope is a type error here rather than a silent miss.
    const drop: Record<typeof scope, () => void> = {
      categories: () => live.getCategoriesCache().invalidate(),
      tags: () => live.getTagsCache().invalidate(),
      recurring: () => {
        live.getRecurringCache().invalidate();
        live.getUpcomingRecurringsCache().invalidate();
      },
    };
    drop[scope]();
  }

  /**
   * After a transaction write the server ACCEPTED: drop the live snapshots it
   * can have made stale (LiveCopilotDatabase.TRANSACTION_DERIVED_SNAPSHOTS;
   * #825). The window cache is handled by each write's own write-through.
   */
  private afterTransactionWrite(): void {
    this.liveDb?.invalidateTransactionDerivedSnapshots();
  }

  /** YYYY-MM of `date` when it is a string long enough to have one. */
  private static monthOf(date: string | undefined): string[] {
    return date !== undefined && date.length >= 7 ? [date.slice(0, 7)] : [];
  }

  /** Whether this server has recorded `id` as a split parent (#822, #842). */
  private isRecordedSplitParent(id: string): boolean {
    // mutation-guard: split-parent records survive a restart
    return this.knownSplitParents.has(id) || (this.splitParentStore?.has(id) ?? false);
  }

  /**
   * Refuse an edit of amount, date or type on a known split parent (#836).
   * Copilot's effect there is unverified: the children already replaced the
   * parent's amount on the account, so a change to the parent could move the
   * balance a second time. The evidence is splitParentEvidence's, so the same
   * sources that make delete_transaction refuse a parent apply. Edits that set
   * none of those fields are not checked and cost nothing. `loadWindow` lets a
   * batch share one window load.
   */
  private async refuseSplitParentBalanceEdit(
    edit: TransactionEdit,
    label: string,
    loadWindow?: () => Promise<readonly TransactionNode[]>
  ): Promise<void> {
    const keys = splitParentRefusedKeys(edit);
    if (keys.length === 0) return;
    const evidence = await this.splitParentEvidence(edit.transaction_id, loadWindow);
    // mutation-guard: a split parent's amount, date and type are not edited
    if (evidence.isParent) {
      throw new Error(
        `${label}: transaction ${edit.transaction_id} is a split parent, and changing its ` +
          `${keys.join(', ')} is refused. What Copilot does to the account balance when a ` +
          `split parent's amount, date or type changes is unverified, and it could move the ` +
          `balance twice: once for the parent and again through its children. Edit the child ` +
          `transactions instead. The parent's name, category, note, tags and reviewed state ` +
          `can still be changed.`
      );
    }
    CopilotMoneyTools.refuseUncheckedSplitTarget(evidence, edit.transaction_id, label);
  }

  /**
   * For the writes refused on a split target (#836), unlike delete: when the
   * window fetch failed, the id cannot be shown not to be a split parent, and
   * the write is refused rather than sent. Delete proceeds on what the caches
   * hold instead (refusing would make it unusable offline); these writes have
   * no such history to keep, and a failed fetch usually means the write itself
   * would fail too.
   */
  private static refuseUncheckedSplitTarget(
    evidence: { windowChecked?: boolean },
    id: string,
    label: string
  ): void {
    // mutation-guard: an unchecked split target is not written
    if (evidence.windowChecked === false) {
      throw new Error(
        `${label}: could not check whether transaction ${id} is a split transaction (the ` +
          `live transaction window failed to load). This write's effect on a split is ` +
          `unverified and could move the balance twice, so nothing was sent. Retry; if the ` +
          `load keeps failing, run refresh_cache, or lower COPILOT_WRITE_RESOLVE_WINDOW_MONTHS ` +
          `to shrink it.`
      );
    }
  }

  /**
   * One write-resolve window load shared by every caller of the returned
   * function (#836): a batch that checks many ids, or a split that both checks
   * its target and resolves it. A failed load rejects every caller alike.
   */
  private sharedWindowLoad(): () => Promise<readonly TransactionNode[]> {
    let pending: Promise<readonly TransactionNode[]> | null = null;
    return () => {
      pending ??= this.loadWriteResolveWindow();
      return pending;
    };
  }

  /**
   * How long one write-resolve window load is reused (#838). A cleanup loop
   * deleting N rows used to pay N window loads, because the window cache's
   * live tier (the recent months) has a TTL of 0. Long enough to cover a burst
   * of writes from one agent turn, short enough that a split made elsewhere
   * shows up on the next call after it.
   */
  static readonly WINDOW_MEMO_MS = 15_000;
  private windowMemo: {
    at: number;
    stamp: string;
    /** Never replaced: the failed-load eviction keys on its identity. */
    rows: Promise<readonly TransactionNode[]>;
    /** Ids this server removed from the live cache since the load; filtered at read. */
    removed: Set<string>;
  } | null = null;

  /**
   * The one way a write removes a row from the live window cache: it also
   * keeps the memoized window (#838) from serving that row, so the invariant
   * "the memo never serves a row this server removed" holds at every removal
   * site rather than by a different reason at each. A test fails any direct
   * patchLiveTransactionDelete call elsewhere in src. Convention one level
   * down: the window cache's own delete() is public too, and nothing gates a
   * write path reaching it directly.
   */
  private evictLiveTransaction(id: string): void {
    this.liveDb?.patchLiveTransactionDelete(id);
    this.windowMemo?.removed.add(id);
  }

  /**
   * Changes whenever something happens that could change what the window
   * holds, so a memoized window is never reused across it:
   *  - a write this server issues, counted by the GraphQL client (failed ones
   *    included), except DeleteTransaction: a delete only removes a row, and
   *    with no negative split evidence (#842) a removed row cannot turn a
   *    refusal into an acceptance, so a burst of deletes can share one load;
   *  - any invalidation of the live window cache (its generation): refresh_cache,
   *    the mid-session login-change sweep, a failed write's month drop.
   * null without a counting client or a window cache (test doubles): no memo.
   */
  private writeStamp(): string | null {
    const client = this.graphqlClient as Partial<Pick<GraphQLClient, 'getMutationCount'>> | null;
    if (typeof client?.getMutationCount !== 'function') return null;
    // Test doubles without a window cache (or one without a generation) get
    // no memo either.
    if (typeof this.liveDb?.getTransactionsWindowCache !== 'function') return null;
    const windowCache = this.liveDb.getTransactionsWindowCache() as Partial<
      Pick<ReturnType<LiveCopilotDatabase['getTransactionsWindowCache']>, 'generationId'>
    >;
    if (typeof windowCache?.generationId !== 'function') return null;
    const writes = client.getMutationCount({ exclude: ['DeleteTransaction'] });
    return `${writes}:${windowCache.generationId()}`;
  }

  /**
   * The write-resolve window's rows ([] with no live layer). Rejects if the
   * fetch fails. Memoized for WINDOW_MEMO_MS across calls with no write in
   * between (#838), so a burst of deletes shares one load.
   *
   * Why the memo cannot weaken a split-parent refusal: every split evidence
   * source is positive (#842 — nothing retires a record or proves an id is
   * NOT a parent), and splitParentEvidence checks the live window cache and
   * the split record afresh on every call, so a split this server makes, or
   * any row a write or a read puts in the cache, is seen whatever the memo
   * holds. A row this server removes from the live cache is filtered out of
   * the memo too, at every removal site (evictLiveTransaction), so a later
   * lookup cannot resolve it from the memo (routing resolution can still,
   * from the append-only meta index). A sharedWindowLoad group keeps the
   * promise it first got, so a removal inside one group is not seen by later
   * calls in it; no group today removes a row before its last read. What
   * a memoized window CAN miss: a child row another client (the app, another
   * device) created in the last few seconds, in a month not otherwise cached
   * here. That is the same gap the window always had for a split made just
   * after the fetch, widened by at most WINDOW_MEMO_MS. The memo also serves
   * routing resolution and split's parent lookup, where the same gap means a
   * row another client created in the last few seconds can resolve as "not
   * found": an error, never a write to the wrong row.
   *
   * A memo hit counts as a checked window for refuseUncheckedSplitTarget:
   * the evidence held is at most WINDOW_MEMO_MS old, and the refusal exists
   * for a window that could not be read at all. If the network has dropped
   * since, the write itself fails loudly. The memo is replaced on the next
   * call after it expires, not on a timer, so a burst's rows stay held until
   * then (one window, bounded).
   */
  private loadWriteResolveWindow(): Promise<readonly TransactionNode[]> {
    const liveDb = this.liveDb;
    if (!liveDb) return Promise.resolve([]);
    const stamp = this.writeStamp();
    const now = Date.now();
    const memo = this.windowMemo;
    if (
      memo &&
      stamp !== null &&
      memo.stamp === stamp &&
      now - memo.at < CopilotMoneyTools.WINDOW_MEMO_MS
    ) {
      if (memo.removed.size === 0) return memo.rows;
      const removed = memo.removed;
      return memo.rows.then((rows) => rows.filter((r) => !removed.has(r.id)));
    }
    const { from, to } = CopilotMoneyTools.writeResolveWindow();
    const rows = liveDb.getTransactions({ from, to }).then((r) => r.rows);
    this.windowMemo = stamp === null ? null : { at: now, stamp, rows, removed: new Set() };
    // A failed load is not reused: the next call tries again.
    rows.catch(() => {
      if (this.windowMemo?.rows === rows) this.windowMemo = null;
    });
    return rows;
  }

  /**
   * Initialize tools with a database connection.
   *
   * @param database - CopilotDatabase instance
   * @param graphqlClient - Optional GraphQL client for write operations.
   * @param liveDb - Optional LiveCopilotDatabase for write-through to live cache.
   * @param options.splitParentStore - Optional persistent split-parent record
   *   (#842). Without one the record is in memory only; the server passes one
   *   under the user's home directory.
   */
  constructor(
    database: CopilotDatabase,
    graphqlClient?: GraphQLClient,
    liveDb?: LiveCopilotDatabase,
    options: { splitParentStore?: SplitParentStore } = {}
  ) {
    this.db = database;
    this.graphqlClient = graphqlClient ?? null;
    this.liveDb = liveDb;
    this.splitParentStore = options.splitParentStore ?? null;
  }

  /**
   * Return the GraphQL client, or throw if write mode is not enabled.
   */
  protected getGraphQLClient(): GraphQLClient {
    if (!this.graphqlClient) {
      throw new Error('Write tools require --write flag to be set');
    }
    return this.graphqlClient;
  }

  /**
   * Get the user-defined category name map.
   *
   * This map contains custom category names defined by the user in Copilot Money,
   * which take precedence over the standard Plaid category names.
   *
   * @returns Map from category_id to category name
   */
  private async getUserCategoryMap(): Promise<Map<string, string>> {
    if (this._userCategoryMap === null) {
      this._userCategoryMap = await this.db.getCategoryNameMap();
    }
    return this._userCategoryMap;
  }

  /**
   * Get the set of category IDs that are marked as excluded.
   *
   * Transactions in these categories should be excluded from spending calculations.
   *
   * @returns Set of excluded category IDs
   */
  private async getExcludedCategoryIds(): Promise<Set<string>> {
    if (this._excludedCategoryIds === null) {
      const userCategories = await this.db.getUserCategories();
      this._excludedCategoryIds = new Set(
        userCategories.filter((cat) => cat.excluded === true).map((cat) => cat.category_id)
      );
    }
    return this._excludedCategoryIds;
  }

  /**
   * Cache-mode side of the shared `category` filter (#845): the same
   * resolveCategoryFilter live mode uses, over the user's categories.
   *
   * CLAIM: a value no category has is accepted exactly when a row IN THE
   * WINDOW, MINUS THE TWO CLASSES LIVE NEVER RECEIVES, carries it: a
   * transaction in the queried date range, without the Plaid-deleted rows and
   * split parents that the call's own exclude_deleted / exclude_split_parents
   * flags drop. The other filters (exclude_transfers, transaction_type,
   * pending, tag, merchant, amount) are not applied to the corpus, in either
   * mode: live's corpus is the raw server window too. An orphaned id stays
   * reachable, and both modes accept and reject the same values.
   *
   * The corpus is read the way the rows it vouches for are read, so it is
   * never wider than them (`scope`):
   *   - 'query' (the filtered path): the main query's read — its date bounds,
   *     or none, and its 50k cap — but not its merchant/account/amount
   *     filters, which the database applies before the cap. With no date
   *     bounds (cache allows that; live does not) that is the whole cache up
   *     to the cap, and the error says "in the cache". So above 50k rows in
   *     range the corpus can be the narrower of the two (the query's 50k are
   *     taken from a pruned set that reaches further back), and an id carried
   *     only past the corpus's cap errors rather than returning rows: the loud
   *     direction, not the silent zero, and unreachable in practice.
   *   - 'whole-cache' (the transaction_id lookup): the lookup searches the
   *     whole cache uncapped, so the corpus does too, and an orphan id is
   *     judged against every row the lookup could find (#858 review round 7).
   * An earlier revision read the whole cache uncapped whenever no dates were
   * passed, on the filtered path too: wider than that path's capped query, so
   * an id carried only past the cap was accepted and returned nothing (#860
   * review).
   *
   * WHY, dated: the first version checked the whole cache, so an
   * out-of-window orphan id returned zero rows silently in cache mode and
   * threw in live mode; accepting any Plaid-taxonomy id was the same silent
   * zero. Live never receives Plaid-deleted rows or split parents, so a row
   * of either class counts here only when the caller asked for it with
   * exclude_deleted: false / exclude_split_parents: false — otherwise the id
   * was accepted and then returned nothing (#858 review rounds 1, 4 and 5).
   * The read is a second in-memory pass over the transactions, on the miss
   * path only.
   */
  private async resolveCacheCategoryFilter(
    category: string,
    startDate: string | undefined,
    endDate: string | undefined,
    keep: { excludeDeleted: boolean; excludeSplitParents: boolean },
    scope: 'query' | 'whole-cache'
  ): Promise<Set<string>> {
    const userCategories = await this.db.getUserCategories();
    const nodes = userCategories.map((c) => ({
      id: c.category_id,
      parentId: c.parent_category_id ?? null,
      name: c.name ?? null,
    }));
    // The read follows `scope`; the error's label follows what was searched:
    // the whole cache whenever no date range bounded it (#860 review).
    const unboundedByDate = startDate === undefined && endDate === undefined;
    const knownElsewhere =
      !nodes.some((n) => n.id === category) &&
      (scope === 'whole-cache'
        ? await this.db.getAllTransactions()
        : await this.db.getTransactions({ startDate, endDate, limit: 50000 })
      ).some(
        (t) =>
          t.category_id === category &&
          !(keep.excludeDeleted && t.plaid_deleted) &&
          !(keep.excludeSplitParents && t.children_transaction_ids?.length)
      );
    return resolveCategoryFilter(category, nodes, {
      listTool: 'get_categories',
      knownElsewhere,
      ...(scope === 'whole-cache' || unboundedByDate ? { corpus: 'in the cache' } : {}),
    });
  }

  /**
   * Apply the derived fields every cache-mode transaction row carries.
   *
   * Both paths through getTransactions() run through here, and that is the
   * whole point of the function existing: `excluded` first shipped on the
   * windowed site only, so the same row answered differently depending on
   * whether the caller passed `transaction_id` or a date window. One site
   * means the next derived field cannot land on half the tool.
   *
   * Runs BEFORE projection — projecting first drops the source keys and
   * leaves nothing to derive from.
   *
   * @param transactions - Raw cache documents
   * @returns The same rows MINUS the internal fields (INTERNAL_TRANSACTION_FIELDS:
   *   `income`), plus category_name, normalized_merchant, excluded,
   *   internal_transfer (defaulted to false, #825)
   */
  private async enrichCacheTransactions(transactions: Transaction[]): Promise<
    Array<
      Omit<Transaction, 'income'> & {
        category_name?: string;
        normalized_merchant: string;
        excluded: boolean;
        internal_transfer: boolean;
      }
    >
  > {
    const excludedCategoryIds = await this.getExcludedCategoryIds();
    return Promise.all(
      // `income` is internal — see INTERNAL_TRANSACTION_FIELDS. The Omit in the
      // return type makes surfacing it a compile error; the guard row makes it
      // a test failure.
      // mutation-guard: the internal income flag is never returned
      transactions.map(async ({ income: _internal, ...txn }) => ({
        ...txn,
        category_name: txn.category_id
          ? await this.resolveCategoryName(txn.category_id)
          : undefined,
        normalized_merchant: normalizeMerchantName(getTransactionDisplayName(txn)),
        // `excluded` answers "is this row excluded from spending?", which is
        // the question a caller doing spend math is asking — NOT "is the raw
        // per-transaction flag set?". Those differ, and shipping the raw flag
        // made the two modes contradict each other: measured 2026-09-11
        // against a real transaction in a user-excluded category, the Firestore
        // document carried `excluded: undefined` while live-mode synthesized
        // `true` from the same category. Copilot does not stamp the
        // per-transaction flag when a category is excluded, so the raw flag
        // alone is not the predicate anyone wants.
        //
        // This is the same union getTransactions' exclude_excluded filter
        // applies, so the field agrees with its own tool's filtering, and
        // matches the live surface for every row live can observe. The
        // residual gap is the per-transaction flag itself, which GraphQL
        // exposes nowhere. That half was unverified until the 2026-10-18 parity
        // run observed it on a real row (#848 item 5); the ledger entry is now
        // verified-once.
        excluded:
          txn.excluded === true ||
          (txn.category_id ? excludedCategoryIds.has(txn.category_id) : false),
        // Defaulted to false when the document has no flag (#825), so a default
        // row always carries it, as a live row does. Still the raw flag — see
        // the comment below for why it is not the exclude_transfers union.
        internal_transfer: txn.internal_transfer === true,
        // `internal_transfer` deliberately does NOT get the same treatment,
        // and the asymmetry is the point rather than an oversight. The rule is
        // "the field means the same thing in both modes", not "the field
        // matches its own filter":
        //   - `excluded` needed the union above, because the category half is
        //     exactly what live can compute, so the union is what makes the two
        //     modes agree.
        //   - `internal_transfer` is the raw document flag, because that
        //     already matches live's server-side `type === 'INTERNAL_TRANSFER'`
        //     classification — measured 508/508 on real data, zero divergence.
        // getTransactions' exclude_transfers filter is deliberately BROADER
        // than the field: isTransferCategory() also matches `credit_card` and
        // any id containing `transfer` or `payment`, because it is a spend
        // heuristic ("don't count this as spending"), not a claim about what
        // the transaction IS. Adopting that union here would let a row's
        // CATEGORY alone set the field, independently of how live typed the
        // row — trading a cross-mode divergence for an intra-mode one. That
        // is the mechanism, not an observation: measured 2026-09-11, 0 of 508
        // joined rows would flip either way, so nothing in the set exercised
        // it. The choice is currently unobservable and rests on the reasoning.
        //
        // Pinned by "a TRANSFER-CATEGORY row without the raw flag reports
        // internal_transfer falsy" in tests/tools/tools.test.ts — prose alone
        // let the next reader "fix the asymmetry" without failing anything.
      }))
    );
  }

  /**
   * Get category name with user-defined categories taking precedence.
   *
   * @param categoryId - The category ID to look up
   * @returns Human-readable category name
   */
  private async resolveCategoryName(categoryId: string | undefined): Promise<string> {
    if (!categoryId) return 'Unknown';
    return getCategoryName(categoryId, await this.getUserCategoryMap());
  }

  /**
   * Resolve account ID to account name.
   *
   * @param accountId - The account ID to look up
   * @returns Account name or undefined if not found
   */
  private async resolveAccountName(accountId: string): Promise<string | undefined> {
    // Deliberately UNFILTERED by isVisibleAccount: a transaction or recurring
    // item can reference a hidden or merged account, and the caller is asking
    // what that account is called, not whether to count it. Filtering here
    // would turn a resolvable name into `undefined`.
    const accounts = await this.db.getAccounts();
    const account = accounts.find((a) => a.account_id === accountId);
    // The NAME rule applies here even though the VISIBILITY rule does not: the
    // opt-out above is from isVisibleAccount only. A caller asking what an
    // account is called should get the same answer this tool's siblings give,
    // hidden or not — otherwise a renamed brokerage reads as two accounts
    // depending on which tool you asked (#663).
    return account && preferredAccountName(account);
  }

  /**
   * Resolve transaction IDs to transaction history for recurring items.
   *
   * @param transactionIds - Array of transaction IDs
   * @returns Array of transaction history entries sorted by date descending
   */
  private async resolveTransactionHistory(
    transactionIds?: string[]
  ): Promise<Array<{ transaction_id: string; date: string; amount: number; merchant: string }>> {
    if (!transactionIds?.length) return [];
    const transactions = await this.db.getTransactions({ limit: 50000 });
    return transactionIds
      .map((id) => transactions.find((t) => t.transaction_id === id))
      .filter((t): t is Transaction => t !== undefined)
      .map((t) => ({
        transaction_id: t.transaction_id,
        date: t.date,
        amount: t.amount,
        merchant: getTransactionDisplayName(t),
      }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 20); // Limit to recent 20
  }

  /**
   * Get transactions with optional filters.
   *
   * Enhanced to support multiple query modes:
   * - Default: Filter-based transaction retrieval
   * - transaction_id: Single transaction lookup
   * - query: Free-text search
   * - transaction_type: Special transaction types (foreign, refunds, credits, duplicates, hsa_eligible, tagged)
   * - Location-based: city, lat/lon with radius
   *
   * @param options - Filter options
   * @returns Object with transaction count and list of transactions
   */
  async getTransactions(options: {
    // Existing filters
    period?: string;
    start_date?: string;
    end_date?: string;
    category?: string;
    merchant?: string;
    account_id?: string;
    min_amount?: number;
    max_amount?: number;
    limit?: number;
    offset?: number;
    exclude_transfers?: boolean;
    exclude_deleted?: boolean;
    exclude_excluded?: boolean;
    exclude_split_parents?: boolean;
    pending?: boolean;
    region?: string;
    country?: string;
    // NEW: Single lookup
    transaction_id?: string;
    // NEW: Text search
    query?: string;
    // NEW: Special types
    transaction_type?: TransactionTypeFilter;
    // NEW: Tag filter
    tag?: string;
    // NEW: Location
    city?: string;
    lat?: number;
    lon?: number;
    radius_km?: number;
    // NEW: Field selection (issue: a real cache-mode transaction row runs ~30 fields wide)
    fields?: string[];
  }): Promise<{
    count: number;
    total_count: number;
    offset: number;
    has_more: boolean;
    // Partial since #604: rows are projected to DEFAULT_TRANSACTION_FIELDS
    // unless the caller asks for more, so every key outside that preset is
    // absent by default. Declaring the truth here is what stops the next
    // reader from assuming a full document is available off this method
    // (same call as getAccounts made in #597 Tier 2).
    transactions: Array<
      Partial<Transaction & { category_name?: string; normalized_merchant?: string }>
    >;
    // Additional fields for special types
    type_specific_data?: Record<string, unknown>;
    // Cache limitation warning
    _cache_warning?: string;
    // Requested `fields` names that matched nothing (typos), when any
    _field_warning?: string;
  }> {
    // v3: `compact` was retired in favor of `fields` (#604). Without this a
    // caller still passing it would silently get the terse default rows —
    // close to what compact: true meant, and the opposite of compact: false.
    // First statement, before the destructure, matching getAccounts below and
    // the live handler: a retired argument is refused before anything is read
    // off the options object.
    rejectRemovedArgs(options, REMOVED_TRANSACTION_ARGS);

    const {
      period,
      category,
      merchant,
      account_id,
      min_amount,
      max_amount,
      exclude_transfers = true,
      exclude_deleted = true,
      exclude_excluded = true,
      exclude_split_parents = true,
      pending,
      region,
      country,
      transaction_id,
      query,
      transaction_type,
      tag,
      city,
      lat,
      lon,
      radius_km = 10,
    } = options;

    // Validate inputs
    const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
    const validatedOffset = validateOffset(options.offset);
    let start_date = validateDate(options.start_date, 'start_date');
    let end_date = validateDate(options.end_date, 'end_date');

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // ============================================
    // MODE 1: Single transaction lookup by ID
    // ============================================
    if (transaction_id) {
      // A lookup by id ignores the filters, but an unknown `category` is still
      // an error, as the schema promises and as live mode does (#858 review):
      // otherwise {transaction_id, category: "Food"} silently ignored it.
      // Judged against the corpus this path actually searches — the whole
      // cache, deleted rows and split parents included, with no date bounds —
      // so the error says "in the cache", and an orphan id the looked-up row
      // carries is accepted even when the row is outside a passed period.
      if (category !== undefined) {
        await this.resolveCacheCategoryFilter(
          category,
          undefined,
          undefined,
          { excludeDeleted: false, excludeSplitParents: false },
          'whole-cache'
        );
      }
      const allTransactions = await this.db.getAllTransactions();
      const found = allTransactions.find((t) => t.transaction_id === transaction_id);
      if (!found) {
        return {
          count: 0,
          total_count: 0,
          offset: 0,
          has_more: false,
          transactions: [],
        };
      }
      const projected = projectTransactionFields(
        // Same derivation the windowed path uses — a single lookup of a
        // category-excluded row must not disagree with a windowed one.
        await this.enrichCacheTransactions([found]),
        // #604: omitting `fields` yields the terse preset, not the full
        // ~30-field document. `fields: ["all"]` restores it.
        options.fields ?? ['default']
      );
      return {
        count: 1,
        total_count: 1,
        offset: 0,
        has_more: false,
        transactions: projected.rows,
        ...(projected.warning && { _field_warning: projected.warning }),
      };
    }

    // Query transactions with higher limit for post-filtering
    const categoryIds =
      category !== undefined
        ? await this.resolveCacheCategoryFilter(
            category,
            start_date,
            end_date,
            {
              excludeDeleted: exclude_deleted,
              excludeSplitParents: exclude_split_parents,
            },
            'query'
          )
        : undefined;
    let transactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      categoryIds,
      merchant,
      accountId: account_id,
      minAmount: min_amount,
      maxAmount: max_amount,
      limit: 50000, // Get more for filtering
    });

    // ============================================
    // MODE 2: Free-text search (query parameter)
    // ============================================
    if (query) {
      const queryLower = query.toLowerCase();
      transactions = transactions.filter((txn) => {
        const name = getTransactionDisplayName(txn).toLowerCase();
        return name.includes(queryLower);
      });
    }

    // ============================================
    // MODE 4: Tag filter
    // ============================================
    if (tag) {
      const normalizedTag = (tag.startsWith('#') ? tag.substring(1) : tag).toLowerCase();
      // tag_ids holds opaque Firestore IDs; resolve name → IDs before filtering.
      const tags = await this.db.getTags();
      const matchingTagIds = new Set(
        tags
          .filter((t) => (t.name ?? t.tag_id).toLowerCase() === normalizedTag)
          .map((t) => t.tag_id)
      );
      transactions = transactions.filter((txn) =>
        txn.tag_ids?.some((id) => matchingTagIds.has(id))
      );
    }

    // ============================================
    // MODE 5: Location-based filtering
    // ============================================
    if (city || (lat !== undefined && lon !== undefined)) {
      transactions = this._filterByLocation(transactions, { city, lat, lon, radius_km });
    }

    // Filter out transfers if requested (check both category and internal_transfer flag)
    if (exclude_transfers) {
      transactions = transactions.filter(
        (txn) => !isTransferCategory(txn.category_id) && !txn.internal_transfer
      );
    }

    // Filter out deleted transactions (Plaid marks these for removal)
    if (exclude_deleted) {
      transactions = transactions.filter((txn) => !txn.plaid_deleted);
    }

    // Filter out user-excluded transactions — the same union
    // enrichCacheTransactions() derives the `excluded` FIELD from, which is
    // what makes the field agree with its own tool's filtering. The set is
    // memoized on the instance, so asking for it here and again during
    // enrichment costs one read.
    if (exclude_excluded) {
      const excludedCategoryIds = await this.getExcludedCategoryIds();
      transactions = transactions.filter(
        (txn) => !txn.excluded && !(txn.category_id && excludedCategoryIds.has(txn.category_id))
      );
    }

    // Filter out split parents. Copilot hides these from its own UI after a
    // split — the children carry the real categorized amounts. Keeping the
    // parent would double-count the same spend (parent.amount == sum of
    // children.amount).
    if (exclude_split_parents) {
      transactions = transactions.filter(
        (txn) => !txn.children_transaction_ids || txn.children_transaction_ids.length === 0
      );
    }

    // Filter by pending status if specified
    if (pending !== undefined) {
      transactions = transactions.filter((txn) => txn.pending === pending);
    }

    // Filter by region if specified
    if (region) {
      const regionLower = region.toLowerCase();
      transactions = transactions.filter(
        (txn) =>
          txn.region?.toLowerCase().includes(regionLower) ||
          txn.city?.toLowerCase().includes(regionLower)
      );
    }

    // Filter by country if specified
    if (country) {
      const countryLower = country.toLowerCase();
      transactions = transactions.filter(
        (txn) =>
          txn.country?.toLowerCase() === countryLower ||
          txn.country?.toLowerCase().includes(countryLower)
      );
    }

    // ============================================
    // MODE 3: Special transaction types
    // ============================================
    // Runs LAST among the row filters and BEFORE pagination, so the selection
    // and the `type_specific_data` totals cover ALL MATCHING ROWS — every row
    // that survives the filters, not just the page returned (they pair with
    // `total_count`, which counts the same set). It used to run before the
    // exclusion filters, so totals summed rows the pipeline then dropped —
    // excluded rows, transfers, and split parents counted against their own
    // children (#854 review).
    //
    // `duplicates` is GROUP-wise, so for it the position is a semantic choice,
    // not just an ordering: pairs are found among the rows the caller would
    // see. A copy that is excluded, deleted, a transfer or a split parent no
    // longer forms a pair with its twin (a one-child split parent used to be
    // reported as a duplicate of its own child). To look for a pair whose
    // other copy is hidden, pass the matching exclude_*: false —
    // exclude_deleted: false for a Plaid-superseded copy, exclude_excluded:
    // false for an excluded one (#854 review).
    let typeSpecificData: Record<string, unknown> | undefined;

    if (transaction_type) {
      const result = this._filterByTransactionType(
        transactions,
        transaction_type,
        await this.getUserCategoryMap()
      );
      transactions = result.transactions;
      typeSpecificData = result.typeSpecificData;
    }

    const totalCount = transactions.length;
    const hasMore = validatedOffset + validatedLimit < totalCount;

    // Apply pagination
    transactions = transactions.slice(validatedOffset, validatedOffset + validatedLimit);

    // Same derivation the transaction_id path above applies — see
    // enrichCacheTransactions() for what is derived and why.
    const enrichedTransactions = await this.enrichCacheTransactions(transactions);

    // Check if query may be limited by cache
    const cacheWarning = await this.db.checkCacheLimitation(start_date, end_date);

    // #604: omitting `fields` yields the terse preset (10 fields), not the
    // full ~30-field document — `fields: ["all"]` restores it.
    const projected = projectTransactionFields(enrichedTransactions, options.fields ?? ['default']);

    return {
      count: enrichedTransactions.length,
      total_count: totalCount,
      offset: validatedOffset,
      has_more: hasMore,
      transactions: projected.rows,
      ...(typeSpecificData && { type_specific_data: typeSpecificData }),
      ...(cacheWarning && { _cache_warning: cacheWarning }),
      ...(projected.warning && { _field_warning: projected.warning }),
    };
  }

  /**
   * Filter transactions by special type.
   * @internal
   */
  private _filterByTransactionType(
    transactions: Transaction[],
    type: TransactionTypeFilter,
    userCategoryMap: Map<string, string>
  ): { transactions: Transaction[]; typeSpecificData?: Record<string, unknown> } {
    // refunds / credits / hsa_eligible / tagged mean the same thing in live
    // mode: both modes evaluate the one rule in transaction-type-rules.ts
    // (#843), each through its own row adapter.
    const byRule = (rule: SharedTransactionType) =>
      transactions.filter((txn) =>
        TRANSACTION_TYPE_RULES[rule](
          cacheTypeRuleRow(txn, (id) => lookupKnownCategoryName(id, userCategoryMap))
        )
      );
    switch (type) {
      case 'foreign': {
        const foreignTxns = transactions.filter((txn) => {
          const isForeignCountry =
            txn.country &&
            txn.country.toUpperCase() !== 'US' &&
            txn.country.toUpperCase() !== 'USA';
          const isForeignFeeCategory =
            txn.category_id === CATEGORY_FOREIGN_TX_FEE_SNAKE ||
            txn.category_id === CATEGORY_FOREIGN_TX_FEE_NUMERIC;
          const isForeignCurrency =
            txn.iso_currency_code && txn.iso_currency_code.toUpperCase() !== 'USD';
          return isForeignCountry || isForeignFeeCategory || isForeignCurrency;
        });
        const fxFees = transactions.filter(
          (txn) =>
            txn.category_id === CATEGORY_FOREIGN_TX_FEE_SNAKE ||
            txn.category_id === CATEGORY_FOREIGN_TX_FEE_NUMERIC
        );
        const totalFxFees = fxFees.reduce((sum, txn) => sum + Math.abs(txn.amount), 0);
        const countryMap = new Map<string, { count: number; total: number }>();
        for (const txn of foreignTxns) {
          const ctry = txn.country || 'Unknown';
          const existing = countryMap.get(ctry) || { count: 0, total: 0 };
          existing.count++;
          existing.total += Math.abs(txn.amount);
          countryMap.set(ctry, existing);
        }
        return {
          transactions: foreignTxns,
          typeSpecificData: {
            total_fx_fees: roundAmount(totalFxFees),
            countries: Array.from(countryMap.entries())
              .map(([c, d]) => ({
                country: c,
                count: d.count,
                total: roundAmount(d.total),
              }))
              .sort((a, b) => b.total - a.total),
          },
        };
      }

      case 'refunds': {
        const refundTxns = byRule('refunds');
        const totalRefunded = refundTxns.reduce((sum, txn) => sum + Math.abs(txn.amount), 0);
        return {
          transactions: refundTxns,
          typeSpecificData: { total_refunded: roundAmount(totalRefunded) },
        };
      }

      case 'credits': {
        const creditTxns = byRule('credits');
        const totalCredits = creditTxns.reduce((sum, txn) => sum + Math.abs(txn.amount), 0);
        return {
          transactions: creditTxns,
          typeSpecificData: { total_credits: roundAmount(totalCredits) },
        };
      }

      case 'duplicates': {
        const duplicateMap = new Map<string, Transaction[]>();
        for (const txn of transactions) {
          const key = `${getTransactionDisplayName(txn)}|${roundAmount(txn.amount)}|${txn.date}`;
          const existing = duplicateMap.get(key) || [];
          existing.push(txn);
          duplicateMap.set(key, existing);
        }
        const duplicates: Transaction[] = [];
        const groups: Array<{ key: string; count: number }> = [];
        for (const [key, txns] of duplicateMap) {
          if (txns.length > 1) {
            duplicates.push(...txns);
            groups.push({ key, count: txns.length });
          }
        }
        return {
          transactions: duplicates,
          typeSpecificData: { duplicate_groups: groups.length, groups: groups.slice(0, 20) },
        };
      }

      case 'hsa_eligible': {
        const hsaTxns = byRule('hsa_eligible');
        const totalAmount = hsaTxns.reduce((sum, txn) => sum + txn.amount, 0);
        return {
          transactions: hsaTxns,
          typeSpecificData: { total_hsa_eligible: roundAmount(totalAmount) },
        };
      }

      case 'tagged': {
        const taggedTxns = byRule('tagged');
        const tagMap = new Map<string, number>();
        for (const txn of taggedTxns) {
          for (const id of txn.tag_ids!) {
            const tagKey = id.toLowerCase();
            tagMap.set(tagKey, (tagMap.get(tagKey) || 0) + 1);
          }
        }
        return {
          transactions: taggedTxns,
          typeSpecificData: {
            tags: Array.from(tagMap.entries())
              .map(([t, c]) => ({ tag: t, count: c }))
              .sort((a, b) => b.count - a.count),
          },
        };
      }
    }
  }

  /**
   * Filter transactions by location.
   * @internal
   */
  private _filterByLocation(
    transactions: Transaction[],
    options: { city?: string; lat?: number; lon?: number; radius_km?: number }
  ): Transaction[] {
    const { city, lat, lon, radius_km = 10 } = options;

    // Haversine distance calculation
    const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
      const R = 6371; // Earth's radius in km
      const dLat = ((lat2 - lat1) * Math.PI) / 180;
      const dLon = ((lon2 - lon1) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) *
          Math.cos((lat2 * Math.PI) / 180) *
          Math.sin(dLon / 2) *
          Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    };

    return transactions.filter((txn) => {
      // City filter
      if (city && !txn.city?.toLowerCase().includes(city.toLowerCase())) return false;

      // Coordinate filter
      if (lat !== undefined && lon !== undefined) {
        if (txn.lat !== undefined && txn.lon !== undefined) {
          const distance = calculateDistance(lat, lon, txn.lat, txn.lon);
          if (distance > radius_km) return false;
        } else {
          return false; // No coordinates to compare
        }
      }

      return true;
    });
  }
  /**
   * Get information about the local data cache.
   *
   * @returns Cache metadata including date range and transaction count
   */
  async getCacheInfo(): Promise<{
    oldest_transaction_date: string | null;
    newest_transaction_date: string | null;
    transaction_count: number;
    cache_note: string;
    decode_health: DecodeHealth;
  }> {
    return await this.db.getCacheInfo();
  }

  /**
   * Refresh the database cache by clearing in-memory data and reloading from disk.
   *
   * Use this when:
   * - User has synced new transactions in Copilot Money app
   * - You suspect the data is stale
   * - User explicitly requests fresh data
   *
   * Note: The cache also auto-refreshes every 5 minutes.
   *
   * @returns Status of the refresh operation with cache info
   */
  async refreshDatabase(): Promise<{
    refreshed: boolean;
    message: string;
    cache_info: {
      oldest_transaction_date: string | null;
      newest_transaction_date: string | null;
      transaction_count: number;
    };
  }> {
    // Clear the cache
    const clearResult = this.db.clearCache();

    // Also clear the local category/account maps in tools
    this._userCategoryMap = null;
    this._excludedCategoryIds = null;

    // Trigger a reload by fetching cache info (which loads transactions)
    const cacheInfo = await this.db.getCacheInfo();

    return {
      refreshed: clearResult.cleared,
      message: clearResult.cleared
        ? `Cache refreshed. Now contains ${cacheInfo.transaction_count} transactions from ${cacheInfo.oldest_transaction_date} to ${cacheInfo.newest_transaction_date}.`
        : 'Cache was already empty. Data loaded fresh.',
      cache_info: {
        oldest_transaction_date: cacheInfo.oldest_transaction_date,
        newest_transaction_date: cacheInfo.newest_transaction_date,
        transaction_count: cacheInfo.transaction_count,
      },
    };
  }

  /**
   * Get all accounts with balances.
   *
   * @param options - Filter options
   * @returns Object with account count, total balance, and list of accounts
   */
  async getAccounts(
    options: {
      account_type?: string;
      include_hidden?: boolean;
      fields?: string[];
    } = {}
  ): Promise<{
    count: number;
    total_balance: number;
    total_assets: number;
    total_liabilities: number;
    // Partial, not Account[]: rows are projected through the field-selection
    // engine, so every key but the caller's selection is absent. The engine
    // widens back to T internally; declaring the truth here is what stops the
    // next reader from assuming a full document is available off this method.
    accounts: Partial<Account>[];
    _field_warning?: string;
  }> {
    // v3: `include_logos` was retired in favor of `fields` — a caller still
    // passing it would otherwise silently get terse rows with no explanation.
    rejectRemovedArgs(options, REMOVED_ACCOUNT_ARGS);
    const { account_type, include_hidden = false } = options;

    let accounts = await this.db.getAccounts(account_type);

    if (!include_hidden) {
      accounts = accounts.filter(isVisibleAccount);
    }

    // #660: prefer the Copilot nickname over the provider `name`. This MUST
    // run before projectRows below — projecting to the preset's `name` key
    // after this resolution is what makes the preferred name selectable at
    // all; doing it in the other order would silently reinstate the
    // provider label for a projected row.
    accounts = accounts.map((account) => {
      // Rewrite only when the preferred name is usable AND different — so a
      // blank or absent nickname leaves the row untouched rather than writing
      // `name: undefined` onto an account that never had one.
      const preferred = preferredAccountName(account);
      return preferred && preferred !== account.name ? { ...account, name: preferred } : account;
    });

    // Calculate totals by asset/liability classification
    let totalAssets = 0;
    let totalLiabilities = 0;
    for (const acc of accounts) {
      if (acc.account_type === 'loan' || acc.account_type === 'credit') {
        totalLiabilities += acc.current_balance;
      } else {
        totalAssets += acc.current_balance;
      }
    }
    const totalBalance = totalAssets - totalLiabilities;

    // v3: omitting `fields` yields the terse preset (no `holdings`, no
    // `official_name`/`original_*` name dupes, no `user_id`) — request them
    // explicitly with fields: ["default", "holdings", ...], or take
    // everything with "all"/"*". Institution logos — previously gated by the
    // now-removed `include_logos` boolean — are reachable the same way:
    // fields: ["default", "logo", "logo_content_type"].
    const { rows: responseAccounts, warning } = projectRows(
      accounts,
      options.fields ?? ['default'],
      {
        preset: DEFAULT_ACCOUNT_FIELDS,
        knownFields: ACCOUNT_KNOWN_FIELDS,
        validFieldsHint: 'the account document fields',
      }
    );

    return {
      count: accounts.length,
      total_balance: roundAmount(totalBalance),
      total_assets: roundAmount(totalAssets),
      total_liabilities: roundAmount(totalLiabilities),
      accounts: responseAccounts,
      ...(warning && { _field_warning: warning }),
    };
  }

  /**
   * Get connection status for all linked financial institutions.
   *
   * Shows per-institution sync health including last successful update timestamps
   * for transactions and investments, login requirements, and error states.
   *
   * @returns Connection status for each institution plus a summary
   */
  async getConnectionStatus(): Promise<{
    connections: Array<{
      item_id: string;
      institution_name: string;
      institution_id: string | undefined;
      status: 'connected' | 'login_required' | 'disconnected' | 'error';
      products: string[];
      last_transactions_update: string | null;
      last_transactions_failed: string | null;
      last_investments_update: string | null;
      last_investments_failed: string | null;
      latest_fetch: string | null;
      latest_investments_fetch: string | null;
      login_required: boolean;
      disconnected: boolean;
      consent_expires: string | null;
      error_code: string | null;
      error_message: string | null;
    }>;
    summary: {
      total: number;
      connected: number;
      needs_attention: number;
    };
    decode_health: DecodeHealth;
    scheduled_smoke: ScheduledSmokeStatus | null;
  }> {
    const items = await this.db.getItems();

    const connections = items.map((item) => {
      // Derive status using item.ts helpers
      let status: 'connected' | 'login_required' | 'disconnected' | 'error';
      if (item.disconnected === true || item.connection_status === 'disconnected') {
        status = 'disconnected';
      } else if (
        (item.error_code && item.error_code !== 'ITEM_NO_ERROR') ||
        item.connection_status === 'error'
      ) {
        status = 'error';
      } else if (item.login_required === true || itemNeedsAttention(item)) {
        status = 'login_required';
      } else if (!isItemHealthy(item)) {
        status = 'error';
      } else {
        status = 'connected';
      }

      return {
        item_id: item.item_id,
        institution_name: getItemDisplayName(item),
        institution_id: item.institution_id,
        status,
        products: item.products ?? [],
        last_transactions_update: item.status_transactions_last_successful_update ?? null,
        last_transactions_failed: item.status_transactions_last_failed_update ?? null,
        last_investments_update: item.status_investments_last_successful_update ?? null,
        last_investments_failed: item.status_investments_last_failed_update ?? null,
        latest_fetch: item.latest_fetch ?? null,
        latest_investments_fetch: item.latest_investments_fetch ?? null,
        login_required: item.login_required ?? false,
        disconnected: item.disconnected ?? false,
        consent_expires: item.consent_expiration_time || null,
        error_code: item.error_code ?? null,
        error_message: item.error_message ?? null,
      };
    });

    const needsAttention = connections.filter((c) => c.status !== 'connected').length;

    return {
      connections,
      summary: {
        total: connections.length,
        connected: connections.length - needsAttention,
        needs_attention: needsAttention,
      },
      decode_health: this.db.getDecodeHealth(),
      scheduled_smoke: readScheduledSmokeStatus(),
    };
  }

  /**
   * Unified category retrieval tool.
   *
   * Supports multiple views via the view parameter:
   * - list (default): Categories used in transactions with counts and amounts
   * - tree: Full Plaid category taxonomy as hierarchical tree
   * - search: Search categories by keyword
   *
   * Additional parameters:
   * - parent_id: Get subcategories of a specific parent
   * - query: Search query for 'search' view
   * - type: Filter by category type (income, expense, transfer)
   *
   * @param options - View and filter options
   * @returns Category data based on view mode
   */
  async getCategories(
    options: {
      view?: CategoryView;
      parent_id?: string;
      query?: string;
      period?: string;
      start_date?: string;
      end_date?: string;
    } = {}
  ): Promise<{
    view: string;
    count: number;
    period?: string;
    data: unknown;
  }> {
    const { view = 'list', parent_id, query, period } = options;
    let start_date = validateDate(options.start_date, 'start_date');
    let end_date = validateDate(options.end_date, 'end_date');

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // If parent_id is specified, get subcategories
    if (parent_id) {
      const allUserCats = await this.db.getUserCategories();
      const parent = allUserCats.find((c) => c.category_id === parent_id);

      if (!parent) {
        throw new Error(`Category not found: ${parent_id}`);
      }

      const children = allUserCats.filter((c) => c.parent_category_id === parent_id);

      return {
        view: 'subcategories',
        count: children.length,
        data: {
          parent_id: parent.category_id,
          parent_name: getCategoryDisplayName(parent),
          subcategories: children.map((child) => ({
            category_id: child.category_id,
            category_name: getCategoryDisplayName(child),
            emoji: child.emoji ?? null,
          })),
        },
      };
    }

    switch (view) {
      case 'tree': {
        // Build hierarchy from user categories
        const allUserCats = await this.db.getUserCategories();

        // Separate root categories (no parent) and children
        const roots = allUserCats.filter((c) => !c.parent_category_id);
        const childMap = new Map<string, Category[]>();
        for (const cat of allUserCats) {
          if (cat.parent_category_id) {
            const siblings = childMap.get(cat.parent_category_id) ?? [];
            siblings.push(cat);
            childMap.set(cat.parent_category_id, siblings);
          }
        }

        const categories = roots.map((root) => {
          const children = childMap.get(root.category_id) ?? [];
          return {
            category_id: root.category_id,
            category_name: getCategoryDisplayName(root),
            emoji: root.emoji ?? null,
            children: children.map((child) => ({
              category_id: child.category_id,
              category_name: getCategoryDisplayName(child),
              emoji: child.emoji ?? null,
            })),
          };
        });

        const totalCount = categories.reduce((sum, cat) => sum + 1 + cat.children.length, 0);

        return {
          view: 'tree',
          count: totalCount,
          data: { categories },
        };
      }

      case 'search': {
        if (!query || query.trim().length === 0) {
          throw new Error('Search query is required for search view');
        }

        const searchTerm = query.trim().toLowerCase();
        const userCats = await this.db.getUserCategories();
        const matches = userCats.filter((c) => c.name?.toLowerCase().includes(searchTerm));

        return {
          view: 'search',
          count: matches.length,
          data: {
            query: query.trim(),
            categories: matches.map((cat) => ({
              category_id: cat.category_id,
              category_name: getCategoryDisplayName(cat),
              emoji: cat.emoji ?? null,
              parent_category_id: cat.parent_category_id ?? null,
            })),
          },
        };
      }

      case 'list':
      default: {
        // Get transactions with date filtering if period/dates specified
        const transactions = filterSplitParents(
          await this.db.getTransactions({
            startDate: start_date,
            endDate: end_date,
            limit: 50000, // Get all for aggregation
          })
        );

        // Count transactions and amounts per category
        const categoryStats = new Map<string, { count: number; totalAmount: number }>();

        for (const txn of transactions) {
          const categoryId = getCategoryIdOrDefault(txn.category_id);
          const stats = categoryStats.get(categoryId) || {
            count: 0,
            totalAmount: 0,
          };
          stats.count++;
          stats.totalAmount += Math.abs(txn.amount);
          categoryStats.set(categoryId, stats);
        }

        // Include all user-created categories, even those with $0 (matching app UI)
        const userCategories = await this.db.getUserCategories();
        for (const cat of userCategories) {
          if (!categoryStats.has(cat.category_id)) {
            categoryStats.set(cat.category_id, { count: 0, totalAmount: 0 });
          }
        }

        // Build a lookup from user categories for parent/emoji info
        const userCatMap = new Map(userCategories.map((c) => [c.category_id, c]));

        // Convert to list
        const categories = (
          await Promise.all(
            Array.from(categoryStats.entries()).map(async ([category_id, stats]) => {
              const userCat = userCatMap.get(category_id);
              return {
                category_id,
                category_name: await this.resolveCategoryName(category_id),
                parent_category_id: userCat?.parent_category_id ?? null,
                parent_name: userCat?.parent_category_id
                  ? getCategoryDisplayName(
                      userCatMap.get(userCat.parent_category_id) ?? {
                        category_id: userCat.parent_category_id,
                      }
                    )
                  : null,
                transaction_count: stats.count,
                total_amount: roundAmount(stats.totalAmount),
                emoji: userCat?.emoji ?? null,
              };
            })
          )
        ).sort((a, b) => b.total_amount - a.total_amount); // Sort by amount (like UI)

        return {
          view: 'list',
          count: categories.length,
          period:
            period ??
            (start_date || end_date ? `${start_date ?? ''} to ${end_date ?? ''}` : 'all_time'),
          data: { categories },
        };
      }
    }
  }

  /**
   * Get recurring/subscription transactions.
   *
   * Identifies transactions that occur regularly (same merchant, similar amount).
   *
   * @param options - Filter options
   * @returns Object with list of recurring transactions grouped by merchant
   */
  async getRecurringTransactions(options: {
    min_occurrences?: number;
    period?: string;
    start_date?: string;
    end_date?: string;
    include_copilot_subscriptions?: boolean;
    name?: string;
    recurring_id?: string;
    fields?: string[];
  }): Promise<{
    period: { start_date?: string; end_date?: string };
    count: number;
    total_monthly_cost: number;
    // Partial, for the same reason getAccounts returns Partial<Account>[]:
    // these rows come out of the field-selection engine, which widens back to
    // T while carrying only the selected keys. Declared as full rows, the type
    // would promise `transactions` and `confidence_reason` that the default
    // preset never returns.
    recurring: Partial<DetectedRecurringRow>[];
    _field_warning?: string;
    copilot_subscriptions?: {
      summary: {
        total_active: number;
        total_paused: number;
        total_archived: number;
        monthly_cost_estimate: number;
        paid_this_month: number;
        left_to_pay_this_month: number;
      };
      this_month: Array<{
        recurring_id: string;
        name: string;
        emoji?: string;
        amount?: number;
        frequency?: string;
        display_date: string;
        is_paid: boolean;
        category_name?: string;
      }>;
      overdue: Array<{
        recurring_id: string;
        name: string;
        emoji?: string;
        amount?: number;
        frequency?: string;
        next_date?: string;
        category_name?: string;
      }>;
      future: Array<{
        recurring_id: string;
        name: string;
        emoji?: string;
        amount?: number;
        frequency?: string;
        next_date?: string;
        category_name?: string;
      }>;
      paused: Array<{
        recurring_id: string;
        name: string;
        emoji?: string;
        amount?: number;
        frequency?: string;
        category_name?: string;
      }>;
      archived: Array<{
        recurring_id: string;
        name: string;
        emoji?: string;
        amount?: number;
        frequency?: string;
        category_name?: string;
      }>;
    };
    detail_view?: Array<{
      recurring_id: string;
      name: string;
      emoji?: string;
      amount?: number;
      frequency?: string;
      category_name?: string;
      state?: string;
      next_date?: string;
      last_date?: string;
      min_amount?: number;
      max_amount?: number;
      match_string?: string;
      account_id?: string;
      account_name?: string;
      transaction_history?: Array<{
        transaction_id: string;
        date: string;
        amount: number;
        merchant: string;
      }>;
    }>;
  }> {
    const { min_occurrences = 2 } = options;
    let { period, start_date, end_date } = options;
    start_date = validateDate(start_date, 'start_date');
    end_date = validateDate(end_date, 'end_date');

    // Default to last 90 days if no period specified
    if (!period && !start_date && !end_date) {
      period = 'last_90_days';
    }

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Get all transactions in the period. Split parents share a merchant
    // name with their children and would inflate occurrence counts, producing
    // false-positive recurring matches.
    const transactions = filterSplitParents(
      await this.db.getTransactions({
        startDate: start_date,
        endDate: end_date,
        limit: 50000,
      })
    );

    // Group by merchant name
    const merchantTransactions = new Map<
      string,
      {
        transactions: Transaction[];
        categoryId?: string;
      }
    >();

    for (const txn of transactions) {
      // Only consider expenses (positive amounts)
      if (txn.amount <= 0) continue;

      const merchantName = getTransactionDisplayName(txn);
      if (merchantName === 'Unknown') continue;

      const existing = merchantTransactions.get(merchantName) || {
        transactions: [],
        categoryId: txn.category_id,
      };
      existing.transactions.push(txn);
      merchantTransactions.set(merchantName, existing);
    }

    // Analyze each merchant for recurring patterns
    const recurring: DetectedRecurringRow[] = [];

    for (const [merchant, data] of merchantTransactions) {
      if (data.transactions.length < min_occurrences) continue;

      // Sort transactions by date
      const sortedTxns = data.transactions.sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      );

      // Calculate average amount (allow 30% variance for "same" amount)
      const amounts = sortedTxns.map((t) => t.amount);
      const avgAmount = amounts.reduce((a, b) => a + b, 0) / sortedTxns.length;
      const totalAmount = amounts.reduce((a, b) => a + b, 0);

      // Check if amounts are consistent (within 30% of average)
      const consistentAmounts = amounts.filter((a) => Math.abs(a - avgAmount) / avgAmount < 0.3);
      if (consistentAmounts.length < min_occurrences) continue;

      // Calculate amount variance for confidence scoring
      const amountVariance =
        amounts.reduce((sum, a) => sum + Math.pow(a - avgAmount, 2), 0) / amounts.length;
      const amountStdDev = Math.sqrt(amountVariance);
      const amountCv = avgAmount > 0 ? amountStdDev / avgAmount : 1; // Coefficient of variation

      // Estimate frequency based on average days between transactions
      const dates = sortedTxns.map((t) => new Date(t.date).getTime());
      const gaps: number[] = [];
      for (let i = 1; i < dates.length; i++) {
        const currentDate = dates[i];
        const previousDate = dates[i - 1];
        if (currentDate !== undefined && previousDate !== undefined) {
          gaps.push((currentDate - previousDate) / (1000 * 60 * 60 * 24));
        }
      }
      const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;

      // Calculate gap variance for confidence scoring
      const gapVariance =
        gaps.length > 0
          ? gaps.reduce((sum, g) => sum + Math.pow(g - avgGap, 2), 0) / gaps.length
          : 0;
      const gapStdDev = Math.sqrt(gapVariance);
      const gapCv = avgGap > 0 ? gapStdDev / avgGap : 1;

      let frequency = 'irregular';
      if (avgGap >= 1 && avgGap <= 7) frequency = 'weekly';
      else if (avgGap >= 13 && avgGap <= 16) frequency = 'bi-weekly';
      else if (avgGap >= 27 && avgGap <= 35) frequency = 'monthly';
      else if (avgGap >= 85 && avgGap <= 100) frequency = 'quarterly';
      else if (avgGap >= 360 && avgGap <= 370) frequency = 'yearly';

      // Calculate confidence score
      let confidence: 'high' | 'medium' | 'low' = 'low';
      const confidenceReasons: string[] = [];

      // High confidence criteria
      if (amountCv < 0.05 && gapCv < 0.15 && sortedTxns.length >= 3 && frequency !== 'irregular') {
        confidence = 'high';
        confidenceReasons.push('exact same amount');
        confidenceReasons.push('consistent interval');
        confidenceReasons.push(`${sortedTxns.length} occurrences`);
      }
      // Medium confidence criteria
      else if (
        (amountCv < 0.15 || gapCv < 0.25) &&
        sortedTxns.length >= 2 &&
        frequency !== 'irregular'
      ) {
        confidence = 'medium';
        if (amountCv < 0.15) confidenceReasons.push('similar amounts');
        if (gapCv < 0.25) confidenceReasons.push('fairly consistent interval');
        confidenceReasons.push(`${sortedTxns.length} occurrences`);
      }
      // Low confidence
      else {
        confidenceReasons.push('variable amounts or intervals');
        if (frequency === 'irregular') confidenceReasons.push('no clear pattern');
      }

      // Calculate next expected date
      let nextExpectedDate: string | undefined;
      const lastTxn = sortedTxns[sortedTxns.length - 1];
      if (lastTxn && frequency !== 'irregular') {
        const lastDate = new Date(lastTxn.date);
        let daysToAdd = 30; // default
        if (frequency === 'weekly') daysToAdd = 7;
        else if (frequency === 'bi-weekly') daysToAdd = 14;
        else if (frequency === 'monthly') daysToAdd = Math.round(avgGap);
        else if (frequency === 'quarterly') daysToAdd = 90;
        else if (frequency === 'yearly') daysToAdd = 365;
        lastDate.setDate(lastDate.getDate() + daysToAdd);
        nextExpectedDate = lastDate.toISOString().substring(0, 10);
      }

      if (lastTxn) {
        recurring.push({
          merchant,
          normalized_merchant: normalizeMerchantName(merchant),
          occurrences: sortedTxns.length,
          average_amount: roundAmount(avgAmount),
          total_amount: roundAmount(totalAmount),
          frequency,
          confidence,
          confidence_reason: confidenceReasons.join(', '),
          category_name: data.categoryId
            ? await this.resolveCategoryName(data.categoryId)
            : undefined,
          last_date: lastTxn.date,
          next_expected_date: nextExpectedDate,
          transactions: sortedTxns.slice(-5).map((t) => ({
            date: t.date,
            amount: t.amount,
          })),
        });
      }
    }

    // Sort by occurrences (most frequent first)
    recurring.sort((a, b) => b.occurrences - a.occurrences);

    // Calculate estimated monthly cost
    const monthlyRecurring = recurring.filter(
      (r) => r.frequency === 'monthly' || r.frequency === 'bi-weekly' || r.frequency === 'weekly'
    );
    let totalMonthlyCost = 0;
    for (const r of monthlyRecurring) {
      if (r.frequency === 'monthly') totalMonthlyCost += r.average_amount;
      else if (r.frequency === 'bi-weekly') totalMonthlyCost += r.average_amount * 2;
      else if (r.frequency === 'weekly') totalMonthlyCost += r.average_amount * 4;
    }

    // Include Copilot's native subscription data if requested (default: true)
    const includeCopilotSubs = options.include_copilot_subscriptions !== false;
    let copilotSubscriptions:
      | {
          summary: {
            total_active: number;
            total_paused: number;
            total_archived: number;
            monthly_cost_estimate: number;
            paid_this_month: number;
            left_to_pay_this_month: number;
          };
          this_month: Array<{
            recurring_id: string;
            name: string;
            emoji?: string;
            amount?: number;
            frequency?: string;
            display_date: string;
            is_paid: boolean;
            category_name?: string;
          }>;
          overdue: Array<{
            recurring_id: string;
            name: string;
            emoji?: string;
            amount?: number;
            frequency?: string;
            next_date?: string;
            category_name?: string;
          }>;
          future: Array<{
            recurring_id: string;
            name: string;
            emoji?: string;
            amount?: number;
            frequency?: string;
            next_date?: string;
            category_name?: string;
          }>;
          paused: Array<{
            recurring_id: string;
            name: string;
            emoji?: string;
            amount?: number;
            frequency?: string;
            category_name?: string;
          }>;
          archived: Array<{
            recurring_id: string;
            name: string;
            emoji?: string;
            amount?: number;
            frequency?: string;
            category_name?: string;
          }>;
        }
      | undefined;

    if (includeCopilotSubs) {
      const copilotRecurring = await this.db.getRecurring();

      // Handle name/ID filtering with detail view
      const isDetailRequest = !!(options.name || options.recurring_id);
      if (isDetailRequest && copilotRecurring.length > 0) {
        let filteredRecurring = copilotRecurring;

        if (options.recurring_id) {
          filteredRecurring = copilotRecurring.filter(
            (r) => r.recurring_id === options.recurring_id
          );
        } else if (options.name) {
          const searchName = options.name.toLowerCase();
          filteredRecurring = copilotRecurring.filter((r) => {
            const displayName = getRecurringDisplayName(r).toLowerCase();
            return displayName.includes(searchName);
          });
        }

        // Return detailed view for filtered items
        const detailView = await Promise.all(
          filteredRecurring.map(async (rec) => ({
            recurring_id: rec.recurring_id,
            name: getRecurringDisplayName(rec),
            emoji: rec.emoji,
            amount: rec.amount,
            frequency: rec.frequency,
            category_name: rec.category_id
              ? await this.resolveCategoryName(rec.category_id)
              : undefined,
            state: rec.state ?? 'active',
            next_date: rec.next_date,
            last_date: rec.last_date,
            min_amount: rec.min_amount,
            max_amount: rec.max_amount,
            match_string: rec.match_string,
            account_id: rec.account_id,
            account_name: rec.account_id
              ? await this.resolveAccountName(rec.account_id)
              : undefined,
            transaction_history: await this.resolveTransactionHistory(rec.transaction_ids),
          }))
        );

        return {
          period: { start_date, end_date },
          count: 0,
          total_monthly_cost: 0,
          recurring: [],
          detail_view: detailView,
        };
      }

      if (copilotRecurring.length > 0) {
        // Get current date info for grouping (use string comparisons to avoid timezone issues)
        const now = new Date();
        const today = now.toISOString().split('T')[0] ?? '';
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const thisMonthPrefix = `${year}-${month}`; // e.g., "2026-01"
        const thisMonthEndStr = `${year}-${month}-31`; // Use 31 for all months (comparison will still work)

        // Group by state first (items without state default to active)
        const active = copilotRecurring.filter(
          (r) => r.state === 'active' || r.state === undefined
        );
        const paused = copilotRecurring.filter((r) => r.state === 'paused');
        const archived = copilotRecurring.filter((r) => r.state === 'archived');

        // Helper to resolve category and create base item
        const createItem = async (rec: (typeof copilotRecurring)[0]) => ({
          recurring_id: rec.recurring_id,
          name: getRecurringDisplayName(rec),
          emoji: rec.emoji,
          amount: rec.amount,
          frequency: rec.frequency,
          category_name: rec.category_id
            ? await this.resolveCategoryName(rec.category_id)
            : undefined,
        });

        // Classify active items into this_month, overdue, future
        const thisMonthItems: Array<{
          recurring_id: string;
          name: string;
          emoji?: string;
          amount?: number;
          frequency?: string;
          display_date: string;
          is_paid: boolean;
          category_name?: string;
        }> = [];
        const overdueItems: Array<{
          recurring_id: string;
          name: string;
          emoji?: string;
          amount?: number;
          frequency?: string;
          next_date?: string;
          category_name?: string;
        }> = [];
        const futureItems: Array<{
          recurring_id: string;
          name: string;
          emoji?: string;
          amount?: number;
          frequency?: string;
          next_date?: string;
          category_name?: string;
        }> = [];

        let paidThisMonth = 0;
        let leftToPayThisMonth = 0;
        let monthlyCostEstimate = 0;

        for (const rec of active) {
          const baseItem = await createItem(rec);

          // Calculate monthly cost estimate
          if (rec.amount) {
            const freq = rec.frequency?.toLowerCase();
            if (freq === 'monthly') monthlyCostEstimate += Math.abs(rec.amount);
            else if (freq === 'biweekly' || freq === 'bi-weekly')
              monthlyCostEstimate += Math.abs(rec.amount) * 2;
            else if (freq === 'weekly') monthlyCostEstimate += Math.abs(rec.amount) * 4;
            else if (freq === 'quarterly') monthlyCostEstimate += Math.abs(rec.amount) / 3;
            else if (freq === 'yearly' || freq === 'annually')
              monthlyCostEstimate += Math.abs(rec.amount) / 12;
            else if (freq === 'semiannually' || freq === 'semi-annually')
              monthlyCostEstimate += Math.abs(rec.amount) / 6;
          }

          // Check if paid this month using string comparison (avoids timezone issues)
          const isPaidThisMonth = rec.last_date?.startsWith(thisMonthPrefix);

          if (isPaidThisMonth && rec.last_date) {
            // Already paid this month - show in "this_month" with is_paid=true
            thisMonthItems.push({
              ...baseItem,
              display_date: rec.last_date,
              is_paid: true,
            });
            paidThisMonth += Math.abs(rec.amount || 0);
          } else if (rec.next_date && rec.next_date < today) {
            // Next date is in the past - overdue
            overdueItems.push({
              ...baseItem,
              next_date: rec.next_date,
            });
            leftToPayThisMonth += Math.abs(rec.amount || 0);
          } else if (rec.next_date && rec.next_date <= thisMonthEndStr) {
            // Next date is this month but not yet paid
            thisMonthItems.push({
              ...baseItem,
              display_date: rec.next_date,
              is_paid: false,
            });
            leftToPayThisMonth += Math.abs(rec.amount || 0);
          } else if (rec.next_date) {
            // Next date is after this month
            futureItems.push({
              ...baseItem,
              next_date: rec.next_date,
            });
          } else {
            // No next_date available - put in future as unknown
            futureItems.push({
              ...baseItem,
              next_date: undefined,
            });
          }
        }

        // Sort items by date
        thisMonthItems.sort((a, b) => a.display_date.localeCompare(b.display_date));
        overdueItems.sort((a, b) => (a.next_date || '').localeCompare(b.next_date || ''));
        futureItems.sort((a, b) => (a.next_date || 'z').localeCompare(b.next_date || 'z'));

        // Create paused and archived arrays
        const pausedItems = await Promise.all(paused.map(createItem));
        const archivedItems = await Promise.all(archived.map(createItem));

        // Sort by name
        pausedItems.sort((a, b) => a.name.localeCompare(b.name));
        archivedItems.sort((a, b) => a.name.localeCompare(b.name));

        copilotSubscriptions = {
          summary: {
            total_active: active.length,
            total_paused: paused.length,
            total_archived: archived.length,
            monthly_cost_estimate: roundAmount(monthlyCostEstimate),
            paid_this_month: roundAmount(paidThisMonth),
            left_to_pay_this_month: roundAmount(leftToPayThisMonth),
          },
          this_month: thisMonthItems,
          overdue: overdueItems,
          future: futureItems,
          paused: pausedItems,
          archived: archivedItems,
        };
      }
    }

    // v3: omitting `fields` yields the terse preset (no `transactions`/
    // `confidence_reason`) — request them explicitly with
    // fields: ["default", "transactions", "confidence_reason"], or take
    // everything with "all"/"*".
    const { rows: projectedRecurring, warning } = projectRows(
      recurring,
      options.fields ?? ['default'],
      {
        preset: DEFAULT_RECURRING_CACHE_FIELDS,
        knownFields: RECURRING_CACHE_KNOWN_FIELDS,
        validFieldsHint: RECURRING_CACHE_VALID_FIELDS_HINT,
      }
    );

    return {
      period: { start_date, end_date },
      count: recurring.length,
      total_monthly_cost: roundAmount(totalMonthlyCost),
      recurring: projectedRecurring,
      ...(copilotSubscriptions ? { copilot_subscriptions: copilotSubscriptions } : {}),
      ...(warning && { _field_warning: warning }),
    };
  }

  /**
   * Get budgets from Copilot's native budget tracking.
   *
   * @param options - Filter options
   * @returns Object with budget count and list of budgets
   */
  async getBudgets(options: { active_only?: boolean } = {}): Promise<{
    count: number;
    total_budgeted: number;
    budgets: Array<{
      budget_id: string;
      name?: string;
      amount?: number;
      amounts?: Record<string, number>;
      period?: string;
      category_id?: string;
      category_name?: string;
      start_date?: string;
      end_date?: string;
      is_active?: boolean;
      iso_currency_code?: string;
    }>;
  }> {
    const { active_only = false } = options;

    const allBudgets = await this.db.getBudgets(active_only);

    // Issue #278: Copilot's macOS app stopped writing to the top-level `amount`
    // field ~2 years ago. Fresh values live in `amounts[YYYY-MM]` keyed by the
    // current month. Prefer that over the stale top-level `amount`.
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const effectiveAmount = (b: {
      amount?: number;
      amounts?: Record<string, number>;
    }): number | undefined => {
      const override = b.amounts?.[currentMonth];
      return override !== undefined ? override : b.amount;
    };

    // Defense-in-depth: processBudget now drops true empty-field tombstones,
    // but a doc could still reach here with some fields set and yet no
    // meaningful budget content (e.g. just a name, or an is_active flag with
    // nothing else). Strip those so the view only contains actionable rows.
    const nonTombstone = allBudgets.filter(
      (b) => b.category_id !== undefined || b.amount !== undefined || b.amounts !== undefined
    );

    // Filter out budgets with orphaned category references (deleted categories)
    const categoryMap = await this.getUserCategoryMap();
    const budgets = nonTombstone.filter((b) => {
      if (!b.category_id) return true; // Keep budgets without category
      // Keep if category exists in user categories or Plaid categories
      return categoryMap.has(b.category_id) || isKnownPlaidCategory(b.category_id);
    });

    // Calculate total budgeted amount (monthly equivalent) using the
    // current-month effective amount (may be 0 for explicit clears).
    let totalBudgeted = 0;
    for (const budget of budgets) {
      const amt = effectiveAmount(budget);
      if (amt) {
        // Convert to monthly equivalent based on period
        const monthlyAmount =
          budget.period === 'yearly'
            ? amt / 12
            : budget.period === 'weekly'
              ? amt * 4.33 // Average weeks per month
              : budget.period === 'daily'
                ? amt * 30
                : amt; // Default to monthly

        totalBudgeted += monthlyAmount;
      }
    }

    const enrichedBudgets = await Promise.all(
      budgets.map(async (b) => ({
        budget_id: b.budget_id,
        name: b.name,
        amount: effectiveAmount(b),
        ...(b.amounts ? { amounts: b.amounts } : {}),
        period: b.period,
        category_id: b.category_id,
        category_name: b.category_id ? await this.resolveCategoryName(b.category_id) : undefined,
        start_date: b.start_date,
        end_date: b.end_date,
        is_active: b.is_active,
        iso_currency_code: b.iso_currency_code,
      }))
    );

    return {
      count: budgets.length,
      total_budgeted: roundAmount(totalBudgeted),
      budgets: enrichedBudgets,
    };
  }

  /**
   * Get financial goals (savings targets, debt payoff goals, etc.).
   *
   * @param options - Filter options
   * @returns Object with goal details
   */
  async getGoals(options: { active_only?: boolean } = {}): Promise<{
    count: number;
    total_target: number;
    total_saved: number;
    goals: Array<{
      goal_id: string;
      name?: string;
      emoji?: string;
      target_amount?: number;
      current_amount?: number;
      monthly_contribution?: number;
      status?: string;
      tracking_type?: string;
      start_date?: string;
      created_date?: string;
      is_ongoing?: boolean;
      inflates_budget?: boolean;
    }>;
  }> {
    const { active_only = false } = options;

    const goals = await this.db.getGoals(active_only);

    // Get goal history to join current_amount with goals
    // We need the most recent month's data for each goal
    const goalHistory = await this.db.getGoalHistory();

    // Build a map of goal_id -> { month, current_amount } tracking the latest month
    const currentAmountMap = new Map<string, { month: string; amount: number }>();
    for (const history of goalHistory) {
      if (history.current_amount === undefined) continue;

      const existing = currentAmountMap.get(history.goal_id);
      // Update if no existing value OR this is a newer month
      if (!existing || history.month > existing.month) {
        currentAmountMap.set(history.goal_id, {
          month: history.month,
          amount: history.current_amount,
        });
      }
    }

    // Calculate totals across all goals
    let totalTarget = 0;
    let totalSaved = 0;
    for (const goal of goals) {
      if (goal.savings?.target_amount) {
        totalTarget += goal.savings.target_amount;
      }
      const currentAmount = currentAmountMap.get(goal.goal_id)?.amount ?? 0;
      totalSaved += currentAmount;
    }

    return {
      count: goals.length,
      total_target: roundAmount(totalTarget),
      total_saved: roundAmount(totalSaved),
      goals: goals.map((g) => ({
        goal_id: g.goal_id,
        name: g.name,
        emoji: g.emoji,
        target_amount: g.savings?.target_amount,
        current_amount: currentAmountMap.get(g.goal_id)?.amount,
        monthly_contribution: g.savings?.tracking_type_monthly_contribution,
        status: g.savings?.status,
        tracking_type: g.savings?.tracking_type,
        start_date: g.savings?.start_date,
        created_date: g.created_date,
        is_ongoing: g.savings?.is_ongoing,
        inflates_budget: g.savings?.inflates_budget,
      })),
    };
  }

  /**
   * Get investment price history with optional filters.
   *
   * @param options - Filter options
   * @returns Object with price data and pagination info
   */
  async getInvestmentPrices(
    options: {
      ticker_symbol?: string;
      start_date?: string;
      end_date?: string;
      price_type?: PriceType;
      fields?: string[];
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{
    count: number;
    total_count: number;
    offset: number;
    has_more: boolean;
    tickers: string[];
    prices: InvestmentPrice[];
    _field_warning?: string;
  }> {
    const { ticker_symbol, start_date, end_date, price_type } = options;
    const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
    const validatedOffset = validateOffset(options.offset);

    validateDate(start_date, 'start_date');
    validateDate(end_date, 'end_date');

    const prices = await this.db.getInvestmentPrices({
      tickerSymbol: ticker_symbol,
      startDate: start_date,
      endDate: end_date,
      priceType: price_type,
    });

    const tickerSet = new Set<string>();
    for (const p of prices) {
      if (p.ticker_symbol) tickerSet.add(p.ticker_symbol);
    }

    const totalCount = prices.length;
    const hasMore = validatedOffset + validatedLimit < totalCount;
    const paged = prices.slice(validatedOffset, validatedOffset + validatedLimit);

    // Derive the latest point BEFORE projecting: the terse default drops the
    // `prices` series, and real documents have no scalar price field, so
    // without this a default row would carry no price at all (#605/#622).
    const enriched = paged.map((row) => {
      const latest = getLatestPricePoint(row);
      return latest ? { ...row, ...latest } : row;
    });

    // v3: omitting `fields` yields the terse preset, not full rows. Callers
    // wanting the series ask for it — `fields: ["default", "prices"]` — or
    // take everything with "all"/"*".
    const { rows, warning } = projectRows(enriched, options.fields ?? ['default'], {
      preset: DEFAULT_INVESTMENT_PRICE_FIELDS,
      knownFields: INVESTMENT_PRICE_KNOWN_FIELDS,
      validFieldsHint:
        'the investment-price document fields plus the derived latest_price and latest_at',
    });

    return {
      count: rows.length,
      total_count: totalCount,
      offset: validatedOffset,
      has_more: hasMore,
      tickers: [...tickerSet].sort(),
      prices: rows,
      ...(warning && { _field_warning: warning }),
    };
  }

  /**
   * Get stock split history with optional filters.
   *
   * One output row per (security, effective_date) tuple. Securities that
   * have never had a split are omitted entirely. The returned `multiplier`
   * is what to multiply a pre-split price/quantity by to convert to the
   * post-split equivalent (e.g. 0.1 for a 10-for-1 split).
   *
   * IMPORTANT: prices returned by `get_investment_prices` (and its live
   * counterpart) are ALREADY split-adjusted by Copilot. This tool is for
   * surfacing the split events themselves — narrative or historical
   * analysis — NOT for back-correcting prices.
   */
  async getInvestmentSplits(
    options: {
      ticker_symbol?: string;
      start_date?: string;
      end_date?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{
    count: number;
    total_count: number;
    offset: number;
    has_more: boolean;
    splits: Array<{
      security_id: string;
      ticker_symbol?: string;
      name?: string;
      effective_date: string;
      multiplier: number;
      ratio_description: string;
    }>;
  }> {
    const { ticker_symbol } = options;
    const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
    const validatedOffset = validateOffset(options.offset);
    const start_date = validateDate(options.start_date, 'start_date');
    const end_date = validateDate(options.end_date, 'end_date');

    // Load splits (applies ticker filter at the doc level).
    const docs = await this.db.getInvestmentSplits({ tickerSymbol: ticker_symbol });
    const securityMap = await this.db.getSecurityMap();

    // Project each (security, date) tuple into its own output row.
    const allRows: Array<{
      security_id: string;
      ticker_symbol?: string;
      name?: string;
      effective_date: string;
      multiplier: number;
      ratio_description: string;
    }> = [];
    for (const doc of docs) {
      const sec = securityMap.get(doc.security_id);
      for (const [date, multiplier] of Object.entries(doc.adjustments)) {
        if (start_date && date < start_date) continue;
        if (end_date && date > end_date) continue;
        allRows.push({
          security_id: doc.security_id,
          ticker_symbol: sec?.ticker_symbol,
          name: sec?.name,
          effective_date: date,
          multiplier,
          ratio_description: formatSplitRatio(multiplier),
        });
      }
    }

    // Sort by date descending (most-recent first) — natural agent UX.
    allRows.sort((a, b) => b.effective_date.localeCompare(a.effective_date));

    const total = allRows.length;
    const sliced = allRows.slice(validatedOffset, validatedOffset + validatedLimit);
    return {
      count: sliced.length,
      total_count: total,
      offset: validatedOffset,
      has_more: validatedOffset + sliced.length < total,
      splits: sliced,
    };
  }

  /**
   * Get current investment holdings with cost basis and returns.
   *
   * Joins holdings (from account documents) with securities for enrichment.
   * Computes average cost and total return when cost_basis is available.
   */
  async getHoldings(
    options: {
      account_id?: string;
      ticker_symbol?: string;
      include_history?: boolean;
      include_hidden?: boolean;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{
    count: number;
    total_count: number;
    offset: number;
    has_more: boolean;
    holdings: HoldingEntry[];
  }> {
    const { account_id, ticker_symbol, include_history = false, include_hidden = false } = options;
    const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
    const validatedOffset = validateOffset(options.offset);

    // Load data sources. Same visibility rule as getAccounts, and the same
    // default (#683) — otherwise a merged account's stale positions are
    // reported as live holdings while the account list correctly hides it,
    // and anything summing institution_value double-counts.
    //
    // Note this applies even when account_id names a hidden account, so that
    // call returns an empty result. Deliberate: the alternative — an explicit
    // id bypassing the filter — makes the tool's answer depend on HOW you
    // asked rather than on what is true, which is the shape of the bug being
    // fixed. The param description says so, and include_hidden is the way in.
    const allAccounts = await this.db.getAccounts();
    const accounts = include_hidden ? allAccounts : allAccounts.filter(isVisibleAccount);
    const securityMap = await this.db.getSecurityMap();

    // Build ticker → security_id lookup for ticker_symbol filtering
    let tickerSecurityIds: Set<string> | undefined;
    if (ticker_symbol) {
      tickerSecurityIds = new Set<string>();
      for (const [id, sec] of securityMap) {
        const isCash = sec.is_cash_equivalent === true || isCashSecurityType(sec.type);
        if (tickerMatches(sec.ticker_symbol, ticker_symbol, isCash)) {
          tickerSecurityIds.add(id);
        }
      }
    }

    // Extract and enrich holdings from investment accounts
    const holdings: HoldingEntry[] = [];

    for (const acct of accounts) {
      if (!acct.holdings || acct.holdings.length === 0) continue;
      if (account_id && acct.account_id !== account_id) continue;

      for (const h of acct.holdings) {
        if (
          !h.security_id ||
          h.quantity === undefined ||
          h.institution_price === undefined ||
          h.institution_value === undefined
        )
          continue;

        // Apply ticker filter
        if (tickerSecurityIds && !tickerSecurityIds.has(h.security_id)) continue;

        // Enrich with security data
        const sec = securityMap.get(h.security_id);

        const entry: HoldingEntry = {
          security_id: h.security_id,
          ticker_symbol: sec?.ticker_symbol,
          name: sec?.name,
          type: sec?.type,
          account_id: acct.account_id,
          // #663: same preference get_accounts applies (#660) — the Copilot
          // nickname when the user set one. Without this the two tools show two
          // different names for one account, which the v3 accounts diet made more
          // likely by redirecting holdings callers here.
          account_name: preferredAccountName(acct),
          quantity: h.quantity,
          institution_price: h.institution_price,
          institution_value: h.institution_value,
          is_cash_equivalent: sec?.is_cash_equivalent,
          iso_currency_code: h.iso_currency_code ?? sec?.iso_currency_code,
        };

        // Compute cost basis derived fields. `computeTotalReturnPercent`
        // applies Math.floor to match Copilot's web UI display convention;
        // see `src/utils/round.ts` for the rationale.
        if (h.cost_basis != null && h.cost_basis !== 0 && h.quantity !== 0) {
          entry.cost_basis = roundAmount(h.cost_basis);
          entry.average_cost = roundAmount(h.cost_basis / h.quantity);
          entry.total_return = roundAmount(h.institution_value - h.cost_basis);
          entry.total_return_percent = computeTotalReturnPercent(
            h.institution_value - h.cost_basis,
            h.cost_basis
          );
        }

        holdings.push(entry);
      }
    }

    // Attach history if requested
    if (include_history) {
      const allHistory = await this.db.getHoldingsHistory();

      for (const holding of holdings) {
        const matchingHistory = allHistory.filter(
          (hh) =>
            hh.security_id === holding.security_id &&
            (!hh.account_id || hh.account_id === holding.account_id)
        );

        if (matchingHistory.length > 0) {
          holding.history = matchingHistory
            .filter((hh) => hh.month && hh.history)
            .map((hh) => ({
              month: hh.month!,
              snapshots: hh.history!,
            }))
            .sort((a, b) => b.month.localeCompare(a.month));
        }
      }
    }

    // Paginate
    const totalCount = holdings.length;
    const hasMore = validatedOffset + validatedLimit < totalCount;
    const paged = holdings.slice(validatedOffset, validatedOffset + validatedLimit);

    return {
      count: paged.length,
      total_count: totalCount,
      offset: validatedOffset,
      has_more: hasMore,
      holdings: paged,
    };
  }

  /**
   * Create a new user-defined category in Copilot Money.
   *
   * Generates a unique category_id, writes via GraphQL; local cache is
   * refreshed by Copilot's sync process.
   */
  async createCategory(args: {
    name: string;
    color_name: string;
    emoji: string;
    is_excluded?: boolean;
    parent_id?: string;
  }): Promise<{ success: true; category_id: string; name: string; color_name: string }> {
    // Copilot's GraphQL schema does not accept parentId on CreateCategoryInput
    // (nor on EditCategoryInput). Parent/child category hierarchies exist in
    // the local cache and can be read via get_categories(parent_id=...), but
    // they are not writable through the web app's GraphQL mutations. Reject
    // with a clear error rather than sending a request the server will refuse.
    // First, before the other checks, so a caller asking for a parent always
    // learns that it cannot be done (it is in argsRejectedByHandler, #877).
    // Presence, not value, like the dispatch pass-through that sends it here.
    if (Object.prototype.hasOwnProperty.call(args, 'parent_id')) {
      throw new Error(
        "parent_id is not supported on create_category: Copilot's GraphQL API " +
          'does not accept parentId on CreateCategoryInput. Create the category ' +
          'without a parent; the Copilot web app does not currently expose a ' +
          'mutation to re-parent categories.'
      );
    }
    const client = this.getGraphQLClient();
    if (!args.name?.trim()) throw new Error('Category name must not be empty');
    if (!args.color_name?.trim()) throw new Error('color_name is required');
    if (!args.emoji?.trim()) throw new Error('emoji is required');
    const colorName = validateColorName(args.color_name);

    try {
      const result = await gqlCreateCategory(client, {
        input: {
          name: args.name.trim(),
          colorName,
          emoji: args.emoji,
          isExcluded: args.is_excluded ?? false,
        },
      });
      this.db.patchCachedCategoryUpsert({
        category_id: result.id,
        name: result.name,
        color: result.colorName,
        emoji: args.emoji,
        excluded: args.is_excluded ?? false,
      });
      // The CreateCategory mutation doesn't return `icon` on its response,
      // so we synthesize it as EmojiUnicode here. If the user-supplied emoji
      // string ends up being stored as a Genmoji on the server, the synthesized
      // shape would be wrong — but the next categoriesCache read overwrites
      // this synthetic entry with the correct server shape, so the divergence
      // is bounded to the window before the next read.
      this.liveDb?.patchLiveCategoryUpsert({
        id: result.id,
        // CreateCategoryInput doesn't accept parentId; new categories are always top-level.
        parentId: null,
        name: result.name,
        templateId: null,
        colorName: result.colorName,
        icon: args.emoji ? { __typename: 'EmojiUnicode', unicode: args.emoji } : null,
        isExcluded: args.is_excluded ?? false,
        isRolloverDisabled: false,
        canBeDeleted: true,
        budget: null,
      });
      return {
        success: true,
        category_id: result.id,
        name: result.name,
        color_name: result.colorName,
      };
    } catch (e) {
      this.afterPossiblyAppliedEntityWrite(e, 'categories');
      if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e), { cause: e });
      throw e;
    }
  }

  /**
   * Resolve accountId/itemId routing ids for a set of transaction ids —
   * required by EditTransaction/CreateRecurring mutations (the server
   * validates the full binding; see the Mutation.editTransaction:routing
   * ledger entry).
   *
   * Live mode (liveDb present — all production writes, since --write
   * implies --live-reads): ① the in-memory meta index fed by every live
   * read (O(1), no network) → ② one windowed live fetch for ids the index
   * misses (default 13 months, COPILOT_WRITE_RESOLVE_WINDOW_MONTHS
   * overrides; the fetch itself re-feeds the index via fetchMonth). The
   * local LevelDB cache is deliberately NOT consulted: README's contract
   * is that writes resolve against the live GraphQL surface, and the
   * desktop app's cache may belong to a different login than the browser
   * session token.
   *
   * Degraded mode (no liveDb — unit tests / hypothetical configs): the
   * local LevelDB cache is the only resolver, as before.
   *
   * Returns the resolved map plus liveWindowMonths (null iff no live fetch
   * could be attempted) so callers can compose an honest not-found error.
   */
  private async resolveTransactionMeta(
    ids: string[],
    loadWindow?: () => Promise<readonly TransactionNode[]>
  ): Promise<{
    meta: Map<string, { accountId: string; itemId: string }>;
    liveWindowMonths: number | null;
  }> {
    const out = new Map<string, { accountId: string; itemId: string }>();

    if (!this.liveDb) {
      const local = await this.db.getAllTransactions();
      const localById = new Map(local.map((t) => [t.transaction_id, t]));
      for (const id of ids) {
        const t = localById.get(id);
        if (t?.account_id && t?.item_id) {
          out.set(id, { accountId: t.account_id, itemId: t.item_id });
        }
      }
      return { meta: out, liveWindowMonths: null };
    }

    const indexed = this.liveDb.lookupTransactionMeta(ids);
    const missing: string[] = [];
    for (const id of ids) {
      const m = indexed.get(id);
      if (m) {
        out.set(id, m);
      } else {
        missing.push(id);
      }
    }

    const { from, to, lookbackMonths } = CopilotMoneyTools.writeResolveWindow();
    if (missing.length > 0) {
      // Consult the meta index the fetch just fed rather than scanning the
      // date-filtered return value: fetchMonth feeds the index with the FULL
      // pre-trim month, so this also resolves same-month future-dated
      // transactions the rows scan missed (#513). The empty-routing-id guard
      // is enforced at the feed, so indexed entries are always valid. A
      // caller's shared loader (#836) lets a later split-parent check reuse
      // this fetch rather than repeat it.
      if (loadWindow) await loadWindow();
      else await this.liveDb.getTransactions({ from, to });
      for (const [id, m] of this.liveDb.lookupTransactionMeta(missing)) {
        out.set(id, m);
      }
    }
    // liveWindowMonths is non-null here even when no fetch ran
    // (missing.length === 0). Safe by invariant: callers only compose the
    // window error for ids absent from `meta`, and an empty `missing` means
    // every requested id IS in `meta` — the error path is unreachable
    // without an attempted fetch.
    return { meta: out, liveWindowMonths: lookbackMonths };
  }

  /**
   * Window size for the live resolution fetch. Mirrors the
   * getCacheTTLMs() env-parse convention (src/core/database.ts): explicit
   * positive integer wins, anything else falls back to the default.
   */
  private static resolveWindowMonths(): number {
    const envValue = process.env.COPILOT_WRITE_RESOLVE_WINDOW_MONTHS;
    if (envValue !== undefined) {
      const months = parseInt(envValue, 10);
      if (!isNaN(months) && months > 0) return months;
    }
    return 13;
  }

  /** The [from, to] date range for write-resolution live fetches, plus
   *  `lookbackMonths`: how far back `from` is. A window load covers
   *  monthsCovered({ from, to }) = lookbackMonths + 1 calendar months. Shared
   *  by resolveTransactionMeta, resolveParentSnapshot and
   *  splitParentEvidence. Public so tests derive the window from this one
   *  definition instead of re-implementing its arithmetic. */
  static writeResolveWindow(): { from: string; to: string; lookbackMonths: number } {
    const lookbackMonths = CopilotMoneyTools.resolveWindowMonths();
    const to = new Date().toISOString().slice(0, 10);
    const fromDate = new Date();
    fromDate.setMonth(fromDate.getMonth() - lookbackMonths);
    const from = fromDate.toISOString().slice(0, 10);
    return { from, to, lookbackMonths };
  }

  /**
   * Compose the not-found error for unresolved write targets. The window
   * suffix appears only when a live fetch was actually attempted
   * (liveWindowMonths non-null) — three distinct failures otherwise share
   * one string: typo'd id, out-of-window id, and the server's own
   * wrong-routing error (verified byte-identical by the 2026-07-05 probe).
   */
  private static transactionsNotFoundMessage(
    missing: string[],
    liveWindowMonths: number | null
  ): string {
    const base = `Transaction${missing.length > 1 ? 's' : ''} not found: ${missing.join(', ')}`;
    if (liveWindowMonths === null) return base;
    return (
      `${base} — not found in the last ${liveWindowMonths} months of live data. ` +
      `If the transaction is older, raise COPILOT_WRITE_RESOLVE_WINDOW_MONTHS; ` +
      `if it should be recent, verify the id.`
    );
  }

  /**
   * Full-row parent snapshot for split_transaction — CONTENT fields only
   * (amount for the sum check, name/date for split defaults). Routing ids
   * are NOT resolved here: split's schema requires the caller-supplied
   * triple. Live mode: window cache → one windowed live fetch (which feeds
   * the window cache and meta index as side effects) → null. Degraded mode
   * (no liveDb): local LevelDB row, preserving the name ?? original_name
   * fallback (older Plaid rows only carry original_name). Content freshness
   * note: unlike routing ids, amount is NOT immutable (pending→posted
   * drift), so live-first here is a correctness improvement over the
   * stale-first LevelDB read it replaces; the server remains the final
   * enforcer of the sum.
   */
  private async resolveParentSnapshot(
    id: string,
    loadWindow: () => Promise<readonly TransactionNode[]> = () => this.loadWriteResolveWindow()
  ): Promise<{
    snapshot: { amount: number; date: string; name?: string } | null;
    liveWindowMonths: number | null;
  }> {
    if (!this.liveDb) {
      const all = await this.db.getAllTransactions();
      const t = all.find((x) => x.transaction_id === id);
      if (!t) return { snapshot: null, liveWindowMonths: null };
      return {
        snapshot: { amount: t.amount, date: t.date, name: t.name ?? t.original_name },
        liveWindowMonths: null,
      };
    }
    const { lookbackMonths } = CopilotMoneyTools.writeResolveWindow();
    const cached = this.liveDb.lookupTransactionNodes([id]).get(id);
    if (cached) {
      return {
        snapshot: { amount: cached.amount, date: cached.date, name: cached.name },
        liveWindowMonths: lookbackMonths,
      };
    }
    const liveRows = await loadWindow();
    // Cache-first: the window cache holds same-month future-dated rows the
    // date-filtered return value misses (#513). Rows-fallback: unlike the
    // append-only meta index resolveTransactionMeta reads, the window cache
    // LRU-evicts per ingest, so a very large window can evict early months
    // before the fetch returns — the in-hand rows are immune to that.
    const n = this.liveDb.lookupTransactionNodes([id]).get(id) ?? liveRows.find((r) => r.id === id);
    if (!n) return { snapshot: null, liveWindowMonths: lookbackMonths };
    return {
      snapshot: { amount: n.amount, date: n.date, name: n.name },
      liveWindowMonths: lookbackMonths,
    };
  }

  /** Minimum gap between two miss-driven refetches of one reference list. */
  static readonly REFERENCE_REFETCH_MIN_MS = 30_000;
  /** Last WASTED refetch per reference cache (keyed by the cache itself). */
  private readonly lastReferenceRefetch = new WeakMap<object, number>();

  /**
   * A live reference list (categories, tags) that holds every id in `ids`
   * when the server does (#846 review). The list is cached for a day, so an
   * id created in the app since would be refused; when a CACHED list misses
   * an id it is refetched once before the caller rejects. Two limits keep a
   * caller retrying an id that does not exist from paying a fetch per try:
   * at most one wasted refetch (one that still misses an id, or fails) per
   * list per REFERENCE_REFETCH_MIN_MS, so a refetch that finds the new id
   * never delays the next one; and a refetch that fails returns the rows
   * already held, so the caller still reports the id as not found (the
   * cache, dropped for the refetch, simply loads again on its next read).
   * Under concurrency the refetch can join a load already in flight, whose
   * rows may predate the new id; that narrow case is accepted.
   */
  private async referenceRows<T extends { id: string }>(
    cache: SnapshotCache<T>,
    load: () => Promise<T[]>,
    ids: readonly string[]
  ): Promise<T[]> {
    const missesAny = (rows: readonly T[]) => ids.some((id) => !rows.some((r) => r.id === id));
    const first = await cache.read(load);
    if (!missesAny(first.rows) || !first.hit) return first.rows;
    const now = Date.now();
    const last = this.lastReferenceRefetch.get(cache);
    if (last !== undefined && now - last < CopilotMoneyTools.REFERENCE_REFETCH_MIN_MS) {
      return first.rows;
    }
    cache.invalidate();
    try {
      const rows = (await cache.read(load)).rows;
      if (missesAny(rows)) this.lastReferenceRefetch.set(cache, Date.now());
      return rows;
    } catch {
      this.lastReferenceRefetch.set(cache, Date.now());
      return first.rows;
    }
  }

  /**
   * Validate a category id against the authoritative source — the live
   * categories cache (fetch-on-cold, existing TTLs) in live mode; the local
   * LevelDB cache only in degraded mode. Message contract unchanged (#510).
   *
   * The ONE category-reference check for every write that assigns a
   * category (#846): create_transaction, split_transaction children,
   * update_transaction(s), bulk_edit_transactions, update_recurring and
   * set_budget. Copilot stores an unknown category id verbatim (ledger:
   * Mutation.bulkEditTransactions:no-referential-validation,
   * Mutation.createTransaction:no-referential-validation), so this is the
   * only guard against a row pointing at no category.
   *
   * A miss on a cached list (1-day TTL) refetches once before rejecting, so a
   * category created in the app since the list was cached is not refused (see
   * referenceRows).
   */
  private async validateCategoryId(categoryId: string): Promise<void> {
    if (!(await this.categoryExists(categoryId))) {
      throw new Error(`Category not found: ${categoryId}`);
    }
  }

  /**
   * Whether `categoryId` is a known category: the lookup validateCategoryId
   * throws on. `refetch: false` answers from what is already held and never
   * makes a network round trip or arms the refetch throttle, for callers that
   * need knowledge, not verification. A cold live list counts as unknown; an
   * expired one is still read as it stands (peek ignores the TTL), which the
   * one caller, set_budget's clear, accepts: its write-through patch is the
   * only consequence. In degraded mode it reads the local cache, which can
   * load LevelDB.
   */
  private async categoryExists(
    categoryId: string,
    opts: { refetch?: boolean } = {}
  ): Promise<boolean> {
    const liveDb = this.liveDb;
    if (liveDb) {
      if (opts.refetch === false) {
        return (
          liveDb
            .getCategoriesCache()
            .peek()
            ?.some((c) => c.id === categoryId) ?? false
        );
      }
      const rows = await this.referenceRows(
        liveDb.getCategoriesCache(),
        async () => {
          const rollovers = await liveDb.resolveRolloversFlag();
          return fetchCategories(liveDb.getClient(), { rollovers });
        },
        [categoryId]
      );
      return rows.some((c) => c.id === categoryId);
    }
    const categories = await this.db.getUserCategories();
    return categories.some((c) => c.category_id === categoryId);
  }

  /** Tag-ids sibling of validateCategoryId — same mode split, same messages. */
  private async validateTagIds(tagIds: string[]): Promise<void> {
    if (tagIds.length === 0) return;
    const liveDb = this.liveDb;
    if (liveDb) {
      const rows = await this.referenceRows(
        liveDb.getTagsCache(),
        () => fetchTags(liveDb.getClient()),
        tagIds
      );
      for (const tagId of tagIds) {
        if (!rows.find((t) => t.id === tagId)) {
          throw new Error(`Tag not found: ${tagId}`);
        }
      }
      return;
    }
    const tags = await this.db.getTags();
    for (const tagId of tagIds) {
      if (!tags.find((t) => t.tag_id === tagId)) {
        throw new Error(`Tag not found: ${tagId}`);
      }
    }
  }

  /**
   * The pure, synchronous half of an edit's field validation: every field
   * check that needs no lookup. Both update tools run it before the split
   * check's window load (#836 review), so an input no retry can make valid
   * neither pays the load nor is reported as a failed one. `label` prefixes
   * every message: the singular tool passes its own name; the plural passes
   * `update_transactions edits[i]` so a failure in a 200-row batch names the
   * row that caused it.
   */
  private static validateEditFieldShapes(edit: TransactionEdit, label: string): void {
    if ('name' in edit && edit.name !== undefined) {
      const trimmed = edit.name.trim();
      if (trimmed.length === 0) {
        throw new Error(`${label}: name must not be empty`);
      }
    }
    if ('category_id' in edit && edit.category_id !== undefined) {
      validateDocId(edit.category_id, 'category_id');
    }
    if ('tag_ids' in edit && edit.tag_ids !== undefined) {
      for (const tagId of edit.tag_ids) {
        validateDocId(tagId, 'tag_id');
      }
    }
    if ('type' in edit && edit.type !== undefined) {
      if (!TRANSACTION_TYPES.includes(edit.type)) {
        throw new Error(
          `${label}: type must be one of ${TRANSACTION_TYPES.join(', ')}. Got: ${edit.type}`
        );
      }
      // Verified live (2026-06-12): setting type=INCOME or INTERNAL_TRANSFER
      // makes the server silently clear the category (no error). So a
      // category_id + INCOME/INTERNAL_TRANSFER request is self-contradictory —
      // the server would drop the category half. Reject it with an accurate
      // message instead of issuing a write that half-applies.
      if (
        (edit.type === 'INCOME' || edit.type === 'INTERNAL_TRANSFER') &&
        'category_id' in edit &&
        edit.category_id !== undefined
      ) {
        throw new Error(
          `${label}: category_id cannot be combined with type ${edit.type} — Copilot ` +
            `clears the category for INCOME/INTERNAL_TRANSFER transactions. Set the type alone ` +
            `(its category is removed), or use type REGULAR to keep/set a category.`
        );
      }
    }
    if ('reviewed' in edit && edit.reviewed !== undefined) {
      if (typeof edit.reviewed !== 'boolean') {
        throw new Error(`${label}: reviewed must be a boolean. Got: ${String(edit.reviewed)}`);
      }
    }
    if ('date' in edit && edit.date !== undefined) {
      validateWriteDate(
        edit.date,
        `${label} date`,
        `Invalid date format. Expected YYYY-MM-DD, got: ${edit.date}`
      );
    }
    if ('amount' in edit && edit.amount !== undefined) {
      if (typeof edit.amount !== 'number' || !Number.isFinite(edit.amount)) {
        throw new Error(`${label}: amount must be a finite number`);
      }
      if (Math.abs(edit.amount) > MAX_VALID_AMOUNT) {
        throw new Error(
          `${label}: amount exceeds maximum valid value (${MAX_VALID_AMOUNT}): ${edit.amount}`
        );
      }
    }
  }

  /**
   * The I/O half of an edit's field validation, shared by update_transaction
   * and update_transactions: an unknown category_id or tag_id. Everything
   * else, the id shapes included, already passed checkEditArgs before the
   * window load. Runs BEFORE any write so a rejected edit mutates nothing.
   */
  private async validateEditReferences(edit: TransactionEdit): Promise<void> {
    if ('category_id' in edit && edit.category_id !== undefined) {
      await this.validateCategoryId(edit.category_id);
    }
    if ('tag_ids' in edit && edit.tag_ids !== undefined) {
      await this.validateTagIds(edit.tag_ids);
    }
  }

  /**
   * Every argument check of one edit that needs no I/O, run by both update
   * tools before the split check's window load (#836 review): the id
   * formats (labelled, so a 200-entry batch says which entry), the routing
   * pair (both ids from a live read, or neither: half a pair is always a
   * caller mistake), and {@link validateEditFieldShapes}.
   */
  private static checkEditArgs(edit: TransactionEdit, label: string): void {
    if ((edit.account_id === undefined) !== (edit.item_id === undefined)) {
      throw new Error(
        `${label}: account_id and item_id must be passed together (both from a live read) to bypass local resolution`
      );
    }
    try {
      validateDocId(edit.transaction_id, 'transaction_id');
      if (edit.account_id !== undefined) validateDocId(edit.account_id, 'account_id');
      if (edit.item_id !== undefined) validateDocId(edit.item_id, 'item_id');
    } catch (e) {
      throw new Error(`${label}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    CopilotMoneyTools.validateEditFieldShapes(edit, label);
  }

  /**
   * Structural validation + account/item resolution for a batch of edits.
   *
   * Resolution is the reason this is batched: `resolveTransactionMeta` takes
   * an array and issues at most ONE windowed fetch for every id it can't find
   * in the meta index, so a 200-edit batch costs the same lookup as a 1-edit
   * one. Resolving per row would re-fetch the window 200 times.
   *
   * Callers supplying BOTH account_id and item_id (from a live read) bypass
   * resolution entirely for that row — that is how out-of-window transactions
   * stay writable. Both callers have already rejected half a pair and a
   * malformed id (checkEditArgs, before the window load).
   */
  private async resolveEditRoutes(
    edits: TransactionEdit[],
    notFoundSuffix: string,
    loadWindow?: () => Promise<readonly TransactionNode[]>
  ): Promise<Array<{ id: string; accountId: string; itemId: string }>> {
    const needsResolution: string[] = [];
    for (const edit of edits) {
      if (edit.account_id === undefined || edit.item_id === undefined) {
        needsResolution.push(edit.transaction_id);
      }
    }

    let metaMap = new Map<string, { accountId: string; itemId: string }>();
    if (needsResolution.length > 0) {
      const resolved = await this.resolveTransactionMeta(needsResolution, loadWindow);
      metaMap = resolved.meta;
      const missing = needsResolution.filter((id) => !metaMap.has(id));
      if (missing.length > 0) {
        throw new Error(
          CopilotMoneyTools.transactionsNotFoundMessage(missing, resolved.liveWindowMonths) +
            notFoundSuffix
        );
      }
    }

    return edits.map((edit) => {
      if (edit.account_id !== undefined && edit.item_id !== undefined) {
        return { id: edit.transaction_id, accountId: edit.account_id, itemId: edit.item_id };
      }
      const meta = metaMap.get(edit.transaction_id)!;
      return { id: edit.transaction_id, accountId: meta.accountId, itemId: meta.itemId };
    });
  }

  /**
   * Run `task` over `entries` with never more than `concurrency` in flight.
   *
   * The cap exists to avoid hammering Copilot's API — the server drops
   * offline under sustained load, so a wide fan-out trades a slow batch for a
   * failed one. Do not raise it without evidence from a live run.
   *
   * Error contract (used only by update_transactions — review_transactions
   * moved to the native bulkEditTransactions single request and does not touch
   * this pool):
   *  - `stopOnError` true  → on the FIRST failure (chronological, not lowest
   *    index) no new writes start, in-flight writes settle, and that single
   *    error is returned. Entries still queued become no-ops, so the tail of a
   *    large batch is never written — pinned by the "entries queued behind the
   *    failure are never written" test.
   *  - `stopOnError` false → every entry is attempted and all failures are
   *    returned in the order they occurred.
   *
   * Either way the caller counts its own successes inside `task`, so partial
   * success is always observable.
   */
  private static async runBoundedPool<TEntry>(
    entries: readonly TEntry[],
    concurrency: number,
    stopOnError: boolean,
    task: (entry: TEntry, index: number) => Promise<void>
  ): Promise<Array<{ index: number; error: unknown }>> {
    // The `as` cast is load-bearing under TS strict: a bare `= []` lets
    // control-flow analysis narrow the element type and forget the annotation,
    // which then breaks the `instanceof` checks callers run on `.error`.
    const failures: Array<{ index: number; error: unknown }> = [] as Array<{
      index: number;
      error: unknown;
    }>;

    // pLimit queues FIFO and releases its slot on either settlement, so tasks
    // start in index order and a rejection never strands the pool. It has no
    // early-exit of its own — stopOnError is implemented by having each task
    // check for a recorded failure at the moment it finally gets a slot, which
    // turns "stop" into "every queued write becomes a no-op" without needing to
    // cancel anything.
    const limit = pLimit(concurrency);
    await Promise.all(
      entries.map((entry, idx) =>
        limit(async () => {
          // mutation-guard: update_transactions stops on first failure
          if (stopOnError && failures.length > 0) return;
          try {
            await task(entry, idx);
          } catch (e) {
            // Under stopOnError an already-in-flight write can also fail after
            // the first one was recorded; keep only the first so the error
            // surfaced to the caller is deterministic.
            if (stopOnError && failures.length > 0) return;
            failures.push({ index: idx, error: e });
          }
        })
      )
    );
    return failures;
  }

  /**
   * Update one or more fields on a transaction in a single atomic write.
   *
   * Supported fields: name, category_id, note, tag_ids, type, reviewed.
   * Omitted fields are preserved. note="" clears the note. tag_ids=[] clears
   * all tags. type=INCOME/INTERNAL_TRANSFER clears the category server-side
   * (so category_id can't be combined with them). reviewed sets the
   * reviewed-state of a single transaction. Other legacy fields (excluded,
   * internal_transfer, goal_id) are not writable through the GraphQL
   * EditTransaction mutation and were removed from this tool when the backend
   * was migrated.
   *
   * Routing bypass: when the caller supplies BOTH account_id and item_id
   * (taken from a live read), they are forwarded verbatim and local
   * resolution is skipped entirely — same defensive "caller-supplied triple"
   * contract as delete_transaction / split_transaction. This lets writes
   * reach transactions outside the resolution window; the server still
   * validates the full (id, accountId, itemId) binding (see the
   * Mutation.editTransaction:routing ledger entry), so a wrong pair fails
   * loudly rather than editing a different transaction.
   */
  async updateTransaction(args: TransactionEdit): Promise<{
    success: true;
    transaction_id: string;
    updated: string[];
  }> {
    const client = this.getGraphQLClient();
    const { transaction_id } = args;

    rejectUnknownEditKeys(args, 'update_transaction');

    // Require at least one mutable field besides transaction_id. The routing
    // ids (account_id/item_id) address the write — they are not edits.
    if (mutableEditKeys(args).length === 0) {
      throw new Error('update_transaction requires at least one field to update');
    }

    // Pure argument checks before any I/O (#836 review): ids, the routing
    // pair, and every field check that needs no lookup. An input no retry can
    // fix must not pay the window load, or be reported as a failed one.
    CopilotMoneyTools.checkEditArgs(args, 'update_transaction');

    // Routing bypass: a caller-supplied account_id + item_id pair (from a
    // live read) is forwarded verbatim — no local resolution, so writes can
    // reach transactions outside the resolution window.
    // One window load serves the split-parent check and routing resolution.
    // The check runs first: the window omits a split parent that still has
    // children, so resolution would answer "not found" and recommend a
    // routing bypass the check then refuses (#836).
    const loadWindow = this.sharedWindowLoad();
    await this.refuseSplitParentBalanceEdit(args, 'update_transaction', loadWindow);
    const [route] = await this.resolveEditRoutes(
      [args],
      ' Pass account_id and item_id (from a live read) to write anyway.',
      loadWindow
    );
    const resolvedAccountId = route!.accountId;
    const resolvedItemId = route!.itemId;

    // The category and tag lookups (runs BEFORE any write for atomicity);
    // every other field check ran in checkEditArgs, before the window load.
    await this.validateEditReferences(args);

    try {
      const result = await editTransaction(client, {
        id: transaction_id,
        accountId: resolvedAccountId,
        itemId: resolvedItemId,
        input: buildEditInput(args),
      });
      // Map GraphQL field names back to MCP API names in the response.
      const updated = Object.keys(result.changed).map((k) => EDIT_GRAPHQL_TO_API_NAME[k] ?? k);

      const patch = buildEditCachePatch(args, result.transaction);
      if (Object.keys(patch).length > 0) {
        this.db.patchCachedTransaction(transaction_id, patch);
      }
      // Live cache: patch from the server's returned row, not the local patch
      // (#821 — the snake_case patch never matched the camelCase node).
      this.liveDb?.upsertLiveTransaction(result.transaction, {
        refusalMonths: CopilotMoneyTools.monthOf(args.date),
      });
      this.afterTransactionWrite();

      return {
        success: true,
        transaction_id: result.id,
        updated,
      };
    } catch (e) {
      // A date edit may have moved the row to another month: drop that one too.
      this.invalidateAfterFailedWrite([transaction_id], CopilotMoneyTools.monthOf(args.date));
      if (e instanceof GraphQLError) {
        throw new Error(graphQLErrorToMcpError(e), { cause: e });
      }
      throw e;
    }
  }

  /**
   * Apply many independent transaction edits in one call.
   *
   * Why this exists: `update_transaction` writes one row per MCP tool call,
   * and one tool call costs one agent turn. A cleanup pass over a few hundred
   * transactions therefore burned a few hundred turns (and re-read the whole
   * context each time) to issue a few hundred sub-second mutations. The GraphQL
   * cost was never the problem; the turn count was. This tool collapses N edits
   * into one call while leaving the per-row write path byte-identical.
   *
   * Each entry is the same shape `update_transaction` takes and gets the same
   * validation, field mapping, and optimistic cache patch — arity is the only
   * difference.
   *
   * Ordering guarantees, in the order they run:
   *  1. Every check that needs no I/O (checkEditArgs): structure, the id
   *     formats, the routing pair, and every field's shape (name, type and
   *     its category contradiction, reviewed, date, amount).
   *  2. The split-parent check on amount/date/type edits (#836).
   *  3. Account/item resolution for the WHOLE batch. Steps 2 and 3 share one
   *     windowed fetch, not one per row.
   *  4. The category and tag lookups for every edit (validateEditReferences),
   *     the only field checks left.
   *  5. Only then does the first write leave the process.
   * So a malformed edit at index 40 fails the call without edit 0 having been
   * written. This is the batch-level extension of the singular tool's
   * "validation runs BEFORE any write for atomicity" property, and it is the
   * reason validation errors are always all-or-nothing regardless of
   * `continue_on_error`.
   *
   * `continue_on_error` governs GraphQL write failures only:
   *  - false (default) → first failure stops the batch: queued entries are
   *    never written and the call throws. Use when the edits are a coherent
   *    unit.
   *  - true            → every edit is attempted; failures come back in
   *    `failures[]`. Use for backlog sweeps where a few unwritable rows
   *    shouldn't strand the rest.
   * In continue_on_error mode `updated_count` and `results[]` reflect exactly
   * what was written, so callers retry `failures[]` rather than the whole set.
   * In default mode the call THROWS, so the client sees only the error string
   * and its counts — not `results[]`. Every edit is an absolute assignment, so
   * re-running the whole batch is safe (hence `idempotentHint: true`).
   */
  async updateTransactions(args: {
    edits: TransactionEdit[];
    continue_on_error?: boolean;
  }): Promise<{
    success: boolean;
    updated_count: number;
    results: Array<{ transaction_id: string; updated: string[] }>;
    failures: Array<{ transaction_id: string; error: string }>;
  }> {
    const client = this.getGraphQLClient();
    const { edits, continue_on_error = false } = args;

    if (!Array.isArray(edits) || edits.length === 0) {
      throw new Error('update_transactions: edits must be a non-empty array');
    }
    if (edits.length > MAX_BULK_EDITS) {
      throw new Error(
        `update_transactions: edits exceeds the maximum batch size (${MAX_BULK_EDITS}): ` +
          `${edits.length}. Split the work into batches of ${MAX_BULK_EDITS} or fewer.`
      );
    }

    const label = (i: number): string => `update_transactions edits[${i}]`;

    // --- Phase 1: structural validation (no network, no writes) ---
    const seen = new Set<string>();
    edits.forEach((edit, i) => {
      if (edit === null || typeof edit !== 'object') {
        throw new Error(`${label(i)}: must be an object`);
      }
      rejectUnknownEditKeys(edit, label(i));
      if (typeof edit.transaction_id !== 'string') {
        throw new Error(`${label(i)}: transaction_id is required`);
      }
      if (mutableEditKeys(edit).length === 0) {
        throw new Error(`${label(i)} requires at least one field to update`);
      }
      // Two edits to the same row would race: the pool runs 5 wide with no
      // ordering guarantee, so the surviving value would be nondeterministic
      // and the optimistic cache patch would disagree with the server. Merge
      // them caller-side instead — one edit can set every field at once.
      if (seen.has(edit.transaction_id)) {
        throw new Error(
          `${label(i)}: duplicate transaction_id ${edit.transaction_id} — ` +
            'combine the edits for one transaction into a single entry'
        );
      }
      seen.add(edit.transaction_id);
      // Every pure check, before Phase 2's window load (#836 review).
      CopilotMoneyTools.checkEditArgs(edit, label(i));
    });

    // --- Phase 2: split parents (#836) — an amount/date/type edit of one
    // refuses the whole batch, before any write, and before routing
    // resolution: the window omits a parent that still has children, so
    // resolving first would answer "not found" and recommend the bypass this
    // check then refuses. One window load serves every edit and resolution.
    const loadWindow = this.sharedWindowLoad();
    for (const [i, edit] of edits.entries()) {
      await this.refuseSplitParentBalanceEdit(edit, label(i), loadWindow);
    }

    // --- Phase 3: routing resolution, batched (one windowed fetch) ---
    const routes = await this.resolveEditRoutes(
      edits,
      ' Pass account_id and item_id (from a live read) on those entries to write anyway, or drop them from the batch.',
      loadWindow
    );

    // --- Phase 4: the category and tag lookups for every edit, still before
    // any write (every other field check ran in Phase 1) ---
    for (const edit of edits) {
      await this.validateEditReferences(edit);
    }

    // --- Phase 5: write ---
    // Keyed by the caller's index, not push order: the pool runs 5 wide, so
    // completion order is nondeterministic and `results[]` would come back in
    // a different order for identical input. Sorted back into input order
    // below.
    const indexed: Array<{ index: number; transaction_id: string; updated: string[] }> = [];
    const entries = edits.map((edit, i) => ({ edit, route: routes[i]!, index: i }));

    const poolFailures = await CopilotMoneyTools.runBoundedPool(
      entries,
      BULK_WRITE_CONCURRENCY,
      !continue_on_error,
      async ({ edit, route, index }) => {
        let result: Awaited<ReturnType<typeof editTransaction>>;
        try {
          result = await editTransaction(client, {
            id: route.id,
            accountId: route.accountId,
            itemId: route.itemId,
            input: buildEditInput(edit),
          });
        } catch (e) {
          // Same as update_transaction (#832): the edit may have landed.
          this.invalidateAfterFailedWrite([route.id], CopilotMoneyTools.monthOf(edit.date));
          throw e;
        }
        indexed.push({
          index,
          transaction_id: result.id,
          updated: Object.keys(result.changed).map((k) => EDIT_GRAPHQL_TO_API_NAME[k] ?? k),
        });
        // Patch per success, not once at the end: on a partial batch the cache
        // must reflect the rows that actually landed and nothing else.
        const patch = buildEditCachePatch(edit, result.transaction);
        if (Object.keys(patch).length > 0) {
          this.db.patchCachedTransaction(route.id, patch);
        }
        this.liveDb?.upsertLiveTransaction(result.transaction, {
          refusalMonths: CopilotMoneyTools.monthOf(edit.date),
        });
        this.afterTransactionWrite();
      }
    );

    const results = indexed
      .sort((a, b) => a.index - b.index)
      .map(({ transaction_id, updated }) => ({ transaction_id, updated }));

    // Redacted here, where it is built: with `continue_on_error` these messages
    // are RETURNED in a success-shaped result and never pass the redaction at
    // `handleCallTool`'s catch, which only sees thrown errors.
    const failures = poolFailures.map(({ index, error }) => ({
      transaction_id: edits[index]!.transaction_id,
      // mutation-guard: a returned batch failure carries no username
      error: redactUserPaths(
        error instanceof GraphQLError
          ? graphQLErrorToMcpError(error)
          : error instanceof Error
            ? error.message
            : String(error)
      ),
    }));

    // Stop-on-error is a hard failure: throw so the caller can't mistake a
    // truncated batch for a completed one. The counts ride along on the message
    // (same contract as review_transactions) and the successful writes stand.
    if (!continue_on_error && failures.length > 0) {
      const failure = failures[0]!;
      const cause = poolFailures[0]!.error;
      throw new Error(
        `update_transactions failed at transaction_id=${failure.transaction_id} ` +
          `(${results.length}/${edits.length} succeeded): ${failure.error}`,
        { cause }
      );
    }

    return {
      success: failures.length === 0,
      updated_count: results.length,
      results,
      failures,
    };
  }

  /**
   * Create a brand-new manual transaction on an existing account.
   *
   * category_id is required for REGULAR and refused for INCOME /
   * INTERNAL_TRANSFER: an edit to those types clears the category, and a
   * create with one stores it but hides it (ledger:
   * FirestoreTransaction.type:clearsCategory), so a category sent with them
   * is lost without a word. Same rule as update_transaction, worded for a
   * create (#825). The server assigns the ID; on success we return the
   * full newly-created Transaction in the local snake_case shape so callers
   * can immediately read it without a refresh_database round-trip.
   *
   * Cache note: unlike updateTransaction which patches an existing cached
   * row, there is no existing row to patch here. A deliberate choice to
   * NOT invent a new "add to cache" code path — the next refresh_database
   * will pick the new transaction up from Copilot's sync. Callers that
   * need it immediately can use the returned `transaction` object.
   */
  async createTransaction(args: {
    account_id: string;
    item_id: string;
    name: string;
    date: string;
    amount: number;
    /** Required for REGULAR; must be omitted for INCOME / INTERNAL_TRANSFER. */
    category_id?: string;
    type: TransactionType;
    tag_ids?: string[];
    note?: string;
    recurring_id?: string;
  }): Promise<{
    success: true;
    transaction_id: string;
    transaction: WriteTransactionRow;
  }> {
    const client = this.getGraphQLClient();
    const { account_id, item_id, name, date, amount, category_id, type } = args;

    // Defense-in-depth validation (the MCP dispatch layer already schema-checks,
    // but methods are callable directly from tests/code).
    validateDocId(account_id, 'account_id');
    validateDocId(item_id, 'item_id');

    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) {
      throw new Error('name must be a non-empty string');
    }

    validateWriteDate(
      date,
      'create_transaction date',
      `Invalid date format. Expected YYYY-MM-DD, got: ${date}`
    );

    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new Error('amount must be a finite number');
    }
    // Match the local Transaction Zod schema's invariant (models/transaction.ts)
    // so a server-accepted amount will also round-trip through the cache.
    if (Math.abs(amount) > MAX_VALID_AMOUNT) {
      throw new Error(`amount exceeds maximum valid value (${MAX_VALID_AMOUNT}): ${amount}`);
    }

    // .includes() on the `as const` tuple needs widening to string[] to accept
    // an arbitrary string arg (TS narrows the tuple's element type otherwise).
    if (!(TRANSACTION_TYPES as readonly string[]).includes(type)) {
      throw new Error(`type must be one of: ${TRANSACTION_TYPES.join(', ')}. Got: ${type}`);
    }

    // INCOME / INTERNAL_TRANSFER have no category in Copilot: an edit to those
    // types clears it (verified), and a create with one stores it but hides it
    // (GraphQL and the web show none; FirestoreTransaction.type:clearsCategory).
    // Either way a category_id sent with them is lost without a word, so the
    // pair is refused, as update_transaction and bulk_edit_transactions refuse
    // it (#825). REGULAR still needs one. Runs before the id's shape check, so
    // `category_id: ""` with INCOME gets this rule rather than a format error.
    if (type === 'INCOME' || type === 'INTERNAL_TRANSFER') {
      if (category_id !== undefined) {
        throw new Error(
          `create_transaction: category_id cannot be combined with type ${type} — Copilot ` +
            `clears the category for INCOME/INTERNAL_TRANSFER transactions. Omit category_id ` +
            `for these types, or use type REGULAR to set a category.`
        );
      }
    } else if (category_id === undefined) {
      throw new Error(
        `create_transaction: category_id is required for type ${type} — only INCOME and ` +
          `INTERNAL_TRANSFER transactions are created without a category.`
      );
    }

    // Shape checks first: they are local, the existence checks below may fetch.
    if (category_id !== undefined) validateDocId(category_id, 'category_id');
    for (const tagId of args.tag_ids ?? []) {
      validateDocId(tagId, 'tag_id');
    }
    if (args.recurring_id !== undefined) {
      validateDocId(args.recurring_id, 'recurring_id');
    }

    // Reference validation (runs BEFORE any write for atomicity). Copilot
    // stores an unknown category id verbatim (#846), so this is the only guard.
    // mutation-guard: create_transaction validates its category id
    if (category_id !== undefined) await this.validateCategoryId(category_id);
    if (args.tag_ids !== undefined) {
      await this.validateTagIds(args.tag_ids);
    }

    const input: CreateTransactionInput = {
      name: trimmedName,
      date,
      amount,
      // CreateTransactionInput.categoryId is non-null (ID!), so a type without a
      // category sends an empty id, which ends in the state the app shows for
      // these types anyway (ledger: Mutation.createTransaction:empty-category-for-income,
      // verified once by a live probe).
      categoryId: category_id ?? '',
      type,
    };
    if (args.tag_ids !== undefined) input.tagIds = args.tag_ids;
    if (args.note !== undefined) input.userNotes = args.note;
    if (args.recurring_id !== undefined) input.recurringId = args.recurring_id;

    try {
      const tx = await gqlCreateTransaction(client, {
        accountId: account_id,
        itemId: item_id,
        input,
      });
      // The response row, in get_transactions_live's field names (#825).
      // Every field comes from the response except tag_ids when the response
      // carries no usable tags array: then it is the requested list.
      const transaction = toWriteTransactionRow(tx, args.tag_ids);

      // Live cache write-through (#820): put the server's row into its month
      // so a read of an already-cached month shows it (a no-op when the month
      // is not cached — the next read fetches it). This also feeds the meta
      // index, so an immediate follow-up write on the new transaction
      // resolves without a network fetch; the empty-routing-id guard (#518)
      // lives inside upsertLiveTransaction.
      // mutation-guard: create_transaction writes through to the live cache
      this.liveDb?.upsertLiveTransaction(tx, {
        insert: true,
        refusalMonths: CopilotMoneyTools.monthOf(args.date),
      });
      this.afterTransactionWrite();

      return {
        success: true,
        transaction_id: tx.id,
        transaction,
      };
    } catch (e) {
      // No id exists to find the row by, so its month is named outright (#832).
      this.invalidateAfterFailedWrite([], CopilotMoneyTools.monthOf(date));
      if (e instanceof GraphQLError) {
        throw new Error(graphQLErrorToMcpError(e), { cause: e });
      }
      throw e;
    }
  }

  /**
   * Permanently delete a transaction.
   *
   * DESTRUCTIVE: there is no soft-delete and no undo. The mutation
   * requires all three IDs; the tool deliberately does NOT look up
   * account_id / item_id from transaction_id in the local cache (which
   * is what update_transaction does). The contract is: require all
   * three from the caller, and let a wrong one produce the server's
   * "Transaction not found" error rather than silently deleting a
   * different transaction that matches on transaction_id alone.
   *
   * Cache: on success we evict the row from the in-memory transaction
   * cache via a small focused helper (patchCachedTransactionDelete) so
   * subsequent get_transactions reflect the delete without waiting for
   * refresh_database. On server-returned-false the cache is intentionally
   * untouched — the local state must not drift away from whatever
   * Copilot's server thinks is real. On a thrown error the local row is
   * kept too, but the live month holding it is dropped (#832): the delete
   * may have landed before the error, so the next live read asks the server.
   *
   * Note on Plaid re-sync: Plaid-connected transactions may re-appear
   * on the source account's next sync, but user-side metadata
   * (category override, tags, notes, reviewed state, goal link, split
   * children) will NOT be preserved. This tool makes no attempt to
   * detect Plaid vs manual — the warning belongs in the tool
   * description, not in runtime logic.
   *
   * Split parents (#822, #842): before sending anything it checks the
   * split record and the caches, and REFUSES a known split parent — see
   * splitParentEvidence(). Routing ids are still never looked up.
   *
   * Cost, per call (not just the first): a recorded parent or a cached child
   * row refuses with no request. Otherwise the local cache's split evidence
   * is read, which runs the same batch decode every cache-mode read uses
   * when nothing has loaded the local cache yet, or when it is past the
   * cache TTL (5 minutes by default; COPILOT_CACHE_TTL_MINUTES, where 0
   * means always stale), attempted at most once per TTL and at least a
   * minute apart, failed attempts included (splitEvidenceRereadMs). So in
   * live mode a delete pays for at most one decode attempt per TTL, or per
   * minute at a TTL of 0, and nothing in between. Cache-only mode (test-only
   * today, since --write implies --live-reads) also reads rows through
   * getAllTransactions(), which can attempt a decode of its own. A decode
   * usually takes seconds, but its worst case is the decode timeout
   * (getDecodeTimeoutMs, 90 s by default), which can outlast an MCP client's
   * request timeout. Nothing is sent until the check resolves, so a
   * client-side timeout leaves no half-done delete, and the decode it
   * started keeps running for the next call. A decode that times out or
   * fails adds no new evidence, but loses none either: the ids earlier
   * decodes named still refuse, alongside the split record and the live
   * checks.
   * Then the write-resolve window is loaded — the same windowed fetch write
   * resolution uses. Cold months are served from the cache, but the
   * live-tier months (the recent ones, TTL 0) are refetched: typically one
   * or two Transactions requests, a full window fetch when nothing is cached
   * yet. A load is reused for WINDOW_MEMO_MS (15 s) by any later call with no
   * write but deletes in between (#838), so a burst of deletes pays for one.
   * Delete is rare and destructive, which is what
   * makes the decode worth paying here when every other write path avoids it.
   */
  async deleteTransaction(args: {
    transaction_id: string;
    account_id: string;
    item_id: string;
  }): Promise<{
    success: true;
    transaction_id: string;
    deleted: boolean;
  }> {
    const client = this.getGraphQLClient();
    const { transaction_id, account_id, item_id } = args;

    // Defense-in-depth — the MCP schema already validates presence and
    // type, but the method is directly callable from tests and other code.
    validateDocId(transaction_id, 'transaction_id');
    validateDocId(account_id, 'account_id');
    validateDocId(item_id, 'item_id');

    // Split parents (#822): deleting one makes the server credit the parent's
    // amount back to the account a second time — the children already replaced
    // it — so the balance ends wrong by that amount (and stays wrong on a manual
    // account). That holds after its children are deleted too (#842). There is
    // no unsplit mutation, so the only safe answer is to refuse before anything
    // is sent. Best-effort: a parent split in the app, whose children no cache
    // holds, is not known here.
    const evidence = await this.splitParentEvidence(transaction_id);
    // mutation-guard: delete_transaction refuses a split parent
    if (evidence.isParent) {
      throw new Error(
        `Transaction ${transaction_id} is a split parent and cannot be deleted: Copilot would ` +
          `credit its amount back to the account a second time, leaving the account balance ` +
          `wrong. Delete the child transactions instead. The parent stays hidden while it has ` +
          `children; once they are all deleted it reappears as an ordinary transaction, and it ` +
          `still cannot be deleted safely. There is no unsplit operation.`
      );
    }
    // Deleting a child: remember its parent BEFORE the delete is sent, so the
    // parent stays known after its last child is gone — including when the
    // delete then fails: a real parent is a parent either way.
    if (evidence.parentOfTarget) this.recordSplitParent(evidence.parentOfTarget);

    try {
      const deleted = await gqlDeleteTransaction(client, {
        id: transaction_id,
        accountId: account_id,
        itemId: item_id,
      });

      // Only evict the cache if the server actually deleted. If it says
      // false (no error, no delete), leaving the cache intact keeps local
      // state honest with whatever the server thinks is real.
      if (deleted) {
        this.db.patchCachedTransactionDelete(transaction_id);
        // Also hides the row from the memoized window (#838): split's parent
        // lookup reads it on a cache miss.
        this.evictLiveTransaction(transaction_id);
        this.afterTransactionWrite();
      }

      return {
        success: true,
        transaction_id,
        deleted,
      };
    } catch (e) {
      // The row may be gone server-side or not (#832).
      this.invalidateAfterFailedWrite([transaction_id]);
      if (e instanceof GraphQLError) {
        throw new Error(graphQLErrorToMcpError(e), { cause: e });
      }
      throw e;
    }
  }

  /**
   * What the split record and the caches know about `id` as a split (#822):
   * whether it is a split parent, and — when it is a split child — its parent.
   *
   * No evidence is ever negative (#842). Copilot's Transaction carries no
   * split marker: while a parent has children the Transactions query omits
   * it, and once they are all deleted it comes back as an ordinary row
   * (parentId null) that still double-credits when deleted (ledger:
   * Transaction.parentId:childlessParentReappears). So a row for `id` itself
   * proves nothing, and every source below can only add a refusal.
   *
   * Both modes:
   *   1. The split record (this process, plus the persisted record) — refusal
   *      with no request.
   *   2. The local cache: any transaction document, SOFT-DELETED ONES
   *      INCLUDED, whose parent_transaction_id is `id`, or `id`'s own document
   *      carrying children_transaction_ids. A deleted child keeps its
   *      parent_transaction_id in the cache (ledger:
   *      FirestoreTransaction.parent_transaction_id:survivesSoftDelete), so
   *      this is what still knows, after a restart, a parent whose children
   *      were deleted in the app or by an earlier process. The ids are the
   *      union over every decode this process ran, so they never shrink.
   *      Decodes when nothing is loaded yet or the cache is past its TTL (5
   *      minutes by default, 0 = always), at most once per TTL and at least
   *      a minute apart, failed attempts included; worst case the decode
   *      timeout (see deleteTransaction).
   *      An unreadable or timed-out cache adds nothing for that call rather
   *      than blocking the write; what earlier decodes named still refuses.
   *
   * Live mode (liveDb present — the shipped CLI always runs writes this way,
   * since --write implies --live-reads) adds, before the local cache (free)
   * and after it (one fetch):
   *   - a cached window row whose parentId is `id` (no request);
   *   - the write-resolve window (the same windowed fetch
   *     resolveTransactionMeta uses), checked for a child row. A failed fetch
   *     is reported as `windowChecked: false` and the check proceeds on what
   *     is already held; each caller decides. delete_transaction proceeds
   *     (refusing would make delete unusable offline); the #836 writes refuse
   *     (refuseUncheckedSplitTarget).
   *
   * Callers: delete_transaction, the amount/date/type edits of
   * update_transaction(s), add_transaction_to_recurring, create_recurring,
   * split_transaction and bulk_edit_transactions with a type. Each pays the
   * local-cache read above, which can decode (worst case the decode
   * timeout), and the window load.
   *
   * `parentOfTarget`: a window row for `id`, when present, decides it over
   * local rows, which may be stale. `windowChecked` is absent when no window
   * fetch was needed (a refusal from cheaper evidence, or cache-only mode).
   */
  private async splitParentEvidence(
    id: string,
    loadWindow: () => Promise<readonly TransactionNode[]> = () => this.loadWriteResolveWindow()
  ): Promise<{ isParent: boolean; parentOfTarget: string | null; windowChecked?: boolean }> {
    // mutation-guard: a fresh row never retires a split record
    if (this.isRecordedSplitParent(id)) return { isParent: true, parentOfTarget: null };
    if (this.liveDb?.hasSplitChildOf(id)) return { isParent: true, parentOfTarget: null };

    // mutation-guard: delete reads the local cache's split evidence in live mode
    const local = await this.localSplitEvidence(id);
    if (local.isParent || !this.liveDb) return local;

    let fetched: readonly TransactionNode[] = [];
    let windowChecked = true;
    try {
      fetched = await loadWindow();
    } catch {
      // Proceed on what the caches and the record hold; the caller decides
      // whether an unchecked window is acceptable.
      windowChecked = false;
    }
    // Rows-fallback as in resolveParentSnapshot: the window cache can LRU-evict
    // early months during a large fetch.
    const own =
      this.liveDb.lookupTransactionNodes([id]).get(id) ?? fetched.find((r) => r.id === id);
    // hasSplitChildOf is re-checked after the fetch on purpose: an ingested
    // boundary-month row can sit outside the date filter `fetched` was built
    // from, so neither check subsumes the other.
    const isParent = this.liveDb.hasSplitChildOf(id) || fetched.some((r) => r.parentId === id);
    return {
      isParent,
      parentOfTarget: own ? (own.parentId ?? null) : local.parentOfTarget,
      windowChecked,
    };
  }

  /**
   * Split evidence for `id` in the local cache (#822, #842): the ids its
   * documents have named as split parents this process, soft-deleted
   * children included (CopilotDatabase.getSplitParentIds, a union that never
   * shrinks), and its rows — a parent when its own
   * row carries children_transaction_ids or any row's parent_transaction_id
   * is `id`; `parentOfTarget` is its own row's parent_transaction_id. The
   * rows matter when no full decode produced the id set (injected data); in
   * live mode, or after a failed decode, only rows already in memory are
   * read. An unreadable local cache yields no new evidence rather than an
   * error.
   */
  private async localSplitEvidence(
    id: string
  ): Promise<{ isParent: boolean; parentOfTarget: string | null }> {
    let readable = true;
    try {
      await this.db.getSplitParentIds();
    } catch {
      // No readable local cache (unreadable, timed out). The accumulated set
      // keeps every id earlier decodes named — a failed reload never leaves
      // less evidence than the call started with — and the record and the
      // live checks still apply.
      readable = false;
    }
    if (this.db.peekSplitParentIds().has(id)) return { isParent: true, parentOfTarget: null };
    let rows: readonly Transaction[] = [];
    try {
      // Rows already in memory only, in live mode or after a failed decode:
      // the decode above loaded them when it ran, and neither a second full
      // read (the per-collection fallback) nor a retried decode is worth
      // paying on a write's split check.
      // The in-memory array first in cache-only mode too: getAllTransactions
      // returns a fresh copy per call, which would defeat the per-array split
      // index (one rebuild per id). Same content; the full read only when the
      // cache has not been loaded.
      rows =
        this.liveDb || !readable
          ? (this.db.peekLoadedTransactions() ?? [])
          : (this.db.peekLoadedTransactions() ?? (await this.db.getAllTransactions()));
    } catch {
      // Same as above.
    }
    return this.splitEvidenceInRows(id, rows);
  }

  /**
   * One-pass index of a row array's split facts, cached per array (#836
   * review): a batch checking N ids against tens of thousands of local rows
   * would otherwise scan them N times on the event loop. What keeps it
   * current: the local cache REPLACES its row array on every reload,
   * injection and delete (a new WeakMap key), and no field patch writes the
   * parent/children fields it reads (pinned by a test over both patch
   * builders). The length check is a second line, not the mechanism.
   * `parentOf` holds split children only: an absent id reads as no parent.
   */
  private readonly splitRowIndexes = new WeakMap<
    readonly Transaction[],
    { length: number; parents: Set<string>; parentOf: Map<string, string> }
  >();

  private splitRowIndex(rows: readonly Transaction[]): {
    parents: Set<string>;
    parentOf: Map<string, string>;
  } {
    const cached = this.splitRowIndexes.get(rows);
    if (cached && cached.length === rows.length) return cached;
    const parents = new Set<string>();
    const parentOf = new Map<string, string>();
    for (const t of rows) {
      if (t.parent_transaction_id) parents.add(t.parent_transaction_id);
      if ((t.children_transaction_ids?.length ?? 0) > 0) parents.add(t.transaction_id);
      // First row naming a parent wins, as the scan this replaces did.
      if (t.parent_transaction_id && !parentOf.has(t.transaction_id)) {
        parentOf.set(t.transaction_id, t.parent_transaction_id);
      }
    }
    const index = { length: rows.length, parents, parentOf };
    this.splitRowIndexes.set(rows, index);
    return index;
  }

  /** The row half of localSplitEvidence (#822): same predicate, via the index. */
  private splitEvidenceInRows(
    id: string,
    rows: readonly Transaction[]
  ): { isParent: boolean; parentOfTarget: string | null } {
    const { parents, parentOf } = this.splitRowIndex(rows);
    if (parents.has(id)) return { isParent: true, parentOfTarget: null };
    return { isParent: false, parentOfTarget: parentOf.get(id) ?? null };
  }

  /**
   * Manually link an existing transaction to an existing recurring series.
   *
   * Use case: Copilot's auto-detection occasionally misses a rent /
   * subscription / etc. charge that should be grouped with a recurring.
   * This tool wraps the GraphQL AddTransactionToRecurring mutation with
   * its single `recurringId` input and returns the just-linked transaction
   * (now with its `recurring_id` populated).
   *
   * Contract: all four IDs are required and forwarded verbatim — the tool
   * does NOT re-resolve account_id / item_id from the cache via
   * transaction_id. A typo in any one field surfaces as a server-side
   * "Transaction not found" rather than silently attaching the wrong
   * transaction. Same defensive choice as delete_transaction.
   *
   * Side effect: the server also sets the row's category to the recurring's
   * category (ledger: Mutation.addTransactionToRecurring:sets-category).
   *
   * Split parents (#836): a known split parent is refused before sending, as
   * is any target when the split check cannot load the write-resolve window
   * (refuseUncheckedSplitTarget). The check pays what delete's does: the
   * local-cache split evidence and one window load.
   *
   * Cache: unlike create_transaction (where there is nothing to patch) and
   * unlike delete_transaction (which evicts the row), here the transaction
   * already exists in the cache — we patch `recurring_id`, and the category
   * the server returned, on the cached row via `patchCachedTransaction` so
   * subsequent get_transactions reads reflect the link without waiting for a
   * refresh_database cycle (#848). The live cache takes the server's row.
   */
  async addTransactionToRecurring(args: {
    transaction_id: string;
    account_id: string;
    item_id: string;
    recurring_id: string;
  }): Promise<{
    success: true;
    transaction_id: string;
    transaction: WriteTransactionRow;
  }> {
    const client = this.getGraphQLClient();
    const { transaction_id, account_id, item_id, recurring_id } = args;

    // Defense-in-depth — the MCP schema already validates presence and
    // type, but the method is directly callable from tests and other code.
    validateDocId(transaction_id, 'transaction_id');
    validateDocId(account_id, 'account_id');
    validateDocId(item_id, 'item_id');
    validateDocId(recurring_id, 'recurring_id');

    // Split parents (#836): whether the recurring then counts the parent's
    // amount as well as its children's is unverified. Refused before sending.
    const evidence = await this.splitParentEvidence(transaction_id);
    // mutation-guard: a split parent is not linked to a recurring
    if (evidence.isParent) {
      throw new Error(
        `add_transaction_to_recurring: transaction ${transaction_id} is a split parent and is ` +
          `not linked. What Copilot does when a split parent joins a recurring is unverified: ` +
          `the recurring could count the parent's amount on top of its children's, the same ` +
          `money twice. Link the child transactions instead.`
      );
    }
    CopilotMoneyTools.refuseUncheckedSplitTarget(
      evidence,
      transaction_id,
      'add_transaction_to_recurring'
    );

    try {
      const tx = await gqlAddTransactionToRecurring(client, {
        id: transaction_id,
        accountId: account_id,
        itemId: item_id,
        input: { recurringId: recurring_id },
      });

      // The response row, in get_transactions_live's field names (#825) —
      // the same mapper as createTransaction's (TransactionFields).
      const transaction = toWriteTransactionRow(tx);

      // Optimistic cache patch: the transaction already exists in the
      // cache, so update its recurring_id and its category to match what the
      // server now says — linking sets the row's category to the recurring's
      // (#848). Both come from the returned row, not the request. A response
      // with NO category key (drift) leaves the cached category alone; an
      // EMPTY one is Copilot's "no category" and is patched in, hence the
      // typeof check rather than a truthiness one. No-op (returns false) if
      // the cache is unloaded or the id is absent — both acceptable, same as
      // delete_transaction's eviction-is-a-no-op contract. The returned
      // `transaction` is mapped from the response alone, never the request:
      // field for field, except `internal_transfer`, which it derives from
      // the returned type, as the live mapper does.
      const linkedType = knownTransactionType(tx.type);
      this.db.patchCachedTransaction(transaction_id, {
        recurring_id: tx.recurringId ?? recurring_id,
        // Same rule as serverCategory, but with no fallback: a missing
        // category leaves the cached one alone.
        ...(typeof tx.categoryId === 'string' ? { category_id: tx.categoryId } : {}),
        // Linking is not known to change the type, but the returned row says
        // what it is, so the type-derived flags follow it like the category.
        ...(linkedType !== undefined ? typeFlagsPatch(linkedType) : {}),
      });
      // Live cache: the server's row, which already carries the new category.
      this.liveDb?.upsertLiveTransaction(tx);
      this.afterTransactionWrite();

      return {
        success: true,
        transaction_id,
        transaction,
      };
    } catch (e) {
      this.invalidateAfterFailedWrite([transaction_id]);
      if (e instanceof GraphQLError) {
        throw new Error(graphQLErrorToMcpError(e), { cause: e });
      }
      throw e;
    }
  }

  /**
   * Split one parent transaction into N child transactions.
   *
   * Wraps the GraphQL `splitTransaction` mutation. Each split entry requires
   * `amount` + `category_id`; `name` and `date` default to the parent's
   * values if omitted by the caller. The sum of all children's `amount`
   * fields must equal the parent's `amount` (server-enforced; we also
   * validate client-side up to a small floating-point epsilon so callers
   * get a clear local error before a round-trip). When the parent cannot
   * be resolved locally (outside the resolution window) the split still
   * proceeds if every entry carries an explicit `name` and `date` — no
   * parent-derived defaults are needed then, and the sum check is deferred
   * to the server.
   *
   * Contract: all three parent IDs (transaction_id, account_id, item_id)
   * are required and forwarded verbatim. Same defensive stance as
   * delete_transaction / add_transaction_to_recurring — we do NOT re-resolve
   * account_id / item_id from the cache via transaction_id. A typo in any
   * field surfaces as a server-side "Transaction not found" rather than
   * silently splitting a different transaction.
   *
   * Cache: on success we evict the parent row from the in-memory
   * transaction cache. Copilot's UI hides the parent after a split (the
   * server sets categoryId to "" and adds children_transaction_ids to the
   * parent doc), so cached reads should stop surfacing it. We deliberately
   * do NOT attempt to insert the new children into the cache — there's no
   * insert helper, the ids are brand-new server-assigned, and the next
   * refresh_database will pick them up. Callers that need the children
   * immediately can read them from the returned `children` array.
   *
   * Reversal: there is no unsplit on the server (probed 2026-10-15: twenty
   * candidate names incl. unsplitTransaction, mergeTransaction(s), undoSplit,
   * removeSplit, deleteSplit(Transaction), revertSplit — none exist). Deleting
   * the parent is NOT an undo: the server credits its amount back a second
   * time and the balance ends wrong (#822), so delete_transaction refuses a
   * known split parent. To remove the split's effect, delete the children;
   * the parent then reappears as an ordinary row and stays undeletable
   * (#842).
   *
   * Per-split metadata (tags, notes, reviewed state) is not accepted by
   * the server's SplitTransactionInput — follow-up edits require per-child
   * update_transaction calls.
   */
  async splitTransaction(args: {
    transaction_id: string;
    account_id: string;
    item_id: string;
    splits: Array<{
      name?: string;
      date?: string;
      amount: number;
      category_id: string;
    }>;
  }): Promise<{
    success: true;
    parent_transaction_id: string;
    child_transaction_ids: string[];
    parent: WriteTransactionRow;
    children: WriteTransactionRow[];
  }> {
    const client = this.getGraphQLClient();
    const { transaction_id, account_id, item_id, splits } = args;

    // Defense-in-depth — the MCP schema already validates presence/type,
    // but the method is directly callable from tests and other code.
    validateDocId(transaction_id, 'transaction_id');
    validateDocId(account_id, 'account_id');
    validateDocId(item_id, 'item_id');

    if (!Array.isArray(splits) || splits.length < 2) {
      throw new Error('splits must have at least 2 entries — a split-into-one is a no-op');
    }

    // Per-entry validation — runs BEFORE cache lookup/sum check so invalid
    // input fails fast and uniformly.
    for (const [i, s] of splits.entries()) {
      validateDocId(s.category_id, 'category_id');

      if (typeof s.amount !== 'number' || !Number.isFinite(s.amount)) {
        throw new Error(`splits[${i}].amount must be a finite number`);
      }
      // Match the local Transaction Zod schema's invariant — mirrors create_transaction.
      if (Math.abs(s.amount) > MAX_VALID_AMOUNT) {
        throw new Error(
          `splits[${i}].amount exceeds maximum valid value (${MAX_VALID_AMOUNT}): ${s.amount}`
        );
      }

      if (s.date !== undefined) {
        validateWriteDate(
          s.date,
          `splits[${i}].date`,
          `splits[${i}].date: Expected YYYY-MM-DD, got: ${s.date}`
        );
      }

      if (s.name !== undefined) {
        const trimmed = s.name.trim();
        if (!trimmed) {
          throw new Error(`splits[${i}].name must be a non-empty string`);
        }
      }
    }

    // Category references, before anything is resolved or sent: the server
    // stores a child's unknown category id verbatim (#846). One check per
    // distinct id; the categories list is cached, so this is one read.
    // mutation-guard: split_transaction validates child category ids
    for (const categoryId of new Set(splits.map((s) => s.category_id))) {
      await this.validateCategoryId(categoryId);
    }

    // Re-splitting a split parent, or splitting a split child (#836): what the
    // server does to the account balance is unverified for both, and either
    // could count the same money twice. Refused before anything is sent.
    // One window load serves this check and the parent resolution below.
    const loadWindow = this.sharedWindowLoad();
    const splitEvidence = await this.splitParentEvidence(transaction_id, loadWindow);
    // mutation-guard: a split parent is not split again
    if (splitEvidence.isParent) {
      throw new Error(
        `split_transaction: transaction ${transaction_id} is already a split parent and is not ` +
          `split again. What Copilot does to the account balance on a re-split is unverified, ` +
          `and it could move the balance twice. Split one of its children instead, or edit the ` +
          `children's amounts and categories. There is no unsplit operation.`
      );
    }
    // mutation-guard: a split child is not split
    if (splitEvidence.parentOfTarget) {
      throw new Error(
        `split_transaction: transaction ${transaction_id} is a split child (of ` +
          `${splitEvidence.parentOfTarget}) and is not split. What Copilot does to the account ` +
          `balance when a split child is split again is unverified, and it could count the ` +
          `amount twice. Edit the child's amount and category instead.`
      );
    }
    // Checked last, so a refusal from evidence already held names the reason.
    CopilotMoneyTools.refuseUncheckedSplitTarget(
      splitEvidence,
      transaction_id,
      'split_transaction'
    );

    // Resolve the parent's CONTENT (amount for the sum check, name/date for
    // defaults) — live-first via the window cache / windowed fetch; local
    // cache only in degraded (no-liveDb) mode. Routing ids are NOT resolved
    // here: the schema requires the caller-supplied triple. See
    // resolveParentSnapshot().
    //
    // An unresolvable parent (outside the resolution window) is only fatal
    // when a split needs a parent-derived default: with an explicit name and
    // date on every split, nothing else is read from the snapshot and the
    // amount-sum check is deferred to the server (which enforces it anyway).
    const { snapshot: parentTxn, liveWindowMonths } = await this.resolveParentSnapshot(
      transaction_id,
      loadWindow
    );
    if (!parentTxn && splits.some((s) => s.name === undefined || s.date === undefined)) {
      throw new Error(
        CopilotMoneyTools.transactionsNotFoundMessage([transaction_id], liveWindowMonths) +
          ' To split anyway, pass an explicit name and date on every split — the amount-sum ' +
          'check is then deferred to the server.'
      );
    }

    if (parentTxn) {
      // Client-side sum check. Server also enforces this, but a local error
      // saves a round-trip and gives the caller more actionable numbers.
      // 1e-6 epsilon tolerates IEEE-754 drift (0.1 + 0.2 = 0.30000000000000004)
      // without letting real mismatches through at 2-decimal financial precision.
      const sum = splits.reduce((acc, s) => acc + s.amount, 0);
      const parentAmount = parentTxn.amount;
      const diff = sum - parentAmount;
      if (Math.abs(diff) > 1e-6) {
        throw new Error(
          `Split amounts must sum to parent amount. ` +
            `Parent=${formatAmountForMessage(parentAmount)}, ` +
            `sum=${formatAmountForMessage(sum)}, diff=${formatAmountForMessage(diff)}`
        );
      }
    }

    // Resolve the default name from the parent (only meaningful when the
    // parent resolved — otherwise every split carries its own name/date).
    // A split without a usable default can't succeed since the server
    // requires `name: String!` on every SplitTransactionInput — surface
    // that as a local error rather than sending an empty string.
    const parentDefaultName = parentTxn?.name;
    if (parentTxn && splits.some((s) => s.name === undefined) && !parentDefaultName) {
      throw new Error(
        `Cannot default split name from parent ${transaction_id}: parent has no usable name. Pass an explicit name on each split.`
      );
    }

    // Apply name/date defaults from the parent AFTER validation + sum check.
    // The non-null assertions are safe: with an unresolved parent, the guard
    // above threw unless every split carries explicit name AND date, so the
    // fallback arms are unreachable; with a resolved parent, the
    // `parentDefaultName` guard threw when any split omits `name` and the
    // default is falsy. TypeScript can't narrow across the `.some` calls.
    const inputs = splits.map((s) => ({
      name: s.name !== undefined ? s.name.trim() : parentDefaultName!,
      date: s.date !== undefined ? s.date : parentTxn!.date,
      amount: s.amount,
      categoryId: s.category_id,
    }));

    try {
      const result = await gqlSplitTransaction(client, {
        id: transaction_id,
        accountId: account_id,
        itemId: item_id,
        input: inputs,
      });
      // Session record (#822): the server has split, so delete_transaction
      // refuses this id from now on. First statements after the mutation.
      // The wrapper now refuses a drifted parent or child row before this
      // point (#887; the catch records the parent then), so nothing below is
      // expected to throw on drift; recording first is defence in depth.
      //
      // The parent is evicted from both caches here too, not after the
      // mapping: the Transactions query omits split parents, so reads must
      // stop surfacing it, and a throw below must not leave the pre-split row
      // cached for a later split-parent check to mistake for a live row. (Its
      // whole month is not invalidated: that would also drop the children
      // written through below, #820.) No-op if the cache is unloaded or the id
      // is absent — same eviction-is-a-no-op contract as delete_transaction.
      //
      // The months the split touched are captured BEFORE the eviction (the
      // parent's cached row is the reliable source; the inputs may differ from
      // what the server stored): if the mapping or write-through below throws,
      // those months are dropped so the next read refetches, rather than
      // serving a month with neither parent nor children (#820).
      const touchedMonths = [
        this.liveDb?.lookupTransactionNodes([transaction_id]).get(transaction_id)?.date,
        result.parentTransaction.date,
        ...inputs.map((i) => i.date),
        // The wrapper guarantees an array of rows with string ids (#887); a
        // row's date is still filtered by the type check below.
        ...result.splitTransactions.map((c) => c.date),
      ]
        .filter((d): d is string => typeof d === 'string' && d.length >= 7)
        .map((d) => d.slice(0, 7));
      this.recordSplitParent(transaction_id);
      this.db.patchCachedTransactionDelete(transaction_id);
      this.evictLiveTransaction(transaction_id);
      this.afterTransactionWrite();

      try {
        return this.finishSplit(result, touchedMonths);
      } catch (e) {
        this.liveDb?.invalidateLiveMonthKeys(touchedMonths);
        throw e;
      }
    } catch (e) {
      // A split that landed and then errored leaves the parent cached while
      // its children exist server-side, double-counting the amount (#832). The
      // parent's id finds its month, and the children's months are the dates
      // the split asked for.
      this.invalidateAfterFailedWrite(
        [transaction_id],
        inputs.flatMap((i) => CopilotMoneyTools.monthOf(i.date))
      );
      if (e instanceof GraphQLError && e.writeApplied) {
        // The server answered without errors but with an unusable payload
        // (#875), so the split has probably landed. Treat it as landed: record
        // and evict the parent as the success path does, or delete_transaction
        // would accept it (#822). If it did not land, the record is still
        // persistent and uid-scoped (never retired, #842): this server refuses
        // to delete that row until its line is removed from
        // ~/.claude/copilot-money/split-parents.<uid>.jsonl. That is the price
        // of never double-crediting a real split; see the ledger entry
        // Mutation.*:null-payload-means-applied.
        this.recordSplitParent(transaction_id);
        this.db.patchCachedTransactionDelete(transaction_id);
        this.evictLiveTransaction(transaction_id);
      }
      if (e instanceof GraphQLError) {
        throw new Error(graphQLErrorToMcpError(e), { cause: e });
      }
      throw e;
    }
  }

  /**
   * The part of split_transaction after the mutation resolved and the parent
   * was recorded and evicted: map the response and write the children
   * through. The wrapper has already refused a drifted parent or child row
   * (#887), so nothing here is expected to throw; it stays separate, with its
   * caller's catch dropping the touched months, as defence in depth against a
   * throw from the write-through.
   */
  private finishSplit(
    result: {
      parentTransaction: CreatedTransaction;
      splitTransactions: CreatedTransaction[];
    },
    touchedMonths: readonly string[]
  ): {
    success: true;
    parent_transaction_id: string;
    child_transaction_ids: string[];
    parent: WriteTransactionRow;
    children: WriteTransactionRow[];
  } {
    // The response rows, in get_transactions_live's field names (#825) — the
    // same mapper as create_transaction / add_to_recurring.
    const parent = toWriteTransactionRow(result.parentTransaction);
    // A child also carries parent_transaction_id: the split knows its parent,
    // as the write-through below does (the fragment does not select parentId).
    const children = result.splitTransactions.map((tx) =>
      toWriteTransactionRow(tx, undefined, result.parentTransaction.id)
    );

    // Feed the live meta index with the parent (it leaves the live cache
    // below, so the children's upserts are not its route in) — so a
    // follow-up write naming it resolves without a network fetch. Same
    // empty-id guard as the other feeds (#508).
    const parentTx = result.parentTransaction;
    if (parentTx.accountId && parentTx.itemId) {
      this.liveDb?.indexTransactionMeta(parentTx.id, {
        accountId: parentTx.accountId,
        itemId: parentTx.itemId,
      });
    }

    // Live cache write-through for the children (#820) — without it a split
    // in a cached month made the whole amount vanish (parent evicted,
    // children absent) until TTL expiry. The mutation fragment does not
    // select parentId, so set it from the parent the server just returned:
    // that is what a Transactions read reports for a split child. Each
    // upsert also feeds the meta index for that child.
    for (const child of result.splitTransactions) {
      // A refused (malformed) child drops every month the split touched: its
      // own returned date cannot be trusted to name its destination.
      this.liveDb?.upsertLiveTransaction(child, {
        insert: true,
        parentId: parentTx.id,
        refusalMonths: touchedMonths,
      });
    }

    return {
      success: true,
      parent_transaction_id: parent.transaction_id,
      child_transaction_ids: children.map((c) => c.transaction_id),
      parent,
      children,
    };
  }

  /**
   * Mark one or more transactions as reviewed (or unreviewed).
   *
   * Two input modes, normalized to one entries list before dispatch:
   * - `transaction_ids`: routing ids are resolved locally (live-first meta
   *   index / windowed fetch; LevelDB in degraded mode) — only works for
   *   transactions the resolution window can see.
   * - `rows`: each {transaction_id, account_id, item_id} entry (taken from a
   *   live read) supplies the mutation's routing ids directly, so
   *   out-of-window historical/backlog transactions work too. Wins when both
   *   modes are passed.
   *
   * Sets isReviewed via GraphQL for each entry; local cache is refreshed by
   * Copilot's sync process.
   */
  async reviewTransactions(args: {
    transaction_ids?: string[];
    rows?: Array<{ transaction_id: string; account_id: string; item_id: string }>;
    reviewed?: boolean;
  }): Promise<{
    success: boolean;
    reviewed_count: number;
    transaction_ids: string[];
  }> {
    const client = this.getGraphQLClient();

    const { transaction_ids, rows, reviewed = true } = args;
    const entries = await this.resolveBulkTargets(
      { transaction_ids, rows },
      'review out-of-window transactions'
    );
    const idList = entries.map((entry) => entry.id);

    // ONE bulkEditTransactions request for the whole set, replacing the former
    // 5-wide fan-out of editTransaction calls. `isReviewed` is one of the five
    // fields BulkEditTransactionInput accepts, and every row here takes the
    // SAME value, so this tool is an exact fit for the bulk mutation's
    // one-input-many-rows shape. (Tools that need per-row edits, or the
    // name/date/amount/note fields bulk does not support, still fan out.)
    const [first, ...rest] = entries;
    // Optimistic cache patch — only ids the server confirmed it wrote, applied
    // inside bulkEdit before any partial-batch error is thrown. A partial batch
    // must not leave the cache claiming writes that never landed, nor hide the
    // ones that did. For rows-mode entries outside the local cache the local
    // patch is a no-op (same eviction-is-a-no-op contract as delete_transaction).
    const result = await this.bulkEdit(
      client,
      [first!, ...rest],
      { isReviewed: reviewed },
      'review_transactions',
      (updated) => {
        for (const tx of updated) {
          // Local patch from the request's `reviewed`, live patch from the
          // server row: the local model has no field mapping from that row, and
          // isReviewed is the only field sent, so for every row in `updated`
          // the two agree.
          this.db.patchCachedTransaction(tx.id, { user_reviewed: reviewed });
          this.liveDb?.upsertLiveTransaction(tx);
        }
      }
    );

    // Unknown ids are dropped silently by the server rather than reported in
    // failed[] (verified live). Surfacing them as a hard failure preserves the
    // pre-bulk contract: a review that didn't land must not report success.
    // mutation-guard: review_transactions surfaces silently-skipped rows
    if (result.skipped.length > 0) {
      throw new Error(
        `review_transactions: ${result.updated.length}/${entries.length} succeeded — ` +
          `the server did not apply ${String(result.skipped.length)} transaction(s) and reported ` +
          `no error for them: ${result.skipped.join(', ')}. They may have been deleted, or the ` +
          'account_id/item_id routing may not match the transaction.'
      );
    }

    return {
      success: true,
      reviewed_count: result.updated.length,
      transaction_ids: idList,
    };
  }

  /**
   * Normalize the two targeting modes shared by every bulk write tool into one
   * entries list.
   *
   * - `transaction_ids`: routing ids resolved locally (live-first meta index /
   *   windowed fetch; LevelDB in degraded mode) — only reaches transactions the
   *   resolution window can see.
   * - `rows`: each {transaction_id, account_id, item_id} (from a live read)
   *   supplies routing directly, so out-of-window rows work too. Wins when both
   *   are passed — a caller who passed `rows` chose the bypass mode, so an
   *   empty/invalid value gets a rows-shaped error rather than silently falling
   *   through to the transaction_ids path and its misleading message.
   *
   * Shared so `review_transactions` and `bulk_edit_transactions` cannot drift
   * on which ids they accept or how they report unresolvable ones.
   */
  private async resolveBulkTargets(
    args: {
      transaction_ids?: string[];
      rows?: Array<{ transaction_id: string; account_id: string; item_id: string }>;
    },
    outOfWindowAction: string,
    loadWindow?: () => Promise<readonly TransactionNode[]>
  ): Promise<Array<{ id: string; accountId: string; itemId: string }>> {
    const { transaction_ids, rows } = args;
    if (rows !== undefined) {
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error(
          'rows must be a non-empty array of {transaction_id, account_id, item_id} when ' +
            'provided — omit it to use transaction_ids instead'
        );
      }
      for (const row of rows) {
        validateDocId(row.transaction_id, 'transaction_id');
        validateDocId(row.account_id, 'account_id');
        validateDocId(row.item_id, 'item_id');
      }
      return rows.map((row) => ({
        id: row.transaction_id,
        accountId: row.account_id,
        itemId: row.item_id,
      }));
    }
    if (!Array.isArray(transaction_ids) || transaction_ids.length === 0) {
      throw new Error(
        'transaction_ids must be a non-empty array — or pass a rows array of ' +
          '{transaction_id, account_id, item_id} (from a live read) to bypass local resolution'
      );
    }
    for (const id of transaction_ids) {
      validateDocId(id, 'transaction_id');
    }
    const { meta: metaMap, liveWindowMonths } = await this.resolveTransactionMeta(
      transaction_ids,
      loadWindow
    );
    const missing = transaction_ids.filter((id) => !metaMap.has(id));
    if (missing.length > 0) {
      throw new Error(
        CopilotMoneyTools.transactionsNotFoundMessage(missing, liveWindowMonths) +
          " Pass a 'rows' array of {transaction_id, account_id, item_id} (from a live read) " +
          `to ${outOfWindowAction}.`
      );
    }
    return transaction_ids.map((id) => {
      const meta = metaMap.get(id)!;
      return { id, accountId: meta.accountId, itemId: meta.itemId };
    });
  }

  /**
   * Shared bulkEditTransactions call path: validate-then-write, with the
   * server's per-row rejections normalized into a thrown error.
   *
   * Every consumer goes through here so the two non-obvious server behaviours
   * are handled in exactly one place:
   *  - `failed[]` entries are a hard error (no partial-success reporting; the
   *    caller decides what to do with `skipped`).
   *  - GraphQLError is mapped to the MCP error string, matching every other
   *    write tool.
   */
  private async bulkEdit(
    client: GraphQLClient,
    ids: [
      { id: string; accountId: string; itemId: string },
      ...{ id: string; accountId: string; itemId: string }[],
    ],
    input: BulkEditTransactionInput,
    label: string,
    onLanded: (updated: BulkEditTransactionsResult['updated']) => void
  ): Promise<BulkEditTransactionsResult> {
    let result: BulkEditTransactionsResult;
    try {
      result = await gqlBulkEditTransactions(client, { ids, input });
    } catch (e) {
      // The batch may have partly landed before the error (a timeout after the
      // server wrote, say), and nothing says which rows did. Drop the live
      // months holding the targeted rows so the next read asks the server
      // instead of serving pre-write rows for up to a week.
      this.invalidateAfterFailedWrite(ids.map((t) => t.id));
      if (e instanceof GraphQLError) {
        throw new Error(`${label} failed: ${graphQLErrorToMcpError(e)}`, { cause: e });
      }
      throw e;
    }
    // Rows the server confirmed it wrote reach the caches BEFORE any partial-
    // batch error below (or the caller's silently-skipped check) throws — a
    // rejected sibling must not leave the caches claiming a landed row never
    // changed.
    onLanded(result.updated);
    // Rows the response does not account for (silently skipped by the server,
    // or a drifted response read as empty) have an unknown outcome: drop
    // their live months so the next read asks the server (#864 review).
    if (result.skipped.length > 0) this.liveDb?.invalidateLiveTransactionMonths(result.skipped);
    // A type change can move a manual account's balance (#825).
    this.afterTransactionWrite();
    if (result.failed.length > 0) {
      const detail = result.failed
        .map(
          (f) =>
            `${f.transaction?.id ?? '<unknown>'}: ${f.errorCode}${f.error ? ` ${f.error}` : ''}`
        )
        .join('; ');
      throw new Error(
        `${label}: server rejected ${String(result.failed.length)} of ${String(ids.length)} ` +
          `transaction(s) (${result.updated.length} succeeded): ${detail}`
      );
    }
    return result;
  }

  /**
   * Apply ONE edit to MANY transactions in a single GraphQL request.
   *
   * This is a thin, safety-hardened wrapper over Copilot's own
   * `bulkEditTransactions` mutation — the one its web UI fires from the
   * multi-select bar. It is deliberately NOT a general batch-edit tool:
   *
   * - **Same edit, many rows.** The mutation takes one input applied to the
   *   whole set. Different edits for different rows require separate calls (or
   *   `update_transaction` per row).
   * - **Five fields only.** `BulkEditTransactionInput` accepts exactly
   *   categoryId / addTagIds / removeTagIds / type / isReviewed (enumerated by
   *   error-leak probe). `name`, `date`, `amount` and `note` are not bulk-
   *   editable at all — use `update_transaction`.
   *
   * All validation runs BEFORE the write, which matters more here than
   * anywhere else in the codebase: the server performs NO referential
   * validation of its own. A nonexistent `category_id` is accepted verbatim
   * and persisted as a dangling reference (verified live 2026-08-01), so the
   * only thing standing between a typo and corrupted rows is the check below.
   */
  async bulkEditTransactions(args: {
    transaction_ids?: string[];
    rows?: Array<{ transaction_id: string; account_id: string; item_id: string }>;
    category_id?: string;
    type?: TransactionType;
    reviewed?: boolean;
    add_tag_ids?: string[];
    remove_tag_ids?: string[];
  }): Promise<{
    success: true;
    updated_count: number;
    transaction_ids: string[];
    applied: string[];
  }> {
    const client = this.getGraphQLClient();
    const { category_id, type, reviewed, add_tag_ids, remove_tag_ids } = args;

    // --- Which fields did the caller actually set? ---
    const applied: string[] = [];
    if (category_id !== undefined) applied.push('category_id');
    if (type !== undefined) applied.push('type');
    if (reviewed !== undefined) applied.push('reviewed');
    if (add_tag_ids !== undefined) applied.push('add_tag_ids');
    if (remove_tag_ids !== undefined) applied.push('remove_tag_ids');
    if (applied.length === 0) {
      throw new Error(
        'bulk_edit_transactions requires at least one of: category_id, type, reviewed, ' +
          'add_tag_ids, remove_tag_ids. Note that name, date, amount and note are NOT ' +
          'bulk-editable by Copilot — use update_transaction for those.'
      );
    }

    // --- Per-field validation, all before any write ---
    if (category_id !== undefined) {
      validateDocId(category_id, 'category_id');
      // Load-bearing: the server accepts unknown category ids verbatim and
      // writes a dangling reference. This is the only guard.
      // mutation-guard: bulk edit validates category ids client-side
      await this.validateCategoryId(category_id);
    }
    if (type !== undefined && !TRANSACTION_TYPES.includes(type)) {
      throw new Error(
        `bulk_edit_transactions: type must be one of ${TRANSACTION_TYPES.join(', ')}. Got: ${type}`
      );
    }
    // Same self-contradiction the singular tool rejects: Copilot clears the
    // category for INCOME/INTERNAL_TRANSFER, so pairing them silently drops
    // the category half of the request.
    if ((type === 'INCOME' || type === 'INTERNAL_TRANSFER') && category_id !== undefined) {
      throw new Error(
        `bulk_edit_transactions: category_id cannot be combined with type ${type} — Copilot ` +
          'clears the category for INCOME/INTERNAL_TRANSFER transactions. Set the type alone, ' +
          'or use type REGULAR to keep/set a category.'
      );
    }
    if (reviewed !== undefined && typeof reviewed !== 'boolean') {
      throw new Error(
        `bulk_edit_transactions: reviewed must be a boolean. Got: ${String(reviewed)}`
      );
    }
    for (const [field, tagIds] of [
      ['add_tag_ids', add_tag_ids],
      ['remove_tag_ids', remove_tag_ids],
    ] as const) {
      if (tagIds === undefined) continue;
      if (!Array.isArray(tagIds) || tagIds.length === 0) {
        throw new Error(`bulk_edit_transactions: ${field} must be a non-empty array when provided`);
      }
      for (const tagId of tagIds) validateDocId(tagId, 'tag_id');
      // The server silently drops unknown tag ids rather than erroring, so an
      // unvalidated typo would report success having applied nothing. That
      // holds for remove_tag_ids too, so removal is validated as well. Whether
      // removing a tag the app deleted is ever needed depends on whether
      // Copilot strips a deleted tag from its transactions, which is
      // unverified (ledger: Mutation.deleteTag:cascades-to-transactions); if it
      // does not, the remove direction should get an exemption like
      // set_budget's clear.
      await this.validateTagIds(tagIds);
    }
    // Adding and removing the same tag in one call has no defined resolution
    // order server-side; reject rather than let the outcome be arbitrary.
    if (add_tag_ids && remove_tag_ids) {
      const removing = new Set(remove_tag_ids);
      const overlap = add_tag_ids.filter((id) => removing.has(id));
      if (overlap.length > 0) {
        throw new Error(
          `bulk_edit_transactions: tag id(s) ${overlap.join(', ')} appear in both add_tag_ids ` +
            'and remove_tag_ids — the server does not define which wins'
        );
      }
    }

    // Cap BEFORE resolution: resolveBulkTargets fans out to resolveTransactionMeta
    // over every requested id, so checking afterwards would pay for a windowed
    // fetch on a batch we were always going to reject. Counted off the raw args
    // because that is the caller's ask — resolution only fills in routing, it
    // never changes how many rows are targeted.
    // rows-wins, like the block below and resolveBulkTargets; only an array
    // has a count (a string's length is not one).
    const targetList = args.rows !== undefined ? args.rows : args.transaction_ids;
    const requestedCount = Array.isArray(targetList) ? targetList.length : 0;
    if (requestedCount > MAX_BULK_EDIT_TARGETS) {
      throw new Error(
        `bulk_edit_transactions: ${String(requestedCount)} targets exceeds the maximum of ` +
          `${String(MAX_BULK_EDIT_TARGETS)} per call. Split the work into smaller batches.`
      );
    }

    // Pure format checks before any I/O: a malformed id must not pay the window
    // load. A non-array target list falls through to resolveBulkTargets, which
    // reports it.
    // rows-wins, as in resolveBulkTargets: a present but malformed `rows`
    // names no targets here, so its structural error is the one reported.
    const requested =
      args.rows !== undefined
        ? Array.isArray(args.rows)
          ? args.rows.map((r) => r?.transaction_id)
          : []
        : args.transaction_ids;
    const requestedIds = (Array.isArray(requested) ? requested : []).filter(
      (id): id is string => typeof id === 'string'
    );
    for (const id of requestedIds) validateDocId(id, 'transaction_id');
    if (Array.isArray(args.rows)) {
      for (const row of args.rows) {
        // A present routing id must be well-formed (validateDocId rejects a
        // non-string too). A missing one is left to resolveBulkTargets, which
        // reports the rows shape.
        if (row?.account_id !== undefined) validateDocId(row.account_id, 'account_id');
        if (row?.item_id !== undefined) validateDocId(row.item_id, 'item_id');
      }
    }

    const loadWindow = this.sharedWindowLoad();
    // Split parents (#836): a type change on one has the same unverified
    // balance effect as update_transaction's, so it is refused the same way,
    // before anything is sent. Category, tag and reviewed changes are not
    // checked (no balance effect). One window load serves every target and
    // resolution. Checked on the requested ids BEFORE resolution, which would
    // otherwise answer "not found" for a parent the window omits.
    if (type !== undefined) {
      for (const id of requestedIds) {
        const evidence = await this.splitParentEvidence(id, loadWindow);
        // mutation-guard: bulk_edit_transactions does not retype a split parent
        if (evidence.isParent) {
          throw new Error(
            `bulk_edit_transactions: transaction ${id} is a split parent, and changing ` +
              `its type is refused. What Copilot does to the account balance when a split ` +
              `parent's type changes is unverified, and it could move the balance twice. Drop ` +
              `it from the targets and change its children instead; its category, tags and ` +
              `reviewed state can still be bulk-edited.`
          );
        }
        CopilotMoneyTools.refuseUncheckedSplitTarget(evidence, id, 'bulk_edit_transactions');
      }
    }

    const entries = await this.resolveBulkTargets(
      args,
      'edit out-of-window transactions',
      loadWindow
    );
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.id)) {
        throw new Error(`bulk_edit_transactions: duplicate transaction_id ${entry.id}`);
      }
      seen.add(entry.id);
    }

    const input: BulkEditTransactionInput = {};
    if (category_id !== undefined) input.categoryId = category_id;
    if (type !== undefined) input.type = type;
    if (reviewed !== undefined) input.isReviewed = reviewed;
    if (add_tag_ids !== undefined) input.addTagIds = add_tag_ids;
    if (remove_tag_ids !== undefined) input.removeTagIds = remove_tag_ids;

    const [first, ...rest] = entries;
    // Optimistic cache patch, per confirmed row, applied inside bulkEdit before
    // any partial-batch error is thrown. `type` is mirrored through its local
    // counterparts (internal_transfer, income) and its category-clearing effect.
    // Tag add/remove is applied against the tag list the SERVER returned, not
    // recomputed locally, so the cache matches the authoritative result.
    const result = await this.bulkEdit(
      client,
      [first!, ...rest],
      input,
      'bulk_edit_transactions',
      (updated) => {
        for (const tx of updated) {
          const patch = buildBulkEditCachePatch(
            { category_id, reviewed, type, add_tag_ids, remove_tag_ids },
            tx
          );
          if (Object.keys(patch).length > 0) {
            this.db.patchCachedTransaction(tx.id, patch);
          }
          // Live cache: the server's returned row, which already carries the
          // type, the cleared category and the post-edit tag list (#821).
          this.liveDb?.upsertLiveTransaction(tx);
        }
      }
    );

    // mutation-guard: bulk_edit_transactions surfaces silently-skipped rows
    if (result.skipped.length > 0) {
      throw new Error(
        `bulk_edit_transactions: ${result.updated.length}/${entries.length} succeeded — the ` +
          `server did not apply ${String(result.skipped.length)} transaction(s) and reported no ` +
          `error for them: ${result.skipped.join(', ')}. They may have been deleted, or the ` +
          'account_id/item_id routing may not match the transaction.'
      );
    }

    return {
      success: true,
      updated_count: result.updated.length,
      transaction_ids: entries.map((e) => e.id),
      applied,
    };
  }

  /**
   * Create a new user-defined tag.
   *
   * Generates a deterministic tag_id from the name, validates it does not
   * already exist, writes via GraphQL; local cache is refreshed by Copilot's
   * sync process.
   */
  async createTag(args: {
    name: string;
    color_name?: string;
  }): Promise<{ success: true; tag_id: string; name: string; color_name: string }> {
    const client = this.getGraphQLClient();
    if (!args.name?.trim()) throw new Error('Tag name must not be empty');
    // Default matches the captured CreateTag example; only a caller-supplied
    // value needs guarding (the literal default is a known-good ColorName).
    const colorName: ColorName =
      args.color_name === undefined ? 'PURPLE2' : validateColorName(args.color_name);

    try {
      const result = await gqlCreateTag(client, {
        input: { name: args.name.trim(), colorName },
      });
      const tag = {
        tag_id: result.id,
        name: result.name,
        color_name: result.colorName,
      };
      this.db.patchCachedTagUpsert(tag);
      this.liveDb?.patchLiveTagUpsert({
        id: result.id,
        name: result.name,
        colorName: result.colorName,
      });
      return {
        success: true,
        tag_id: result.id,
        name: result.name,
        color_name: result.colorName,
      };
    } catch (e) {
      this.afterPossiblyAppliedEntityWrite(e, 'tags');
      if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e), { cause: e });
      throw e;
    }
  }

  /**
   * Delete an existing user-defined tag.
   *
   * Validates the tag exists in the local cache, deletes via GraphQL; local
   * cache is refreshed by Copilot's sync process.
   */
  async deleteTag(args: { tag_id: string }): Promise<{
    success: true;
    tag_id: string;
    deleted: true;
  }> {
    const client = this.getGraphQLClient();
    try {
      const result = await gqlDeleteTag(client, { id: args.tag_id });
      this.db.patchCachedTagDelete(args.tag_id);
      this.liveDb?.patchLiveTagDelete(args.tag_id);
      return { success: true, tag_id: result.id, deleted: true };
    } catch (e) {
      this.afterPossiblyAppliedEntityWrite(e, 'tags');
      if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e), { cause: e });
      throw e;
    }
  }

  /**
   * Update an existing user-defined category.
   *
   * Validates the category exists, applies only the provided fields via
   * GraphQL; local cache is refreshed by Copilot's sync process.
   */
  async updateCategory(args: {
    category_id: string;
    name?: string;
    color_name?: string;
    emoji?: string;
    is_excluded?: boolean;
  }): Promise<{ success: true; category_id: string; updated: string[] }> {
    const client = this.getGraphQLClient();
    const input: EditCategoryInput = {};
    if (args.name !== undefined) input.name = args.name;
    if (args.color_name !== undefined) input.colorName = validateColorName(args.color_name);
    if (args.emoji !== undefined) input.emoji = args.emoji;
    if (args.is_excluded !== undefined) input.isExcluded = args.is_excluded;
    if (Object.keys(input).length === 0) {
      throw new Error('update_category requires at least one field to update');
    }

    try {
      const result = await gqlEditCategory(client, { id: args.category_id, input });
      const patch: Partial<Category> = { category_id: args.category_id };
      if (args.name !== undefined) patch.name = args.name;
      if (args.color_name !== undefined) patch.color = args.color_name;
      if (args.emoji !== undefined) patch.emoji = args.emoji;
      if (args.is_excluded !== undefined) patch.excluded = args.is_excluded;
      this.db.patchCachedCategoryUpsert(patch as Category);
      // Like createCategory above: the EditCategory mutation doesn't return
      // `icon` on its response, so we synthesize it as EmojiUnicode here. If
      // the category was previously a Genmoji, this write-through will
      // incorrectly mark it as EmojiUnicode until the next categoriesCache
      // read overwrites it with the correct server shape — bounded divergence,
      // same trade-off as createCategory.
      if (this.liveDb) {
        const cached = this.liveDb
          .getCategoriesCache()
          .peek()
          ?.find((c) => c.id === args.category_id);
        if (cached) {
          const merged: CategoryNode = {
            ...cached,
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.color_name !== undefined ? { colorName: args.color_name } : {}),
            ...(args.emoji !== undefined
              ? { icon: { __typename: 'EmojiUnicode', unicode: args.emoji } }
              : {}),
            ...(args.is_excluded !== undefined ? { isExcluded: args.is_excluded } : {}),
          };
          this.liveDb.patchLiveCategoryUpsert(merged);
        }
      }
      return {
        success: true,
        category_id: result.id,
        updated: Object.keys(result.changed),
      };
    } catch (e) {
      this.afterPossiblyAppliedEntityWrite(e, 'categories');
      if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e), { cause: e });
      throw e;
    }
  }

  /**
   * Delete a user-defined category via GraphQL.
   */
  async deleteCategory(args: { category_id: string }): Promise<{
    success: true;
    category_id: string;
    deleted: true;
  }> {
    const client = this.getGraphQLClient();
    try {
      const result = await gqlDeleteCategory(client, { id: args.category_id });
      this.db.patchCachedCategoryDelete(args.category_id);
      this.liveDb?.patchLiveCategoryDelete(args.category_id);
      return { success: true, category_id: result.id, deleted: true };
    } catch (e) {
      this.afterPossiblyAppliedEntityWrite(e, 'categories');
      if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e), { cause: e });
      throw e;
    }
  }

  /**
   * Set the monthly budget amount for a category via GraphQL.
   *
   * Dispatches to EditBudget (all-months default) or EditBudgetMonthly
   * (per-month override). amount="0" clears the budget.
   */
  async setBudget(args: { category_id: string; amount: string; month?: string }): Promise<{
    success: true;
    category_id: string;
    amount: string;
    month?: string;
    cleared: boolean;
  }> {
    const client = this.getGraphQLClient();
    if (!args.category_id?.trim()) throw new Error('category_id is required');
    if (typeof args.amount !== 'string') {
      throw new Error('amount must be a string (e.g. "250.00")');
    }
    if (!/^\d+(\.\d{1,2})?$/.test(args.amount)) {
      throw new Error(
        'amount must be a non-negative decimal like "250.00" or "0" to clear the budget'
      );
    }
    if (args.month !== undefined && !/^\d{4}-\d{2}$/.test(args.month)) {
      throw new Error('month must be "YYYY-MM"');
    }
    if (args.month !== undefined && !isCalendarMonth(args.month)) {
      throw new Error(`month: ${args.month} is not a real calendar month (01-12)`);
    }
    // A budget on a category that does not exist is a write to nothing the app
    // can show; same single check as every other category reference (#846).
    // Clearing (amount 0) is exempt, so a budget left on a category deleted in
    // the app can still be cleared; but then nothing confirms the category, so
    // the write-through below is skipped rather than synthesizing a cached
    // budget row for it (the caches catch up on their TTL).
    validateDocId(args.category_id, 'category_id');
    const clearing = parseFloat(args.amount) === 0;
    if (!clearing) await this.validateCategoryId(args.category_id);
    // Knowledge, not verification: no fetch and no throttle stamp for a miss
    // the clear path expects.
    const categoryKnown =
      !clearing || (await this.categoryExists(args.category_id, { refetch: false }));

    try {
      const result = await gqlSetBudget(client, {
        categoryId: args.category_id,
        amount: args.amount,
        month: args.month,
      });
      if (categoryKnown) {
        this.db.patchCachedBudget(args.category_id, parseFloat(args.amount), args.month);
        this.liveDb?.patchLiveCategoryBudget(args.category_id, parseFloat(args.amount), args.month);
      }
      return {
        success: true,
        category_id: result.categoryId,
        amount: result.amount,
        ...(result.month ? { month: result.month } : {}),
        cleared: result.cleared,
      };
    } catch (e) {
      this.afterPossiblyAppliedEntityWrite(e, 'categories');
      if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e), { cause: e });
      throw e;
    }
  }

  /**
   * Change the state of a recurring item (activate, pause, or archive).
   *
   * Validates the recurring item exists, writes state via GraphQL; local cache
   * is refreshed by Copilot's sync process.
   */
  async setRecurringState(args: {
    recurring_id: string;
    state: string;
  }): Promise<{ success: true; recurring_id: string; state: string }> {
    const client = this.getGraphQLClient();
    // .includes() on the `as const` tuple needs widening to string[] to accept
    // an arbitrary string arg (TS narrows the tuple's element type otherwise).
    if (!(RECURRING_STATE_VALUES as readonly string[]).includes(args.state)) {
      throw new Error(
        `state must be one of: ${RECURRING_STATE_VALUES.join(', ')}. Got: ${args.state}`
      );
    }

    try {
      const result = await gqlEditRecurring(client, {
        id: args.recurring_id,
        // Validated against RECURRING_STATE_VALUES above, so the cast is safe.
        input: { state: args.state as RecurringStateValue },
      });
      // GraphQL returns uppercase state ("ACTIVE"); the LevelDB cache stores
      // lowercase ("active"). Normalize to the cache's shape on patch.
      const recurringPatch = {
        recurring_id: args.recurring_id,
        state: args.state.toLowerCase() as 'active' | 'paused' | 'archived',
      };
      this.db.patchCachedRecurringUpsert(recurringPatch);
      // If recurringCache hasn't been warmed yet, peek() returns undefined and we
      // skip the live-cache update silently. The next get_recurring_live call will
      // hydrate fresh data from GraphQL (the EditRecurring mutation already
      // succeeded). Mirrors the same semantic in updateTag/updateCategory.
      if (this.liveDb) {
        const cached = this.liveDb
          .getRecurringCache()
          .peek()
          ?.find((r) => r.id === args.recurring_id);
        if (cached) {
          const merged: RecurringNode = { ...cached, state: args.state };
          this.liveDb.patchLiveRecurringUpsert(merged);
        }
      }
      return { success: true, recurring_id: result.id, state: args.state };
    } catch (e) {
      this.afterPossiblyAppliedEntityWrite(e, 'recurring');
      if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e), { cause: e });
      throw e;
    }
  }

  /**
   * Delete a recurring item via GraphQL.
   */
  async deleteRecurring(args: { recurring_id: string }): Promise<{
    success: true;
    recurring_id: string;
    deleted: true;
  }> {
    const client = this.getGraphQLClient();
    try {
      const result = await gqlDeleteRecurring(client, { id: args.recurring_id });
      this.db.patchCachedRecurringDelete(args.recurring_id);
      this.liveDb?.patchLiveRecurringDelete(args.recurring_id);
      return { success: true, recurring_id: result.id, deleted: true };
    } catch (e) {
      this.afterPossiblyAppliedEntityWrite(e, 'recurring');
      if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e), { cause: e });
      throw e;
    }
  }

  /**
   * Update an existing tag's name and/or color.
   *
   * Validates the tag exists, builds a dynamic patch for only the provided
   * fields, writes via GraphQL; local cache is refreshed by Copilot's sync
   * process.
   */
  async updateTag(args: {
    tag_id: string;
    name?: string;
    color_name?: string;
  }): Promise<{ success: true; tag_id: string; updated: string[] }> {
    const client = this.getGraphQLClient();
    const input: EditTagInput = {};
    if (args.name !== undefined) input.name = args.name;
    if (args.color_name !== undefined) input.colorName = validateColorName(args.color_name);
    if (Object.keys(input).length === 0) {
      throw new Error('update_tag requires at least one field to update');
    }

    try {
      const result = await gqlEditTag(client, { id: args.tag_id, input });
      const patch: Partial<Tag> = { tag_id: args.tag_id };
      if (args.name !== undefined) patch.name = args.name;
      if (args.color_name !== undefined) patch.color_name = args.color_name;
      this.db.patchCachedTagUpsert(patch as Tag);
      // If tagsCache hasn't been warmed yet, peek() returns undefined and we
      // skip the live-cache update silently. The next get_tags_live call will
      // hydrate fresh data from GraphQL (the EditTag mutation already succeeded).
      // Mirrors the same semantic in updateCategory's write-through.
      if (this.liveDb) {
        const cached = this.liveDb
          .getTagsCache()
          .peek()
          ?.find((t) => t.id === args.tag_id);
        if (cached) {
          const merged: TagNode = {
            ...cached,
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.color_name !== undefined ? { colorName: args.color_name } : {}),
          };
          this.liveDb.patchLiveTagUpsert(merged);
        }
      }
      return { success: true, tag_id: result.id, updated: Object.keys(result.changed) };
    } catch (e) {
      this.afterPossiblyAppliedEntityWrite(e, 'tags');
      if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e), { cause: e });
      throw e;
    }
  }

  /**
   * Create a new recurring/subscription item.
   *
   * Generates a unique recurring_id, writes via GraphQL; local cache is
   * refreshed by Copilot's sync process.
   *
   * Routing bypass (#571): when the caller supplies BOTH account_id and
   * item_id (taken from a live read), the triple is forwarded verbatim and
   * local resolution is skipped — same contract as update_transaction /
   * delete_transaction. The server validates the full (id, accountId,
   * itemId) binding on the nested transaction ref (see the
   * Mutation.createRecurring:routing ledger entry), so a wrong pair fails
   * loudly rather than seeding the recurring from a different transaction.
   */
  async createRecurring(args: {
    transaction_id: string;
    account_id?: string;
    item_id?: string;
    frequency: string;
  }): Promise<{
    success: true;
    recurring_id: string;
    name: string;
    state: string;
    frequency: string;
  }> {
    const client = this.getGraphQLClient();
    // .includes() on the `as const` tuple needs widening to string[] to accept
    // an arbitrary string arg (TS narrows the tuple's element type otherwise).
    if (!(RECURRING_FREQUENCIES as readonly string[]).includes(args.frequency)) {
      throw new Error(
        `frequency must be one of: ${RECURRING_FREQUENCIES.join(', ')}. Got: ${args.frequency}`
      );
    }

    validateDocId(args.transaction_id, 'transaction_id');

    // Half a pair is always a caller mistake; reject it rather than
    // silently resolving (same stance as update_transaction).
    if ((args.account_id === undefined) !== (args.item_id === undefined)) {
      throw new Error(
        'create_recurring: account_id and item_id must be passed together (both from a live read) to bypass local resolution'
      );
    }
    // Pure argument checks before any I/O (see update_transaction).
    if (args.account_id !== undefined) validateDocId(args.account_id, 'account_id');
    if (args.item_id !== undefined) validateDocId(args.item_id, 'item_id');
    const loadWindow = this.sharedWindowLoad();
    // Split parents (#836): a recurring seeded from one would count the
    // parent's amount on top of its children's, and derive its expected
    // amount from it; what the server does is unverified. Refused before
    // sending, as add_transaction_to_recurring refuses it. Checked before
    // routing resolution: the window omits a parent that still has children,
    // so resolution would otherwise answer "not found" first and recommend a
    // routing bypass that this check then refuses. One window load serves both.
    const evidence = await this.splitParentEvidence(args.transaction_id, loadWindow);
    // mutation-guard: a recurring is not seeded from a split parent
    if (evidence.isParent) {
      throw new Error(
        `create_recurring: transaction ${args.transaction_id} is a split parent, and a ` +
          `recurring is not created from it. What Copilot does when a split parent seeds a ` +
          `recurring is unverified: the series could count the parent's amount on top of its ` +
          `children's, the same money twice. Create it from one of the child transactions.`
      );
    }
    CopilotMoneyTools.refuseUncheckedSplitTarget(evidence, args.transaction_id, 'create_recurring');

    let txnMeta: { accountId: string; itemId: string };
    if (args.account_id !== undefined && args.item_id !== undefined) {
      // Formats were checked before the window load, above.
      txnMeta = { accountId: args.account_id, itemId: args.item_id };
    } else {
      // Resolve routing ids the same way update_transaction does — live-first
      // in live mode, local cache only in degraded mode. See
      // resolveTransactionMeta(). Fixes the class bug where a transaction
      // older than the local cache window could not be made recurring.
      const { meta, liveWindowMonths } = await this.resolveTransactionMeta(
        [args.transaction_id],
        loadWindow
      );
      const resolved = meta.get(args.transaction_id);
      if (!resolved) {
        throw new Error(
          CopilotMoneyTools.transactionsNotFoundMessage([args.transaction_id], liveWindowMonths) +
            ' Pass account_id and item_id (from a live read) to create the recurring anyway.'
        );
      }
      txnMeta = resolved;
    }

    try {
      const result = await gqlCreateRecurring(client, {
        input: {
          // Validated against RECURRING_FREQUENCIES above, so the widening cast is safe.
          frequency: args.frequency as RecurringFrequency,
          transaction: {
            accountId: txnMeta.accountId,
            itemId: txnMeta.itemId,
            transactionId: args.transaction_id,
          },
        },
      });
      const recurringRow = {
        recurring_id: result.id,
        name: result.name,
        state: result.state.toLowerCase() as 'active' | 'paused' | 'archived',
        frequency: result.frequency,
      };
      this.db.patchCachedRecurringUpsert(recurringRow);
      // CreateRecurring returns only id/name/state/frequency. We synthesize a
      // RecurringNode with safe defaults for the missing fields; the next
      // get_recurring_live call will overwrite them with the server-canonical
      // shape. Same trade-off as createCategory/createTag.
      this.liveDb?.patchLiveRecurringUpsert({
        id: result.id,
        name: result.name,
        state: result.state,
        frequency: result.frequency,
        nextPaymentAmount: null,
        nextPaymentDate: null,
        categoryId: null,
        emoji: null,
        icon: null,
        rule: null,
        payments: [],
      });
      return {
        success: true,
        recurring_id: result.id,
        name: result.name,
        state: result.state,
        frequency: result.frequency,
      };
    } catch (e) {
      this.afterPossiblyAppliedEntityWrite(e, 'recurring');
      if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e), { cause: e });
      throw e;
    }
  }

  /**
   * Update an existing recurring/subscription item.
   *
   * Validates the recurring item exists, builds a dynamic patch from the
   * provided fields, writes via GraphQL; local cache is refreshed by Copilot's
   * sync process.
   */
  async updateRecurring(args: {
    recurring_id: string;
    name?: string;
    category_id?: string;
    frequency?: string;
    rule?: {
      name_contains?: string;
      min_amount?: string;
      max_amount?: string;
      days?: number[];
    };
    state?: string;
  }): Promise<{ success: true; recurring_id: string; updated: string[] }> {
    const client = this.getGraphQLClient();
    if (args.name !== undefined) {
      const trimmed = args.name.trim();
      if (trimmed.length === 0) {
        throw new Error('update_recurring: name must not be empty');
      }
    }
    if (args.category_id !== undefined) {
      validateDocId(args.category_id, 'category_id');
      await this.validateCategoryId(args.category_id);
    }
    if (args.frequency !== undefined) {
      // .includes() on the `as const` tuple needs widening to string[] to accept
      // an arbitrary string arg (TS narrows the tuple's element type otherwise).
      if (!(RECURRING_FREQUENCIES as readonly string[]).includes(args.frequency)) {
        throw new Error(
          `frequency must be one of: ${RECURRING_FREQUENCIES.join(', ')}. Got: ${args.frequency}`
        );
      }
    }
    if (args.state !== undefined) {
      // .includes() on the `as const` tuple needs widening to string[] to accept
      // an arbitrary string arg (TS narrows the tuple's element type otherwise).
      if (!(RECURRING_STATE_VALUES as readonly string[]).includes(args.state)) {
        throw new Error(
          `state must be one of: ${RECURRING_STATE_VALUES.join(', ')}. Got: ${args.state}`
        );
      }
    }
    const input: Record<string, unknown> = {};
    if (args.name !== undefined) input.name = args.name.trim();
    if (args.category_id !== undefined) input.categoryId = args.category_id;
    if (args.frequency !== undefined) input.frequency = args.frequency;
    if (args.state !== undefined) input.state = args.state;
    if (args.rule !== undefined) {
      const rule: Record<string, unknown> = {};
      if (args.rule.name_contains !== undefined) rule.nameContains = args.rule.name_contains;
      if (args.rule.min_amount !== undefined) rule.minAmount = args.rule.min_amount;
      if (args.rule.max_amount !== undefined) rule.maxAmount = args.rule.max_amount;
      if (args.rule.days !== undefined) rule.days = args.rule.days;
      input.rule = rule;
    }
    if (Object.keys(input).length === 0) {
      throw new Error('update_recurring requires at least one field to update');
    }

    try {
      const result = await gqlEditRecurring(client, { id: args.recurring_id, input });
      const patch: Partial<Recurring> = { recurring_id: args.recurring_id };
      if (args.name !== undefined) patch.name = args.name.trim();
      if (args.category_id !== undefined) patch.category_id = args.category_id;
      if (args.frequency !== undefined) {
        // The GraphQL enum value ANNUALLY maps to 'yearly' in the read-side cache
        // model (KNOWN_FREQUENCIES); every other lowercased value matches directly.
        const lowered = args.frequency.toLowerCase();
        patch.frequency = lowered === 'annually' ? 'yearly' : lowered;
      }
      if (args.state !== undefined) {
        patch.state = args.state.toLowerCase() as 'active' | 'paused' | 'archived';
      }
      if (args.rule?.name_contains !== undefined) patch.match_string = args.rule.name_contains;
      if (args.rule?.min_amount !== undefined) patch.min_amount = parseFloat(args.rule.min_amount);
      if (args.rule?.max_amount !== undefined) patch.max_amount = parseFloat(args.rule.max_amount);
      this.db.patchCachedRecurringUpsert(patch as Recurring);
      // Peek-merge against the GraphQL RecurringNode shape. Skip silently if
      // cache cold; same convention as updateTag/updateCategory.
      if (this.liveDb) {
        const cached = this.liveDb
          .getRecurringCache()
          .peek()
          ?.find((r) => r.id === args.recurring_id);
        if (cached) {
          const mergedRule: RecurringNode['rule'] =
            args.rule !== undefined
              ? {
                  nameContains:
                    args.rule.name_contains !== undefined
                      ? args.rule.name_contains
                      : (cached.rule?.nameContains ?? null),
                  minAmount:
                    args.rule.min_amount !== undefined
                      ? parseFloat(args.rule.min_amount)
                      : (cached.rule?.minAmount ?? null),
                  maxAmount:
                    args.rule.max_amount !== undefined
                      ? parseFloat(args.rule.max_amount)
                      : (cached.rule?.maxAmount ?? null),
                  days: args.rule.days !== undefined ? args.rule.days : (cached.rule?.days ?? null),
                }
              : cached.rule;
          const merged: RecurringNode = {
            ...cached,
            ...(args.name !== undefined ? { name: args.name.trim() } : {}),
            ...(args.category_id !== undefined ? { categoryId: args.category_id } : {}),
            ...(args.frequency !== undefined ? { frequency: args.frequency } : {}),
            ...(args.state !== undefined ? { state: args.state } : {}),
            rule: mergedRule,
          };
          this.liveDb.patchLiveRecurringUpsert(merged);
        }
      }
      return { success: true, recurring_id: result.id, updated: Object.keys(result.changed) };
    } catch (e) {
      this.afterPossiblyAppliedEntityWrite(e, 'recurring');
      if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e), { cause: e });
      throw e;
    }
  }

  /**
   * Get daily balance snapshots for accounts over time.
   *
   * Supports daily, weekly, and monthly granularity. Weekly and monthly modes
   * downsample by keeping the last data point per period.
   */
  async getBalanceHistory(options: {
    account_id?: string;
    start_date?: string;
    end_date?: string;
    granularity: BalanceHistoryGranularity;
    limit?: number;
    offset?: number;
  }): Promise<{
    count: number;
    total_count: number;
    offset: number;
    has_more: boolean;
    accounts: string[];
    balance_history: Array<{
      date: string;
      account_id: string;
      account_name?: string;
      current_balance?: number;
      available_balance?: number;
      limit?: number;
    }>;
  }> {
    const { account_id, start_date, end_date, granularity } = options;
    const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
    const validatedOffset = validateOffset(options.offset);

    if (!granularity) {
      throw new Error(
        `granularity is required — must be one of: ${BALANCE_HISTORY_GRANULARITIES.join(', ')}`
      );
    }
    if (!(BALANCE_HISTORY_GRANULARITIES as readonly string[]).includes(granularity)) {
      throw new Error(
        `Invalid granularity: ${granularity}. Must be one of: ${BALANCE_HISTORY_GRANULARITIES.join(', ')}`
      );
    }
    validateDate(start_date, 'start_date');
    validateDate(end_date, 'end_date');

    const raw = await this.db.getBalanceHistory({
      accountId: account_id,
      startDate: start_date,
      endDate: end_date,
    });

    // Downsample if needed
    let sampled = raw;
    if (granularity === 'weekly' || granularity === 'monthly') {
      // Group by account_id + period key, keep last date per group
      const grouped = new Map<string, (typeof raw)[0]>();
      for (const row of raw) {
        const periodKey =
          granularity === 'monthly'
            ? `${row.account_id}:${row.date.slice(0, 7)}` // YYYY-MM
            : `${row.account_id}:${getISOWeekKey(row.date)}`; // YYYY-Www
        const existing = grouped.get(periodKey);
        if (!existing || row.date > existing.date) {
          grouped.set(periodKey, row);
        }
      }
      sampled = [...grouped.values()].sort((a, b) => {
        const acctCmp = a.account_id.localeCompare(b.account_id);
        if (acctCmp !== 0) return acctCmp;
        return b.date.localeCompare(a.date);
      });
    }

    // Enrich with account names
    const accountNameMap = await this.db.getAccountNameMap();
    const accountSet = new Set<string>();

    const enriched = sampled.map((row) => {
      accountSet.add(row.account_id);
      return {
        date: row.date,
        account_id: row.account_id,
        account_name: accountNameMap.get(row.account_id),
        current_balance: row.current_balance,
        available_balance: row.available_balance,
        limit: row.limit ?? undefined,
      };
    });

    const totalCount = enriched.length;
    const hasMore = validatedOffset + validatedLimit < totalCount;
    const paged = enriched.slice(validatedOffset, validatedOffset + validatedLimit);

    return {
      count: paged.length,
      total_count: totalCount,
      offset: validatedOffset,
      has_more: hasMore,
      accounts: [...accountSet].sort(),
      balance_history: paged,
    };
  }

  /**
   * Get monthly progress snapshots for financial goals.
   */
  async getGoalHistory(
    options: {
      goal_id?: string;
      start_month?: string;
      end_month?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{
    count: number;
    total_count: number;
    offset: number;
    has_more: boolean;
    goal_history: Array<
      GoalHistory & {
        goal_name?: string;
      }
    >;
  }> {
    const { goal_id, start_month, end_month } = options;
    validateMonth(start_month, 'start_month');
    validateMonth(end_month, 'end_month');
    const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
    const validatedOffset = validateOffset(options.offset);

    const history = await this.db.getGoalHistory(goal_id, {
      startMonth: start_month,
      endMonth: end_month,
    });

    // Build goal name map for enrichment
    const goals = await this.db.getGoals(false);
    const goalNameMap = new Map<string, string>();
    for (const g of goals) {
      if (g.name) goalNameMap.set(g.goal_id, g.name);
    }

    const enriched = history.map((h) => ({
      ...h,
      goal_name: goalNameMap.get(h.goal_id),
    }));

    const totalCount = enriched.length;
    const hasMore = validatedOffset + validatedLimit < totalCount;
    const paged = enriched.slice(validatedOffset, validatedOffset + validatedLimit);

    return {
      count: paged.length,
      total_count: totalCount,
      offset: validatedOffset,
      has_more: hasMore,
      goal_history: paged,
    };
  }
}

/**
 * MCP tool schema definition.
 */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON Schema properties require flexible typing
    properties: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

/**
 * Create MCP tool schemas for all cache-mode read tools.
 *
 * Pure projection of the registry's `READ_TOOL_DEFS` (one `ToolDefinition`
 * per tool — schema, handler, and classification in a single object).
 *
 * CRITICAL: All tools have readOnlyHint: true as they only read data.
 *
 * @returns List of tool schema definitions
 */
export function createToolSchemas(): ToolSchema[] {
  return READ_TOOL_DEFS.map((def) => def.schema);
}

/**
 * Create MCP tool schemas for write tools.
 *
 * Pure projection of the registry's `WRITE_TOOL_DEFS`. These tools modify
 * Copilot Money data via GraphQL and are only registered when the server
 * is started with the --write flag.
 *
 * @returns List of write tool schema definitions
 */
export function createWriteToolSchemas(): ToolSchema[] {
  return WRITE_TOOL_DEFS.map((def) => def.schema);
}
