/**
 * MCP tool definitions for Copilot Money data.
 *
 * Exposes database functionality through the Model Context Protocol.
 */

import { CopilotDatabase } from '../core/database.js';
import { parsePeriod } from '../utils/date.js';
import {
  getCategoryName,
  isTransferCategory,
  isIncomeCategory,
  isKnownPlaidCategory,
} from '../utils/categories.js';
import type { Transaction, Account } from '../models/index.js';
import { getTransactionDisplayName, getRecurringDisplayName } from '../models/index.js';
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
  ];
}
