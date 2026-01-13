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

  /**
   * Initialize tools with a database connection.
   *
   * @param database - CopilotDatabase instance
   */
  constructor(database: CopilotDatabase) {
    this.db = database;
  }

  /**
   * Get transactions with optional filters.
   *
   * @param options - Filter options
   * @returns Object with transaction count and list of transactions
   */
  getTransactions(options: {
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
    pending?: boolean;
    region?: string;
    country?: string;
  }): {
    count: number;
    total_count: number;
    offset: number;
    has_more: boolean;
    transactions: Array<Transaction & { category_name?: string; normalized_merchant?: string }>;
  } {
    const {
      period,
      category,
      merchant,
      account_id,
      min_amount,
      max_amount,
      exclude_transfers = false,
      pending,
      region,
      country,
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

    // Query transactions with higher limit for post-filtering
    let transactions = this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      category,
      merchant,
      accountId: account_id,
      minAmount: min_amount,
      maxAmount: max_amount,
      limit: 50000, // Get more for filtering
    });

    // Filter out transfers if requested
    if (exclude_transfers) {
      transactions = transactions.filter((txn) => !isTransferCategory(txn.category_id));
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
    const enrichedTransactions = transactions.map((txn) => ({
      ...txn,
      category_name: txn.category_id ? getCategoryName(txn.category_id) : undefined,
      normalized_merchant: normalizeMerchantName(getTransactionDisplayName(txn)),
    }));

    return {
      count: enrichedTransactions.length,
      total_count: totalCount,
      offset: validatedOffset,
      has_more: hasMore,
      transactions: enrichedTransactions,
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
  searchTransactions(
    query: string,
    options: {
      limit?: number;
      period?: string;
      start_date?: string;
      end_date?: string;
    } = {}
  ): {
    count: number;
    transactions: Array<Transaction & { category_name?: string }>;
  } {
    const { limit = 50, period } = options;
    let { start_date, end_date } = options;

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    let transactions = this.db.searchTransactions(query, start_date || end_date ? 10000 : limit);

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
    const enrichedTransactions = transactions.map((txn) => ({
      ...txn,
      category_name: txn.category_id ? getCategoryName(txn.category_id) : undefined,
    }));

    return {
      count: enrichedTransactions.length,
      transactions: enrichedTransactions,
    };
  }

  /**
   * Get all accounts with balances.
   *
   * @param accountType - Optional filter by account type
   * @returns Object with account count, total balance, and list of accounts
   */
  getAccounts(accountType?: string): {
    count: number;
    total_balance: number;
    accounts: Account[];
  } {
    const accounts = this.db.getAccounts(accountType);

    // Calculate total balance
    const totalBalance = accounts.reduce((sum, acc) => sum + acc.current_balance, 0);

    return {
      count: accounts.length,
      total_balance: Math.round(totalBalance * 100) / 100,
      accounts,
    };
  }

  /**
   * Get spending aggregated by category.
   *
   * @param options - Filter options
   * @returns Object with spending breakdown by category
   */
  getSpendingByCategory(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    min_amount?: number;
    exclude_transfers?: boolean;
  }): {
    period: { start_date?: string; end_date?: string };
    total_spending: number;
    category_count: number;
    categories: Array<{
      category_id: string;
      category_name: string;
      total_spending: number;
      transaction_count: number;
    }>;
  } {
    const { period, min_amount = 0.0, exclude_transfers = false } = options;
    let { start_date, end_date } = options;

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Get transactions with filters
    let transactions = this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      minAmount: min_amount,
      limit: 50000, // High limit for aggregation
    });

    // Filter out transfers if requested (check both category and internal_transfer flag)
    if (exclude_transfers) {
      transactions = transactions.filter(
        (txn) => !isTransferCategory(txn.category_id) && !txn.internal_transfer
      );
    }

    // Aggregate by category (always exclude internal transfers from spending)
    const categorySpending: Map<string, number> = new Map();
    const categoryCounts: Map<string, number> = new Map();

    for (const txn of transactions) {
      // Only count positive amounts (expenses), skip internal transfers
      if (txn.amount > 0 && !txn.internal_transfer) {
        const cat = txn.category_id || 'Uncategorized';
        categorySpending.set(cat, (categorySpending.get(cat) || 0) + txn.amount);
        categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
      }
    }

    // Convert to list of objects, sorted by spending (descending)
    const categories = Array.from(categorySpending.entries())
      .map(([category_id, total_spending]) => ({
        category_id,
        category_name: getCategoryName(category_id),
        total_spending: Math.round(total_spending * 100) / 100,
        transaction_count: categoryCounts.get(category_id) || 0,
      }))
      .sort((a, b) => b.total_spending - a.total_spending);

    // Calculate totals
    const totalSpending =
      Math.round(categories.reduce((sum, cat) => sum + cat.total_spending, 0) * 100) / 100;

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
  getAccountBalance(accountId: string): {
    account_id: string;
    name: string;
    account_type?: string;
    subtype?: string;
    current_balance: number;
    available_balance?: number;
    mask?: string;
    institution_name?: string;
  } {
    const accounts = this.db.getAccounts();

    // Find the account
    const account = accounts.find((acc) => acc.account_id === accountId);

    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    return {
      account_id: account.account_id,
      name: account.name || account.official_name || 'Unknown',
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
  getCategories(): {
    count: number;
    categories: Array<{
      category_id: string;
      category_name: string;
      transaction_count: number;
      total_amount: number;
    }>;
  } {
    const allTransactions = this.db.getAllTransactions();

    // Count transactions and amounts per category
    const categoryStats = new Map<string, { count: number; totalAmount: number }>();

    for (const txn of allTransactions) {
      const categoryId = txn.category_id || 'Uncategorized';
      const stats = categoryStats.get(categoryId) || {
        count: 0,
        totalAmount: 0,
      };
      stats.count++;
      stats.totalAmount += Math.abs(txn.amount);
      categoryStats.set(categoryId, stats);
    }

    // Convert to list
    const categories = Array.from(categoryStats.entries())
      .map(([category_id, stats]) => ({
        category_id,
        category_name: getCategoryName(category_id),
        transaction_count: stats.count,
        total_amount: Math.round(stats.totalAmount * 100) / 100,
      }))
      .sort((a, b) => b.transaction_count - a.transaction_count);

    return {
      count: categories.length,
      categories,
    };
  }

  /**
   * Get recurring/subscription transactions.
   *
   * Identifies transactions that occur regularly (same merchant, similar amount).
   *
   * @param options - Filter options
   * @returns Object with list of recurring transactions grouped by merchant
   */
  getRecurringTransactions(options: {
    min_occurrences?: number;
    period?: string;
    start_date?: string;
    end_date?: string;
    include_copilot_subscriptions?: boolean;
  }): {
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
  } {
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
    const transactions = this.db.getTransactions({
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
          average_amount: Math.round(avgAmount * 100) / 100,
          total_amount: Math.round(totalAmount * 100) / 100,
          frequency,
          confidence,
          confidence_reason: confidenceReasons.join(', '),
          category_name: data.categoryId ? getCategoryName(data.categoryId) : undefined,
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
      const copilotRecurring = this.db.getRecurring();
      if (copilotRecurring.length > 0) {
        copilotSubscriptions = copilotRecurring.map((rec) => ({
          recurring_id: rec.recurring_id,
          name: getRecurringDisplayName(rec),
          amount: rec.amount,
          frequency: rec.frequency,
          next_date: rec.next_date,
          last_date: rec.last_date,
          category_name: rec.category_id ? getCategoryName(rec.category_id) : undefined,
          is_active: rec.is_active,
        }));
      }
    }

    return {
      period: { start_date, end_date },
      count: recurring.length,
      total_monthly_cost: Math.round(totalMonthlyCost * 100) / 100,
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
  getBudgets(options: { active_only?: boolean } = {}): {
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
  } {
    const { active_only = false } = options;

    const budgets = this.db.getBudgets(active_only);

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

    return {
      count: budgets.length,
      total_budgeted: Math.round(totalBudgeted * 100) / 100,
      budgets: budgets.map((b) => ({
        budget_id: b.budget_id,
        name: b.name,
        amount: b.amount,
        period: b.period,
        category_id: b.category_id,
        category_name: b.category_id ? getCategoryName(b.category_id) : undefined,
        start_date: b.start_date,
        end_date: b.end_date,
        is_active: b.is_active,
        iso_currency_code: b.iso_currency_code,
      })),
    };
  }

  /**
   * Get financial goals (savings targets, debt payoff goals, etc.).
   *
   * @param options - Filter options
   * @returns Object with goal details
   */
  getGoals(options: { active_only?: boolean } = {}): {
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
  } {
    const { active_only = false } = options;

    const goals = this.db.getGoals(active_only);

    // Calculate total target amount across all goals
    let totalTarget = 0;
    for (const goal of goals) {
      if (goal.savings?.target_amount) {
        totalTarget += goal.savings.target_amount;
      }
    }

    return {
      count: goals.length,
      total_target: Math.round(totalTarget * 100) / 100,
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
  getGoalProgress(options: { goal_id?: string } = {}): {
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
  } {
    const { goal_id } = options;

    // Get goals (all or filtered by goal_id)
    const goals = this.db.getGoals(false);
    let filteredGoals = goals;

    if (goal_id) {
      filteredGoals = goals.filter((g) => g.goal_id === goal_id);
    }

    // Get history for each goal to calculate progress
    const progressData = filteredGoals.map((goal) => {
      // Get latest history for this goal
      const history = this.db.getGoalHistory(goal.goal_id, { limit: 12 }); // Last 12 months

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
        progress_percent: progressPercent ? Math.round(progressPercent * 100) / 100 : undefined,
        monthly_contribution: goal.savings?.tracking_type_monthly_contribution,
        estimated_completion: estimatedCompletion,
        status: goal.savings?.status,
        latest_month: latestMonth,
      };
    });

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
  getGoalHistory(options: {
    goal_id: string;
    start_month?: string;
    end_month?: string;
    limit?: number;
  }): {
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
  } {
    const { goal_id, start_month, end_month, limit = 12 } = options;

    // Get the goal details
    const goals = this.db.getGoals(false);
    const goal = goals.find((g) => g.goal_id === goal_id);

    // Get history for this goal
    const history = this.db.getGoalHistory(goal_id, {
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
        progress_percent: progressPercent ? Math.round(progressPercent * 100) / 100 : undefined,
        month_start_amount: monthStats.start_amount,
        month_end_amount: monthStats.end_amount,
        month_change_amount: monthStats.change_amount
          ? Math.round(monthStats.change_amount * 100) / 100
          : undefined,
        month_change_percent: monthStats.change_percent
          ? Math.round(monthStats.change_percent * 100) / 100
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
  estimateGoalCompletion(options: { goal_id?: string } = {}): {
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
  } {
    const { goal_id } = options;

    // Get goals (all or filtered)
    const goals = this.db.getGoals(false);
    let filteredGoals = goals;

    if (goal_id) {
      filteredGoals = goals.filter((g) => g.goal_id === goal_id);
    }

    // Calculate estimates for each goal
    const estimates = filteredGoals.map((goal) => {
      // Get history to calculate average contribution
      const history = this.db.getGoalHistory(goal.goal_id, { limit: 12 });

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
        remaining_amount: remainingAmount ? Math.round(remainingAmount * 100) / 100 : undefined,
        average_monthly_contribution: averageMonthlyContribution
          ? Math.round(averageMonthlyContribution * 100) / 100
          : undefined,
        estimated_months_remaining: estimatedMonthsRemaining,
        estimated_completion_month: estimatedCompletionMonth,
        is_on_track: isOnTrack,
        status: goal.savings?.status,
      };
    });

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
  getGoalContributions(options: {
    goal_id: string;
    start_month?: string;
    end_month?: string;
    limit?: number;
  }): {
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
  } {
    const { goal_id, start_month, end_month, limit = 12 } = options;

    // Get goal details
    const goals = this.db.getGoals(false);
    const goal = goals.find((g) => g.goal_id === goal_id);

    // Get history
    const history = this.db.getGoalHistory(goal_id, {
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
        month_change: Math.round(monthChange * 100) / 100,
        deposits: monthChange > 0 ? Math.round(monthChange * 100) / 100 : undefined,
        withdrawals: monthChange < 0 ? Math.round(Math.abs(monthChange) * 100) / 100 : undefined,
        net: Math.round(monthChange * 100) / 100,
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
      total_contributed: Math.round(totalContributed * 100) / 100,
      total_withdrawn: Math.round(totalWithdrawn * 100) / 100,
      net_contribution: Math.round(netContribution * 100) / 100,
      average_monthly_contribution: Math.round(averageMonthlyContribution * 100) / 100,
      months_analyzed: monthlyBreakdown.length,
      monthly_breakdown: monthlyBreakdown,
    };
  }

  /**
   * Get income transactions (negative amounts or income categories).
   *
   * @param options - Filter options
   * @returns Object with income breakdown
   */
  getIncome(options: { period?: string; start_date?: string; end_date?: string }): {
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
  } {
    const { period } = options;
    let { start_date, end_date } = options;

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Get all transactions in the period
    const allTransactions = this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    // Filter for income (negative amounts or income categories)
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

      // Include negative amounts (income/credits) but try to exclude obvious refunds
      // Refunds are often from merchants where we also have positive transactions
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
          Math.abs(txn.amount) < 500; // Small amounts from these merchants are likely refunds

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
    const incomeBySource = Array.from(sourceMap.entries())
      .map(([source, data]) => ({
        source,
        category_name: data.categoryId ? getCategoryName(data.categoryId) : undefined,
        total: Math.round(data.total * 100) / 100,
        count: data.count,
      }))
      .sort((a, b) => b.total - a.total);

    // Calculate total
    const totalIncome = incomeBySource.reduce((sum, s) => sum + s.total, 0);

    // Enrich transactions with category names
    const enrichedTransactions = incomeTransactions.slice(0, 100).map((txn) => ({
      ...txn,
      category_name: txn.category_id ? getCategoryName(txn.category_id) : undefined,
    }));

    return {
      period: { start_date, end_date },
      total_income: Math.round(totalIncome * 100) / 100,
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
  getSpendingByMerchant(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
    exclude_transfers?: boolean;
  }): {
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
  } {
    const { period, limit = 50, exclude_transfers = false } = options;
    let { start_date, end_date } = options;

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Get transactions with filters
    let transactions = this.db.getTransactions({
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
    const merchantSpending = new Map<
      string,
      { total: number; count: number; categoryId?: string }
    >();

    for (const txn of transactions) {
      // Only count positive amounts (expenses), skip internal transfers
      if (txn.amount <= 0 || txn.internal_transfer) continue;

      const merchantName = getTransactionDisplayName(txn);
      const existing = merchantSpending.get(merchantName) || {
        total: 0,
        count: 0,
        categoryId: txn.category_id,
      };
      existing.total += txn.amount;
      existing.count++;
      merchantSpending.set(merchantName, existing);
    }

    // Convert to list, sorted by spending
    const merchants = Array.from(merchantSpending.entries())
      .map(([merchant, data]) => ({
        merchant,
        category_name: data.categoryId ? getCategoryName(data.categoryId) : undefined,
        total_spending: Math.round(data.total * 100) / 100,
        transaction_count: data.count,
        average_transaction: Math.round((data.total / data.count) * 100) / 100,
      }))
      .sort((a, b) => b.total_spending - a.total_spending)
      .slice(0, limit);

    // Calculate totals
    const totalSpending = merchants.reduce((sum, m) => sum + m.total_spending, 0);

    return {
      period: { start_date, end_date },
      total_spending: Math.round(totalSpending * 100) / 100,
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
  getForeignTransactions(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
  }): {
    period: { start_date?: string; end_date?: string };
    count: number;
    total_amount: number;
    total_fx_fees: number;
    countries: Array<{ country: string; transaction_count: number; total_amount: number }>;
    transactions: Array<Transaction & { category_name?: string; normalized_merchant?: string }>;
  } {
    const { period, limit = 100 } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    const allTransactions = this.db.getTransactions({
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
        total_amount: Math.round(data.total * 100) / 100,
      }))
      .sort((a, b) => b.total_amount - a.total_amount);

    const totalAmount = foreignTxns.reduce((sum, txn) => sum + Math.abs(txn.amount), 0);

    const enrichedTransactions = foreignTxns.slice(0, limit).map((txn) => ({
      ...txn,
      category_name: txn.category_id ? getCategoryName(txn.category_id) : undefined,
      normalized_merchant: normalizeMerchantName(getTransactionDisplayName(txn)),
    }));

    return {
      period: { start_date, end_date },
      count: foreignTxns.length,
      total_amount: Math.round(totalAmount * 100) / 100,
      total_fx_fees: Math.round(totalFxFees * 100) / 100,
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
  getRefunds(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
  }): {
    period: { start_date?: string; end_date?: string };
    count: number;
    total_refunded: number;
    refunds_by_merchant: Array<{ merchant: string; refund_count: number; total_refunded: number }>;
    transactions: Array<Transaction & { category_name?: string }>;
  } {
    const { period, limit = 100 } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    const allTransactions = this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    // Refunds are negative amounts (credits) that are not transfers/income
    const refundTxns = allTransactions.filter((txn) => {
      if (txn.amount >= 0) return false; // Must be a credit
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
        total_refunded: Math.round(data.total * 100) / 100,
      }))
      .sort((a, b) => b.total_refunded - a.total_refunded);

    const totalRefunded = refundTxns.reduce((sum, txn) => sum + Math.abs(txn.amount), 0);

    const enrichedTransactions = refundTxns.slice(0, limit).map((txn) => ({
      ...txn,
      category_name: txn.category_id ? getCategoryName(txn.category_id) : undefined,
    }));

    return {
      period: { start_date, end_date },
      count: refundTxns.length,
      total_refunded: Math.round(totalRefunded * 100) / 100,
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
  getDuplicateTransactions(options: { period?: string; start_date?: string; end_date?: string }): {
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
  } {
    const { period } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    const allTransactions = this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    // Group by: same merchant + same amount + same date (or within 1 day)
    const potentialDuplicates = new Map<string, Transaction[]>();

    for (const txn of allTransactions) {
      const merchant = getTransactionDisplayName(txn);
      const amount = Math.round(txn.amount * 100) / 100;
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
  getCredits(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
  }): {
    period: { start_date?: string; end_date?: string };
    count: number;
    total_credits: number;
    credits_by_type: Array<{ type: string; count: number; total: number }>;
    transactions: Array<Transaction & { category_name?: string; credit_type?: string }>;
  } {
    const { period, limit = 100 } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    const allTransactions = this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    // Credits are negative amounts that look like statement credits
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

    const creditTxns = allTransactions.filter((txn) => {
      if (txn.amount >= 0) return false; // Must be negative (credit)
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
        total: Math.round(data.total * 100) / 100,
      }))
      .sort((a, b) => b.total - a.total);

    const totalCredits = creditTxns.reduce((sum, txn) => sum + Math.abs(txn.amount), 0);

    const enrichedTransactions = creditTxns.slice(0, limit).map((txn) => ({
      ...txn,
      category_name: txn.category_id ? getCategoryName(txn.category_id) : undefined,
      credit_type: getCreditType(txn),
    }));

    return {
      period: { start_date, end_date },
      count: creditTxns.length,
      total_credits: Math.round(totalCredits * 100) / 100,
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
  getSpendingByDayOfWeek(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    exclude_transfers?: boolean;
  }): {
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
  } {
    const { period, exclude_transfers = false } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    let transactions = this.db.getTransactions({
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
        total_spending: Math.round(stats.total * 100) / 100,
        transaction_count: stats.count,
        average_transaction:
          stats.count > 0 ? Math.round((stats.total / stats.count) * 100) / 100 : 0,
        percentage_of_total:
          totalSpending > 0 ? Math.round((stats.total / totalSpending) * 10000) / 100 : 0,
      }))
      .sort((a, b) => a.day_number - b.day_number);

    return {
      period: { start_date, end_date },
      total_spending: Math.round(totalSpending * 100) / 100,
      days,
    };
  }

  /**
   * Detect and group transactions into trips.
   *
   * @param options - Filter options
   * @returns Object with detected trips
   */
  getTrips(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    min_days?: number;
  }): {
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
  } {
    const { period, min_days = 2 } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    const allTransactions = this.db.getTransactions({
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
              for (const t of tripTxns) {
                if (t.amount > 0) {
                  totalSpent += t.amount;
                  const cat = getCategoryName(t.category_id || 'Uncategorized');
                  categoryTotals.set(cat, (categoryTotals.get(cat) || 0) + t.amount);
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
                total_spent: Math.round(totalSpent * 100) / 100,
                transaction_count: tripTxns.length,
                categories: Array.from(categoryTotals.entries())
                  .map(([category, total]) => ({ category, total: Math.round(total * 100) / 100 }))
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
          for (const t of tripTxns) {
            if (t.amount > 0) {
              totalSpent += t.amount;
              const cat = getCategoryName(t.category_id || 'Uncategorized');
              categoryTotals.set(cat, (categoryTotals.get(cat) || 0) + t.amount);
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
            total_spent: Math.round(totalSpent * 100) / 100,
            transaction_count: tripTxns.length,
            categories: Array.from(categoryTotals.entries())
              .map(([category, total]) => ({ category, total: Math.round(total * 100) / 100 }))
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
  getTransactionById(transactionId: string): {
    found: boolean;
    transaction?: Transaction & { category_name?: string; normalized_merchant?: string };
  } {
    const allTransactions = this.db.getAllTransactions();
    const txn = allTransactions.find((t) => t.transaction_id === transactionId);

    if (!txn) {
      return { found: false };
    }

    return {
      found: true,
      transaction: {
        ...txn,
        category_name: txn.category_id ? getCategoryName(txn.category_id) : undefined,
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
  getTopMerchants(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
    exclude_transfers?: boolean;
  }): {
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
  } {
    const { period, limit = 20, exclude_transfers = false } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    let transactions = this.db.getTransactions({
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

    const merchants = Array.from(merchantStats.entries())
      .map(([merchant, stats]) => ({
        merchant,
        normalized_name: normalizeMerchantName(merchant),
        total_spent: Math.round(stats.total * 100) / 100,
        transaction_count: stats.count,
        average_transaction: Math.round((stats.total / stats.count) * 100) / 100,
        first_transaction: stats.firstDate,
        last_transaction: stats.lastDate,
        category_name: stats.categoryId ? getCategoryName(stats.categoryId) : undefined,
      }))
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
  getUnusualTransactions(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    threshold_multiplier?: number;
  }): {
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
  } {
    const { period, threshold_multiplier = 2 } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Get a longer history for baseline calculation
    const allTransactions = this.db.getAllTransactions();
    const periodTransactions = this.db.getTransactions({
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
      const category = txn.category_id || 'Uncategorized';
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
      const category = txn.category_id || 'Uncategorized';
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

      // Flag very large transactions regardless
      if (!isAnomaly && txn.amount > 1000) {
        isAnomaly = true;
        reason = 'Large transaction (>$1000)';
      }

      if (isAnomaly) {
        anomalies.push({
          ...txn,
          category_name: txn.category_id ? getCategoryName(txn.category_id) : undefined,
          anomaly_reason: reason,
          expected_amount: expected ? Math.round(expected * 100) / 100 : undefined,
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
  exportTransactions(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    format?: 'csv' | 'json';
    include_fields?: string[];
  }): {
    format: string;
    record_count: number;
    data: string;
  } {
    const { period, format = 'csv', include_fields } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    const transactions = this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    const defaultFields = ['date', 'amount', 'name', 'category_id', 'account_id', 'pending'];
    const fields = include_fields || defaultFields;

    // Enrich with category names
    const enriched = transactions.map((txn) => ({
      ...txn,
      category_name: txn.category_id ? getCategoryName(txn.category_id) : '',
      normalized_merchant: normalizeMerchantName(getTransactionDisplayName(txn)),
    }));

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
  getHsaFsaEligible(options: { period?: string; start_date?: string; end_date?: string }): {
    period: { start_date?: string; end_date?: string };
    count: number;
    total_amount: number;
    by_category: Array<{ category: string; count: number; total: number }>;
    transactions: Array<Transaction & { category_name?: string; eligibility_reason: string }>;
  } {
    const { period } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    const transactions = this.db.getTransactions({
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

    const hsaEligible = transactions.filter((txn) => {
      if (txn.amount <= 0) return false;

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
        total: Math.round(data.total * 100) / 100,
      }))
      .sort((a, b) => b.total - a.total);

    const totalAmount = hsaEligible.reduce((sum, txn) => sum + txn.amount, 0);

    return {
      period: { start_date, end_date },
      count: hsaEligible.length,
      total_amount: Math.round(totalAmount * 100) / 100,
      by_category: byCategory,
      transactions: hsaEligible.slice(0, 100).map((txn) => ({
        ...txn,
        category_name: txn.category_id ? getCategoryName(txn.category_id) : undefined,
        eligibility_reason: getEligibilityReason(txn),
      })),
    };
  }

  /**
   * Get spending rate/velocity analysis.
   *
   * @param options - Filter options
   * @returns Spending rate analysis with projections
   */
  getSpendingRate(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
    exclude_transfers?: boolean;
  }): {
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
  } {
    const { period, exclude_transfers = false } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    } else if (!start_date && !end_date) {
      // Default to this month
      [start_date, end_date] = parsePeriod('this_month');
    }

    let transactions = this.db.getTransactions({
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
    const totalSpending = transactions
      .filter((txn) => txn.amount > 0 && !txn.internal_transfer)
      .reduce((sum, txn) => sum + txn.amount, 0);

    const dailyAverage = daysElapsed > 0 ? totalSpending / daysElapsed : 0;
    const weeklyAverage = dailyAverage * 7;
    const projectedMonthlyTotal = dailyAverage * 30;

    // Weekly breakdown (exclude internal transfers)
    const weeklyTotals = new Map<
      string,
      { start: string; end: string; total: number; days: number }
    >();
    for (const txn of transactions) {
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
      existing.total += txn.amount;
      weeklyTotals.set(weekKey, existing);
    }

    const spendingByWeek = Array.from(weeklyTotals.values())
      .map((week) => ({
        week_start: week.start,
        week_end: week.end,
        total: Math.round(week.total * 100) / 100,
        daily_average: Math.round((week.total / week.days) * 100) / 100,
      }))
      .sort((a, b) => a.week_start.localeCompare(b.week_start));

    // Compare to previous period
    const periodLength = daysInPeriod;
    const prevStart = new Date(startDateObj);
    prevStart.setDate(prevStart.getDate() - periodLength);
    const prevEnd = new Date(startDateObj);
    prevEnd.setDate(prevEnd.getDate() - 1);

    let prevTransactions = this.db.getTransactions({
      startDate: prevStart.toISOString().substring(0, 10),
      endDate: prevEnd.toISOString().substring(0, 10),
      limit: 50000,
    });

    if (exclude_transfers) {
      prevTransactions = prevTransactions.filter((txn) => !isTransferCategory(txn.category_id));
    }

    const previousPeriodTotal = prevTransactions
      .filter((txn) => txn.amount > 0)
      .reduce((sum, txn) => sum + txn.amount, 0);

    const changePercent =
      previousPeriodTotal > 0
        ? Math.round(((totalSpending - previousPeriodTotal) / previousPeriodTotal) * 10000) / 100
        : 0;

    // Are we on track? (spending less than prorated amount from last period)
    const proratedPrevious = (previousPeriodTotal / periodLength) * daysElapsed;
    const onTrack = totalSpending <= proratedPrevious;

    return {
      period: { start_date, end_date },
      days_in_period: daysInPeriod,
      days_elapsed: daysElapsed,
      total_spending: Math.round(totalSpending * 100) / 100,
      daily_average: Math.round(dailyAverage * 100) / 100,
      weekly_average: Math.round(weeklyAverage * 100) / 100,
      projected_monthly_total: Math.round(projectedMonthlyTotal * 100) / 100,
      spending_by_week: spendingByWeek,
      comparison_to_previous: {
        previous_period_total: Math.round(previousPeriodTotal * 100) / 100,
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
   * @param options - Filter options
   * @returns Object with various data quality metrics and issues
   */
  getDataQualityReport(options: { period?: string; start_date?: string; end_date?: string }): {
    period: { start_date?: string; end_date?: string };
    summary: {
      total_transactions: number;
      total_accounts: number;
      issues_found: number;
    };
    category_issues: {
      unresolved_category_count: number;
      unresolved_categories: Array<{
        category_id: string;
        transaction_count: number;
        total_amount: number;
        sample_transactions: Array<{ date: string; merchant: string; amount: number }>;
      }>;
    };
    currency_issues: {
      potential_unconverted_count: number;
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
      non_unique_transaction_ids: Array<{
        transaction_id: string;
        occurrences: number;
        sample_dates: string[];
      }>;
      potential_duplicate_accounts: Array<{
        account_name: string;
        account_type: string;
        count: number;
        account_ids: string[];
        balances: number[];
      }>;
    };
    suspicious_categorizations: Array<{
      transaction_id: string;
      date: string;
      merchant: string;
      amount: number;
      category_assigned: string;
      reason: string;
    }>;
  } {
    const { period } = options;
    let { start_date, end_date } = options;

    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    const allTransactions = this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      limit: 50000,
    });

    const allAccounts = this.db.getAccounts();

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

      const categoryName = getCategoryName(txn.category_id);

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
        total_amount: Math.round(data.total * 100) / 100,
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
      if (hasForeignIndicator && amount > 1000 && currency === 'USD') {
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
      if (amount > 500 && amount % 1000 < 10 && hasForeignIndicator) {
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

    const nonUniqueTransactionIds = Array.from(transactionIdCounts.entries())
      .filter(([_, occurrences]) => occurrences.length > 1)
      .map(([transaction_id, occurrences]) => ({
        transaction_id,
        occurrences: occurrences.length,
        sample_dates: occurrences.slice(0, 5).map((o) => o.date),
      }))
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 20); // Top 20

    issuesFound += nonUniqueTransactionIds.length;

    // Check for potential duplicate accounts
    const accountsByNameAndType = new Map<
      string,
      Array<{ id: string; name: string; type: string; balance: number }>
    >();

    for (const account of allAccounts) {
      const accountName = account.name || account.official_name || 'Unknown';
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
      const categoryName = txn.category_id ? getCategoryName(txn.category_id) : 'Unknown';

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

    issuesFound += suspiciousCategorizations.length;

    return {
      period: { start_date, end_date },
      summary: {
        total_transactions: allTransactions.length,
        total_accounts: allAccounts.length,
        issues_found: issuesFound,
      },
      category_issues: {
        unresolved_category_count: unresolvedCategoryList.length,
        unresolved_categories: unresolvedCategoryList,
      },
      currency_issues: {
        potential_unconverted_count: suspiciousCurrencyTransactions.length,
        suspicious_transactions: suspiciousCurrencyTransactions.slice(0, 20), // Limit to top 20
      },
      duplicate_issues: {
        non_unique_transaction_ids: nonUniqueTransactionIds,
        potential_duplicate_accounts: potentialDuplicateAccounts,
      },
      suspicious_categorizations: suspiciousCategorizations.slice(0, 20), // Limit to top 20
    };
  }

  /**
   * Compare spending between two time periods.
   *
   * @param options - Filter options
   * @returns Object with comparison between two periods
   */
  comparePeriods(options: { period1: string; period2: string; exclude_transfers?: boolean }): {
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
  } {
    const { period1, period2, exclude_transfers = false } = options;

    // Parse periods
    const [start1, end1] = parsePeriod(period1);
    const [start2, end2] = parsePeriod(period2);

    // Helper to analyze a period
    const analyzePeriod = (
      startDate: string,
      endDate: string
    ): {
      spending: number;
      income: number;
      count: number;
      byCategory: Map<string, number>;
    } => {
      let transactions = this.db.getTransactions({
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

      for (const txn of transactions) {
        // Always exclude internal transfers from spending calculations
        if (txn.amount > 0 && !txn.internal_transfer) {
          spending += txn.amount;
          const cat = txn.category_id || 'Uncategorized';
          byCategory.set(cat, (byCategory.get(cat) || 0) + txn.amount);
        } else if (txn.amount < 0) {
          income += Math.abs(txn.amount);
        }
      }

      return {
        spending: Math.round(spending * 100) / 100,
        income: Math.round(income * 100) / 100,
        count: transactions.length,
        byCategory,
      };
    };

    const p1Data = analyzePeriod(start1, end1);
    const p2Data = analyzePeriod(start2, end2);

    // Calculate changes
    const spendingChange = p2Data.spending - p1Data.spending;
    const spendingChangePercent =
      p1Data.spending > 0 ? Math.round((spendingChange / p1Data.spending) * 10000) / 100 : 0;

    const incomeChange = p2Data.income - p1Data.income;
    const incomeChangePercent =
      p1Data.income > 0 ? Math.round((incomeChange / p1Data.income) * 10000) / 100 : 0;

    // Compare categories
    const allCategories = new Set([...p1Data.byCategory.keys(), ...p2Data.byCategory.keys()]);

    const categoryComparison = Array.from(allCategories)
      .map((categoryId) => {
        const p1Spending = p1Data.byCategory.get(categoryId) || 0;
        const p2Spending = p2Data.byCategory.get(categoryId) || 0;
        const change = p2Spending - p1Spending;
        const changePercent = p1Spending > 0 ? Math.round((change / p1Spending) * 10000) / 100 : 0;

        return {
          category_id: categoryId,
          category_name: getCategoryName(categoryId),
          period1_spending: Math.round(p1Spending * 100) / 100,
          period2_spending: Math.round(p2Spending * 100) / 100,
          change: Math.round(change * 100) / 100,
          change_percent: changePercent,
        };
      })
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    return {
      period1: {
        name: period1,
        start_date: start1,
        end_date: end1,
        total_spending: p1Data.spending,
        total_income: p1Data.income,
        net: Math.round((p1Data.income - p1Data.spending) * 100) / 100,
        transaction_count: p1Data.count,
      },
      period2: {
        name: period2,
        start_date: start2,
        end_date: end2,
        total_spending: p2Data.spending,
        total_income: p2Data.income,
        net: Math.round((p2Data.income - p2Data.spending) * 100) / 100,
        transaction_count: p2Data.count,
      },
      comparison: {
        spending_change: Math.round(spendingChange * 100) / 100,
        spending_change_percent: spendingChangePercent,
        income_change: Math.round(incomeChange * 100) / 100,
        income_change_percent: incomeChangePercent,
        net_change:
          Math.round((p2Data.income - p2Data.spending - (p1Data.income - p1Data.spending)) * 100) /
          100,
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
  getInvestmentPrices(options: { ticker_symbol?: string } = {}): {
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
  } {
    const { ticker_symbol } = options;

    // Get latest prices (no date filter to get most recent)
    const prices = this.db.getInvestmentPrices({
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
  getInvestmentPriceHistory(options: {
    ticker_symbol: string;
    start_date?: string;
    end_date?: string;
    price_type?: 'daily' | 'hf';
  }): {
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
  } {
    const { ticker_symbol, start_date, end_date, price_type } = options;

    // Validate required parameter
    if (!ticker_symbol) {
      throw new Error('ticker_symbol is required');
    }

    // Get historical prices for this ticker
    const prices = this.db.getInvestmentPrices({
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
          latestPrice && earliestPrice
            ? Math.round((latestPrice - earliestPrice) * 100) / 100
            : undefined,
        price_change_percent:
          latestPrice && earliestPrice && earliestPrice > 0
            ? Math.round(((latestPrice - earliestPrice) / earliestPrice) * 10000) / 100
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
  getInvestmentSplits(
    options: {
      ticker_symbol?: string;
      start_date?: string;
      end_date?: string;
    } = {}
  ): {
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
  } {
    const { ticker_symbol, start_date, end_date } = options;

    // Get splits from database
    const splits = this.db.getInvestmentSplits({
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
  getConnectedInstitutions(
    options: {
      connection_status?: string;
      institution_id?: string;
      needs_update?: boolean;
    } = {}
  ): {
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
  } {
    const { connection_status, institution_id, needs_update } = options;

    // Get items from database
    const items = this.db.getItems({
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
  getSpendingOverTime(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      granularity?: 'day' | 'week' | 'month';
      category?: string;
      exclude_transfers?: boolean;
    } = {}
  ): {
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
  } {
    const allTransactions = this.db.getTransactions();
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
      return txDate >= startDate && txDate <= endDate && t.amount < 0;
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

      if (!periodMap.has(periodKey)) {
        periodMap.set(periodKey, {
          start: periodBounds.start,
          end: periodBounds.end,
          total: 0,
          count: 0,
        });
      }

      const period = periodMap.get(periodKey)!;
      period.total += Math.abs(t.amount);
      period.count += 1;
    }

    // Convert to sorted array
    const periods = Array.from(periodMap.entries())
      .sort((a, b) => a[1].start.getTime() - b[1].start.getTime())
      .map(([, data]) => ({
        period_start: data.start.toISOString().substring(0, 10),
        period_end: data.end.toISOString().substring(0, 10),
        total_spending: Math.round(data.total * 100) / 100,
        transaction_count: data.count,
        average_transaction: data.count > 0 ? Math.round((data.total / data.count) * 100) / 100 : 0,
      }));

    // Calculate summary
    const totalSpending = periods.reduce((sum, p) => sum + p.total_spending, 0);
    const avgPerPeriod =
      periods.length > 0 ? Math.round((totalSpending / periods.length) * 100) / 100 : 0;

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
        total_spending: Math.round(totalSpending * 100) / 100,
        average_per_period: avgPerPeriod,
        highest_period: highest,
        lowest_period: lowest,
      },
    };
  }

  /**
   * Get period key for grouping (helper method).
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
   * Get period bounds for a date (helper method).
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
  getAverageTransactionSize(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      group_by?: 'category' | 'merchant';
      limit?: number;
    } = {}
  ): {
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
  } {
    const allTransactions = this.db.getTransactions();
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
        t.amount < 0 &&
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
        key = getCategoryName(t.category_id || 'uncategorized');
      }

      if (!groupMap.has(key)) {
        groupMap.set(key, { amounts: [], total: 0, min: Infinity, max: 0 });
      }

      const group = groupMap.get(key)!;
      group.amounts.push(amount);
      group.total += amount;
      group.min = Math.min(group.min, amount);
      group.max = Math.max(group.max, amount);
    }

    // Calculate overall average
    const allAmounts = filtered.map((t) => Math.abs(t.amount));
    const overallAvg =
      allAmounts.length > 0
        ? Math.round((allAmounts.reduce((a, b) => a + b, 0) / allAmounts.length) * 100) / 100
        : 0;

    // Convert to sorted array
    const groups = Array.from(groupMap.entries())
      .map(([name, data]) => ({
        name,
        average_amount: Math.round((data.total / data.amounts.length) * 100) / 100,
        transaction_count: data.amounts.length,
        total_amount: Math.round(data.total * 100) / 100,
        min_amount: data.min === Infinity ? 0 : Math.round(data.min * 100) / 100,
        max_amount: Math.round(data.max * 100) / 100,
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
  getCategoryTrends(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      compare_to_previous?: boolean;
      limit?: number;
    } = {}
  ): {
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
  } {
    const allTransactions = this.db.getTransactions();
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
        t.amount < 0 &&
        !isTransferCategory(t.category_id)
      );
    });

    const previousTransactions = compareToPrevious
      ? allTransactions.filter((t) => {
          const txDate = new Date(t.date);
          return (
            txDate >= previousStart &&
            txDate <= previousEnd &&
            t.amount < 0 &&
            !isTransferCategory(t.category_id)
          );
        })
      : [];

    // Aggregate by category for current period
    const currentByCategory = new Map<string, { id: string; total: number }>();
    for (const t of currentTransactions) {
      const catId = t.category_id || 'uncategorized';
      if (!currentByCategory.has(catId)) {
        currentByCategory.set(catId, { id: catId, total: 0 });
      }
      currentByCategory.get(catId)!.total += Math.abs(t.amount);
    }

    // Aggregate by category for previous period
    const previousByCategory = new Map<string, number>();
    for (const t of previousTransactions) {
      const catId = t.category_id || 'uncategorized';
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
        category: getCategoryName(catId),
        category_id: catId,
        current_amount: Math.round(currentAmount * 100) / 100,
        previous_amount: previousAmount !== null ? Math.round(previousAmount * 100) / 100 : null,
        change_amount: changeAmount !== null ? Math.round(changeAmount * 100) / 100 : null,
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
  getMerchantFrequency(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      min_visits?: number;
      limit?: number;
    } = {}
  ): {
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
  } {
    const allTransactions = this.db.getTransactions();
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
        t.amount < 0 &&
        !isTransferCategory(t.category_id) &&
        t.name
      );
    });

    // Group by merchant
    const merchantMap = new Map<string, { dates: Date[]; total: number }>();

    for (const t of filtered) {
      const merchant = t.name ? normalizeMerchantName(t.name) : 'Unknown';

      if (!merchantMap.has(merchant)) {
        merchantMap.set(merchant, { dates: [], total: 0 });
      }

      const data = merchantMap.get(merchant)!;
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
        const firstVisit = data.dates[0]!;
        const lastVisit = data.dates[data.dates.length - 1]!;

        let daysBetween: number | null = null;
        if (visitCount > 1) {
          const totalDays = (lastVisit.getTime() - firstVisit.getTime()) / (24 * 60 * 60 * 1000);
          daysBetween = Math.round(totalDays / (visitCount - 1));
        }

        return {
          merchant,
          visit_count: visitCount,
          total_spent: Math.round(data.total * 100) / 100,
          average_per_visit: Math.round((data.total / visitCount) * 100) / 100,
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
  getBudgetUtilization(
    options: {
      month?: string;
      category?: string;
      include_inactive?: boolean;
    } = {}
  ): {
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
  } {
    const budgets = this.db.getBudgets();
    const transactions = this.db.getTransactions();

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
        t.amount < 0 &&
        !isTransferCategory(t.category_id)
      );
    });

    // Group spending by category
    const spendingByCategory = new Map<string, number>();
    for (const t of monthTransactions) {
      const catId = t.category_id || 'uncategorized';
      spendingByCategory.set(catId, (spendingByCategory.get(catId) || 0) + Math.abs(t.amount));
    }

    // Build utilization data
    const utilizationData = filtered.map((b) => {
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
        category: getCategoryName(categoryId),
        category_id: categoryId,
        budget_amount: Math.round(budgetAmount * 100) / 100,
        spent_amount: Math.round(spent * 100) / 100,
        remaining: Math.round(remaining * 100) / 100,
        utilization_percentage: Math.round(utilization * 10) / 10,
        status,
      };
    });

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
        total_budgeted: Math.round(totalBudgeted * 100) / 100,
        total_spent: Math.round(totalSpent * 100) / 100,
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
  getBudgetVsActual(
    options: {
      months?: number;
      category?: string;
    } = {}
  ): {
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
  } {
    const numMonths = options.months || 6;
    const budgets = this.db.getBudgets().filter((b) => b.is_active !== false);
    const transactions = this.db.getTransactions();

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
          t.amount < 0 &&
          !isTransferCategory(t.category_id) &&
          matchesCategory
        );
      });

      const totalActual = monthTransactions.reduce((sum, t) => sum + Math.abs(t.amount), 0);
      const difference = totalBudgetedPerMonth - totalActual;
      const variance = totalBudgetedPerMonth > 0 ? (difference / totalBudgetedPerMonth) * 100 : 0;

      return {
        month,
        total_budgeted: Math.round(totalBudgetedPerMonth * 100) / 100,
        total_actual: Math.round(totalActual * 100) / 100,
        difference: Math.round(difference * 100) / 100,
        variance_percentage: Math.round(variance * 10) / 10,
      };
    });

    // Category breakdown
    const categoryData = new Map<string, { budgeted: number; actuals: number[] }>();

    for (const b of filteredBudgets) {
      const catId = b.category_id || 'uncategorized';
      if (!categoryData.has(catId)) {
        categoryData.set(catId, { budgeted: 0, actuals: [] });
      }
      categoryData.get(catId)!.budgeted += b.amount || 0;
    }

    // Get actual spending per category
    for (const month of months) {
      const monthStart = `${month}-01`;
      const monthEnd = `${month}-31`;

      for (const [catId, data] of categoryData.entries()) {
        const spent = transactions
          .filter(
            (t) =>
              t.date >= monthStart && t.date <= monthEnd && t.category_id === catId && t.amount < 0
          )
          .reduce((sum, t) => sum + Math.abs(t.amount), 0);
        data.actuals.push(spent);
      }
    }

    const categoryBreakdown = Array.from(categoryData.entries()).map(([catId, data]) => {
      const avgBudgeted = data.budgeted;
      const avgActual =
        data.actuals.length > 0 ? data.actuals.reduce((a, b) => a + b, 0) / data.actuals.length : 0;

      // Calculate consistency (lower variance = higher score)
      const variance =
        data.actuals.length > 0
          ? data.actuals.reduce((sum, v) => sum + Math.pow(v - avgActual, 2), 0) /
            data.actuals.length
          : 0;
      const stdDev = Math.sqrt(variance);
      const consistencyScore = avgActual > 0 ? Math.max(0, 100 - (stdDev / avgActual) * 100) : 100;

      return {
        category: getCategoryName(catId),
        category_id: catId,
        avg_budgeted: Math.round(avgBudgeted * 100) / 100,
        avg_actual: Math.round(avgActual * 100) / 100,
        consistency_score: Math.round(consistencyScore),
      };
    });

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
  getBudgetRecommendations(
    options: {
      months?: number;
    } = {}
  ): {
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
  } {
    const numMonths = options.months || 3;
    const budgets = this.db.getBudgets().filter((b) => b.is_active !== false);
    const transactions = this.db.getTransactions();

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
          t.amount < 0 &&
          !isTransferCategory(t.category_id)
      );

      const spendingThisMonth = new Map<string, number>();
      for (const t of monthTxns) {
        const catId = t.category_id || 'uncategorized';
        spendingThisMonth.set(catId, (spendingThisMonth.get(catId) || 0) + Math.abs(t.amount));
      }

      for (const [catId, amount] of spendingThisMonth.entries()) {
        if (!categorySpending.has(catId)) {
          categorySpending.set(catId, []);
        }
        categorySpending.get(catId)!.push(amount);
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
      const recommendedBudget = Math.round(avgSpending * 1.1 * 100) / 100;
      const diff = currentBudget - recommendedBudget;
      const diffPercent = currentBudget > 0 ? (diff / currentBudget) * 100 : 0;

      let reason = 'Budget appears well-calibrated';
      if (diffPercent > 20) {
        reason = `Budget may be ${Math.round(diffPercent)}% higher than needed`;
      } else if (diffPercent < -20) {
        reason = `Budget may be ${Math.abs(Math.round(diffPercent))}% too low`;
      }

      recommendations.push({
        category: getCategoryName(catId),
        category_id: catId,
        current_budget: currentBudget,
        recommended_budget: recommendedBudget,
        avg_spending: Math.round(avgSpending * 100) / 100,
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
            category: getCategoryName(catId),
            category_id: catId,
            avg_spending: Math.round(avgSpending * 100) / 100,
            suggested_budget: Math.round(avgSpending * 1.1 * 100) / 100,
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
        total_current_budget: Math.round(totalCurrent * 100) / 100,
        total_recommended: Math.round(totalRecommended * 100) / 100,
        potential_savings: Math.round((totalCurrent - totalRecommended) * 100) / 100,
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
  getBudgetAlerts(
    options: {
      threshold_percentage?: number;
      month?: string;
    } = {}
  ): {
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
  } {
    const threshold = options.threshold_percentage || 80;
    const budgets = this.db.getBudgets().filter((b) => b.is_active !== false);
    const transactions = this.db.getTransactions();

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
        t.amount < 0 &&
        !isTransferCategory(t.category_id)
      );
    });

    // Group spending by category
    const spendingByCategory = new Map<string, number>();
    for (const t of monthTransactions) {
      const catId = t.category_id || 'uncategorized';
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
        projectedTotal = Math.round(dailyRate * daysInMonth * 100) / 100;
      }

      // Determine alert type and message
      let alertType: 'exceeded' | 'warning' | 'approaching' = 'approaching';
      let message = '';

      if (utilization >= 100) {
        alertType = 'exceeded';
        const overAmount = Math.round((spent - budgetAmount) * 100) / 100;
        message = `Over budget by $${overAmount}`;
      } else if (utilization >= 90) {
        alertType = 'warning';
        const remaining = Math.round((budgetAmount - spent) * 100) / 100;
        message = `Only $${remaining} remaining with ${daysRemaining} days left`;
      } else {
        alertType = 'approaching';
        message = `${Math.round(utilization)}% used - on pace to ${
          projectedTotal && projectedTotal > budgetAmount ? 'exceed' : 'stay within'
        } budget`;
      }

      alerts.push({
        budget_id: b.budget_id,
        category: getCategoryName(categoryId),
        category_id: categoryId,
        alert_type: alertType,
        budget_amount: Math.round(budgetAmount * 100) / 100,
        spent_amount: Math.round(spent * 100) / 100,
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
        total_over_budget: Math.round(totalOverBudget * 100) / 100,
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
  getPortfolioAllocation(options: { include_prices?: boolean } = {}): {
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
  } {
    const { include_prices = true } = options;

    // Get investment accounts
    const accounts = this.db.getAccounts();
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
    const byAccount = investmentAccounts.map((a) => ({
      account_id: a.account_id,
      account_name: a.name || a.official_name || 'Unknown',
      institution: a.institution_name || 'Unknown',
      balance: Math.round((a.current_balance || 0) * 100) / 100,
      percentage:
        totalValue > 0 ? Math.round(((a.current_balance || 0) / totalValue) * 1000) / 10 : 0,
    }));

    // Sort by balance descending
    byAccount.sort((a, b) => b.balance - a.balance);

    // Get securities from investment prices
    let bySecurity: Array<{
      ticker_symbol: string;
      latest_price?: number;
      price_date?: string;
    }> = [];

    if (include_prices) {
      const prices = this.db.getInvestmentPrices({});

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
          latest_price: s.price ? Math.round(s.price * 100) / 100 : undefined,
          price_date: s.date,
        }))
        .sort((a, b) => a.ticker_symbol.localeCompare(b.ticker_symbol));
    }

    // Summary
    const largestAccount = byAccount[0] ?? null;

    return {
      total_value: Math.round(totalValue * 100) / 100,
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
  getInvestmentPerformance(
    options: {
      ticker_symbol?: string;
      period?: string;
      start_date?: string;
      end_date?: string;
    } = {}
  ): {
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
  } {
    const { ticker_symbol, period = 'last_30_days' } = options;
    let { start_date, end_date } = options;

    // Parse period to get date range
    if (!start_date || !end_date) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Get price data
    const prices = this.db.getInvestmentPrices({
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
        if (!byTicker.has(ticker)) {
          byTicker.set(ticker, []);
        }
        byTicker.get(ticker)!.push({ date, price });
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
        priceChange = Math.round((endPrice - startPrice) * 100) / 100;
        percentChange =
          startPrice !== 0
            ? Math.round(((endPrice - startPrice) / startPrice) * 10000) / 100
            : null;

        if (percentChange !== null) {
          if (percentChange > 0.5) trend = 'up';
          else if (percentChange < -0.5) trend = 'down';
          else trend = 'flat';
        }
      }

      performance.push({
        ticker_symbol: ticker,
        start_price: startPrice ? Math.round(startPrice * 100) / 100 : null,
        end_price: endPrice ? Math.round(endPrice * 100) / 100 : null,
        high_price: Math.round(highPrice * 100) / 100,
        low_price: Math.round(lowPrice * 100) / 100,
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
  getDividendIncome(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      account_id?: string;
    } = {}
  ): {
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
  } {
    const { period = 'ytd', account_id } = options;
    let { start_date, end_date } = options;

    // Parse period to get date range
    if (!start_date || !end_date) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Dividend-related category IDs
    const dividendCategories = new Set(['dividend', 'income_dividends', 'capital_gain']);

    // Get transactions that are dividend income
    const transactions = this.db.getTransactions();
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
      amount: Math.abs(Math.round(t.amount * 100) / 100),
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
        amount: Math.round(data.amount * 100) / 100,
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
        amount: Math.round(data.amount * 100) / 100,
        count: data.count,
      }))
      .sort((a, b) => b.amount - a.amount);

    // Summary calculations
    const avgDividend =
      formattedDividends.length > 0
        ? Math.round((totalDividends / formattedDividends.length) * 100) / 100
        : 0;
    const largestDividend =
      formattedDividends.length > 0 ? Math.max(...formattedDividends.map((d) => d.amount)) : 0;
    const monthlyAvg =
      byMonth.length > 0 ? Math.round((totalDividends / byMonth.length) * 100) / 100 : 0;

    return {
      period: {
        start_date: start_date,
        end_date: end_date,
      },
      total_dividends: Math.round(totalDividends * 100) / 100,
      dividend_count: formattedDividends.length,
      dividends: formattedDividends,
      by_month: byMonth,
      by_source: bySource,
      summary: {
        average_dividend: avgDividend,
        largest_dividend: Math.round(largestDividend * 100) / 100,
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
  getInvestmentFees(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      account_id?: string;
    } = {}
  ): {
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
  } {
    const { period = 'ytd', account_id } = options;
    let { start_date, end_date } = options;

    // Parse period to get date range
    if (!start_date || !end_date) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Get investment accounts
    const accounts = this.db.getAccounts();
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
    const transactions = this.db.getTransactions();
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
      amount: Math.round(t.amount * 100) / 100,
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
        amount: Math.round(data.amount * 100) / 100,
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
        amount: Math.round(data.amount * 100) / 100,
        count: data.count,
      }))
      .sort((a, b) => b.month.localeCompare(a.month));

    // Summary calculations
    const avgFee =
      formattedFees.length > 0 ? Math.round((totalFees / formattedFees.length) * 100) / 100 : 0;
    const largestFee =
      formattedFees.length > 0 ? Math.max(...formattedFees.map((f) => f.amount)) : 0;
    const monthlyAvg =
      byMonth.length > 0 ? Math.round((totalFees / byMonth.length) * 100) / 100 : 0;

    return {
      period: {
        start_date: start_date,
        end_date: end_date,
      },
      total_fees: Math.round(totalFees * 100) / 100,
      fee_count: formattedFees.length,
      fees: formattedFees,
      by_type: byType,
      by_month: byMonth,
      summary: {
        average_fee: avgFee,
        largest_fee: Math.round(largestFee * 100) / 100,
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
  getGoalProjection(options: { goal_id?: string } = {}): {
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
  } {
    const { goal_id } = options;

    const goals = this.db.getGoals(false);
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
      const history = this.db.getGoalHistory(goal.goal_id, { limit: 12 });

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
          monthly_contribution: Math.round(monthlyAmount * 100) / 100,
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
        target_amount: Math.round(targetAmount * 100) / 100,
        current_amount: Math.round(currentAmount * 100) / 100,
        remaining_amount: Math.round(remaining * 100) / 100,
        progress_percent: Math.round(progressPercent * 10) / 10,
        historical_monthly_contribution: Math.round(historicalContribution * 100) / 100,
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
  getGoalMilestones(options: { goal_id?: string } = {}): {
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
  } {
    const { goal_id } = options;

    const goals = this.db.getGoals(false);
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
      const history = this.db.getGoalHistory(goal.goal_id, { limit: 24 });
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
          amount_needed: Math.round((milestone25Amount - currentAmount) * 100) / 100,
        };
      } else if (!milestone50Achieved) {
        nextMilestone = {
          percentage: 50,
          amount_needed: Math.round((milestone50Amount - currentAmount) * 100) / 100,
        };
      } else if (!milestone75Achieved) {
        nextMilestone = {
          percentage: 75,
          amount_needed: Math.round((milestone75Amount - currentAmount) * 100) / 100,
        };
      } else if (!milestone100Achieved) {
        nextMilestone = {
          percentage: 100,
          amount_needed: Math.round((milestone100Amount - currentAmount) * 100) / 100,
        };
      }

      milestoneData.push({
        goal_id: goal.goal_id,
        name: goal.name,
        target_amount: Math.round(targetAmount * 100) / 100,
        current_amount: Math.round(currentAmount * 100) / 100,
        progress_percent: Math.round(progressPercent * 10) / 10,
        milestones: {
          milestone_25: {
            achieved: milestone25Achieved,
            achieved_date: milestone25Achieved ? findMilestoneDate(milestone25Amount) : undefined,
            amount: Math.round(milestone25Amount * 100) / 100,
          },
          milestone_50: {
            achieved: milestone50Achieved,
            achieved_date: milestone50Achieved ? findMilestoneDate(milestone50Amount) : undefined,
            amount: Math.round(milestone50Amount * 100) / 100,
          },
          milestone_75: {
            achieved: milestone75Achieved,
            achieved_date: milestone75Achieved ? findMilestoneDate(milestone75Amount) : undefined,
            amount: Math.round(milestone75Amount * 100) / 100,
          },
          milestone_100: {
            achieved: milestone100Achieved,
            achieved_date: milestone100Achieved ? findMilestoneDate(milestone100Amount) : undefined,
            amount: Math.round(milestone100Amount * 100) / 100,
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
  getGoalsAtRisk(
    options: {
      months_lookback?: number;
      risk_threshold?: number;
    } = {}
  ): {
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
  } {
    const { months_lookback = 6, risk_threshold = 50 } = options;

    const goals = this.db.getGoals(false);
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
      const history = this.db.getGoalHistory(goal.goal_id, { limit: months_lookback });

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
          target_amount: Math.round(targetAmount * 100) / 100,
          current_amount: Math.round(currentAmount * 100) / 100,
          remaining_amount: Math.round(remaining * 100) / 100,
          progress_percent: Math.round(progressPercent * 10) / 10,
          risk_level: riskLevel,
          risk_factors: riskFactors,
          historical_monthly_contribution: Math.round(historicalContribution * 100) / 100,
          required_monthly_contribution: Math.round(requiredMonthly * 100) / 100,
          contribution_gap: Math.round(Math.max(0, contributionGap) * 100) / 100,
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
          atRiskGoals.length > 0 ? Math.round((totalGap / atRiskGoals.length) * 100) / 100 : 0,
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
  getGoalRecommendations(options: { goal_id?: string } = {}): {
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
  } {
    const { goal_id } = options;

    const goals = this.db.getGoals(false);
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
      const history = this.db.getGoalHistory(goal.goal_id, { limit: 6 });

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
          suggested_value: Math.round((remaining / 12) * 100) / 100,
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
          current_value: Math.round(historicalContribution * 100) / 100,
          suggested_value: Math.round(plannedContribution * 100) / 100,
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
          current_value: Math.round(currentAmount * 100) / 100,
          impact: `Only $${Math.round(remaining * 100) / 100} left to reach your goal`,
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
            current_value: Math.round(targetAmount * 100) / 100,
            suggested_value: Math.round(achievableTarget * 100) / 100,
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
            current_value: Math.round(historicalContribution * 100) / 100,
            suggested_value: Math.round((remaining / 24) * 100) / 100,
            impact: `Increasing to $${Math.round((remaining / 24) * 100) / 100}/month achieves goal in 2 years`,
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
  getAccountActivity(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      account_type?: string;
    } = {}
  ): {
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
  } {
    const { period = 'last_30_days', account_type } = options;
    let { start_date, end_date } = options;

    if (!start_date || !end_date) {
      [start_date, end_date] = parsePeriod(period);
    }

    const accounts = this.db.getAccounts();
    const transactions = this.db.getTransactions();

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
        mostActiveAccount = account.name || account.official_name || 'Unknown';
      }

      activityData.push({
        account_id: account.account_id,
        account_name: account.name || account.official_name || 'Unknown',
        account_type: account.account_type,
        institution: account.institution_name,
        transaction_count: count,
        total_inflow: Math.round(totalInflow * 100) / 100,
        total_outflow: Math.round(totalOutflow * 100) / 100,
        net_flow: Math.round(netFlow * 100) / 100,
        average_transaction: Math.round(avgTxn * 100) / 100,
        largest_transaction: Math.round(largestTxn * 100) / 100,
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
  getBalanceTrends(
    options: {
      account_id?: string;
      months?: number;
      granularity?: 'daily' | 'weekly' | 'monthly';
    } = {}
  ): {
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
  } {
    const { account_id, months = 6, granularity = 'monthly' } = options;

    const accounts = this.db.getAccounts();
    const transactions = this.db.getTransactions();

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
          inflow: Math.round(data.inflow * 100) / 100,
          outflow: Math.round(data.outflow * 100) / 100,
          net_change: Math.round((data.inflow - data.outflow) * 100) / 100,
        }))
        .sort((a, b) => a.period.localeCompare(b.period));

      // Calculate overall trend
      let totalNetChange = 0;
      for (const t of trends) {
        totalNetChange += t.net_change;
      }

      const avgMonthlyChange = trends.length > 0 ? totalNetChange / Math.max(months, 1) : 0;

      let overallTrend: 'growing' | 'declining' | 'stable' = 'stable';
      if (avgMonthlyChange > 100) {
        overallTrend = 'growing';
        growingCount++;
      } else if (avgMonthlyChange < -100) {
        overallTrend = 'declining';
        decliningCount++;
      } else {
        stableCount++;
      }

      trendData.push({
        account_id: account.account_id,
        account_name: account.name || account.official_name || 'Unknown',
        current_balance: account.current_balance,
        trend_data: trends,
        overall_trend: overallTrend,
        average_monthly_change: Math.round(avgMonthlyChange * 100) / 100,
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
  getAccountFees(
    options: {
      period?: string;
      start_date?: string;
      end_date?: string;
      account_id?: string;
    } = {}
  ): {
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
  } {
    const { period = 'ytd', account_id } = options;
    let { start_date, end_date } = options;

    if (!start_date || !end_date) {
      [start_date, end_date] = parsePeriod(period);
    }

    const accounts = this.db.getAccounts();
    const accountMap = new Map(accounts.map((a) => [a.account_id, a]));

    const transactions = this.db.getTransactions();

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
    const formattedFees = fees.map((t) => {
      const account = t.account_id ? accountMap.get(t.account_id) : undefined;
      return {
        transaction_id: t.transaction_id,
        date: t.date,
        amount: Math.round(t.amount * 100) / 100,
        name: t.name || t.original_name || 'Unknown',
        fee_type: classifyFeeType(t),
        account_id: t.account_id,
        account_name: account?.name || account?.official_name,
      };
    });

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
        amount: Math.round(data.amount * 100) / 100,
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
        amount: Math.round(data.amount * 100) / 100,
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
      total_fees: Math.round(totalFees * 100) / 100,
      fee_count: formattedFees.length,
      fees: formattedFees,
      by_type: byType,
      by_account: byAccount,
      summary: {
        average_fee: Math.round(avgFee * 100) / 100,
        largest_fee: Math.round(largestFee * 100) / 100,
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
  getYearOverYear(
    options: {
      current_year?: number;
      compare_year?: number;
      month?: number;
      exclude_transfers?: boolean;
    } = {}
  ): {
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
  } {
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

    const transactions = this.db.getTransactions();

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

      for (const t of txns) {
        if (t.amount > 0) {
          spending += t.amount;
        } else {
          income += Math.abs(t.amount);
        }
      }

      return {
        total_spending: Math.round(spending * 100) / 100,
        total_income: Math.round(income * 100) / 100,
        net_savings: Math.round((income - spending) * 100) / 100,
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
        ? Math.round((spendingChange / comparePeriod.total_spending) * 10000) / 100
        : null;
    const incomeChangePercent =
      comparePeriod.total_income > 0
        ? Math.round((incomeChange / comparePeriod.total_income) * 10000) / 100
        : null;

    // Category comparison
    const getCategorySpending = (txns: Transaction[]) => {
      const map = new Map<string, number>();
      for (const t of txns) {
        if (t.amount > 0) {
          const catId = t.category_id || 'uncategorized';
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
      const changePct = compareAmt > 0 ? Math.round((changeAmt / compareAmt) * 10000) / 100 : null;

      categoryComparison.push({
        category_id: catId,
        category_name: getCategoryName(catId),
        current_amount: Math.round(currentAmt * 100) / 100,
        compare_amount: Math.round(compareAmt * 100) / 100,
        change_amount: Math.round(changeAmt * 100) / 100,
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
        spending_change: Math.round(spendingChange * 100) / 100,
        spending_change_percent: spendingChangePercent,
        income_change: Math.round(incomeChange * 100) / 100,
        income_change_percent: incomeChangePercent,
        savings_change: Math.round(savingsChange * 100) / 100,
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
        'Get transactions with optional filters. Supports date ranges, ' +
        "category, merchant, account, amount, pending status, region/country filters. Use 'period' " +
        'for common date ranges (this_month, last_30_days, ytd, etc.). ' +
        'Returns human-readable category names and normalized merchant names. ' +
        'Supports pagination with offset parameter. Use exclude_transfers=true ' +
        'to filter out account transfers and credit card payments.',
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
          exclude_transfers: {
            type: 'boolean',
            description:
              'Exclude transfers between accounts and credit card payments (default: false)',
            default: false,
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
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'search_transactions',
      description:
        'Free-text search of transactions by merchant name. ' +
        'Case-insensitive search. Now supports date filtering with ' +
        'period, start_date, and end_date parameters.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results (default: 50)',
            default: 50,
          },
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
        },
        required: ['query'],
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
        "even when account_type is 'depository').",
      inputSchema: {
        type: 'object',
        properties: {
          account_type: {
            type: 'string',
            description:
              'Filter by account type (checking, savings, credit, investment, depository)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_spending_by_category',
      description:
        'Get spending aggregated by category for a date range. ' +
        'Returns total spending per category with human-readable names, sorted by amount. ' +
        "Use 'period' for common date ranges. Use exclude_transfers=true " +
        'to get more accurate spending totals.',
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
          min_amount: {
            type: 'number',
            description: 'Only include expenses >= this (default: 0.0)',
            default: 0.0,
          },
          exclude_transfers: {
            type: 'boolean',
            description:
              'Exclude transfers between accounts and credit card payments (default: false)',
            default: false,
          },
        },
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
        'Get all categories found in transactions with their human-readable names. ' +
        "Useful for understanding what category IDs like '13005000' or 'food_dining' mean. " +
        'Returns category IDs, names, transaction counts, and total amounts.',
      inputSchema: {
        type: 'object',
        properties: {},
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
      name: 'get_goal_progress',
      description:
        'Get current progress and status for financial goals. ' +
        'Shows current amount saved, progress percentage toward target, estimated completion date, ' +
        'and latest month with data. Calculates actual progress from historical snapshots. ' +
        'Useful for tracking goal performance and completion estimates.',
      inputSchema: {
        type: 'object',
        properties: {
          goal_id: {
            type: 'string',
            description: 'Optional goal ID to get progress for a specific goal',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_goal_history',
      description:
        'Get monthly historical snapshots of goal progress. ' +
        'Returns monthly data showing how the goal amount changed over time, ' +
        'including start/end amounts for each month, progress percentages, and daily snapshot counts. ' +
        'Useful for visualizing goal progress trends and analyzing contribution patterns.',
      inputSchema: {
        type: 'object',
        properties: {
          goal_id: {
            type: 'string',
            description: 'Goal ID to get history for (required)',
          },
          start_month: {
            type: 'string',
            description: 'Start month filter (YYYY-MM format, optional)',
          },
          end_month: {
            type: 'string',
            description: 'End month filter (YYYY-MM format, optional)',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of months to return (default: 12)',
            default: 12,
          },
        },
        required: ['goal_id'],
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'estimate_goal_completion',
      description:
        'Estimate when financial goals will be completed. ' +
        'Calculates estimated completion dates based on historical contribution rates and remaining amounts. ' +
        'Shows months remaining, estimated completion month, and whether the goal is on track. ' +
        'Useful for planning and adjusting savings strategies.',
      inputSchema: {
        type: 'object',
        properties: {
          goal_id: {
            type: 'string',
            description: 'Optional goal ID to estimate completion for a specific goal',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_goal_contributions',
      description:
        'Analyze goal contribution patterns and history. ' +
        'Shows total deposits, withdrawals, net contributions, and average monthly contribution rate. ' +
        'Provides monthly breakdown of changes with deposits and withdrawals separated. ' +
        'Useful for understanding contribution consistency and identifying patterns.',
      inputSchema: {
        type: 'object',
        properties: {
          goal_id: {
            type: 'string',
            description: 'Goal ID to analyze contributions for (required)',
          },
          start_month: {
            type: 'string',
            description: 'Start month filter (YYYY-MM format, optional)',
          },
          end_month: {
            type: 'string',
            description: 'End month filter (YYYY-MM format, optional)',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of months to analyze (default: 12)',
            default: 12,
          },
        },
        required: ['goal_id'],
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_income',
      description:
        'Get income transactions (deposits, paychecks, refunds). ' +
        'Filters for negative amounts (credits) or income-related categories. ' +
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
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_spending_by_merchant',
      description:
        'Get spending aggregated by merchant name. Returns top merchants ' +
        'by total spending with transaction counts and averages. ' +
        'Use exclude_transfers=true for more accurate results.',
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
          limit: {
            type: 'integer',
            description: 'Maximum number of merchants to return (default: 50)',
            default: 50,
          },
          exclude_transfers: {
            type: 'boolean',
            description: 'Exclude transfers between accounts (default: false)',
            default: false,
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
      name: 'get_foreign_transactions',
      description:
        'Get international transactions with foreign currencies or FX fees. ' +
        'Identifies transactions in foreign countries, with non-USD currency, ' +
        'or with foreign transaction fee categories. Returns breakdown by country ' +
        'and total FX fees paid.',
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
          limit: {
            type: 'integer',
            description: 'Maximum number of transactions to return (default: 100)',
            default: 100,
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_refunds',
      description:
        'Get refund/return transactions. Finds negative amounts (credits) that represent ' +
        'refunds, returns, or reversals. Returns breakdown by merchant and total refunded.',
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
          limit: {
            type: 'integer',
            description: 'Maximum number of transactions to return (default: 100)',
            default: 100,
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_duplicate_transactions',
      description:
        'Detect potential duplicate transactions. Identifies transactions with same ' +
        'merchant, amount, and date, or transactions sharing the same transaction_id. ' +
        'Useful for finding data quality issues or actual duplicates.',
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
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_credits',
      description:
        'Get statement credits (Amex credits, cashback, rewards). Finds negative amounts ' +
        'that represent credits like hotel credits, entertainment credits, uber credits, etc. ' +
        'Returns breakdown by credit type.',
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
          limit: {
            type: 'integer',
            description: 'Maximum number of transactions to return (default: 100)',
            default: 100,
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_spending_by_day_of_week',
      description:
        'Get spending aggregated by day of week. Shows spending patterns across ' +
        'Sunday through Saturday, including total, average transaction, and percentage ' +
        'of total spending for each day.',
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
          exclude_transfers: {
            type: 'boolean',
            description: 'Exclude transfers between accounts (default: false)',
            default: false,
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
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
      name: 'get_transaction_by_id',
      description:
        'Get a single transaction by its ID. Returns detailed transaction information ' +
        'including category name and normalized merchant name.',
      inputSchema: {
        type: 'object',
        properties: {
          transaction_id: {
            type: 'string',
            description: 'The transaction ID to look up',
          },
        },
        required: ['transaction_id'],
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_top_merchants',
      description:
        'Get top merchants by spending. Returns ranked list of merchants with total spent, ' +
        'transaction count, average transaction, and date range of transactions.',
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
          limit: {
            type: 'integer',
            description: 'Number of top merchants to return (default: 20)',
            default: 20,
          },
          exclude_transfers: {
            type: 'boolean',
            description: 'Exclude transfers between accounts (default: false)',
            default: false,
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_unusual_transactions',
      description:
        'Detect unusual/anomalous transactions. Flags transactions significantly above ' +
        'average for that merchant or category. Also flags large transactions >$1000.',
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
      name: 'get_hsa_fsa_eligible',
      description:
        'Find HSA/FSA eligible transactions. Identifies transactions at pharmacies, ' +
        'medical providers, dental, vision, and other healthcare expenses.',
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
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_spending_rate',
      description:
        'Get spending velocity analysis. Shows daily/weekly burn rate, projects month-end total, ' +
        'compares to previous period, and indicates if spending is on track.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description: 'Period shorthand (default: this_month)',
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
            description: 'Exclude transfers between accounts (default: false)',
            default: false,
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
        'categorizations. Use this to find data quality issues before doing analysis.',
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
      name: 'get_investment_price_history',
      description:
        'Get historical price data for a specific investment ticker over a date range. ' +
        'Returns time-series price data showing how the investment price changed over time. ' +
        'Includes price summary with latest/earliest prices, high/low ranges, and percent change. ' +
        'Supports both daily (monthly aggregated) and high-frequency (intraday) price data. ' +
        'Useful for analyzing price trends, volatility, and historical performance.',
      inputSchema: {
        type: 'object',
        properties: {
          ticker_symbol: {
            type: 'string',
            description: 'Ticker symbol to get history for (e.g., "AAPL", "BTC-USD") - required',
          },
          start_date: {
            type: 'string',
            description: 'Start date filter (YYYY-MM or YYYY-MM-DD format, optional)',
          },
          end_date: {
            type: 'string',
            description: 'End date filter (YYYY-MM or YYYY-MM-DD format, optional)',
          },
          price_type: {
            type: 'string',
            description:
              'Filter by price type: "daily" (monthly data) or "hf" (high-frequency intraday)',
            enum: ['daily', 'hf'],
          },
        },
        required: ['ticker_symbol'],
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
    {
      name: 'get_category_hierarchy',
      description:
        'Get the full Plaid category taxonomy as a hierarchical tree. ' +
        'Shows all spending categories organized by type (income, expense, transfer) ' +
        'with parent categories and their subcategories. Useful for understanding ' +
        'how transactions are categorized and for building category selection interfaces.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Filter by category type: "income", "expense", or "transfer"',
            enum: ['income', 'expense', 'transfer'],
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_subcategories',
      description:
        'Get subcategories (children) of a specific parent category. ' +
        'Use this to drill down into specific spending areas. For example, ' +
        '"food_and_drink" has subcategories like groceries, restaurants, coffee, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          category_id: {
            type: 'string',
            description:
              'Parent category ID (e.g., "food_and_drink", "transportation", "entertainment")',
          },
        },
        required: ['category_id'],
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'search_categories',
      description:
        'Search for categories by name or keyword. Performs a case-insensitive search ' +
        'across category names, IDs, and paths. Returns matching categories with their ' +
        'full hierarchy information. Useful for finding specific categories.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query (e.g., "food", "gas", "utilities", "entertainment")',
          },
        },
        required: ['query'],
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
      name: 'get_spending_over_time',
      description:
        'Get spending aggregated over time periods (daily, weekly, or monthly). ' +
        'Shows spending trends within a date range with totals, transaction counts, ' +
        'and averages per period. Includes summary with highest/lowest periods. ' +
        'Great for understanding spending patterns over time.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description:
              'Named period: this_month, last_month, last_30_days, last_3_months, last_6_months, ytd, last_year',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD). Use with end_date for custom range.',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD). Use with start_date for custom range.',
          },
          granularity: {
            type: 'string',
            enum: ['day', 'week', 'month'],
            description: 'Time granularity for grouping (default: month)',
          },
          category: {
            type: 'string',
            description: 'Filter by category (partial match)',
          },
          exclude_transfers: {
            type: 'boolean',
            description: 'Exclude transfers (default: true)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
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
    {
      name: 'get_merchant_frequency',
      description:
        'Analyze how often you visit merchants and your spending patterns. ' +
        'Shows visit counts, total spent, average per visit, days between visits, ' +
        'and visits per month. Great for identifying shopping habits.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description:
              'Named period: this_month, last_month, last_30_days, last_3_months, last_6_months, ytd',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD)',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD)',
          },
          min_visits: {
            type: 'integer',
            description: 'Minimum visits to include (default: 2)',
          },
          limit: {
            type: 'integer',
            description: 'Maximum merchants to return (default: 20)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },

    // ---- Budget Analytics ----
    {
      name: 'get_budget_utilization',
      description:
        'Get budget utilization status for all active budgets. Shows how much of each ' +
        'budget has been used, remaining amount, and utilization percentage. ' +
        'Identifies budgets that are under, on track, or over budget.',
      inputSchema: {
        type: 'object',
        properties: {
          month: {
            type: 'string',
            description: 'Month to analyze (YYYY-MM format, default: current month)',
          },
          category: {
            type: 'string',
            description: 'Filter by category (partial match)',
          },
          include_inactive: {
            type: 'boolean',
            description: 'Include inactive budgets (default: false)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_budget_vs_actual',
      description:
        'Compare budgeted amounts to actual spending over multiple months. ' +
        'Shows variance, category breakdown, and consistency scores. ' +
        'Helps understand budget accuracy and spending patterns.',
      inputSchema: {
        type: 'object',
        properties: {
          months: {
            type: 'integer',
            description: 'Number of months to analyze (default: 6)',
          },
          category: {
            type: 'string',
            description: 'Filter by category (partial match)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_budget_recommendations',
      description:
        'Get smart budget recommendations based on spending patterns. ' +
        'Suggests adjustments for existing budgets and recommends new budgets ' +
        'for categories with consistent spending but no budget.',
      inputSchema: {
        type: 'object',
        properties: {
          months: {
            type: 'integer',
            description: 'Number of months to analyze for recommendations (default: 3)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_budget_alerts',
      description:
        'Get alerts for budgets that are approaching, at warning level, or exceeded. ' +
        'Shows utilization, days remaining, and projected totals. ' +
        'Helps proactively manage spending.',
      inputSchema: {
        type: 'object',
        properties: {
          threshold_percentage: {
            type: 'integer',
            description: 'Alert threshold percentage (default: 80)',
          },
          month: {
            type: 'string',
            description: 'Month to check (YYYY-MM format, default: current month)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },

    // ---- Investment Analytics ----
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
    {
      name: 'get_investment_performance',
      description:
        'Get investment performance metrics over a time period. ' +
        'Shows returns, price changes, highs/lows, and trend direction for each security. ' +
        'Identifies best and worst performers. Useful for analyzing investment returns.',
      inputSchema: {
        type: 'object',
        properties: {
          ticker_symbol: {
            type: 'string',
            description: 'Filter by specific ticker symbol (e.g., "AAPL")',
          },
          period: {
            type: 'string',
            description:
              'Named period: this_month, last_month, last_30_days, last_90_days, ytd (default: last_30_days)',
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
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_dividend_income',
      description:
        'Get dividend income from investments. ' +
        'Tracks dividend payments received, grouped by month and source. ' +
        'Shows total dividends, average payment, and largest dividend. ' +
        'Useful for income investors tracking dividend streams.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description:
              'Named period: this_month, last_month, last_30_days, ytd, this_year (default: ytd)',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD)',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD)',
          },
          account_id: {
            type: 'string',
            description: 'Filter by specific account ID',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_investment_fees',
      description:
        'Get investment-related fees (management fees, trading commissions, etc.). ' +
        'Tracks fees from investment accounts, grouped by type and month. ' +
        'Shows total fees, average fee, and monthly fee average. ' +
        'Useful for understanding the cost of investing.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description:
              'Named period: this_month, last_month, last_30_days, ytd, this_year (default: ytd)',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD)',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD)',
          },
          account_id: {
            type: 'string',
            description: 'Filter by specific account ID',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },

    // ---- Goal Analytics ----
    {
      name: 'get_goal_projection',
      description:
        'Get goal projections with multiple scenarios (conservative, moderate, aggressive). ' +
        'Shows estimated completion dates based on different contribution rates. ' +
        'Useful for planning and understanding goal achievement timelines.',
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
    {
      name: 'get_goals_at_risk',
      description:
        'Identify goals at risk of not being achieved. ' +
        'Analyzes contribution patterns and flags goals with critical/high/medium risk. ' +
        'Shows risk factors and required contributions to get back on track.',
      inputSchema: {
        type: 'object',
        properties: {
          months_lookback: {
            type: 'integer',
            description: 'Number of months to analyze (default: 6)',
          },
          risk_threshold: {
            type: 'integer',
            description: 'Minimum risk score to include (default: 50)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_goal_recommendations',
      description:
        'Get personalized recommendations to improve goal progress. ' +
        'Suggests increasing contributions, adjusting targets, or celebrating milestones. ' +
        'Prioritizes recommendations by urgency and impact.',
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
      name: 'get_account_activity',
      description:
        'Get account activity summary showing transaction counts, volumes, and activity levels. ' +
        'Identifies most active accounts and shows inflow/outflow statistics per account.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description:
              'Named period: this_month, last_month, last_30_days, last_90_days, ytd (default: last_30_days)',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD)',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD)',
          },
          account_type: {
            type: 'string',
            description: 'Filter by account type (checking, savings, credit, etc.)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_balance_trends',
      description:
        'Analyze balance trends over time by tracking inflows and outflows. ' +
        'Shows growing, declining, or stable accounts and average monthly changes.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: {
            type: 'string',
            description: 'Filter by specific account ID',
          },
          months: {
            type: 'integer',
            description: 'Number of months to analyze (default: 6)',
          },
          granularity: {
            type: 'string',
            description: 'Time granularity: daily, weekly, or monthly (default: monthly)',
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_account_fees',
      description:
        'Track account-related fees (ATM, overdraft, foreign transaction, etc.). ' +
        'Shows fees grouped by type and account with totals and averages.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description:
              'Named period: this_month, last_month, last_30_days, ytd, this_year (default: ytd)',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD)',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD)',
          },
          account_id: {
            type: 'string',
            description: 'Filter by specific account ID',
          },
        },
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
  ];
}
