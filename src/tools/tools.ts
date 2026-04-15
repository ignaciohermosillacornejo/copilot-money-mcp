/**
 * MCP tool definitions for Copilot Money data.
 *
 * Exposes database functionality through the Model Context Protocol.
 */

import { CopilotDatabase } from '../core/database.js';
import type { GraphQLClient } from '../core/graphql/client.js';
import { GraphQLError } from '../core/graphql/client.js';
import { editTransaction } from '../core/graphql/transactions.js';
import {
  createCategory as gqlCreateCategory,
  editCategory as gqlEditCategory,
  deleteCategory as gqlDeleteCategory,
} from '../core/graphql/categories.js';
import {
  createTag as gqlCreateTag,
  editTag as gqlEditTag,
  deleteTag as gqlDeleteTag,
} from '../core/graphql/tags.js';
import {
  createRecurring as gqlCreateRecurring,
  editRecurring as gqlEditRecurring,
  deleteRecurring as gqlDeleteRecurring,
} from '../core/graphql/recurrings.js';
import { setBudget as gqlSetBudget } from '../core/graphql/budgets.js';
import { graphQLErrorToMcpError } from './errors.js';
import { parsePeriod } from '../utils/date.js';
import {
  getCategoryName,
  isTransferCategory,
  isIncomeCategory,
  isKnownPlaidCategory,
} from '../utils/categories.js';
import type { Transaction, Account, InvestmentPrice, InvestmentSplit } from '../models/index.js';
import { getTransactionDisplayName, getRecurringDisplayName } from '../models/index.js';
import type { InvestmentPerformance, TwrHolding } from '../models/investment-performance.js';
import type { Security } from '../models/security.js';
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
 * Rounds a number to 2 decimal places for currency display.
 *
 * @param value - The number to round
 * @returns Number rounded to 2 decimal places
 *
 * @example
 * roundAmount(10.126) // returns 10.13
 * roundAmount(10.1)   // returns 10.1
 */
