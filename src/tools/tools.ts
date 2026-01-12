/**
 * MCP tool definitions for Copilot Money data.
 *
 * Exposes database functionality through the Model Context Protocol.
 */

import { CopilotDatabase } from "../core/database.js";
import { parsePeriod } from "../utils/date.js";
import type { Transaction, Account } from "../models/index.js";

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
  }): {
    count: number;
    transactions: Transaction[];
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
    } = options;

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Query transactions
    const transactions = this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      category,
      merchant,
      accountId: account_id,
      minAmount: min_amount,
      maxAmount: max_amount,
      limit,
    });

    return {
      count: transactions.length,
      transactions,
    };
  }

  /**
   * Free-text search of transactions.
   *
   * Searches merchant names (display_name field).
   *
   * @param query - Search query (case-insensitive)
   * @param limit - Maximum results (default: 50)
   * @returns Object with transaction count and list of matching transactions
   */
  searchTransactions(
    query: string,
    limit = 50
  ): {
    count: number;
    transactions: Transaction[];
  } {
    const transactions = this.db.searchTransactions(query, limit);

    return {
      count: transactions.length,
      transactions,
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
      total_balance: totalBalance,
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
  }): {
    period: { start_date?: string; end_date?: string };
    total_spending: number;
    category_count: number;
    categories: Array<{
      category: string;
      total_spending: number;
      transaction_count: number;
    }>;
  } {
    let { period, start_date, end_date, min_amount = 0.0 } = options;

    // If period is specified, parse it to start/end dates
    if (period) {
      [start_date, end_date] = parsePeriod(period);
    }

    // Get transactions with filters
    const transactions = this.db.getTransactions({
      startDate: start_date,
      endDate: end_date,
      minAmount: min_amount,
      limit: 10000, // High limit for aggregation
    });

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
      .map(([category, total_spending]) => ({
        category,
        total_spending: Math.round(total_spending * 100) / 100, // Round to 2 decimals
        transaction_count: categoryCounts.get(category) || 0,
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
      current_balance: account.current_balance,
      available_balance: account.available_balance,
      mask: account.mask,
      institution_name: account.institution_name,
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
        "for common date ranges (this_month, last_30_days, ytd, etc.).",
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
        },
      },
      annotations: {
        readOnlyHint: true, // CRITICAL: Read-only tool
      },
    },
    {
      name: "search_transactions",
      description:
        "Free-text search of transactions by merchant name. " +
        "Case-insensitive search.",
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
        },
        required: ["query"],
      },
      annotations: {
        readOnlyHint: true, // CRITICAL: Read-only tool
      },
    },
    {
      name: "get_accounts",
      description:
        "Get all accounts with balances. Optionally filter by account type " +
        "(checking, savings, credit, investment).",
      inputSchema: {
        type: "object",
        properties: {
          account_type: {
            type: "string",
            description: "Filter by account type",
          },
        },
      },
      annotations: {
        readOnlyHint: true, // CRITICAL: Read-only tool
      },
    },
    {
      name: "get_spending_by_category",
      description:
        "Get spending aggregated by category for a date range. " +
        "Returns total spending per category, sorted by amount. " +
        "Use 'period' for common date ranges.",
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
        },
      },
      annotations: {
        readOnlyHint: true, // CRITICAL: Read-only tool
      },
    },
    {
      name: "get_account_balance",
      description: "Get balance and details for a specific account by ID.",
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
        readOnlyHint: true, // CRITICAL: Read-only tool
      },
    },
  ];
}
