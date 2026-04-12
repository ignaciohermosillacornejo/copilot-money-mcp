/**
 * MCP tool definitions for Copilot Money data.
 *
 * Exposes database functionality through the Model Context Protocol.
 */

import { CopilotDatabase } from '../core/database.js';
import type { FirestoreClient } from '../core/firestore-client.js';
import { toFirestoreFields } from '../core/format/firestore-rest.js';
import { parsePeriod } from '../utils/date.js';
import {
  getCategoryName,
  isTransferCategory,
  isIncomeCategory,
  isKnownPlaidCategory,
} from '../utils/categories.js';
import type { Transaction, Account, InvestmentPrice, InvestmentSplit } from '../models/index.js';
import {
  getTransactionDisplayName,
  getRecurringDisplayName,
  KNOWN_PERIODS,
  RECURRING_STATES,
} from '../models/index.js';
import type { InvestmentPerformance, TwrHolding } from '../models/investment-performance.js';
import type { Security } from '../models/security.js';
import type { GoalHistory } from '../models/goal-history.js';
import { isItemHealthy, itemNeedsAttention, getItemDisplayName } from '../models/item.js';
import {
  getRootCategories,
  getCategoryChildren,
  getCategory,
  getCategoryParent,
  searchCategories as searchCategoriesInHierarchy,
} from '../models/category-full.js';

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

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/** Validate that a color string is a valid #RRGGBB hex code. */
function validateHexColor(color: string): void {
  if (!HEX_COLOR_RE.test(color)) {
    throw new Error(`Invalid color format: ${color} (expected #RRGGBB)`);
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

/**
 * Accepted frequency values for creating recurring items.
 * Subset of KNOWN_FREQUENCIES from the model -- only user-facing values.
 */
const VALID_RECURRING_FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'yearly'] as const;

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
  private firestoreClient: FirestoreClient | null;
  private _userCategoryMap: Map<string, string> | null = null;
  private _excludedCategoryIds: Set<string> | null = null;

  /**
   * Initialize tools with a database connection.
   *
   * @param database - CopilotDatabase instance
   * @param firestoreClient - Optional Firestore client for write operations
   */
  constructor(database: CopilotDatabase, firestoreClient?: FirestoreClient) {
    this.db = database;
    this.firestoreClient = firestoreClient ?? null;
  }

  /**
   * Return the Firestore client, or throw if write mode is not enabled.
   */
  protected getFirestoreClient(): FirestoreClient {
    if (!this.firestoreClient) {
      throw new Error(
        'Write mode is not enabled. Start the server with --write to use write tools.'
      );
    }
    return this.firestoreClient;
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
      const tagRegex = new RegExp(`#${normalizedTag}\\b`, 'i');
      transactions = transactions.filter((txn) => {
        const name = txn.name || txn.original_name || '';
        return tagRegex.test(name);
      });
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
        const taggedTxns = transactions.filter((txn) => {
          const name = txn.name || txn.original_name || '';
          return /#\w+/.test(name);
        });
        const tagMap = new Map<string, number>();
        for (const txn of taggedTxns) {
          const name = txn.name || txn.original_name || '';
          const tags = name.match(/#\w+/g) || [];
          for (const t of tags) {
            tagMap.set(t.toLowerCase(), (tagMap.get(t.toLowerCase()) || 0) + 1);
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
      type?: 'income' | 'expense' | 'transfer';
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
    const { view = 'list', parent_id, query, type, period } = options;
    let start_date = validateDate(options.start_date, 'start_date');
    let end_date = validateDate(options.end_date, 'end_date');

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // If parent_id is specified, get subcategories
    if (parent_id) {
      const rootCats = getRootCategories();
      const parent = rootCats.find((cat) => cat.id === parent_id);

      if (!parent) {
        throw new Error(`Category not found or has no subcategories: ${parent_id}`);
      }

      const children = getCategoryChildren(parent_id);

      return {
        view: 'subcategories',
        count: children.length,
        data: {
          parent_id: parent.id,
          parent_name: parent.display_name,
          subcategories: children.map((child) => ({
            id: child.id,
            name: child.name,
            display_name: child.display_name,
            path: child.path,
            type: child.type,
          })),
        },
      };
    }

    switch (view) {
      case 'tree': {
        // Get root categories, optionally filtered by type
        let rootCats = getRootCategories();
        if (type) {
          rootCats = rootCats.filter((cat) => cat.type === type);
        }

        // Build hierarchy
        const categories = rootCats.map((root) => {
          const children = getCategoryChildren(root.id);
          return {
            id: root.id,
            name: root.name,
            display_name: root.display_name,
            type: root.type,
            children: children.map((child) => ({
              id: child.id,
              name: child.name,
              display_name: child.display_name,
              path: child.path,
            })),
          };
        });

        const totalCount = categories.reduce((sum, cat) => sum + 1 + cat.children.length, 0);

        return {
          view: 'tree',
          count: totalCount,
          data: {
            type_filter: type,
            categories,
          },
        };
      }

      case 'search': {
        if (!query || query.trim().length === 0) {
          throw new Error('Search query is required for search view');
        }

        const results = searchCategoriesInHierarchy(query.trim());

        return {
          view: 'search',
          count: results.length,
          data: {
            query: query.trim(),
            categories: results.map((cat) => ({
              id: cat.id,
              name: cat.name,
              display_name: cat.display_name,
              path: cat.path,
              type: cat.type,
              depth: cat.depth,
              is_leaf: cat.is_leaf,
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

        // Include all known categories, even those with $0 (like UI does)
        const allKnownCategories = getRootCategories();
        for (const rootCat of allKnownCategories) {
          // Add root category if not already present
          if (!categoryStats.has(rootCat.id)) {
            categoryStats.set(rootCat.id, { count: 0, totalAmount: 0 });
          }
          // Add all child categories
          const children = getCategoryChildren(rootCat.id);
          for (const child of children) {
            if (!categoryStats.has(child.id)) {
              categoryStats.set(child.id, { count: 0, totalAmount: 0 });
            }
          }
        }

        // Convert to list with parent category info
        const categories = (
          await Promise.all(
            Array.from(categoryStats.entries()).map(async ([category_id, stats]) => {
              const categoryNode = getCategory(category_id);
              const parentNode = getCategoryParent(category_id);
              return {
                category_id,
                category_name: await this.resolveCategoryName(category_id),
                parent_id: parentNode?.id ?? null,
                parent_name: parentNode?.display_name ?? null,
                transaction_count: stats.count,
                total_amount: roundAmount(stats.totalAmount),
                type: categoryNode?.type ?? null,
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

    // Filter out budgets with orphaned category references (deleted categories)
    const categoryMap = await this.getUserCategoryMap();
    const budgets = allBudgets.filter((b) => {
      if (!b.category_id) return true; // Keep budgets without category
      // Keep if category exists in user categories or Plaid categories
      return categoryMap.has(b.category_id) || isKnownPlaidCategory(b.category_id);
    });

    // Calculate total budgeted amount (monthly equivalent)
    let totalBudgeted = 0;
    for (const budget of budgets) {
      if (budget.amount) {
        // Convert to monthly equivalent based on period
        const monthlyAmount =
          budget.period === 'yearly'
            ? budget.amount / 12
            : budget.period === 'weekly'
              ? budget.amount * 4.33 // Average weeks per month
              : budget.period === 'daily'
                ? budget.amount * 30
                : budget.amount; // Default to monthly

        totalBudgeted += monthlyAmount;
      }
    }

    const enrichedBudgets = await Promise.all(
      budgets.map(async (b) => ({
        budget_id: b.budget_id,
        name: b.name,
        amount: b.amount,
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
   * Generates a unique category_id, writes to Firestore, then clears the cache
   * so the new category is visible on next query.
   */
  async createCategory(args: {
    name: string;
    emoji?: string;
    color?: string;
    parent_category_id?: string;
    excluded?: boolean;
  }): Promise<{
    success: boolean;
    category_id: string;
    name: string;
    emoji?: string;
    color?: string;
    parent_category_id?: string;
    excluded: boolean;
  }> {
    const client = this.getFirestoreClient();

    const { name, emoji, color, parent_category_id, excluded = false } = args;

    // Validate name is non-empty
    if (!name.trim()) {
      throw new Error('Category name must not be empty');
    }

    const existingCategories = await this.db.getUserCategories();

    // Validate parent_category_id if provided
    if (parent_category_id) {
      validateDocId(parent_category_id, 'parent_category_id');
      const parent = existingCategories.find((c) => c.category_id === parent_category_id);
      if (!parent) {
        throw new Error(`Parent category not found: ${parent_category_id}`);
      }
    }

    // Check for duplicate name
    const duplicate = existingCategories.find(
      (c) => c.name?.toLowerCase() === name.trim().toLowerCase()
    );
    if (duplicate) {
      throw new Error(
        `Category with name "${name.trim()}" already exists (id: ${duplicate.category_id})`
      );
    }

    // Generate a unique category_id
    const categoryId = `custom_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

    // Determine user_id: prefer existing categories, fall back to auth layer
    const userIdFromCategories = existingCategories.find((c) => c.user_id)?.user_id;
    const userId = userIdFromCategories ?? (await client.requireUserId());

    // Build document fields
    const docFields: Record<string, unknown> = {
      category_id: categoryId,
      name: name.trim(),
      excluded,
    };
    if (emoji) docFields.emoji = emoji;
    if (color) {
      validateHexColor(color);
      docFields.color = color;
    }
    if (parent_category_id) docFields.parent_category_id = parent_category_id;

    // Write to Firestore
    const collectionPath = `users/${userId}/categories`;
    const firestoreFields = toFirestoreFields(docFields);
    await client.createDocument(collectionPath, categoryId, firestoreFields);

    // Clear cache so the new category is visible on next query
    this.db.clearCache();
    this._userCategoryMap = null;

    const result: {
      success: boolean;
      category_id: string;
      name: string;
      emoji?: string;
      color?: string;
      parent_category_id?: string;
      excluded: boolean;
    } = {
      success: true,
      category_id: categoryId,
      name: name.trim(),
      excluded,
    };
    if (emoji) result.emoji = emoji;
    if (color) result.color = color;
    if (parent_category_id) result.parent_category_id = parent_category_id;

    return result;
  }

  /**
   * Resolve a transaction by ID: validate format, find in cache, verify Firestore path fields.
   * Returns the transaction and its Firestore collection path.
   */
  private async resolveTransaction(transactionId: string): Promise<{
    txn: Transaction;
    collectionPath: string;
  }> {
    validateDocId(transactionId, 'transaction_id');

    const transactions = await this.db.getAllTransactions();
    const txn = transactions.find((t) => t.transaction_id === transactionId);
    if (!txn) {
      throw new Error(`Transaction not found: ${transactionId}`);
    }
    if (!txn.item_id || !txn.account_id) {
      throw new Error(
        `Transaction ${transactionId} is missing item_id or account_id — cannot determine Firestore path`
      );
    }
    return {
      txn,
      collectionPath: `items/${txn.item_id}/accounts/${txn.account_id}/transactions`,
    };
  }

  /**
   * Update one or more fields on a transaction in a single atomic write.
   *
   * Supported fields: category_id, note, tag_ids, excluded, name,
   * internal_transfer, goal_id. Omitted fields are preserved. note=""
   * clears the note. tag_ids=[] clears all tags. goal_id=null unlinks
   * (Firestore gets "", cache gets undefined).
   */
  async updateTransaction(args: {
    transaction_id: string;
    category_id?: string;
    note?: string;
    tag_ids?: string[];
    excluded?: boolean;
    name?: string;
    internal_transfer?: boolean;
    goal_id?: string | null;
  }): Promise<{
    success: true;
    transaction_id: string;
    updated: string[];
  }> {
    const { transaction_id } = args;

    // Reject unknown fields (equivalent to JSON Schema additionalProperties: false,
    // but re-checked here as a defense in depth in case the method is called directly
    // without going through the MCP dispatch layer).
    const allowedKeys = new Set([
      'transaction_id',
      'category_id',
      'note',
      'tag_ids',
      'excluded',
      'name',
      'internal_transfer',
      'goal_id',
    ]);
    for (const key of Object.keys(args)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`update_transaction: unknown field "${key}"`);
      }
    }

    // Require at least one mutable field besides transaction_id.
    // Treat explicit `undefined` values as absent so callers cannot accidentally
    // unlink goal_id / overwrite fields by passing undefined (MCP clients never
    // send undefined, but direct TS callers can).
    const mutableKeys = Object.keys(args).filter(
      (k) => k !== 'transaction_id' && (args as Record<string, unknown>)[k] !== undefined
    );
    if (mutableKeys.length === 0) {
      throw new Error('update_transaction requires at least one field to update');
    }

    // Resolve the transaction and its Firestore path FIRST so "Transaction not found"
    // is the primary error when both the transaction and a field are invalid.
    const { collectionPath } = await this.resolveTransaction(transaction_id);

    // Per-field validation (runs BEFORE any Firestore write for atomicity).
    let trimmedName: string | undefined;
    if ('name' in args && args.name !== undefined) {
      trimmedName = args.name.trim();
      if (trimmedName.length === 0) {
        throw new Error('Transaction name must not be empty');
      }
    }
    if ('category_id' in args && args.category_id !== undefined) {
      validateDocId(args.category_id, 'category_id');
      const categories = await this.db.getUserCategories();
      const category = categories.find((c) => c.category_id === args.category_id);
      if (!category) {
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
    if ('goal_id' in args && args.goal_id !== null && args.goal_id !== undefined) {
      validateDocId(args.goal_id, 'goal_id');
      const goals = await this.db.getGoals();
      const goal = goals.find((g) => g.goal_id === args.goal_id);
      if (!goal) {
        throw new Error(`Goal not found: ${args.goal_id}`);
      }
    }

    // Build two parallel field maps by key presence (NOT by destructuring — see spec).
    // The `!== undefined` guards treat explicit undefined as absent, matching the
    // mutableKeys check above.
    const firestoreFields: Record<string, unknown> = {};
    const cacheFields: Partial<Transaction> = {};

    if ('category_id' in args && args.category_id !== undefined) {
      firestoreFields.category_id = args.category_id;
      cacheFields.category_id = args.category_id;
    }
    if ('note' in args && args.note !== undefined) {
      firestoreFields.user_note = args.note;
      cacheFields.user_note = args.note;
    }
    if ('tag_ids' in args && args.tag_ids !== undefined) {
      firestoreFields.tag_ids = args.tag_ids;
      cacheFields.tag_ids = args.tag_ids;
    }
    if ('excluded' in args && args.excluded !== undefined) {
      firestoreFields.excluded = args.excluded;
      cacheFields.excluded = args.excluded;
    }
    if ('name' in args && trimmedName !== undefined) {
      firestoreFields.name = trimmedName;
      cacheFields.name = trimmedName;
    }
    if ('internal_transfer' in args && args.internal_transfer !== undefined) {
      firestoreFields.internal_transfer = args.internal_transfer;
      cacheFields.internal_transfer = args.internal_transfer;
    }
    if ('goal_id' in args && args.goal_id !== undefined) {
      // goal_id: null unlinks → Firestore gets empty string, cache gets undefined.
      // goal_id: undefined is treated as absent (skipped) to prevent direct TS
      // callers from accidentally unlinking by passing undefined.
      firestoreFields.goal_id = args.goal_id ?? '';
      cacheFields.goal_id = args.goal_id ?? undefined;
    }

    // Single atomic Firestore write + cache patch.
    const client = this.getFirestoreClient();
    const firestoreValue = toFirestoreFields(firestoreFields);
    const updateMask = Object.keys(firestoreFields);
    await client.updateDocument(collectionPath, transaction_id, firestoreValue, updateMask);

    if (!this.db.patchCachedTransaction(transaction_id, cacheFields)) {
      this.db.clearCache();
    }

    // Map Firestore field names back to API names for the response so callers see
    // `note` (not `user_note`) — matches what they sent.
    const firestoreToApiName: Record<string, string> = { user_note: 'note' };
    const updated = updateMask.map((k) => firestoreToApiName[k] ?? k);

    return {
      success: true,
      transaction_id,
      updated,
    };
  }

  /**
   * Mark one or more transactions as reviewed (or unreviewed).
   *
   * Validates all transaction IDs, writes user_reviewed to Firestore for each,
   * then patches the in-memory cache.
   */
  async reviewTransactions(args: { transaction_ids: string[]; reviewed?: boolean }): Promise<{
    success: boolean;
    reviewed_count: number;
    transaction_ids: string[];
  }> {
    const client = this.getFirestoreClient();

    const { transaction_ids, reviewed = true } = args;

    if (!Array.isArray(transaction_ids) || transaction_ids.length === 0) {
      throw new Error('transaction_ids must be a non-empty array');
    }

    for (const id of transaction_ids) {
      validateDocId(id, 'transaction_id');
    }

    // Validate all transactions exist and collect them
    const allTransactions = await this.db.getAllTransactions();
    const txnMap = new Map(allTransactions.map((t) => [t.transaction_id, t]));

    const resolvedTxns = [];
    for (const id of transaction_ids) {
      const txn = txnMap.get(id);
      if (!txn) {
        throw new Error(`Transaction not found: ${id}`);
      }
      if (!txn.item_id || !txn.account_id) {
        throw new Error(
          `Transaction ${id} is missing item_id or account_id — cannot determine Firestore path`
        );
      }
      resolvedTxns.push(txn);
    }

    // Batch writes to avoid overwhelming Firestore (max 10 concurrent)
    const REVIEW_BATCH_SIZE = 10;
    const firestoreFields = toFirestoreFields({ user_reviewed: reviewed });
    for (let i = 0; i < resolvedTxns.length; i += REVIEW_BATCH_SIZE) {
      const batch = resolvedTxns.slice(i, i + REVIEW_BATCH_SIZE);
      await Promise.all(
        batch.map(async (txn) => {
          const collectionPath = `items/${txn.item_id}/accounts/${txn.account_id}/transactions`;
          await client.updateDocument(collectionPath, txn.transaction_id, firestoreFields, [
            'user_reviewed',
          ]);
          if (!this.db.patchCachedTransaction(txn.transaction_id, { user_reviewed: reviewed })) {
            this.db.clearCache();
          }
        })
      );
    }

    return {
      success: true,
      reviewed_count: resolvedTxns.length,
      transaction_ids: resolvedTxns.map((t) => t.transaction_id),
    };
  }

  /**
   * Create a new user-defined tag.
   *
   * Generates a deterministic tag_id from the name, validates it does not
   * already exist, writes to Firestore, then clears the cache so the next
   * read picks up the new tag.
   */
  async createTag(args: { name: string; color_name?: string; hex_color?: string }): Promise<{
    success: boolean;
    tag_id: string;
    name: string;
    color_name?: string;
    hex_color?: string;
  }> {
    const client = this.getFirestoreClient();

    const { name, color_name, hex_color } = args;

    // Validate name is non-empty
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error('Tag name must not be empty');
    }

    // Generate deterministic tag_id from name (lowercase, spaces to underscores, strip special chars)
    const tag_id = trimmedName
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_-]/g, '');
    if (!tag_id) {
      throw new Error(`Cannot generate a valid tag_id from name: ${trimmedName}`);
    }

    if (hex_color !== undefined) validateHexColor(hex_color);

    // Check for duplicate tag
    const existingTags = await this.db.getTags();
    const duplicate = existingTags.find((t) => t.tag_id === tag_id);
    if (duplicate) {
      throw new Error(`Tag "${trimmedName}" already exists (id: ${tag_id})`);
    }

    // Resolve user_id for the Firestore path users/{user_id}/tags/{tag_id}
    const userId = await client.requireUserId();

    // Build fields for Firestore
    const docFields: Record<string, unknown> = { name: trimmedName };
    if (color_name !== undefined) docFields.color_name = color_name;
    if (hex_color !== undefined) docFields.hex_color = hex_color;

    const firestoreFields = toFirestoreFields(docFields);
    const collectionPath = `users/${userId}/tags`;
    await client.createDocument(collectionPath, tag_id, firestoreFields);

    // Clear the cache so the next read picks up the new tag from LevelDB
    this.db.clearCache();

    const result: {
      success: boolean;
      tag_id: string;
      name: string;
      color_name?: string;
      hex_color?: string;
    } = {
      success: true,
      tag_id,
      name: trimmedName,
    };
    if (color_name !== undefined) result.color_name = color_name;
    if (hex_color !== undefined) result.hex_color = hex_color;
    return result;
  }

  /**
   * Delete an existing user-defined tag.
   *
   * Validates the tag exists in the local cache, deletes from Firestore,
   * then clears the cache.
   */
  async deleteTag(args: { tag_id: string }): Promise<{
    success: boolean;
    tag_id: string;
    deleted_name: string;
  }> {
    const client = this.getFirestoreClient();

    const { tag_id } = args;

    // Validate tag_id format
    validateDocId(tag_id, 'tag_id');

    // Validate tag exists
    const existingTags = await this.db.getTags();
    const tag = existingTags.find((t) => t.tag_id === tag_id);
    if (!tag) {
      throw new Error(`Tag not found: ${tag_id}`);
    }

    // Resolve user_id for the Firestore path users/{user_id}/tags/{tag_id}
    const userId = await client.requireUserId();

    const collectionPath = `users/${userId}/tags`;
    await client.deleteDocument(collectionPath, tag_id);

    // Clear the cache so the next read reflects the deletion
    this.db.clearCache();

    return {
      success: true,
      tag_id,
      deleted_name: tag.name ?? tag_id,
    };
  }

  /**
   * Update an existing user-defined category.
   *
   * Validates the category exists, applies only the provided fields via
   * Firestore updateMask, then clears the cache.
   */
  async updateCategory(args: {
    category_id: string;
    name?: string;
    emoji?: string;
    color?: string;
    excluded?: boolean;
    parent_category_id?: string | null;
  }): Promise<{
    success: boolean;
    category_id: string;
    updated_fields: string[];
  }> {
    const client = this.getFirestoreClient();

    const { category_id, name, emoji, color, excluded, parent_category_id } = args;

    // Validate category_id format
    validateDocId(category_id, 'category_id');

    // Validate category exists
    const existingCategories = await this.db.getUserCategories();
    const category = existingCategories.find((c) => c.category_id === category_id);
    if (!category) {
      throw new Error(`Category not found: ${category_id}`);
    }

    // Build dynamic update fields
    const fieldsToUpdate: Record<string, unknown> = {};
    const updateMask: string[] = [];

    if (name !== undefined) {
      const trimmedName = name.trim();
      if (!trimmedName) {
        throw new Error('Category name must not be empty');
      }
      // Check for duplicate name among OTHER categories
      const duplicate = existingCategories.find(
        (c) => c.category_id !== category_id && c.name?.toLowerCase() === trimmedName.toLowerCase()
      );
      if (duplicate) {
        throw new Error(
          `Category with name "${trimmedName}" already exists (id: ${duplicate.category_id})`
        );
      }
      fieldsToUpdate.name = trimmedName;
      updateMask.push('name');
    }
    if (emoji !== undefined) {
      fieldsToUpdate.emoji = emoji;
      updateMask.push('emoji');
    }
    if (color !== undefined) {
      validateHexColor(color);
      fieldsToUpdate.color = color;
      updateMask.push('color');
    }
    if (excluded !== undefined) {
      fieldsToUpdate.excluded = excluded;
      updateMask.push('excluded');
    }
    if (parent_category_id !== undefined) {
      if (parent_category_id !== null) {
        validateDocId(parent_category_id, 'parent_category_id');
        if (parent_category_id === category_id) {
          throw new Error('A category cannot be its own parent');
        }
        const parent = existingCategories.find((c) => c.category_id === parent_category_id);
        if (!parent) {
          throw new Error(`Parent category not found: ${parent_category_id}`);
        }
      }
      fieldsToUpdate.parent_category_id = parent_category_id ?? '';
      updateMask.push('parent_category_id');
    }

    if (updateMask.length === 0) {
      throw new Error('No fields to update');
    }

    // Determine user_id
    const userIdFromCategories = existingCategories.find((c) => c.user_id)?.user_id;
    const userId = userIdFromCategories ?? (await client.requireUserId());

    // Write to Firestore
    const collectionPath = `users/${userId}/categories`;
    const firestoreFields = toFirestoreFields(fieldsToUpdate);
    await client.updateDocument(collectionPath, category_id, firestoreFields, updateMask);

    // Clear cache so updates are visible on next query
    this.db.clearCache();
    this._userCategoryMap = null;

    return {
      success: true,
      category_id,
      updated_fields: updateMask,
    };
  }

  /**
   * Delete a user-defined category.
   *
   * Validates the category exists, deletes from Firestore, then clears
   * the cache.
   */
  async deleteCategory(args: { category_id: string }): Promise<{
    success: boolean;
    category_id: string;
    deleted_name: string;
  }> {
    const client = this.getFirestoreClient();

    const { category_id } = args;

    // Validate category_id format
    validateDocId(category_id, 'category_id');

    // Validate category exists
    const existingCategories = await this.db.getUserCategories();
    const category = existingCategories.find((c) => c.category_id === category_id);
    if (!category) {
      throw new Error(`Category not found: ${category_id}`);
    }

    // Resolve user_id for the Firestore path users/{user_id}/categories/{category_id}
    const userIdFromCategories = existingCategories.find((c) => c.user_id)?.user_id;
    const userId = userIdFromCategories ?? (await client.requireUserId());

    const collectionPath = `users/${userId}/categories`;
    await client.deleteDocument(collectionPath, category_id);

    // Clear the cache so the next read reflects the deletion
    this.db.clearCache();
    this._userCategoryMap = null;

    return {
      success: true,
      category_id,
      deleted_name: category.name ?? category_id,
    };
  }

  /**
   * Create a new budget in Copilot Money.
   *
   * Generates a unique budget_id, validates the category exists and has no
   * existing budget, writes to Firestore, then clears the cache.
   */
  async createBudget(args: {
    category_id: string;
    amount: number;
    period?: string;
    name?: string;
  }): Promise<{
    success: boolean;
    budget_id: string;
    category_id: string;
    amount: number;
    period: string;
    name?: string;
  }> {
    const client = this.getFirestoreClient();

    const { category_id, amount, period = 'monthly', name } = args;

    // Validate category_id format
    validateDocId(category_id, 'category_id');

    // Validate amount is positive
    if (amount <= 0) {
      throw new Error('Budget amount must be greater than 0');
    }

    // Validate period
    if (!(KNOWN_PERIODS as readonly string[]).includes(period)) {
      throw new Error(`Invalid period: ${period}. Must be one of: ${KNOWN_PERIODS.join(', ')}`);
    }

    // Validate category exists
    const categories = await this.db.getUserCategories();
    const category = categories.find((c) => c.category_id === category_id);
    if (!category) {
      throw new Error(`Category not found: ${category_id}`);
    }

    // Check no existing budget targets the same category
    const existingBudgets = await this.db.getBudgets();
    const duplicate = existingBudgets.find((b) => b.category_id === category_id);
    if (duplicate) {
      throw new Error(
        `A budget already exists for category "${category_id}" (budget_id: ${duplicate.budget_id})`
      );
    }

    // Generate unique budget_id
    const budgetId = `budget_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

    // Resolve user_id
    const userId = await client.requireUserId();

    // Build document fields
    const docFields: Record<string, unknown> = {
      budget_id: budgetId,
      category_id,
      amount,
      period,
      is_active: true,
    };
    if (name) docFields.name = name;

    // Write to Firestore
    const collectionPath = `users/${userId}/budgets`;
    const firestoreFields = toFirestoreFields(docFields);
    await client.createDocument(collectionPath, budgetId, firestoreFields);

    // Clear cache so the new budget is visible on next query
    this.db.clearCache();

    const result: {
      success: boolean;
      budget_id: string;
      category_id: string;
      amount: number;
      period: string;
      name?: string;
    } = {
      success: true,
      budget_id: budgetId,
      category_id,
      amount,
      period,
    };
    if (name) result.name = name;

    return result;
  }

  /**
   * Update an existing budget in Copilot Money.
   *
   * Validates the budget exists, builds a dynamic update mask for only the
   * provided fields, writes to Firestore, then clears the cache.
   */
  async updateBudget(args: {
    budget_id: string;
    amount?: number;
    period?: string;
    name?: string;
    is_active?: boolean;
  }): Promise<{
    success: boolean;
    budget_id: string;
    updated_fields: string[];
  }> {
    const client = this.getFirestoreClient();

    const { budget_id, amount, period, name, is_active } = args;

    // Validate budget_id format
    validateDocId(budget_id, 'budget_id');

    // Validate budget exists
    const existingBudgets = await this.db.getBudgets();
    const budget = existingBudgets.find((b) => b.budget_id === budget_id);
    if (!budget) {
      throw new Error(`Budget not found: ${budget_id}`);
    }

    // Build update fields — only include fields explicitly provided
    const updateFields: Record<string, unknown> = {};
    const updatedFieldNames: string[] = [];

    if (amount !== undefined) {
      if (amount <= 0) {
        throw new Error('Budget amount must be greater than 0');
      }
      updateFields.amount = amount;
      updatedFieldNames.push('amount');
    }

    if (period !== undefined) {
      if (!(KNOWN_PERIODS as readonly string[]).includes(period)) {
        throw new Error(`Invalid period: ${period}. Must be one of: ${KNOWN_PERIODS.join(', ')}`);
      }
      updateFields.period = period;
      updatedFieldNames.push('period');
    }

    if (name !== undefined) {
      const trimmedName = name.trim();
      if (!trimmedName) {
        throw new Error('Budget name must not be empty');
      }
      updateFields.name = trimmedName;
      updatedFieldNames.push('name');
    }

    if (is_active !== undefined) {
      updateFields.is_active = is_active;
      updatedFieldNames.push('is_active');
    }

    // Ensure at least one field is being updated
    if (updatedFieldNames.length === 0) {
      throw new Error(
        'No fields to update. Provide at least one of: amount, period, name, is_active'
      );
    }

    // Resolve user_id
    const userId = await client.requireUserId();

    // Write to Firestore with dynamic update mask
    const collectionPath = `users/${userId}/budgets`;
    const firestoreFields = toFirestoreFields(updateFields);
    await client.updateDocument(collectionPath, budget_id, firestoreFields, updatedFieldNames);

    // Clear cache so the updated budget is visible on next query
    this.db.clearCache();

    return {
      success: true,
      budget_id,
      updated_fields: updatedFieldNames,
    };
  }

  /**
   * Delete an existing budget from Copilot Money.
   *
   * Validates the budget exists, deletes from Firestore, then clears the cache.
   */
  async deleteBudget(args: { budget_id: string }): Promise<{
    success: boolean;
    budget_id: string;
    deleted_name: string;
  }> {
    const client = this.getFirestoreClient();

    const { budget_id } = args;

    // Validate budget_id format
    validateDocId(budget_id, 'budget_id');

    // Validate budget exists
    const existingBudgets = await this.db.getBudgets();
    const budget = existingBudgets.find((b) => b.budget_id === budget_id);
    if (!budget) {
      throw new Error(`Budget not found: ${budget_id}`);
    }

    // Resolve user_id
    const userId = await client.requireUserId();

    const collectionPath = `users/${userId}/budgets`;
    await client.deleteDocument(collectionPath, budget_id);

    // Clear the cache so the next read reflects the deletion
    this.db.clearCache();

    return {
      success: true,
      budget_id,
      deleted_name: budget.name ?? budget.category_id ?? budget_id,
    };
  }

  /**
   * Change the state of a recurring item (activate, pause, or archive).
   *
   * Validates the recurring item exists, writes both state and is_active
   * fields to Firestore, then clears the cache.
   */
  async setRecurringState(args: {
    recurring_id: string;
    state: 'active' | 'paused' | 'archived';
  }): Promise<{
    success: boolean;
    recurring_id: string;
    name: string;
    old_state: string;
    new_state: string;
  }> {
    const client = this.getFirestoreClient();

    const { recurring_id, state } = args;

    // Validate recurring_id format
    validateDocId(recurring_id, 'recurring_id');

    // Validate state
    if (!(RECURRING_STATES as readonly string[]).includes(state)) {
      throw new Error(`Invalid state: ${state}. Must be one of: ${RECURRING_STATES.join(', ')}`);
    }

    // Validate recurring exists (false = include inactive)
    const allRecurring = await this.db.getRecurring(false);
    const recurring = allRecurring.find((r) => r.recurring_id === recurring_id);
    if (!recurring) {
      throw new Error(`Recurring item not found: ${recurring_id}`);
    }

    const displayName = getRecurringDisplayName(recurring);
    const oldState = recurring.state ?? (recurring.is_active ? 'active' : 'paused');

    // Resolve user_id for the Firestore path users/{user_id}/recurring/{recurring_id}
    const userId = await client.requireUserId();

    // Write both state and derived is_active field
    const is_active = state === 'active';
    const firestoreFields = toFirestoreFields({ state, is_active });
    const collectionPath = `users/${userId}/recurring`;
    await client.updateDocument(collectionPath, recurring_id, firestoreFields, [
      'state',
      'is_active',
    ]);

    // Clear the cache so the next read reflects the change
    this.db.clearCache();

    return {
      success: true,
      recurring_id,
      name: displayName,
      old_state: oldState,
      new_state: state,
    };
  }

  /**
   * Delete a recurring item.
   *
   * Validates the recurring item exists, deletes from Firestore,
   * then clears the cache.
   */
  async deleteRecurring(args: { recurring_id: string }): Promise<{
    success: boolean;
    recurring_id: string;
    deleted_name: string;
  }> {
    const client = this.getFirestoreClient();

    const { recurring_id } = args;

    // Validate recurring_id format
    validateDocId(recurring_id, 'recurring_id');

    // Validate recurring exists
    const allRecurring = await this.db.getRecurring(false);
    const recurring = allRecurring.find((r) => r.recurring_id === recurring_id);
    if (!recurring) {
      throw new Error(`Recurring item not found: ${recurring_id}`);
    }

    const displayName = getRecurringDisplayName(recurring);

    // Resolve user_id for the Firestore path users/{user_id}/recurring/{recurring_id}
    const userId = await client.requireUserId();

    const collectionPath = `users/${userId}/recurring`;
    await client.deleteDocument(collectionPath, recurring_id);

    // Clear the cache so the next read reflects the deletion
    this.db.clearCache();

    return {
      success: true,
      recurring_id,
      deleted_name: displayName,
    };
  }

  /**
   * Update a financial goal's properties.
   *
   * Validates the goal exists, builds a dynamic update mask from the provided
   * fields, writes to Firestore, then clears the cache.
   */
  async updateGoal(args: {
    goal_id: string;
    name?: string;
    emoji?: string;
    target_amount?: number;
    monthly_contribution?: number;
    status?: 'active' | 'paused';
  }): Promise<{
    success: boolean;
    goal_id: string;
    updated_fields: string[];
  }> {
    const client = this.getFirestoreClient();

    const { goal_id, name, emoji, target_amount, monthly_contribution, status } = args;

    // Validate goal_id format
    validateDocId(goal_id, 'goal_id');

    // Validate goal exists first (include inactive goals)
    const goals = await this.db.getGoals(false);
    const goal = goals.find((g) => g.goal_id === goal_id);
    if (!goal) {
      throw new Error(`Goal not found: ${goal_id}`);
    }

    // Build dynamic update fields
    const fieldsToUpdate: Record<string, unknown> = {};
    const updateMask: string[] = [];

    if (name !== undefined) {
      if (!name.trim()) {
        throw new Error('Goal name must not be empty');
      }
      fieldsToUpdate.name = name.trim();
      updateMask.push('name');
    }
    if (emoji !== undefined) {
      fieldsToUpdate.emoji = emoji;
      updateMask.push('emoji');
    }

    // Nested savings fields — use a single 'savings' mask entry so Firestore
    // merges the sub-object correctly via the REST PATCH API
    const savingsUpdate: Record<string, unknown> = {};
    if (target_amount !== undefined) {
      if (target_amount <= 0) {
        throw new Error('target_amount must be greater than 0');
      }
      savingsUpdate.target_amount = target_amount;
    }
    if (monthly_contribution !== undefined) {
      if (monthly_contribution < 0) {
        throw new Error('monthly_contribution must be >= 0');
      }
      savingsUpdate.tracking_type_monthly_contribution = monthly_contribution;
    }
    if (status !== undefined) {
      savingsUpdate.status = status;
    }
    if (Object.keys(savingsUpdate).length > 0) {
      fieldsToUpdate.savings = savingsUpdate;
      updateMask.push('savings');
    }

    if (updateMask.length === 0) {
      throw new Error('No fields to update');
    }

    // Resolve user_id
    const userId = await client.requireUserId();

    // Write to Firestore
    const collectionPath = `users/${userId}/financial_goals`;
    const firestoreFields = toFirestoreFields(fieldsToUpdate);
    await client.updateDocument(collectionPath, goal_id, firestoreFields, updateMask);

    // Clear cache so next read picks up the change
    this.db.clearCache();

    return {
      success: true,
      goal_id,
      updated_fields: updateMask,
    };
  }

  /**
   * Delete a financial goal.
   *
   * Validates the goal exists in the local cache, deletes from Firestore,
   * then clears the cache.
   */
  async deleteGoal(args: { goal_id: string }): Promise<{
    success: boolean;
    goal_id: string;
    deleted_name: string;
  }> {
    const client = this.getFirestoreClient();

    const { goal_id } = args;

    // Validate goal_id format
    validateDocId(goal_id, 'goal_id');

    // Validate goal exists (include inactive goals)
    const goals = await this.db.getGoals(false);
    const goal = goals.find((g) => g.goal_id === goal_id);
    if (!goal) {
      throw new Error(`Goal not found: ${goal_id}`);
    }

    // Resolve user_id
    const userId = await client.requireUserId();

    const collectionPath = `users/${userId}/financial_goals`;
    await client.deleteDocument(collectionPath, goal_id);

    // Clear the cache so the next read reflects the deletion
    this.db.clearCache();

    return {
      success: true,
      goal_id,
      deleted_name: goal.name ?? goal_id,
    };
  }

  /**
   * Update an existing tag's name and/or color.
   *
   * Validates the tag exists, builds a dynamic update mask for only the
   * provided fields, writes to Firestore, then clears the cache.
   */
  async updateTag(args: {
    tag_id: string;
    name?: string;
    color_name?: string;
    hex_color?: string;
  }): Promise<{
    success: boolean;
    tag_id: string;
    updated_fields: string[];
  }> {
    const client = this.getFirestoreClient();

    const { tag_id, name, color_name, hex_color } = args;

    // Validate tag_id format
    validateDocId(tag_id, 'tag_id');

    // Validate tag exists
    const existingTags = await this.db.getTags();
    const tag = existingTags.find((t) => t.tag_id === tag_id);
    if (!tag) {
      throw new Error(`Tag not found: ${tag_id}`);
    }

    // Build dynamic update fields
    const fieldsToUpdate: Record<string, unknown> = {};
    const updateMask: string[] = [];

    if (name !== undefined) {
      const trimmedName = name.trim();
      if (!trimmedName) {
        throw new Error('Tag name must not be empty');
      }
      fieldsToUpdate.name = trimmedName;
      updateMask.push('name');
    }
    if (color_name !== undefined) {
      fieldsToUpdate.color_name = color_name;
      updateMask.push('color_name');
    }
    if (hex_color !== undefined) {
      validateHexColor(hex_color);
      fieldsToUpdate.hex_color = hex_color;
      updateMask.push('hex_color');
    }

    if (updateMask.length === 0) {
      throw new Error('No fields to update. Provide at least one of: name, color_name, hex_color');
    }

    // Resolve user_id
    const userId = await client.requireUserId();

    // Write to Firestore with dynamic update mask
    const collectionPath = `users/${userId}/tags`;
    const firestoreFields = toFirestoreFields(fieldsToUpdate);
    await client.updateDocument(collectionPath, tag_id, firestoreFields, updateMask);

    // Clear cache so the updated tag is visible on next query
    this.db.clearCache();

    return {
      success: true,
      tag_id,
      updated_fields: updateMask,
    };
  }

  /**
   * Create a new recurring/subscription item.
   *
   * Generates a unique recurring_id, writes to Firestore, then clears the cache
   * so the new recurring item is visible on next query.
   */
  async createRecurring(args: {
    name: string;
    amount: number;
    frequency: string;
    category_id?: string;
    account_id?: string;
    merchant_name?: string;
    start_date?: string;
  }): Promise<{
    success: boolean;
    recurring_id: string;
    name: string;
    amount: number;
    frequency: string;
  }> {
    const client = this.getFirestoreClient();

    const { name, amount, frequency, category_id, account_id, merchant_name, start_date } = args;

    // Validate name is non-empty
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error('Recurring name must not be empty');
    }

    // Validate amount is positive
    if (amount <= 0) {
      throw new Error('Recurring amount must be greater than 0');
    }

    // Validate frequency
    if (!(VALID_RECURRING_FREQUENCIES as readonly string[]).includes(frequency)) {
      throw new Error(
        `Invalid frequency: ${frequency}. Must be one of: ${VALID_RECURRING_FREQUENCIES.join(', ')}`
      );
    }

    // Validate optional IDs
    if (category_id !== undefined) validateDocId(category_id, 'category_id');
    if (account_id !== undefined) validateDocId(account_id, 'account_id');

    // Validate start_date format
    if (start_date !== undefined) validateDate(start_date, 'start_date');

    // Generate unique recurring_id
    const recurringId = crypto.randomUUID();

    // Resolve user_id
    const userId = await client.requireUserId();

    // Build document fields
    const today = new Date().toISOString().slice(0, 10);
    const docFields: Record<string, unknown> = {
      recurring_id: recurringId,
      name: trimmedName,
      amount,
      frequency,
      is_active: true,
      state: 'active',
      latest_date: start_date ?? today,
    };
    if (category_id !== undefined) docFields.category_id = category_id;
    if (account_id !== undefined) docFields.account_id = account_id;
    if (merchant_name !== undefined) docFields.merchant_name = merchant_name;
    if (start_date !== undefined) docFields.start_date = start_date;

    // Write to Firestore
    const collectionPath = `users/${userId}/recurring`;
    const firestoreFields = toFirestoreFields(docFields);
    await client.createDocument(collectionPath, recurringId, firestoreFields);

    // Clear cache so the new recurring item is visible on next query
    this.db.clearCache();

    return {
      success: true,
      recurring_id: recurringId,
      name: trimmedName,
      amount,
      frequency,
    };
  }

  /**
   * Create a new financial goal.
   *
   * Generates a unique goal_id, writes to Firestore with a savings sub-object,
   * then clears the cache so the new goal is visible on next query.
   */
  async createGoal(args: {
    name: string;
    target_amount: number;
    emoji?: string;
    monthly_contribution?: number;
    start_date?: string;
  }): Promise<{
    success: boolean;
    goal_id: string;
    name: string;
    target_amount: number;
  }> {
    const client = this.getFirestoreClient();

    const { name, target_amount, emoji, monthly_contribution, start_date } = args;

    // Validate name is non-empty
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error('Goal name must not be empty');
    }

    // Validate target_amount is positive
    if (target_amount <= 0) {
      throw new Error('target_amount must be greater than 0');
    }

    // Validate monthly_contribution if provided
    if (monthly_contribution !== undefined && monthly_contribution < 0) {
      throw new Error('monthly_contribution must be >= 0');
    }

    // Validate start_date format
    if (start_date !== undefined) validateDate(start_date, 'start_date');

    // Generate unique goal_id
    const goalId = crypto.randomUUID();

    // Resolve user_id
    const userId = await client.requireUserId();

    // Build document fields
    const today = new Date().toISOString().slice(0, 10);
    const docFields: Record<string, unknown> = {
      goal_id: goalId,
      name: trimmedName,
      savings: {
        type: 'savings',
        status: 'active',
        target_amount,
        tracking_type: monthly_contribution !== undefined ? 'monthly_contribution' : 'manual',
        tracking_type_monthly_contribution: monthly_contribution ?? 0,
        start_date: start_date ?? today,
        is_ongoing: false,
      },
    };
    if (emoji !== undefined) docFields.emoji = emoji;

    // Write to Firestore
    const collectionPath = `users/${userId}/financial_goals`;
    const firestoreFields = toFirestoreFields(docFields);
    await client.createDocument(collectionPath, goalId, firestoreFields);

    // Clear cache so the new goal is visible on next query
    this.db.clearCache();

    return {
      success: true,
      goal_id: goalId,
      name: trimmedName,
      target_amount,
    };
  }

  /**
   * Update an existing recurring/subscription item.
   *
   * Validates the recurring item exists, builds a dynamic update mask from the
   * provided fields, writes to Firestore, then clears the cache.
   */
  async updateRecurring(args: {
    recurring_id: string;
    name?: string;
    amount?: number;
    frequency?: string;
    category_id?: string;
    account_id?: string;
    merchant_name?: string;
    emoji?: string;
    match_string?: string;
    transaction_ids?: string[];
    excluded_transaction_ids?: string[];
    included_transaction_ids?: string[];
    days_filter?: number;
  }): Promise<{
    success: boolean;
    recurring_id: string;
    name: string;
    updated_fields: string[];
  }> {
    const client = this.getFirestoreClient();

    const {
      recurring_id,
      name,
      amount,
      frequency,
      category_id,
      account_id,
      merchant_name,
      emoji,
      match_string,
      transaction_ids,
      excluded_transaction_ids,
      included_transaction_ids,
      days_filter,
    } = args;

    // Validate recurring_id format
    validateDocId(recurring_id, 'recurring_id');

    // Verify recurring exists (include inactive)
    const allRecurring = await this.db.getRecurring(false);
    const recurring = allRecurring.find((r) => r.recurring_id === recurring_id);
    if (!recurring) {
      throw new Error(`Recurring not found: ${recurring_id}`);
    }

    // Build dynamic update fields
    const fieldsToUpdate: Record<string, unknown> = {};
    const updateMask: string[] = [];

    if (name !== undefined) {
      if (!name.trim()) {
        throw new Error('Recurring name must not be empty');
      }
      fieldsToUpdate.name = name.trim();
      updateMask.push('name');
    }
    if (amount !== undefined) {
      if (amount <= 0) {
        throw new Error('amount must be greater than 0');
      }
      fieldsToUpdate.amount = amount;
      updateMask.push('amount');
    }
    if (frequency !== undefined) {
      if (!(VALID_RECURRING_FREQUENCIES as readonly string[]).includes(frequency)) {
        throw new Error(
          `Invalid frequency: ${frequency}. Must be one of: ${VALID_RECURRING_FREQUENCIES.join(', ')}`
        );
      }
      fieldsToUpdate.frequency = frequency;
      updateMask.push('frequency');
    }
    if (category_id !== undefined) {
      validateDocId(category_id, 'category_id');
      fieldsToUpdate.category_id = category_id;
      updateMask.push('category_id');
    }
    if (account_id !== undefined) {
      validateDocId(account_id, 'account_id');
      fieldsToUpdate.account_id = account_id;
      updateMask.push('account_id');
    }
    if (merchant_name !== undefined) {
      fieldsToUpdate.merchant_name = merchant_name;
      updateMask.push('merchant_name');
    }
    if (emoji !== undefined) {
      fieldsToUpdate.emoji = emoji;
      updateMask.push('emoji');
    }
    if (match_string !== undefined) {
      if (!match_string.trim()) {
        throw new Error('match_string must not be empty');
      }
      fieldsToUpdate.match_string = match_string.trim();
      updateMask.push('match_string');
    }
    if (transaction_ids !== undefined) {
      fieldsToUpdate.transaction_ids = transaction_ids;
      updateMask.push('transaction_ids');
    }
    if (excluded_transaction_ids !== undefined) {
      fieldsToUpdate.excluded_transaction_ids = excluded_transaction_ids;
      updateMask.push('excluded_transaction_ids');
    }
    if (included_transaction_ids !== undefined) {
      fieldsToUpdate.included_transaction_ids = included_transaction_ids;
      updateMask.push('included_transaction_ids');
    }
    if (days_filter !== undefined) {
      fieldsToUpdate.days_filter = days_filter;
      updateMask.push('days_filter');
    }

    if (updateMask.length === 0) {
      throw new Error('No fields to update');
    }

    // Resolve user_id and write
    const userId = await client.requireUserId();
    const collectionPath = `users/${userId}/recurring`;
    const firestoreFields = toFirestoreFields(fieldsToUpdate);
    await client.updateDocument(collectionPath, recurring_id, firestoreFields, updateMask);

    // Clear cache
    this.db.clearCache();

    const displayName = name?.trim() ?? recurring.name ?? recurring.merchant_name ?? recurring_id;

    return {
      success: true,
      recurring_id,
      name: displayName,
      updated_fields: updateMask,
    };
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
        '(6) Tag filter: Use tag to find #tagged transactions. ' +
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
              'duplicates (potential duplicate transactions), hsa_eligible (medical expenses), tagged (#hashtag)',
          },
          // NEW: Tag filter
          tag: {
            type: 'string',
            description: 'Filter by hashtag (with or without #)',
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
        'list (default) - categories with transaction counts/amounts for a time period; ' +
        'tree - full Plaid category taxonomy as hierarchical tree; ' +
        'search - search categories by keyword. Use parent_id to get subcategories. ' +
        'For list view, use period (e.g., "this_month") or start_date/end_date to filter by date. ' +
        'Includes all categories, even those with $0 spent (matching UI behavior).',
      inputSchema: {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            enum: ['list', 'tree', 'search'],
            description:
              'View mode: list (categories in transactions), tree (full hierarchy), search (find by keyword)',
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
          type: {
            type: 'string',
            enum: ['income', 'expense', 'transfer'],
            description: "Filter by category type (for 'tree' view)",
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
        'Retrieves user-defined spending limits and budget rules stored in the app. ' +
        'Returns budget details including amounts, periods (monthly/yearly/weekly), ' +
        'category associations, and active status. Calculates total budgeted amount as monthly equivalent.',
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
        'from Firestore, enriched with ticker symbol and name from the securities collection. ' +
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
 * These tools modify Copilot Money data via the Firestore REST API and are
 * only registered when the server is started with the --write flag.
 *
 * @returns List of write tool schema definitions
 */
export function createWriteToolSchemas(): ToolSchema[] {
  return [
    {
      name: 'update_transaction',
      description:
        'Update one or more fields on a transaction in a single atomic write. ' +
        'Pass transaction_id plus any combination of category_id, note, tag_ids, ' +
        'excluded, name, internal_transfer, or goal_id. Omitted fields are preserved ' +
        '(e.g., sending only tag_ids does not erase the note). Pass note="" to clear ' +
        'the note. Pass tag_ids=[] to clear all tags. Pass goal_id=null to unlink the ' +
        'goal. At least one mutable field must be provided besides transaction_id.',
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
          excluded: {
            type: 'boolean',
            description: 'Whether the transaction is excluded from spending reports.',
          },
          name: {
            type: 'string',
            description: 'Display name (will be trimmed; must be non-empty if present).',
          },
          internal_transfer: {
            type: 'boolean',
            description: 'Whether the transaction is an internal transfer.',
          },
          goal_id: {
            type: ['string', 'null'],
            description: 'Financial goal ID to link to. Pass null to unlink the existing goal.',
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
        'Accepts an array of transaction_ids. Writes directly to Copilot Money via Firestore.',
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
        'Copilot Money app and can be referenced via hashtags in transaction names (e.g. #vacation). ' +
        'Optionally set a color. Writes directly to Copilot Money via Firestore.',
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
        'Delete a user-defined tag. The tag_id can be obtained from transaction names ' +
        '(hashtags like #vacation) or from the tag definitions in the local cache. ' +
        'Writes directly to Copilot Money via Firestore.',
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
        'Create a new custom category in Copilot Money. Provide a name (required) ' +
        'and optionally an emoji, color, parent category, or excluded flag. ' +
        'Returns the generated category_id. The new category can then be used ' +
        'with update_transaction.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Display name for the new category (e.g., "Subscriptions")',
          },
          emoji: {
            type: 'string',
            description: 'Emoji icon for the category (e.g., "🎬")',
          },
          color: {
            type: 'string',
            description: 'Hex color code for the category (e.g., "#FF5733")',
          },
          parent_category_id: {
            type: 'string',
            description:
              'Parent category ID to nest under (from get_categories). ' +
              'Creates a subcategory when provided.',
          },
          excluded: {
            type: 'boolean',
            description: 'Exclude this category from spending totals (default: false)',
            default: false,
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
      name: 'update_category',
      description:
        'Update an existing user-defined category. Provide category_id (required) and any ' +
        'fields to change: name, emoji, color, excluded, or parent_category_id (null to ungroup). ' +
        'Only the specified fields are updated. Writes directly to Copilot Money via Firestore.',
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
          color: {
            type: 'string',
            description: 'New hex color code for the category (e.g., "#FF5733")',
          },
          excluded: {
            type: 'boolean',
            description: 'Exclude this category from spending totals',
          },
          parent_category_id: {
            type: ['string', 'null'],
            description:
              'Parent category ID to nest under, or null to ungroup. ' +
              'Use get_categories to find valid parent IDs.',
          },
        },
        required: ['category_id'],
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
        'Writes directly to Copilot Money via Firestore.',
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
      name: 'create_budget',
      description:
        'Create a new budget in Copilot Money. Requires a category_id and amount. ' +
        'Only one budget per category is allowed. Optionally set a period (default: monthly) ' +
        'and a display name. Writes directly to Copilot Money via Firestore.',
      inputSchema: {
        type: 'object',
        properties: {
          category_id: {
            type: 'string',
            description: 'Category ID to budget for (from get_categories)',
          },
          amount: {
            type: 'number',
            description: 'Budget amount (must be greater than 0)',
          },
          period: {
            type: 'string',
            description: 'Budget period: monthly, yearly, weekly, or daily (default: monthly)',
            enum: ['monthly', 'yearly', 'weekly', 'daily'],
          },
          name: {
            type: 'string',
            description: 'Optional display name for the budget',
          },
        },
        required: ['category_id', 'amount'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    {
      name: 'update_budget',
      description:
        'Update an existing budget in Copilot Money. Requires budget_id and at least one ' +
        'field to update (amount, period, name, or is_active). Only provided fields are changed.',
      inputSchema: {
        type: 'object',
        properties: {
          budget_id: {
            type: 'string',
            description: 'Budget ID to update (from get_budgets)',
          },
          amount: {
            type: 'number',
            description: 'New budget amount (must be greater than 0)',
          },
          period: {
            type: 'string',
            description: 'New budget period: monthly, yearly, weekly, or daily',
            enum: ['monthly', 'yearly', 'weekly', 'daily'],
          },
          name: {
            type: 'string',
            description: 'New display name for the budget',
          },
          is_active: {
            type: 'boolean',
            description: 'Set to false to deactivate the budget, true to reactivate',
          },
        },
        required: ['budget_id'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      name: 'delete_budget',
      description:
        'Delete a budget from Copilot Money. Requires the budget_id (from get_budgets). ' +
        'This permanently removes the budget. Writes directly to Copilot Money via Firestore.',
      inputSchema: {
        type: 'object',
        properties: {
          budget_id: {
            type: 'string',
            description: 'Budget ID to delete (from get_budgets)',
          },
        },
        required: ['budget_id'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    {
      name: 'set_recurring_state',
      description:
        'Change the state of a recurring item (subscription/charge). ' +
        'Set to active, paused, or archived. Requires recurring_id (from get_recurring_transactions). ' +
        'Writes directly to Copilot Money via Firestore.',
      inputSchema: {
        type: 'object',
        properties: {
          recurring_id: {
            type: 'string',
            description: 'Recurring item ID to update (from get_recurring_transactions results)',
          },
          state: {
            type: 'string',
            enum: ['active', 'paused', 'archived'],
            description: 'New state for the recurring item',
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
        'Writes directly to Copilot Money via Firestore.',
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
      name: 'update_goal',
      description:
        "Update a financial goal's properties. Provide goal_id (required) and any combination " +
        'of name, emoji, target_amount, monthly_contribution, or status. Only the fields you ' +
        'provide will be updated. Writes directly to Copilot Money via Firestore.',
      inputSchema: {
        type: 'object',
        properties: {
          goal_id: {
            type: 'string',
            description: 'Goal ID to update (from get_goals results)',
          },
          name: {
            type: 'string',
            description: 'New display name for the goal',
          },
          emoji: {
            type: 'string',
            description: 'New emoji icon for the goal',
          },
          target_amount: {
            type: 'number',
            description: 'New target savings amount (must be > 0)',
          },
          monthly_contribution: {
            type: 'number',
            description: 'New monthly contribution amount (must be >= 0)',
          },
          status: {
            type: 'string',
            enum: ['active', 'paused'],
            description: 'Set goal status to active or paused',
          },
        },
        required: ['goal_id'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      name: 'delete_goal',
      description:
        'Delete a financial goal. The goal_id can be obtained from get_goals results. ' +
        'Writes directly to Copilot Money via Firestore.',
      inputSchema: {
        type: 'object',
        properties: {
          goal_id: {
            type: 'string',
            description: 'Goal ID to delete',
          },
        },
        required: ['goal_id'],
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
        'Writes directly to Copilot Money via Firestore.',
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
        'Create a new recurring/subscription item. Requires a name, amount, and frequency. ' +
        'Optionally set category, account, merchant name, or start date. ' +
        'Writes directly to Copilot Money via Firestore.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the recurring item (e.g. "Netflix", "Gym Membership")',
          },
          amount: {
            type: 'number',
            description: 'Recurring amount (must be greater than 0)',
          },
          frequency: {
            type: 'string',
            enum: ['weekly', 'biweekly', 'monthly', 'yearly'],
            description: 'How often the charge recurs',
          },
          category_id: {
            type: 'string',
            description: 'Category ID for this recurring item (from get_categories)',
          },
          account_id: {
            type: 'string',
            description: 'Account ID for this recurring item (from get_accounts)',
          },
          merchant_name: {
            type: 'string',
            description: 'Merchant name for the recurring charge',
          },
          start_date: {
            type: 'string',
            description: 'Start date in ISO format (YYYY-MM-DD). Defaults to today.',
          },
        },
        required: ['name', 'amount', 'frequency'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    {
      name: 'create_goal',
      description:
        'Create a new financial goal. Requires a name and target amount. ' +
        'Optionally set an emoji, monthly contribution, or start date. ' +
        'Writes directly to Copilot Money via Firestore.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the financial goal (e.g. "Emergency Fund", "Vacation")',
          },
          target_amount: {
            type: 'number',
            description: 'Target savings amount (must be greater than 0)',
          },
          emoji: {
            type: 'string',
            description: 'Emoji icon for the goal (e.g. "🏖️")',
          },
          monthly_contribution: {
            type: 'number',
            description:
              'Monthly contribution amount (must be >= 0). ' +
              'Sets tracking to monthly_contribution mode when provided.',
          },
          start_date: {
            type: 'string',
            description: 'Start date in ISO format (YYYY-MM-DD). Defaults to today.',
          },
        },
        required: ['name', 'target_amount'],
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
        'Update an existing recurring/subscription item. Can modify name, amount, frequency, ' +
        'category, account, match string, and transaction ID lists. ' +
        'Useful for fixing recurring detection — update match_string and transaction_ids ' +
        'to teach Copilot which transactions belong to this recurring charge. ' +
        'Writes directly to Copilot Money via Firestore.',
      inputSchema: {
        type: 'object',
        properties: {
          recurring_id: {
            type: 'string',
            description: 'ID of the recurring item to update (from get_recurring_transactions)',
          },
          name: {
            type: 'string',
            description: 'New display name for the recurring charge',
          },
          amount: {
            type: 'number',
            description: 'Expected recurring amount (must be > 0)',
          },
          frequency: {
            type: 'string',
            enum: ['weekly', 'biweekly', 'monthly', 'yearly'],
            description: 'How often this charge recurs',
          },
          category_id: {
            type: 'string',
            description: 'Category ID to assign (from get_categories)',
          },
          account_id: {
            type: 'string',
            description: 'Account ID this recurring charge is associated with',
          },
          merchant_name: {
            type: 'string',
            description: 'Merchant name for the recurring charge',
          },
          emoji: {
            type: 'string',
            description: 'Emoji icon for the recurring item',
          },
          match_string: {
            type: 'string',
            description:
              'Pattern used to auto-match incoming transactions to this recurring item ' +
              '(e.g., "NETFLIX" matches transactions with "NETFLIX" in the name)',
          },
          transaction_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Transaction IDs that belong to this recurring item',
          },
          excluded_transaction_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Transaction IDs explicitly excluded from this recurring item',
          },
          included_transaction_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Transaction IDs explicitly included in this recurring item',
          },
          days_filter: {
            type: 'number',
            description: 'Expected day-of-month for matching (e.g., 1 for charges on the 1st)',
          },
        },
        required: ['recurring_id'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
  ];
}