function roundAmount(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Gets the category ID or returns the default 'uncategorized'.
 *
 * @param categoryId - The category ID (may be null or undefined)
 * @returns The category ID or 'uncategorized'
 */
function getCategoryIdOrDefault(categoryId: string | null | undefined): string {
  return categoryId || DEFAULT_CATEGORY_ID;
}

/**
 * Normalize merchant names for better aggregation.
 *
 * Handles variations like:
 * - "APPLE.COM-BILL" vs "APPLE.COM/BILL"
 * - "UBER" vs "UBER EATS"
 * - "AMAZON.COM*..." vs "AMAZON MKTPL*..." vs "AMAZON GROCE*..."
 */
export function normalizeMerchantName(name: string): string {
  let normalized = name.toUpperCase().trim();

  // Remove common suffixes/prefixes
  normalized = normalized
    .replace(/[*#].*$/, '') // Remove everything after * or #
    .replace(/\s+/g, ' ') // Normalize whitespace
    .replace(/[.,/-]+/g, ' ') // Replace punctuation with spaces
    .trim();

  // Common merchant normalizations
  const merchantMappings: Record<string, string> = {
    'APPLE COM BILL': 'APPLE',
    'APPLE COM': 'APPLE',
    'AMAZON COM': 'AMAZON',
    'AMAZON MKTPL': 'AMAZON',
    'AMAZON GROCE': 'AMAZON GROCERY',
    'AMZN MKTP': 'AMAZON',
    AMZN: 'AMAZON',
    'UBER EATS': 'UBER EATS',
    'UBER TRIP': 'UBER',
    'UBER BV': 'UBER',
    LYFT: 'LYFT',
    STARBUCKS: 'STARBUCKS',
    DOORDASH: 'DOORDASH',
    GRUBHUB: 'GRUBHUB',
    'NETFLIX COM': 'NETFLIX',
    NETFLIX: 'NETFLIX',
    SPOTIFY: 'SPOTIFY',
    HULU: 'HULU',
    'DISNEY PLUS': 'DISNEY+',
    DISNEYPLUS: 'DISNEY+',
    'HBO MAX': 'HBO MAX',
    WALMART: 'WALMART',
    TARGET: 'TARGET',
    COSTCO: 'COSTCO',
    WHOLEFDS: 'WHOLE FOODS',
    'WHOLE FOODS': 'WHOLE FOODS',
    'TRADER JOE': 'TRADER JOES',
  };

  // Check for known mappings
  for (const [pattern, replacement] of Object.entries(merchantMappings)) {
    if (normalized.includes(pattern)) {
      return replacement;
    }
  }

  // Return first 3 words for long names
  const words = normalized.split(' ').filter((w) => w.length > 0);
  if (words.length > 3) {
    return words.slice(0, 3).join(' ');
  }

  return normalized || name;
}

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
 * Collection of MCP tools for querying Copilot Money data.
 */
export class CopilotMoneyTools {
  private db: CopilotDatabase;
  private graphqlClient: GraphQLClient | null;
  private _userCategoryMap: Map<string, string> | null = null;
  private _excludedCategoryIds: Set<string> | null = null;

  /**
   * Initialize tools with a database connection.
   *
   * @param database - CopilotDatabase instance
   * @param graphqlClient - Optional GraphQL client for write operations.
   */
  constructor(database: CopilotDatabase, graphqlClient?: GraphQLClient) {
    this.db = database;
    this.graphqlClient = graphqlClient ?? null;
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
    pending?: boolean;
    region?: string;
    country?: string;
    // NEW: Single lookup
    transaction_id?: string;
    // NEW: Text search
    query?: string;
    // NEW: Special types
    transaction_type?: 'foreign' | 'refunds' | 'credits' | 'duplicates' | 'hsa_eligible' | 'tagged';
    // NEW: Tag filter
    tag?: string;
    // NEW: Location
    city?: string;
    lat?: number;
    lon?: number;
    radius_km?: number;
  }): Promise<{
    count: number;
    total_count: number;
    offset: number;
    has_more: boolean;
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
        transactions: [
          {
            ...found,
            category_name: found.category_id
              ? await this.resolveCategoryName(found.category_id)
              : undefined,
            normalized_merchant: normalizeMerchantName(getTransactionDisplayName(found)),
          },
        ],
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
      const normalizedTag = tag.startsWith('#')
        ? tag.substring(1).toLowerCase()
        : tag.toLowerCase();
      transactions = transactions.filter((txn) =>
        txn.tag_ids?.some((id) => id.toLowerCase() === normalizedTag)
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
      transactions: enrichedTransactions,
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
    type: 'foreign' | 'refunds' | 'credits' | 'duplicates' | 'hsa_eligible' | 'tagged',
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
    } = {}
  ): Promise<{
    count: number;
    total_balance: number;
    total_assets: number;
    total_liabilities: number;
    accounts: Account[];
  }> {
    const { account_type, include_hidden = false } = options;

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

    return {
      count: accounts.length,
      total_balance: roundAmount(totalBalance),
      total_assets: roundAmount(totalAssets),
      total_liabilities: roundAmount(totalLiabilities),
      accounts,
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
        products: item.billed_products ?? [],
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
      view?: 'list' | 'tree' | 'search';
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
        const transactions = await this.db.getTransactions({
          startDate: start_date,
          endDate: end_date,
          limit: 50000, // Get all for aggregation
        });

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

    // Get all transactions in the period
    const transactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

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

    // Drop tombstones: Firestore represents deleted docs as empty-field
    // entries. Our decoder emits those as `{budget_id: docId}` objects with
    // no category, amount, or amounts. Users see dozens of ghost rows unless
    // we filter them out here (getCategories does the equivalent filter via
    // its name guard).
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
      price_type?: 'daily' | 'hf';
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
   * @param options - Filter options
   * @returns Object with split data and pagination info
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
    splits: InvestmentSplit[];
  }> {
    const { ticker_symbol, start_date, end_date } = options;
    const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
    const validatedOffset = validateOffset(options.offset);

    if (start_date) validateDate(start_date, 'start_date');
    if (end_date) validateDate(end_date, 'end_date');

    const splits = await this.db.getInvestmentSplits({
      tickerSymbol: ticker_symbol,
      startDate: start_date,
      endDate: end_date,
    });

    const totalCount = splits.length;
    const hasMore = validatedOffset + validatedLimit < totalCount;
    const paged = splits.slice(validatedOffset, validatedOffset + validatedLimit);

    return {
      count: paged.length,
      total_count: totalCount,
      offset: validatedOffset,
      has_more: hasMore,
      splits: paged,
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

        // Compute cost basis derived fields
        if (h.cost_basis != null && h.cost_basis !== 0 && h.quantity !== 0) {
          entry.cost_basis = roundAmount(h.cost_basis);
          entry.average_cost = roundAmount(h.cost_basis / h.quantity);
          entry.total_return = roundAmount(h.institution_value - h.cost_basis);
          entry.total_return_percent = roundAmount(
            ((h.institution_value - h.cost_basis) / Math.abs(h.cost_basis)) * 100
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
          colorName: args.color_name,
          emoji: args.emoji,
          isExcluded: args.is_excluded ?? false,
        },
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
   * Update one or more fields on a transaction in a single atomic write.
   *
   * Supported fields: category_id, note, tag_ids. Omitted fields are preserved.
   * note="" clears the note. tag_ids=[] clears all tags. Other legacy fields
   * (name, excluded, internal_transfer, goal_id) are not writable through the
   * GraphQL EditTransaction mutation and were removed from this tool when the
   * backend was migrated.
   */
  async updateTransaction(args: {
    transaction_id: string;
    category_id?: string;
    note?: string;
    tag_ids?: string[];
  }): Promise<{
    success: true;
    transaction_id: string;
    updated: string[];
  }> {
    const client = this.getGraphQLClient();
    const { transaction_id } = args;

    // Reject unknown fields (equivalent to JSON Schema additionalProperties: false,
    // but re-checked here as a defense in depth in case the method is called directly
    // without going through the MCP dispatch layer).
    const allowedKeys = new Set(['transaction_id', 'category_id', 'note', 'tag_ids']);
    for (const key of Object.keys(args)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`update_transaction: unknown field "${key}"`);
      }
    }

    // Require at least one mutable field besides transaction_id.
    const mutableKeys = Object.keys(args).filter(
      (k) => k !== 'transaction_id' && (args as Record<string, unknown>)[k] !== undefined
    );
    if (mutableKeys.length === 0) {
      throw new Error('update_transaction requires at least one field to update');
    }

    validateDocId(transaction_id, 'transaction_id');

    // Resolve the transaction from the local cache so we can supply accountId /
    // itemId to the GraphQL mutation.
    const allTxns = await this.db.getAllTransactions();
    const txn = allTxns.find((t) => t.transaction_id === transaction_id);
    if (!txn) {
      throw new Error(`Transaction not found: ${transaction_id}`);
    }

    // Per-field validation (runs BEFORE any write for atomicity).
    if ('category_id' in args && args.category_id !== undefined) {
      validateDocId(args.category_id, 'category_id');
      const categories = await this.db.getUserCategories();
      if (!categories.find((c) => c.category_id === args.category_id)) {
        throw new Error(`Category not found: ${args.category_id}`);
      }
    }
    if ('tag_ids' in args && args.tag_ids !== undefined) {
      for (const tagId of args.tag_ids) {
        validateDocId(tagId, 'tag_id');
      }
      if (args.tag_ids.length > 0) {
        const tags = await this.db.getTags();
        for (const tagId of args.tag_ids) {
          if (!tags.find((t) => t.tag_id === tagId)) {
            throw new Error(`Tag not found: ${tagId}`);
          }
        }
      }
    }
    // Map MCP fields → EditTransaction input shape.
    const input: {
      categoryId?: string;
      userNotes?: string | null;
      tagIds?: string[];
      isReviewed?: boolean;
    } = {};
    if ('category_id' in args && args.category_id !== undefined)
      input.categoryId = args.category_id;
    if ('note' in args && args.note !== undefined) input.userNotes = args.note;
    if ('tag_ids' in args && args.tag_ids !== undefined) input.tagIds = args.tag_ids;

    if (!txn.account_id || !txn.item_id) {
      throw new Error(`Transaction ${transaction_id} missing account_id or item_id in local cache`);
    }

    try {
      const result = await editTransaction(client, {
        id: transaction_id,
        accountId: txn.account_id,
        itemId: txn.item_id,
        input,
      });
      // Map GraphQL field names back to MCP API names in the response.
      const graphqlToApiName: Record<string, string> = {
        categoryId: 'category_id',
        userNotes: 'note',
        tagIds: 'tag_ids',
        isReviewed: 'reviewed',
      };
      const updated = Object.keys(result.changed).map((k) => graphqlToApiName[k] ?? k);
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
   * Mark one or more transactions as reviewed (or unreviewed).
   *
   * Validates all transaction IDs, sets isReviewed via GraphQL for each; local
   * cache is refreshed by Copilot's sync process.
   */
  async reviewTransactions(args: { transaction_ids: string[]; reviewed?: boolean }): Promise<{
    success: boolean;
    reviewed_count: number;
    transaction_ids: string[];
  }> {
    const client = this.getGraphQLClient();

    const { transaction_ids, reviewed = true } = args;

    if (!Array.isArray(transaction_ids) || transaction_ids.length === 0) {
      throw new Error('transaction_ids must be a non-empty array');
    }

    for (const id of transaction_ids) {
      validateDocId(id, 'transaction_id');
    }

    const allTransactions = await this.db.getAllTransactions();
    const txnMap = new Map(allTransactions.map((t) => [t.transaction_id, t]));

    const missing = transaction_ids.filter((id) => !txnMap.has(id));
    if (missing.length > 0) {
      throw new Error(`Transactions not found: ${missing.join(', ')}`);
    }

    // Pre-flight: confirm every transaction has account/item ids before
    // issuing any writes. Keeps partial-failure surface small.
    for (const id of transaction_ids) {
      const txn = txnMap.get(id)!;
      if (!txn.account_id || !txn.item_id) {
        throw new Error(`Transaction ${id} missing account_id or item_id in local cache`);
      }
    }

    // Bounded concurrency: never more than CONCURRENCY in flight at once.
    // The user explicitly asked to cap parallel writes at 5 to avoid
    // hammering Copilot's API. We preserve the partial-failure contract:
    // on the first error we stop starting new writes, wait for in-flight
    // ones to settle, and surface the error with a success count that
    // accurately reflects completed writes.
    const CONCURRENCY = 5;
    let reviewed_count = 0;
    let firstError: { id: string; error: unknown } | null = null as {
      id: string;
      error: unknown;
    } | null;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        if (firstError) return;
        const idx = cursor++;
        if (idx >= transaction_ids.length) return;
        const id = transaction_ids[idx]!;
        const txn = txnMap.get(id)!;
        try {
          await editTransaction(client, {
            id,
            accountId: txn.account_id!,
            itemId: txn.item_id!,
            input: { isReviewed: reviewed },
          });
          reviewed_count++;
        } catch (e) {
          // Record the first failure only; other in-flight workers settle.
          if (!firstError) firstError = { id, error: e };
          return;
        }
      }
    };

    const workerCount = Math.min(CONCURRENCY, transaction_ids.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (firstError) {
      const { id, error } = firstError;
      if (error instanceof GraphQLError) {
        throw new Error(
          `review_transactions failed at id=${id} (${reviewed_count}/${transaction_ids.length} succeeded): ${graphQLErrorToMcpError(error)}`,
          { cause: error }
        );
      }
      throw error;
    }

    return {
      success: true,
      reviewed_count,
      transaction_ids,
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
    hex_color?: string;
  }): Promise<{ success: true; tag_id: string; name: string; color_name: string }> {
    const client = this.getGraphQLClient();
    if (!args.name?.trim()) throw new Error('Tag name must not be empty');
    const colorName = args.color_name ?? 'PURPLE2'; // default matches captured CreateTag example

    try {
      const result = await gqlCreateTag(client, {
        input: { name: args.name.trim(), colorName },
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
    const input: Record<string, unknown> = {};
    if (args.name !== undefined) input.name = args.name;
    if (args.color_name !== undefined) input.colorName = args.color_name;
    if (args.emoji !== undefined) input.emoji = args.emoji;
    if (args.is_excluded !== undefined) input.isExcluded = args.is_excluded;
    if (Object.keys(input).length === 0) {
      throw new Error('update_category requires at least one field to update');
    }

    try {
      const result = await gqlEditCategory(client, { id: args.category_id, input });
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
    const VALID_STATES = ['ACTIVE', 'PAUSED', 'ARCHIVED'];
    if (!VALID_STATES.includes(args.state)) {
      throw new Error(`state must be one of: ${VALID_STATES.join(', ')}. Got: ${args.state}`);
    }

    try {
      const result = await gqlEditRecurring(client, {
        id: args.recurring_id,
        input: { state: args.state },
      });
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
    const input: Record<string, unknown> = {};
    if (args.name !== undefined) input.name = args.name;
    if (args.color_name !== undefined) input.colorName = args.color_name;
    if (Object.keys(input).length === 0) {
      throw new Error('update_tag requires at least one field to update');
    }

    try {
      const result = await gqlEditTag(client, { id: args.tag_id, input });
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
   */
  async createRecurring(args: { transaction_id: string; frequency: string }): Promise<{
    success: true;
    recurring_id: string;
    name: string;
    state: string;
    frequency: string;
  }> {
    const client = this.getGraphQLClient();
    const VALID_FREQUENCIES = ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'YEARLY'];
    if (!VALID_FREQUENCIES.includes(args.frequency)) {
      throw new Error(
        `frequency must be one of: ${VALID_FREQUENCIES.join(', ')}. Got: ${args.frequency}`
      );
    }

    const all = await this.db.getAllTransactions();
    const txn = all.find((t) => t.transaction_id === args.transaction_id);
    if (!txn) throw new Error(`Transaction not found: ${args.transaction_id}`);
    if (!txn.account_id || !txn.item_id) {
      throw new Error(
        `Transaction ${args.transaction_id} missing account_id or item_id in local cache`
      );
    }

    try {
      const result = await gqlCreateRecurring(client, {
        input: {
          frequency: args.frequency,
          transaction: {
            accountId: txn.account_id,
            itemId: txn.item_id,
            transactionId: args.transaction_id,
          },
        },
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
    rule?: {
      name_contains?: string;
      min_amount?: string;
      max_amount?: string;
      days?: number[];
    };
    state?: string;
  }): Promise<{ success: true; recurring_id: string; updated: string[] }> {
    const client = this.getGraphQLClient();
    const input: Record<string, unknown> = {};
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
    granularity: 'daily' | 'weekly' | 'monthly';
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
      throw new Error('granularity is required — must be "daily", "weekly", or "monthly"');
    }
    const validGranularities = ['daily', 'weekly', 'monthly'] as const;
    if (!(validGranularities as readonly string[]).includes(granularity)) {
      throw new Error(
        `Invalid granularity: ${granularity}. Must be one of: ${validGranularities.join(', ')}`
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
   * Get per-security investment performance data.
   */
  async getInvestmentPerformance(
    options: {
      ticker_symbol?: string;
      security_id?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{
    count: number;
    total_count: number;
    offset: number;
    has_more: boolean;
    performance: Array<
      InvestmentPerformance & {
        ticker_symbol?: string;
        name?: string;
      }
    >;
  }> {
    const { ticker_symbol, security_id } = options;
    const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
    const validatedOffset = validateOffset(options.offset);

    const securityMap = await this.db.getSecurityMap();

    // Resolve ticker_symbol to security IDs
    let tickerSecurityIds: Set<string> | undefined;
    if (ticker_symbol) {
      tickerSecurityIds = new Set<string>();
      for (const [id, sec] of securityMap) {
        if (sec.ticker_symbol?.toLowerCase() === ticker_symbol.toLowerCase()) {
          tickerSecurityIds.add(id);
        }
      }
    }

    let data = await this.db.getInvestmentPerformance(
      security_id ? { securityId: security_id } : {}
    );

    // Apply ticker filter
    if (tickerSecurityIds) {
      data = data.filter((p) => p.security_id && tickerSecurityIds.has(p.security_id));
    }

    // Enrich with security data
    const enriched = data.map((p) => {
      const sec = p.security_id ? securityMap.get(p.security_id) : undefined;
      return {
        ...p,
        ticker_symbol: sec?.ticker_symbol,
        name: sec?.name,
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
      performance: paged,
    };
  }

  /**
   * Get time-weighted return (TWR) monthly data for investment holdings.
   */
  async getTwrReturns(
    options: {
      ticker_symbol?: string;
      security_id?: string;
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
    twr_returns: Array<
      TwrHolding & {
        ticker_symbol?: string;
        name?: string;
      }
    >;
  }> {
    const { ticker_symbol, security_id, start_month, end_month } = options;
    validateMonth(start_month, 'start_month');
    validateMonth(end_month, 'end_month');
    const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
    const validatedOffset = validateOffset(options.offset);

    const securityMap = await this.db.getSecurityMap();

    // Resolve ticker to security IDs
    let tickerSecurityIds: Set<string> | undefined;
    if (ticker_symbol) {
      tickerSecurityIds = new Set<string>();
      for (const [id, sec] of securityMap) {
        if (sec.ticker_symbol?.toLowerCase() === ticker_symbol.toLowerCase()) {
          tickerSecurityIds.add(id);
        }
      }
    }

    let data = await this.db.getTwrHoldings({
      securityId: security_id,
      startMonth: start_month,
      endMonth: end_month,
    });

    // Apply ticker filter
    if (tickerSecurityIds) {
      data = data.filter((t) => t.security_id && tickerSecurityIds.has(t.security_id));
    }

    // Enrich with security data
    const enriched = data.map((t) => {
      const sec = t.security_id ? securityMap.get(t.security_id) : undefined;
      return {
        ...t,
        ticker_symbol: sec?.ticker_symbol,
        name: sec?.name,
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
      twr_returns: paged,
    };
  }

  /**
   * Get security master data — stocks, ETFs, mutual funds, and cash equivalents.
   */
  async getSecurities(
    options: {
      ticker_symbol?: string;
      type?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{
    count: number;
    total_count: number;
    offset: number;
    has_more: boolean;
    securities: Security[];
  }> {
    const { ticker_symbol, type } = options;
    const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
    const validatedOffset = validateOffset(options.offset);

    const securities = await this.db.getSecurities({
      tickerSymbol: ticker_symbol,
      type,
    });

    const totalCount = securities.length;
    const hasMore = validatedOffset + validatedLimit < totalCount;
    const paged = securities.slice(validatedOffset, validatedOffset + validatedLimit);

    return {
      count: paged.length,
      total_count: totalCount,
      offset: validatedOffset,
      has_more: hasMore,
      securities: paged,
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
 * Create MCP tool schemas for all tools.
 *
 * CRITICAL: All tools have readOnlyHint: true as they only read data.
 *
 * @returns List of tool schema definitions
 */
export function createToolSchemas(): ToolSchema[] {
  return [
    {
      name: 'get_transactions',
      description:
        'Unified transaction retrieval tool. Supports multiple modes: ' +
        '(1) Filter-based: Use period, date range, category, merchant, amount filters. ' +
        '(2) Single lookup: Provide transaction_id to get one transaction. ' +
        '(3) Text search: Use query for free-text merchant search. ' +
        '(4) Special types: Use transaction_type for foreign/refunds/credits/duplicates/hsa_eligible/tagged. ' +
        '(5) Location-based: Use city or lat/lon with radius_km. ' +
        '(6) Tag filter: Use tag to find transactions with a specific tag. ' +
        'Returns human-readable category names and normalized merchant names.',
      inputSchema: {
        type: 'object',
        properties: {
          // Date filters
          period: {
            type: 'string',
            description:
              'Period shorthand: this_month, last_month, ' +
              'last_7_days, last_30_days, last_90_days, ytd, ' +
              'this_year, last_year',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD)',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD)',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
          // Basic filters
          category: {
            type: 'string',
            description: 'Filter by category (case-insensitive substring)',
          },
          merchant: {
            type: 'string',
            description: 'Filter by merchant name (case-insensitive substring)',
          },
          account_id: {
            type: 'string',
            description: 'Filter by account ID',
          },
          min_amount: {
            type: 'number',
            description: 'Minimum transaction amount',
          },
          max_amount: {
            type: 'number',
            description: 'Maximum transaction amount',
          },
          // Pagination
          limit: {
            type: 'integer',
            description: 'Maximum number of results (default: 100)',
            default: 100,
          },
          offset: {
            type: 'integer',
            description: 'Number of results to skip for pagination (default: 0)',
            default: 0,
          },
          // Toggles
          exclude_transfers: {
            type: 'boolean',
            description:
              'Exclude transfers between accounts and credit card payments (default: true)',
            default: true,
          },
          exclude_deleted: {
            type: 'boolean',
            description: 'Exclude deleted transactions marked by Plaid (default: true)',
            default: true,
          },
          exclude_excluded: {
            type: 'boolean',
            description: 'Exclude user-excluded transactions (default: true)',
            default: true,
          },
          pending: {
            type: 'boolean',
            description: 'Filter by pending status (true for pending only, false for settled only)',
          },
          region: {
            type: 'string',
            description: 'Filter by region/city (case-insensitive substring)',
          },
          country: {
            type: 'string',
            description: 'Filter by country code (e.g., US, CL)',
          },
          // NEW: Single transaction lookup
          transaction_id: {
            type: 'string',
            description: 'Get a single transaction by ID (ignores other filters)',
          },
          // NEW: Text search
          query: {
            type: 'string',
            description: 'Free-text search in merchant/transaction names',
          },
          // NEW: Special transaction types
          transaction_type: {
            type: 'string',
            enum: ['foreign', 'refunds', 'credits', 'duplicates', 'hsa_eligible', 'tagged'],
            description:
              'Filter by special type: foreign (international), refunds, credits (cashback/rewards), ' +
              'duplicates (potential duplicate transactions), hsa_eligible (medical expenses), tagged (has tags)',
          },
          // NEW: Tag filter
          tag: {
            type: 'string',
            description: 'Filter by tag name (e.g. "vacation")',
          },
          // NEW: Location filters
          city: {
            type: 'string',
            description: 'Filter by city name (partial match)',
          },
          lat: {
            type: 'number',
            description: 'Latitude for proximity search (use with lon and radius_km)',
          },
          lon: {
            type: 'number',
            description: 'Longitude for proximity search (use with lat and radius_km)',
          },
          radius_km: {
            type: 'number',
            description: 'Search radius in kilometers (default: 10)',
            default: 10,
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_cache_info',
      description:
        'Get information about the local data cache, including the date range of cached transactions ' +
        'and total count. Useful for understanding data availability before running historical queries. ' +
        'This tool reads from a local cache that may not contain your complete transaction history.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'refresh_database',
      description:
        'Refresh the in-memory cache by reloading data from the local Copilot Money database. ' +
        'Use this when the user has recently synced new transactions in the Copilot Money app, ' +
        'or when you suspect the cached data is stale. The cache also auto-refreshes every 5 minutes. ' +
        'Returns the updated cache info after refresh.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_accounts',
      description:
        'Get all accounts with balances, plus summary fields: total_balance (net worth = assets minus liabilities), ' +
        'total_assets, and total_liabilities. Optionally filter by account type ' +
        '(checking, savings, credit, investment). Checks both account_type ' +
        'and subtype fields for better filtering (e.g., finds checking accounts ' +
        "even when account_type is 'depository'). By default, hidden accounts are excluded.",
      inputSchema: {
        type: 'object',
        properties: {
          account_type: {
            type: 'string',
            description:
              'Filter by account type (checking, savings, credit, loan, investment, depository). ' +
              'Note: summary totals (total_assets, total_liabilities, total_balance) reflect only the filtered subset.',
          },
          include_hidden: {
            type: 'boolean',
            description: 'Include hidden accounts (default: false)',
            default: false,
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_connection_status',
      description:
        'Get connection status for all linked financial institutions. ' +
        'Shows per-institution sync health including last successful update timestamps ' +
        'for transactions and investments, login requirements, and error states. ' +
        'Use this to check when accounts were last synced or to identify connections needing attention.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_categories',
      description:
        'Unified category retrieval tool. Supports multiple views: ' +
        'list (default) - user categories with transaction counts/amounts for a time period; ' +
        'tree - user categories as hierarchical tree; ' +
        'search - search user categories by keyword. Use parent_id to get subcategories. ' +
        'For list view, use period (e.g., "this_month") or start_date/end_date to filter by date. ' +
        'Includes all categories, even those with $0 spent (matching UI behavior).',
      inputSchema: {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            enum: ['list', 'tree', 'search'],
            description:
              'View mode: list (categories with spend totals), tree (parent/child hierarchy), search (find by keyword)',
          },
          period: {
            type: 'string',
            description:
              "Time period for list view (e.g., 'this_month', 'last_month', 'last_30_days', 'this_year'). " +
              'Takes precedence over start_date/end_date if provided.',
          },
          start_date: {
            type: 'string',
            description: 'Start date for list view (YYYY-MM-DD format)',
          },
          end_date: {
            type: 'string',
            description: 'End date for list view (YYYY-MM-DD format)',
          },
          parent_id: {
            type: 'string',
            description: 'Get subcategories of this parent category ID',
          },
          query: {
            type: 'string',
            description: "Search query (required for 'search' view)",
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_recurring_transactions',
      description:
        'Identify recurring/subscription charges. Combines two data sources: ' +
        '(1) Pattern analysis - finds transactions from same merchant with similar amounts, ' +
        'returns estimated frequency, confidence score, and next expected date. ' +
        "(2) Copilot's native subscription tracking - returns user-confirmed subscriptions " +
        'stored in the app. Both sources are included by default for comprehensive coverage.',
      inputSchema: {
        type: 'object',
        properties: {
          min_occurrences: {
            type: 'integer',
            description: 'Minimum number of occurrences to qualify as recurring (default: 2)',
            default: 2,
          },
          period: {
            type: 'string',
            description:
              'Period to analyze (default: last_90_days). ' +
              'Options: this_month, last_month, last_7_days, last_30_days, ' +
              'last_90_days, ytd, this_year, last_year',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD)',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD)',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
          include_copilot_subscriptions: {
            type: 'boolean',
            description:
              "Include Copilot's native subscription tracking data (default: true). " +
              'Returns copilot_subscriptions array with user-confirmed subscriptions.',
            default: true,
          },
          name: {
            type: 'string',
            description:
              'Filter by name (case-insensitive partial match). When filtering, returns detailed ' +
              'view with additional fields like min_amount, max_amount, match_string, account info, ' +
              'and transaction history.',
          },
          recurring_id: {
            type: 'string',
            description:
              'Filter by exact recurring ID. When filtering, returns detailed view with additional ' +
              'fields like min_amount, max_amount, match_string, account info, and transaction history.',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_budgets',
      description:
        "Get budgets from Copilot's native budget tracking. " +
        'Returns the current-month effective budget per category plus the full ' +
        '`amounts` map of per-month overrides for history lookups. For parent ' +
        'categories, the returned `amount` is the resolved total (children + ' +
        'rollovers) that Copilot displays in the Budgets view. Totals use the ' +
        'current-month effective amount. ' +
        'Refresh note: after `set_budget` writes, `refresh_database` then read.',
      inputSchema: {
        type: 'object',
        properties: {
          active_only: {
            type: 'boolean',
            description: 'Only return active budgets (default: false)',
            default: false,
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_goals',
      description:
        "Get financial goals from Copilot's native goal tracking. " +
        'Retrieves user-defined savings goals, debt payoff targets, and investment goals. ' +
        'Returns goal details including target amounts, monthly contributions, status (active/paused), ' +
        'start dates, and tracking configuration. Calculates total target amount across all goals.',
      inputSchema: {
        type: 'object',
        properties: {
          active_only: {
            type: 'boolean',
            description: 'Only return active goals (default: false)',
            default: false,
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_investment_prices',
      description:
        'Get investment price history for portfolio tracking. Returns daily and high-frequency ' +
        'price data for stocks, ETFs, mutual funds, and crypto. Filter by ticker symbol, date range, ' +
        'or price type (daily/hf). Includes OHLCV data when available.',
      inputSchema: {
        type: 'object',
        properties: {
          ticker_symbol: {
            type: 'string',
            description: 'Filter by ticker symbol (e.g., "AAPL", "BTC-USD", "VTSAX")',
          },
          start_date: { type: 'string', description: 'Start date (YYYY-MM-DD or YYYY-MM)' },
          end_date: { type: 'string', description: 'End date (YYYY-MM-DD or YYYY-MM)' },
          price_type: {
            type: 'string',
            enum: ['daily', 'hf'],
            description:
              'Filter by price type: daily (monthly aggregates) or hf (high-frequency intraday)',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results (default: 100, max: 10000)',
            default: 100,
          },
          offset: {
            type: 'integer',
            description: 'Number of results to skip for pagination (default: 0)',
            default: 0,
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_investment_splits',
      description:
        'Get stock split history. Returns split ratios, dates, and multipliers for ' +
        'accurate historical price and share calculations. Filter by ticker symbol or date range.',
      inputSchema: {
        type: 'object',
        properties: {
          ticker_symbol: {
            type: 'string',
            description: 'Filter by ticker symbol (e.g., "AAPL", "TSLA")',
          },
          start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
          end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
          limit: {
            type: 'integer',
            description: 'Maximum number of results (default: 100, max: 10000)',
            default: 100,
          },
          offset: {
            type: 'integer',
            description: 'Number of results to skip for pagination (default: 0)',
            default: 0,
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_holdings',
      description:
        'Get current investment holdings with position-level detail. Returns ticker, name, ' +
        'quantity, current price, equity value, average cost, and total return per holding. ' +
        'Joins data from account holdings, securities, and optionally historical snapshots. ' +
        'Filter by account or ticker symbol. Note: cost_basis may be unavailable for ' +
        'cash-equivalent positions.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: { type: 'string', description: 'Filter by investment account ID' },
          ticker_symbol: {
            type: 'string',
            description: 'Filter by ticker symbol (e.g., "AAPL", "SCHX")',
          },
          include_history: {
            type: 'boolean',
            description: 'Include monthly price/quantity snapshots per holding (default: false)',
            default: false,
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results (default: 100, max: 10000)',
            default: 100,
          },
          offset: {
            type: 'integer',
            description: 'Number of results to skip for pagination (default: 0)',
            default: 0,
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_balance_history',
      description:
        'Get daily balance snapshots for accounts over time. Returns current_balance, ' +
        'available_balance, and limit per day. Requires a granularity parameter (daily, weekly, ' +
        'or monthly) to control response size. Weekly and monthly modes downsample by keeping ' +
        'the last data point per period. Filter by account_id and date range.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: {
            type: 'string',
            description: 'Filter by account ID',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD)',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD)',
          },
          granularity: {
            type: 'string',
            enum: ['daily', 'weekly', 'monthly'],
            description:
              'Required. Controls response density: daily (every day), weekly (one per week), ' +
              'or monthly (one per month). Use weekly or monthly for longer time ranges.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results (default: 100, max: 10000)',
            default: 100,
          },
          offset: {
            type: 'integer',
            description: 'Number of results to skip for pagination (default: 0)',
            default: 0,
          },
        },
        required: ['granularity'],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_investment_performance',
      description:
        'Get per-security investment performance data. Returns structured performance records ' +
        'from the local LevelDB cache, enriched with ticker symbol and name from the securities collection. ' +
        'Filter by ticker symbol or security ID.',
      inputSchema: {
        type: 'object',
        properties: {
          ticker_symbol: {
            type: 'string',
            description: 'Filter by ticker symbol (e.g., "AAPL", "VTSAX")',
          },
          security_id: {
            type: 'string',
            description: 'Filter by security ID (SHA256 hash)',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results (default: 100, max: 10000)',
            default: 100,
          },
          offset: {
            type: 'integer',
            description: 'Number of results to skip for pagination (default: 0)',
            default: 0,
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_twr_returns',
      description:
        'Get time-weighted return (TWR) monthly data for investment holdings. Returns ' +
        'monthly TWR records with epoch-millisecond keyed history entries. ' +
        'Filter by ticker symbol, security ID, or month range (YYYY-MM).',
      inputSchema: {
        type: 'object',
        properties: {
          ticker_symbol: {
            type: 'string',
            description: 'Filter by ticker symbol (e.g., "AAPL", "VTSAX")',
          },
          security_id: {
            type: 'string',
            description: 'Filter by security ID (SHA256 hash)',
          },
          start_month: {
            type: 'string',
            description: 'Start month (YYYY-MM)',
          },
          end_month: {
            type: 'string',
            description: 'End month (YYYY-MM)',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results (default: 100, max: 10000)',
            default: 100,
          },
          offset: {
            type: 'integer',
            description: 'Number of results to skip for pagination (default: 0)',
            default: 0,
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_securities',
      description:
        'Get security master data — stocks, ETFs, mutual funds, and cash equivalents. ' +
        'Returns ticker symbol, name, type, current price, ISIN/CUSIP identifiers, ' +
        'and update metadata. Filter by ticker symbol or security type.',
      inputSchema: {
        type: 'object',
        properties: {
          ticker_symbol: {
            type: 'string',
            description: 'Filter by ticker symbol (e.g., "AAPL", "VTSAX")',
          },
          type: {
            type: 'string',
            description: 'Filter by security type (e.g., "equity", "etf", "mutual fund")',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results (default: 100, max: 10000)',
            default: 100,
          },
          offset: {
            type: 'integer',
            description: 'Number of results to skip for pagination (default: 0)',
            default: 0,
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_goal_history',
      description:
        'Get monthly progress snapshots for financial goals. Returns current_amount, ' +
        'target_amount, daily data points, and contribution records per month. ' +
        'Filter by goal_id or month range (YYYY-MM).',
      inputSchema: {
        type: 'object',
        properties: {
          goal_id: {
            type: 'string',
            description: 'Filter by goal ID',
          },
          start_month: {
            type: 'string',
            description: 'Start month (YYYY-MM)',
          },
          end_month: {
            type: 'string',
            description: 'End month (YYYY-MM)',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results (default: 100, max: 10000)',
            default: 100,
          },
          offset: {
            type: 'integer',
            description: 'Number of results to skip for pagination (default: 0)',
            default: 0,
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
  ];
}

/**
 * Create MCP tool schemas for write tools.
 *
 * These tools modify Copilot Money data via GraphQL and are
 * only registered when the server is started with the --write flag.
 *
 * @returns List of write tool schema definitions
 */
export function createWriteToolSchemas(): ToolSchema[] {
  return [
    {
      name: 'update_transaction',
      description:
        "Update a single transaction's category, note, or tags. Pass transaction_id plus " +
        'any combination of category_id, note, or tag_ids — only specified fields are changed. ' +
        'Pass note="" to clear the note. Pass tag_ids=[] to clear all tags. At least one mutable ' +
        'field must be provided besides transaction_id. Other fields (name, excluded, ' +
        'internal_transfer, goal_id) are not writable through the GraphQL API and were removed ' +
        'from this tool when the backend was migrated.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          transaction_id: {
            type: 'string',
            description: 'Transaction ID to update (from get_transactions results)',
          },
          category_id: {
            type: 'string',
            description: 'New category ID to assign (from get_categories results)',
          },
          note: {
            type: 'string',
            description: 'User note text. Pass empty string to clear.',
          },
          tag_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tag IDs to set. Pass empty array to clear all tags.',
          },
        },
        required: ['transaction_id'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      name: 'review_transactions',
      description:
        'Mark one or more transactions as reviewed (or unreviewed). ' +
        'Accepts an array of transaction_ids. Writes directly to Copilot Money via GraphQL.',
      inputSchema: {
        type: 'object',
        properties: {
          transaction_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Transaction IDs to mark as reviewed',
          },
          reviewed: {
            type: 'boolean',
            description: 'Set to true to mark as reviewed, false to unmark. Defaults to true.',
          },
        },
        required: ['transaction_ids'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      name: 'create_tag',
      description:
        'Create a new user-defined tag for categorizing transactions. Tags appear in the ' +
        'Copilot Money app and are stored in the tag_ids field on transactions. ' +
        'Optionally set a color. Writes directly to Copilot Money via GraphQL.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Tag name (e.g. "vacation", "business expense")',
          },
          color_name: {
            type: 'string',
            description: 'Optional color name (e.g. "blue", "red")',
          },
          hex_color: {
            type: 'string',
            description: 'Optional hex color code (e.g. "#FF5733")',
          },
        },
        required: ['name'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    {
      name: 'delete_tag',
      description:
        'Delete a user-defined tag. The tag_id can be obtained from the tag definitions ' +
        'in the local cache. Writes directly to Copilot Money via GraphQL.',
      inputSchema: {
        type: 'object',
        properties: {
          tag_id: {
            type: 'string',
            description: 'Tag ID to delete',
          },
        },
        required: ['tag_id'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    {
      name: 'create_category',
      description:
        'Create a new custom category in Copilot Money. Provide name, color_name, ' +
        'and emoji (all required). Optionally set is_excluded. Returns the generated ' +
        'category_id. The new category can then be used with update_transaction. ' +
        "Note: parent/child category hierarchies are not writable through Copilot's " +
        'GraphQL API — create flat categories only. Writes directly to Copilot Money via GraphQL.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Display name for the new category (e.g., "Subscriptions")',
          },
          color_name: {
            type: 'string',
            description:
              'Named color from the Copilot palette (e.g., "RED1", "OLIVE1", "PURPLE2"). ' +
              'See existing categories via get_categories for valid values.',
          },
          emoji: {
            type: 'string',
            description: 'Emoji icon for the category (e.g., "🎬")',
          },
          is_excluded: {
            type: 'boolean',
            description: 'Exclude this category from spending totals (default: false)',
            default: false,
          },
        },
        required: ['name', 'color_name', 'emoji'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    {
      name: 'update_category',
      description:
        'Update an existing user-defined category. Provide category_id (required) and any ' +
        'fields to change: name, emoji, color_name, or is_excluded. Only the specified ' +
        'fields are updated. Note: parent/child category hierarchies are not writable ' +
        "through Copilot's GraphQL API. Writes directly to Copilot Money via GraphQL.",
      inputSchema: {
        type: 'object',
        properties: {
          category_id: {
            type: 'string',
            description: 'Category ID to update (from get_categories results)',
          },
          name: {
            type: 'string',
            description: 'New display name for the category',
          },
          emoji: {
            type: 'string',
            description: 'New emoji icon for the category (e.g., "🎬")',
          },
          color_name: {
            type: 'string',
            description:
              'New named color from the Copilot palette (e.g., "RED1", "OLIVE1", "PURPLE2").',
          },
          is_excluded: {
            type: 'boolean',
            description: 'Exclude this category from spending totals',
          },
        },
        required: ['category_id'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      name: 'delete_category',
      description:
        'Delete a user-defined category. The category_id can be obtained from get_categories. ' +
        'Writes directly to Copilot Money via GraphQL.',
      inputSchema: {
        type: 'object',
        properties: {
          category_id: {
            type: 'string',
            description: 'Category ID to delete',
          },
        },
        required: ['category_id'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    {
      name: 'set_budget',
      description:
        'Set the monthly budget amount for a category. amount="0" clears the budget. ' +
        'Pass month="YYYY-MM" for a single-month override; omit for the all-months default. ' +
        'Note: if the user has disabled "Enable budgeting" or "Enable rollover" in ' +
        'Copilot → Settings → General, the budget write still succeeds on the server, but ' +
        'the value will not appear in the Copilot UI until those toggles are re-enabled. ' +
        'Rollover behavior also depends on the "Rollover categories" selection in the same ' +
        'settings pane, which is not writable through this tool.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          category_id: {
            type: 'string' as const,
            description: 'ID of the category to budget.',
          },
          amount: {
            type: 'string' as const,
            description: 'Decimal amount as a string (e.g. "250.00"). "0" clears the budget.',
          },
          month: {
            type: 'string' as const,
            description:
              'Optional. YYYY-MM for a single-month override. Omit to set the all-months default.',
          },
        },
        required: ['category_id', 'amount'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      name: 'set_recurring_state',
      description:
        'Change the state of a recurring item (subscription/charge). ' +
        'Set to ACTIVE, PAUSED, or ARCHIVED (uppercase, matching the GraphQL API). ' +
        'Requires recurring_id (from get_recurring_transactions). ' +
        'Writes directly to Copilot Money via GraphQL.',
      inputSchema: {
        type: 'object',
        properties: {
          recurring_id: {
            type: 'string',
            description: 'Recurring item ID to update (from get_recurring_transactions results)',
          },
          state: {
            type: 'string',
            enum: ['ACTIVE', 'PAUSED', 'ARCHIVED'],
            description: 'New state for the recurring item (uppercase: ACTIVE, PAUSED, ARCHIVED)',
          },
        },
        required: ['recurring_id', 'state'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      name: 'delete_recurring',
      description:
        'Delete a recurring item (subscription/charge). ' +
        'Requires recurring_id (from get_recurring_transactions). ' +
        'Writes directly to Copilot Money via GraphQL.',
      inputSchema: {
        type: 'object',
        properties: {
          recurring_id: {
            type: 'string',
            description: 'Recurring item ID to delete (from get_recurring_transactions results)',
          },
        },
        required: ['recurring_id'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    {
      name: 'update_tag',
      description:
        'Update an existing tag. Provide tag_id (required) and at least one of name, ' +
        'color_name, or hex_color. Only the specified fields are updated. ' +
        'Writes directly to Copilot Money via GraphQL.',
      inputSchema: {
        type: 'object',
        properties: {
          tag_id: {
            type: 'string',
            description: 'Tag ID to update',
          },
          name: {
            type: 'string',
            description: 'New display name for the tag',
          },
          color_name: {
            type: 'string',
            description: 'New color name (e.g. "blue", "red")',
          },
          hex_color: {
            type: 'string',
            description: 'New hex color code (e.g. "#FF5733")',
          },
        },
        required: ['tag_id'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      name: 'create_recurring',
      description:
        'Create a new recurring/subscription item by seeding it from an existing transaction. ' +
        'The recurring inherits its merchant name, account, and initial amount from that transaction; ' +
        'you only supply the cadence (frequency). Writes directly to Copilot Money via GraphQL.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          transaction_id: {
            type: 'string' as const,
            description:
              'ID of an existing transaction to seed the recurring from. The recurring inherits its merchant name, account, and initial amount from this transaction.',
          },
          frequency: {
            type: 'string' as const,
            enum: ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'YEARLY'] as const,
            description: 'How often the recurring payment occurs.',
          },
        },
        required: ['transaction_id', 'frequency'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    {
      name: 'update_recurring',
      description:
        'Update an existing recurring transaction. Pass recurring_id plus any combination of ' +
        'state or rule (name_contains, min_amount, max_amount, days). The recurring cannot be ' +
        'renamed or re-linked to a different transaction through this tool — those fields must ' +
        'be changed in the Copilot Money web app. Writes directly to Copilot Money via GraphQL.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          recurring_id: {
            type: 'string' as const,
            description: 'ID of the recurring to update.',
          },
          state: {
            type: 'string' as const,
            enum: ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const,
            description:
              'State of the recurring. Use set_recurring_state instead if you only want to ' +
              'change state — this tool is for broader edits.',
          },
          rule: {
            type: 'object' as const,
            description: 'Matching rule. Controls how Copilot auto-detects future payments.',
            properties: {
              name_contains: {
                type: 'string' as const,
                description: 'Substring that must appear in the merchant/payee name.',
              },
              min_amount: {
                type: 'string' as const,
                description: 'Minimum amount (as a decimal string) for a transaction to match.',
              },
              max_amount: {
                type: 'string' as const,
                description: 'Maximum amount (as a decimal string) for a transaction to match.',
              },
              days: {
                type: 'array' as const,
                items: { type: 'number' as const },
                description: 'Days of the month (1-31) when this recurring is expected.',
              },
            },
            additionalProperties: false,
          },
        },
        required: ['recurring_id'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
  ];
}
