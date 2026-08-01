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
import type { LiveCopilotDatabase } from '../core/live-database.js';
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
import { graphQLErrorToMcpError } from './errors.js';
import { parsePeriod } from '../utils/date.js';
import {
  readScheduledSmokeStatus,
  type ScheduledSmokeStatus,
} from '../utils/scheduled-smoke-status.js';
import { computeTotalReturnPercent, roundAmount } from '../utils/round.js';
import { pLimit } from '../utils/concurrency.js';
import {
  getCategoryName,
  isTransferCategory,
  isIncomeCategory,
  isKnownPlaidCategory,
} from '../utils/categories.js';
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
} from '../models/index.js';
import type { GoalHistory } from '../models/goal-history.js';
import { isItemHealthy, itemNeedsAttention, getItemDisplayName } from '../models/item.js';
import { type Category, getCategoryDisplayName } from '../models/category.js';

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

/** Validate that a document ID contains only safe characters. */
function validateDocId(id: string, label: string): void {
  if (!SAFE_ID_RE.test(id)) {
    throw new Error(`Invalid ${label} format: ${id}`);
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
 * Fields returned per transaction when `compact: true` is passed to
 * get_transactions, instead of the full ~35-40 field Firestore document.
 * Covers the common "what did I spend, where, when, in what category" case.
 */
export const DEFAULT_COMPACT_TRANSACTION_FIELDS = [
  'transaction_id',
  'date',
  'name',
  'amount',
  'category_name',
  'account_id',
  'pending',
] as const;

/**
 * Project each transaction down to an explicit `fields` allowlist (or the
 * `compact` preset when no explicit list is given). Applied after
 * category_name/normalized_merchant enrichment so both are selectable.
 * A single Firestore transaction document carries ~35-40 fields (internal
 * IDs, Plaid metadata, intelligence-suggestion arrays, flags like
 * is_amazon/from_investment) that most callers never need — pulling months
 * of history at full width both wastes an MCP client's context and can push
 * a single call over response-size limits.
 */
function projectTransactionFields<T extends Record<string, unknown>>(
  txns: T[],
  options: { fields?: string[]; compact?: boolean }
): T[] {
  const fields =
    options.fields ?? (options.compact ? [...DEFAULT_COMPACT_TRANSACTION_FIELDS] : undefined);
  if (!fields || fields.length === 0) return txns;
  const fieldSet = new Set(fields);
  return txns.map((txn) => {
    const projected: Record<string, unknown> = {};
    for (const key of Object.keys(txn)) {
      if (fieldSet.has(key)) projected[key] = txn[key];
    }
    return projected as T;
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
 * Validates a date string is in YYYY-MM-DD format.
 *
 * @param date - The date string to validate
 * @param paramName - Parameter name for error messages
 * @returns The validated date string
 * @throws Error if date format is invalid
 */
function validateDate(date: string | undefined, paramName: string): string | undefined {
  if (date === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid ${paramName} format. Expected YYYY-MM-DD, got: ${date}`);
  }
  return date;
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
 * Drop split-transaction parents from a list. Each split parent's amount
 * equals the sum of its children's amounts, so any aggregation (category
 * totals, merchant grouping, recurring detection) double-counts if parents
 * are included alongside their children. Copilot hides parents in its own
 * UI for the same reason.
 */
/**
 * Ceiling on targets per bulk_edit_transactions call.
 *
 * Unlike a client-side fan-out, the whole batch is ONE server request, so this
 * bounds the size of the request body and the blast radius of a mistaken call
 * rather than any concurrency. Copilot's own web UI has no documented cap;
 * this is ours, chosen to keep a misfire recoverable by hand.
 */
const MAX_BULK_EDIT_TARGETS = 500;

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
 * Build the optimistic cache patch for one applied edit: writes to the
 * in-memory cache so a subsequent read returns the new value without needing
 * refresh_database + re-decode.
 *
 * `type` itself isn't mirrored: the local Transaction model stores Plaid's
 * `transaction_type`/`plaid_transaction_type`, not Copilot's
 * REGULAR/INCOME/INTERNAL_TRANSFER classification, so there's no field to
 * patch. Only its side-effect is patchable — INCOME/INTERNAL_TRANSFER clears
 * the category server-side (verified live), so mirror that so a follow-up read
 * doesn't show a stale category.
 */
function buildEditCachePatch(edit: TransactionEdit): Partial<Transaction> {
  const patch: Partial<Transaction> = {};
  if ('name' in edit && edit.name !== undefined) patch.name = edit.name.trim();
  if ('category_id' in edit && edit.category_id !== undefined) patch.category_id = edit.category_id;
  if ('note' in edit && edit.note !== undefined) patch.user_note = edit.note;
  if ('tag_ids' in edit && edit.tag_ids !== undefined) patch.tag_ids = edit.tag_ids;
  if ('reviewed' in edit && edit.reviewed !== undefined) patch.user_reviewed = edit.reviewed;
  if ('date' in edit && edit.date !== undefined) patch.date = edit.date;
  if ('amount' in edit && edit.amount !== undefined) patch.amount = edit.amount;
  if (edit.type === 'INCOME' || edit.type === 'INTERNAL_TRANSFER') {
    patch.category_id = '';
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
   * Initialize tools with a database connection.
   *
   * @param database - CopilotDatabase instance
   * @param graphqlClient - Optional GraphQL client for write operations.
   * @param liveDb - Optional LiveCopilotDatabase for write-through to live cache.
   */
  constructor(
    database: CopilotDatabase,
    graphqlClient?: GraphQLClient,
    liveDb?: LiveCopilotDatabase
  ) {
    this.db = database;
    this.graphqlClient = graphqlClient ?? null;
    this.liveDb = liveDb;
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
    const accounts = await this.db.getAccounts();
    const account = accounts.find((a) => a.account_id === accountId);
    return account?.name;
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
    // NEW: Field selection (issue: cache-mode transactions run ~35-40 fields wide)
    fields?: string[];
    compact?: boolean;
  }): Promise<{
    count: number;
    total_count: number;
    offset: number;
    has_more: boolean;
    // NOTE: when `fields`/`compact` narrow the response, the actual objects
    // carry fewer keys than this type promises — those are opt-in, and the
    // caller who requested the subset already knows what they asked for.
    transactions: Array<Transaction & { category_name?: string; normalized_merchant?: string }>;
    // Additional fields for special types
    type_specific_data?: Record<string, unknown>;
    // Cache limitation warning
    _cache_warning?: string;
  }> {
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
      fields,
      compact,
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
      return {
        count: 1,
        total_count: 1,
        offset: 0,
        has_more: false,
        transactions: projectTransactionFields(
          [
            {
              ...found,
              category_name: found.category_id
                ? await this.resolveCategoryName(found.category_id)
                : undefined,
              normalized_merchant: normalizeMerchantName(getTransactionDisplayName(found)),
            },
          ],
          { fields, compact }
        ),
      };
    }

    // Query transactions with higher limit for post-filtering
    let transactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      category,
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
    // MODE 3: Special transaction types
    // ============================================
    let typeSpecificData: Record<string, unknown> | undefined;

    if (transaction_type) {
      const result = this._filterByTransactionType(
        transactions,
        transaction_type,
        start_date,
        end_date
      );
      transactions = result.transactions;
      typeSpecificData = result.typeSpecificData;
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

    // Filter out user-excluded transactions (both txn.excluded and category.excluded)
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

    const totalCount = transactions.length;
    const hasMore = validatedOffset + validatedLimit < totalCount;

    // Apply pagination
    transactions = transactions.slice(validatedOffset, validatedOffset + validatedLimit);

    // Add human-readable category names and normalized merchant
    const enrichedTransactions = await Promise.all(
      transactions.map(async (txn) => ({
        ...txn,
        category_name: txn.category_id
          ? await this.resolveCategoryName(txn.category_id)
          : undefined,
        normalized_merchant: normalizeMerchantName(getTransactionDisplayName(txn)),
      }))
    );

    // Check if query may be limited by cache
    const cacheWarning = await this.db.checkCacheLimitation(start_date, end_date);

    return {
      count: enrichedTransactions.length,
      total_count: totalCount,
      offset: validatedOffset,
      has_more: hasMore,
      transactions: projectTransactionFields(enrichedTransactions, { fields, compact }),
      ...(typeSpecificData && { type_specific_data: typeSpecificData }),
      ...(cacheWarning && { _cache_warning: cacheWarning }),
    };
  }

  /**
   * Filter transactions by special type.
   * @internal
   */
  private _filterByTransactionType(
    transactions: Transaction[],
    type: TransactionTypeFilter,
    _startDate?: string,
    _endDate?: string
  ): { transactions: Transaction[]; typeSpecificData?: Record<string, unknown> } {
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
        const refundTxns = transactions.filter((txn) => {
          if (txn.amount >= 0) return false;
          if (isTransferCategory(txn.category_id)) return false;
          if (isIncomeCategory(txn.category_id)) return false;
          const name = getTransactionDisplayName(txn).toLowerCase();
          return name.includes('refund') || name.includes('return') || name.includes('reversal');
        });
        const totalRefunded = refundTxns.reduce((sum, txn) => sum + Math.abs(txn.amount), 0);
        return {
          transactions: refundTxns,
          typeSpecificData: { total_refunded: roundAmount(totalRefunded) },
        };
      }

      case 'credits': {
        const creditKeywords = ['credit', 'cashback', 'reward', 'rebate', 'bonus'];
        const creditTxns = transactions.filter((txn) => {
          if (txn.amount >= 0) return false;
          if (isTransferCategory(txn.category_id)) return false;
          if (isIncomeCategory(txn.category_id)) return false;
          const name = getTransactionDisplayName(txn).toLowerCase();
          return creditKeywords.some((kw) => name.includes(kw));
        });
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
        const medicalCategories = ['medical', 'healthcare', 'pharmacy', 'dental', 'eye_care'];
        const medicalMerchants = [
          'cvs',
          'walgreens',
          'pharmacy',
          'medical',
          'dental',
          'vision',
          'hospital',
        ];
        const hsaTxns = transactions.filter((txn) => {
          if (txn.amount <= 0) return false;
          const isMedicalCat =
            txn.category_id &&
            medicalCategories.some((c) => txn.category_id?.toLowerCase().includes(c));
          const merchantName = getTransactionDisplayName(txn).toLowerCase();
          const isMedicalMerchant = medicalMerchants.some((m) => merchantName.includes(m));
          return isMedicalCat || isMedicalMerchant;
        });
        const totalAmount = hsaTxns.reduce((sum, txn) => sum + txn.amount, 0);
        return {
          transactions: hsaTxns,
          typeSpecificData: { total_hsa_eligible: roundAmount(totalAmount) },
        };
      }

      case 'tagged': {
        const taggedTxns = transactions.filter((txn) => txn.tag_ids && txn.tag_ids.length > 0);
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
      include_logos?: boolean;
    } = {}
  ): Promise<{
    count: number;
    total_balance: number;
    total_assets: number;
    total_liabilities: number;
    accounts: Account[];
  }> {
    const { account_type, include_hidden = false, include_logos = false } = options;

    let accounts = await this.db.getAccounts(account_type);

    // Filter hidden/deleted accounts if needed (same pattern as getNetWorth)
    if (!include_hidden) {
      // Filter out accounts marked as user_deleted (merged or removed accounts)
      accounts = accounts.filter((acc) => acc.user_deleted !== true);

      // Also filter by hidden flag from user account customizations
      const userAccounts = await this.db.getUserAccounts();
      const hiddenIds = new Set(userAccounts.filter((ua) => ua.hidden).map((ua) => ua.account_id));
      accounts = accounts.filter((acc) => !hiddenIds.has(acc.account_id));
    }

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

    // `logo` is a base64-encoded PNG (several KB per account) that Firestore
    // caches alongside every account document. Left in, it dominates the
    // response (issue: ~20-30x bloat for a handful of accounts) for data an
    // MCP client has no use for. Strip it by default; include_logos opts back in.
    const responseAccounts = include_logos
      ? accounts
      : accounts.map(({ logo: _logo, logo_content_type: _logoContentType, ...rest }) => rest);

    return {
      count: accounts.length,
      total_balance: roundAmount(totalBalance),
      total_assets: roundAmount(totalAssets),
      total_liabilities: roundAmount(totalLiabilities),
      accounts: responseAccounts,
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
  }): Promise<{
    period: { start_date?: string; end_date?: string };
    count: number;
    total_monthly_cost: number;
    recurring: Array<{
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
    }>;
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
    const recurring: Array<{
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
    }> = [];

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

    return {
      period: { start_date, end_date },
      count: recurring.length,
      total_monthly_cost: roundAmount(totalMonthlyCost),
      recurring,
      ...(copilotSubscriptions ? { copilot_subscriptions: copilotSubscriptions } : {}),
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
  }> {
    const { ticker_symbol, start_date, end_date, price_type } = options;
    const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
    const validatedOffset = validateOffset(options.offset);

    if (start_date) validateDate(start_date, 'start_date');
    if (end_date) validateDate(end_date, 'end_date');

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

    return {
      count: paged.length,
      total_count: totalCount,
      offset: validatedOffset,
      has_more: hasMore,
      tickers: [...tickerSet].sort(),
      prices: paged,
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
    const { account_id, ticker_symbol, include_history = false } = options;
    const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
    const validatedOffset = validateOffset(options.offset);

    // Load data sources
    const accounts = await this.db.getAccounts();
    const securityMap = await this.db.getSecurityMap();

    // Build ticker → security_id lookup for ticker_symbol filtering
    let tickerSecurityIds: Set<string> | undefined;
    if (ticker_symbol) {
      tickerSecurityIds = new Set<string>();
      for (const [id, sec] of securityMap) {
        if (sec.ticker_symbol?.toLowerCase() === ticker_symbol.toLowerCase()) {
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
          account_name: acct.name ?? acct.official_name,
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
    const client = this.getGraphQLClient();
    if (!args.name?.trim()) throw new Error('Category name must not be empty');
    if (!args.color_name?.trim()) throw new Error('color_name is required');
    if (!args.emoji?.trim()) throw new Error('emoji is required');
    const colorName = validateColorName(args.color_name);

    // Copilot's GraphQL schema does not accept parentId on CreateCategoryInput
    // (nor on EditCategoryInput). Parent/child category hierarchies exist in
    // the local cache and can be read via get_categories(parent_id=...), but
    // they are not writable through the web app's GraphQL mutations. Reject
    // with a clear error rather than sending a request the server will refuse.
    if (args.parent_id !== undefined) {
      throw new Error(
        "parent_id is not supported on create_category: Copilot's GraphQL API " +
          'does not accept parentId on CreateCategoryInput. Create the category ' +
          'without a parent; the Copilot web app does not currently expose a ' +
          'mutation to re-parent categories.'
      );
    }

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
  private async resolveTransactionMeta(ids: string[]): Promise<{
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

    const { from, to, months } = CopilotMoneyTools.writeResolveWindow();
    if (missing.length > 0) {
      // Consult the meta index the fetch just fed rather than scanning the
      // date-filtered return value: fetchMonth feeds the index with the FULL
      // pre-trim month, so this also resolves same-month future-dated
      // transactions the rows scan missed (#513). The empty-routing-id guard
      // is enforced at the feed, so indexed entries are always valid.
      await this.liveDb.getTransactions({ from, to });
      for (const [id, m] of this.liveDb.lookupTransactionMeta(missing)) {
        out.set(id, m);
      }
    }
    // liveWindowMonths is non-null here even when no fetch ran
    // (missing.length === 0). Safe by invariant: callers only compose the
    // window error for ids absent from `meta`, and an empty `missing` means
    // every requested id IS in `meta` — the error path is unreachable
    // without an attempted fetch.
    return { meta: out, liveWindowMonths: months };
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

  /** The [from, to] date range + month count for write-resolution live
   *  fetches. Shared by resolveTransactionMeta and resolveParentSnapshot. */
  private static writeResolveWindow(): { from: string; to: string; months: number } {
    const months = CopilotMoneyTools.resolveWindowMonths();
    const to = new Date().toISOString().slice(0, 10);
    const fromDate = new Date();
    fromDate.setMonth(fromDate.getMonth() - months);
    const from = fromDate.toISOString().slice(0, 10);
    return { from, to, months };
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
  private async resolveParentSnapshot(id: string): Promise<{
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
    const { from, to, months } = CopilotMoneyTools.writeResolveWindow();
    const cached = this.liveDb.lookupTransactionNodes([id]).get(id);
    if (cached) {
      return {
        snapshot: { amount: cached.amount, date: cached.date, name: cached.name },
        liveWindowMonths: months,
      };
    }
    const live = await this.liveDb.getTransactions({ from, to });
    // Cache-first: the window cache holds same-month future-dated rows the
    // date-filtered return value misses (#513). Rows-fallback: unlike the
    // append-only meta index resolveTransactionMeta reads, the window cache
    // LRU-evicts per ingest, so a very large window can evict early months
    // before the fetch returns — the in-hand rows are immune to that.
    const n =
      this.liveDb.lookupTransactionNodes([id]).get(id) ?? live.rows.find((r) => r.id === id);
    if (!n) return { snapshot: null, liveWindowMonths: months };
    return {
      snapshot: { amount: n.amount, date: n.date, name: n.name },
      liveWindowMonths: months,
    };
  }

  /**
   * Validate a category id against the authoritative source — the live
   * categories cache (fetch-on-cold, existing TTLs) in live mode; the local
   * LevelDB cache only in degraded mode. Message contract unchanged (#510).
   */
  private async validateCategoryId(categoryId: string): Promise<void> {
    const liveDb = this.liveDb;
    if (liveDb) {
      const { rows } = await liveDb.getCategoriesCache().read(async () => {
        const rollovers = await liveDb.resolveRolloversFlag();
        return fetchCategories(liveDb.getClient(), { rollovers });
      });
      if (!rows.find((c) => c.id === categoryId)) {
        throw new Error(`Category not found: ${categoryId}`);
      }
      return;
    }
    const categories = await this.db.getUserCategories();
    if (!categories.find((c) => c.category_id === categoryId)) {
      throw new Error(`Category not found: ${categoryId}`);
    }
  }

  /** Tag-ids sibling of validateCategoryId — same mode split, same messages. */
  private async validateTagIds(tagIds: string[]): Promise<void> {
    if (tagIds.length === 0) return;
    const liveDb = this.liveDb;
    if (liveDb) {
      const { rows } = await liveDb.getTagsCache().read(() => fetchTags(liveDb.getClient()));
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
   * Per-field validation shared by update_transaction and update_transactions.
   *
   * Runs BEFORE any write so a rejected edit mutates nothing. `label` prefixes
   * every message: the singular tool passes its own name so its error strings
   * are unchanged; the plural passes `update_transactions edits[i]` so a
   * failure in a 200-row batch names the row that caused it.
   */
  private async validateEditFields(edit: TransactionEdit, label: string): Promise<void> {
    if ('name' in edit && edit.name !== undefined) {
      const trimmed = edit.name.trim();
      if (trimmed.length === 0) {
        throw new Error(`${label}: name must not be empty`);
      }
    }
    if ('category_id' in edit && edit.category_id !== undefined) {
      validateDocId(edit.category_id, 'category_id');
      await this.validateCategoryId(edit.category_id);
    }
    if ('tag_ids' in edit && edit.tag_ids !== undefined) {
      for (const tagId of edit.tag_ids) {
        validateDocId(tagId, 'tag_id');
      }
      await this.validateTagIds(edit.tag_ids);
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
      validateDate(edit.date, 'date');
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
   * Structural validation + account/item resolution for a batch of edits.
   *
   * Resolution is the reason this is batched: `resolveTransactionMeta` takes
   * an array and issues at most ONE windowed fetch for every id it can't find
   * in the meta index, so a 200-edit batch costs the same lookup as a 1-edit
   * one. Resolving per row would re-fetch the window 200 times.
   *
   * Callers supplying BOTH account_id and item_id (from a live read) bypass
   * resolution entirely for that row — that is how out-of-window transactions
   * stay writable. Half a pair is always a caller mistake; reject it rather
   * than silently resolving.
   */
  private async resolveEditRoutes(
    edits: TransactionEdit[],
    label: (index: number) => string,
    notFoundSuffix: string
  ): Promise<Array<{ id: string; accountId: string; itemId: string }>> {
    const needsResolution: string[] = [];
    edits.forEach((edit, i) => {
      if ((edit.account_id === undefined) !== (edit.item_id === undefined)) {
        throw new Error(
          `${label(i)}: account_id and item_id must be passed together (both from a live read) to bypass local resolution`
        );
      }
      if (edit.account_id !== undefined && edit.item_id !== undefined) {
        // Prefix with the row label like every other per-entry error — a bare
        // "Invalid account_id" in a 200-row batch doesn't say which row.
        try {
          validateDocId(edit.account_id, 'account_id');
          validateDocId(edit.item_id, 'item_id');
        } catch (e) {
          throw new Error(`${label(i)}: ${e instanceof Error ? e.message : String(e)}`, {
            cause: e,
          });
        }
      } else {
        needsResolution.push(edit.transaction_id);
      }
    });

    let metaMap = new Map<string, { accountId: string; itemId: string }>();
    if (needsResolution.length > 0) {
      const resolved = await this.resolveTransactionMeta(needsResolution);
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

    validateDocId(transaction_id, 'transaction_id');

    // Routing bypass: a caller-supplied account_id + item_id pair (from a
    // live read) is forwarded verbatim — no local resolution, so writes can
    // reach transactions outside the resolution window.
    const [route] = await this.resolveEditRoutes(
      [args],
      () => 'update_transaction',
      ' Pass account_id and item_id (from a live read) to write anyway.'
    );
    const resolvedAccountId = route!.accountId;
    const resolvedItemId = route!.itemId;

    // Per-field validation (runs BEFORE any write for atomicity).
    await this.validateEditFields(args, 'update_transaction');

    try {
      const result = await editTransaction(client, {
        id: transaction_id,
        accountId: resolvedAccountId,
        itemId: resolvedItemId,
        input: buildEditInput(args),
      });
      // Map GraphQL field names back to MCP API names in the response.
      const updated = Object.keys(result.changed).map((k) => EDIT_GRAPHQL_TO_API_NAME[k] ?? k);

      const patch = buildEditCachePatch(args);
      if (Object.keys(patch).length > 0) {
        this.db.patchCachedTransaction(transaction_id, patch);
        this.liveDb?.patchLiveTransaction(transaction_id, patch);
      }

      return {
        success: true,
        transaction_id: result.id,
        updated,
      };
    } catch (e) {
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
   *  1. Structural checks + account/item resolution for the WHOLE batch (one
   *     windowed fetch, not one per row).
   *  2. Per-field validation for every edit.
   *  3. Only then does the first write leave the process.
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
      validateDocId(edit.transaction_id, 'transaction_id');
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
    });

    // --- Phase 2: routing resolution, batched (one windowed fetch) ---
    const routes = await this.resolveEditRoutes(
      edits,
      label,
      ' Pass account_id and item_id (from a live read) on those entries to write anyway, or drop them from the batch.'
    );

    // --- Phase 3: per-field validation for every edit, still before any write ---
    for (const [i, edit] of edits.entries()) {
      await this.validateEditFields(edit, label(i));
    }

    // --- Phase 4: write ---
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
        const result = await editTransaction(client, {
          id: route.id,
          accountId: route.accountId,
          itemId: route.itemId,
          input: buildEditInput(edit),
        });
        indexed.push({
          index,
          transaction_id: result.id,
          updated: Object.keys(result.changed).map((k) => EDIT_GRAPHQL_TO_API_NAME[k] ?? k),
        });
        // Patch per success, not once at the end: on a partial batch the cache
        // must reflect the rows that actually landed and nothing else.
        const patch = buildEditCachePatch(edit);
        if (Object.keys(patch).length > 0) {
          this.db.patchCachedTransaction(route.id, patch);
          this.liveDb?.patchLiveTransaction(route.id, patch);
        }
      }
    );

    const results = indexed
      .sort((a, b) => a.index - b.index)
      .map(({ transaction_id, updated }) => ({ transaction_id, updated }));

    const failures = poolFailures.map(({ index, error }) => ({
      transaction_id: edits[index]!.transaction_id,
      error:
        error instanceof GraphQLError
          ? graphQLErrorToMcpError(error)
          : error instanceof Error
            ? error.message
            : String(error),
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
   * Seven required inputs, no optionals — scope is intentionally tight for
   * the first pass. The server assigns the ID; on success we return the
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
    category_id: string;
    type: TransactionType;
    tag_ids?: string[];
    note?: string;
    recurring_id?: string;
  }): Promise<{
    success: true;
    transaction_id: string;
    transaction: Transaction;
  }> {
    const client = this.getGraphQLClient();
    const { account_id, item_id, name, date, amount, category_id, type } = args;

    // Defense-in-depth validation (the MCP dispatch layer already schema-checks,
    // but methods are callable directly from tests/code).
    validateDocId(account_id, 'account_id');
    validateDocId(item_id, 'item_id');
    validateDocId(category_id, 'category_id');

    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) {
      throw new Error('name must be a non-empty string');
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Invalid date format. Expected YYYY-MM-DD, got: ${date}`);
    }

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

    // Optional metadata validation (runs BEFORE any write for atomicity).
    if (args.tag_ids !== undefined) {
      for (const tagId of args.tag_ids) {
        validateDocId(tagId, 'tag_id');
      }
      await this.validateTagIds(args.tag_ids);
    }
    if (args.recurring_id !== undefined) {
      validateDocId(args.recurring_id, 'recurring_id');
    }

    const input: CreateTransactionInput = {
      name: trimmedName,
      date,
      amount,
      categoryId: category_id,
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
      // Map the GraphQL camelCase Transaction fields back to the project's
      // local snake_case Transaction shape. Only fields Copilot actually
      // populates on create are included; the rest arrive on the next
      // refresh_database cycle.
      const transaction: Transaction = {
        transaction_id: tx.id,
        amount: tx.amount,
        date: tx.date,
        name: tx.name,
        account_id: tx.accountId,
        item_id: tx.itemId,
        category_id: tx.categoryId,
        pending: tx.isPending,
        user_reviewed: tx.isReviewed,
        user_note: tx.userNotes ?? undefined,
        recurring_id: tx.recurringId ?? undefined,
        tag_ids: tx.tags.map((t) => t.id),
        internal_transfer: tx.type === 'INTERNAL_TRANSFER',
        is_manual: true,
      };

      // Feed the live meta index so an immediate follow-up write on the new
      // transaction resolves without a network fetch. Same empty-id guard as
      // the other mutation feeds (#518) — response validation is warn-only,
      // so a drifted response must not reach the index.
      if (tx.accountId && tx.itemId) {
        this.liveDb?.indexTransactionMeta(tx.id, { accountId: tx.accountId, itemId: tx.itemId });
      }

      return {
        success: true,
        transaction_id: tx.id,
        transaction,
      };
    } catch (e) {
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
   * refresh_database. On server-returned-false OR thrown error, the
   * cache is intentionally untouched — the local state must not drift
   * away from whatever Copilot's server thinks is real.
   *
   * Note on Plaid re-sync: Plaid-connected transactions may re-appear
   * on the source account's next sync, but user-side metadata
   * (category override, tags, notes, reviewed state, goal link, split
   * children) will NOT be preserved. This tool makes no attempt to
   * detect Plaid vs manual — the warning belongs in the tool
   * description, not in runtime logic.
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
        this.liveDb?.patchLiveTransactionDelete(transaction_id);
      }

      return {
        success: true,
        transaction_id,
        deleted,
      };
    } catch (e) {
      if (e instanceof GraphQLError) {
        throw new Error(graphQLErrorToMcpError(e), { cause: e });
      }
      throw e;
    }
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
   * Cache: unlike create_transaction (where there is nothing to patch) and
   * unlike delete_transaction (which evicts the row), here the transaction
   * already exists in the cache — we patch `recurring_id` on the cached
   * row via `patchCachedTransaction` so subsequent get_transactions reads
   * reflect the link without waiting for a refresh_database cycle.
   */
  async addTransactionToRecurring(args: {
    transaction_id: string;
    account_id: string;
    item_id: string;
    recurring_id: string;
  }): Promise<{
    success: true;
    transaction_id: string;
    transaction: Transaction;
  }> {
    const client = this.getGraphQLClient();
    const { transaction_id, account_id, item_id, recurring_id } = args;

    // Defense-in-depth — the MCP schema already validates presence and
    // type, but the method is directly callable from tests and other code.
    validateDocId(transaction_id, 'transaction_id');
    validateDocId(account_id, 'account_id');
    validateDocId(item_id, 'item_id');
    validateDocId(recurring_id, 'recurring_id');

    try {
      const tx = await gqlAddTransactionToRecurring(client, {
        id: transaction_id,
        accountId: account_id,
        itemId: item_id,
        input: { recurringId: recurring_id },
      });

      // Map the GraphQL camelCase Transaction fields back to the project's
      // local snake_case Transaction shape. Mirrors createTransaction's
      // mapping — the input type is identical (TransactionFields).
      const transaction: Transaction = {
        transaction_id: tx.id,
        amount: tx.amount,
        date: tx.date,
        name: tx.name,
        account_id: tx.accountId,
        item_id: tx.itemId,
        category_id: tx.categoryId,
        pending: tx.isPending,
        user_reviewed: tx.isReviewed,
        user_note: tx.userNotes ?? undefined,
        recurring_id: tx.recurringId ?? undefined,
        tag_ids: tx.tags.map((t) => t.id),
        internal_transfer: tx.type === 'INTERNAL_TRANSFER',
      };

      // Optimistic cache patch: the transaction already exists in the
      // cache, so just update its recurring_id to match what the server
      // now says. No-op (returns false) if the cache is unloaded or the
      // id is absent — both acceptable, same as delete_transaction's
      // eviction-is-a-no-op contract.
      this.db.patchCachedTransaction(transaction_id, { recurring_id });
      this.liveDb?.patchLiveTransaction(transaction_id, { recurring_id });

      return {
        success: true,
        transaction_id,
        transaction,
      };
    } catch (e) {
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
   * Reversal: there is no `unsplitTransaction` / `revertSplit` / `undoSplit`
   * on the server (all three probed and don't exist). To "undo" a split,
   * callers must delete each child via delete_transaction and edit the
   * parent's category back via update_transaction.
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
    parent: Transaction;
    children: Transaction[];
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

      if (s.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(s.date)) {
        throw new Error(`splits[${i}].date: Expected YYYY-MM-DD, got: ${s.date}`);
      }

      if (s.name !== undefined) {
        const trimmed = s.name.trim();
        if (!trimmed) {
          throw new Error(`splits[${i}].name must be a non-empty string`);
        }
      }
    }

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
    const { snapshot: parentTxn, liveWindowMonths } =
      await this.resolveParentSnapshot(transaction_id);
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
            `Parent=${parentAmount}, sum=${sum}, diff=${diff}`
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

      // Map each server-side TransactionFields shape to the local snake_case
      // Transaction model. Same field set as create_transaction / add_to_recurring.
      const toLocal = (tx: CreatedTransaction): Transaction => ({
        transaction_id: tx.id,
        amount: tx.amount,
        date: tx.date,
        name: tx.name,
        account_id: tx.accountId,
        item_id: tx.itemId,
        category_id: tx.categoryId,
        pending: tx.isPending,
        user_reviewed: tx.isReviewed,
        user_note: tx.userNotes ?? undefined,
        recurring_id: tx.recurringId ?? undefined,
        tag_ids: tx.tags.map((t) => t.id),
        internal_transfer: tx.type === 'INTERNAL_TRANSFER',
      });

      const parent = toLocal(result.parentTransaction);
      const children = result.splitTransactions.map(toLocal);

      // Feed the live meta index with everything the mutation returned —
      // parent and children arrive as full TransactionFields — so a
      // follow-up edit on a child resolves without a network fetch. Same
      // empty-id guard as the other feeds (#508).
      for (const tx of [result.parentTransaction, ...result.splitTransactions]) {
        if (tx.accountId && tx.itemId) {
          this.liveDb?.indexTransactionMeta(tx.id, {
            accountId: tx.accountId,
            itemId: tx.itemId,
          });
        }
      }

      // Evict the parent from the in-memory cache so subsequent
      // get_transactions reads stop surfacing the now-hidden row. No-op
      // if the cache is unloaded or the id is absent — same eviction-is-a-
      // no-op contract as delete_transaction.
      this.db.patchCachedTransactionDelete(transaction_id);
      this.liveDb?.patchLiveTransactionDelete(transaction_id);

      return {
        success: true,
        parent_transaction_id: parent.transaction_id,
        child_transaction_ids: children.map((c) => c.transaction_id),
        parent,
        children,
      };
    } catch (e) {
      if (e instanceof GraphQLError) {
        throw new Error(graphQLErrorToMcpError(e), { cause: e });
      }
      throw e;
    }
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
    const result = await this.bulkEdit(
      client,
      [first!, ...rest],
      { isReviewed: reviewed },
      'review_transactions'
    );

    // Unknown ids are dropped silently by the server rather than reported in
    // failed[] (verified live). Surfacing them as a hard failure preserves the
    // pre-bulk contract: a review that didn't land must not report success.
    if (result.skipped.length > 0) {
      throw new Error(
        `review_transactions: ${result.updated.length}/${entries.length} succeeded — ` +
          `the server did not apply ${String(result.skipped.length)} transaction(s) and reported ` +
          `no error for them: ${result.skipped.join(', ')}. They may have been deleted, or the ` +
          'account_id/item_id routing may not match the transaction.'
      );
    }

    // Optimistic cache patch — only ids the server confirmed it wrote. A
    // partial batch must not leave the cache claiming writes that never
    // landed. For rows-mode entries outside the local cache both patches are
    // no-ops (same eviction-is-a-no-op contract as delete_transaction).
    for (const tx of result.updated) {
      this.db.patchCachedTransaction(tx.id, { user_reviewed: reviewed });
      this.liveDb?.patchLiveTransaction(tx.id, { user_reviewed: reviewed });
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
    outOfWindowAction: string
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
    const { meta: metaMap, liveWindowMonths } = await this.resolveTransactionMeta(transaction_ids);
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
    label: string
  ): Promise<BulkEditTransactionsResult> {
    let result: BulkEditTransactionsResult;
    try {
      result = await gqlBulkEditTransactions(client, { ids, input });
    } catch (e) {
      if (e instanceof GraphQLError) {
        throw new Error(`${label} failed: ${graphQLErrorToMcpError(e)}`, { cause: e });
      }
      throw e;
    }
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
      // unvalidated typo would report success having applied nothing.
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
    const requestedCount = (args.rows ?? args.transaction_ids)?.length ?? 0;
    if (requestedCount > MAX_BULK_EDIT_TARGETS) {
      throw new Error(
        `bulk_edit_transactions: ${String(requestedCount)} targets exceeds the maximum of ` +
          `${String(MAX_BULK_EDIT_TARGETS)} per call. Split the work into smaller batches.`
      );
    }

    const entries = await this.resolveBulkTargets(args, 'edit out-of-window transactions');
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
    const result = await this.bulkEdit(client, [first!, ...rest], input, 'bulk_edit_transactions');

    if (result.skipped.length > 0) {
      throw new Error(
        `bulk_edit_transactions: ${result.updated.length}/${entries.length} succeeded — the ` +
          `server did not apply ${String(result.skipped.length)} transaction(s) and reported no ` +
          `error for them: ${result.skipped.join(', ')}. They may have been deleted, or the ` +
          'account_id/item_id routing may not match the transaction.'
      );
    }

    // Optimistic cache patch, per confirmed row. `type` itself has no local
    // counterpart (the cache stores Plaid's transaction_type, not Copilot's
    // classification) — only its category-clearing side effect is patchable.
    // Tag add/remove is applied against the tag list the SERVER returned, not
    // recomputed locally, so the cache matches the authoritative result.
    for (const tx of result.updated) {
      const patch: Partial<Transaction> = {};
      if (category_id !== undefined) patch.category_id = category_id;
      if (reviewed !== undefined) patch.user_reviewed = reviewed;
      if (type === 'INCOME' || type === 'INTERNAL_TRANSFER') patch.category_id = '';
      if (add_tag_ids !== undefined || remove_tag_ids !== undefined) {
        patch.tag_ids = tx.tags.map((t) => t.id);
      }
      if (Object.keys(patch).length > 0) {
        this.db.patchCachedTransaction(tx.id, patch);
        this.liveDb?.patchLiveTransaction(tx.id, patch);
      }
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

    try {
      const result = await gqlSetBudget(client, {
        categoryId: args.category_id,
        amount: args.amount,
        month: args.month,
      });
      this.db.patchCachedBudget(args.category_id, parseFloat(args.amount), args.month);
      this.liveDb?.patchLiveCategoryBudget(args.category_id, parseFloat(args.amount), args.month);
      return {
        success: true,
        category_id: result.categoryId,
        amount: result.amount,
        ...(result.month ? { month: result.month } : {}),
        cleared: result.cleared,
      };
    } catch (e) {
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
    let txnMeta: { accountId: string; itemId: string };
    if (args.account_id !== undefined && args.item_id !== undefined) {
      validateDocId(args.account_id, 'account_id');
      validateDocId(args.item_id, 'item_id');
      txnMeta = { accountId: args.account_id, itemId: args.item_id };
    } else {
      // Resolve routing ids the same way update_transaction does — live-first
      // in live mode, local cache only in degraded mode. See
      // resolveTransactionMeta(). Fixes the class bug where a transaction
      // older than the local cache window could not be made recurring.
      const { meta, liveWindowMonths } = await this.resolveTransactionMeta([args.transaction_id]);
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
    if (start_date) validateDate(start_date, 'start_date');
    if (end_date) validateDate(end_date, 'end_date');

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
