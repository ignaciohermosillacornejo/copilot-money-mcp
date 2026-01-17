/**
 * MCP tool definitions for Copilot Money data.
 *
 * Exposes database functionality through the Model Context Protocol.
 */

import { CopilotDatabase } from '../core/database.js';
import { parsePeriod } from '../utils/date.js';
import { getCategoryName, isTransferCategory, isIncomeCategory } from '../utils/categories.js';
import type { Transaction, Account } from '../models/index.js';
import { getTransactionDisplayName, getRecurringDisplayName } from '../models/index.js';
import { estimateGoalCompletion } from '../models/goal.js';
import { getHistoryProgress, getMonthStartEnd, type GoalHistory } from '../models/goal-history.js';
import { getBestPrice, getPriceDate } from '../models/investment-price.js';
import {
  getSplitMultiplier,
  getSplitDisplayString,
  isReverseSplit,
} from '../models/investment-split.js';
import {
  getItemDisplayName,
  isItemHealthy,
  itemNeedsAttention,
  getItemStatusDescription,
  getItemAccountCount,
  formatLastUpdate,
} from '../models/item.js';
import {
  getRootCategories,
  getCategoryChildren,
  searchCategories as searchCategoriesInHierarchy,
} from '../models/category-full.js';

// ============================================
// Category Constants
// ============================================

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

/** Maximum allowed limit for data quality report transaction analysis */
const MAX_DATA_QUALITY_TRANSACTION_LIMIT = 100000;

/** Default limit for data quality report transaction analysis */
const DEFAULT_DATA_QUALITY_TRANSACTION_LIMIT = 50000;

/** Default limit for issues returned per category in data quality report */
const DEFAULT_ISSUES_LIMIT = 20;

/** Maximum issues to return per category in data quality report */
const MAX_ISSUES_LIMIT = 100;

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
// Configurable Currency Thresholds
// ============================================
// These thresholds can be overridden via tool parameters

/** Minimum spending amount to recommend creating a budget for an unbudgeted category */
const DEFAULT_BUDGET_RECOMMENDATION_THRESHOLD = 100;

/** Maximum amount from common retail merchants to consider as a refund (not income) */
const DEFAULT_REFUND_THRESHOLD = 500;

/** Default transaction amount above which to flag as a large transaction anomaly (user-configurable) */
const DEFAULT_LARGE_TRANSACTION_THRESHOLD = 1000;

/** Amount threshold for flagging large transactions with foreign merchant indicators */
const DEFAULT_FOREIGN_LARGE_AMOUNT_THRESHOLD = 1000;

/** Amount threshold for flagging suspiciously round foreign amounts */
const DEFAULT_ROUND_AMOUNT_THRESHOLD = 500;

/** Monthly change amount threshold for classifying account trends as growing/declining */
const DEFAULT_TREND_THRESHOLD = 100;

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
 * Collection of MCP tools for querying Copilot Money data.
 */
export class CopilotMoneyTools {
  private db: CopilotDatabase;
  private _userCategoryMap: Map<string, string> | null = null;
  private _userAccountMap: Map<string, string> | null = null;
  private _excludedCategoryIds: Set<string> | null = null;

  /**
   * Initialize tools with a database connection.
   *
   * @param database - CopilotDatabase instance
   */
  constructor(database: CopilotDatabase) {
    this.db = database;
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
   * Get the user-defined account name map.
   *
   * This map contains custom account names defined by the user in Copilot Money,
   * which take precedence over the bank's internal account names.
   *
   * @returns Map from account_id to user-defined account name
   */
  private async getUserAccountMap(): Promise<Map<string, string>> {
    if (this._userAccountMap === null) {
      this._userAccountMap = await this.db.getAccountNameMap();
    }
    return this._userAccountMap;
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
   * Get account name with user-defined names taking precedence.
   *
   * Checks user-defined account names first (e.g., "Chase Sapphire Preferred"),
   * then falls back to the account's own name/official_name from the bank
   * (e.g., "CHASE CREDIT CRD AUTOPAY").
   *
   * @param account - The account object to get a display name for
   * @returns Human-readable account name
   */
  private async resolveAccountName(account: {
    account_id: string;
    name?: string;
    official_name?: string;
  }): Promise<string> {
    // Check user-defined name first (highest priority)
    const userAccountMap = await this.getUserAccountMap();
    const userName = userAccountMap.get(account.account_id);
    if (userName) {
      return userName;
    }
    // Fall back to the account's own name/official_name
    return account.name ?? account.official_name ?? 'Unknown';
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

    return {
      count: enrichedTransactions.length,
      total_count: totalCount,
      offset: validatedOffset,
      has_more: hasMore,
      transactions: enrichedTransactions,
      ...(typeSpecificData && { type_specific_data: typeSpecificData }),
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
   * Unified spending aggregation tool.
   *
   * Supports multiple groupings via group_by parameter:
   * - category: Spending by category
   * - merchant: Spending by merchant
   * - day_of_week: Spending by day of week
   * - time: Spending over time (with granularity)
   * - rate: Spending rate/velocity analysis
   *
   * @param options - Filter and grouping options
   * @returns Spending data grouped as specified
   */
  async getSpending(options: {
    group_by: 'category' | 'merchant' | 'day_of_week' | 'time' | 'rate';
    granularity?: 'day' | 'week' | 'month';
    period?: string;
    start_date?: string;
    end_date?: string;
    category?: string;
    limit?: number;
    exclude_transfers?: boolean;
  }): Promise<{
    group_by: string;
    period: { start_date?: string; end_date?: string };
    total_spending: number;
    data: unknown;
    summary?: Record<string, unknown>;
  }> {
    const {
      group_by,
      granularity = 'month',
      period,
      category,
      limit = 50,
      exclude_transfers = true,
    } = options;
    let { start_date, end_date } = options;

    // Parse period if specified
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    } else if (!start_date && !end_date) {
      // Default to last 6 months for most analyses
      const now = new Date();
      end_date = now.toISOString().substring(0, 10);
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      start_date = sixMonthsAgo.toISOString().substring(0, 10);
    }

    // Get transactions
    let transactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    // Filter out transfers if requested
    if (exclude_transfers) {
      transactions = transactions.filter(
        (txn) => !isTransferCategory(txn.category_id) && !txn.internal_transfer
      );
    }

    // Filter by category if specified
    if (category) {
      const categoryLower = category.toLowerCase();
      transactions = transactions.filter((txn) =>
        txn.category_id?.toLowerCase().includes(categoryLower)
      );
    }

    // Only consider expenses (positive amounts in Copilot Money format)
    const expenses = transactions.filter((txn) => txn.amount > 0);

    switch (group_by) {
      case 'category': {
        const categorySpending = new Map<string, { total: number; count: number }>();
        for (const txn of expenses) {
          const cat = getCategoryIdOrDefault(txn.category_id);
          const existing = categorySpending.get(cat) || { total: 0, count: 0 };
          existing.total += Math.abs(txn.amount);
          existing.count++;
          categorySpending.set(cat, existing);
        }

        const categories = (
          await Promise.all(
            Array.from(categorySpending.entries()).map(async ([category_id, data]) => ({
              category_id,
              category_name: await this.resolveCategoryName(category_id),
              total_spending: roundAmount(data.total),
              transaction_count: data.count,
            }))
          )
        ).sort((a, b) => b.total_spending - a.total_spending);

        const totalSpending = categories.reduce((sum, c) => sum + c.total_spending, 0);

        return {
          group_by,
          period: { start_date, end_date },
          total_spending: roundAmount(totalSpending),
          data: categories,
          summary: { category_count: categories.length },
        };
      }

      case 'merchant': {
        const merchantSpending = new Map<
          string,
          { total: number; count: number; categoryId?: string }
        >();
        for (const txn of expenses) {
          const merchantName = getTransactionDisplayName(txn);
          const existing = merchantSpending.get(merchantName) || {
            total: 0,
            count: 0,
            categoryId: txn.category_id,
          };
          existing.total += Math.abs(txn.amount);
          existing.count++;
          merchantSpending.set(merchantName, existing);
        }

        const merchants = (
          await Promise.all(
            Array.from(merchantSpending.entries()).map(async ([merchant, data]) => ({
              merchant,
              category_name: data.categoryId
                ? await this.resolveCategoryName(data.categoryId)
                : undefined,
              total_spending: roundAmount(data.total),
              transaction_count: data.count,
              average_transaction: roundAmount(data.total / data.count),
            }))
          )
        )
          .sort((a, b) => b.total_spending - a.total_spending)
          .slice(0, limit);

        const totalSpending = merchants.reduce((sum, m) => sum + m.total_spending, 0);

        return {
          group_by,
          period: { start_date, end_date },
          total_spending: roundAmount(totalSpending),
          data: merchants,
          summary: { merchant_count: merchantSpending.size },
        };
      }

      case 'day_of_week': {
        const dayNames = [
          'Sunday',
          'Monday',
          'Tuesday',
          'Wednesday',
          'Thursday',
          'Friday',
          'Saturday',
        ];
        const daySpending = new Map<number, { total: number; count: number }>();

        for (const txn of expenses) {
          const dayOfWeek = new Date(txn.date + 'T12:00:00').getDay();
          const existing = daySpending.get(dayOfWeek) || { total: 0, count: 0 };
          existing.total += Math.abs(txn.amount);
          existing.count++;
          daySpending.set(dayOfWeek, existing);
        }

        const totalSpending = expenses.reduce((sum, txn) => sum + Math.abs(txn.amount), 0);

        const days = dayNames.map((name, index) => {
          const data = daySpending.get(index) || { total: 0, count: 0 };
          return {
            day_of_week: index,
            day_name: name,
            total_spending: roundAmount(data.total),
            transaction_count: data.count,
            average_transaction: data.count > 0 ? roundAmount(data.total / data.count) : 0,
            percentage: totalSpending > 0 ? roundAmount((data.total / totalSpending) * 100) : 0,
          };
        });

        const highestDay =
          days.length > 0
            ? days.reduce((max, d) => (d.total_spending > max.total_spending ? d : max), days[0]!)
            : null;

        return {
          group_by,
          period: { start_date, end_date },
          total_spending: roundAmount(totalSpending),
          data: days,
          summary: { highest_spending_day: highestDay?.day_name },
        };
      }

      case 'time': {
        const periodMap = new Map<
          string,
          { start: Date; end: Date; total: number; count: number }
        >();

        for (const txn of expenses) {
          const date = new Date(txn.date);
          const periodKey = this.getPeriodKey(date, granularity);
          const periodBounds = this.getPeriodBounds(date, granularity);

          if (!periodMap.has(periodKey)) {
            periodMap.set(periodKey, {
              start: periodBounds.start,
              end: periodBounds.end,
              total: 0,
              count: 0,
            });
          }

          const p = periodMap.get(periodKey)!;
          p.total += Math.abs(txn.amount);
          p.count++;
        }

        const periods = Array.from(periodMap.entries())
          .sort((a, b) => a[1].start.getTime() - b[1].start.getTime())
          .map(([, data]) => ({
            period_start: data.start.toISOString().substring(0, 10),
            period_end: data.end.toISOString().substring(0, 10),
            total_spending: roundAmount(data.total),
            transaction_count: data.count,
            average_transaction: data.count > 0 ? roundAmount(data.total / data.count) : 0,
          }));

        const totalSpending = periods.reduce((sum, p) => sum + p.total_spending, 0);
        const avgPerPeriod = periods.length > 0 ? roundAmount(totalSpending / periods.length) : 0;

        let highest: { period_start: string; amount: number } | null = null;
        let lowest: { period_start: string; amount: number } | null = null;
        for (const p of periods) {
          if (!highest || p.total_spending > highest.amount) {
            highest = { period_start: p.period_start, amount: p.total_spending };
          }
          if (!lowest || p.total_spending < lowest.amount) {
            lowest = { period_start: p.period_start, amount: p.total_spending };
          }
        }

        return {
          group_by,
          period: { start_date, end_date },
          total_spending: roundAmount(totalSpending),
          data: { granularity, periods },
          summary: {
            average_per_period: avgPerPeriod,
            highest_period: highest,
            lowest_period: lowest,
          },
        };
      }

      case 'rate': {
        const startDateObj = new Date(start_date + 'T00:00:00');
        const endDateObj = new Date(end_date + 'T23:59:59');
        const todayObj = new Date();
        const daysInPeriod = Math.ceil(
          (endDateObj.getTime() - startDateObj.getTime()) / (1000 * 60 * 60 * 24)
        );
        const daysElapsed = Math.min(
          Math.ceil((todayObj.getTime() - startDateObj.getTime()) / (1000 * 60 * 60 * 24)),
          daysInPeriod
        );

        const totalSpending = expenses.reduce((sum, txn) => sum + Math.abs(txn.amount), 0);
        const dailyAverage = daysElapsed > 0 ? totalSpending / daysElapsed : 0;
        const weeklyAverage = dailyAverage * 7;
        const projectedMonthlyTotal = dailyAverage * 30;

        return {
          group_by,
          period: { start_date, end_date },
          total_spending: roundAmount(totalSpending),
          data: {
            days_in_period: daysInPeriod,
            days_elapsed: daysElapsed,
            daily_average: roundAmount(dailyAverage),
            weekly_average: roundAmount(weeklyAverage),
            projected_monthly_total: roundAmount(projectedMonthlyTotal),
          },
          summary: {
            on_track: totalSpending <= dailyAverage * daysInPeriod,
          },
        };
      }
    }
  }

  /**
   * Unified account analytics tool.
   *
   * Supports multiple analysis types via the analysis parameter:
   * - activity: Account activity summary with transaction counts and flows
   * - balance_trends: Balance trends over time
   * - fees: Account-related fees (ATM, overdraft, etc.)
   *
   * @param options - Analysis type and filter options
   * @returns Account analytics data
   */
  async getAccountAnalytics(options: {
    analysis: 'activity' | 'balance_trends' | 'fees';
    account_id?: string;
    period?: string;
    start_date?: string;
    end_date?: string;
    months?: number;
    granularity?: 'daily' | 'weekly' | 'monthly';
    account_type?: string;
    trend_threshold?: number;
  }): Promise<{
    analysis: string;
    period: { start_date?: string; end_date?: string };
    data: unknown;
    summary?: Record<string, unknown>;
  }> {
    const {
      analysis,
      account_id,
      period = 'last_30_days',
      account_type,
      months = 6,
      granularity = 'monthly',
      trend_threshold = DEFAULT_TREND_THRESHOLD,
    } = options;
    let { start_date, end_date } = options;

    if (!start_date || !end_date) {
      [start_date, end_date] = parsePeriod(period);
    }
    const effectiveStartDate = start_date;
    const effectiveEndDate = end_date;

    const accounts = await this.db.getAccounts();
    const transactions = await this.db.getTransactions();
    const periodTransactions = transactions.filter(
      (t) => t.date >= effectiveStartDate && t.date <= effectiveEndDate
    );

    switch (analysis) {
      case 'activity': {
        const activityData: Array<{
          account_id: string;
          account_name: string;
          account_type?: string;
          transaction_count: number;
          total_inflow: number;
          total_outflow: number;
          net_flow: number;
          activity_level: string;
        }> = [];

        for (const account of accounts) {
          if (account_type) {
            const typeMatch =
              account.account_type?.toLowerCase().includes(account_type.toLowerCase()) ||
              account.subtype?.toLowerCase().includes(account_type.toLowerCase());
            if (!typeMatch) continue;
          }

          const accountTxns = periodTransactions.filter((t) => t.account_id === account.account_id);
          const count = accountTxns.length;

          let totalInflow = 0;
          let totalOutflow = 0;
          for (const t of accountTxns) {
            if (t.amount < 0) totalInflow += Math.abs(t.amount);
            else totalOutflow += t.amount;
          }

          let activityLevel = 'inactive';
          if (count >= 30) activityLevel = 'high';
          else if (count >= 10) activityLevel = 'medium';
          else if (count > 0) activityLevel = 'low';

          activityData.push({
            account_id: account.account_id,
            account_name: await this.resolveAccountName(account),
            account_type: account.account_type,
            transaction_count: count,
            total_inflow: roundAmount(totalInflow),
            total_outflow: roundAmount(totalOutflow),
            net_flow: roundAmount(totalInflow - totalOutflow),
            activity_level: activityLevel,
          });
        }

        activityData.sort((a, b) => b.transaction_count - a.transaction_count);

        return {
          analysis,
          period: { start_date, end_date },
          data: activityData,
          summary: {
            total_accounts: activityData.length,
            active_accounts: activityData.filter((a) => a.activity_level !== 'inactive').length,
            most_active: activityData[0]?.account_name || null,
          },
        };
      }

      case 'balance_trends': {
        // Calculate monthly trends based on transactions
        const accountsToAnalyze = account_id
          ? accounts.filter((a) => a.account_id === account_id)
          : accounts;

        let growingCount = 0;
        let decliningCount = 0;
        let stableCount = 0;

        const trendsData = await Promise.all(
          accountsToAnalyze.map(async (account) => {
            const accountTxns = transactions
              .filter((t) => t.account_id === account.account_id)
              .sort((a, b) => a.date.localeCompare(b.date));

            // Group by month
            const monthlyData = new Map<string, { inflow: number; outflow: number }>();
            for (const t of accountTxns) {
              const month = t.date.substring(0, 7);
              const existing = monthlyData.get(month) || { inflow: 0, outflow: 0 };
              if (t.amount < 0) existing.inflow += Math.abs(t.amount);
              else existing.outflow += t.amount;
              monthlyData.set(month, existing);
            }

            const monthlyArray = Array.from(monthlyData.entries())
              .sort((a, b) => a[0].localeCompare(b[0]))
              .slice(-months)
              .map(([month, data]) => ({
                month,
                inflow: roundAmount(data.inflow),
                outflow: roundAmount(data.outflow),
                net_change: roundAmount(data.inflow - data.outflow),
              }));

            // Calculate overall trend using configurable threshold
            const totalNetChange = monthlyArray.reduce((sum, m) => sum + m.net_change, 0);
            const avgMonthlyChange = monthlyArray.length > 0 ? totalNetChange / months : 0;

            let overallTrend: 'growing' | 'declining' | 'stable' = 'stable';
            if (avgMonthlyChange > trend_threshold) {
              overallTrend = 'growing';
              growingCount++;
            } else if (avgMonthlyChange < -trend_threshold) {
              overallTrend = 'declining';
              decliningCount++;
            } else {
              stableCount++;
            }

            return {
              account_id: account.account_id,
              account_name: await this.resolveAccountName(account),
              current_balance: account.current_balance,
              monthly_data: monthlyArray,
              overall_trend: overallTrend,
              average_monthly_change: roundAmount(avgMonthlyChange),
            };
          })
        );

        return {
          analysis,
          period: { start_date, end_date },
          data: { months, granularity, accounts: trendsData },
          summary: {
            total_accounts: trendsData.length,
            growing_accounts: growingCount,
            declining_accounts: decliningCount,
            stable_accounts: stableCount,
          },
        };
      }

      case 'fees': {
        const feeCategories = [
          'bank_fees',
          'atm_fee',
          'overdraft',
          'service_fee',
          'late_fee',
          '10000000',
        ];
        // Fees are expenses (negative amounts in standard accounting)
        const feeTxns = periodTransactions.filter((t) => {
          const isFeeCategory =
            t.category_id &&
            feeCategories.some((fc) => t.category_id!.toLowerCase().includes(fc.toLowerCase()));
          const isFeeName = getTransactionDisplayName(t).toLowerCase().includes('fee');
          return (isFeeCategory || isFeeName) && t.amount > 0;
        });

        if (account_id) {
          const filtered = feeTxns.filter((t) => t.account_id === account_id);
          feeTxns.length = 0;
          feeTxns.push(...filtered);
        }

        const feesByType = new Map<string, { count: number; total: number }>();
        for (const t of feeTxns) {
          const type = await this.resolveCategoryName(t.category_id || 'unknown_fee');
          const existing = feesByType.get(type) || { count: 0, total: 0 };
          existing.count++;
          existing.total += Math.abs(t.amount);
          feesByType.set(type, existing);
        }

        const feeData = Array.from(feesByType.entries())
          .map(([type, data]) => ({
            fee_type: type,
            count: data.count,
            total: roundAmount(data.total),
          }))
          .sort((a, b) => b.total - a.total);

        const totalFees = feeTxns.reduce((sum, t) => sum + Math.abs(t.amount), 0);

        return {
          analysis,
          period: { start_date, end_date },
          data: feeData,
          summary: {
            total_fees: roundAmount(totalFees),
            fee_count: feeTxns.length,
          },
        };
      }
    }
  }

  /**
   * Unified budget analytics tool.
   *
   * Supports multiple analysis types:
   * - utilization: Current budget usage
   * - vs_actual: Budget vs actual spending comparison
   * - alerts: Budgets approaching/exceeding limits
   * - recommendations: Smart budget recommendations
   *
   * @param options - Analysis type and filter options
   * @returns Budget analytics data
   */
  async getBudgetAnalytics(options: {
    analysis: 'utilization' | 'vs_actual' | 'alerts' | 'recommendations';
    month?: string;
    months?: number;
    category?: string;
    threshold_percentage?: number;
    budget_recommendation_threshold?: number;
  }): Promise<{
    analysis: string;
    data: unknown;
    summary?: Record<string, unknown>;
  }> {
    const {
      analysis,
      month,
      months = 6,
      category,
      threshold_percentage = 80,
      budget_recommendation_threshold = DEFAULT_BUDGET_RECOMMENDATION_THRESHOLD,
    } = options;

    const budgets = await this.db.getBudgets(true);
    const now = new Date();
    const currentMonth =
      month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [monthStart, monthEnd] = parsePeriod('this_month');

    const transactions = await this.db.getTransactions({
      startDate: monthStart,
      endDate: monthEnd,
      limit: 50000,
    });

    switch (analysis) {
      case 'utilization': {
        const utilizationData = await Promise.all(
          budgets.map(async (budget) => {
            const categoryId = budget.category_id;
            // Expenses are positive amounts in Copilot Money format
            const spent = transactions
              .filter(
                (t) =>
                  t.amount > 0 && t.category_id === categoryId && !isTransferCategory(t.category_id)
              )
              .reduce((sum, t) => sum + Math.abs(t.amount), 0);
            const budgetAmount = budget.amount || 0;
            const utilization = budgetAmount > 0 ? (spent / budgetAmount) * 100 : 0;

            return {
              budget_id: budget.budget_id,
              category: await this.resolveCategoryName(categoryId || 'Unknown'),
              budget_amount: budgetAmount,
              spent: roundAmount(spent),
              remaining: roundAmount(budgetAmount - spent),
              utilization_percent: roundAmount(utilization),
              status:
                utilization >= 100
                  ? ('over' as const)
                  : utilization >= 80
                    ? ('warning' as const)
                    : ('ok' as const),
            };
          })
        );

        if (category) {
          const filtered = utilizationData.filter((u) =>
            u.category.toLowerCase().includes(category.toLowerCase())
          );
          return { analysis, data: filtered, summary: { month: currentMonth } };
        }

        return {
          analysis,
          data: utilizationData,
          summary: {
            month: currentMonth,
            over_budget: utilizationData.filter((u) => u.status === 'over').length,
            warning: utilizationData.filter((u) => u.status === 'warning').length,
          },
        };
      }

      case 'vs_actual': {
        // Get historical data
        const historicalData: Array<{
          month: string;
          budgeted: number;
          actual: number;
          variance: number;
        }> = [];
        const startMonth = new Date();
        startMonth.setMonth(startMonth.getMonth() - months);

        for (let i = 0; i < months; i++) {
          const m = new Date(startMonth);
          m.setMonth(m.getMonth() + i);
          const monthStr = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
          // Approximate month boundaries
          const monthStartDate = `${monthStr}-01`;
          const monthEndDate = `${monthStr}-31`;

          const monthTxns = await this.db.getTransactions({
            startDate: monthStartDate,
            endDate: monthEndDate,
            limit: 50000,
          });
          // Expenses are positive amounts in Copilot Money format
          const actual = monthTxns
            .filter((t) => t.amount > 0 && !isTransferCategory(t.category_id))
            .reduce((sum, t) => sum + Math.abs(t.amount), 0);

          const budgeted = budgets.reduce((sum, b) => sum + (b.amount || 0), 0);

          historicalData.push({
            month: monthStr,
            budgeted: roundAmount(budgeted),
            actual: roundAmount(actual),
            variance: roundAmount(budgeted - actual),
          });
        }

        return {
          analysis,
          data: historicalData,
          summary: { months_analyzed: months },
        };
      }

      case 'alerts': {
        const alertsRaw = await Promise.all(
          budgets.map(async (budget) => {
            const categoryId = budget.category_id;
            // Expenses are positive amounts in Copilot Money format
            const spent = transactions
              .filter((t) => t.amount > 0 && t.category_id === categoryId)
              .reduce((sum, t) => sum + Math.abs(t.amount), 0);
            const budgetAmount = budget.amount || 0;
            const utilization = budgetAmount > 0 ? (spent / budgetAmount) * 100 : 0;

            if (utilization >= threshold_percentage) {
              return {
                budget_id: budget.budget_id,
                category: await this.resolveCategoryName(categoryId || 'Unknown'),
                budget_amount: budgetAmount,
                spent: roundAmount(spent),
                utilization_percent: roundAmount(utilization),
                alert_level: utilization >= 100 ? ('exceeded' as const) : ('warning' as const),
              };
            }
            return null;
          })
        );
        const alerts = alertsRaw.filter(Boolean);

        return {
          analysis,
          data: alerts,
          summary: { threshold: threshold_percentage, alert_count: alerts.length },
        };
      }

      case 'recommendations': {
        // Simple recommendations based on spending patterns
        const recommendations: Array<{
          type: string;
          category: string;
          message: string;
          suggested_amount?: number;
        }> = [];

        // Check for categories with spending but no budget
        // Expenses are positive amounts in Copilot Money format
        const spendingByCategory = new Map<string, number>();
        for (const t of transactions) {
          if (t.amount > 0 && !isTransferCategory(t.category_id)) {
            const cat = getCategoryIdOrDefault(t.category_id);
            spendingByCategory.set(cat, (spendingByCategory.get(cat) || 0) + Math.abs(t.amount));
          }
        }

        const budgetedCategories = new Set(budgets.map((b) => b.category_id));

        for (const [cat, spent] of spendingByCategory) {
          if (!budgetedCategories.has(cat) && spent > budget_recommendation_threshold) {
            recommendations.push({
              type: 'new_budget',
              category: await this.resolveCategoryName(cat),
              message: `Consider creating a budget for ${await this.resolveCategoryName(cat)} - you spent $${Math.round(spent)} this month`,
              suggested_amount: roundAmount(spent * 1.1),
            });
          }
        }

        return {
          analysis,
          data: recommendations.slice(0, 10),
          summary: { recommendation_count: recommendations.length },
        };
      }
    }
  }

  /**
   * Unified goal analytics tool.
   *
   * Supports multiple analysis types:
   * - projection: Goal completion projections with scenarios
   * - risk: Identify goals at risk
   * - recommendations: Personalized goal recommendations
   *
   * @param options - Analysis type and filter options
   * @returns Goal analytics data
   */
  async getGoalAnalytics(options: {
    analysis: 'projection' | 'risk' | 'recommendations';
    goal_id?: string;
    months_lookback?: number;
  }): Promise<{
    analysis: string;
    data: unknown;
    summary?: Record<string, unknown>;
  }> {
    const { analysis, goal_id, months_lookback = 6 } = options;
    const goals = await this.db.getGoals(false);
    const filteredGoals = goal_id ? goals.filter((g) => g.goal_id === goal_id) : goals;

    switch (analysis) {
      case 'projection': {
        const projections = await Promise.all(
          filteredGoals.map(async (goal) => {
            const history = await this.db.getGoalHistory(goal.goal_id, { limit: 12 });
            const targetAmount = goal.savings?.target_amount || 0;
            let currentAmount = 0;
            let avgMonthlyContribution = 0;

            if (history.length > 0) {
              currentAmount = history[0]?.current_amount ?? 0;
              if (history.length >= 2) {
                const contributions = [];
                for (let i = 1; i < history.length; i++) {
                  const current = history[i - 1]?.current_amount ?? 0;
                  const previous = history[i]?.current_amount ?? 0;
                  contributions.push(current - previous);
                }
                avgMonthlyContribution =
                  contributions.reduce((a, b) => a + b, 0) / contributions.length;
              }
            }

            const remaining = targetAmount - currentAmount;
            const monthsToComplete =
              avgMonthlyContribution > 0 ? Math.ceil(remaining / avgMonthlyContribution) : null;

            return {
              goal_id: goal.goal_id,
              name: goal.name,
              target_amount: targetAmount,
              current_amount: roundAmount(currentAmount),
              progress_percent:
                targetAmount > 0 ? roundAmount((currentAmount / targetAmount) * 100) : 0,
              avg_monthly_contribution: roundAmount(avgMonthlyContribution),
              months_to_complete: monthsToComplete,
              scenarios: {
                conservative: monthsToComplete ? Math.ceil(monthsToComplete * 1.2) : null,
                moderate: monthsToComplete,
                aggressive: monthsToComplete ? Math.ceil(monthsToComplete * 0.8) : null,
              },
            };
          })
        );

        return { analysis, data: projections };
      }

      case 'risk': {
        const atRiskRaw = await Promise.all(
          filteredGoals.map(async (goal) => {
            const history = await this.db.getGoalHistory(goal.goal_id, { limit: months_lookback });
            const targetAmount = goal.savings?.target_amount || 0;
            const currentAmount = history[0]?.current_amount ?? 0;
            const progress = targetAmount > 0 ? (currentAmount / targetAmount) * 100 : 0;

            // Calculate consistency
            let riskScore = 0;
            const riskFactors: string[] = [];

            if (progress < 25 && history.length > 3) {
              riskScore += 30;
              riskFactors.push('Low progress after several months');
            }

            if (history.length >= 2) {
              const recentChange =
                (history[0]?.current_amount ?? 0) - (history[1]?.current_amount ?? 0);
              if (recentChange <= 0) {
                riskScore += 20;
                riskFactors.push('No recent contributions');
              }
            }

            if (riskScore >= 30) {
              return {
                goal_id: goal.goal_id,
                name: goal.name,
                risk_score: riskScore,
                risk_level: riskScore >= 50 ? ('high' as const) : ('medium' as const),
                risk_factors: riskFactors,
                current_progress: roundAmount(progress),
              };
            }
            return null;
          })
        );
        const atRisk = atRiskRaw.filter(Boolean);

        return {
          analysis,
          data: atRisk,
          summary: { goals_at_risk: atRisk.length },
        };
      }

      case 'recommendations': {
        const recommendations: Array<{
          goal_id: string;
          name: string;
          recommendation: string;
          priority: string;
        }> = [];

        for (const goal of filteredGoals) {
          const history = await this.db.getGoalHistory(goal.goal_id, { limit: 6 });
          const targetAmount = goal.savings?.target_amount || 0;
          const currentAmount = history[0]?.current_amount ?? 0;
          const progress = targetAmount > 0 ? (currentAmount / targetAmount) * 100 : 0;

          if (progress >= 90) {
            recommendations.push({
              goal_id: goal.goal_id,
              name: goal.name || 'Unknown',
              recommendation: 'Almost there! Consider a final push to complete this goal.',
              priority: 'low',
            });
          } else if (progress < 10 && history.length > 2) {
            recommendations.push({
              goal_id: goal.goal_id,
              name: goal.name || 'Unknown',
              recommendation: 'Consider increasing contributions or adjusting the target.',
              priority: 'high',
            });
          }
        }

        return { analysis, data: recommendations };
      }
    }
  }

  /**
   * Get goal details with optional includes.
   *
   * Combines goal progress, history, and contributions into a single call.
   *
   * @param options - Filter and include options
   * @returns Goal details
   */
  async getGoalDetails(
    options: {
      goal_id?: string;
      include?: ('progress' | 'history' | 'contributions')[];
      start_month?: string;
      end_month?: string;
    } = {}
  ): Promise<{
    count: number;
    goals: Array<{
      goal_id: string;
      name?: string;
      target_amount?: number;
      progress?: { current_amount: number; progress_percent: number };
      history?: Array<{ month: string; amount: number }>;
      contributions?: { total: number; monthly_avg: number };
    }>;
  }> {
    const { goal_id, include = ['progress'], start_month, end_month } = options;
    const goals = await this.db.getGoals(false);
    const filteredGoals = goal_id ? goals.filter((g) => g.goal_id === goal_id) : goals;

    const goalDetails = await Promise.all(
      filteredGoals.map(async (goal) => {
        const result: {
          goal_id: string;
          name?: string;
          target_amount?: number;
          progress?: { current_amount: number; progress_percent: number };
          history?: Array<{ month: string; amount: number }>;
          contributions?: { total: number; monthly_avg: number };
        } = {
          goal_id: goal.goal_id,
          name: goal.name,
          target_amount: goal.savings?.target_amount,
        };

        const history = await this.db.getGoalHistory(goal.goal_id, {
          startMonth: start_month,
          endMonth: end_month,
          limit: 12,
        });

        if (include.includes('progress')) {
          const currentAmount = history[0]?.current_amount ?? 0;
          const targetAmount = goal.savings?.target_amount || 0;
          result.progress = {
            current_amount: roundAmount(currentAmount),
            progress_percent:
              targetAmount > 0 ? roundAmount((currentAmount / targetAmount) * 100) : 0,
          };
        }

        if (include.includes('history')) {
          result.history = history.map((h) => ({
            month: h.month,
            amount: roundAmount(h.current_amount ?? 0),
          }));
        }

        if (include.includes('contributions')) {
          let totalContributions = 0;
          if (history.length >= 2) {
            for (let i = 0; i < history.length - 1; i++) {
              const current = history[i]?.current_amount ?? 0;
              const previous = history[i + 1]?.current_amount ?? 0;
              if (current > previous) totalContributions += current - previous;
            }
          }
          result.contributions = {
            total: roundAmount(totalContributions),
            monthly_avg:
              history.length > 1 ? roundAmount(totalContributions / (history.length - 1)) : 0,
          };
        }

        return result;
      })
    );

    return { count: goalDetails.length, goals: goalDetails };
  }

  /**
   * Unified investment analytics tool.
   *
   * Supports multiple analysis types:
   * - performance: Investment performance metrics
   * - dividends: Dividend income tracking
   * - fees: Investment-related fees
   *
   * @param options - Analysis type and filter options
   * @returns Investment analytics data
   */
  async getInvestmentAnalytics(options: {
    analysis: 'performance' | 'dividends' | 'fees';
    ticker_symbol?: string;
    account_id?: string;
    period?: string;
    start_date?: string;
    end_date?: string;
  }): Promise<{
    analysis: string;
    period: { start_date?: string; end_date?: string };
    data: unknown;
    summary?: Record<string, unknown>;
  }> {
    const { analysis, ticker_symbol, account_id, period = 'ytd' } = options;
    let { start_date, end_date } = options;

    if (!start_date || !end_date) {
      [start_date, end_date] = parsePeriod(period);
    }
    const effectiveStartDate = start_date;
    const effectiveEndDate = end_date;

    switch (analysis) {
      case 'performance': {
        const prices = await this.db.getInvestmentPrices({ tickerSymbol: ticker_symbol });
        const filteredPrices = prices.filter((p) => {
          const priceDate = getPriceDate(p);
          return priceDate && priceDate >= effectiveStartDate && priceDate <= effectiveEndDate;
        });

        // Group by ticker
        const tickerPerformance = new Map<
          string,
          { prices: typeof filteredPrices; earliest: number; latest: number }
        >();

        for (const p of filteredPrices) {
          const ticker = p.ticker_symbol || 'Unknown';
          const existing = tickerPerformance.get(ticker) || {
            prices: [],
            earliest: Infinity,
            latest: 0,
          };
          const price = getBestPrice(p);
          if (price) {
            existing.prices.push(p);
            existing.earliest = Math.min(existing.earliest, price);
            existing.latest = price;
          }
          tickerPerformance.set(ticker, existing);
        }

        const performanceData = Array.from(tickerPerformance.entries()).map(([ticker, data]) => {
          const change = data.latest - data.earliest;
          const changePercent = data.earliest > 0 ? (change / data.earliest) * 100 : 0;
          return {
            ticker_symbol: ticker,
            earliest_price: roundAmount(data.earliest),
            latest_price: roundAmount(data.latest),
            change: roundAmount(change),
            change_percent: roundAmount(changePercent),
            trend: change > 0 ? 'up' : change < 0 ? 'down' : 'stable',
          };
        });

        return {
          analysis,
          period: { start_date, end_date },
          data: performanceData,
          summary: {
            securities_count: performanceData.length,
            gainers: performanceData.filter((p) => p.trend === 'up').length,
            losers: performanceData.filter((p) => p.trend === 'down').length,
          },
        };
      }

      case 'dividends': {
        const transactions = await this.db.getTransactions({
          startDate: start_date,
          endDate: end_date,
          limit: 50000,
        });
        const dividendTxns = transactions.filter((t) => {
          const name = getTransactionDisplayName(t).toLowerCase();
          const isDividend =
            name.includes('dividend') || t.category_id?.toLowerCase().includes('dividend');
          const accountMatch = !account_id || t.account_id === account_id;
          return isDividend && t.amount < 0 && accountMatch;
        });

        const totalDividends = dividendTxns.reduce((sum, t) => sum + Math.abs(t.amount), 0);

        return {
          analysis,
          period: { start_date, end_date },
          data: dividendTxns.map((t) => ({
            date: t.date,
            amount: roundAmount(Math.abs(t.amount)),
            source: getTransactionDisplayName(t),
          })),
          summary: {
            total_dividends: roundAmount(totalDividends),
            payment_count: dividendTxns.length,
          },
        };
      }

      case 'fees': {
        const transactions = await this.db.getTransactions({
          startDate: start_date,
          endDate: end_date,
          limit: 50000,
        });
        const accounts = await this.db.getAccounts();
        // Fees are expenses (negative amounts in standard accounting)
        const feeTxns = transactions.filter((t) => {
          const name = getTransactionDisplayName(t).toLowerCase();
          const isFee =
            name.includes('fee') ||
            name.includes('commission') ||
            t.category_id?.toLowerCase().includes('fee');
          const accountMatch = !account_id || t.account_id === account_id;
          // Check if it's from an investment account type
          const txnAccount = accounts.find((a) => a.account_id === t.account_id);
          const isInvestmentAccount =
            txnAccount?.account_type?.toLowerCase().includes('investment') ||
            txnAccount?.subtype?.toLowerCase().includes('brokerage');
          return isFee && t.amount > 0 && accountMatch && isInvestmentAccount;
        });

        const totalFees = feeTxns.reduce((sum, t) => sum + Math.abs(t.amount), 0);

        return {
          analysis,
          period: { start_date, end_date },
          data: feeTxns.map((t) => ({
            date: t.date,
            amount: roundAmount(Math.abs(t.amount)),
            description: getTransactionDisplayName(t),
          })),
          summary: {
            total_fees: roundAmount(totalFees),
            fee_count: feeTxns.length,
          },
        };
      }
    }
  }

  /**
   * Unified merchant analytics tool.
   *
   * Combines top merchants and merchant frequency analysis.
   *
   * @param options - Sort and filter options
   * @returns Merchant analytics data
   */
  async getMerchantAnalytics(options: {
    sort_by: 'spending' | 'frequency' | 'average';
    period?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
    min_visits?: number;
  }): Promise<{
    sort_by: string;
    period: { start_date?: string; end_date?: string };
    merchants: Array<{
      merchant: string;
      total_spending: number;
      transaction_count: number;
      average_transaction: number;
      first_visit?: string;
      last_visit?: string;
      visits_per_month?: number;
    }>;
    summary: {
      total_merchants: number;
      total_spending: number;
    };
  }> {
    const { sort_by, period = 'last_90_days', limit = 20, min_visits = 1 } = options;
    let { start_date, end_date } = options;

    if (!start_date || !end_date) {
      [start_date, end_date] = parsePeriod(period);
    }

    const transactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });
    // Expenses are positive amounts in Copilot Money format
    const expenses = transactions.filter((t) => t.amount > 0 && !isTransferCategory(t.category_id));

    const merchantData = new Map<string, { total: number; count: number; dates: string[] }>();

    for (const t of expenses) {
      const merchant = normalizeMerchantName(getTransactionDisplayName(t));
      const existing = merchantData.get(merchant) || { total: 0, count: 0, dates: [] };
      existing.total += Math.abs(t.amount);
      existing.count++;
      existing.dates.push(t.date);
      merchantData.set(merchant, existing);
    }

    // Calculate months in period for visits_per_month
    const startDateObj = new Date(start_date);
    const endDateObj = new Date(end_date);
    const monthsInPeriod = Math.max(
      1,
      (endDateObj.getTime() - startDateObj.getTime()) / (1000 * 60 * 60 * 24 * 30)
    );

    let merchants = Array.from(merchantData.entries())
      .filter(([, data]) => data.count >= min_visits)
      .map(([merchant, data]) => {
        const sortedDates = data.dates.sort();
        return {
          merchant,
          total_spending: roundAmount(data.total),
          transaction_count: data.count,
          average_transaction: roundAmount(data.total / data.count),
          first_visit: sortedDates[0],
          last_visit: sortedDates[sortedDates.length - 1],
          visits_per_month: roundAmount(data.count / monthsInPeriod),
        };
      });

    // Sort based on sort_by
    switch (sort_by) {
      case 'spending':
        merchants.sort((a, b) => b.total_spending - a.total_spending);
        break;
      case 'frequency':
        merchants.sort((a, b) => b.transaction_count - a.transaction_count);
        break;
      case 'average':
        merchants.sort((a, b) => b.average_transaction - a.average_transaction);
        break;
    }

    merchants = merchants.slice(0, limit);
    const totalSpending = merchants.reduce((sum, m) => sum + m.total_spending, 0);

    return {
      sort_by,
      period: { start_date, end_date },
      merchants,
      summary: {
        total_merchants: merchantData.size,
        total_spending: roundAmount(totalSpending),
      },
    };
  }

  /**
   * Free-text search of transactions with optional date filtering.
   *
   * Searches merchant names (display_name field).
   *
   * @param query - Search query (case-insensitive)
   * @param options - Optional search options
   * @returns Object with transaction count and list of matching transactions
   */
  async searchTransactions(
    query: string,
    options: {
      limit?: number;
      period?: string;
      start_date?: string;
      end_date?: string;
    } = {}
  ): Promise<{
    count: number;
    transactions: Array<Transaction & { category_name?: string }>;
  }> {
    const { limit = 50, period } = options;
    let { start_date, end_date } = options;

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    let transactions = await this.db.searchTransactions(
      query,
      start_date || end_date ? 10000 : limit
    );

    // Apply date filters if specified
    if (start_date) {
      const startDateFilter = start_date;
      transactions = transactions.filter((txn) => txn.date >= startDateFilter);
    }
    if (end_date) {
      const endDateFilter = end_date;
      transactions = transactions.filter((txn) => txn.date <= endDateFilter);
    }

    // Apply limit
    transactions = transactions.slice(0, limit);

    // Add human-readable category names
    const enrichedTransactions = await Promise.all(
      transactions.map(async (txn) => ({
        ...txn,
        category_name: txn.category_id
          ? await this.resolveCategoryName(txn.category_id)
          : undefined,
      }))
    );

    return {
      count: enrichedTransactions.length,
      transactions: enrichedTransactions,
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

    // Calculate total balance
    const totalBalance = accounts.reduce((sum, acc) => sum + acc.current_balance, 0);

    return {
      count: accounts.length,
      total_balance: roundAmount(totalBalance),
      accounts,
    };
  }

  /**
   * Get spending aggregated by category.
   *
   * @param options - Filter options
   * @returns Object with spending breakdown by category
   */
  async getSpendingByCategory(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    min_amount?: number;
    exclude_transfers?: boolean;
  }): Promise<{
    period: { start_date?: string; end_date?: string };
    total_spending: number;
    category_count: number;
    categories: Array<{
      category_id: string;
      category_name: string;
      total_spending: number;
      transaction_count: number;
    }>;
  }> {
    const { period, min_amount = 0.0, exclude_transfers = false } = options;
    let { start_date, end_date } = options;

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Get transactions with filters
    // Note: expenses are positive amounts in Copilot Money format
    // We'll filter by absolute amount after selecting expenses
    let transactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000, // High limit for aggregation
    });

