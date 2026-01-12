/**
 * MCP tool definitions for Copilot Money data.
 *
 * Exposes database functionality through the Model Context Protocol.
 */

import { CopilotDatabase } from '../core/database.js';
import { parsePeriod } from '../utils/date.js';
import { getCategoryName, isTransferCategory, isIncomeCategory } from '../utils/categories.js';
import type { Transaction, Account } from '../models/index.js';
import { getTransactionDisplayName } from '../models/index.js';

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
      limit = 100,
      offset = 0,
      exclude_transfers = false,
      pending,
      region,
      country,
    } = options;
    let { start_date, end_date } = options;

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
    const hasMore = offset + limit < totalCount;

    // Apply pagination
    transactions = transactions.slice(offset, offset + limit);

    // Add human-readable category names and normalized merchant
    const enrichedTransactions = transactions.map((txn) => ({
      ...txn,
      category_name: txn.category_id ? getCategoryName(txn.category_id) : undefined,
      normalized_merchant: normalizeMerchantName(getTransactionDisplayName(txn)),
    }));

    return {
      count: enrichedTransactions.length,
      total_count: totalCount,
      offset,
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

    // Filter out transfers if requested
    if (exclude_transfers) {
      transactions = transactions.filter((txn) => !isTransferCategory(txn.category_id));
    }

    // Aggregate by category
    const categorySpending: Map<string, number> = new Map();
    const categoryCounts: Map<string, number> = new Map();

    for (const txn of transactions) {
      // Only count positive amounts (expenses)
      if (txn.amount > 0) {
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
        nextExpectedDate = lastDate.toISOString().split('T')[0];
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

    return {
      period: { start_date, end_date },
      count: recurring.length,
      total_monthly_cost: Math.round(totalMonthlyCost * 100) / 100,
      recurring,
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
    const incomeTransactions = allTransactions.filter(
      (txn) => txn.amount < 0 || isIncomeCategory(txn.category_id)
    );

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

    // Filter out transfers if requested
    if (exclude_transfers) {
      transactions = transactions.filter((txn) => !isTransferCategory(txn.category_id));
    }

    // Aggregate by merchant
    const merchantSpending = new Map<
      string,
      { total: number; count: number; categoryId?: string }
    >();

    for (const txn of transactions) {
      // Only count positive amounts (expenses)
      if (txn.amount <= 0) continue;

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
    const foreignTxns = allTransactions.filter((txn) => {
      const isForeignCountry =
        txn.country && txn.country.toUpperCase() !== 'US' && txn.country.toUpperCase() !== 'USA';
      const isForeignFeeCategory =
        txn.category_id === 'bank_fees_foreign_transaction_fees' || txn.category_id === '10005000';
      const isForeignCurrency =
        txn.iso_currency_code && txn.iso_currency_code.toUpperCase() !== 'USD';
      return isForeignCountry || isForeignFeeCategory || isForeignCurrency;
    });

    // Calculate FX fees separately
    const fxFees = allTransactions.filter(
      (txn) =>
        txn.category_id === 'bank_fees_foreign_transaction_fees' || txn.category_id === '10005000'
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

      // Include if it's a credit from a merchant (likely a refund)
      return isRefundName || isRefundCategory || txn.amount < 0;
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

    if (exclude_transfers) {
      transactions = transactions.filter((txn) => !isTransferCategory(txn.category_id));
    }

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayStats = new Map<number, { total: number; count: number }>();

    for (let i = 0; i < 7; i++) {
      dayStats.set(i, { total: 0, count: 0 });
    }

    for (const txn of transactions) {
      if (txn.amount <= 0) continue; // Only count expenses
      const dayOfWeek = new Date(txn.date + 'T12:00:00').getDay();
      const stats = dayStats.get(dayOfWeek)!;
      stats.total += txn.amount;
      stats.count++;
    }

    const totalSpending = Array.from(dayStats.values()).reduce((sum, s) => sum + s.total, 0);

    const days = Array.from(dayStats.entries())
      .map(([dayNum, stats]) => ({
        day: dayNames[dayNum]!,
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

    // Group transactions by country
    const byCountry = new Map<string, Transaction[]>();
    for (const txn of travelTxns) {
      const country = txn.country || 'Unknown';
      const existing = byCountry.get(country) || [];
      existing.push(txn);
      byCountry.set(country, existing);
    }

    // For each country, find contiguous date ranges
    for (const [country, txns] of byCountry) {
      if (country === 'US' || country === 'USA') continue;

      // Sort by date
      const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));

      // Find contiguous ranges (transactions within 3 days of each other)
      let tripStart = sorted[0];
      let tripEnd = sorted[0];
      let tripTxns: Transaction[] = [sorted[0]!].filter(Boolean);

      for (let i = 1; i < sorted.length; i++) {
        const current = sorted[i]!;
        const prevDate = new Date(tripEnd!.date);
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

              trips.push({
                location: tripStart.city || country,
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

          trips.push({
            location: tripStart.city || country,
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

    if (exclude_transfers) {
      transactions = transactions.filter((txn) => !isTransferCategory(txn.category_id));
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
      if (txn.amount <= 0) continue;
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
          const strValue = String(value);
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
            txn.category_id!.toLowerCase().includes(cat.toLowerCase()) || txn.category_id === cat
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

    if (exclude_transfers) {
      transactions = transactions.filter((txn) => !isTransferCategory(txn.category_id));
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

    const totalSpending = transactions
      .filter((txn) => txn.amount > 0)
      .reduce((sum, txn) => sum + txn.amount, 0);

    const dailyAverage = daysElapsed > 0 ? totalSpending / daysElapsed : 0;
    const weeklyAverage = dailyAverage * 7;
    const projectedMonthlyTotal = dailyAverage * 30;

    // Weekly breakdown
    const weeklyTotals = new Map<
      string,
      { start: string; end: string; total: number; days: number }
    >();
    for (const txn of transactions) {
      if (txn.amount <= 0) continue;
      const txnDate = new Date(txn.date + 'T12:00:00');
      const weekStart = new Date(txnDate);
      weekStart.setDate(txnDate.getDate() - txnDate.getDay());
      const weekKey = weekStart.toISOString().split('T')[0]!;
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);

      const existing = weeklyTotals.get(weekKey) || {
        start: weekKey,
        end: weekEnd.toISOString().split('T')[0]!,
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
      startDate: prevStart.toISOString().split('T')[0],
      endDate: prevEnd.toISOString().split('T')[0],
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

      if (exclude_transfers) {
        transactions = transactions.filter((txn) => !isTransferCategory(txn.category_id));
      }

      let spending = 0;
      let income = 0;
      const byCategory = new Map<string, number>();

      for (const txn of transactions) {
        if (txn.amount > 0) {
          spending += txn.amount;
          const cat = txn.category_id || 'Uncategorized';
          byCategory.set(cat, (byCategory.get(cat) || 0) + txn.amount);
        } else {
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
}

/**
 * MCP tool schema definition.
 */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
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
        'Identify recurring/subscription charges. Finds transactions that occur ' +
        'regularly from the same merchant with similar amounts. Returns estimated ' +
        'frequency (weekly, monthly, etc.), total monthly cost, confidence score ' +
        '(high/medium/low), and next expected charge date.',
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
  ];
}
