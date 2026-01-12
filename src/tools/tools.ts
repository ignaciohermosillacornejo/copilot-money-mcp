/**
 * MCP tool definitions for Copilot Money data.
 *
 * Exposes database functionality through the Model Context Protocol.
 */

import { CopilotDatabase } from "../core/database.js";
import { parsePeriod } from "../utils/date.js";
import {
  getCategoryName,
  isTransferCategory,
  isIncomeCategory,
} from "../utils/categories.js";
import type { Transaction, Account, Category } from "../models/index.js";
import { getTransactionDisplayName } from "../models/index.js";

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
    exclude_transfers?: boolean;
  }): {
    count: number;
    transactions: Array<Transaction & { category_name?: string }>;
  } {
    let {
      period,
      start_date,
      end_date,
      category,
      merchant,
      account_id,
      min_amount,
      max_amount,
      limit = 100,
      exclude_transfers = false,
    } = options;

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Query transactions
    let transactions = this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      category,
      merchant,
      accountId: account_id,
      minAmount: min_amount,
      maxAmount: max_amount,
      limit: exclude_transfers ? limit * 2 : limit, // Get more if filtering transfers
    });

    // Filter out transfers if requested
    if (exclude_transfers) {
      transactions = transactions.filter(
        (txn) => !isTransferCategory(txn.category_id)
      );
      transactions = transactions.slice(0, limit);
    }

    // Add human-readable category names
    const enrichedTransactions = transactions.map((txn) => ({
      ...txn,
      category_name: txn.category_id
        ? getCategoryName(txn.category_id)
        : undefined,
    }));

    return {
      count: enrichedTransactions.length,
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
    let { limit = 50, period, start_date, end_date } = options;

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    let transactions = this.db.searchTransactions(
      query,
      start_date || end_date ? 10000 : limit
    );

    // Apply date filters if specified
    if (start_date) {
      transactions = transactions.filter((txn) => txn.date >= start_date!);
    }
    if (end_date) {
      transactions = transactions.filter((txn) => txn.date <= end_date!);
    }

    // Apply limit
    transactions = transactions.slice(0, limit);

    // Add human-readable category names
    const enrichedTransactions = transactions.map((txn) => ({
      ...txn,
      category_name: txn.category_id
        ? getCategoryName(txn.category_id)
        : undefined,
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
    const totalBalance = accounts.reduce(
      (sum, acc) => sum + acc.current_balance,
      0
    );

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
    let {
      period,
      start_date,
      end_date,
      min_amount = 0.0,
      exclude_transfers = false,
    } = options;

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
      transactions = transactions.filter(
        (txn) => !isTransferCategory(txn.category_id)
      );
    }

    // Aggregate by category
    const categorySpending: Map<string, number> = new Map();
    const categoryCounts: Map<string, number> = new Map();

    for (const txn of transactions) {
      // Only count positive amounts (expenses)
      if (txn.amount > 0) {
        const cat = txn.category_id || "Uncategorized";
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
      Math.round(
        categories.reduce((sum, cat) => sum + cat.total_spending, 0) * 100
      ) / 100;

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
      name: account.name || account.official_name || "Unknown",
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
    const categoryStats = new Map<
      string,
      { count: number; totalAmount: number }
    >();

    for (const txn of allTransactions) {
      const categoryId = txn.category_id || "Uncategorized";
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
      occurrences: number;
      average_amount: number;
      total_amount: number;
      frequency: string;
      category_name?: string;
      last_date: string;
      transactions: Array<{ date: string; amount: number }>;
    }>;
  } {
    let { min_occurrences = 2, period, start_date, end_date } = options;

    // Default to last 90 days if no period specified
    if (!period && !start_date && !end_date) {
      period = "last_90_days";
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
      if (merchantName === "Unknown") continue;

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
      occurrences: number;
      average_amount: number;
      total_amount: number;
      frequency: string;
      category_name?: string;
      last_date: string;
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
      const avgAmount =
        amounts.reduce((a, b) => a + b, 0) / sortedTxns.length;
      const totalAmount = amounts.reduce((a, b) => a + b, 0);

      // Check if amounts are consistent (within 30% of average)
      const consistentAmounts = amounts.filter(
        (a) => Math.abs(a - avgAmount) / avgAmount < 0.3
      );
      if (consistentAmounts.length < min_occurrences) continue;

      // Estimate frequency based on average days between transactions
      const dates = sortedTxns.map((t) => new Date(t.date).getTime());
      const gaps: number[] = [];
      for (let i = 1; i < dates.length; i++) {
        gaps.push((dates[i] - dates[i - 1]) / (1000 * 60 * 60 * 24));
      }
      const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;

      let frequency = "irregular";
      if (avgGap >= 1 && avgGap <= 7) frequency = "weekly";
      else if (avgGap >= 13 && avgGap <= 16) frequency = "bi-weekly";
      else if (avgGap >= 27 && avgGap <= 35) frequency = "monthly";
      else if (avgGap >= 85 && avgGap <= 100) frequency = "quarterly";
      else if (avgGap >= 360 && avgGap <= 370) frequency = "yearly";

      recurring.push({
        merchant,
        occurrences: sortedTxns.length,
        average_amount: Math.round(avgAmount * 100) / 100,
        total_amount: Math.round(totalAmount * 100) / 100,
        frequency,
        category_name: data.categoryId
          ? getCategoryName(data.categoryId)
          : undefined,
        last_date: sortedTxns[sortedTxns.length - 1].date,
        transactions: sortedTxns.slice(-5).map((t) => ({
          date: t.date,
          amount: t.amount,
        })),
      });
    }

    // Sort by occurrences (most frequent first)
    recurring.sort((a, b) => b.occurrences - a.occurrences);

    // Calculate estimated monthly cost
    const monthlyRecurring = recurring.filter(
      (r) => r.frequency === "monthly" || r.frequency === "bi-weekly" || r.frequency === "weekly"
    );
    let totalMonthlyCost = 0;
    for (const r of monthlyRecurring) {
      if (r.frequency === "monthly") totalMonthlyCost += r.average_amount;
      else if (r.frequency === "bi-weekly") totalMonthlyCost += r.average_amount * 2;
      else if (r.frequency === "weekly") totalMonthlyCost += r.average_amount * 4;
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
  getIncome(options: {
    period?: string;
    start_date?: string;
    end_date?: string;
  }): {
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
    let { period, start_date, end_date } = options;

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
    const sourceMap = new Map<
      string,
      { total: number; count: number; categoryId?: string }
    >();

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
        category_name: data.categoryId
          ? getCategoryName(data.categoryId)
          : undefined,
        total: Math.round(data.total * 100) / 100,
        count: data.count,
      }))
      .sort((a, b) => b.total - a.total);

    // Calculate total
    const totalIncome = incomeBySource.reduce((sum, s) => sum + s.total, 0);

    // Enrich transactions with category names
    const enrichedTransactions = incomeTransactions
      .slice(0, 100)
      .map((txn) => ({
        ...txn,
        category_name: txn.category_id
          ? getCategoryName(txn.category_id)
          : undefined,
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
    let {
      period,
      start_date,
      end_date,
      limit = 50,
      exclude_transfers = false,
    } = options;

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
      transactions = transactions.filter(
        (txn) => !isTransferCategory(txn.category_id)
      );
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
        category_name: data.categoryId
          ? getCategoryName(data.categoryId)
          : undefined,
        total_spending: Math.round(data.total * 100) / 100,
        transaction_count: data.count,
        average_transaction: Math.round((data.total / data.count) * 100) / 100,
      }))
      .sort((a, b) => b.total_spending - a.total_spending)
      .slice(0, limit);

    // Calculate totals
    const totalSpending = merchants.reduce(
      (sum, m) => sum + m.total_spending,
      0
    );

    return {
      period: { start_date, end_date },
      total_spending: Math.round(totalSpending * 100) / 100,
      merchant_count: merchantSpending.size,
      merchants,
    };
  }

  /**
   * Compare spending between two time periods.
   *
   * @param options - Filter options
   * @returns Object with comparison between two periods
   */
  comparePeriods(options: {
    period1: string;
    period2: string;
    exclude_transfers?: boolean;
  }): {
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
        transactions = transactions.filter(
          (txn) => !isTransferCategory(txn.category_id)
        );
      }

      let spending = 0;
      let income = 0;
      const byCategory = new Map<string, number>();

      for (const txn of transactions) {
        if (txn.amount > 0) {
          spending += txn.amount;
          const cat = txn.category_id || "Uncategorized";
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
      p1Data.spending > 0
        ? Math.round((spendingChange / p1Data.spending) * 10000) / 100
        : 0;

    const incomeChange = p2Data.income - p1Data.income;
    const incomeChangePercent =
      p1Data.income > 0
        ? Math.round((incomeChange / p1Data.income) * 10000) / 100
        : 0;

    // Compare categories
    const allCategories = new Set([
      ...p1Data.byCategory.keys(),
      ...p2Data.byCategory.keys(),
    ]);

    const categoryComparison = Array.from(allCategories)
      .map((categoryId) => {
        const p1Spending = p1Data.byCategory.get(categoryId) || 0;
        const p2Spending = p2Data.byCategory.get(categoryId) || 0;
        const change = p2Spending - p1Spending;
        const changePercent =
          p1Spending > 0 ? Math.round((change / p1Spending) * 10000) / 100 : 0;

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
        net_change: Math.round((p2Data.income - p2Data.spending - (p1Data.income - p1Data.spending)) * 100) / 100,
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
    type: "object";
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
      name: "get_transactions",
      description:
        "Get transactions with optional filters. Supports date ranges, " +
        "category, merchant, account, and amount filters. Use 'period' " +
        "for common date ranges (this_month, last_30_days, ytd, etc.). " +
        "Returns human-readable category names. Use exclude_transfers=true " +
        "to filter out account transfers and credit card payments.",
      inputSchema: {
        type: "object",
        properties: {
          period: {
            type: "string",
            description:
              "Period shorthand: this_month, last_month, " +
              "last_7_days, last_30_days, last_90_days, ytd, " +
              "this_year, last_year",
          },
          start_date: {
            type: "string",
            description: "Start date (YYYY-MM-DD)",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
          end_date: {
            type: "string",
            description: "End date (YYYY-MM-DD)",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
          category: {
            type: "string",
            description: "Filter by category (case-insensitive substring)",
          },
          merchant: {
            type: "string",
            description:
              "Filter by merchant name (case-insensitive substring)",
          },
          account_id: {
            type: "string",
            description: "Filter by account ID",
          },
          min_amount: {
            type: "number",
            description: "Minimum transaction amount",
          },
          max_amount: {
            type: "number",
            description: "Maximum transaction amount",
          },
          limit: {
            type: "integer",
            description: "Maximum number of results (default: 100)",
            default: 100,
          },
          exclude_transfers: {
            type: "boolean",
            description:
              "Exclude transfers between accounts and credit card payments (default: false)",
            default: false,
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: "search_transactions",
      description:
        "Free-text search of transactions by merchant name. " +
        "Case-insensitive search. Now supports date filtering with " +
        "period, start_date, and end_date parameters.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
          limit: {
            type: "integer",
            description: "Maximum number of results (default: 50)",
            default: 50,
          },
          period: {
            type: "string",
            description:
              "Period shorthand: this_month, last_month, " +
              "last_7_days, last_30_days, last_90_days, ytd, " +
              "this_year, last_year",
          },
          start_date: {
            type: "string",
            description: "Start date (YYYY-MM-DD)",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
          end_date: {
            type: "string",
            description: "End date (YYYY-MM-DD)",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
        },
        required: ["query"],
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: "get_accounts",
      description:
        "Get all accounts with balances. Optionally filter by account type " +
        "(checking, savings, credit, investment). Now checks both account_type " +
        "and subtype fields for better filtering (e.g., finds checking accounts " +
        "even when account_type is 'depository').",
      inputSchema: {
        type: "object",
        properties: {
          account_type: {
            type: "string",
            description:
              "Filter by account type (checking, savings, credit, investment, depository)",
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: "get_spending_by_category",
      description:
        "Get spending aggregated by category for a date range. " +
        "Returns total spending per category with human-readable names, sorted by amount. " +
        "Use 'period' for common date ranges. Use exclude_transfers=true " +
        "to get more accurate spending totals.",
      inputSchema: {
        type: "object",
        properties: {
          period: {
            type: "string",
            description:
              "Period shorthand: this_month, last_month, " +
              "last_7_days, last_30_days, last_90_days, ytd, " +
              "this_year, last_year",
          },
          start_date: {
            type: "string",
            description: "Start date (YYYY-MM-DD)",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
          end_date: {
            type: "string",
            description: "End date (YYYY-MM-DD)",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
          min_amount: {
            type: "number",
            description: "Only include expenses >= this (default: 0.0)",
            default: 0.0,
          },
          exclude_transfers: {
            type: "boolean",
            description:
              "Exclude transfers between accounts and credit card payments (default: false)",
            default: false,
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: "get_account_balance",
      description:
        "Get balance and details for a specific account by ID. " +
        "Includes account_type and subtype fields.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: {
            type: "string",
            description: "Account ID to query",
          },
        },
        required: ["account_id"],
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: "get_categories",
      description:
        "Get all categories found in transactions with their human-readable names. " +
        "Useful for understanding what category IDs like '13005000' or 'food_dining' mean. " +
        "Returns category IDs, names, transaction counts, and total amounts.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: "get_recurring_transactions",
      description:
        "Identify recurring/subscription charges. Finds transactions that occur " +
        "regularly from the same merchant with similar amounts. Returns estimated " +
        "frequency (weekly, monthly, etc.) and total monthly cost.",
      inputSchema: {
        type: "object",
        properties: {
          min_occurrences: {
            type: "integer",
            description:
              "Minimum number of occurrences to qualify as recurring (default: 2)",
            default: 2,
          },
          period: {
            type: "string",
            description:
              "Period to analyze (default: last_90_days). " +
              "Options: this_month, last_month, last_7_days, last_30_days, " +
              "last_90_days, ytd, this_year, last_year",
          },
          start_date: {
            type: "string",
            description: "Start date (YYYY-MM-DD)",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
          end_date: {
            type: "string",
            description: "End date (YYYY-MM-DD)",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: "get_income",
      description:
        "Get income transactions (deposits, paychecks, refunds). " +
        "Filters for negative amounts (credits) or income-related categories. " +
        "Returns total income and breakdown by source.",
      inputSchema: {
        type: "object",
        properties: {
          period: {
            type: "string",
            description:
              "Period shorthand: this_month, last_month, " +
              "last_7_days, last_30_days, last_90_days, ytd, " +
              "this_year, last_year",
          },
          start_date: {
            type: "string",
            description: "Start date (YYYY-MM-DD)",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
          end_date: {
            type: "string",
            description: "End date (YYYY-MM-DD)",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: "get_spending_by_merchant",
      description:
        "Get spending aggregated by merchant name. Returns top merchants " +
        "by total spending with transaction counts and averages. " +
        "Use exclude_transfers=true for more accurate results.",
      inputSchema: {
        type: "object",
        properties: {
          period: {
            type: "string",
            description:
              "Period shorthand: this_month, last_month, " +
              "last_7_days, last_30_days, last_90_days, ytd, " +
              "this_year, last_year",
          },
          start_date: {
            type: "string",
            description: "Start date (YYYY-MM-DD)",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
          end_date: {
            type: "string",
            description: "End date (YYYY-MM-DD)",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
          limit: {
            type: "integer",
            description: "Maximum number of merchants to return (default: 50)",
            default: 50,
          },
          exclude_transfers: {
            type: "boolean",
            description:
              "Exclude transfers between accounts (default: false)",
            default: false,
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: "compare_periods",
      description:
        "Compare spending and income between two time periods. " +
        "Returns totals for each period, percentage changes, and " +
        "category-by-category comparison showing where spending changed most.",
      inputSchema: {
        type: "object",
        properties: {
          period1: {
            type: "string",
            description:
              "First period (baseline): this_month, last_month, " +
              "last_7_days, last_30_days, last_90_days, ytd, " +
              "this_year, last_year",
          },
          period2: {
            type: "string",
            description:
              "Second period (to compare): this_month, last_month, " +
              "last_7_days, last_30_days, last_90_days, ytd, " +
              "this_year, last_year",
          },
          exclude_transfers: {
            type: "boolean",
            description:
              "Exclude transfers between accounts (default: false)",
            default: false,
          },
        },
        required: ["period1", "period2"],
      },
      annotations: {
        readOnlyHint: true,
      },
    },
  ];
}