    // Filter out transfers if requested (check both category and internal_transfer flag)
    if (exclude_transfers) {
      transactions = transactions.filter(
        (txn) => !isTransferCategory(txn.category_id) && !txn.internal_transfer
      );
    }

    // Aggregate by category (always exclude internal transfers from spending)
    // Expenses are positive amounts in Copilot Money format
    const categorySpending: Map<string, number> = new Map();
    const categoryCounts: Map<string, number> = new Map();

    for (const txn of transactions) {
      // Only count positive amounts (expenses in Copilot format), skip internal transfers
      // Also apply min_amount filter on absolute value
      if (txn.amount > 0 && !txn.internal_transfer && txn.amount >= min_amount) {
        const cat = getCategoryIdOrDefault(txn.category_id);
        categorySpending.set(cat, (categorySpending.get(cat) || 0) + Math.abs(txn.amount));
        categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
      }
    }

    // Convert to list of objects, sorted by spending (descending)
    const categories = (
      await Promise.all(
        Array.from(categorySpending.entries()).map(async ([category_id, total_spending]) => ({
          category_id,
          category_name: await this.resolveCategoryName(category_id),
          total_spending: roundAmount(total_spending),
          transaction_count: categoryCounts.get(category_id) || 0,
        }))
      )
    ).sort((a, b) => b.total_spending - a.total_spending);

    // Calculate totals
    const totalSpending = roundAmount(categories.reduce((sum, cat) => sum + cat.total_spending, 0));

    return {
      period: { start_date, end_date },
      total_spending: totalSpending,
      category_count: categories.length,
      categories,
    };
  }

  /**
   * Get balance for a specific account.
   *
   * @param accountId - Account ID to query
   * @returns Object with account details and balance
   * @throws Error if account_id is not found
   */
  async getAccountBalance(accountId: string): Promise<{
    account_id: string;
    name: string;
    account_type?: string;
    subtype?: string;
    current_balance: number;
    available_balance?: number;
    mask?: string;
    institution_name?: string;
  }> {
    const accounts = await this.db.getAccounts();

    // Find the account
    const account = accounts.find((acc) => acc.account_id === accountId);

    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    return {
      account_id: account.account_id,
      name: await this.resolveAccountName(account),
      account_type: account.account_type,
      subtype: account.subtype,
      current_balance: account.current_balance,
      available_balance: account.available_balance,
      mask: account.mask,
      institution_name: account.institution_name,
    };
  }

  /**
   * Get all categories with human-readable names.
   *
   * @returns Object with list of all categories found in transactions
   */
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
    } = {}
  ): Promise<{
    view: string;
    count: number;
    data: unknown;
  }> {
    const { view = 'list', parent_id, query, type } = options;

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
        const allTransactions = await this.db.getAllTransactions();

        // Count transactions and amounts per category
        const categoryStats = new Map<string, { count: number; totalAmount: number }>();

        for (const txn of allTransactions) {
          const categoryId = getCategoryIdOrDefault(txn.category_id);
          const stats = categoryStats.get(categoryId) || {
            count: 0,
            totalAmount: 0,
          };
          stats.count++;
          stats.totalAmount += Math.abs(txn.amount);
          categoryStats.set(categoryId, stats);
        }

        // Convert to list
        const categories = (
          await Promise.all(
            Array.from(categoryStats.entries()).map(async ([category_id, stats]) => ({
              category_id,
              category_name: await this.resolveCategoryName(category_id),
              transaction_count: stats.count,
              total_amount: roundAmount(stats.totalAmount),
            }))
          )
        ).sort((a, b) => b.transaction_count - a.transaction_count);

        return {
          view: 'list',
          count: categories.length,
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
    copilot_subscriptions?: Array<{
      recurring_id: string;
      name: string;
      amount?: number;
      frequency?: string;
      next_date?: string;
      last_date?: string;
      category_name?: string;
      is_active?: boolean;
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
      | Array<{
          recurring_id: string;
          name: string;
          amount?: number;
          frequency?: string;
          next_date?: string;
          last_date?: string;
          category_name?: string;
          is_active?: boolean;
        }>
      | undefined;

    if (includeCopilotSubs) {
      const copilotRecurring = await this.db.getRecurring();
      if (copilotRecurring.length > 0) {
        copilotSubscriptions = await Promise.all(
          copilotRecurring.map(async (rec) => ({
            recurring_id: rec.recurring_id,
            name: getRecurringDisplayName(rec),
            amount: rec.amount,
            frequency: rec.frequency,
            next_date: rec.next_date,
            last_date: rec.last_date,
            category_name: rec.category_id
              ? await this.resolveCategoryName(rec.category_id)
              : undefined,
            is_active: rec.is_active,
          }))
        );
      }
    }

    return {
      period: { start_date, end_date },
      count: recurring.length,
      total_monthly_cost: roundAmount(totalMonthlyCost),
      recurring,
      ...(copilotSubscriptions && copilotSubscriptions.length > 0
        ? { copilot_subscriptions: copilotSubscriptions }
        : {}),
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

    const budgets = await this.db.getBudgets(active_only);

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
    goals: Array<{
      goal_id: string;
      name?: string;
      emoji?: string;
      target_amount?: number;
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

    // Calculate total target amount across all goals
    let totalTarget = 0;
    for (const goal of goals) {
      if (goal.savings?.target_amount) {
        totalTarget += goal.savings.target_amount;
      }
    }

    return {
      count: goals.length,
      total_target: roundAmount(totalTarget),
      goals: goals.map((g) => ({
        goal_id: g.goal_id,
        name: g.name,
        emoji: g.emoji,
        target_amount: g.savings?.target_amount,
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
   * Get goal progress and current status.
   *
   * Returns the current amount saved, progress percentage, and completion estimate
   * for one or all financial goals based on historical data.
   *
   * @param options - Filter options
   * @returns Object with goal progress details
   */
  async getGoalProgress(options: { goal_id?: string } = {}): Promise<{
    count: number;
    goals: Array<{
      goal_id: string;
      name?: string;
      emoji?: string;
      target_amount?: number;
      current_amount?: number;
      progress_percent?: number;
      monthly_contribution?: number;
      estimated_completion?: string;
      status?: string;
      latest_month?: string;
    }>;
  }> {
    const { goal_id } = options;

    // Get goals (all or filtered by goal_id)
    const goals = await this.db.getGoals(false);
    let filteredGoals = goals;

    if (goal_id) {
      filteredGoals = goals.filter((g) => g.goal_id === goal_id);
    }

    // Get history for each goal to calculate progress
    const progressData = await Promise.all(
      filteredGoals.map(async (goal) => {
        // Get latest history for this goal
        const history = await this.db.getGoalHistory(goal.goal_id, { limit: 12 }); // Last 12 months

        let currentAmount: number | undefined;
        let latestMonth: string | undefined;
        let averageMonthlyContribution: number | undefined;

        if (history.length > 0) {
          // Get latest month's current_amount
          const latestHistory = history[0];
          if (latestHistory) {
            currentAmount = latestHistory.current_amount;
            latestMonth = latestHistory.month;
          }

          // Calculate average monthly contribution from history
          if (history.length >= 2) {
            const amounts = history.map((h) => ({ month: h.month, amount: h.current_amount ?? 0 }));
            // Sort by month ascending to calculate differences
            amounts.sort((a, b) => a.month.localeCompare(b.month));

            const contributions: number[] = [];
            for (let i = 1; i < amounts.length; i++) {
              const current = amounts[i];
              const previous = amounts[i - 1];
              if (current && previous) {
                contributions.push(current.amount - previous.amount);
              }
            }

            if (contributions.length > 0) {
              averageMonthlyContribution =
                contributions.reduce((sum, c) => sum + c, 0) / contributions.length;
            }
          }
        }

        // Calculate progress percentage
        const targetAmount = goal.savings?.target_amount;
        let progressPercent: number | undefined;
        if (targetAmount && currentAmount !== undefined) {
          progressPercent = Math.min(100, (currentAmount / targetAmount) * 100);
        }

        // Estimate completion date
        let estimatedCompletion: string | undefined;
        if (currentAmount !== undefined && averageMonthlyContribution !== undefined) {
          estimatedCompletion = estimateGoalCompletion(
            goal,
            currentAmount,
            averageMonthlyContribution
          );
        }

        return {
          goal_id: goal.goal_id,
          name: goal.name,
          emoji: goal.emoji,
          target_amount: targetAmount,
          current_amount: currentAmount,
          progress_percent: progressPercent ? roundAmount(progressPercent) : undefined,
          monthly_contribution: goal.savings?.tracking_type_monthly_contribution,
          estimated_completion: estimatedCompletion,
          status: goal.savings?.status,
          latest_month: latestMonth,
        };
      })
    );

    return {
      count: progressData.length,
      goals: progressData,
    };
  }

  /**
   * Get goal history (monthly snapshots).
   *
   * Returns historical snapshots of goal progress including monthly amounts,
   * daily data, and contribution tracking.
   *
   * @param options - Filter options
   * @returns Object with historical goal data
   */
  async getGoalHistory(options: {
    goal_id: string;
    start_month?: string;
    end_month?: string;
    limit?: number;
  }): Promise<{
    goal_id: string;
    goal_name?: string;
    count: number;
    history: Array<{
      month: string;
      current_amount?: number;
      target_amount?: number;
      progress_percent?: number;
      month_start_amount?: number;
      month_end_amount?: number;
      month_change_amount?: number;
      month_change_percent?: number;
      daily_snapshots_count?: number;
    }>;
  }> {
    const { goal_id, start_month, end_month, limit = 12 } = options;

    // Get the goal details
    const goals = await this.db.getGoals(false);
    const goal = goals.find((g) => g.goal_id === goal_id);

    // Get history for this goal
    const history = await this.db.getGoalHistory(goal_id, {
      startMonth: start_month,
      endMonth: end_month,
      limit,
    });

    // Process history entries
    const processedHistory = history.map((h: GoalHistory) => {
      const progressPercent = getHistoryProgress(h);
      const monthStats = getMonthStartEnd(h);
      const dailySnapshotsCount = h.daily_data ? Object.keys(h.daily_data).length : 0;

      return {
        month: h.month,
        current_amount: h.current_amount,
        target_amount: h.target_amount,
        progress_percent: progressPercent ? roundAmount(progressPercent) : undefined,
        month_start_amount: monthStats.start_amount,
        month_end_amount: monthStats.end_amount,
        month_change_amount: monthStats.change_amount
          ? roundAmount(monthStats.change_amount)
          : undefined,
        month_change_percent: monthStats.change_percent
          ? roundAmount(monthStats.change_percent)
          : undefined,
        daily_snapshots_count: dailySnapshotsCount,
      };
    });

    return {
      goal_id,
      goal_name: goal?.name,
      count: processedHistory.length,
      history: processedHistory,
    };
  }

  /**
   * Estimate goal completion date.
   *
   * Calculates estimated completion based on historical contribution rates
   * and remaining amount needed.
   *
   * @param options - Filter options
   * @returns Object with completion estimates for goals
   */
  async estimateGoalCompletion(options: { goal_id?: string } = {}): Promise<{
    count: number;
    goals: Array<{
      goal_id: string;
      name?: string;
      target_amount?: number;
      current_amount?: number;
      remaining_amount?: number;
      average_monthly_contribution?: number;
      estimated_months_remaining?: number;
      estimated_completion_month?: string;
      is_on_track?: boolean;
      status?: string;
    }>;
  }> {
    const { goal_id } = options;

    // Get goals (all or filtered)
    const goals = await this.db.getGoals(false);
    let filteredGoals = goals;

    if (goal_id) {
      filteredGoals = goals.filter((g) => g.goal_id === goal_id);
    }

    // Calculate estimates for each goal
    const estimates = await Promise.all(
      filteredGoals.map(async (goal) => {
        // Get history to calculate average contribution
        const history = await this.db.getGoalHistory(goal.goal_id, { limit: 12 });

        let currentAmount: number | undefined;
        let averageMonthlyContribution: number | undefined;

        if (history.length > 0) {
          const latestHistory = history[0];
          if (latestHistory) {
            currentAmount = latestHistory.current_amount;
          }

          // Calculate average contribution
          if (history.length >= 2) {
            const amounts = history
              .map((h) => ({ month: h.month, amount: h.current_amount ?? 0 }))
              .sort((a, b) => a.month.localeCompare(b.month));

            const contributions: number[] = [];
            for (let i = 1; i < amounts.length; i++) {
              const current = amounts[i];
              const previous = amounts[i - 1];
              if (current && previous) {
                contributions.push(current.amount - previous.amount);
              }
            }

            if (contributions.length > 0) {
              averageMonthlyContribution =
                contributions.reduce((sum, c) => sum + c, 0) / contributions.length;
            }
          }
        }

        const targetAmount = goal.savings?.target_amount;
        const remainingAmount =
          targetAmount && currentAmount !== undefined ? targetAmount - currentAmount : undefined;

        let estimatedMonthsRemaining: number | undefined;
        let estimatedCompletionMonth: string | undefined;
        let isOnTrack: boolean | undefined;

        if (
          remainingAmount !== undefined &&
          remainingAmount > 0 &&
          averageMonthlyContribution !== undefined &&
          averageMonthlyContribution > 0
        ) {
          estimatedMonthsRemaining = Math.ceil(remainingAmount / averageMonthlyContribution);

          // Calculate completion date
          const today = new Date();
          const targetDate = new Date(
            today.getFullYear(),
            today.getMonth() + estimatedMonthsRemaining,
            1
          );
          estimatedCompletionMonth = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}`;

          // Check if on track (compare with expected monthly contribution)
          const expectedContribution = goal.savings?.tracking_type_monthly_contribution;
          if (expectedContribution) {
            isOnTrack = averageMonthlyContribution >= expectedContribution * 0.9; // 90% threshold
          }
        }

        return {
          goal_id: goal.goal_id,
          name: goal.name,
          target_amount: targetAmount,
          current_amount: currentAmount,
          remaining_amount: remainingAmount ? roundAmount(remainingAmount) : undefined,
          average_monthly_contribution: averageMonthlyContribution
            ? roundAmount(averageMonthlyContribution)
            : undefined,
          estimated_months_remaining: estimatedMonthsRemaining,
          estimated_completion_month: estimatedCompletionMonth,
          is_on_track: isOnTrack,
          status: goal.savings?.status,
        };
      })
    );

    return {
      count: estimates.length,
      goals: estimates,
    };
  }

  /**
   * Get goal contributions breakdown.
   *
   * Analyzes contribution patterns and provides insights into deposits,
   * withdrawals, and contribution consistency.
   *
   * @param options - Filter options
   * @returns Object with contribution analysis
   */
  async getGoalContributions(options: {
    goal_id: string;
    start_month?: string;
    end_month?: string;
    limit?: number;
  }): Promise<{
    goal_id: string;
    goal_name?: string;
    period: { start_month?: string; end_month?: string };
    total_contributed: number;
    total_withdrawn: number;
    net_contribution: number;
    average_monthly_contribution: number;
    months_analyzed: number;
    monthly_breakdown: Array<{
      month: string;
      current_amount?: number;
      month_change: number;
      deposits?: number;
      withdrawals?: number;
      net: number;
    }>;
  }> {
    const { goal_id, start_month, end_month, limit = 12 } = options;

    // Get goal details
    const goals = await this.db.getGoals(false);
    const goal = goals.find((g) => g.goal_id === goal_id);

    // Get history
    const history = await this.db.getGoalHistory(goal_id, {
      startMonth: start_month,
      endMonth: end_month,
      limit,
    });

    // Sort by month ascending for analysis
    const sortedHistory = [...history].sort((a, b) => a.month.localeCompare(b.month));

    let totalContributed = 0;
    let totalWithdrawn = 0;

    // Calculate monthly changes
    const monthlyBreakdown = sortedHistory.map((h, index) => {
      const currentAmount = h.current_amount ?? 0;
      const prevAmount = index > 0 ? (sortedHistory[index - 1]?.current_amount ?? 0) : 0;
      const monthChange = currentAmount - prevAmount;

      // Track contributions vs withdrawals
      if (monthChange > 0) {
        totalContributed += monthChange;
      } else if (monthChange < 0) {
        totalWithdrawn += Math.abs(monthChange);
      }

      return {
        month: h.month,
        current_amount: h.current_amount,
        month_change: roundAmount(monthChange),
        deposits: monthChange > 0 ? roundAmount(monthChange) : undefined,
        withdrawals: monthChange < 0 ? roundAmount(Math.abs(monthChange)) : undefined,
        net: roundAmount(monthChange),
      };
    });

    const netContribution = totalContributed - totalWithdrawn;
    const averageMonthlyContribution =
      monthlyBreakdown.length > 1 ? netContribution / (monthlyBreakdown.length - 1) : 0;

    return {
      goal_id,
      goal_name: goal?.name,
      period: {
        start_month: sortedHistory[0]?.month,
        end_month: sortedHistory[sortedHistory.length - 1]?.month,
      },
      total_contributed: roundAmount(totalContributed),
      total_withdrawn: roundAmount(totalWithdrawn),
      net_contribution: roundAmount(netContribution),
      average_monthly_contribution: roundAmount(averageMonthlyContribution),
      months_analyzed: monthlyBreakdown.length,
      monthly_breakdown: monthlyBreakdown,
    };
  }

  /**
   * Get income transactions (negative amounts or income categories).
   *
   * Copilot Money format:
   * - Positive amounts = expenses (money going OUT)
   * - Negative amounts = income/credits (money coming IN)
   *
   * @param options - Filter options
   * @returns Object with income breakdown
   */
  async getIncome(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    refund_threshold?: number;
  }): Promise<{
    period: { start_date?: string; end_date?: string };
    total_income: number;
    transaction_count: number;
    income_by_source: Array<{
      source: string;
      category_name?: string;
      total: number;
      count: number;
    }>;
    transactions: Array<Transaction & { category_name?: string }>;
  }> {
    const { period, refund_threshold = DEFAULT_REFUND_THRESHOLD } = options;
    let { start_date, end_date } = options;

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Get all transactions in the period
    const allTransactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    // Filter for income (negative amounts or income categories) - Copilot Money format
    // But exclude transfers, credit card payments, and likely refunds
    const incomeTransactions = allTransactions.filter((txn) => {
      // Exclude transfers and credit card payments
      if (isTransferCategory(txn.category_id)) {
        return false;
      }

      const merchant = getTransactionDisplayName(txn).toUpperCase();

      // Exclude internal transfers and credit card payments by merchant name
      if (
        merchant.includes('CREDIT CARD') ||
        merchant.includes('AUTOPAY') ||
        merchant.includes('PAYMENT') ||
        merchant.includes('TRANSFER') ||
        merchant.includes('CHASE CREDIT') ||
        merchant.includes('AMEX') ||
        merchant.includes('AMERICAN EXPRESS')
      ) {
        return false;
      }

      // Include if it's a known income category
      if (isIncomeCategory(txn.category_id)) {
        return true;
      }

      // Include negative amounts (income/credits in Copilot format) but try to exclude obvious refunds
      // Refunds are often small negative amounts from retail merchants
      if (txn.amount < 0) {
        // Exclude small refunds from common merchants (likely just refunds, not income)
        const isLikelyRefund =
          (merchant.includes('AMAZON') ||
            merchant.includes('UBER') ||
            merchant.includes('TARGET') ||
            merchant.includes('WALMART') ||
            merchant.includes('STARBUCKS') ||
            merchant.includes('NETFLIX') ||
            merchant.includes('SPOTIFY') ||
            merchant.includes('APPLE.COM') ||
            merchant.includes('GOOGLE')) &&
          Math.abs(txn.amount) < refund_threshold; // Small negative amounts from these merchants are likely refunds

        return !isLikelyRefund;
      }

      return false;
    });

    // Group by source (merchant name)
    const sourceMap = new Map<string, { total: number; count: number; categoryId?: string }>();

    for (const txn of incomeTransactions) {
      const source = getTransactionDisplayName(txn);
      const existing = sourceMap.get(source) || {
        total: 0,
        count: 0,
        categoryId: txn.category_id,
      };
      existing.total += Math.abs(txn.amount);
      existing.count++;
      sourceMap.set(source, existing);
    }

    // Convert to sorted list
    const incomeBySource = (
      await Promise.all(
        Array.from(sourceMap.entries()).map(async ([source, data]) => ({
          source,
          category_name: data.categoryId
            ? await this.resolveCategoryName(data.categoryId)
            : undefined,
          total: roundAmount(data.total),
          count: data.count,
        }))
      )
    ).sort((a, b) => b.total - a.total);

    // Calculate total
    const totalIncome = incomeBySource.reduce((sum, s) => sum + s.total, 0);

    // Enrich transactions with category names
    const enrichedTransactions = await Promise.all(
      incomeTransactions.slice(0, 100).map(async (txn) => ({
        ...txn,
        category_name: txn.category_id
          ? await this.resolveCategoryName(txn.category_id)
          : undefined,
      }))
    );

    return {
      period: { start_date, end_date },
      total_income: roundAmount(totalIncome),
      transaction_count: incomeTransactions.length,
      income_by_source: incomeBySource,
      transactions: enrichedTransactions,
    };
  }

  /**
   * Get spending aggregated by merchant.
   *
   * @param options - Filter options
   * @returns Object with spending breakdown by merchant
   */
  async getSpendingByMerchant(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
    exclude_transfers?: boolean;
  }): Promise<{
    period: { start_date?: string; end_date?: string };
    total_spending: number;
    merchant_count: number;
    merchants: Array<{
      merchant: string;
      category_name?: string;
      total_spending: number;
      transaction_count: number;
      average_transaction: number;
    }>;
  }> {
    const { period, limit = 50, exclude_transfers = false } = options;
    let { start_date, end_date } = options;

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Get transactions with filters
    let transactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    // Filter out transfers if requested (check both category and internal_transfer flag)
    if (exclude_transfers) {
      transactions = transactions.filter(
        (txn) => !isTransferCategory(txn.category_id) && !txn.internal_transfer
      );
    }

    // Aggregate by merchant (always exclude internal transfers from spending)
    // Expenses are positive amounts in Copilot Money format
    const merchantSpending = new Map<
      string,
      { total: number; count: number; categoryId?: string }
    >();

    for (const txn of transactions) {
      // Only count positive amounts (expenses in Copilot format), skip internal transfers
      if (txn.amount <= 0 || txn.internal_transfer) continue;

      const merchantName = getTransactionDisplayName(txn);
      const existing = merchantSpending.get(merchantName) || {
        total: 0,
        count: 0,
        categoryId: txn.category_id,
      };
      existing.total += Math.abs(txn.amount);
      existing.count++;
      merchantSpending.set(merchantName, existing);
    }

    // Convert to list, sorted by spending
    const merchants = (
      await Promise.all(
        Array.from(merchantSpending.entries()).map(async ([merchant, data]) => ({
          merchant,
          category_name: data.categoryId
            ? await this.resolveCategoryName(data.categoryId)
            : undefined,
          total_spending: roundAmount(data.total),
          transaction_count: data.count,
          average_transaction: roundAmount(data.total / data.count),
        }))
      )
    )
      .sort((a, b) => b.total_spending - a.total_spending)
      .slice(0, limit);

    // Calculate totals
    const totalSpending = merchants.reduce((sum, m) => sum + m.total_spending, 0);

    return {
      period: { start_date, end_date },
      total_spending: roundAmount(totalSpending),
      merchant_count: merchantSpending.size,
      merchants,
    };
  }

  /**
   * Get foreign transactions (international purchases or transactions with FX fees).
   *
   * @param options - Filter options
   * @returns Object with foreign transactions and total FX fees
   */
  async getForeignTransactions(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
  }): Promise<{
    period: { start_date?: string; end_date?: string };
    count: number;
    total_amount: number;
    total_fx_fees: number;
    countries: Array<{ country: string; transaction_count: number; total_amount: number }>;
    transactions: Array<Transaction & { category_name?: string; normalized_merchant?: string }>;
  }> {
    const { period, limit = 100 } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    const allTransactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    // Find foreign transactions:
    // 1. Transactions with country != US
    // 2. Transactions with foreign transaction fee category
    // 3. Transactions with non-USD currency
    // 4. Transactions with foreign city/country indicators in merchant name
    const foreignTxns = allTransactions.filter((txn) => {
      const isForeignCountry =
        txn.country && txn.country.toUpperCase() !== 'US' && txn.country.toUpperCase() !== 'USA';
      const isForeignFeeCategory =
        txn.category_id === CATEGORY_FOREIGN_TX_FEE_SNAKE ||
        txn.category_id === CATEGORY_FOREIGN_TX_FEE_NUMERIC;
      const isForeignCurrency =
        txn.iso_currency_code && txn.iso_currency_code.toUpperCase() !== 'USD';

      // Check merchant name for foreign indicators
      const merchant = getTransactionDisplayName(txn).toUpperCase();
      const hasForeignCityIndicator =
        merchant.includes('SANTIAGO') ||
        merchant.includes('VALPARAISO') ||
        merchant.includes('LONDON') ||
        merchant.includes('PARIS') ||
        merchant.includes('TOKYO') ||
        merchant.includes('MEXICO CITY') ||
        merchant.includes('BARCELONA') ||
        merchant.includes('MADRID') ||
        merchant.includes('ROME') ||
        merchant.includes('BERLIN') ||
        merchant.includes('AMSTERDAM') ||
        merchant.includes('TORONTO') ||
        merchant.includes('VANCOUVER') ||
        merchant.includes('MONTREAL');

      // Check for country codes in merchant name (e.g., " CL ", " GB ", " MX ")
      const hasCountryCode =
        / CL /.test(merchant) || // Chile
        / GB /.test(merchant) || // UK
        / UK /.test(merchant) ||
        / MX /.test(merchant) || // Mexico
        / FR /.test(merchant) || // France
        / DE /.test(merchant) || // Germany
        / IT /.test(merchant) || // Italy
        / ES /.test(merchant) || // Spain
        / JP /.test(merchant) || // Japan
        / CA /.test(merchant); // Canada

      // Check region field for non-US regions
      const isForeignRegion =
        txn.region &&
        ![
          'AL',
          'AK',
          'AZ',
          'AR',
          'CA',
          'CO',
          'CT',
          'DE',
          'FL',
          'GA',
          'HI',
          'ID',
          'IL',
          'IN',
          'IA',
          'KS',
          'KY',
          'LA',
          'ME',
          'MD',
          'MA',
          'MI',
          'MN',
          'MS',
          'MO',
          'MT',
          'NE',
          'NV',
          'NH',
          'NJ',
          'NM',
          'NY',
          'NC',
          'ND',
          'OH',
          'OK',
          'OR',
          'PA',
          'RI',
          'SC',
          'SD',
          'TN',
          'TX',
          'UT',
          'VT',
          'VA',
          'WA',
          'WV',
          'WI',
          'WY',
          'DC',
        ].includes(txn.region.toUpperCase());

      return (
        isForeignCountry ||
        isForeignFeeCategory ||
        isForeignCurrency ||
        hasForeignCityIndicator ||
        hasCountryCode ||
        isForeignRegion
      );
    });

    // Calculate FX fees separately
    const fxFees = allTransactions.filter(
      (txn) =>
        txn.category_id === CATEGORY_FOREIGN_TX_FEE_SNAKE ||
        txn.category_id === CATEGORY_FOREIGN_TX_FEE_NUMERIC
    );
    const totalFxFees = fxFees.reduce((sum, txn) => sum + Math.abs(txn.amount), 0);

    // Aggregate by country
    const countryMap = new Map<string, { count: number; total: number }>();
    for (const txn of foreignTxns) {
      const country = txn.country || 'Unknown';
      const existing = countryMap.get(country) || { count: 0, total: 0 };
      existing.count++;
      existing.total += Math.abs(txn.amount);
      countryMap.set(country, existing);
    }

    const countries = Array.from(countryMap.entries())
      .map(([country, data]) => ({
        country,
        transaction_count: data.count,
        total_amount: roundAmount(data.total),
      }))
      .sort((a, b) => b.total_amount - a.total_amount);

    const totalAmount = foreignTxns.reduce((sum, txn) => sum + Math.abs(txn.amount), 0);

    const enrichedTransactions = await Promise.all(
      foreignTxns.slice(0, limit).map(async (txn) => ({
        ...txn,
        category_name: txn.category_id
          ? await this.resolveCategoryName(txn.category_id)
          : undefined,
        normalized_merchant: normalizeMerchantName(getTransactionDisplayName(txn)),
      }))
    );

    return {
      period: { start_date, end_date },
      count: foreignTxns.length,
      total_amount: roundAmount(totalAmount),
      total_fx_fees: roundAmount(totalFxFees),
      countries,
      transactions: enrichedTransactions,
    };
  }

  /**
   * Get refund transactions (negative amounts that are returns/refunds).
   *
   * @param options - Filter options
   * @returns Object with refund transactions
   */
  async getRefunds(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
  }): Promise<{
    period: { start_date?: string; end_date?: string };
    count: number;
    total_refunded: number;
    refunds_by_merchant: Array<{ merchant: string; refund_count: number; total_refunded: number }>;
    transactions: Array<Transaction & { category_name?: string }>;
  }> {
    const { period, limit = 100 } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    const allTransactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    // Refunds are negative amounts (credits/money coming back) in Copilot format
    const refundTxns = allTransactions.filter((txn) => {
      if (txn.amount >= 0) return false; // Must be a credit (negative = money in, in Copilot format)
      if (isTransferCategory(txn.category_id)) return false;
      if (isIncomeCategory(txn.category_id)) return false;

      // Check for refund-related merchant names or categories
      const name = getTransactionDisplayName(txn).toLowerCase();
      const isRefundName =
        name.includes('refund') ||
        name.includes('return') ||
        name.includes('credit') ||
        name.includes('reversal');
      const isRefundCategory = txn.category_id?.toLowerCase().includes('refund');

      // Include only if it has refund-related keywords in name or category
      return isRefundName || isRefundCategory;
    });

    // Aggregate by merchant
    const merchantMap = new Map<string, { count: number; total: number }>();
    for (const txn of refundTxns) {
      const merchant = getTransactionDisplayName(txn);
      const existing = merchantMap.get(merchant) || { count: 0, total: 0 };
      existing.count++;
      existing.total += Math.abs(txn.amount);
      merchantMap.set(merchant, existing);
    }

    const refundsByMerchant = Array.from(merchantMap.entries())
      .map(([merchant, data]) => ({
        merchant,
        refund_count: data.count,
        total_refunded: roundAmount(data.total),
      }))
      .sort((a, b) => b.total_refunded - a.total_refunded);

    const totalRefunded = refundTxns.reduce((sum, txn) => sum + Math.abs(txn.amount), 0);

    const enrichedTransactions = await Promise.all(
      refundTxns.slice(0, limit).map(async (txn) => ({
        ...txn,
        category_name: txn.category_id
          ? await this.resolveCategoryName(txn.category_id)
          : undefined,
      }))
    );

    return {
      period: { start_date, end_date },
      count: refundTxns.length,
      total_refunded: roundAmount(totalRefunded),
      refunds_by_merchant: refundsByMerchant,
      transactions: enrichedTransactions,
    };
  }

  /**
   * Detect potential duplicate transactions.
   *
   * @param options - Filter options
   * @returns Object with potential duplicates grouped
   */
  async getDuplicateTransactions(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
  }): Promise<{
    period: { start_date?: string; end_date?: string };
    duplicate_groups_count: number;
    total_potential_duplicates: number;
    duplicate_groups: Array<{
      group_key: string;
      transaction_count: number;
      dates: string[];
      amounts: number[];
      accounts: string[];
      transactions: Array<{
        transaction_id: string;
        date: string;
        amount: number;
        account_id?: string;
      }>;
    }>;
  }> {
    const { period } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    const allTransactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    // Group by: same merchant + same amount + same date (or within 1 day)
    const potentialDuplicates = new Map<string, Transaction[]>();

    for (const txn of allTransactions) {
      const merchant = getTransactionDisplayName(txn);
      const amount = roundAmount(txn.amount);
      const key = `${merchant}|${amount}|${txn.date}`;

      const existing = potentialDuplicates.get(key) || [];
      existing.push(txn);
      potentialDuplicates.set(key, existing);
    }

    // Also check for same transaction_id with different data
    const byTxnId = new Map<string, Transaction[]>();
    for (const txn of allTransactions) {
      const existing = byTxnId.get(txn.transaction_id) || [];
      existing.push(txn);
      byTxnId.set(txn.transaction_id, existing);
    }

    // Merge duplicate groups
    const duplicateGroups: Array<{
      group_key: string;
      transaction_count: number;
      dates: string[];
      amounts: number[];
      accounts: string[];
      transactions: Array<{
        transaction_id: string;
        date: string;
        amount: number;
        account_id?: string;
      }>;
    }> = [];

    // Add merchant+amount+date duplicates
    for (const [key, txns] of potentialDuplicates) {
      if (txns.length > 1) {
        duplicateGroups.push({
          group_key: key,
          transaction_count: txns.length,
          dates: [...new Set(txns.map((t) => t.date))],
          amounts: [...new Set(txns.map((t) => t.amount))],
          accounts: [...new Set(txns.map((t) => t.account_id).filter(Boolean) as string[])],
          transactions: txns.map((t) => ({
            transaction_id: t.transaction_id,
            date: t.date,
            amount: t.amount,
            account_id: t.account_id,
          })),
        });
      }
    }

    // Add same transaction_id duplicates
    for (const [txnId, txns] of byTxnId) {
      if (txns.length > 1) {
        const key = `same_id:${txnId}`;
        // Check if not already included
        if (!duplicateGroups.some((g) => g.group_key === key)) {
          duplicateGroups.push({
            group_key: key,
            transaction_count: txns.length,
            dates: [...new Set(txns.map((t) => t.date))],
            amounts: [...new Set(txns.map((t) => t.amount))],
            accounts: [...new Set(txns.map((t) => t.account_id).filter(Boolean) as string[])],
            transactions: txns.map((t) => ({
              transaction_id: t.transaction_id,
              date: t.date,
              amount: t.amount,
              account_id: t.account_id,
            })),
          });
        }
      }
    }

    // Sort by transaction count
    duplicateGroups.sort((a, b) => b.transaction_count - a.transaction_count);

    const totalDuplicates = duplicateGroups.reduce((sum, g) => sum + g.transaction_count, 0);

    return {
      period: { start_date, end_date },
      duplicate_groups_count: duplicateGroups.length,
      total_potential_duplicates: totalDuplicates,
      duplicate_groups: duplicateGroups.slice(0, 50), // Limit to 50 groups
    };
  }

  /**
   * Get credits/statement credits (Amex credits, cashback, etc.).
   *
   * @param options - Filter options
   * @returns Object with credit transactions
   */
  async getCredits(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
  }): Promise<{
    period: { start_date?: string; end_date?: string };
    count: number;
    total_credits: number;
    credits_by_type: Array<{ type: string; count: number; total: number }>;
    transactions: Array<Transaction & { category_name?: string; credit_type?: string }>;
  }> {
    const { period, limit = 100 } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    const allTransactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    // Keywords that indicate statement credits (positive amounts with these keywords)
    const creditKeywords = [
      'credit',
      'cashback',
      'reward',
      'rebate',
      'bonus',
      'statement credit',
      'hotel credit',
      'entertainment credit',
      'uber credit',
      'airline credit',
      'digital entertainment',
    ];

    // Credits are negative amounts (money coming back) in Copilot format
    const creditTxns = allTransactions.filter((txn) => {
      if (txn.amount >= 0) return false; // Must be negative (credit = money coming in, in Copilot format)
      if (isTransferCategory(txn.category_id)) return false;
      if (isIncomeCategory(txn.category_id)) return false;

      const name = getTransactionDisplayName(txn).toLowerCase();
      return creditKeywords.some((kw) => name.includes(kw));
    });

    // Categorize credit types
    const getCreditType = (txn: Transaction): string => {
      const name = getTransactionDisplayName(txn).toLowerCase();
      if (name.includes('hotel')) return 'Hotel Credit';
      if (name.includes('entertainment') || name.includes('streaming'))
        return 'Entertainment Credit';
      if (name.includes('airline') || name.includes('travel')) return 'Travel Credit';
      if (name.includes('uber')) return 'Uber Credit';
      if (name.includes('cashback')) return 'Cashback';
      if (name.includes('reward')) return 'Rewards';
      if (name.includes('statement')) return 'Statement Credit';
      return 'Other Credit';
    };

    // Aggregate by type
    const typeMap = new Map<string, { count: number; total: number }>();
    for (const txn of creditTxns) {
      const type = getCreditType(txn);
      const existing = typeMap.get(type) || { count: 0, total: 0 };
      existing.count++;
      existing.total += Math.abs(txn.amount);
      typeMap.set(type, existing);
    }

    const creditsByType = Array.from(typeMap.entries())
      .map(([type, data]) => ({
        type,
        count: data.count,
        total: roundAmount(data.total),
      }))
      .sort((a, b) => b.total - a.total);

    const totalCredits = creditTxns.reduce((sum, txn) => sum + Math.abs(txn.amount), 0);

    const enrichedTransactions = await Promise.all(
      creditTxns.slice(0, limit).map(async (txn) => ({
        ...txn,
        category_name: txn.category_id
          ? await this.resolveCategoryName(txn.category_id)
          : undefined,
        credit_type: getCreditType(txn),
      }))
    );

    return {
      period: { start_date, end_date },
      count: creditTxns.length,
      total_credits: roundAmount(totalCredits),
      credits_by_type: creditsByType,
      transactions: enrichedTransactions,
    };
  }

  /**
   * Get spending aggregated by day of week.
   *
   * @param options - Filter options
   * @returns Object with spending breakdown by day
   */
  async getSpendingByDayOfWeek(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    exclude_transfers?: boolean;
  }): Promise<{
    period: { start_date?: string; end_date?: string };
    total_spending: number;
    days: Array<{
      day: string;
      day_number: number;
      total_spending: number;
      transaction_count: number;
      average_transaction: number;
      percentage_of_total: number;
    }>;
  }> {
    const { period, exclude_transfers = false } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    let transactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    // Filter out transfers if requested (check both category and internal_transfer flag)
    if (exclude_transfers) {
      transactions = transactions.filter(
        (txn) => !isTransferCategory(txn.category_id) && !txn.internal_transfer
      );
    }

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayStats = new Map<number, { total: number; count: number }>();

    for (let i = 0; i < 7; i++) {
      dayStats.set(i, { total: 0, count: 0 });
    }

    for (const txn of transactions) {
      // Only count expenses, skip internal transfers
      if (txn.amount <= 0 || txn.internal_transfer) continue;
      const dayOfWeek = new Date(txn.date + 'T12:00:00').getDay();
      const stats = dayStats.get(dayOfWeek);
      if (!stats) continue;
      stats.total += txn.amount;
      stats.count++;
    }

    const totalSpending = Array.from(dayStats.values()).reduce((sum, s) => sum + s.total, 0);

    const days = Array.from(dayStats.entries())
      .map(([dayNum, stats]) => ({
        day: dayNames[dayNum] ?? 'Unknown',
        day_number: dayNum,
        total_spending: roundAmount(stats.total),
        transaction_count: stats.count,
        average_transaction: stats.count > 0 ? roundAmount(stats.total / stats.count) : 0,
        percentage_of_total:
          totalSpending > 0 ? roundAmount((stats.total / totalSpending) * 100) : 0,
      }))
      .sort((a, b) => a.day_number - b.day_number);

    return {
      period: { start_date, end_date },
      total_spending: roundAmount(totalSpending),
      days,
    };
  }

  /**
   * Detect and group transactions into trips.
   *
   * @param options - Filter options
   * @returns Object with detected trips
   */
  async getTrips(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    min_days?: number;
  }): Promise<{
    period: { start_date?: string; end_date?: string };
    trip_count: number;
    trips: Array<{
      location: string;
      country?: string;
      start_date: string;
      end_date: string;
      duration_days: number;
      total_spent: number;
      transaction_count: number;
      categories: Array<{ category: string; total: number }>;
    }>;
  }> {
    const { period, min_days = 2 } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    const allTransactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    // Find transactions in foreign countries or travel-related categories
    const travelTxns = allTransactions.filter((txn) => {
      const isForeignCountry =
        txn.country && txn.country.toUpperCase() !== 'US' && txn.country.toUpperCase() !== 'USA';
      const isTravelCategory =
        txn.category_id?.toLowerCase().includes('travel') || txn.category_id?.startsWith('22'); // Travel numeric category
      return isForeignCountry || isTravelCategory;
    });

    // Group by location and date proximity
    const trips: Array<{
      location: string;
      country?: string;
      start_date: string;
      end_date: string;
      duration_days: number;
      total_spent: number;
      transaction_count: number;
      categories: Array<{ category: string; total: number }>;
    }> = [];

    // Helper function to extract location from transaction
    const extractLocation = (txn: Transaction): { country: string; city?: string } => {
      // Try explicit country field first
      if (txn.country && txn.country.toUpperCase() !== 'US') {
        return { country: txn.country, city: txn.city };
      }

      // Parse from merchant name
      const merchant = getTransactionDisplayName(txn).toUpperCase();

      // Common foreign cities
      if (merchant.includes('SANTIAGO')) return { country: 'CL', city: 'Santiago' };
      if (merchant.includes('VALPARAISO')) return { country: 'CL', city: 'Valparaiso' };
      if (merchant.includes('LONDON')) return { country: 'GB', city: 'London' };
      if (merchant.includes('PARIS')) return { country: 'FR', city: 'Paris' };
      if (merchant.includes('TOKYO')) return { country: 'JP', city: 'Tokyo' };
      if (merchant.includes('BARCELONA')) return { country: 'ES', city: 'Barcelona' };
      if (merchant.includes('MADRID')) return { country: 'ES', city: 'Madrid' };
      if (merchant.includes('ROME')) return { country: 'IT', city: 'Rome' };
      if (merchant.includes('BERLIN')) return { country: 'DE', city: 'Berlin' };

      // Check for country codes
      if (/ CL /.test(merchant)) return { country: 'CL', city: txn.city };
      if (/ GB /.test(merchant) || / UK /.test(merchant)) return { country: 'GB', city: txn.city };
      if (/ MX /.test(merchant)) return { country: 'MX', city: txn.city };
      if (/ FR /.test(merchant)) return { country: 'FR', city: txn.city };
      if (/ DE /.test(merchant)) return { country: 'DE', city: txn.city };
      if (/ IT /.test(merchant)) return { country: 'IT', city: txn.city };
      if (/ ES /.test(merchant)) return { country: 'ES', city: txn.city };
      if (/ JP /.test(merchant)) return { country: 'JP', city: txn.city };
      if (/ CA /.test(merchant)) return { country: 'CA', city: txn.city };

      return { country: 'Unknown', city: txn.city };
    };

    // Group transactions by country
    const byCountry = new Map<string, Array<Transaction & { inferred_city?: string }>>();
    for (const txn of travelTxns) {
      const location = extractLocation(txn);
      const existing = byCountry.get(location.country) || [];
      existing.push({ ...txn, inferred_city: location.city });
      byCountry.set(location.country, existing);
    }

    // For each country, find contiguous date ranges
    for (const [country, txns] of byCountry) {
      if (country === 'US' || country === 'USA') continue;

      // Sort by date
      const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));
      const firstTxn = sorted[0];
      if (!firstTxn) continue;

      // Find contiguous ranges (transactions within 3 days of each other)
      let tripStart: Transaction = firstTxn;
      let tripEnd: Transaction = firstTxn;
      let tripTxns: Transaction[] = [firstTxn];

      for (let i = 1; i < sorted.length; i++) {
        const current = sorted[i];
        if (!current || !tripEnd) continue;
        const prevDate = new Date(tripEnd.date);
        const currDate = new Date(current.date);
        const daysDiff = (currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24);

        if (daysDiff <= 3) {
          // Same trip
          tripEnd = current;
          tripTxns.push(current);
        } else {
          // New trip - save previous if long enough
          if (tripStart && tripEnd) {
            const duration =
              Math.ceil(
                (new Date(tripEnd.date).getTime() - new Date(tripStart.date).getTime()) /
                  (1000 * 60 * 60 * 24)
              ) + 1;
            if (duration >= min_days) {
              const categoryTotals = new Map<string, number>();
              let totalSpent = 0;
              // Expenses are positive amounts in Copilot Money format
              for (const t of tripTxns) {
                if (t.amount > 0) {
                  totalSpent += Math.abs(t.amount);
                  const cat = await this.resolveCategoryName(getCategoryIdOrDefault(t.category_id));
                  categoryTotals.set(cat, (categoryTotals.get(cat) || 0) + Math.abs(t.amount));
                }
              }

              // Collect all cities mentioned in trip
              const cities = tripTxns
                .map(
                  (t) =>
                    (t as (typeof tripTxns)[0] & { inferred_city?: string }).inferred_city || t.city
                )
                .filter(Boolean);
              const uniqueCities = [...new Set(cities)];
              const locationStr = uniqueCities.length > 0 ? uniqueCities.join(', ') : country;

              trips.push({
                location: locationStr,
                country,
                start_date: tripStart.date,
                end_date: tripEnd.date,
                duration_days: duration,
                total_spent: roundAmount(totalSpent),
                transaction_count: tripTxns.length,
                categories: Array.from(categoryTotals.entries())
                  .map(([category, total]) => ({ category, total: roundAmount(total) }))
                  .sort((a, b) => b.total - a.total),
              });
            }
          }
          // Start new trip
          tripStart = current;
          tripEnd = current;
          tripTxns = [current];
        }
      }

      // Don't forget the last trip
      if (tripStart && tripEnd) {
        const duration =
          Math.ceil(
            (new Date(tripEnd.date).getTime() - new Date(tripStart.date).getTime()) /
              (1000 * 60 * 60 * 24)
          ) + 1;
        if (duration >= min_days) {
          const categoryTotals = new Map<string, number>();
          let totalSpent = 0;
          // Expenses are positive amounts in Copilot Money format
          for (const t of tripTxns) {
            if (t.amount > 0) {
              totalSpent += Math.abs(t.amount);
              const cat = await this.resolveCategoryName(getCategoryIdOrDefault(t.category_id));
              categoryTotals.set(cat, (categoryTotals.get(cat) || 0) + Math.abs(t.amount));
            }
          }

          // Collect all cities mentioned in trip
          const cities = tripTxns
            .map(
              (t) =>
                (t as (typeof tripTxns)[0] & { inferred_city?: string }).inferred_city || t.city
            )
            .filter(Boolean);
          const uniqueCities = [...new Set(cities)];
          const locationStr = uniqueCities.length > 0 ? uniqueCities.join(', ') : country;

          trips.push({
            location: locationStr,
            country,
            start_date: tripStart.date,
            end_date: tripEnd.date,
            duration_days: duration,
            total_spent: roundAmount(totalSpent),
            transaction_count: tripTxns.length,
            categories: Array.from(categoryTotals.entries())
              .map(([category, total]) => ({ category, total: roundAmount(total) }))
              .sort((a, b) => b.total - a.total),
          });
        }
      }
    }

    // Sort by start date descending
    trips.sort((a, b) => b.start_date.localeCompare(a.start_date));

    return {
      period: { start_date, end_date },
      trip_count: trips.length,
      trips,
    };
  }

  /**
   * Get a single transaction by ID.
   *
   * @param transactionId - Transaction ID
   * @returns Transaction details
   */
  async getTransactionById(transactionId: string): Promise<{
    found: boolean;
    transaction?: Transaction & { category_name?: string; normalized_merchant?: string };
  }> {
    const allTransactions = await this.db.getAllTransactions();
    const txn = allTransactions.find((t) => t.transaction_id === transactionId);

    if (!txn) {
      return { found: false };
    }

    return {
      found: true,
      transaction: {
        ...txn,
        category_name: txn.category_id
          ? await this.resolveCategoryName(txn.category_id)
          : undefined,
        normalized_merchant: normalizeMerchantName(getTransactionDisplayName(txn)),
      },
    };
  }

  /**
   * Get top merchants by spending.
   *
   * @param options - Filter options
   * @returns Object with top merchants
   */
  async getTopMerchants(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
    exclude_transfers?: boolean;
  }): Promise<{
    period: { start_date?: string; end_date?: string };
    merchants: Array<{
      rank: number;
      merchant: string;
      normalized_name: string;
      total_spent: number;
      transaction_count: number;
      average_transaction: number;
      first_transaction: string;
      last_transaction: string;
      category_name?: string;
    }>;
  }> {
    const { period, limit = 20, exclude_transfers = false } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    let transactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    // Filter out transfers if requested (check both category and internal_transfer flag)
    if (exclude_transfers) {
      transactions = transactions.filter(
        (txn) => !isTransferCategory(txn.category_id) && !txn.internal_transfer
      );
    }

    const merchantStats = new Map<
      string,
      {
        total: number;
        count: number;
        firstDate: string;
        lastDate: string;
        categoryId?: string;
      }
    >();

    for (const txn of transactions) {
      // Only count expenses, skip internal transfers
      if (txn.amount <= 0 || txn.internal_transfer) continue;
      const merchant = getTransactionDisplayName(txn);
      const existing = merchantStats.get(merchant) || {
        total: 0,
        count: 0,
        firstDate: txn.date,
        lastDate: txn.date,
        categoryId: txn.category_id,
      };
      existing.total += txn.amount;
      existing.count++;
      if (txn.date < existing.firstDate) existing.firstDate = txn.date;
      if (txn.date > existing.lastDate) existing.lastDate = txn.date;
      merchantStats.set(merchant, existing);
    }

    const merchantsRaw = await Promise.all(
      Array.from(merchantStats.entries()).map(async ([merchant, stats]) => ({
        merchant,
        normalized_name: normalizeMerchantName(merchant),
        total_spent: roundAmount(stats.total),
        transaction_count: stats.count,
        average_transaction: roundAmount(stats.total / stats.count),
        first_transaction: stats.firstDate,
        last_transaction: stats.lastDate,
        category_name: stats.categoryId
          ? await this.resolveCategoryName(stats.categoryId)
          : undefined,
      }))
    );
    const merchants = merchantsRaw
      .sort((a, b) => b.total_spent - a.total_spent)
      .slice(0, limit)
      .map((m, i) => ({ rank: i + 1, ...m }));

    return {
      period: { start_date, end_date },
      merchants,
    };
  }

  /**
   * Detect unusual/anomalous transactions.
   *
   * @param options - Filter options
   * @returns Object with unusual transactions
   */
  async getUnusualTransactions(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    threshold_multiplier?: number;
    large_transaction_threshold?: number;
  }): Promise<{
    period: { start_date?: string; end_date?: string };
    count: number;
    transactions: Array<
      Transaction & {
        category_name?: string;
        anomaly_reason: string;
        expected_amount?: number;
        deviation_percent?: number;
      }
    >;
  }> {
    const {
      period,
      threshold_multiplier = 2,
      large_transaction_threshold = DEFAULT_LARGE_TRANSACTION_THRESHOLD,
    } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Get a longer history for baseline calculation
    const allTransactions = await this.db.getAllTransactions();
    const periodTransactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    // Calculate merchant averages
    const merchantAverages = new Map<string, { avg: number; stdDev: number; count: number }>();
    const merchantAmounts = new Map<string, number[]>();

    for (const txn of allTransactions) {
      if (txn.amount <= 0) continue;
      const merchant = getTransactionDisplayName(txn);
      const amounts = merchantAmounts.get(merchant) || [];
      amounts.push(txn.amount);
      merchantAmounts.set(merchant, amounts);
    }

    for (const [merchant, amounts] of merchantAmounts) {
      if (amounts.length < 3) continue; // Need enough data
      const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      const variance =
        amounts.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / amounts.length;
      const stdDev = Math.sqrt(variance);
      merchantAverages.set(merchant, { avg, stdDev, count: amounts.length });
    }

    // Calculate category averages
    const categoryAverages = new Map<string, { avg: number; stdDev: number }>();
    const categoryAmounts = new Map<string, number[]>();

    for (const txn of allTransactions) {
      if (txn.amount <= 0) continue;
      const category = getCategoryIdOrDefault(txn.category_id);
      const amounts = categoryAmounts.get(category) || [];
      amounts.push(txn.amount);
      categoryAmounts.set(category, amounts);
    }

    for (const [category, amounts] of categoryAmounts) {
      if (amounts.length < 3) continue;
      const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      const variance =
        amounts.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / amounts.length;
      const stdDev = Math.sqrt(variance);
      categoryAverages.set(category, { avg, stdDev });
    }

    // Find anomalies in period
    const anomalies: Array<
      Transaction & {
        category_name?: string;
        anomaly_reason: string;
        expected_amount?: number;
        deviation_percent?: number;
      }
    > = [];

    for (const txn of periodTransactions) {
      if (txn.amount <= 0) continue;

      const merchant = getTransactionDisplayName(txn);
      const merchantStats = merchantAverages.get(merchant);
      const category = getCategoryIdOrDefault(txn.category_id);
      const categoryStats = categoryAverages.get(category);

      let isAnomaly = false;
      let reason = '';
      let expected: number | undefined;
      let deviation: number | undefined;

      // Check against merchant average
      if (merchantStats && merchantStats.count >= 3) {
        const threshold = merchantStats.avg + threshold_multiplier * merchantStats.stdDev;
        if (txn.amount > threshold && merchantStats.stdDev > 0) {
          isAnomaly = true;
          expected = merchantStats.avg;
          deviation = Math.round(((txn.amount - merchantStats.avg) / merchantStats.avg) * 100);
          reason = `${Math.round(deviation)}% above average for ${merchant}`;
        }
      }

      // Check against category average if not already flagged
      if (!isAnomaly && categoryStats) {
        const threshold = categoryStats.avg + threshold_multiplier * categoryStats.stdDev;
        if (txn.amount > threshold && categoryStats.stdDev > 0) {
          isAnomaly = true;
          expected = categoryStats.avg;
          deviation = Math.round(((txn.amount - categoryStats.avg) / categoryStats.avg) * 100);
          reason = `${Math.round(deviation)}% above category average`;
        }
      }

      // Flag transactions based on amount thresholds (most severe first)
      if (!isAnomaly && txn.amount >= UNREALISTIC_AMOUNT_THRESHOLD) {
        isAnomaly = true;
        reason = `Unrealistic amount (>=$${UNREALISTIC_AMOUNT_THRESHOLD.toLocaleString()}) - likely data quality issue`;
      } else if (!isAnomaly && txn.amount >= EXTREMELY_LARGE_THRESHOLD) {
        isAnomaly = true;
        reason = `Extremely large transaction (>=$${EXTREMELY_LARGE_THRESHOLD.toLocaleString()}) - review for accuracy`;
      } else if (!isAnomaly && txn.amount >= LARGE_TRANSACTION_THRESHOLD) {
        isAnomaly = true;
        reason = `Large transaction (>=$${LARGE_TRANSACTION_THRESHOLD.toLocaleString()})`;
      } else if (!isAnomaly && txn.amount > large_transaction_threshold) {
        // User-configurable threshold for flagging smaller large transactions
        isAnomaly = true;
        reason = `Large transaction (>$${large_transaction_threshold})`;
      }

      if (isAnomaly) {
        anomalies.push({
          ...txn,
          category_name: txn.category_id
            ? await this.resolveCategoryName(txn.category_id)
            : undefined,
          anomaly_reason: reason,
          expected_amount: expected ? roundAmount(expected) : undefined,
          deviation_percent: deviation,
        });
      }
    }

    // Sort by deviation (most unusual first)
    anomalies.sort((a, b) => (b.deviation_percent || 0) - (a.deviation_percent || 0));

    return {
      period: { start_date, end_date },
      count: anomalies.length,
      transactions: anomalies.slice(0, 50),
    };
  }

  /**
   * Export transactions in various formats.
   *
   * @param options - Export options
   * @returns Formatted export data
   */
  async exportTransactions(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    format?: 'csv' | 'json';
    include_fields?: string[];
  }): Promise<{
    format: string;
    record_count: number;
    data: string;
  }> {
    const { period, format = 'csv', include_fields } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    const transactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    const defaultFields = ['date', 'amount', 'name', 'category_id', 'account_id', 'pending'];
    const fields = include_fields || defaultFields;

    // Enrich with category names
    const enriched = await Promise.all(
      transactions.map(async (txn) => ({
        ...txn,
        category_name: txn.category_id ? await this.resolveCategoryName(txn.category_id) : '',
        normalized_merchant: normalizeMerchantName(getTransactionDisplayName(txn)),
      }))
    );

    if (format === 'json') {
      const filteredData = enriched.map((txn) => {
        const result: Record<string, unknown> = {};
        for (const field of fields) {
          if (field in txn) {
            result[field] = (txn as Record<string, unknown>)[field];
          }
        }
        return result;
      });
      return {
        format: 'json',
        record_count: filteredData.length,
        data: JSON.stringify(filteredData, null, 2),
      };
    }

    // CSV format
    const allFields = [...fields, 'category_name', 'normalized_merchant'];
    const headers = allFields.join(',');
    const rows = enriched.map((txn) => {
      return allFields
        .map((field) => {
          const value = (txn as Record<string, unknown>)[field];
          if (value === undefined || value === null) return '';
          const strValue =
            typeof value === 'object'
              ? JSON.stringify(value)
              : String(value as string | number | boolean);
          // Escape CSV values
          if (strValue.includes(',') || strValue.includes('"') || strValue.includes('\n')) {
            return `"${strValue.replace(/"/g, '""')}"`;
          }
          return strValue;
        })
        .join(',');
    });

    return {
      format: 'csv',
      record_count: enriched.length,
      data: [headers, ...rows].join('\n'),
    };
  }

  /**
   * Get HSA/FSA eligible transactions.
   *
   * @param options - Filter options
   * @returns Object with HSA/FSA eligible transactions
   */
  async getHsaFsaEligible(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
  }): Promise<{
    period: { start_date?: string; end_date?: string };
    count: number;
    total_amount: number;
    by_category: Array<{ category: string; count: number; total: number }>;
    transactions: Array<Transaction & { category_name?: string; eligibility_reason: string }>;
  }> {
    const { period } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    const transactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    // Medical-related categories and merchants
    const medicalCategories = [
      'medical',
      'healthcare',
      'pharmacy',
      'medical_dental_care',
      'medical_eye_care',
      'medical_pharmacies_and_supplements',
      'medical_primary_care',
      'medical_other_medical',
      '14000000',
      '14001000',
      '14002000',
      '14003000',
      '14009000',
      '14011000',
    ];

    const medicalMerchants = [
      'cvs',
      'walgreens',
      'rite aid',
      'pharmacy',
      'medical',
      'health',
      'doctor',
      'dental',
      'vision',
      'optical',
      'hospital',
      'clinic',
      'urgent care',
      'lab',
      'prescription',
      'rx',
      'healthcare',
      'therapy',
      'physical therapy',
    ];

    // HSA/FSA eligible transactions are expenses (positive amounts in Copilot format) for medical services
    const hsaEligible = transactions.filter((txn) => {
      if (txn.amount <= 0) return false; // Must be an expense (positive in Copilot format)

      // Check category
      const isMedicalCategory =
        txn.category_id &&
        medicalCategories.some(
          (cat) =>
            txn.category_id?.toLowerCase().includes(cat.toLowerCase()) || txn.category_id === cat
        );

      // Check merchant name
      const merchantName = getTransactionDisplayName(txn).toLowerCase();
      const isMedicalMerchant = medicalMerchants.some((m) => merchantName.includes(m));

      return isMedicalCategory || isMedicalMerchant;
    });

    // Get eligibility reason
    const getEligibilityReason = (txn: Transaction): string => {
      const merchantName = getTransactionDisplayName(txn).toLowerCase();
      if (
        merchantName.includes('pharmacy') ||
        merchantName.includes('cvs') ||
        merchantName.includes('walgreens')
      ) {
        return 'Pharmacy';
      }
      if (merchantName.includes('dental') || txn.category_id?.includes('dental')) {
        return 'Dental Care';
      }
      if (
        merchantName.includes('vision') ||
        merchantName.includes('optical') ||
        txn.category_id?.includes('eye')
      ) {
        return 'Vision Care';
      }
      if (merchantName.includes('doctor') || merchantName.includes('clinic')) {
        return 'Medical Provider';
      }
      return 'Medical Expense';
    };

    // Aggregate by category
    const categoryMap = new Map<string, { count: number; total: number }>();
    for (const txn of hsaEligible) {
      const reason = getEligibilityReason(txn);
      const existing = categoryMap.get(reason) || { count: 0, total: 0 };
      existing.count++;
      existing.total += txn.amount;
      categoryMap.set(reason, existing);
    }

    const byCategory = Array.from(categoryMap.entries())
      .map(([category, data]) => ({
        category,
        count: data.count,
        total: roundAmount(data.total),
      }))
      .sort((a, b) => b.total - a.total);

    const totalAmount = hsaEligible.reduce((sum, txn) => sum + txn.amount, 0);

    const enrichedTransactions = await Promise.all(
      hsaEligible.slice(0, 100).map(async (txn) => ({
        ...txn,
        category_name: txn.category_id
          ? await this.resolveCategoryName(txn.category_id)
          : undefined,
        eligibility_reason: getEligibilityReason(txn),
      }))
    );

    return {
      period: { start_date, end_date },
      count: hsaEligible.length,
      total_amount: roundAmount(totalAmount),
      by_category: byCategory,
      transactions: enrichedTransactions,
    };
  }

  /**
   * Get spending rate/velocity analysis.
   *
   * @param options - Filter options
   * @returns Spending rate analysis with projections
   */
  async getSpendingRate(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    exclude_transfers?: boolean;
  }): Promise<{
    period: { start_date?: string; end_date?: string };
    days_in_period: number;
    days_elapsed: number;
    total_spending: number;
    daily_average: number;
    weekly_average: number;
    projected_monthly_total: number;
    spending_by_week: Array<{
      week_start: string;
      week_end: string;
      total: number;
      daily_average: number;
    }>;
    comparison_to_previous: {
      previous_period_total: number;
      change_percent: number;
      on_track: boolean;
    };
  }> {
    const { period, exclude_transfers = false } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    } else if (!start_date && !end_date) {
      // Default to this month
      [start_date, end_date] = parsePeriod('this_month');
    }

    let transactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    // Filter out transfers if requested (check both category and internal_transfer flag)
    if (exclude_transfers) {
      transactions = transactions.filter(
        (txn) => !isTransferCategory(txn.category_id) && !txn.internal_transfer
      );
    }

    // Calculate period stats
    const startDateObj = new Date(start_date + 'T00:00:00');
    const endDateObj = new Date(end_date + 'T23:59:59');
    const todayObj = new Date();
    const daysInPeriod = Math.ceil(
      (endDateObj.getTime() - startDateObj.getTime()) / (1000 * 60 * 60 * 24)
    );
    const daysElapsed = Math.min(
      Math.ceil((todayObj.getTime() - startDateObj.getTime()) / (1000 * 60 * 60 * 24)),
      daysInPeriod
    );

    // Always exclude internal transfers from spending calculations
    // Expenses are positive amounts in Copilot Money format
    const totalSpending = transactions
      .filter((txn) => txn.amount > 0 && !txn.internal_transfer)
      .reduce((sum, txn) => sum + Math.abs(txn.amount), 0);

    const dailyAverage = daysElapsed > 0 ? totalSpending / daysElapsed : 0;
    const weeklyAverage = dailyAverage * 7;
    const projectedMonthlyTotal = dailyAverage * 30;

    // Weekly breakdown (exclude internal transfers)
    const weeklyTotals = new Map<
      string,
      { start: string; end: string; total: number; days: number }
    >();
    for (const txn of transactions) {
      // Only count positive amounts (expenses in Copilot format), skip internal transfers
      if (txn.amount <= 0 || txn.internal_transfer) continue;
      const txnDate = new Date(txn.date + 'T12:00:00');
      const weekStart = new Date(txnDate);
      weekStart.setDate(txnDate.getDate() - txnDate.getDay());
      const weekKey = weekStart.toISOString().substring(0, 10) ?? '';
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);

      const existing = weeklyTotals.get(weekKey) || {
        start: weekKey,
        end: weekEnd.toISOString().substring(0, 10) ?? '',
        total: 0,
        days: 7,
      };
      existing.total += Math.abs(txn.amount);
      weeklyTotals.set(weekKey, existing);
    }

    const spendingByWeek = Array.from(weeklyTotals.values())
      .map((week) => ({
        week_start: week.start,
        week_end: week.end,
        total: roundAmount(week.total),
        daily_average: roundAmount(week.total / week.days),
      }))
      .sort((a, b) => a.week_start.localeCompare(b.week_start));

    // Compare to previous period
    const periodLength = daysInPeriod;
    const prevStart = new Date(startDateObj);
    prevStart.setDate(prevStart.getDate() - periodLength);
    const prevEnd = new Date(startDateObj);
    prevEnd.setDate(prevEnd.getDate() - 1);

    let prevTransactions = await this.db.getTransactions({
      startDate: prevStart.toISOString().substring(0, 10),
      endDate: prevEnd.toISOString().substring(0, 10),
      limit: 50000,
    });

    if (exclude_transfers) {
      prevTransactions = prevTransactions.filter((txn) => !isTransferCategory(txn.category_id));
    }

    // Expenses are positive amounts in Copilot Money format
    const previousPeriodTotal = prevTransactions
      .filter((txn) => txn.amount > 0)
      .reduce((sum, txn) => sum + Math.abs(txn.amount), 0);

    const changePercent =
      previousPeriodTotal > 0
        ? roundAmount(((totalSpending - previousPeriodTotal) / previousPeriodTotal) * 100)
        : 0;

    // Are we on track? (spending less than prorated amount from last period)
    const proratedPrevious = (previousPeriodTotal / periodLength) * daysElapsed;
    const onTrack = totalSpending <= proratedPrevious;

    return {
      period: { start_date, end_date },
      days_in_period: daysInPeriod,
      days_elapsed: daysElapsed,
      total_spending: roundAmount(totalSpending),
      daily_average: roundAmount(dailyAverage),
      weekly_average: roundAmount(weeklyAverage),
      projected_monthly_total: roundAmount(projectedMonthlyTotal),
      spending_by_week: spendingByWeek,
      comparison_to_previous: {
        previous_period_total: roundAmount(previousPeriodTotal),
        change_percent: changePercent,
        on_track: onTrack,
      },
    };
  }

  /**
   * Generate a data quality report to help identify issues in financial data.
   *
   * This tool helps users find problematic data that should be corrected in Copilot Money:
   * - Unresolved category IDs
   * - Potential currency conversion issues
   * - Transactions sharing IDs (non-unique)
   * - Potential duplicate accounts
   * - Suspicious categorizations
   *
   * Supports configurable limits for large datasets:
   * - transaction_limit: Max transactions to analyze (default 50000, max 100000)
   * - issues_limit: Max issues to return per category (default 20, max 100)
   * - issues_offset: Skip first N issues for pagination (default 0)
   *
   * @param options - Filter and pagination options
   * @returns Object with various data quality metrics and issues
   */
  async getDataQualityReport(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    transaction_limit?: number;
    issues_limit?: number;
    issues_offset?: number;
    foreign_large_amount_threshold?: number;
    round_amount_threshold?: number;
  }): Promise<{
    period: { start_date?: string; end_date?: string };
    analysis_metadata: {
      transactions_analyzed: number;
      transaction_limit_reached: boolean;
      issues_limit: number;
      issues_offset: number;
    };
    summary: {
      total_transactions: number;
      total_accounts: number;
      issues_found: number;
    };
    category_issues: {
      count: number;
      total: number;
      has_more: boolean;
      unresolved_categories: Array<{
        category_id: string;
        transaction_count: number;
        total_amount: number;
        sample_transactions: Array<{ date: string; merchant: string; amount: number }>;
      }>;
    };
    currency_issues: {
      count: number;
      total: number;
      has_more: boolean;
      suspicious_transactions: Array<{
        transaction_id: string;
        date: string;
        merchant: string;
        amount: number;
        currency: string;
        reason: string;
      }>;
    };
    duplicate_issues: {
      non_unique_ids: {
        count: number;
        total: number;
        has_more: boolean;
        items: Array<{
          transaction_id: string;
          occurrences: number;
          sample_dates: string[];
        }>;
      };
      potential_duplicate_accounts: Array<{
        account_name: string;
        account_type: string;
        count: number;
        account_ids: string[];
        balances: number[];
      }>;
    };
    amount_issues: {
      count: number;
      total: number;
      has_more: boolean;
      items: Array<{
        transaction_id: string;
        date: string;
        merchant: string;
        amount: number;
        category_name: string;
        severity: 'extremely_large' | 'unrealistic';
        reason: string;
      }>;
    };
    suspicious_categorizations: {
      count: number;
      total: number;
      has_more: boolean;
      items: Array<{
        transaction_id: string;
        date: string;
        merchant: string;
        amount: number;
        category_assigned: string;
        reason: string;
      }>;
    };
  }> {
    const {
      period,
      foreign_large_amount_threshold = DEFAULT_FOREIGN_LARGE_AMOUNT_THRESHOLD,
      round_amount_threshold = DEFAULT_ROUND_AMOUNT_THRESHOLD,
    } = options;
    let { start_date, end_date } = options;

    // Validate and apply limits
    const transactionLimit = Math.min(
      Math.max(1, options.transaction_limit ?? DEFAULT_DATA_QUALITY_TRANSACTION_LIMIT),
      MAX_DATA_QUALITY_TRANSACTION_LIMIT
    );
    const issuesLimit = Math.min(
      Math.max(1, options.issues_limit ?? DEFAULT_ISSUES_LIMIT),
      MAX_ISSUES_LIMIT
    );
    const issuesOffset = Math.max(0, options.issues_offset ?? 0);

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Fetch transactions up to the configured limit
    const allTransactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: transactionLimit,
    });

    // Track if we hit the limit (meaning there may be more transactions available)
    const hitTransactionLimit = allTransactions.length === transactionLimit;

    const allAccounts = await this.db.getAccounts();

    let issuesFound = 0;

    // ===== CATEGORY ISSUES =====
    const unresolvedCategories = new Map<
      string,
      {
        count: number;
        total: number;
        samples: Array<{ date: string; merchant: string; amount: number }>;
      }
    >();

    for (const txn of allTransactions) {
      if (!txn.category_id) continue;

      const categoryName = await this.resolveCategoryName(txn.category_id);

      // Check if category is unresolved (no mapping exists or returns the ID itself)
      const isUnresolved =
        categoryName === txn.category_id || // No mapping found
        /^[a-zA-Z0-9]{20,}$/.test(categoryName) || // Looks like a Firebase/random ID
        /^\d{8}$/.test(categoryName); // 8-digit numeric ID without mapping

      if (isUnresolved) {
        const existing = unresolvedCategories.get(txn.category_id) || {
          count: 0,
          total: 0,
          samples: [],
        };
        existing.count++;
        existing.total += Math.abs(txn.amount);

        if (existing.samples.length < 3) {
          existing.samples.push({
            date: txn.date,
            merchant: getTransactionDisplayName(txn),
            amount: txn.amount,
          });
        }

        unresolvedCategories.set(txn.category_id, existing);
      }
    }

    const unresolvedCategoryList = Array.from(unresolvedCategories.entries())
      .map(([category_id, data]) => ({
        category_id,
        transaction_count: data.count,
        total_amount: roundAmount(data.total),
        sample_transactions: data.samples,
      }))
      .sort((a, b) => b.total_amount - a.total_amount);

    issuesFound += unresolvedCategoryList.length;

    // ===== CURRENCY ISSUES =====
    const suspiciousCurrencyTransactions: Array<{
      transaction_id: string;
      date: string;
      merchant: string;
      amount: number;
      currency: string;
      reason: string;
    }> = [];

    for (const txn of allTransactions) {
      const merchant = getTransactionDisplayName(txn).toUpperCase();
      const amount = Math.abs(txn.amount);
      const currency = txn.iso_currency_code || 'USD';

      // Flag suspiciously large amounts with foreign indicators
      const hasForeignIndicator =
        merchant.includes(' CL ') || // Chile
        merchant.includes(' SANTIAGO') ||
        merchant.includes(' VALPARAISO') ||
        merchant.includes(' MX ') || // Mexico
        merchant.includes(' GB ') || // UK
        merchant.includes(' FR ') || // France
        merchant.includes(' JP ') || // Japan
        /\b[A-Z]{2}\b/.test(merchant); // Two-letter country codes

      // Suspiciously large transaction with foreign merchant
      if (hasForeignIndicator && amount > foreign_large_amount_threshold && currency === 'USD') {
        suspiciousCurrencyTransactions.push({
          transaction_id: txn.transaction_id,
          date: txn.date,
          merchant: getTransactionDisplayName(txn),
          amount: txn.amount,
          currency,
          reason: 'Large amount with foreign merchant name - possible unconverted currency',
        });
      }

      // Extremely round numbers that match typical foreign exchange rates
      if (amount > round_amount_threshold && amount % 1000 < 10 && hasForeignIndicator) {
        suspiciousCurrencyTransactions.push({
          transaction_id: txn.transaction_id,
          date: txn.date,
          merchant: getTransactionDisplayName(txn),
          amount: txn.amount,
          currency,
          reason: 'Very round amount with foreign merchant - possible unconverted currency',
        });
      }
    }

    issuesFound += suspiciousCurrencyTransactions.length;

    // ===== DUPLICATE ISSUES =====

    // Check for non-unique transaction IDs
    const transactionIdCounts = new Map<string, Array<{ date: string }>>();
    for (const txn of allTransactions) {
      const existing = transactionIdCounts.get(txn.transaction_id) || [];
      existing.push({ date: txn.date });
      transactionIdCounts.set(txn.transaction_id, existing);
    }

    const allNonUniqueTransactionIds = Array.from(transactionIdCounts.entries())
      .filter(([_, occurrences]) => occurrences.length > 1)
      .map(([transaction_id, occurrences]) => ({
        transaction_id,
        occurrences: occurrences.length,
        sample_dates: occurrences.slice(0, 5).map((o) => o.date),
      }))
      .sort((a, b) => b.occurrences - a.occurrences);

    const totalNonUniqueIds = allNonUniqueTransactionIds.length;
    const nonUniqueTransactionIds = allNonUniqueTransactionIds.slice(
      issuesOffset,
      issuesOffset + issuesLimit
    );
    const hasMoreNonUnique = issuesOffset + issuesLimit < totalNonUniqueIds;

    issuesFound += totalNonUniqueIds;

    // Check for potential duplicate accounts
    const accountsByNameAndType = new Map<
      string,
      Array<{ id: string; name: string; type: string; balance: number }>
    >();

    for (const account of allAccounts) {
      const accountName = await this.resolveAccountName(account);
      const accountType = account.account_type || 'unknown';
      const key = `${accountName}|${accountType}`;
      const existing = accountsByNameAndType.get(key) || [];
      existing.push({
        id: account.account_id,
        name: accountName,
        type: accountType,
        balance: account.current_balance || 0,
      });
      accountsByNameAndType.set(key, existing);
    }

    const potentialDuplicateAccounts = Array.from(accountsByNameAndType.entries())
      .filter(([_, accounts]) => accounts.length > 1)
      .map(([key, accounts]) => {
        const [name, type] = key.split('|');
        return {
          account_name: name || 'Unknown',
          account_type: type || 'Unknown',
          count: accounts.length,
          account_ids: accounts.map((a) => a.id),
          balances: accounts.map((a) => a.balance),
        };
      });

    issuesFound += potentialDuplicateAccounts.length;

    // ===== SUSPICIOUS CATEGORIZATIONS =====
    const suspiciousCategorizations: Array<{
      transaction_id: string;
      date: string;
      merchant: string;
      amount: number;
      category_assigned: string;
      reason: string;
    }> = [];

    for (const txn of allTransactions) {
      const merchant = getTransactionDisplayName(txn).toUpperCase();
      const categoryName = txn.category_id
        ? await this.resolveCategoryName(txn.category_id)
        : 'Unknown';

      // Uber categorized as Parking
      if (merchant.includes('UBER') && categoryName.includes('Parking')) {
        suspiciousCategorizations.push({
          transaction_id: txn.transaction_id,
          date: txn.date,
          merchant: getTransactionDisplayName(txn),
          amount: txn.amount,
          category_assigned: categoryName,
          reason: 'Uber should be Rideshare, not Parking',
        });
      }

      // Grocery stores as Pawn Shops
      if (
        (merchant.includes('WHOLE FOODS') ||
          merchant.includes('JUMBO') ||
          merchant.includes('SAFEWAY') ||
          merchant.includes('KROGER')) &&
        categoryName.includes('Pawn')
      ) {
        suspiciousCategorizations.push({
          transaction_id: txn.transaction_id,
          date: txn.date,
          merchant: getTransactionDisplayName(txn),
          amount: txn.amount,
          category_assigned: categoryName,
          reason: 'Grocery store miscategorized as Pawn Shop',
        });
      }

      // Pharmacies as Office Supplies or Dance & Music
      if (
        (merchant.includes('PHARMAC') ||
          merchant.includes('FARMACIA') ||
          merchant.includes('CVS')) &&
        (categoryName.includes('Office Supplies') || categoryName.includes('Dance'))
      ) {
        suspiciousCategorizations.push({
          transaction_id: txn.transaction_id,
          date: txn.date,
          merchant: getTransactionDisplayName(txn),
          amount: txn.amount,
          category_assigned: categoryName,
          reason: 'Pharmacy should be Healthcare, not ' + categoryName,
        });
      }

      // Software subscriptions as Travel/Cruises
      if (
        (merchant.includes('CLAUDE') ||
          merchant.includes('CHATGPT') ||
          merchant.includes('OPENAI') ||
          merchant.includes('ANTHROPIC')) &&
        (categoryName.includes('Travel') || categoryName.includes('Cruise'))
      ) {
        suspiciousCategorizations.push({
          transaction_id: txn.transaction_id,
          date: txn.date,
          merchant: getTransactionDisplayName(txn),
          amount: txn.amount,
          category_assigned: categoryName,
          reason: 'Software subscription miscategorized as Travel',
        });
      }

      // Apple.com as Dance & Music
      if (merchant.includes('APPLE.COM') && categoryName.includes('Dance')) {
        suspiciousCategorizations.push({
          transaction_id: txn.transaction_id,
          date: txn.date,
          merchant: getTransactionDisplayName(txn),
          amount: txn.amount,
          category_assigned: categoryName,
          reason: 'Apple.com should be Software/Subscriptions or Electronics',
        });
      }

      // H&M or clothing stores as CBD
      if (
        (merchant.includes('H&M') || merchant.includes('ZARA') || merchant.includes('GAP')) &&
        categoryName.includes('CBD')
      ) {
        suspiciousCategorizations.push({
          transaction_id: txn.transaction_id,
          date: txn.date,
          merchant: getTransactionDisplayName(txn),
          amount: txn.amount,
          category_assigned: categoryName,
          reason: 'Clothing store miscategorized as CBD',
        });
      }
    }

    const totalSuspiciousCategorizations = suspiciousCategorizations.length;
    issuesFound += totalSuspiciousCategorizations;

    // Apply pagination to all issue categories
    const paginatedUnresolvedCategories = unresolvedCategoryList.slice(
      issuesOffset,
      issuesOffset + issuesLimit
    );
    const totalUnresolvedCategories = unresolvedCategoryList.length;
    const hasMoreUnresolvedCategories = issuesOffset + issuesLimit < totalUnresolvedCategories;

    const paginatedCurrencyIssues = suspiciousCurrencyTransactions.slice(
      issuesOffset,
      issuesOffset + issuesLimit
    );
    const totalCurrencyIssues = suspiciousCurrencyTransactions.length;
    const hasMoreCurrencyIssues = issuesOffset + issuesLimit < totalCurrencyIssues;

    const paginatedSuspiciousCategorizations = suspiciousCategorizations.slice(
      issuesOffset,
      issuesOffset + issuesLimit
    );
    const hasMoreSuspiciousCategorizations =
      issuesOffset + issuesLimit < totalSuspiciousCategorizations;

    // ===== AMOUNT ISSUES =====
    const extremelyLargeTransactions: Array<{
      transaction_id: string;
      date: string;
      merchant: string;
      amount: number;
      category_name: string;
      severity: 'extremely_large' | 'unrealistic';
      reason: string;
    }> = [];

    for (const txn of allTransactions) {
      const absAmount = Math.abs(txn.amount);
      const merchant = getTransactionDisplayName(txn);
      const categoryName = txn.category_id
        ? await this.resolveCategoryName(txn.category_id)
        : 'Unknown';

      if (absAmount >= UNREALISTIC_AMOUNT_THRESHOLD) {
        // Unrealistic amounts (>= $1,000,000) - almost certainly data errors
        extremelyLargeTransactions.push({
          transaction_id: txn.transaction_id,
          date: txn.date,
          merchant,
          amount: txn.amount,
          category_name: categoryName,
          severity: 'unrealistic',
          reason: `Amount $${absAmount.toLocaleString()} exceeds $${UNREALISTIC_AMOUNT_THRESHOLD.toLocaleString()} - likely a data quality issue or unconverted foreign currency`,
        });
      } else if (absAmount >= EXTREMELY_LARGE_THRESHOLD) {
        // Extremely large amounts ($100,000 - $999,999) - unusual for personal finance
        extremelyLargeTransactions.push({
          transaction_id: txn.transaction_id,
          date: txn.date,
          merchant,
          amount: txn.amount,
          category_name: categoryName,
          severity: 'extremely_large',
          reason: `Amount $${absAmount.toLocaleString()} exceeds $${EXTREMELY_LARGE_THRESHOLD.toLocaleString()} - review for accuracy`,
        });
      }
    }

    // Sort by amount (largest first)
    extremelyLargeTransactions.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

    const totalAmountIssues = extremelyLargeTransactions.length;
    issuesFound += totalAmountIssues;

    const paginatedAmountIssues = extremelyLargeTransactions.slice(
      issuesOffset,
      issuesOffset + issuesLimit
    );
    const hasMoreAmountIssues = issuesOffset + issuesLimit < totalAmountIssues;

    return {
      period: { start_date, end_date },
      analysis_metadata: {
        transactions_analyzed: allTransactions.length,
        transaction_limit_reached: hitTransactionLimit,
        issues_limit: issuesLimit,
        issues_offset: issuesOffset,
      },
      summary: {
        total_transactions: allTransactions.length,
        total_accounts: allAccounts.length,
        issues_found: issuesFound,
      },
      category_issues: {
        count: paginatedUnresolvedCategories.length,
        total: totalUnresolvedCategories,
        has_more: hasMoreUnresolvedCategories,
        unresolved_categories: paginatedUnresolvedCategories,
      },
      currency_issues: {
        count: paginatedCurrencyIssues.length,
        total: totalCurrencyIssues,
        has_more: hasMoreCurrencyIssues,
        suspicious_transactions: paginatedCurrencyIssues,
      },
      duplicate_issues: {
        non_unique_ids: {
          count: nonUniqueTransactionIds.length,
          total: totalNonUniqueIds,
          has_more: hasMoreNonUnique,
          items: nonUniqueTransactionIds,
        },
        potential_duplicate_accounts: potentialDuplicateAccounts,
      },
      amount_issues: {
        count: paginatedAmountIssues.length,
        total: totalAmountIssues,
        has_more: hasMoreAmountIssues,
        items: paginatedAmountIssues,
      },
      suspicious_categorizations: {
        count: paginatedSuspiciousCategorizations.length,
        total: totalSuspiciousCategorizations,
        has_more: hasMoreSuspiciousCategorizations,
        items: paginatedSuspiciousCategorizations,
      },
    };
  }

  /**
   * Compare spending between two time periods.
   *
   * @param options - Filter options
   * @returns Object with comparison between two periods
   */
  async comparePeriods(options: {
    period1: string;
    period2: string;
    exclude_transfers?: boolean;
  }): Promise<{
    period1: {
      name: string;
      start_date: string;
      end_date: string;
      total_spending: number;
      total_income: number;
      net: number;
      transaction_count: number;
    };
    period2: {
      name: string;
      start_date: string;
      end_date: string;
      total_spending: number;
      total_income: number;
      net: number;
      transaction_count: number;
    };
    comparison: {
      spending_change: number;
      spending_change_percent: number;
      income_change: number;
      income_change_percent: number;
      net_change: number;
    };
    category_comparison: Array<{
      category_id: string;
      category_name: string;
      period1_spending: number;
      period2_spending: number;
      change: number;
      change_percent: number;
    }>;
  }> {
    const { period1, period2, exclude_transfers = false } = options;

    // Parse periods
    const [start1, end1] = parsePeriod(period1);
    const [start2, end2] = parsePeriod(period2);

    // Helper to analyze a period
    const analyzePeriod = async (
      startDate: string,
      endDate: string
    ): Promise<{
      spending: number;
      income: number;
      count: number;
      byCategory: Map<string, number>;
    }> => {
      let transactions = await this.db.getTransactions({
        startDate,
        endDate,
        limit: 50000,
      });

      // Filter out transfers if requested (check both category and internal_transfer flag)
      if (exclude_transfers) {
        transactions = transactions.filter(
          (txn) => !isTransferCategory(txn.category_id) && !txn.internal_transfer
        );
      }

      let spending = 0;
      let income = 0;
      const byCategory = new Map<string, number>();

      // Copilot Money format: positive = expenses, negative = income
      for (const txn of transactions) {
        // Always exclude internal transfers from spending calculations
        if (txn.amount > 0 && !txn.internal_transfer) {
          spending += txn.amount;
          const cat = getCategoryIdOrDefault(txn.category_id);
          byCategory.set(cat, (byCategory.get(cat) || 0) + txn.amount);
        } else if (txn.amount < 0) {
          income += Math.abs(txn.amount);
        }
      }

      return {
        spending: roundAmount(spending),
        income: roundAmount(income),
        count: transactions.length,
        byCategory,
      };
    };

    const p1Data = await analyzePeriod(start1, end1);
    const p2Data = await analyzePeriod(start2, end2);

    // Calculate changes
    const spendingChange = p2Data.spending - p1Data.spending;
    const spendingChangePercent =
      p1Data.spending > 0 ? roundAmount((spendingChange / p1Data.spending) * 100) : 0;

    const incomeChange = p2Data.income - p1Data.income;
    const incomeChangePercent =
      p1Data.income > 0 ? roundAmount((incomeChange / p1Data.income) * 100) : 0;

    // Compare categories
    const allCategories = new Set([...p1Data.byCategory.keys(), ...p2Data.byCategory.keys()]);

    const categoryComparison = (
      await Promise.all(
        Array.from(allCategories).map(async (categoryId) => {
          const p1Spending = p1Data.byCategory.get(categoryId) || 0;
          const p2Spending = p2Data.byCategory.get(categoryId) || 0;
          const change = p2Spending - p1Spending;
          const changePercent = p1Spending > 0 ? roundAmount((change / p1Spending) * 100) : 0;

          return {
            category_id: categoryId,
            category_name: await this.resolveCategoryName(categoryId),
            period1_spending: roundAmount(p1Spending),
            period2_spending: roundAmount(p2Spending),
            change: roundAmount(change),
            change_percent: changePercent,
          };
        })
      )
    ).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    return {
      period1: {
        name: period1,
        start_date: start1,
        end_date: end1,
        total_spending: p1Data.spending,
        total_income: p1Data.income,
        net: roundAmount(p1Data.income - p1Data.spending),
        transaction_count: p1Data.count,
      },
      period2: {
        name: period2,
        start_date: start2,
        end_date: end2,
        total_spending: p2Data.spending,
        total_income: p2Data.income,
        net: roundAmount(p2Data.income - p2Data.spending),
        transaction_count: p2Data.count,
      },
      comparison: {
        spending_change: roundAmount(spendingChange),
        spending_change_percent: spendingChangePercent,
        income_change: roundAmount(incomeChange),
        income_change_percent: incomeChangePercent,
        net_change: roundAmount(
          p2Data.income - p2Data.spending - (p1Data.income - p1Data.spending)
        ),
      },
      category_comparison: categoryComparison.slice(0, 20),
    };
  }

  /**
   * Get investment prices (current/latest prices for investments).
   *
   * Returns the most recent price data for investments, optionally filtered by ticker symbol.
   * Useful for checking current portfolio values and tracking investment performance.
   *
   * @param options - Filter options
   * @returns Object with investment price data
   */
  async getInvestmentPrices(options: { ticker_symbol?: string } = {}): Promise<{
    count: number;
    prices: Array<{
      investment_id: string;
      ticker_symbol?: string;
      price?: number;
      close_price?: number;
      current_price?: number;
      institution_price?: number;
      best_price?: number;
      date?: string;
      month?: string;
      currency?: string;
      high?: number;
      low?: number;
      open?: number;
      volume?: number;
      price_type?: string;
    }>;
  }> {
    const { ticker_symbol } = options;

    // Get latest prices (no date filter to get most recent)
    const prices = await this.db.getInvestmentPrices({
      tickerSymbol: ticker_symbol,
    });

    // Group by investment_id and get the latest price for each
    const latestPrices = new Map<string, (typeof prices)[0]>();
    for (const price of prices) {
      const existing = latestPrices.get(price.investment_id);
      const priceDate = getPriceDate(price);
      const existingDate = existing ? getPriceDate(existing) : undefined;

      // Keep the most recent price (by date/month)
      if (!existing || (priceDate && existingDate && priceDate > existingDate)) {
        latestPrices.set(price.investment_id, price);
      }
    }

    // Convert to array and format
    const formattedPrices = Array.from(latestPrices.values()).map((p) => ({
      investment_id: p.investment_id,
      ticker_symbol: p.ticker_symbol,
      price: p.price,
      close_price: p.close_price,
      current_price: p.current_price,
      institution_price: p.institution_price,
      best_price: getBestPrice(p),
      date: p.date,
      month: p.month,
      currency: p.currency,
      high: p.high,
      low: p.low,
      open: p.open,
      volume: p.volume,
      price_type: p.price_type,
    }));

    // Sort by ticker symbol (or investment_id if no ticker)
    formattedPrices.sort((a, b) => {
      const aName = a.ticker_symbol || a.investment_id;
      const bName = b.ticker_symbol || b.investment_id;
      return aName.localeCompare(bName);
    });

    return {
      count: formattedPrices.length,
      prices: formattedPrices,
    };
  }

  /**
   * Get historical price data for a specific investment ticker.
   *
   * Returns time-series price data for an investment over a specified date range.
   * Useful for analyzing price trends, volatility, and historical performance.
   *
   * @param options - Filter options
   * @returns Object with historical price data
   */
  async getInvestmentPriceHistory(options: {
    ticker_symbol: string;
    start_date?: string;
    end_date?: string;
    price_type?: 'daily' | 'hf';
  }): Promise<{
    ticker_symbol: string;
    count: number;
    date_range: {
      start_date?: string;
      end_date?: string;
    };
    price_summary?: {
      latest_price?: number;
      earliest_price?: number;
      highest_price?: number;
      lowest_price?: number;
      price_change?: number;
      price_change_percent?: number;
    };
    history: Array<{
      date?: string;
      month?: string;
      price?: number;
      close_price?: number;
      current_price?: number;
      best_price?: number;
      open?: number;
      high?: number;
      low?: number;
      volume?: number;
      currency?: string;
      price_type?: string;
    }>;
  }> {
    const { ticker_symbol, start_date, end_date, price_type } = options;

    // Validate required parameter
    if (!ticker_symbol) {
      throw new Error('ticker_symbol is required');
    }

    // Get historical prices for this ticker
    const prices = await this.db.getInvestmentPrices({
      tickerSymbol: ticker_symbol,
      startDate: start_date,
      endDate: end_date,
      priceType: price_type,
    });

    if (prices.length === 0) {
      return {
        ticker_symbol,
        count: 0,
        date_range: {
          start_date,
          end_date,
        },
        history: [],
      };
    }

    // Format history
    const history = prices.map((p) => ({
      date: p.date,
      month: p.month,
      price: p.price,
      close_price: p.close_price,
      current_price: p.current_price,
      best_price: getBestPrice(p),
      open: p.open,
      high: p.high,
      low: p.low,
      volume: p.volume,
      currency: p.currency,
      price_type: p.price_type,
    }));

    // Sort by date/month descending (newest first)
    history.sort((a, b) => {
      const aDate = a.date || a.month || '';
      const bDate = b.date || b.month || '';
      return bDate.localeCompare(aDate);
    });

    // Calculate price summary
    const pricesWithValues = prices
      .map((p) => getBestPrice(p))
      .filter((p): p is number => p !== undefined);

    let priceSummary;
    if (pricesWithValues.length > 0) {
      const latestPrice = history[0]?.best_price;
      const earliestPrice = history[history.length - 1]?.best_price;
      const highestPrice = Math.max(...pricesWithValues);
      const lowestPrice = Math.min(...pricesWithValues);

      priceSummary = {
        latest_price: latestPrice,
        earliest_price: earliestPrice,
        highest_price: highestPrice,
        lowest_price: lowestPrice,
        price_change:
          latestPrice && earliestPrice ? roundAmount(latestPrice - earliestPrice) : undefined,
        price_change_percent:
          latestPrice && earliestPrice && earliestPrice > 0
            ? roundAmount(((latestPrice - earliestPrice) / earliestPrice) * 100)
            : undefined,
      };
    }

    return {
      ticker_symbol,
      count: history.length,
      date_range: {
        start_date:
          start_date || history[history.length - 1]?.date || history[history.length - 1]?.month,
        end_date: end_date || history[0]?.date || history[0]?.month,
      },
      price_summary: priceSummary,
      history,
    };
  }

  /**
   * Get investment splits (stock splits) from the database.
   *
   * Returns stock split information including split ratios, dates, and calculated multipliers.
   * Useful for understanding how historical prices and share counts should be adjusted.
   *
   * @param options - Filter options
   * @returns Object with investment split data
   */
  async getInvestmentSplits(
    options: {
      ticker_symbol?: string;
      start_date?: string;
      end_date?: string;
    } = {}
  ): Promise<{
    count: number;
    splits: Array<{
      split_id: string;
      ticker_symbol?: string;
      split_date?: string;
      split_ratio?: string;
      from_factor?: number;
      to_factor?: number;
      multiplier?: number;
      display_string: string;
      is_reverse_split?: boolean;
      announcement_date?: string;
      record_date?: string;
      ex_date?: string;
      description?: string;
    }>;
  }> {
    const { ticker_symbol, start_date, end_date } = options;

    // Get splits from database
    const splits = await this.db.getInvestmentSplits({
      tickerSymbol: ticker_symbol,
      startDate: start_date,
      endDate: end_date,
    });

    // Format splits with calculated fields
    const formattedSplits = splits.map((split) => ({
      split_id: split.split_id,
      ticker_symbol: split.ticker_symbol,
      split_date: split.split_date,
      split_ratio: split.split_ratio,
      from_factor: split.from_factor,
      to_factor: split.to_factor,
      multiplier: getSplitMultiplier(split),
      display_string: getSplitDisplayString(split),
      is_reverse_split: isReverseSplit(split),
      announcement_date: split.announcement_date,
      record_date: split.record_date,
      ex_date: split.ex_date,
      description: split.description,
    }));

    return {
      count: formattedSplits.length,
      splits: formattedSplits,
    };
  }

  /**
   * Get connected financial institutions (Plaid items).
   *
   * Returns information about institution connections including health status,
   * error states, and when they were last synced. Useful for monitoring
   * connection health and identifying accounts that need re-authentication.
   *
   * @param options - Filter options
   * @returns Object with institution connection data
   */
  async getConnectedInstitutions(
    options: {
      connection_status?: string;
      institution_id?: string;
      needs_update?: boolean;
    } = {}
  ): Promise<{
    count: number;
    healthy_count: number;
    needs_attention_count: number;
    institutions: Array<{
      item_id: string;
      institution_name: string;
      institution_id?: string;
      connection_status?: string;
      status_description: string;
      is_healthy: boolean;
      needs_attention: boolean;
      account_count: number;
      last_updated?: string;
      error_code?: string;
      error_message?: string;
    }>;
  }> {
    const { connection_status, institution_id, needs_update } = options;

    // Get items from database
    const items = await this.db.getItems({
      connectionStatus: connection_status,
      institutionId: institution_id,
      needsUpdate: needs_update,
    });

    // Format items with calculated fields
    const formattedItems = items.map((item) => ({
      item_id: item.item_id,
      institution_name: getItemDisplayName(item),
      institution_id: item.institution_id,
      connection_status: item.connection_status,
      status_description: getItemStatusDescription(item),
      is_healthy: isItemHealthy(item),
      needs_attention: itemNeedsAttention(item),
      account_count: getItemAccountCount(item),
      last_updated: formatLastUpdate(item),
      error_code: item.error_code,
      error_message: item.error_message,
    }));

    // Count healthy and needing attention
    const healthyCount = formattedItems.filter((i) => i.is_healthy).length;
    const needsAttentionCount = formattedItems.filter((i) => i.needs_attention).length;

    return {
      count: formattedItems.length,
      healthy_count: healthyCount,
      needs_attention_count: needsAttentionCount,
      institutions: formattedItems,
    };
  }

  /**
   * Get the full category hierarchy tree.
   *
   * Returns the complete Plaid category taxonomy organized as a tree structure
   * with root categories and their children. Useful for understanding how
   * transactions are categorized and for building category selection UIs.
   *
   * @param options - Filter options
   * @returns Object with category hierarchy
   */
  getCategoryHierarchy(options: { type?: 'income' | 'expense' | 'transfer' } = {}): {
    count: number;
    type_filter?: string;
    categories: Array<{
      id: string;
      name: string;
      display_name: string;
      type: string;
      children: Array<{
        id: string;
        name: string;
        display_name: string;
        path: string;
      }>;
    }>;
  } {
    const { type } = options;

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

    // Count total categories
    const totalCount = categories.reduce((sum, cat) => sum + 1 + cat.children.length, 0);

    return {
      count: totalCount,
      type_filter: type,
      categories,
    };
  }

  /**
   * Get subcategories (children) of a specific category.
   *
   * Returns all direct children of a given category. Useful for drilling down
   * into specific spending areas or building hierarchical category selectors.
   *
   * @param categoryId - Parent category ID
   * @returns Object with subcategories
   */
  getSubcategories(categoryId: string): {
    parent_id: string;
    parent_name: string;
    count: number;
    subcategories: Array<{
      id: string;
      name: string;
      display_name: string;
      path: string;
      type: string;
    }>;
  } {
    // Find the parent category
    const rootCats = getRootCategories();
    const parent = rootCats.find((cat) => cat.id === categoryId);

    if (!parent) {
      // Check if it's a child category (which would have no children)
      throw new Error(`Category not found or has no subcategories: ${categoryId}`);
    }

    const children = getCategoryChildren(categoryId);

    return {
      parent_id: parent.id,
      parent_name: parent.display_name,
      count: children.length,
      subcategories: children.map((child) => ({
        id: child.id,
        name: child.name,
        display_name: child.display_name,
        path: child.path,
        type: child.type,
      })),
    };
  }

  /**
   * Search categories by name or keyword.
   *
   * Performs a case-insensitive search across category names, IDs, and paths.
   * Useful for finding specific categories when you know part of the name.
   *
   * @param query - Search query
   * @returns Object with matching categories
   */
  searchCategoriesHierarchy(query: string): {
    query: string;
    count: number;
    categories: Array<{
      id: string;
      name: string;
      display_name: string;
      path: string;
      type: string;
      depth: number;
      is_leaf: boolean;
    }>;
  } {
    if (!query || query.trim().length === 0) {
      throw new Error('Search query is required');
    }

    const results = searchCategoriesInHierarchy(query.trim());

    return {
      query: query.trim(),
      count: results.length,
      categories: results.map((cat) => ({
        id: cat.id,
        name: cat.name,
        display_name: cat.display_name,
        path: cat.path,
        type: cat.type,
        depth: cat.depth,
        is_leaf: cat.is_leaf,
      })),
    };
  }

  // ============================================
  // PHASE 12: ANALYTICS TOOLS
  // ============================================

  // ---- Spending Trends ----

  /**
   * Get spending aggregated over time periods.
   *
   * Shows spending trends by day, week, or month within a date range.
   *
   * @param options - Filter options
   * @returns Time series spending data
   */
  async getSpendingOverTime(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      granularity?: 'day' | 'week' | 'month';
      category?: string;
      exclude_transfers?: boolean;
    } = {}
  ): Promise<{
    granularity: string;
    start_date: string;
    end_date: string;
    periods: Array<{
      period_start: string;
      period_end: string;
      total_spending: number;
      transaction_count: number;
      average_transaction: number;
    }>;
    summary: {
      total_spending: number;
      average_per_period: number;
      highest_period: { period_start: string; amount: number } | null;
      lowest_period: { period_start: string; amount: number } | null;
    };
  }> {
    const allTransactions = await this.db.getTransactions();
    const granularity = options.granularity || 'month';

    // Determine date range
    let startDate: Date;
    let endDate: Date;

    if (options.period) {
      const [start, end] = parsePeriod(options.period);
      startDate = new Date(start);
      endDate = new Date(end);
    } else if (options.start_date && options.end_date) {
      validateDate(options.start_date, 'start_date');
      validateDate(options.end_date, 'end_date');
      startDate = new Date(options.start_date);
      endDate = new Date(options.end_date);
    } else {
      // Default to last 6 months
      endDate = new Date();
      startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 6);
    }

    // Filter transactions
    let filtered = allTransactions.filter((t) => {
      const txDate = new Date(t.date);
      return txDate >= startDate && txDate <= endDate && t.amount > 0;
    });

    // Apply additional filters
    if (options.exclude_transfers !== false) {
      filtered = filtered.filter((t) => !isTransferCategory(t.category_id));
    }
    if (options.category) {
      const categoryLower = options.category.toLowerCase();
      filtered = filtered.filter((t) => t.category_id?.toLowerCase().includes(categoryLower));
    }

    // Group by period
    const periodMap = new Map<string, { start: Date; end: Date; total: number; count: number }>();

    for (const t of filtered) {
      const date = new Date(t.date);
      const periodKey = this.getPeriodKey(date, granularity);
      const periodBounds = this.getPeriodBounds(date, granularity);

      let period = periodMap.get(periodKey);
      if (!period) {
        period = {
          start: periodBounds.start,
          end: periodBounds.end,
          total: 0,
          count: 0,
        };
        periodMap.set(periodKey, period);
      }
      period.total += Math.abs(t.amount);
      period.count += 1;
    }

    // Convert to sorted array
    const periods = Array.from(periodMap.entries())
      .sort((a, b) => a[1].start.getTime() - b[1].start.getTime())
      .map(([, data]) => ({
        period_start: data.start.toISOString().substring(0, 10),
        period_end: data.end.toISOString().substring(0, 10),
        total_spending: roundAmount(data.total),
        transaction_count: data.count,
        average_transaction: data.count > 0 ? roundAmount(data.total / data.count) : 0,
      }));

    // Calculate summary
    const totalSpending = periods.reduce((sum, p) => sum + p.total_spending, 0);
    const avgPerPeriod = periods.length > 0 ? roundAmount(totalSpending / periods.length) : 0;

    let highest: { period_start: string; amount: number } | null = null;
    let lowest: { period_start: string; amount: number } | null = null;

    for (const p of periods) {
      if (!highest || p.total_spending > highest.amount) {
        highest = { period_start: p.period_start, amount: p.total_spending };
      }
      if (!lowest || p.total_spending < lowest.amount) {
        lowest = { period_start: p.period_start, amount: p.total_spending };
      }
    }

    return {
      granularity,
      start_date: startDate.toISOString().substring(0, 10),
      end_date: endDate.toISOString().substring(0, 10),
      periods,
      summary: {
        total_spending: roundAmount(totalSpending),
        average_per_period: avgPerPeriod,
        highest_period: highest,
        lowest_period: lowest,
      },
    };
  }

  /**
   * Generate a unique key for grouping transactions by time period.
   *
   * Used internally for aggregating spending data into day, week, or month buckets.
   * - Day: Returns ISO date string (YYYY-MM-DD)
   * - Week: Returns the Sunday start date of the week (YYYY-MM-DD)
   * - Month: Returns year-month string (YYYY-MM)
   *
   * @param date - The date to generate a period key for
   * @param granularity - The time granularity ('day', 'week', or 'month')
   * @returns A string key uniquely identifying the time period
   */
  private getPeriodKey(date: Date, granularity: 'day' | 'week' | 'month'): string {
    if (granularity === 'day') {
      return date.toISOString().substring(0, 10);
    }
    if (granularity === 'week') {
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      return weekStart.toISOString().substring(0, 10);
    }
    // month
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Calculate the start and end dates for a time period containing a given date.
   *
   * Used internally for determining period boundaries when aggregating spending:
   * - Day: Returns the same date for both start and end
   * - Week: Returns Sunday (start) through Saturday (end) of the week
   * - Month: Returns first day through last day of the month
   *
   * @param date - The date to calculate period bounds for
   * @param granularity - The time granularity ('day', 'week', or 'month')
   * @returns Object with start and end Date objects for the period
   */
  private getPeriodBounds(
    date: Date,
    granularity: 'day' | 'week' | 'month'
  ): { start: Date; end: Date } {
    if (granularity === 'day') {
      return { start: new Date(date), end: new Date(date) };
    }
    if (granularity === 'week') {
      const start = new Date(date);
      start.setDate(date.getDate() - date.getDay());
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      return { start, end };
    }
    // month
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return { start, end };
  }

  /**
   * Get average transaction size by category or merchant.
   *
   * Analyzes transaction sizes to identify patterns.
   *
   * @param options - Filter options
   * @returns Average transaction analysis
   */
  async getAverageTransactionSize(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      group_by?: 'category' | 'merchant';
      limit?: number;
    } = {}
  ): Promise<{
    group_by: string;
    overall_average: number;
    groups: Array<{
      name: string;
      average_amount: number;
      transaction_count: number;
      total_amount: number;
      min_amount: number;
      max_amount: number;
    }>;
  }> {
    const allTransactions = await this.db.getTransactions();
    const groupBy = options.group_by || 'category';
    const limit = validateLimit(options.limit, 20);

    // Determine date range
    let startDate: Date;
    let endDate: Date;

    if (options.period) {
      const [start, end] = parsePeriod(options.period);
      startDate = new Date(start);
      endDate = new Date(end);
    } else if (options.start_date && options.end_date) {
      validateDate(options.start_date, 'start_date');
      validateDate(options.end_date, 'end_date');
      startDate = new Date(options.start_date);
      endDate = new Date(options.end_date);
    } else {
      // Default to last 3 months
      endDate = new Date();
      startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 3);
    }

    // Filter transactions (expenses only)
    const filtered = allTransactions.filter((t) => {
      const txDate = new Date(t.date);
      return (
        txDate >= startDate &&
        txDate <= endDate &&
        t.amount > 0 &&
        !isTransferCategory(t.category_id)
      );
    });

    // Group transactions
    const groupMap = new Map<
      string,
      { amounts: number[]; total: number; min: number; max: number }
    >();

    for (const t of filtered) {
      const amount = Math.abs(t.amount);
      let key: string;

      if (groupBy === 'merchant') {
        key = t.name ? normalizeMerchantName(t.name) : 'Unknown';
      } else {
        key = await this.resolveCategoryName(getCategoryIdOrDefault(t.category_id));
      }

      let group = groupMap.get(key);
      if (!group) {
        group = { amounts: [], total: 0, min: Infinity, max: 0 };
        groupMap.set(key, group);
      }
      group.amounts.push(amount);
      group.total += amount;
      group.min = Math.min(group.min, amount);
      group.max = Math.max(group.max, amount);
    }

    // Calculate overall average
    const allAmounts = filtered.map((t) => Math.abs(t.amount));
    const overallAvg =
      allAmounts.length > 0
        ? roundAmount(allAmounts.reduce((a, b) => a + b, 0) / allAmounts.length)
        : 0;

    // Convert to sorted array
    const groups = Array.from(groupMap.entries())
      .map(([name, data]) => ({
        name,
        average_amount: roundAmount(data.total / data.amounts.length),
        transaction_count: data.amounts.length,
        total_amount: roundAmount(data.total),
        min_amount: data.min === Infinity ? 0 : roundAmount(data.min),
        max_amount: roundAmount(data.max),
      }))
      .sort((a, b) => b.transaction_count - a.transaction_count)
      .slice(0, limit);

    return {
      group_by: groupBy,
      overall_average: overallAvg,
      groups,
    };
  }

  /**
   * Get spending trends by category over time.
   *
   * Compares spending in each category across two time periods.
   *
   * @param options - Filter options
   * @returns Category trend analysis
   */
  async getCategoryTrends(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      compare_to_previous?: boolean;
      limit?: number;
    } = {}
  ): Promise<{
    current_period: { start: string; end: string };
    previous_period: { start: string; end: string } | null;
    trends: Array<{
      category: string;
      category_id: string;
      current_amount: number;
      previous_amount: number | null;
      change_amount: number | null;
      change_percentage: number | null;
      trend: 'up' | 'down' | 'stable' | 'new';
    }>;
  }> {
    const allTransactions = await this.db.getTransactions();
    const compareToPrevious = options.compare_to_previous !== false;
    const limit = validateLimit(options.limit, 15);

    // Determine current period date range
    let currentStart: Date;
    let currentEnd: Date;

    if (options.period) {
      const [start, end] = parsePeriod(options.period);
      currentStart = new Date(start);
      currentEnd = new Date(end);
    } else if (options.start_date && options.end_date) {
      validateDate(options.start_date, 'start_date');
      validateDate(options.end_date, 'end_date');
      currentStart = new Date(options.start_date);
      currentEnd = new Date(options.end_date);
    } else {
      // Default to current month
      currentEnd = new Date();
      currentStart = new Date(currentEnd.getFullYear(), currentEnd.getMonth(), 1);
    }

    // Calculate previous period (same duration)
    const durationMs = currentEnd.getTime() - currentStart.getTime();
    const previousEnd = new Date(currentStart.getTime() - 1);
    const previousStart = new Date(previousEnd.getTime() - durationMs);

    // Filter transactions for both periods
    const currentTransactions = allTransactions.filter((t) => {
      const txDate = new Date(t.date);
      return (
        txDate >= currentStart &&
        txDate <= currentEnd &&
        t.amount > 0 &&
        !isTransferCategory(t.category_id)
      );
    });

    const previousTransactions = compareToPrevious
      ? allTransactions.filter((t) => {
          const txDate = new Date(t.date);
          return (
            txDate >= previousStart &&
            txDate <= previousEnd &&
            t.amount > 0 &&
            !isTransferCategory(t.category_id)
          );
        })
      : [];

    // Aggregate by category for current period
    const currentByCategory = new Map<string, { id: string; total: number }>();
    for (const t of currentTransactions) {
      const catId = getCategoryIdOrDefault(t.category_id);
      let catData = currentByCategory.get(catId);
      if (!catData) {
        catData = { id: catId, total: 0 };
        currentByCategory.set(catId, catData);
      }
      catData.total += Math.abs(t.amount);
    }

    // Aggregate by category for previous period
    const previousByCategory = new Map<string, number>();
    for (const t of previousTransactions) {
      const catId = getCategoryIdOrDefault(t.category_id);
      previousByCategory.set(catId, (previousByCategory.get(catId) || 0) + Math.abs(t.amount));
    }

    // Build trends array
    const allCategories = new Set([...currentByCategory.keys(), ...previousByCategory.keys()]);

    const trends: Array<{
      category: string;
      category_id: string;
      current_amount: number;
      previous_amount: number | null;
      change_amount: number | null;
      change_percentage: number | null;
      trend: 'up' | 'down' | 'stable' | 'new';
    }> = [];

    for (const catId of allCategories) {
      const current = currentByCategory.get(catId);
      const previous = previousByCategory.get(catId);

      if (!current && !previous) continue;

      const currentAmount = current?.total || 0;
      const previousAmount = compareToPrevious ? previous || 0 : null;

      let changeAmount: number | null = null;
      let changePercentage: number | null = null;
      let trend: 'up' | 'down' | 'stable' | 'new' = 'stable';

      if (compareToPrevious) {
        if (previousAmount === 0 && currentAmount > 0) {
          trend = 'new';
        } else if (previousAmount !== null && previousAmount > 0) {
          changeAmount = currentAmount - previousAmount;
          changePercentage = Math.round((changeAmount / previousAmount) * 100 * 10) / 10;
          if (changePercentage > 5) trend = 'up';
          else if (changePercentage < -5) trend = 'down';
          else trend = 'stable';
        }
      }

      trends.push({
        category: await this.resolveCategoryName(catId),
        category_id: catId,
        current_amount: roundAmount(currentAmount),
        previous_amount: previousAmount !== null ? roundAmount(previousAmount) : null,
        change_amount: changeAmount !== null ? roundAmount(changeAmount) : null,
        change_percentage: changePercentage,
        trend,
      });
    }

    // Sort by current amount descending and limit
    trends.sort((a, b) => b.current_amount - a.current_amount);
    const limitedTrends = trends.slice(0, limit);

    return {
      current_period: {
        start: currentStart.toISOString().substring(0, 10),
        end: currentEnd.toISOString().substring(0, 10),
      },
      previous_period: compareToPrevious
        ? {
            start: previousStart.toISOString().substring(0, 10),
            end: previousEnd.toISOString().substring(0, 10),
          }
        : null,
      trends: limitedTrends,
    };
  }

  /**
   * Get merchant visit frequency analysis.
   *
   * Shows how often you visit merchants and spending patterns.
   *
   * @param options - Filter options
   * @returns Merchant frequency analysis
   */
  async getMerchantFrequency(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      min_visits?: number;
      limit?: number;
    } = {}
  ): Promise<{
    period: { start: string; end: string };
    merchants: Array<{
      merchant: string;
      visit_count: number;
      total_spent: number;
      average_per_visit: number;
      first_visit: string;
      last_visit: string;
      days_between_visits: number | null;
      visits_per_month: number;
    }>;
    summary: {
      total_merchants: number;
      total_visits: number;
      most_frequent: string | null;
      highest_spending: string | null;
    };
  }> {
    const allTransactions = await this.db.getTransactions();
    const minVisits = options.min_visits || 2;
    const limit = validateLimit(options.limit, 20);

    // Determine date range
    let startDate: Date;
    let endDate: Date;

    if (options.period) {
      const [start, end] = parsePeriod(options.period);
      startDate = new Date(start);
      endDate = new Date(end);
    } else if (options.start_date && options.end_date) {
      validateDate(options.start_date, 'start_date');
      validateDate(options.end_date, 'end_date');
      startDate = new Date(options.start_date);
      endDate = new Date(options.end_date);
    } else {
      // Default to last 6 months
      endDate = new Date();
      startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 6);
    }

    // Filter transactions (expenses only, exclude transfers)
    const filtered = allTransactions.filter((t) => {
      const txDate = new Date(t.date);
      return (
        txDate >= startDate &&
        txDate <= endDate &&
        t.amount > 0 &&
        !isTransferCategory(t.category_id) &&
        t.name
      );
    });

    // Group by merchant
    const merchantMap = new Map<string, { dates: Date[]; total: number }>();

    for (const t of filtered) {
      const merchant = t.name ? normalizeMerchantName(t.name) : 'Unknown';

      let data = merchantMap.get(merchant);
      if (!data) {
        data = { dates: [], total: 0 };
        merchantMap.set(merchant, data);
      }
      data.dates.push(new Date(t.date));
      data.total += Math.abs(t.amount);
    }

    // Calculate months in period for visits_per_month
    const monthsInPeriod = Math.max(
      1,
      (endDate.getTime() - startDate.getTime()) / (30 * 24 * 60 * 60 * 1000)
    );

    // Convert to sorted array
    const merchants = Array.from(merchantMap.entries())
      .filter(([, data]) => data.dates.length >= minVisits)
      .map(([merchant, data]) => {
        data.dates.sort((a, b) => a.getTime() - b.getTime());
        const visitCount = data.dates.length;
        const firstVisit = data.dates[0] as Date;
        const lastVisit = data.dates[data.dates.length - 1] as Date;

        let daysBetween: number | null = null;
        if (visitCount > 1) {
          const totalDays = (lastVisit.getTime() - firstVisit.getTime()) / (24 * 60 * 60 * 1000);
          daysBetween = Math.round(totalDays / (visitCount - 1));
        }

        return {
          merchant,
          visit_count: visitCount,
          total_spent: roundAmount(data.total),
          average_per_visit: roundAmount(data.total / visitCount),
          first_visit: firstVisit.toISOString().substring(0, 10),
          last_visit: lastVisit.toISOString().substring(0, 10),
          days_between_visits: daysBetween,
          visits_per_month: Math.round((visitCount / monthsInPeriod) * 10) / 10,
        };
      })
      .sort((a, b) => b.visit_count - a.visit_count)
      .slice(0, limit);

    // Summary
    const mostFrequent = merchants[0]?.merchant ?? null;
    const sortedBySpending = [...merchants].sort((a, b) => b.total_spent - a.total_spent);
    const highestSpending = sortedBySpending[0]?.merchant ?? null;

    return {
      period: {
        start: startDate.toISOString().substring(0, 10),
        end: endDate.toISOString().substring(0, 10),
      },
      merchants,
      summary: {
        total_merchants: merchants.length,
        total_visits: merchants.reduce((sum, m) => sum + m.visit_count, 0),
        most_frequent: mostFrequent,
        highest_spending: highestSpending,
      },
    };
  }

  // ---- Budget Analytics ----

  /**
   * Get budget utilization for all budgets.
   *
   * Shows how much of each budget has been used.
   *
   * @param options - Filter options
   * @returns Budget utilization data
   */
  async getBudgetUtilization(
    options: {
      month?: string;
      category?: string;
      include_inactive?: boolean;
    } = {}
  ): Promise<{
    month: string;
    budgets: Array<{
      budget_id: string;
      category: string;
      category_id: string;
      budget_amount: number;
      spent_amount: number;
      remaining: number;
      utilization_percentage: number;
      status: 'under' | 'on_track' | 'over';
    }>;
    summary: {
      total_budgeted: number;
      total_spent: number;
      overall_utilization: number;
      over_budget_count: number;
    };
  }> {
    const budgets = await this.db.getBudgets();
    const transactions = await this.db.getTransactions();

    // Determine month
    let targetMonth: string;
    if (options.month) {
      if (!/^\d{4}-\d{2}$/.test(options.month)) {
        throw new Error('Invalid month format. Expected YYYY-MM');
      }
      targetMonth = options.month;
    } else {
      const now = new Date();
      targetMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    // Filter budgets
    let filtered = budgets;
    if (!options.include_inactive) {
      filtered = filtered.filter((b) => b.is_active !== false);
    }
    if (options.category) {
      const categoryLower = options.category.toLowerCase();
      filtered = filtered.filter(
        (b) =>
          b.category_id?.toLowerCase().includes(categoryLower) ||
          b.name?.toLowerCase().includes(categoryLower)
      );
    }

    // Calculate spending for the month
    const monthStart = `${targetMonth}-01`;
    const monthEnd = `${targetMonth}-31`;

    const monthTransactions = transactions.filter((t) => {
      return (
        t.date >= monthStart &&
        t.date <= monthEnd &&
        t.amount > 0 &&
        !isTransferCategory(t.category_id)
      );
    });

    // Group spending by category
    const spendingByCategory = new Map<string, number>();
    for (const t of monthTransactions) {
      const catId = getCategoryIdOrDefault(t.category_id);
      spendingByCategory.set(catId, (spendingByCategory.get(catId) || 0) + Math.abs(t.amount));
    }

    // Build utilization data
    const utilizationData = await Promise.all(
      filtered.map(async (b) => {
        const categoryId = b.category_id || '';
        const spent = spendingByCategory.get(categoryId) || 0;
        const budgetAmount = b.amount || 0;
        const remaining = budgetAmount - spent;
        const utilization = budgetAmount > 0 ? (spent / budgetAmount) * 100 : 0;

        let status: 'under' | 'on_track' | 'over' = 'under';
        if (utilization >= 100) {
          status = 'over';
        } else if (utilization >= 75) {
          status = 'on_track';
        }

        return {
          budget_id: b.budget_id,
          category: await this.resolveCategoryName(categoryId),
          category_id: categoryId,
          budget_amount: roundAmount(budgetAmount),
          spent_amount: roundAmount(spent),
          remaining: roundAmount(remaining),
          utilization_percentage: Math.round(utilization * 10) / 10,
          status,
        };
      })
    );

    // Sort by utilization descending
    utilizationData.sort((a, b) => b.utilization_percentage - a.utilization_percentage);

    // Summary
    const totalBudgeted = utilizationData.reduce((sum, b) => sum + b.budget_amount, 0);
    const totalSpent = utilizationData.reduce((sum, b) => sum + b.spent_amount, 0);
    const overBudgetCount = utilizationData.filter((b) => b.status === 'over').length;

    return {
      month: targetMonth,
      budgets: utilizationData,
      summary: {
        total_budgeted: roundAmount(totalBudgeted),
        total_spent: roundAmount(totalSpent),
        overall_utilization:
          totalBudgeted > 0 ? Math.round((totalSpent / totalBudgeted) * 100 * 10) / 10 : 0,
        over_budget_count: overBudgetCount,
      },
    };
  }

  /**
   * Compare budgets to actual spending over multiple months.
   *
   * Shows how budgets compare to actual spending historically.
   *
   * @param options - Filter options
   * @returns Budget vs actual comparison data
   */
  async getBudgetVsActual(
    options: {
      months?: number;
      category?: string;
    } = {}
  ): Promise<{
    months_analyzed: number;
    comparisons: Array<{
      month: string;
      total_budgeted: number;
      total_actual: number;
      difference: number;
      variance_percentage: number;
    }>;
    category_breakdown: Array<{
      category: string;
      category_id: string;
      avg_budgeted: number;
      avg_actual: number;
      consistency_score: number;
    }>;
    insights: {
      most_accurate_month: string | null;
      least_accurate_month: string | null;
      avg_variance: number;
    };
  }> {
    const numMonths = options.months || 6;
    const budgets = (await this.db.getBudgets()).filter((b) => b.is_active !== false);
    const transactions = await this.db.getTransactions();

    // Generate list of months to analyze
    const months: string[] = [];
    const now = new Date();
    for (let i = 0; i < numMonths; i++) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`);
    }

    // Filter budgets by category if specified
    let filteredBudgets = budgets;
    if (options.category) {
      const categoryLower = options.category.toLowerCase();
      filteredBudgets = budgets.filter(
        (b) =>
          b.category_id?.toLowerCase().includes(categoryLower) ||
          b.name?.toLowerCase().includes(categoryLower)
      );
    }

    // Calculate total budgeted amount
    const totalBudgetedPerMonth = filteredBudgets.reduce((sum, b) => sum + (b.amount || 0), 0);

    // Analyze each month
    const comparisons = months.map((month) => {
      const monthStart = `${month}-01`;
      const monthEnd = `${month}-31`;

      const monthTransactions = transactions.filter((t) => {
        const matchesCategory =
          !options.category ||
          t.category_id?.toLowerCase().includes(options.category.toLowerCase());
        return (
          t.date >= monthStart &&
          t.date <= monthEnd &&
          t.amount > 0 &&
          !isTransferCategory(t.category_id) &&
          matchesCategory
        );
      });

      const totalActual = monthTransactions.reduce((sum, t) => sum + Math.abs(t.amount), 0);
      const difference = totalBudgetedPerMonth - totalActual;
      const variance = totalBudgetedPerMonth > 0 ? (difference / totalBudgetedPerMonth) * 100 : 0;

      return {
        month,
        total_budgeted: roundAmount(totalBudgetedPerMonth),
        total_actual: roundAmount(totalActual),
        difference: roundAmount(difference),
        variance_percentage: Math.round(variance * 10) / 10,
      };
    });

    // Category breakdown
    const categoryData = new Map<string, { budgeted: number; actuals: number[] }>();

    for (const b of filteredBudgets) {
      const catId = getCategoryIdOrDefault(b.category_id);
      let catData = categoryData.get(catId);
      if (!catData) {
        catData = { budgeted: 0, actuals: [] };
        categoryData.set(catId, catData);
      }
      catData.budgeted += b.amount || 0;
    }

    // Get actual spending per category
    for (const month of months) {
      const monthStart = `${month}-01`;
      const monthEnd = `${month}-31`;

      for (const [catId, data] of categoryData.entries()) {
        const spent = transactions
          .filter(
            (t) =>
              t.date >= monthStart && t.date <= monthEnd && t.category_id === catId && t.amount > 0
          )
          .reduce((sum, t) => sum + Math.abs(t.amount), 0);
        data.actuals.push(spent);
      }
    }

    const categoryBreakdown = await Promise.all(
      Array.from(categoryData.entries()).map(async ([catId, data]) => {
        const avgBudgeted = data.budgeted;
        const avgActual =
          data.actuals.length > 0
            ? data.actuals.reduce((a, b) => a + b, 0) / data.actuals.length
            : 0;

        // Calculate consistency (lower variance = higher score)
        const variance =
          data.actuals.length > 0
            ? data.actuals.reduce((sum, v) => sum + Math.pow(v - avgActual, 2), 0) /
              data.actuals.length
            : 0;
        const stdDev = Math.sqrt(variance);
        const consistencyScore =
          avgActual > 0 ? Math.max(0, 100 - (stdDev / avgActual) * 100) : 100;

        return {
          category: await this.resolveCategoryName(catId),
          category_id: catId,
          avg_budgeted: roundAmount(avgBudgeted),
          avg_actual: roundAmount(avgActual),
          consistency_score: Math.round(consistencyScore),
        };
      })
    );

    // Insights
    const sortedByVariance = [...comparisons].sort(
      (a, b) => Math.abs(a.variance_percentage) - Math.abs(b.variance_percentage)
    );
    const avgVariance =
      comparisons.length > 0
        ? comparisons.reduce((sum, c) => sum + Math.abs(c.variance_percentage), 0) /
          comparisons.length
        : 0;

    return {
      months_analyzed: numMonths,
      comparisons,
      category_breakdown: categoryBreakdown.sort((a, b) => b.avg_actual - a.avg_actual),
      insights: {
        most_accurate_month: sortedByVariance[0]?.month ?? null,
        least_accurate_month: sortedByVariance[sortedByVariance.length - 1]?.month ?? null,
        avg_variance: Math.round(avgVariance * 10) / 10,
      },
    };
  }

  /**
   * Get budget recommendations based on spending patterns.
   *
   * Suggests budget adjustments based on historical data.
   *
   * @param options - Filter options
   * @returns Budget recommendations
   */
  async getBudgetRecommendations(
    options: {
      months?: number;
    } = {}
  ): Promise<{
    recommendations: Array<{
      category: string;
      category_id: string;
      current_budget: number | null;
      recommended_budget: number;
      avg_spending: number;
      confidence: 'high' | 'medium' | 'low';
      reason: string;
    }>;
    new_budget_suggestions: Array<{
      category: string;
      category_id: string;
      avg_spending: number;
      suggested_budget: number;
      reason: string;
    }>;
    summary: {
      total_current_budget: number;
      total_recommended: number;
      potential_savings: number;
    };
  }> {
    const numMonths = options.months || 3;
    const budgets = (await this.db.getBudgets()).filter((b) => b.is_active !== false);
    const transactions = await this.db.getTransactions();

    // Generate list of months to analyze
    const months: string[] = [];
    const now = new Date();
    for (let i = 0; i < numMonths; i++) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`);
    }

    // Calculate average spending by category
    const categorySpending = new Map<string, number[]>();

    for (const month of months) {
      const monthStart = `${month}-01`;
      const monthEnd = `${month}-31`;

      const monthTxns = transactions.filter(
        (t) =>
          t.date >= monthStart &&
          t.date <= monthEnd &&
          t.amount > 0 &&
          !isTransferCategory(t.category_id)
      );

      const spendingThisMonth = new Map<string, number>();
      for (const t of monthTxns) {
        const catId = getCategoryIdOrDefault(t.category_id);
        spendingThisMonth.set(catId, (spendingThisMonth.get(catId) || 0) + Math.abs(t.amount));
      }

      for (const [catId, amount] of spendingThisMonth.entries()) {
        let spending = categorySpending.get(catId);
        if (!spending) {
          spending = [];
          categorySpending.set(catId, spending);
        }
        spending.push(amount);
      }
    }

    // Build budget map
    const budgetMap = new Map<string, number>();
    for (const b of budgets) {
      const catId = b.category_id || '';
      budgetMap.set(catId, b.amount || 0);
    }

    // Generate recommendations for existing budgets
    const recommendations: Array<{
      category: string;
      category_id: string;
      current_budget: number | null;
      recommended_budget: number;
      avg_spending: number;
      confidence: 'high' | 'medium' | 'low';
      reason: string;
    }> = [];

    for (const b of budgets) {
      const catId = b.category_id || '';
      const spending = categorySpending.get(catId) || [];
      const currentBudget = b.amount || 0;

      if (spending.length === 0) continue;

      const avgSpending = spending.reduce((a, b) => a + b, 0) / spending.length;
      const variance =
        spending.reduce((sum, v) => sum + Math.pow(v - avgSpending, 2), 0) / spending.length;
      const stdDev = Math.sqrt(variance);

      // Confidence based on variance
      let confidence: 'high' | 'medium' | 'low' = 'high';
      const cv = avgSpending > 0 ? stdDev / avgSpending : 0;
      if (cv > 0.5) confidence = 'low';
      else if (cv > 0.25) confidence = 'medium';

      // Recommended budget: average + 10% buffer
      const recommendedBudget = roundAmount(avgSpending * 1.1);
      const diff = currentBudget - recommendedBudget;
      const diffPercent = currentBudget > 0 ? (diff / currentBudget) * 100 : 0;

      let reason = 'Budget appears well-calibrated';
      if (diffPercent > 20) {
        reason = `Budget may be ${Math.round(diffPercent)}% higher than needed`;
      } else if (diffPercent < -20) {
        reason = `Budget may be ${Math.abs(Math.round(diffPercent))}% too low`;
      }

      recommendations.push({
        category: await this.resolveCategoryName(catId),
        category_id: catId,
        current_budget: currentBudget,
        recommended_budget: recommendedBudget,
        avg_spending: roundAmount(avgSpending),
        confidence,
        reason,
      });
    }

    // Suggest new budgets for categories without budgets
    const newBudgetSuggestions: Array<{
      category: string;
      category_id: string;
      avg_spending: number;
      suggested_budget: number;
      reason: string;
    }> = [];

    for (const [catId, spending] of categorySpending.entries()) {
      if (!budgetMap.has(catId) && spending.length >= 2) {
        const avgSpending = spending.reduce((a, b) => a + b, 0) / spending.length;
        if (avgSpending >= 50) {
          // Only suggest for significant spending
          newBudgetSuggestions.push({
            category: await this.resolveCategoryName(catId),
            category_id: catId,
            avg_spending: roundAmount(avgSpending),
            suggested_budget: roundAmount(avgSpending * 1.1),
            reason: `Consistent spending of $${Math.round(avgSpending)}/month detected`,
          });
        }
      }
    }

    // Sort suggestions by spending
    newBudgetSuggestions.sort((a, b) => b.avg_spending - a.avg_spending);

    // Summary
    const totalCurrent = recommendations.reduce((sum, r) => sum + (r.current_budget || 0), 0);
    const totalRecommended = recommendations.reduce((sum, r) => sum + r.recommended_budget, 0);

    return {
      recommendations: recommendations.sort((a, b) => b.avg_spending - a.avg_spending),
      new_budget_suggestions: newBudgetSuggestions.slice(0, 10),
      summary: {
        total_current_budget: roundAmount(totalCurrent),
        total_recommended: roundAmount(totalRecommended),
        potential_savings: roundAmount(totalCurrent - totalRecommended),
      },
    };
  }

  /**
   * Get budget alerts for categories approaching or exceeding limits.
   *
   * Identifies budgets that need attention.
   *
   * @param options - Filter options
   * @returns Budget alerts
   */
  async getBudgetAlerts(
    options: {
      threshold_percentage?: number;
      month?: string;
    } = {}
  ): Promise<{
    month: string;
    alerts: Array<{
      budget_id: string;
      category: string;
      category_id: string;
      alert_type: 'exceeded' | 'warning' | 'approaching';
      budget_amount: number;
      spent_amount: number;
      utilization_percentage: number;
      days_remaining: number;
      projected_total: number | null;
      message: string;
    }>;
    summary: {
      exceeded_count: number;
      warning_count: number;
      approaching_count: number;
      total_over_budget: number;
    };
  }> {
    const threshold = options.threshold_percentage || 80;
    const budgets = (await this.db.getBudgets()).filter((b) => b.is_active !== false);
    const transactions = await this.db.getTransactions();

    // Determine month
    let targetMonth: string;
    if (options.month) {
      if (!/^\d{4}-\d{2}$/.test(options.month)) {
        throw new Error('Invalid month format. Expected YYYY-MM');
      }
      targetMonth = options.month;
    } else {
      const now = new Date();
      targetMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    // Calculate days in month and remaining
    const parts = targetMonth.split('-').map(Number);
    const year = parts[0] ?? new Date().getFullYear();
    const month = parts[1] ?? 1;
    const daysInMonth = new Date(year, month, 0).getDate();
    const today = new Date();
    const currentDay =
      today.getFullYear() === year && today.getMonth() + 1 === month
        ? today.getDate()
        : daysInMonth;
    const daysRemaining = Math.max(0, daysInMonth - currentDay);

    // Calculate spending for the month
    const monthStart = `${targetMonth}-01`;
    const monthEnd = `${targetMonth}-31`;

    const monthTransactions = transactions.filter((t) => {
      return (
        t.date >= monthStart &&
        t.date <= monthEnd &&
        t.amount > 0 &&
        !isTransferCategory(t.category_id)
      );
    });

    // Group spending by category
    const spendingByCategory = new Map<string, number>();
    for (const t of monthTransactions) {
      const catId = getCategoryIdOrDefault(t.category_id);
      spendingByCategory.set(catId, (spendingByCategory.get(catId) || 0) + Math.abs(t.amount));
    }

    // Generate alerts
    const alerts: Array<{
      budget_id: string;
      category: string;
      category_id: string;
      alert_type: 'exceeded' | 'warning' | 'approaching';
      budget_amount: number;
      spent_amount: number;
      utilization_percentage: number;
      days_remaining: number;
      projected_total: number | null;
      message: string;
    }> = [];

    for (const b of budgets) {
      const categoryId = b.category_id || '';
      const budgetAmount = b.amount || 0;
      const spent = spendingByCategory.get(categoryId) || 0;
      const utilization = budgetAmount > 0 ? (spent / budgetAmount) * 100 : 0;

      // Skip if below threshold
      if (utilization < threshold) continue;

      // Calculate projected spending
      let projectedTotal: number | null = null;
      if (currentDay > 0 && daysRemaining > 0) {
        const dailyRate = spent / currentDay;
        projectedTotal = roundAmount(dailyRate * daysInMonth);
      }

      // Determine alert type and message
      let alertType: 'exceeded' | 'warning' | 'approaching' = 'approaching';
      let message = '';

      if (utilization >= 100) {
        alertType = 'exceeded';
        const overAmount = roundAmount(spent - budgetAmount);
        message = `Over budget by $${overAmount}`;
      } else if (utilization >= 90) {
        alertType = 'warning';
        const remaining = roundAmount(budgetAmount - spent);
        message = `Only $${remaining} remaining with ${daysRemaining} days left`;
      } else {
        alertType = 'approaching';
        message = `${Math.round(utilization)}% used - on pace to ${
          projectedTotal && projectedTotal > budgetAmount ? 'exceed' : 'stay within'
        } budget`;
      }

      alerts.push({
        budget_id: b.budget_id,
        category: await this.resolveCategoryName(categoryId),
        category_id: categoryId,
        alert_type: alertType,
        budget_amount: roundAmount(budgetAmount),
        spent_amount: roundAmount(spent),
        utilization_percentage: Math.round(utilization * 10) / 10,
        days_remaining: daysRemaining,
        projected_total: projectedTotal,
        message,
      });
    }

    // Sort by severity (exceeded first, then by utilization)
    alerts.sort((a, b) => {
      const severityOrder = { exceeded: 0, warning: 1, approaching: 2 };
      const aSeverity = severityOrder[a.alert_type];
      const bSeverity = severityOrder[b.alert_type];
      if (aSeverity !== bSeverity) return aSeverity - bSeverity;
      return b.utilization_percentage - a.utilization_percentage;
    });

    // Summary
    const exceededAlerts = alerts.filter((a) => a.alert_type === 'exceeded');
    const totalOverBudget = exceededAlerts.reduce(
      (sum, a) => sum + (a.spent_amount - a.budget_amount),
      0
    );

    return {
      month: targetMonth,
      alerts,
      summary: {
        exceeded_count: exceededAlerts.length,
        warning_count: alerts.filter((a) => a.alert_type === 'warning').length,
        approaching_count: alerts.filter((a) => a.alert_type === 'approaching').length,
        total_over_budget: roundAmount(totalOverBudget),
      },
    };
  }

  // ============================================
  // PHASE 12.3: INVESTMENT ANALYTICS TOOLS
  // ============================================

  /**
   * Get portfolio allocation across investment accounts and securities.
   *
   * Shows how investments are distributed across different accounts, asset types,
   * and individual securities. Useful for understanding diversification.
   *
   * @param options - Filter options
   * @returns Object with portfolio allocation data
   */
  async getPortfolioAllocation(options: { include_prices?: boolean } = {}): Promise<{
    total_value: number;
    account_count: number;
    by_account: Array<{
      account_id: string;
      account_name: string;
      institution: string;
      balance: number;
      percentage: number;
    }>;
    by_security: Array<{
      ticker_symbol: string;
      latest_price?: number;
      price_date?: string;
    }>;
    summary: {
      largest_account: string | null;
      largest_account_percentage: number;
      security_count: number;
    };
  }> {
    const { include_prices = true } = options;

    // Get investment accounts
    const accounts = await this.db.getAccounts();
    const investmentAccounts = accounts.filter(
      (a) =>
        a.account_type?.toLowerCase() === 'investment' ||
        a.subtype?.toLowerCase().includes('brokerage') ||
        a.subtype?.toLowerCase().includes('401k') ||
        a.subtype?.toLowerCase().includes('ira') ||
        a.subtype?.toLowerCase().includes('roth')
    );

    // Calculate totals
    const totalValue = investmentAccounts.reduce((sum, a) => sum + (a.current_balance || 0), 0);

    // Build account allocation
    const byAccount = await Promise.all(
      investmentAccounts.map(async (a) => ({
        account_id: a.account_id,
        account_name: await this.resolveAccountName(a),
        institution: a.institution_name || 'Unknown',
        balance: roundAmount(a.current_balance || 0),
        percentage:
          totalValue > 0 ? Math.round(((a.current_balance || 0) / totalValue) * 1000) / 10 : 0,
      }))
    );

    // Sort by balance descending
    byAccount.sort((a, b) => b.balance - a.balance);

    // Get securities from investment prices
    let bySecurity: Array<{
      ticker_symbol: string;
      latest_price?: number;
      price_date?: string;
    }> = [];

    if (include_prices) {
      const prices = await this.db.getInvestmentPrices({});

      // Group by ticker and get latest price
      const latestByTicker = new Map<string, { ticker: string; price?: number; date?: string }>();

      for (const p of prices) {
        const ticker = p.ticker_symbol || p.investment_id;
        const existing = latestByTicker.get(ticker);
        const priceDate = getPriceDate(p);
        const existingDate = existing?.date;

        if (!existing || (priceDate && existingDate && priceDate > existingDate)) {
          latestByTicker.set(ticker, {
            ticker,
            price: getBestPrice(p),
            date: priceDate,
          });
        }
      }

      bySecurity = Array.from(latestByTicker.values())
        .map((s) => ({
          ticker_symbol: s.ticker,
          latest_price: s.price ? roundAmount(s.price) : undefined,
          price_date: s.date,
        }))
        .sort((a, b) => a.ticker_symbol.localeCompare(b.ticker_symbol));
    }

    // Summary
    const largestAccount = byAccount[0] ?? null;

    return {
      total_value: roundAmount(totalValue),
      account_count: investmentAccounts.length,
      by_account: byAccount,
      by_security: bySecurity,
      summary: {
        largest_account: largestAccount?.account_name ?? null,
        largest_account_percentage: largestAccount?.percentage ?? 0,
        security_count: bySecurity.length,
      },
    };
  }

  /**
   * Get investment performance metrics.
   *
   * Calculates performance based on price history including returns,
   * highs/lows, and volatility indicators.
   *
   * @param options - Filter options
   * @returns Object with investment performance data
   */
  async getInvestmentPerformance(
    options: {
      ticker_symbol?: string;
      period?: string;
      start_date?: string;
      end_date?: string;
    } = {}
  ): Promise<{
    period: {
      start_date: string;
      end_date: string;
    };
    performance: Array<{
      ticker_symbol: string;
      start_price: number | null;
      end_price: number | null;
      high_price: number | null;
      low_price: number | null;
      price_change: number | null;
      percent_change: number | null;
      data_points: number;
      trend: 'up' | 'down' | 'flat' | 'unknown';
    }>;
    summary: {
      total_securities: number;
      gainers: number;
      losers: number;
      best_performer: string | null;
      worst_performer: string | null;
      best_return: number | null;
      worst_return: number | null;
    };
  }> {
    const { ticker_symbol, period = 'last_30_days' } = options;
    let { start_date, end_date } = options;

    // Parse period to get date range
    if (!start_date || !end_date) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Get price data
    const prices = await this.db.getInvestmentPrices({
      tickerSymbol: ticker_symbol,
      startDate: start_date,
      endDate: end_date,
    });

    // Group by ticker
    const byTicker = new Map<string, Array<{ date: string; price: number }>>();

    for (const p of prices) {
      const ticker = p.ticker_symbol || p.investment_id;
      const price = getBestPrice(p);
      const date = getPriceDate(p);

      if (price && date) {
        let tickerData = byTicker.get(ticker);
        if (!tickerData) {
          tickerData = [];
          byTicker.set(ticker, tickerData);
        }
        tickerData.push({ date, price });
      }
    }

    // Calculate performance for each ticker
    const performance: Array<{
      ticker_symbol: string;
      start_price: number | null;
      end_price: number | null;
      high_price: number | null;
      low_price: number | null;
      price_change: number | null;
      percent_change: number | null;
      data_points: number;
      trend: 'up' | 'down' | 'flat' | 'unknown';
    }> = [];

    for (const [ticker, priceData] of byTicker) {
      // Sort by date
      priceData.sort((a, b) => a.date.localeCompare(b.date));

      const dataPoints = priceData.length;
      if (dataPoints === 0) continue;

      const startPrice = priceData[0]?.price ?? null;
      const endPrice = priceData[dataPoints - 1]?.price ?? null;
      const highPrice = Math.max(...priceData.map((p) => p.price));
      const lowPrice = Math.min(...priceData.map((p) => p.price));

      let priceChange: number | null = null;
      let percentChange: number | null = null;
      let trend: 'up' | 'down' | 'flat' | 'unknown' = 'unknown';

      if (startPrice !== null && endPrice !== null) {
        priceChange = roundAmount(endPrice - startPrice);
        percentChange =
          startPrice !== 0 ? roundAmount(((endPrice - startPrice) / startPrice) * 100) : null;

        if (percentChange !== null) {
          if (percentChange > 0.5) trend = 'up';
          else if (percentChange < -0.5) trend = 'down';
          else trend = 'flat';
        }
      }

      performance.push({
        ticker_symbol: ticker,
        start_price: startPrice ? roundAmount(startPrice) : null,
        end_price: endPrice ? roundAmount(endPrice) : null,
        high_price: roundAmount(highPrice),
        low_price: roundAmount(lowPrice),
        price_change: priceChange,
        percent_change: percentChange,
        data_points: dataPoints,
        trend,
      });
    }

    // Sort by percent change descending
    performance.sort((a, b) => (b.percent_change ?? -Infinity) - (a.percent_change ?? -Infinity));

    // Summary
    const gainers = performance.filter((p) => (p.percent_change ?? 0) > 0).length;
    const losers = performance.filter((p) => (p.percent_change ?? 0) < 0).length;
    const bestPerformer = performance[0] ?? null;
    const worstPerformer = performance[performance.length - 1] ?? null;

    return {
      period: {
        start_date: start_date,
        end_date: end_date,
      },
      performance,
      summary: {
        total_securities: performance.length,
        gainers,
        losers,
        best_performer: bestPerformer?.ticker_symbol ?? null,
        worst_performer: worstPerformer?.ticker_symbol ?? null,
        best_return: bestPerformer?.percent_change ?? null,
        worst_return: worstPerformer?.percent_change ?? null,
      },
    };
  }

  /**
   * Get dividend income from investments.
   *
   * Tracks dividend payments received from investment accounts.
   *
   * @param options - Filter options
   * @returns Object with dividend income data
   */
  async getDividendIncome(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      account_id?: string;
    } = {}
  ): Promise<{
    period: {
      start_date: string;
      end_date: string;
    };
    total_dividends: number;
    dividend_count: number;
    dividends: Array<{
      transaction_id: string;
      date: string;
      amount: number;
      name: string;
      account_id?: string;
    }>;
    by_month: Array<{
      month: string;
      amount: number;
      count: number;
    }>;
    by_source: Array<{
      source: string;
      amount: number;
      count: number;
    }>;
    summary: {
      average_dividend: number;
      largest_dividend: number;
      monthly_average: number;
    };
  }> {
    const { period = 'ytd', account_id } = options;
    let { start_date, end_date } = options;

    // Parse period to get date range
    if (!start_date || !end_date) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Dividend-related category IDs
    const dividendCategories = new Set(['dividend', 'income_dividends', 'capital_gain']);

    // Get transactions that are dividend income
    const transactions = await this.db.getTransactions();
    const dividends = transactions.filter((t) => {
      // Date filter
      if (t.date < start_date || t.date > end_date) return false;

      // Account filter
      if (account_id && t.account_id !== account_id) return false;

      // Must be income (negative amount) or match dividend category
      const categoryId = t.category_id?.toLowerCase() || '';
      const isDividendCategory = dividendCategories.has(categoryId);
      const hasDividendKeyword =
        t.name?.toLowerCase().includes('dividend') ||
        t.name?.toLowerCase().includes('div ') ||
        t.original_name?.toLowerCase().includes('dividend');

      return isDividendCategory || (t.amount < 0 && hasDividendKeyword);
    });

    // Calculate totals (dividends are negative amounts in the system)
    const totalDividends = Math.abs(dividends.reduce((sum, t) => sum + t.amount, 0));

    // Format dividends list
    const formattedDividends = dividends.map((t) => ({
      transaction_id: t.transaction_id,
      date: t.date,
      amount: Math.abs(roundAmount(t.amount)),
      name: t.name || t.original_name || 'Unknown',
      account_id: t.account_id,
    }));

    // Sort by date descending
    formattedDividends.sort((a, b) => b.date.localeCompare(a.date));

    // Group by month
    const monthlyMap = new Map<string, { amount: number; count: number }>();
    for (const d of formattedDividends) {
      const month = d.date.substring(0, 7);
      const existing = monthlyMap.get(month) || { amount: 0, count: 0 };
      existing.amount += d.amount;
      existing.count += 1;
      monthlyMap.set(month, existing);
    }

    const byMonth = Array.from(monthlyMap.entries())
      .map(([month, data]) => ({
        month,
        amount: roundAmount(data.amount),
        count: data.count,
      }))
      .sort((a, b) => b.month.localeCompare(a.month));

    // Group by source (merchant name)
    const sourceMap = new Map<string, { amount: number; count: number }>();
    for (const d of formattedDividends) {
      const source = d.name;
      const existing = sourceMap.get(source) || { amount: 0, count: 0 };
      existing.amount += d.amount;
      existing.count += 1;
      sourceMap.set(source, existing);
    }

    const bySource = Array.from(sourceMap.entries())
      .map(([source, data]) => ({
        source,
        amount: roundAmount(data.amount),
        count: data.count,
      }))
      .sort((a, b) => b.amount - a.amount);

    // Summary calculations
    const avgDividend =
      formattedDividends.length > 0 ? roundAmount(totalDividends / formattedDividends.length) : 0;
    const largestDividend =
      formattedDividends.length > 0 ? Math.max(...formattedDividends.map((d) => d.amount)) : 0;
    const monthlyAvg = byMonth.length > 0 ? roundAmount(totalDividends / byMonth.length) : 0;

    return {
      period: {
        start_date: start_date,
        end_date: end_date,
      },
      total_dividends: roundAmount(totalDividends),
      dividend_count: formattedDividends.length,
      dividends: formattedDividends,
      by_month: byMonth,
      by_source: bySource,
      summary: {
        average_dividend: avgDividend,
        largest_dividend: roundAmount(largestDividend),
        monthly_average: monthlyAvg,
      },
    };
  }

  /**
   * Get investment-related fees.
   *
   * Tracks fees associated with investment accounts like management fees,
   * trading commissions, expense ratios, etc.
   *
   * @param options - Filter options
   * @returns Object with investment fee data
   */
  async getInvestmentFees(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      account_id?: string;
    } = {}
  ): Promise<{
    period: {
      start_date: string;
      end_date: string;
    };
    total_fees: number;
    fee_count: number;
    fees: Array<{
      transaction_id: string;
      date: string;
      amount: number;
      name: string;
      fee_type: string;
      account_id?: string;
    }>;
    by_type: Array<{
      fee_type: string;
      amount: number;
      count: number;
    }>;
    by_month: Array<{
      month: string;
      amount: number;
      count: number;
    }>;
    summary: {
      average_fee: number;
      largest_fee: number;
      monthly_average: number;
    };
  }> {
    const { period = 'ytd', account_id } = options;
    let { start_date, end_date } = options;

    // Parse period to get date range
    if (!start_date || !end_date) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Get investment accounts
    const accounts = await this.db.getAccounts();
    const investmentAccountIds = new Set(
      accounts
        .filter(
          (a) =>
            a.account_type?.toLowerCase() === 'investment' ||
            a.subtype?.toLowerCase().includes('brokerage') ||
            a.subtype?.toLowerCase().includes('401k') ||
            a.subtype?.toLowerCase().includes('ira')
        )
        .map((a) => a.account_id)
    );

    // Fee-related keywords
    const feeKeywords = [
      'fee',
      'commission',
      'expense',
      'management',
      'advisory',
      'custodian',
      'trading',
      'margin',
    ];

    // Get transactions that are investment fees
    const transactions = await this.db.getTransactions();
    const fees = transactions.filter((t) => {
      // Date filter
      if (t.date < start_date || t.date > end_date) return false;

      // Account filter - if specified use it, otherwise filter by investment accounts
      if (account_id) {
        if (t.account_id !== account_id) return false;
      } else {
        // Only include transactions from investment accounts
        if (!t.account_id || !investmentAccountIds.has(t.account_id)) return false;
      }

      // Must be an expense (positive amount) and match fee keywords
      if (t.amount <= 0) return false;

      const name = (t.name || t.original_name || '').toLowerCase();
      return feeKeywords.some((keyword) => name.includes(keyword));
    });

    // Calculate totals
    const totalFees = fees.reduce((sum, t) => sum + t.amount, 0);

    // Classify fee type
    const classifyFeeType = (name: string): string => {
      const lowerName = name.toLowerCase();
      if (lowerName.includes('management') || lowerName.includes('advisory')) {
        return 'Management Fee';
      }
      if (lowerName.includes('commission') || lowerName.includes('trading')) {
        return 'Trading Commission';
      }
      if (lowerName.includes('expense ratio') || lowerName.includes('er ')) {
        return 'Expense Ratio';
      }
      if (lowerName.includes('custodian')) {
        return 'Custodian Fee';
      }
      if (lowerName.includes('margin')) {
        return 'Margin Interest';
      }
      return 'Other Investment Fee';
    };

    // Format fees list
    const formattedFees = fees.map((t) => ({
      transaction_id: t.transaction_id,
      date: t.date,
      amount: roundAmount(t.amount),
      name: t.name || t.original_name || 'Unknown',
      fee_type: classifyFeeType(t.name || t.original_name || ''),
      account_id: t.account_id,
    }));

    // Sort by date descending
    formattedFees.sort((a, b) => b.date.localeCompare(a.date));

    // Group by fee type
    const typeMap = new Map<string, { amount: number; count: number }>();
    for (const f of formattedFees) {
      const existing = typeMap.get(f.fee_type) || { amount: 0, count: 0 };
      existing.amount += f.amount;
      existing.count += 1;
      typeMap.set(f.fee_type, existing);
    }

    const byType = Array.from(typeMap.entries())
      .map(([feeType, data]) => ({
        fee_type: feeType,
        amount: roundAmount(data.amount),
        count: data.count,
      }))
      .sort((a, b) => b.amount - a.amount);

    // Group by month
    const monthlyMap = new Map<string, { amount: number; count: number }>();
    for (const f of formattedFees) {
      const month = f.date.substring(0, 7);
      const existing = monthlyMap.get(month) || { amount: 0, count: 0 };
      existing.amount += f.amount;
      existing.count += 1;
      monthlyMap.set(month, existing);
    }

    const byMonth = Array.from(monthlyMap.entries())
      .map(([month, data]) => ({
        month,
        amount: roundAmount(data.amount),
        count: data.count,
      }))
      .sort((a, b) => b.month.localeCompare(a.month));

    // Summary calculations
    const avgFee = formattedFees.length > 0 ? roundAmount(totalFees / formattedFees.length) : 0;
    const largestFee =
      formattedFees.length > 0 ? Math.max(...formattedFees.map((f) => f.amount)) : 0;
    const monthlyAvg = byMonth.length > 0 ? roundAmount(totalFees / byMonth.length) : 0;

    return {
      period: {
        start_date: start_date,
        end_date: end_date,
      },
      total_fees: roundAmount(totalFees),
      fee_count: formattedFees.length,
      fees: formattedFees,
      by_type: byType,
      by_month: byMonth,
      summary: {
        average_fee: avgFee,
        largest_fee: roundAmount(largestFee),
        monthly_average: monthlyAvg,
      },
    };
  }

  // ============================================
  // PHASE 12.4: GOAL ANALYTICS TOOLS
  // ============================================

  /**
   * Get goal projections with multiple scenarios.
   *
   * Projects when goals will be achieved under different contribution scenarios
   * (conservative, moderate, aggressive).
   *
   * @param options - Filter options
   * @returns Object with goal projection data
   */
  async getGoalProjection(options: { goal_id?: string } = {}): Promise<{
    count: number;
    goals: Array<{
      goal_id: string;
      name?: string;
      target_amount: number;
      current_amount: number;
      remaining_amount: number;
      progress_percent: number;
      historical_monthly_contribution: number;
      projections: {
        conservative: {
          monthly_contribution: number;
          months_to_complete: number;
          estimated_date: string;
        } | null;
        moderate: {
          monthly_contribution: number;
          months_to_complete: number;
          estimated_date: string;
        } | null;
        aggressive: {
          monthly_contribution: number;
          months_to_complete: number;
          estimated_date: string;
        } | null;
      };
      status?: string;
    }>;
    summary: {
      all_on_track: number;
      needs_attention: number;
      average_progress: number;
    };
  }> {
    const { goal_id } = options;

    const goals = await this.db.getGoals(false);
    let filteredGoals = goals;

    if (goal_id) {
      filteredGoals = goals.filter((g) => g.goal_id === goal_id);
    }

    // Process each goal
    const projections: Array<{
      goal_id: string;
      name?: string;
      target_amount: number;
      current_amount: number;
      remaining_amount: number;
      progress_percent: number;
      historical_monthly_contribution: number;
      projections: {
        conservative: {
          monthly_contribution: number;
          months_to_complete: number;
          estimated_date: string;
        } | null;
        moderate: {
          monthly_contribution: number;
          months_to_complete: number;
          estimated_date: string;
        } | null;
        aggressive: {
          monthly_contribution: number;
          months_to_complete: number;
          estimated_date: string;
        } | null;
      };
      status?: string;
    }> = [];

    let totalProgress = 0;
    let onTrackCount = 0;
    let needsAttentionCount = 0;

    for (const goal of filteredGoals) {
      const targetAmount = goal.savings?.target_amount || 0;
      if (targetAmount <= 0) continue;

      // Get historical data
      const history = await this.db.getGoalHistory(goal.goal_id, { limit: 12 });

      let currentAmount = 0;
      let historicalContribution = 0;

      if (history.length > 0) {
        currentAmount = history[0]?.current_amount ?? 0;

        // Calculate historical average contribution
        if (history.length >= 2) {
          const sorted = [...history].sort((a, b) => a.month.localeCompare(b.month));
          const contributions: number[] = [];

          for (let i = 1; i < sorted.length; i++) {
            const curr = sorted[i]?.current_amount ?? 0;
            const prev = sorted[i - 1]?.current_amount ?? 0;
            if (curr > prev) {
              contributions.push(curr - prev);
            }
          }

          if (contributions.length > 0) {
            historicalContribution =
              contributions.reduce((a, b) => a + b, 0) / contributions.length;
          }
        }
      }

      const remaining = Math.max(0, targetAmount - currentAmount);
      const progressPercent = (currentAmount / targetAmount) * 100;
      totalProgress += progressPercent;

      // Calculate projections for each scenario
      const calculateProjection = (monthlyAmount: number) => {
        if (monthlyAmount <= 0 || remaining <= 0) return null;

        const months = Math.ceil(remaining / monthlyAmount);
        const today = new Date();
        const targetDate = new Date(today.getFullYear(), today.getMonth() + months, 1);
        const year = targetDate.getFullYear();
        const month = String(targetDate.getMonth() + 1).padStart(2, '0');

        return {
          monthly_contribution: roundAmount(monthlyAmount),
          months_to_complete: months,
          estimated_date: `${year}-${month}`,
        };
      };

      // Conservative: 80% of historical rate
      // Moderate: historical rate
      // Aggressive: 120% of historical rate or planned contribution
      const plannedContribution = goal.savings?.tracking_type_monthly_contribution || 0;
      const baseContribution = Math.max(historicalContribution, plannedContribution);

      const conservative = calculateProjection(baseContribution * 0.8);
      const moderate = calculateProjection(baseContribution);
      const aggressive = calculateProjection(Math.max(baseContribution * 1.2, plannedContribution));

      // Determine if on track
      if (moderate && moderate.months_to_complete <= 24) {
        onTrackCount++;
      } else {
        needsAttentionCount++;
      }

      projections.push({
        goal_id: goal.goal_id,
        name: goal.name,
        target_amount: roundAmount(targetAmount),
        current_amount: roundAmount(currentAmount),
        remaining_amount: roundAmount(remaining),
        progress_percent: Math.round(progressPercent * 10) / 10,
        historical_monthly_contribution: roundAmount(historicalContribution),
        projections: {
          conservative,
          moderate,
          aggressive,
        },
        status: goal.savings?.status,
      });
    }

    return {
      count: projections.length,
      goals: projections,
      summary: {
        all_on_track: onTrackCount,
        needs_attention: needsAttentionCount,
        average_progress:
          projections.length > 0 ? Math.round((totalProgress / projections.length) * 10) / 10 : 0,
      },
    };
  }

  /**
   * Get goal milestones progress.
   *
   * Tracks milestone achievements (25%, 50%, 75%, 100%) for each goal.
   *
   * @param options - Filter options
   * @returns Object with milestone data
   */
  async getGoalMilestones(options: { goal_id?: string } = {}): Promise<{
    count: number;
    goals: Array<{
      goal_id: string;
      name?: string;
      target_amount: number;
      current_amount: number;
      progress_percent: number;
      milestones: {
        milestone_25: { achieved: boolean; achieved_date?: string; amount: number };
        milestone_50: { achieved: boolean; achieved_date?: string; amount: number };
        milestone_75: { achieved: boolean; achieved_date?: string; amount: number };
        milestone_100: { achieved: boolean; achieved_date?: string; amount: number };
      };
      next_milestone: {
        percentage: number;
        amount_needed: number;
      } | null;
      status?: string;
    }>;
    summary: {
      total_milestones_achieved: number;
      goals_at_25: number;
      goals_at_50: number;
      goals_at_75: number;
      goals_complete: number;
    };
  }> {
    const { goal_id } = options;

    const goals = await this.db.getGoals(false);
    let filteredGoals = goals;

    if (goal_id) {
      filteredGoals = goals.filter((g) => g.goal_id === goal_id);
    }

    const milestoneData: Array<{
      goal_id: string;
      name?: string;
      target_amount: number;
      current_amount: number;
      progress_percent: number;
      milestones: {
        milestone_25: { achieved: boolean; achieved_date?: string; amount: number };
        milestone_50: { achieved: boolean; achieved_date?: string; amount: number };
        milestone_75: { achieved: boolean; achieved_date?: string; amount: number };
        milestone_100: { achieved: boolean; achieved_date?: string; amount: number };
      };
      next_milestone: {
        percentage: number;
        amount_needed: number;
      } | null;
      status?: string;
    }> = [];

    let totalMilestonesAchieved = 0;
    let goalsAt25 = 0;
    let goalsAt50 = 0;
    let goalsAt75 = 0;
    let goalsComplete = 0;

    for (const goal of filteredGoals) {
      const targetAmount = goal.savings?.target_amount || 0;
      if (targetAmount <= 0) continue;

      // Get history to find milestone dates
      const history = await this.db.getGoalHistory(goal.goal_id, { limit: 24 });
      const sortedHistory = [...history].sort((a, b) => a.month.localeCompare(b.month));

      let currentAmount = 0;
      if (history.length > 0) {
        const latestHistory = history.sort((a, b) => b.month.localeCompare(a.month))[0];
        currentAmount = latestHistory?.current_amount ?? 0;
      }

      const progressPercent = (currentAmount / targetAmount) * 100;

      // Calculate milestone amounts
      const milestone25Amount = targetAmount * 0.25;
      const milestone50Amount = targetAmount * 0.5;
      const milestone75Amount = targetAmount * 0.75;
      const milestone100Amount = targetAmount;

      // Find when milestones were achieved
      const findMilestoneDate = (threshold: number): string | undefined => {
        for (const h of sortedHistory) {
          if ((h.current_amount ?? 0) >= threshold) {
            return h.month;
          }
        }
        return undefined;
      };

      const milestone25Achieved = currentAmount >= milestone25Amount;
      const milestone50Achieved = currentAmount >= milestone50Amount;
      const milestone75Achieved = currentAmount >= milestone75Amount;
      const milestone100Achieved = currentAmount >= milestone100Amount;

      // Count milestones
      if (milestone25Achieved) totalMilestonesAchieved++;
      if (milestone50Achieved) totalMilestonesAchieved++;
      if (milestone75Achieved) totalMilestonesAchieved++;
      if (milestone100Achieved) totalMilestonesAchieved++;

      // Track goals at each milestone level
      if (milestone100Achieved) goalsComplete++;
      else if (milestone75Achieved) goalsAt75++;
      else if (milestone50Achieved) goalsAt50++;
      else if (milestone25Achieved) goalsAt25++;

      // Determine next milestone
      let nextMilestone: { percentage: number; amount_needed: number } | null = null;
      if (!milestone25Achieved) {
        nextMilestone = {
          percentage: 25,
          amount_needed: roundAmount(milestone25Amount - currentAmount),
        };
      } else if (!milestone50Achieved) {
        nextMilestone = {
          percentage: 50,
          amount_needed: roundAmount(milestone50Amount - currentAmount),
        };
      } else if (!milestone75Achieved) {
        nextMilestone = {
          percentage: 75,
          amount_needed: roundAmount(milestone75Amount - currentAmount),
        };
      } else if (!milestone100Achieved) {
        nextMilestone = {
          percentage: 100,
          amount_needed: roundAmount(milestone100Amount - currentAmount),
        };
      }

      milestoneData.push({
        goal_id: goal.goal_id,
        name: goal.name,
        target_amount: roundAmount(targetAmount),
        current_amount: roundAmount(currentAmount),
        progress_percent: Math.round(progressPercent * 10) / 10,
        milestones: {
          milestone_25: {
            achieved: milestone25Achieved,
            achieved_date: milestone25Achieved ? findMilestoneDate(milestone25Amount) : undefined,
            amount: roundAmount(milestone25Amount),
          },
          milestone_50: {
            achieved: milestone50Achieved,
            achieved_date: milestone50Achieved ? findMilestoneDate(milestone50Amount) : undefined,
            amount: roundAmount(milestone50Amount),
          },
          milestone_75: {
            achieved: milestone75Achieved,
            achieved_date: milestone75Achieved ? findMilestoneDate(milestone75Amount) : undefined,
            amount: roundAmount(milestone75Amount),
          },
          milestone_100: {
            achieved: milestone100Achieved,
            achieved_date: milestone100Achieved ? findMilestoneDate(milestone100Amount) : undefined,
            amount: roundAmount(milestone100Amount),
          },
        },
        next_milestone: nextMilestone,
        status: goal.savings?.status,
      });
    }

    return {
      count: milestoneData.length,
      goals: milestoneData,
      summary: {
        total_milestones_achieved: totalMilestonesAchieved,
        goals_at_25: goalsAt25,
        goals_at_50: goalsAt50,
        goals_at_75: goalsAt75,
        goals_complete: goalsComplete,
      },
    };
  }

  /**
   * Get goals at risk of not being achieved.
   *
   * Identifies goals that are behind schedule or at risk based on
   * contribution patterns and remaining time.
   *
   * @param options - Filter options
   * @returns Object with at-risk goal data
   */
  async getGoalsAtRisk(
    options: {
      months_lookback?: number;
      risk_threshold?: number;
    } = {}
  ): Promise<{
    count: number;
    at_risk_count: number;
    goals: Array<{
      goal_id: string;
      name?: string;
      target_amount: number;
      current_amount: number;
      remaining_amount: number;
      progress_percent: number;
      risk_level: 'low' | 'medium' | 'high' | 'critical';
      risk_factors: string[];
      historical_monthly_contribution: number;
      required_monthly_contribution: number;
      contribution_gap: number;
      estimated_completion?: string;
      status?: string;
    }>;
    summary: {
      critical_count: number;
      high_risk_count: number;
      medium_risk_count: number;
      low_risk_count: number;
      average_contribution_gap: number;
    };
  }> {
    const { months_lookback = 6, risk_threshold = 50 } = options;

    const goals = await this.db.getGoals(false);
    const activeGoals = goals.filter((g) => g.savings?.status === 'active');

    const atRiskGoals: Array<{
      goal_id: string;
      name?: string;
      target_amount: number;
      current_amount: number;
      remaining_amount: number;
      progress_percent: number;
      risk_level: 'low' | 'medium' | 'high' | 'critical';
      risk_factors: string[];
      historical_monthly_contribution: number;
      required_monthly_contribution: number;
      contribution_gap: number;
      estimated_completion?: string;
      status?: string;
    }> = [];

    let criticalCount = 0;
    let highRiskCount = 0;
    let mediumRiskCount = 0;
    let lowRiskCount = 0;
    let totalGap = 0;

    for (const goal of activeGoals) {
      const targetAmount = goal.savings?.target_amount || 0;
      if (targetAmount <= 0) continue;

      const plannedMonthlyContribution = goal.savings?.tracking_type_monthly_contribution || 0;

      // Get history
      const history = await this.db.getGoalHistory(goal.goal_id, { limit: months_lookback });

      let currentAmount = 0;
      let historicalContribution = 0;

      if (history.length > 0) {
        currentAmount =
          history.sort((a, b) => b.month.localeCompare(a.month))[0]?.current_amount ?? 0;

        // Calculate historical average
        if (history.length >= 2) {
          const sorted = [...history].sort((a, b) => a.month.localeCompare(b.month));
          const contributions: number[] = [];

          for (let i = 1; i < sorted.length; i++) {
            const curr = sorted[i]?.current_amount ?? 0;
            const prev = sorted[i - 1]?.current_amount ?? 0;
            contributions.push(curr - prev);
          }

          if (contributions.length > 0) {
            historicalContribution =
              contributions.reduce((a, b) => a + b, 0) / contributions.length;
          }
        }
      }

      const remaining = Math.max(0, targetAmount - currentAmount);
      const progressPercent = (currentAmount / targetAmount) * 100;

      // Calculate required monthly contribution for 12-month completion
      const requiredMonthly = remaining / 12;

      // Calculate contribution gap
      const contributionGap =
        plannedMonthlyContribution > 0
          ? plannedMonthlyContribution - historicalContribution
          : requiredMonthly - historicalContribution;

      totalGap += Math.max(0, contributionGap);

      // Determine risk factors and level
      const riskFactors: string[] = [];
      let riskScore = 0;

      // Factor 1: Contribution gap
      if (historicalContribution < requiredMonthly * 0.5) {
        riskFactors.push('Contributions significantly below required pace');
        riskScore += 40;
      } else if (historicalContribution < requiredMonthly * 0.8) {
        riskFactors.push('Contributions below required pace');
        riskScore += 20;
      }

      // Factor 2: Progress below expected
      const expectedProgress = (months_lookback / 24) * 100; // Assuming 2-year goal
      if (progressPercent < expectedProgress * 0.5) {
        riskFactors.push('Progress significantly behind schedule');
        riskScore += 30;
      } else if (progressPercent < expectedProgress * 0.8) {
        riskFactors.push('Progress slightly behind schedule');
        riskScore += 15;
      }

      // Factor 3: No contributions in recent months
      if (historicalContribution <= 0) {
        riskFactors.push('No recent contributions detected');
        riskScore += 25;
      }

      // Factor 4: Large remaining amount
      if (remaining > targetAmount * 0.8) {
        riskFactors.push('Large amount still remaining');
        riskScore += 10;
      }

      // Determine risk level
      let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';
      if (riskScore >= 60) {
        riskLevel = 'critical';
        criticalCount++;
      } else if (riskScore >= 40) {
        riskLevel = 'high';
        highRiskCount++;
      } else if (riskScore >= 20) {
        riskLevel = 'medium';
        mediumRiskCount++;
      } else {
        riskLevel = 'low';
        lowRiskCount++;
      }

      // Only include goals above risk threshold
      if (riskScore >= risk_threshold || progressPercent < 50) {
        // Calculate estimated completion
        let estimatedCompletion: string | undefined;
        if (historicalContribution > 0 && remaining > 0) {
          const months = Math.ceil(remaining / historicalContribution);
          const today = new Date();
          const targetDate = new Date(today.getFullYear(), today.getMonth() + months, 1);
          estimatedCompletion = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}`;
        }

        atRiskGoals.push({
          goal_id: goal.goal_id,
          name: goal.name,
          target_amount: roundAmount(targetAmount),
          current_amount: roundAmount(currentAmount),
          remaining_amount: roundAmount(remaining),
          progress_percent: Math.round(progressPercent * 10) / 10,
          risk_level: riskLevel,
          risk_factors: riskFactors,
          historical_monthly_contribution: roundAmount(historicalContribution),
          required_monthly_contribution: roundAmount(requiredMonthly),
          contribution_gap: roundAmount(Math.max(0, contributionGap)),
          estimated_completion: estimatedCompletion,
          status: goal.savings?.status,
        });
      }
    }

    // Sort by risk level (critical first)
    const riskOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    atRiskGoals.sort((a, b) => riskOrder[a.risk_level] - riskOrder[b.risk_level]);

    return {
      count: activeGoals.length,
      at_risk_count: atRiskGoals.length,
      goals: atRiskGoals,
      summary: {
        critical_count: criticalCount,
        high_risk_count: highRiskCount,
        medium_risk_count: mediumRiskCount,
        low_risk_count: lowRiskCount,
        average_contribution_gap:
          atRiskGoals.length > 0 ? roundAmount(totalGap / atRiskGoals.length) : 0,
      },
    };
  }

  /**
   * Get goal recommendations based on analysis.
   *
   * Suggests actions to improve goal achievement chances.
   *
   * @param options - Filter options
   * @returns Object with goal recommendations
   */
  async getGoalRecommendations(options: { goal_id?: string } = {}): Promise<{
    count: number;
    recommendations: Array<{
      goal_id: string;
      goal_name?: string;
      recommendation_type:
        | 'increase_contribution'
        | 'adjust_target'
        | 'extend_timeline'
        | 'celebrate_progress'
        | 'start_contributing';
      priority: 'high' | 'medium' | 'low';
      title: string;
      description: string;
      current_value?: number;
      suggested_value?: number;
      impact: string;
    }>;
    summary: {
      high_priority_count: number;
      medium_priority_count: number;
      low_priority_count: number;
      goals_needing_attention: number;
      goals_on_track: number;
    };
  }> {
    const { goal_id } = options;

    const goals = await this.db.getGoals(false);
    let filteredGoals = goals;

    if (goal_id) {
      filteredGoals = goals.filter((g) => g.goal_id === goal_id);
    }

    const recommendations: Array<{
      goal_id: string;
      goal_name?: string;
      recommendation_type:
        | 'increase_contribution'
        | 'adjust_target'
        | 'extend_timeline'
        | 'celebrate_progress'
        | 'start_contributing';
      priority: 'high' | 'medium' | 'low';
      title: string;
      description: string;
      current_value?: number;
      suggested_value?: number;
      impact: string;
    }> = [];

    let highPriorityCount = 0;
    let mediumPriorityCount = 0;
    let lowPriorityCount = 0;
    let needsAttentionCount = 0;
    let onTrackCount = 0;

    for (const goal of filteredGoals) {
      const targetAmount = goal.savings?.target_amount || 0;
      if (targetAmount <= 0) continue;

      const plannedContribution = goal.savings?.tracking_type_monthly_contribution || 0;

      // Get history
      const history = await this.db.getGoalHistory(goal.goal_id, { limit: 6 });

      let currentAmount = 0;
      let historicalContribution = 0;

      if (history.length > 0) {
        currentAmount =
          history.sort((a, b) => b.month.localeCompare(a.month))[0]?.current_amount ?? 0;

        if (history.length >= 2) {
          const sorted = [...history].sort((a, b) => a.month.localeCompare(b.month));
          const contributions: number[] = [];

          for (let i = 1; i < sorted.length; i++) {
            const curr = sorted[i]?.current_amount ?? 0;
            const prev = sorted[i - 1]?.current_amount ?? 0;
            if (curr > prev) contributions.push(curr - prev);
          }

          if (contributions.length > 0) {
            historicalContribution =
              contributions.reduce((a, b) => a + b, 0) / contributions.length;
          }
        }
      }

      const progressPercent = (currentAmount / targetAmount) * 100;
      const remaining = targetAmount - currentAmount;

      // Generate recommendations based on analysis

      // 1. No contributions detected
      if (historicalContribution <= 0 && progressPercent < 100) {
        recommendations.push({
          goal_id: goal.goal_id,
          goal_name: goal.name,
          recommendation_type: 'start_contributing',
          priority: 'high',
          title: 'Start Contributing',
          description: `No contributions detected for "${goal.name || 'this goal'}". Set up automatic transfers to make progress.`,
          current_value: 0,
          suggested_value: roundAmount(remaining / 12),
          impact: 'Essential to make any progress toward this goal',
        });
        highPriorityCount++;
        needsAttentionCount++;
        continue;
      }

      // 2. Contributions below planned amount
      if (plannedContribution > 0 && historicalContribution < plannedContribution * 0.8) {
        recommendations.push({
          goal_id: goal.goal_id,
          goal_name: goal.name,
          recommendation_type: 'increase_contribution',
          priority: 'high',
          title: 'Increase Contributions',
          description: `Contributing $${Math.round(historicalContribution)} vs planned $${plannedContribution}/month. Increase to stay on track.`,
          current_value: roundAmount(historicalContribution),
          suggested_value: roundAmount(plannedContribution),
          impact: `Will help reach goal ${Math.round((plannedContribution / historicalContribution - 1) * 100)}% faster`,
        });
        highPriorityCount++;
        needsAttentionCount++;
      }
      // 3. Progress above 75% - celebrate
      else if (progressPercent >= 75 && progressPercent < 100) {
        recommendations.push({
          goal_id: goal.goal_id,
          goal_name: goal.name,
          recommendation_type: 'celebrate_progress',
          priority: 'low',
          title: 'Great Progress!',
          description: `You're ${Math.round(progressPercent)}% of the way to "${goal.name || 'your goal'}". Keep up the momentum!`,
          current_value: roundAmount(currentAmount),
          impact: `Only $${roundAmount(remaining)} left to reach your goal`,
        });
        lowPriorityCount++;
        onTrackCount++;
      }
      // 4. Slow progress - suggest smaller target
      else if (progressPercent < 25 && history.length >= 6 && historicalContribution > 0) {
        const achievableTarget = currentAmount + historicalContribution * 24;
        if (achievableTarget < targetAmount * 0.7) {
          recommendations.push({
            goal_id: goal.goal_id,
            goal_name: goal.name,
            recommendation_type: 'adjust_target',
            priority: 'medium',
            title: 'Consider Adjusting Target',
            description: `At current pace, you'll reach $${Math.round(achievableTarget)} in 2 years. Consider a more achievable target.`,
            current_value: roundAmount(targetAmount),
            suggested_value: roundAmount(achievableTarget),
            impact: 'Makes the goal more achievable and motivating',
          });
          mediumPriorityCount++;
          needsAttentionCount++;
        }
      }
      // 5. Good progress - continue
      else if (progressPercent >= 25 && progressPercent < 75) {
        // Check if on track for 24-month completion
        const monthsToComplete =
          historicalContribution > 0 ? remaining / historicalContribution : Infinity;

        if (monthsToComplete <= 24) {
          onTrackCount++;
        } else {
          recommendations.push({
            goal_id: goal.goal_id,
            goal_name: goal.name,
            recommendation_type: 'extend_timeline',
            priority: 'medium',
            title: 'Adjust Timeline Expectations',
            description: `At current pace, "${goal.name || 'this goal'}" will take ${Math.round(monthsToComplete)} months. Consider extending your timeline or increasing contributions.`,
            current_value: roundAmount(historicalContribution),
            suggested_value: roundAmount(remaining / 24),
            impact: `Increasing to $${roundAmount(remaining / 24)}/month achieves goal in 2 years`,
          });
          mediumPriorityCount++;
        }
      }
    }

    // Sort by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return {
      count: recommendations.length,
      recommendations,
      summary: {
        high_priority_count: highPriorityCount,
        medium_priority_count: mediumPriorityCount,
        low_priority_count: lowPriorityCount,
        goals_needing_attention: needsAttentionCount,
        goals_on_track: onTrackCount,
      },
    };
  }

  // ============================================
  // PHASE 12.5: ACCOUNT & COMPARISON TOOLS
  // ============================================

  /**
   * Get account activity summary.
   *
   * Shows transaction activity statistics per account including
   * transaction counts, volume, and activity levels.
   *
   * @param options - Filter options
   * @returns Object with account activity data
   */
  async getAccountActivity(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      account_type?: string;
    } = {}
  ): Promise<{
    period: {
      start_date: string;
      end_date: string;
    };
    accounts: Array<{
      account_id: string;
      account_name: string;
      account_type?: string;
      institution?: string;
      transaction_count: number;
      total_inflow: number;
      total_outflow: number;
      net_flow: number;
      average_transaction: number;
      largest_transaction: number;
      activity_level: 'high' | 'medium' | 'low' | 'inactive';
    }>;
    summary: {
      total_accounts: number;
      active_accounts: number;
      most_active_account: string | null;
      total_transactions: number;
    };
  }> {
    const { period = 'last_30_days', account_type } = options;
    let { start_date, end_date } = options;

    if (!start_date || !end_date) {
      [start_date, end_date] = parsePeriod(period);
    }

    const accounts = await this.db.getAccounts();
    const transactions = await this.db.getTransactions();

    // Filter transactions by date
    const periodTransactions = transactions.filter(
      (t) => t.date >= start_date && t.date <= end_date
    );

    // Calculate activity per account
    const activityData: Array<{
      account_id: string;
      account_name: string;
      account_type?: string;
      institution?: string;
      transaction_count: number;
      total_inflow: number;
      total_outflow: number;
      net_flow: number;
      average_transaction: number;
      largest_transaction: number;
      activity_level: 'high' | 'medium' | 'low' | 'inactive';
    }> = [];

    let totalTransactions = 0;
    let mostActiveAccount: string | null = null;
    let highestCount = 0;

    for (const account of accounts) {
      // Filter by account type if specified
      if (account_type) {
        const typeMatch =
          account.account_type?.toLowerCase().includes(account_type.toLowerCase()) ||
          account.subtype?.toLowerCase().includes(account_type.toLowerCase());
        if (!typeMatch) continue;
      }

      const accountTxns = periodTransactions.filter((t) => t.account_id === account.account_id);
      const count = accountTxns.length;
      totalTransactions += count;

      let totalInflow = 0;
      let totalOutflow = 0;
      let largestTxn = 0;

      for (const t of accountTxns) {
        if (t.amount < 0) {
          totalInflow += Math.abs(t.amount);
        } else {
          totalOutflow += t.amount;
        }
        largestTxn = Math.max(largestTxn, Math.abs(t.amount));
      }

      const avgTxn = count > 0 ? (totalInflow + totalOutflow) / count : 0;
      const netFlow = totalInflow - totalOutflow;

      // Determine activity level
      let activityLevel: 'high' | 'medium' | 'low' | 'inactive' = 'inactive';
      if (count >= 30) activityLevel = 'high';
      else if (count >= 10) activityLevel = 'medium';
      else if (count > 0) activityLevel = 'low';

      if (count > highestCount) {
        highestCount = count;
        mostActiveAccount = await this.resolveAccountName(account);
      }

      activityData.push({
        account_id: account.account_id,
        account_name: await this.resolveAccountName(account),
        account_type: account.account_type,
        institution: account.institution_name,
        transaction_count: count,
        total_inflow: roundAmount(totalInflow),
        total_outflow: roundAmount(totalOutflow),
        net_flow: roundAmount(netFlow),
        average_transaction: roundAmount(avgTxn),
        largest_transaction: roundAmount(largestTxn),
        activity_level: activityLevel,
      });
    }

    // Sort by transaction count descending
    activityData.sort((a, b) => b.transaction_count - a.transaction_count);

    return {
      period: {
        start_date,
        end_date,
      },
      accounts: activityData,
      summary: {
        total_accounts: activityData.length,
        active_accounts: activityData.filter((a) => a.activity_level !== 'inactive').length,
        most_active_account: mostActiveAccount,
        total_transactions: totalTransactions,
      },
    };
  }

  /**
   * Get balance trends over time.
   *
   * Shows how account balances have changed by analyzing transaction flows.
   *
   * @param options - Filter options
   * @returns Object with balance trend data
   */
  async getBalanceTrends(
    options: {
      account_id?: string;
      months?: number;
      granularity?: 'daily' | 'weekly' | 'monthly';
      trend_threshold?: number;
    } = {}
  ): Promise<{
    months_analyzed: number;
    accounts: Array<{
      account_id: string;
      account_name: string;
      current_balance: number;
      trend_data: Array<{
        period: string;
        inflow: number;
        outflow: number;
        net_change: number;
      }>;
      overall_trend: 'growing' | 'declining' | 'stable';
      average_monthly_change: number;
    }>;
    summary: {
      total_accounts: number;
      growing_accounts: number;
      declining_accounts: number;
      stable_accounts: number;
    };
  }> {
    const {
      account_id,
      months = 6,
      granularity = 'monthly',
      trend_threshold = DEFAULT_TREND_THRESHOLD,
    } = options;

    const accounts = await this.db.getAccounts();
    const transactions = await this.db.getTransactions();

    // Calculate date range
    const today = new Date();
    const startDate = new Date(today.getFullYear(), today.getMonth() - months, 1);
    const startDateStr = startDate.toISOString().substring(0, 10);
    const endDateStr = today.toISOString().substring(0, 10);

    // Filter transactions
    const periodTransactions = transactions.filter(
      (t) => t.date >= startDateStr && t.date <= endDateStr
    );

    // Filter accounts if specified
    let targetAccounts = accounts;
    if (account_id) {
      targetAccounts = accounts.filter((a) => a.account_id === account_id);
    }

    const trendData: Array<{
      account_id: string;
      account_name: string;
      current_balance: number;
      trend_data: Array<{
        period: string;
        inflow: number;
        outflow: number;
        net_change: number;
      }>;
      overall_trend: 'growing' | 'declining' | 'stable';
      average_monthly_change: number;
    }> = [];

    let growingCount = 0;
    let decliningCount = 0;
    let stableCount = 0;

    for (const account of targetAccounts) {
      const accountTxns = periodTransactions.filter((t) => t.account_id === account.account_id);

      // Group by period
      const periodMap = new Map<string, { inflow: number; outflow: number }>();

      for (const t of accountTxns) {
        let periodKey: string;
        if (granularity === 'daily') {
          periodKey = t.date;
        } else if (granularity === 'weekly') {
          const date = new Date(t.date);
          const weekStart = new Date(date);
          weekStart.setDate(date.getDate() - date.getDay());
          periodKey = weekStart.toISOString().substring(0, 10);
        } else {
          periodKey = t.date.substring(0, 7);
        }

        const existing = periodMap.get(periodKey) || { inflow: 0, outflow: 0 };
        if (t.amount < 0) {
          existing.inflow += Math.abs(t.amount);
        } else {
          existing.outflow += t.amount;
        }
        periodMap.set(periodKey, existing);
      }

      // Convert to sorted array
      const trends = Array.from(periodMap.entries())
        .map(([period, data]) => ({
          period,
          inflow: roundAmount(data.inflow),
          outflow: roundAmount(data.outflow),
          net_change: roundAmount(data.inflow - data.outflow),
        }))
        .sort((a, b) => a.period.localeCompare(b.period));

      // Calculate overall trend
      let totalNetChange = 0;
      for (const t of trends) {
        totalNetChange += t.net_change;
      }

      const avgMonthlyChange = trends.length > 0 ? totalNetChange / Math.max(months, 1) : 0;

      let overallTrend: 'growing' | 'declining' | 'stable' = 'stable';
      if (avgMonthlyChange > trend_threshold) {
        overallTrend = 'growing';
        growingCount++;
      } else if (avgMonthlyChange < -trend_threshold) {
        overallTrend = 'declining';
        decliningCount++;
      } else {
        stableCount++;
      }

      trendData.push({
        account_id: account.account_id,
        account_name: await this.resolveAccountName(account),
        current_balance: account.current_balance,
        trend_data: trends,
        overall_trend: overallTrend,
        average_monthly_change: roundAmount(avgMonthlyChange),
      });
    }

    return {
      months_analyzed: months,
      accounts: trendData,
      summary: {
        total_accounts: trendData.length,
        growing_accounts: growingCount,
        declining_accounts: decliningCount,
        stable_accounts: stableCount,
      },
    };
  }

  /**
   * Get account-related fees.
   *
   * Tracks fees like ATM fees, overdraft fees, foreign transaction fees, etc.
   *
   * @param options - Filter options
   * @returns Object with account fee data
   */
  async getAccountFees(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      account_id?: string;
    } = {}
  ): Promise<{
    period: {
      start_date: string;
      end_date: string;
    };
    total_fees: number;
    fee_count: number;
    fees: Array<{
      transaction_id: string;
      date: string;
      amount: number;
      name: string;
      fee_type: string;
      account_id?: string;
      account_name?: string;
    }>;
    by_type: Array<{
      fee_type: string;
      amount: number;
      count: number;
    }>;
    by_account: Array<{
      account_id: string;
      account_name: string;
      amount: number;
      count: number;
    }>;
    summary: {
      average_fee: number;
      largest_fee: number;
      most_common_fee: string | null;
    };
  }> {
    const { period = 'ytd', account_id } = options;
    let { start_date, end_date } = options;

    if (!start_date || !end_date) {
      [start_date, end_date] = parsePeriod(period);
    }

    const accounts = await this.db.getAccounts();
    const accountMap = new Map(accounts.map((a) => [a.account_id, a]));

    const transactions = await this.db.getTransactions();

    // Fee-related categories
    const feeCategories = new Set([
      '10000000',
      '10001000',
      '10002000',
      '10003000',
      '10004000',
      '10005000',
      '10006000',
      '10007000',
      '10008000',
      '10009000',
      'bank_fees',
      'bank_fees_atm_fees',
      'bank_fees_foreign_transaction_fees',
      'bank_fees_insufficient_funds',
      'bank_fees_interest_charge',
      'bank_fees_overdraft_fees',
      'bank_fees_other_bank_fees',
      'fees',
    ]);

    // Fee keywords
    const feeKeywords = ['fee', 'charge', 'penalty', 'overdraft', 'atm'];

    // Find fee transactions
    const fees = transactions.filter((t) => {
      if (t.date < start_date || t.date > end_date) return false;
      if (account_id && t.account_id !== account_id) return false;
      if (t.amount <= 0) return false; // Fees are expenses (positive)

      const categoryMatch = t.category_id ? feeCategories.has(t.category_id.toLowerCase()) : false;
      const nameMatch = feeKeywords.some(
        (keyword) =>
          t.name?.toLowerCase().includes(keyword) ||
          t.original_name?.toLowerCase().includes(keyword)
      );

      return categoryMatch || nameMatch;
    });

    // Classify fee type
    const classifyFeeType = (t: Transaction): string => {
      const name = (t.name || t.original_name || '').toLowerCase();
      const categoryId = t.category_id?.toLowerCase() || '';

      if (name.includes('atm') || categoryId.includes('atm')) return 'ATM Fee';
      if (name.includes('overdraft') || categoryId.includes('overdraft')) return 'Overdraft Fee';
      if (name.includes('foreign') || categoryId.includes('foreign'))
        return 'Foreign Transaction Fee';
      if (name.includes('insufficient') || categoryId.includes('insufficient'))
        return 'Insufficient Funds Fee';
      if (name.includes('wire') || categoryId.includes('wire')) return 'Wire Transfer Fee';
      if (name.includes('late') || categoryId.includes('late')) return 'Late Payment Fee';
      if (name.includes('interest') || categoryId.includes('interest')) return 'Interest Charge';
      return 'Other Fee';
    };

    // Format fees
    const formattedFees = await Promise.all(
      fees.map(async (t) => {
        const account = t.account_id ? accountMap.get(t.account_id) : undefined;
        return {
          transaction_id: t.transaction_id,
          date: t.date,
          amount: roundAmount(t.amount),
          name: t.name || t.original_name || 'Unknown',
          fee_type: classifyFeeType(t),
          account_id: t.account_id,
          account_name: account ? await this.resolveAccountName(account) : undefined,
        };
      })
    );

    // Sort by date descending
    formattedFees.sort((a, b) => b.date.localeCompare(a.date));

    // Calculate totals
    const totalFees = formattedFees.reduce((sum, f) => sum + f.amount, 0);

    // Group by type
    const typeMap = new Map<string, { amount: number; count: number }>();
    for (const f of formattedFees) {
      const existing = typeMap.get(f.fee_type) || { amount: 0, count: 0 };
      existing.amount += f.amount;
      existing.count++;
      typeMap.set(f.fee_type, existing);
    }

    const byType = Array.from(typeMap.entries())
      .map(([feeType, data]) => ({
        fee_type: feeType,
        amount: roundAmount(data.amount),
        count: data.count,
      }))
      .sort((a, b) => b.amount - a.amount);

    // Group by account
    const accountFeeMap = new Map<string, { name: string; amount: number; count: number }>();
    for (const f of formattedFees) {
      if (!f.account_id) continue;
      const existing = accountFeeMap.get(f.account_id) || {
        name: f.account_name || 'Unknown',
        amount: 0,
        count: 0,
      };
      existing.amount += f.amount;
      existing.count++;
      accountFeeMap.set(f.account_id, existing);
    }

    const byAccount = Array.from(accountFeeMap.entries())
      .map(([accountId, data]) => ({
        account_id: accountId,
        account_name: data.name,
        amount: roundAmount(data.amount),
        count: data.count,
      }))
      .sort((a, b) => b.amount - a.amount);

    // Summary
    const avgFee = formattedFees.length > 0 ? totalFees / formattedFees.length : 0;
    const largestFee =
      formattedFees.length > 0 ? Math.max(...formattedFees.map((f) => f.amount)) : 0;
    const mostCommonFee = byType[0]?.fee_type ?? null;

    return {
      period: {
        start_date,
        end_date,
      },
      total_fees: roundAmount(totalFees),
      fee_count: formattedFees.length,
      fees: formattedFees,
      by_type: byType,
      by_account: byAccount,
      summary: {
        average_fee: roundAmount(avgFee),
        largest_fee: roundAmount(largestFee),
        most_common_fee: mostCommonFee,
      },
    };
  }

  /**
   * Compare year-over-year spending and income.
   *
   * Shows how spending and income changed compared to the same period last year.
   *
   * @param options - Filter options
   * @returns Object with year-over-year comparison data
   */
  async getYearOverYear(
    options: {
      current_year?: number;
      compare_year?: number;
      month?: number;
      exclude_transfers?: boolean;
    } = {}
  ): Promise<{
    current_year: number;
    compare_year: number;
    period_analyzed: string;
    current_period: {
      total_spending: number;
      total_income: number;
      net_savings: number;
      transaction_count: number;
    };
    compare_period: {
      total_spending: number;
      total_income: number;
      net_savings: number;
      transaction_count: number;
    };
    changes: {
      spending_change: number;
      spending_change_percent: number | null;
      income_change: number;
      income_change_percent: number | null;
      savings_change: number;
    };
    category_comparison: Array<{
      category_id: string;
      category_name: string;
      current_amount: number;
      compare_amount: number;
      change_amount: number;
      change_percent: number | null;
    }>;
    summary: {
      spending_trend: 'increased' | 'decreased' | 'stable';
      income_trend: 'increased' | 'decreased' | 'stable';
      biggest_spending_increase: string | null;
      biggest_spending_decrease: string | null;
    };
  }> {
    const today = new Date();
    const {
      current_year = today.getFullYear(),
      compare_year = current_year - 1,
      month,
      exclude_transfers = true,
    } = options;

    // Determine date ranges
    let currentStart: string;
    let currentEnd: string;
    let compareStart: string;
    let compareEnd: string;
    let periodAnalyzed: string;

    if (month) {
      // Specific month comparison
      const monthStr = String(month).padStart(2, '0');
      currentStart = `${current_year}-${monthStr}-01`;
      currentEnd = `${current_year}-${monthStr}-31`;
      compareStart = `${compare_year}-${monthStr}-01`;
      compareEnd = `${compare_year}-${monthStr}-31`;
      periodAnalyzed = `Month ${month}`;
    } else {
      // Year-to-date comparison
      const currentMonth = today.getMonth() + 1;
      const dayOfMonth = today.getDate();
      currentStart = `${current_year}-01-01`;
      currentEnd = `${current_year}-${String(currentMonth).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
      compareStart = `${compare_year}-01-01`;
      compareEnd = `${compare_year}-${String(currentMonth).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
      periodAnalyzed = `Year to date (Jan 1 - ${currentEnd.substring(5)})`;
    }

    const transactions = await this.db.getTransactions();

    // Filter transactions
    const filterTransactions = (txns: Transaction[], start: string, end: string) =>
      txns.filter((t) => {
        if (t.date < start || t.date > end) return false;
        if (exclude_transfers && isTransferCategory(t.category_id)) return false;
        return true;
      });

    const currentTxns = filterTransactions(transactions, currentStart, currentEnd);
    const compareTxns = filterTransactions(transactions, compareStart, compareEnd);

    // Calculate totals
    const calculatePeriodTotals = (txns: Transaction[]) => {
      let spending = 0;
      let income = 0;

      // Copilot Money format: positive = expense, negative = income
      for (const t of txns) {
        if (t.amount > 0) {
          spending += t.amount;
        } else if (t.amount < 0) {
          income += Math.abs(t.amount);
        }
      }

      return {
        total_spending: roundAmount(spending),
        total_income: roundAmount(income),
        net_savings: roundAmount(income - spending),
        transaction_count: txns.length,
      };
    };

    const currentPeriod = calculatePeriodTotals(currentTxns);
    const comparePeriod = calculatePeriodTotals(compareTxns);

    // Calculate changes
    const spendingChange = currentPeriod.total_spending - comparePeriod.total_spending;
    const incomeChange = currentPeriod.total_income - comparePeriod.total_income;
    const savingsChange = currentPeriod.net_savings - comparePeriod.net_savings;

    const spendingChangePercent =
      comparePeriod.total_spending > 0
        ? roundAmount((spendingChange / comparePeriod.total_spending) * 100)
        : null;
    const incomeChangePercent =
      comparePeriod.total_income > 0
        ? roundAmount((incomeChange / comparePeriod.total_income) * 100)
        : null;

    // Category comparison
    // Expenses are positive amounts in Copilot Money format
    const getCategorySpending = (txns: Transaction[]) => {
      const map = new Map<string, number>();
      for (const t of txns) {
        if (t.amount > 0) {
          const catId = getCategoryIdOrDefault(t.category_id);
          map.set(catId, (map.get(catId) || 0) + t.amount);
        }
      }
      return map;
    };

    const currentByCategory = getCategorySpending(currentTxns);
    const compareByCategory = getCategorySpending(compareTxns);

    // Merge categories
    const allCategories = new Set([...currentByCategory.keys(), ...compareByCategory.keys()]);
    const categoryComparison: Array<{
      category_id: string;
      category_name: string;
      current_amount: number;
      compare_amount: number;
      change_amount: number;
      change_percent: number | null;
    }> = [];

    for (const catId of allCategories) {
      const currentAmt = currentByCategory.get(catId) || 0;
      const compareAmt = compareByCategory.get(catId) || 0;
      const changeAmt = currentAmt - compareAmt;
      const changePct = compareAmt > 0 ? roundAmount((changeAmt / compareAmt) * 100) : null;

      categoryComparison.push({
        category_id: catId,
        category_name: await this.resolveCategoryName(catId),
        current_amount: roundAmount(currentAmt),
        compare_amount: roundAmount(compareAmt),
        change_amount: roundAmount(changeAmt),
        change_percent: changePct,
      });
    }

    // Sort by change amount
    categoryComparison.sort((a, b) => b.change_amount - a.change_amount);

    // Determine trends
    const spendingTrend: 'increased' | 'decreased' | 'stable' =
      spendingChangePercent !== null && spendingChangePercent > 5
        ? 'increased'
        : spendingChangePercent !== null && spendingChangePercent < -5
          ? 'decreased'
          : 'stable';

    const incomeTrend: 'increased' | 'decreased' | 'stable' =
      incomeChangePercent !== null && incomeChangePercent > 5
        ? 'increased'
        : incomeChangePercent !== null && incomeChangePercent < -5
          ? 'decreased'
          : 'stable';

    // Find biggest changes
    const increases = categoryComparison.filter((c) => c.change_amount > 0);
    const decreases = categoryComparison.filter((c) => c.change_amount < 0);

    return {
      current_year,
      compare_year,
      period_analyzed: periodAnalyzed,
      current_period: currentPeriod,
      compare_period: comparePeriod,
      changes: {
        spending_change: roundAmount(spendingChange),
        spending_change_percent: spendingChangePercent,
        income_change: roundAmount(incomeChange),
        income_change_percent: incomeChangePercent,
        savings_change: roundAmount(savingsChange),
      },
      category_comparison: categoryComparison.slice(0, 20),
      summary: {
        spending_trend: spendingTrend,
        income_trend: incomeTrend,
        biggest_spending_increase: increases[0]?.category_name ?? null,
        biggest_spending_decrease: decreases[decreases.length - 1]?.category_name ?? null,
      },
    };
  }

  // ============================================
  // PHASE 12.6: SEARCH & DISCOVERY TOOLS
  // ============================================

  /**
   * Advanced search with complex multi-criteria filtering.
   *
   * Combines multiple filters for precise transaction discovery.
   *
   * @param options - Search criteria
   * @returns Object with matching transactions
   */
  async getAdvancedSearch(
    options: {
      query?: string;
      min_amount?: number;
      max_amount?: number;
      start_date?: string;
      end_date?: string;
      category?: string;
      account_id?: string;
      merchant?: string;
      is_income?: boolean;
      is_expense?: boolean;
      exclude_transfers?: boolean;
      city?: string;
      payment_method?: string;
      limit?: number;
    } = {}
  ): Promise<{
    count: number;
    filters_applied: string[];
    transactions: Array<{
      transaction_id: string;
      date: string;
      amount: number;
      name: string;
      category_id?: string;
      category_name: string;
      account_id?: string;
      city?: string;
      match_score: number;
    }>;
    summary: {
      total_amount: number;
      average_amount: number;
      date_range: {
        earliest: string | null;
        latest: string | null;
      };
    };
  }> {
    const {
      query,
      min_amount,
      max_amount,
      start_date,
      end_date,
      category,
      account_id,
      merchant,
      is_income,
      is_expense,
      exclude_transfers = true,
      city,
      payment_method,
      limit = 100,
    } = options;

    const transactions = await this.db.getTransactions();
    const filtersApplied: string[] = [];

    // Apply filters
    const results = transactions.filter((t) => {
      // Date filter
      if (start_date && t.date < start_date) return false;
      if (end_date && t.date > end_date) return false;

      // Amount filter
      const absAmount = Math.abs(t.amount);
      if (min_amount !== undefined && absAmount < min_amount) return false;
      if (max_amount !== undefined && absAmount > max_amount) return false;

      // Account filter
      if (account_id && t.account_id !== account_id) return false;

      // Category filter
      if (category) {
        const catMatch = t.category_id?.toLowerCase().includes(category.toLowerCase());
        if (!catMatch) return false;
      }

      // Merchant filter
      if (merchant) {
        const nameMatch =
          t.name?.toLowerCase().includes(merchant.toLowerCase()) ||
          t.original_name?.toLowerCase().includes(merchant.toLowerCase());
        if (!nameMatch) return false;
      }

      // Income/expense filter
      if (is_income && t.amount >= 0) return false;
      if (is_expense && t.amount <= 0) return false;

      // Transfer filter
      if (exclude_transfers && isTransferCategory(t.category_id)) return false;

      // City filter
      if (city && !t.city?.toLowerCase().includes(city.toLowerCase())) return false;

      // Payment method filter
      if (
        payment_method &&
        !t.payment_method?.toLowerCase().includes(payment_method.toLowerCase())
      ) {
        return false;
      }

      // Query filter (searches name, original_name)
      if (query) {
        const searchQuery = query.toLowerCase();
        const nameMatch =
          t.name?.toLowerCase().includes(searchQuery) ||
          t.original_name?.toLowerCase().includes(searchQuery);
        if (!nameMatch) return false;
      }

      return true;
    });

    // Track applied filters
    if (query) filtersApplied.push(`query: "${query}"`);
    if (min_amount !== undefined) filtersApplied.push(`min_amount: $${min_amount}`);
    if (max_amount !== undefined) filtersApplied.push(`max_amount: $${max_amount}`);
    if (start_date) filtersApplied.push(`start_date: ${start_date}`);
    if (end_date) filtersApplied.push(`end_date: ${end_date}`);
    if (category) filtersApplied.push(`category: ${category}`);
    if (account_id) filtersApplied.push(`account_id: ${account_id}`);
    if (merchant) filtersApplied.push(`merchant: ${merchant}`);
    if (is_income) filtersApplied.push('is_income: true');
    if (is_expense) filtersApplied.push('is_expense: true');
    if (exclude_transfers) filtersApplied.push('exclude_transfers: true');
    if (city) filtersApplied.push(`city: ${city}`);
    if (payment_method) filtersApplied.push(`payment_method: ${payment_method}`);

    // Calculate match scores based on query relevance
    const scoredResults = results.map((t) => {
      let score = 1.0;
      if (query) {
        const searchQuery = query.toLowerCase();
        const name = t.name?.toLowerCase() || '';
        if (name === searchQuery) score = 1.0;
        else if (name.startsWith(searchQuery)) score = 0.9;
        else if (name.includes(searchQuery)) score = 0.7;
        else score = 0.5;
      }
      return { transaction: t, score };
    });

    // Sort by date descending, then score
    scoredResults.sort((a, b) => {
      if (a.transaction.date !== b.transaction.date) {
        return b.transaction.date.localeCompare(a.transaction.date);
      }
      return b.score - a.score;
    });

    // Apply limit
    const limitedResults = scoredResults.slice(0, limit);

    // Calculate summary
    const totalAmount = limitedResults.reduce((sum, r) => sum + Math.abs(r.transaction.amount), 0);
    const avgAmount = limitedResults.length > 0 ? totalAmount / limitedResults.length : 0;
    const dates = limitedResults.map((r) => r.transaction.date).sort();

    return {
      count: limitedResults.length,
      filters_applied: filtersApplied,
      transactions: await Promise.all(
        limitedResults.map(async (r) => ({
          transaction_id: r.transaction.transaction_id,
          date: r.transaction.date,
          amount: roundAmount(r.transaction.amount),
          name: r.transaction.name || r.transaction.original_name || 'Unknown',
          category_id: r.transaction.category_id,
          category_name: await this.resolveCategoryName(
            getCategoryIdOrDefault(r.transaction.category_id)
          ),
          account_id: r.transaction.account_id,
          city: r.transaction.city,
          match_score: roundAmount(r.score),
        }))
      ),
      summary: {
        total_amount: roundAmount(totalAmount),
        average_amount: roundAmount(avgAmount),
        date_range: {
          earliest: dates[0] ?? null,
          latest: dates[dates.length - 1] ?? null,
        },
      },
    };
  }

  /**
   * Search for transactions containing hashtags or custom tags.
   *
   * Searches for #tag patterns in transaction names and notes.
   *
   * @param options - Search options
   * @returns Object with tagged transactions
   */
  async getTagSearch(
    options: {
      tag?: string;
      period?: string;
      start_date?: string;
      end_date?: string;
      limit?: number;
    } = {}
  ): Promise<{
    period: {
      start_date: string;
      end_date: string;
    };
    tag_searched?: string;
    count: number;
    transactions: Array<{
      transaction_id: string;
      date: string;
      amount: number;
      name: string;
      tags_found: string[];
      category_id?: string;
    }>;
    all_tags: Array<{
      tag: string;
      count: number;
      total_amount: number;
    }>;
    summary: {
      unique_tags: number;
      most_used_tag: string | null;
    };
  }> {
    const { tag, period = 'last_90_days', limit = 100 } = options;
    let { start_date, end_date } = options;

    if (!start_date || !end_date) {
      [start_date, end_date] = parsePeriod(period);
    }

    const transactions = await this.db.getTransactions();

    // Filter by date
    const periodTxns = transactions.filter((t) => t.date >= start_date && t.date <= end_date);

    // Extract tags from transaction names (hashtags like #vacation, #groceries)
    const tagRegex = /#[\w-]+/g;

    const taggedTxns: Array<{
      transaction: Transaction;
      tags: string[];
    }> = [];

    const tagCounts = new Map<string, { count: number; amount: number }>();

    for (const t of periodTxns) {
      const text = `${t.name || ''} ${t.original_name || ''}`;
      const matches = text.match(tagRegex);

      if (matches && matches.length > 0) {
        const uniqueTags = [...new Set(matches.map((m) => m.toLowerCase()))];

        // If specific tag is searched, filter by it
        if (tag) {
          const searchTag = tag.startsWith('#') ? tag.toLowerCase() : `#${tag.toLowerCase()}`;
          if (!uniqueTags.includes(searchTag)) continue;
        }

        taggedTxns.push({
          transaction: t,
          tags: uniqueTags,
        });

        // Count tag usage
        for (const tagStr of uniqueTags) {
          const existing = tagCounts.get(tagStr) || { count: 0, amount: 0 };
          existing.count++;
          existing.amount += Math.abs(t.amount);
          tagCounts.set(tagStr, existing);
        }
      }
    }

    // Sort by date descending
    taggedTxns.sort((a, b) => b.transaction.date.localeCompare(a.transaction.date));

    // Apply limit
    const limitedTxns = taggedTxns.slice(0, limit);

    // Convert tag counts to sorted array
    const allTags = Array.from(tagCounts.entries())
      .map(([tagStr, data]) => ({
        tag: tagStr,
        count: data.count,
        total_amount: roundAmount(data.amount),
      }))
      .sort((a, b) => b.count - a.count);

    return {
      period: {
        start_date,
        end_date,
      },
      tag_searched: tag,
      count: limitedTxns.length,
      transactions: limitedTxns.map((r) => ({
        transaction_id: r.transaction.transaction_id,
        date: r.transaction.date,
        amount: roundAmount(r.transaction.amount),
        name: r.transaction.name || r.transaction.original_name || 'Unknown',
        tags_found: r.tags,
        category_id: r.transaction.category_id,
      })),
      all_tags: allTags,
      summary: {
        unique_tags: allTags.length,
        most_used_tag: allTags[0]?.tag ?? null,
      },
    };
  }

  /**
   * Search transactions by notes or descriptive text.
   *
   * Searches transaction names for note-like content including
   * parenthetical text, descriptions after colons, etc.
   *
   * @param options - Search options
   * @returns Object with matched transactions
   */
  async getNoteSearch(options: {
    query: string;
    period?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
  }): Promise<{
    period: {
      start_date: string;
      end_date: string;
    };
    query: string;
    count: number;
    transactions: Array<{
      transaction_id: string;
      date: string;
      amount: number;
      name: string;
      matched_text: string;
      category_id?: string;
    }>;
    summary: {
      total_matches: number;
      date_range: {
        earliest: string | null;
        latest: string | null;
      };
    };
  }> {
    const { query, period = 'ytd', limit = 100 } = options;
    let { start_date, end_date } = options;

    if (!start_date || !end_date) {
      [start_date, end_date] = parsePeriod(period);
    }

    const transactions = await this.db.getTransactions();
    const searchQuery = query.toLowerCase();

    // Find transactions matching the query
    const matches: Array<{
      transaction: Transaction;
      matchedText: string;
    }> = [];

    for (const t of transactions) {
      if (t.date < start_date || t.date > end_date) continue;

      const name = t.name || '';
      const originalName = t.original_name || '';
      const fullText = `${name} ${originalName}`;

      if (fullText.toLowerCase().includes(searchQuery)) {
        // Find the matched portion for context
        const lowerText = fullText.toLowerCase();
        const matchIdx = lowerText.indexOf(searchQuery);
        const contextStart = Math.max(0, matchIdx - 20);
        const contextEnd = Math.min(fullText.length, matchIdx + searchQuery.length + 20);
        const matchedText = fullText.substring(contextStart, contextEnd);

        matches.push({
          transaction: t,
          matchedText: matchedText.trim(),
        });
      }
    }

    // Sort by date descending
    matches.sort((a, b) => b.transaction.date.localeCompare(a.transaction.date));

    // Apply limit
    const limitedMatches = matches.slice(0, limit);
    const dates = limitedMatches.map((m) => m.transaction.date).sort();

    return {
      period: {
        start_date,
        end_date,
      },
      query,
      count: limitedMatches.length,
      transactions: limitedMatches.map((m) => ({
        transaction_id: m.transaction.transaction_id,
        date: m.transaction.date,
        amount: roundAmount(m.transaction.amount),
        name: m.transaction.name || m.transaction.original_name || 'Unknown',
        matched_text: m.matchedText,
        category_id: m.transaction.category_id,
      })),
      summary: {
        total_matches: matches.length,
        date_range: {
          earliest: dates[0] ?? null,
          latest: dates[dates.length - 1] ?? null,
        },
      },
    };
  }

  /**
   * Search transactions by location.
   *
   * Finds transactions at specific cities, regions, or near coordinates.
   *
   * @param options - Search options
   * @returns Object with location-based results
   */
  async getLocationSearch(
    options: {
      city?: string;
      region?: string;
      country?: string;
      lat?: number;
      lon?: number;
      radius_km?: number;
      period?: string;
      start_date?: string;
      end_date?: string;
      limit?: number;
    } = {}
  ): Promise<{
    period: {
      start_date: string;
      end_date: string;
    };
    location_filter: {
      city?: string;
      region?: string;
      country?: string;
      coordinates?: {
        lat: number;
        lon: number;
        radius_km: number;
      };
    };
    count: number;
    transactions: Array<{
      transaction_id: string;
      date: string;
      amount: number;
      name: string;
      city?: string;
      region?: string;
      country?: string;
      coordinates?: {
        lat: number;
        lon: number;
      };
      distance_km?: number;
      category_id?: string;
    }>;
    location_summary: Array<{
      city: string;
      count: number;
      total_spending: number;
    }>;
    summary: {
      unique_cities: number;
      most_common_city: string | null;
      total_spending: number;
    };
  }> {
    const {
      city,
      region,
      country,
      lat,
      lon,
      radius_km = 10,
      period = 'ytd',
      limit = 100,
    } = options;
    let { start_date, end_date } = options;

    if (!start_date || !end_date) {
      [start_date, end_date] = parsePeriod(period);
    }

    const transactions = await this.db.getTransactions();

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

    // Filter transactions
    const matches: Array<{
      transaction: Transaction;
      distance?: number;
    }> = [];

    for (const t of transactions) {
      if (t.date < start_date || t.date > end_date) continue;

      // Must have some location data
      if (!t.city && !t.region && !t.country && !t.lat && !t.lon) continue;

      // City filter
      if (city && !t.city?.toLowerCase().includes(city.toLowerCase())) continue;

      // Region filter
      if (region && !t.region?.toLowerCase().includes(region.toLowerCase())) continue;

      // Country filter
      if (country && !t.country?.toLowerCase().includes(country.toLowerCase())) continue;

      // Coordinate filter
      let distance: number | undefined;
      if (lat !== undefined && lon !== undefined) {
        if (t.lat !== undefined && t.lon !== undefined) {
          distance = calculateDistance(lat, lon, t.lat, t.lon);
          if (distance > radius_km) continue;
        } else {
          continue; // No coordinates to compare
        }
      }

      matches.push({
        transaction: t,
        distance,
      });
    }

    // Sort by date or distance
    if (lat !== undefined && lon !== undefined) {
      matches.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    } else {
      matches.sort((a, b) => b.transaction.date.localeCompare(a.transaction.date));
    }

    // Apply limit
    const limitedMatches = matches.slice(0, limit);

    // Calculate location summary
    const cityMap = new Map<string, { count: number; spending: number }>();
    for (const m of matches) {
      const cityName = m.transaction.city || 'Unknown';
      const existing = cityMap.get(cityName) || { count: 0, spending: 0 };
      existing.count++;
      if (m.transaction.amount > 0) {
        existing.spending += m.transaction.amount;
      }
      cityMap.set(cityName, existing);
    }

    const locationSummary = Array.from(cityMap.entries())
      .map(([cityName, data]) => ({
        city: cityName,
        count: data.count,
        total_spending: roundAmount(data.spending),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const totalSpending = limitedMatches.reduce(
      (sum, m) => sum + (m.transaction.amount > 0 ? m.transaction.amount : 0),
      0
    );

    return {
      period: {
        start_date,
        end_date,
      },
      location_filter: {
        city,
        region,
        country,
        coordinates: lat !== undefined && lon !== undefined ? { lat, lon, radius_km } : undefined,
      },
      count: limitedMatches.length,
      transactions: limitedMatches.map((m) => ({
        transaction_id: m.transaction.transaction_id,
        date: m.transaction.date,
        amount: roundAmount(m.transaction.amount),
        name: m.transaction.name || m.transaction.original_name || 'Unknown',
        city: m.transaction.city,
        region: m.transaction.region,
        country: m.transaction.country,
        coordinates:
          m.transaction.lat !== undefined && m.transaction.lon !== undefined
            ? { lat: m.transaction.lat, lon: m.transaction.lon }
            : undefined,
        distance_km: m.distance ? roundAmount(m.distance) : undefined,
        category_id: m.transaction.category_id,
      })),
      location_summary: locationSummary,
      summary: {
        unique_cities: cityMap.size,
        most_common_city: locationSummary[0]?.city ?? null,
        total_spending: roundAmount(totalSpending),
      },
    };
  }

  // ============================================
  // NET WORTH & CASH FLOW TOOLS
  // ============================================

  /**
   * Calculate net worth from all accounts.
   *
   * @param options - Filter options
   * @returns Object with assets, liabilities, net worth, and account breakdown
   */
  async getNetWorth(
    options: {
      account_type?: string;
      include_hidden?: boolean;
    } = {}
  ): Promise<{
    net_worth: number;
    assets: number;
    liabilities: number;
    breakdown: {
      asset_accounts: Array<{
        account_id: string;
        name: string;
        account_type?: string;
        balance: number;
        institution_name?: string;
      }>;
      liability_accounts: Array<{
        account_id: string;
        name: string;
        account_type?: string;
        balance: number;
        institution_name?: string;
      }>;
    };
    summary: {
      total_accounts: number;
      asset_account_count: number;
      liability_account_count: number;
      largest_asset: { name: string; balance: number } | null;
      largest_liability: { name: string; balance: number } | null;
    };
  }> {
    const { account_type, include_hidden = false } = options;

    // Get accounts with optional type filter
    let accounts = await this.db.getAccounts(account_type);

    // Filter hidden/deleted accounts if needed
    if (!include_hidden) {
      // Filter out accounts marked as user_deleted (merged or removed accounts)
      accounts = accounts.filter((acc) => acc.user_deleted !== true);

      // Also filter by hidden flag from user account customizations
      const userAccounts = await this.db.getUserAccounts();
      const hiddenIds = new Set(userAccounts.filter((ua) => ua.hidden).map((ua) => ua.account_id));
      accounts = accounts.filter((acc) => !hiddenIds.has(acc.account_id));
    }

    // Get user account names for display
    const userAccountMap = await this.getUserAccountMap();

    // Separate assets (positive balance) and liabilities (negative balance like credit cards)
    const assetAccounts: Array<{
      account_id: string;
      name: string;
      account_type?: string;
      balance: number;
      institution_name?: string;
    }> = [];

    const liabilityAccounts: Array<{
      account_id: string;
      name: string;
      account_type?: string;
      balance: number;
      institution_name?: string;
    }> = [];

    let totalAssets = 0;
    let totalLiabilities = 0;

    for (const acc of accounts) {
      const accountEntry = {
        account_id: acc.account_id,
        name:
          userAccountMap.get(acc.account_id) || acc.name || acc.official_name || 'Unknown Account',
        account_type: acc.account_type,
        balance: roundAmount(acc.current_balance),
        institution_name: acc.institution_name,
      };

      // Credit cards and loans typically have negative balances (money owed)
      // But some accounts might have positive balance representing what you owe
      // Use account type to help classify
      const isLiabilityType = ['credit', 'loan', 'mortgage'].some(
        (t) => acc.account_type?.toLowerCase().includes(t) || acc.subtype?.toLowerCase().includes(t)
      );

      if (isLiabilityType || acc.current_balance < 0) {
        // Liabilities: store as positive number (amount owed)
        accountEntry.balance = roundAmount(Math.abs(acc.current_balance));
        liabilityAccounts.push(accountEntry);
        totalLiabilities += Math.abs(acc.current_balance);
      } else {
        assetAccounts.push(accountEntry);
        totalAssets += acc.current_balance;
      }
    }

    // Sort by balance (highest first)
    assetAccounts.sort((a, b) => b.balance - a.balance);
    liabilityAccounts.sort((a, b) => b.balance - a.balance);

    const netWorth = roundAmount(totalAssets - totalLiabilities);

    return {
      net_worth: netWorth,
      assets: roundAmount(totalAssets),
      liabilities: roundAmount(totalLiabilities),
      breakdown: {
        asset_accounts: assetAccounts,
        liability_accounts: liabilityAccounts,
      },
      summary: {
        total_accounts: accounts.length,
        asset_account_count: assetAccounts.length,
        liability_account_count: liabilityAccounts.length,
        largest_asset: assetAccounts[0]
          ? { name: assetAccounts[0].name, balance: assetAccounts[0].balance }
          : null,
        largest_liability: liabilityAccounts[0]
          ? { name: liabilityAccounts[0].name, balance: liabilityAccounts[0].balance }
          : null,
      },
    };
  }

  /**
   * Calculate savings rate for a period.
   *
   * @param options - Filter options
   * @returns Object with income, spending, savings, and rate
   */
  async getSavingsRate(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      exclude_transfers?: boolean;
    } = {}
  ): Promise<{
    period: {
      start_date?: string;
      end_date?: string;
    };
    income: number;
    spending: number;
    savings: number;
    savings_rate: number | null;
    interpretation: string;
    breakdown: {
      income_sources: Array<{
        category_id: string;
        category_name: string;
        amount: number;
      }>;
      top_expenses: Array<{
        category_id: string;
        category_name: string;
        amount: number;
      }>;
    };
  }> {
    const { period, exclude_transfers = true } = options;
    let { start_date, end_date } = options;

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Get all transactions for the period
    const transactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: MAX_QUERY_LIMIT,
    });

    // Calculate income and spending
    let totalIncome = 0;
    let totalSpending = 0;

    const incomeByCategory = new Map<string, number>();
    const expenseByCategory = new Map<string, number>();

    for (const txn of transactions) {
      // Skip transfers if requested
      if (exclude_transfers && isTransferCategory(txn.category_id)) {
        continue;
      }

      // Copilot Money format: positive = expense, negative = income
      if (txn.amount > 0) {
        totalSpending += txn.amount;
        const catId = getCategoryIdOrDefault(txn.category_id);
        expenseByCategory.set(catId, (expenseByCategory.get(catId) || 0) + txn.amount);
      } else {
        totalIncome += Math.abs(txn.amount);
        const catId = getCategoryIdOrDefault(txn.category_id);
        incomeByCategory.set(catId, (incomeByCategory.get(catId) || 0) + Math.abs(txn.amount));
      }
    }

    const savings = totalIncome - totalSpending;
    const savingsRate = totalIncome > 0 ? roundAmount((savings / totalIncome) * 100) : null;

    // Determine interpretation
    let interpretation: string;
    if (savingsRate === null) {
      interpretation = 'No income recorded in this period';
    } else if (savingsRate >= 50) {
      interpretation = 'Excellent! Saving more than half of income';
    } else if (savingsRate >= 30) {
      interpretation = 'Great! Saving a significant portion of income';
    } else if (savingsRate >= 20) {
      interpretation = 'Good savings rate, meeting the recommended 20% target';
    } else if (savingsRate >= 10) {
      interpretation = 'Moderate savings rate, consider increasing if possible';
    } else if (savingsRate >= 0) {
      interpretation = 'Low savings rate, spending nearly all income';
    } else {
      interpretation = 'Negative savings rate - spending more than earning';
    }

    // Build income sources breakdown
    const incomeSources: Array<{
      category_id: string;
      category_name: string;
      amount: number;
    }> = [];

    for (const [catId, amount] of incomeByCategory) {
      incomeSources.push({
        category_id: catId,
        category_name: await this.resolveCategoryName(catId),
        amount: roundAmount(amount),
      });
    }
    incomeSources.sort((a, b) => b.amount - a.amount);

    // Build top expenses breakdown
    const topExpenses: Array<{
      category_id: string;
      category_name: string;
      amount: number;
    }> = [];

    for (const [catId, amount] of expenseByCategory) {
      topExpenses.push({
        category_id: catId,
        category_name: await this.resolveCategoryName(catId),
        amount: roundAmount(amount),
      });
    }
    topExpenses.sort((a, b) => b.amount - a.amount);

    return {
      period: {
        start_date,
        end_date,
      },
      income: roundAmount(totalIncome),
      spending: roundAmount(totalSpending),
      savings: roundAmount(savings),
      savings_rate: savingsRate,
      interpretation,
      breakdown: {
        income_sources: incomeSources.slice(0, 10),
        top_expenses: topExpenses.slice(0, 10),
      },
    };
  }

  /**
   * Analyze cash flow showing money in vs money out.
   *
   * @param options - Filter options
   * @returns Object with inflows, outflows, net flow, and breakdown
   */
  async getCashFlow(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      exclude_transfers?: boolean;
      top_n?: number;
    } = {}
  ): Promise<{
    period: {
      start_date?: string;
      end_date?: string;
    };
    inflows: number;
    outflows: number;
    net_cash_flow: number;
    transaction_count: {
      inflow_count: number;
      outflow_count: number;
    };
    by_category: {
      inflows: Array<{
        category_id: string;
        category_name: string;
        amount: number;
        count: number;
      }>;
      outflows: Array<{
        category_id: string;
        category_name: string;
        amount: number;
        count: number;
      }>;
    };
    largest_transactions: {
      largest_inflows: Array<{
        date: string;
        amount: number;
        name: string;
        category_name: string;
      }>;
      largest_outflows: Array<{
        date: string;
        amount: number;
        name: string;
        category_name: string;
      }>;
    };
    summary: {
      daily_average_inflow: number;
      daily_average_outflow: number;
      flow_status: 'positive' | 'negative' | 'balanced';
    };
  }> {
    const { period, exclude_transfers = true, top_n = 10 } = options;
    let { start_date, end_date } = options;

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Get all transactions for the period
    const transactions = await this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: MAX_QUERY_LIMIT,
    });

    // Separate inflows and outflows
    const inflows: Transaction[] = [];
    const outflows: Transaction[] = [];
    let totalInflows = 0;
    let totalOutflows = 0;

    const inflowByCategory = new Map<string, { amount: number; count: number }>();
    const outflowByCategory = new Map<string, { amount: number; count: number }>();

    for (const txn of transactions) {
      // Skip transfers if requested
      if (exclude_transfers && isTransferCategory(txn.category_id)) {
        continue;
      }

      const catId = getCategoryIdOrDefault(txn.category_id);

      // Copilot Money format: positive = expense = outflow, negative = income = inflow
      if (txn.amount < 0) {
        inflows.push(txn);
        totalInflows += Math.abs(txn.amount);
        const existing = inflowByCategory.get(catId) || { amount: 0, count: 0 };
        existing.amount += Math.abs(txn.amount);
        existing.count++;
        inflowByCategory.set(catId, existing);
      } else {
        outflows.push(txn);
        totalOutflows += txn.amount;
        const existing = outflowByCategory.get(catId) || { amount: 0, count: 0 };
        existing.amount += txn.amount;
        existing.count++;
        outflowByCategory.set(catId, existing);
      }
    }

    // Sort by amount for largest transactions
    inflows.sort((a, b) => a.amount - b.amount); // Most negative first (largest income)
    outflows.sort((a, b) => b.amount - a.amount); // Largest positive first (largest expense)

    // Build category breakdowns
    const inflowCategories: Array<{
      category_id: string;
      category_name: string;
      amount: number;
      count: number;
    }> = [];

    for (const [catId, data] of inflowByCategory) {
      inflowCategories.push({
        category_id: catId,
        category_name: await this.resolveCategoryName(catId),
        amount: roundAmount(data.amount),
        count: data.count,
      });
    }
    inflowCategories.sort((a, b) => b.amount - a.amount);

    const outflowCategories: Array<{
      category_id: string;
      category_name: string;
      amount: number;
      count: number;
    }> = [];

    for (const [catId, data] of outflowByCategory) {
      outflowCategories.push({
        category_id: catId,
        category_name: await this.resolveCategoryName(catId),
        amount: roundAmount(data.amount),
        count: data.count,
      });
    }
    outflowCategories.sort((a, b) => b.amount - a.amount);

    // Calculate daily averages
    let dayCount = 1;
    if (start_date && end_date) {
      const startMs = new Date(start_date).getTime();
      const endMs = new Date(end_date).getTime();
      dayCount = Math.max(1, Math.ceil((endMs - startMs) / (1000 * 60 * 60 * 24)));
    }

    const dailyAvgInflow = roundAmount(totalInflows / dayCount);
    const dailyAvgOutflow = roundAmount(totalOutflows / dayCount);

    const netCashFlow = totalInflows - totalOutflows;
    const flowStatus: 'positive' | 'negative' | 'balanced' =
      netCashFlow > 100 ? 'positive' : netCashFlow < -100 ? 'negative' : 'balanced';

    // Build largest transactions lists
    const largestInflows = await Promise.all(
      inflows.slice(0, top_n).map(async (txn) => ({
        date: txn.date,
        amount: roundAmount(txn.amount),
        name: getTransactionDisplayName(txn),
        category_name: await this.resolveCategoryName(txn.category_id),
      }))
    );

    const largestOutflows = await Promise.all(
      outflows.slice(0, top_n).map(async (txn) => ({
        date: txn.date,
        amount: roundAmount(Math.abs(txn.amount)),
        name: getTransactionDisplayName(txn),
        category_name: await this.resolveCategoryName(txn.category_id),
      }))
    );

    return {
      period: {
        start_date,
        end_date,
      },
      inflows: roundAmount(totalInflows),
      outflows: roundAmount(totalOutflows),
      net_cash_flow: roundAmount(netCashFlow),
      transaction_count: {
        inflow_count: inflows.length,
        outflow_count: outflows.length,
      },
      by_category: {
        inflows: inflowCategories.slice(0, 10),
        outflows: outflowCategories.slice(0, 10),
      },
      largest_transactions: {
        largest_inflows: largestInflows,
        largest_outflows: largestOutflows,
      },
      summary: {
        daily_average_inflow: dailyAvgInflow,
        daily_average_outflow: dailyAvgOutflow,
        flow_status: flowStatus,
      },
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
  };
  annotations?: {
    readOnlyHint?: boolean;
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
      name: 'get_accounts',
      description:
        'Get all accounts with balances. Optionally filter by account type ' +
        '(checking, savings, credit, investment). Now checks both account_type ' +
        'and subtype fields for better filtering (e.g., finds checking accounts ' +
        "even when account_type is 'depository'). By default, hidden accounts are excluded.",
      inputSchema: {
        type: 'object',
        properties: {
          account_type: {
            type: 'string',
            description:
              'Filter by account type (checking, savings, credit, investment, depository)',
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
      name: 'get_spending',
      description:
        'Unified spending aggregation tool. Use group_by to select analysis type: ' +
        'category (spending by category), merchant (spending by merchant), ' +
        'day_of_week (spending patterns by weekday), time (spending over time with granularity), ' +
        'rate (spending velocity and projections). Replaces get_spending_by_category, ' +
        'get_spending_by_merchant, get_spending_by_day_of_week, get_spending_over_time, get_spending_rate.',
      inputSchema: {
        type: 'object',
        properties: {
          group_by: {
            type: 'string',
            enum: ['category', 'merchant', 'day_of_week', 'time', 'rate'],
            description:
              'How to aggregate spending: category, merchant, day_of_week, time (with granularity), or rate (velocity)',
          },
          granularity: {
            type: 'string',
            enum: ['day', 'week', 'month'],
            description: "Time granularity for 'time' grouping (default: month)",
          },
          period: {
            type: 'string',
            description:
              'Period shorthand: this_month, last_month, last_7_days, last_30_days, last_90_days, ytd, this_year, last_year',
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
          category: {
            type: 'string',
            description: 'Filter by category (partial match)',
          },
          limit: {
            type: 'integer',
            description: 'Max results for merchant grouping (default: 50)',
            default: 50,
          },
          exclude_transfers: {
            type: 'boolean',
            description: 'Exclude transfers (default: true)',
            default: true,
          },
        },
        required: ['group_by'],
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_account_balance',
      description:
        'Get balance and details for a specific account by ID. ' +
        'Includes account_type and subtype fields.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: {
            type: 'string',
            description: 'Account ID to query',
          },
        },
        required: ['account_id'],
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_categories',
      description:
        'Unified category retrieval tool. Supports multiple views: ' +
        'list (default) - categories used in transactions with counts/amounts; ' +
        'tree - full Plaid category taxonomy as hierarchical tree; ' +
        'search - search categories by keyword. Use parent_id to get subcategories. ' +
        'Replaces get_category_hierarchy, get_subcategories, search_categories.',
      inputSchema: {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            enum: ['list', 'tree', 'search'],
            description:
              'View mode: list (categories in transactions), tree (full hierarchy), search (find by keyword)',
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
      name: 'get_income',
      description:
        'Get income transactions (deposits, paychecks, refunds). ' +
        'Filters for positive amounts (credits) or income-related categories. ' +
        'Returns total income and breakdown by source.',
      inputSchema: {
        type: 'object',
        properties: {
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
          refund_threshold: {
            type: 'number',
            description:
              'Maximum amount from common retail merchants to consider as a refund rather than income (default: 500)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'compare_periods',
      description:
        'Compare spending and income between two time periods. ' +
        'Returns totals for each period, percentage changes, and ' +
        'category-by-category comparison showing where spending changed most.',
      inputSchema: {
        type: 'object',
        properties: {
          period1: {
            type: 'string',
            description:
              'First period (baseline): this_month, last_month, ' +
              'last_7_days, last_30_days, last_90_days, ytd, ' +
              'this_year, last_year',
          },
          period2: {
            type: 'string',
            description:
              'Second period (to compare): this_month, last_month, ' +
              'last_7_days, last_30_days, last_90_days, ytd, ' +
              'this_year, last_year',
          },
          exclude_transfers: {
            type: 'boolean',
            description: 'Exclude transfers between accounts (default: false)',
            default: false,
          },
        },
        required: ['period1', 'period2'],
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    // ============================================
    // NEW TOOLS - Items 13-33
    // ============================================
    {
      name: 'get_trips',
      description:
        'Detect and group transactions into trips. Identifies clusters of transactions ' +
        'in foreign locations within date ranges. Returns trip details including location, ' +
        'duration, total spent, and category breakdown.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description: 'Period shorthand: this_month, last_month, last_30_days, ytd, etc.',
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
          min_days: {
            type: 'integer',
            description: 'Minimum trip duration in days (default: 2)',
            default: 2,
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_merchant_analytics',
      description:
        'Unified merchant analytics tool. Use sort_by parameter to rank merchants: ' +
        'spending (by total amount), frequency (by visit count), average (by avg transaction). ' +
        'Includes visit dates and visits_per_month. Replaces get_top_merchants, get_merchant_frequency.',
      inputSchema: {
        type: 'object',
        properties: {
          sort_by: {
            type: 'string',
            enum: ['spending', 'frequency', 'average'],
            description: 'How to rank merchants',
          },
          period: {
            type: 'string',
            description: 'Named period (default: last_90_days)',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD)',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD)',
          },
          limit: {
            type: 'integer',
            description: 'Max merchants to return (default: 20)',
          },
          min_visits: {
            type: 'integer',
            description: 'Minimum visits to include (default: 1)',
          },
        },
        required: ['sort_by'],
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_unusual_transactions',
      description:
        'Detect unusual/anomalous transactions. Flags transactions significantly above ' +
        'average for that merchant or category. Also flags large transactions above a configurable threshold.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description: 'Period shorthand: this_month, last_month, last_30_days, ytd, etc.',
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
          threshold_multiplier: {
            type: 'number',
            description: 'Number of standard deviations above average to flag (default: 2)',
            default: 2,
          },
          large_transaction_threshold: {
            type: 'number',
            description:
              'Transaction amount above which to flag as a large transaction anomaly (default: 1000)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'export_transactions',
      description:
        'Export transactions to CSV or JSON format. Returns formatted data string ' +
        'that can be saved to a file for external analysis.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description: 'Period shorthand: this_month, last_month, last_30_days, ytd, etc.',
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
          format: {
            type: 'string',
            description: 'Export format: csv or json (default: csv)',
            enum: ['csv', 'json'],
            default: 'csv',
          },
          include_fields: {
            type: 'array',
            description:
              'Fields to include in export (default: date, amount, name, category_id, account_id, pending)',
            items: { type: 'string' },
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_data_quality_report',
      description:
        'Generate a comprehensive data quality report. Helps identify issues in financial data ' +
        'that should be corrected in Copilot Money: unresolved category IDs, potential currency ' +
        'conversion problems, non-unique transaction IDs, duplicate accounts, and suspicious ' +
        'categorizations. Use this to find data quality issues before doing analysis. ' +
        'Supports configurable limits for large datasets and pagination for browsing issues.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description: 'Period shorthand: this_month, last_month, last_90_days, ytd, etc.',
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
          transaction_limit: {
            type: 'number',
            description:
              'Maximum transactions to analyze (default: 50000, max: 100000). ' +
              'Use lower values for faster analysis or higher for comprehensive reports.',
            default: 50000,
            minimum: 1,
            maximum: 100000,
          },
          issues_limit: {
            type: 'number',
            description:
              'Maximum issues to return per category (default: 20, max: 100). ' +
              'Use with issues_offset for pagination through large result sets.',
            default: 20,
            minimum: 1,
            maximum: 100,
          },
          issues_offset: {
            type: 'number',
            description:
              'Number of issues to skip for pagination (default: 0). ' +
              'Use with issues_limit to page through results.',
            default: 0,
            minimum: 0,
          },
          foreign_large_amount_threshold: {
            type: 'number',
            description:
              'Amount threshold for flagging large transactions with foreign merchant indicators (default: 1000)',
          },
          round_amount_threshold: {
            type: 'number',
            description:
              'Amount threshold for flagging suspiciously round foreign amounts (default: 500)',
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
        'Get current/latest prices for investments (stocks, crypto, ETFs). ' +
        'Returns the most recent price data for each investment, optionally filtered by ticker symbol. ' +
        'Shows multiple price fields (price, close_price, current_price, institution_price) with a best_price ' +
        'field that automatically selects the most relevant price. Includes OHLCV data when available. ' +
        'Useful for checking current portfolio values and tracking investment performance.',
      inputSchema: {
        type: 'object',
        properties: {
          ticker_symbol: {
            type: 'string',
            description:
              'Optional ticker symbol to filter by (e.g., "AAPL", "BTC-USD", "VTSAX"). ' +
              'If omitted, returns prices for all investments.',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_investment_splits',
      description:
        'Get stock splits for investments. Returns information about historical stock splits ' +
        'including split ratios (e.g., "4:1"), split dates, and calculated multipliers. ' +
        'Stock splits affect share counts and historical price calculations. ' +
        'For example, after a 4:1 split, historical prices should be divided by 4 ' +
        'and share counts multiplied by 4 to maintain accurate comparisons. ' +
        'Also identifies reverse splits where shares are consolidated.',
      inputSchema: {
        type: 'object',
        properties: {
          ticker_symbol: {
            type: 'string',
            description: 'Filter by ticker symbol (e.g., "AAPL", "TSLA", "GOOGL")',
          },
          start_date: {
            type: 'string',
            description: 'Filter splits on or after this date (YYYY-MM-DD)',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
          end_date: {
            type: 'string',
            description: 'Filter splits on or before this date (YYYY-MM-DD)',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_connected_institutions',
      description:
        'Get connected financial institutions (Plaid items). Shows all bank and financial ' +
        'institution connections with their health status, error states, and last sync times. ' +
        'Useful for identifying accounts that need re-authentication or have connection issues. ' +
        'Returns counts of healthy connections and those needing attention.',
      inputSchema: {
        type: 'object',
        properties: {
          connection_status: {
            type: 'string',
            description: 'Filter by connection status (e.g., "active", "error", "disconnected")',
          },
          institution_id: {
            type: 'string',
            description: 'Filter by Plaid institution ID',
          },
          needs_update: {
            type: 'boolean',
            description: 'Filter by whether connection needs re-authentication (true/false)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },

    // ============================================
    // PHASE 12: ANALYTICS TOOLS
    // ============================================

    // ---- Spending Trends ----
    {
      name: 'get_average_transaction_size',
      description:
        'Calculate average transaction amounts grouped by category or merchant. ' +
        'Shows min/max amounts, transaction counts, and totals for each group. ' +
        'Useful for identifying spending patterns and outliers.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description: 'Named period: this_month, last_month, last_30_days, last_3_months, ytd',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD)',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD)',
          },
          group_by: {
            type: 'string',
            enum: ['category', 'merchant'],
            description: 'How to group transactions (default: category)',
          },
          limit: {
            type: 'integer',
            description: 'Maximum groups to return (default: 20)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_category_trends',
      description:
        'Track spending trends by category, comparing current vs previous period. ' +
        'Shows change amounts, percentages, and trend direction (up/down/stable/new) ' +
        'for each category. Helps identify categories with significant changes.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description: 'Named period: this_month, last_month, last_30_days, last_3_months, ytd',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD)',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD)',
          },
          compare_to_previous: {
            type: 'boolean',
            description: 'Compare to equivalent previous period (default: true)',
          },
          limit: {
            type: 'integer',
            description: 'Maximum categories to return (default: 15)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },

    // ---- Budget Analytics ----
    {
      name: 'get_budget_analytics',
      description:
        'Unified budget analytics tool. Use analysis parameter: ' +
        'utilization (current budget usage), vs_actual (budget vs actual comparison), ' +
        'alerts (budgets near/over limit), recommendations (smart budget suggestions). ' +
        'Replaces get_budget_utilization, get_budget_vs_actual, get_budget_alerts, get_budget_recommendations.',
      inputSchema: {
        type: 'object',
        properties: {
          analysis: {
            type: 'string',
            enum: ['utilization', 'vs_actual', 'alerts', 'recommendations'],
            description: 'Type of analysis',
          },
          month: {
            type: 'string',
            description: 'Month to analyze (YYYY-MM format)',
          },
          months: {
            type: 'integer',
            description: 'Number of months for vs_actual analysis (default: 6)',
          },
          category: {
            type: 'string',
            description: 'Filter by category',
          },
          threshold_percentage: {
            type: 'integer',
            description: 'Alert threshold percentage (default: 80)',
          },
          budget_recommendation_threshold: {
            type: 'number',
            description:
              'Minimum spending amount in a category to recommend creating a budget (default: 100)',
          },
        },
        required: ['analysis'],
      },
      annotations: {
        readOnlyHint: true,
      },
    },

    // ---- Investment Analytics ----
    {
      name: 'get_investment_analytics',
      description:
        'Unified investment analytics tool. Use analysis parameter: ' +
        'performance (price changes, returns), dividends (dividend income tracking), ' +
        'fees (investment-related fees). Replaces get_investment_performance, get_dividend_income, get_investment_fees.',
      inputSchema: {
        type: 'object',
        properties: {
          analysis: {
            type: 'string',
            enum: ['performance', 'dividends', 'fees'],
            description: 'Type of analysis',
          },
          ticker_symbol: {
            type: 'string',
            description: 'Filter by specific ticker symbol',
          },
          account_id: {
            type: 'string',
            description: 'Filter by specific account ID',
          },
          period: {
            type: 'string',
            description: 'Named period (default: ytd)',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD)',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD)',
          },
        },
        required: ['analysis'],
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_portfolio_allocation',
      description:
        'Get portfolio allocation across investment accounts and securities. ' +
        'Shows how investments are distributed by account (with balances and percentages) ' +
        'and lists all securities with current prices. Useful for understanding diversification ' +
        'and identifying concentration in specific accounts.',
      inputSchema: {
        type: 'object',
        properties: {
          include_prices: {
            type: 'boolean',
            description: 'Include current security prices (default: true)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },

    // ---- Goal Analytics ----
    {
      name: 'get_goal_analytics',
      description:
        'Unified goal analytics tool. Use analysis parameter: ' +
        'projection (completion scenarios), risk (identify at-risk goals), ' +
        'recommendations (personalized suggestions). ' +
        'Replaces get_goal_projection, get_goals_at_risk, get_goal_recommendations.',
      inputSchema: {
        type: 'object',
        properties: {
          analysis: {
            type: 'string',
            enum: ['projection', 'risk', 'recommendations'],
            description: 'Type of analysis',
          },
          goal_id: {
            type: 'string',
            description: 'Filter by specific goal ID',
          },
          months_lookback: {
            type: 'integer',
            description: 'Number of months to analyze for risk assessment (default: 6)',
          },
        },
        required: ['analysis'],
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_goal_details',
      description:
        'Get goal details with optional includes. Combines progress, history, and contributions into one call. ' +
        'Replaces separate calls to get_goal_progress, get_goal_history, get_goal_contributions.',
      inputSchema: {
        type: 'object',
        properties: {
          goal_id: {
            type: 'string',
            description: 'Filter by specific goal ID',
          },
          include: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['progress', 'history', 'contributions'],
            },
            description: 'What to include: progress, history, contributions (default: [progress])',
          },
          start_month: {
            type: 'string',
            description: 'Start month for history (YYYY-MM)',
          },
          end_month: {
            type: 'string',
            description: 'End month for history (YYYY-MM)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_goal_milestones',
      description:
        'Track goal milestone achievements (25%, 50%, 75%, 100%). ' +
        'Shows when milestones were achieved and what the next milestone requires. ' +
        'Useful for celebrating progress and staying motivated.',
      inputSchema: {
        type: 'object',
        properties: {
          goal_id: {
            type: 'string',
            description: 'Filter by specific goal ID',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },

    // ---- Account & Comparison ----
    {
      name: 'get_account_analytics',
      description:
        'Unified account analytics tool. Use analysis parameter: ' +
        'activity (transaction counts, inflows/outflows), balance_trends (balance changes over time), ' +
        'fees (ATM, overdraft, service fees). Replaces get_account_activity, get_balance_trends, get_account_fees.',
      inputSchema: {
        type: 'object',
        properties: {
          analysis: {
            type: 'string',
            enum: ['activity', 'balance_trends', 'fees'],
            description: 'Type of analysis: activity, balance_trends, or fees',
          },
          account_id: {
            type: 'string',
            description: 'Filter by specific account ID',
          },
          period: {
            type: 'string',
            description: 'Named period (default: last_30_days)',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD)',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD)',
          },
          months: {
            type: 'integer',
            description: 'Number of months for balance_trends (default: 6)',
          },
          granularity: {
            type: 'string',
            enum: ['daily', 'weekly', 'monthly'],
            description: 'Time granularity for balance_trends',
          },
          account_type: {
            type: 'string',
            description: 'Filter by account type',
          },
          trend_threshold: {
            type: 'number',
            description:
              'Monthly change amount threshold for classifying account trends as growing/declining (default: 100)',
          },
        },
        required: ['analysis'],
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_year_over_year',
      description:
        'Compare spending and income year-over-year. ' +
        'Shows changes compared to the same period last year with category breakdown.',
      inputSchema: {
        type: 'object',
        properties: {
          current_year: {
            type: 'integer',
            description: 'Current year to compare (default: current year)',
          },
          compare_year: {
            type: 'integer',
            description: 'Year to compare against (default: current year - 1)',
          },
          month: {
            type: 'integer',
            description: 'Specific month to compare (1-12). If omitted, compares YTD.',
          },
          exclude_transfers: {
            type: 'boolean',
            description: 'Exclude transfers from comparison (default: true)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },

    // ---- Net Worth & Cash Flow ----
    {
      name: 'get_net_worth',
      description:
        'Calculate total net worth from all accounts. ' +
        'Shows assets (positive balances), liabilities (negative balances like credit cards), ' +
        'and net worth (assets - liabilities). Optionally filter by account type.',
      inputSchema: {
        type: 'object',
        properties: {
          account_type: {
            type: 'string',
            description:
              'Filter by account type (checking, savings, credit, investment, depository)',
          },
          include_hidden: {
            type: 'boolean',
            description: 'Include hidden accounts (default: false)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_savings_rate',
      description:
        'Calculate savings rate (income - spending) / income for a period. ' +
        'Shows income, spending, savings amount, and savings rate percentage. ' +
        'A positive rate means saving money, negative means spending more than earning.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description:
              'Period shorthand: this_month, last_month, last_30_days, last_90_days, ytd, this_year, last_year',
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
          exclude_transfers: {
            type: 'boolean',
            description: 'Exclude transfers from calculation (default: true)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_cash_flow',
      description:
        'Analyze cash flow showing money in (income) vs money out (expenses) for a period. ' +
        'Includes net cash flow, flow by category, and largest inflows/outflows.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description:
              'Period shorthand: this_month, last_month, last_30_days, last_90_days, ytd, this_year, last_year',
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
          exclude_transfers: {
            type: 'boolean',
            description: 'Exclude transfers from calculation (default: true)',
          },
          top_n: {
            type: 'integer',
            description: 'Number of top inflows/outflows to return (default: 10)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
  ];
}
