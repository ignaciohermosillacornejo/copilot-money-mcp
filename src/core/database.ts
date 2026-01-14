/**
 * Database abstraction layer for Copilot Money data.
 *
 * Provides filtered access to transactions and accounts with
 * proper error handling.
 */

import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  decodeAccounts,
  decodeTransactions,
  decodeRecurring,
  decodeBudgets,
  decodeGoals,
  decodeGoalHistory,
  decodeInvestmentPrices,
  decodeInvestmentSplits,
  decodeItems,
  decodeCategories,
} from './decoder.js';
import {
  Account,
  Transaction,
  Category,
  Recurring,
  Budget,
  Goal,
  GoalHistory,
  InvestmentPrice,
  InvestmentSplit,
  Item,
  getTransactionDisplayName,
} from '../models/index.js';
import { getCategoryName } from '../utils/categories.js';

/**
 * Find Copilot Money database by searching known locations.
 * Returns the first valid path found, or undefined if none found.
 */
function findCopilotDatabase(): string | undefined {
  const home = homedir();

  // Known possible locations for Copilot Money database (macOS)
  const possiblePaths = [
    // Current known location
    join(
      home,
      'Library/Containers/com.copilot.production/Data/Library',
      'Application Support/firestore/__FIRAPP_DEFAULT',
      'copilot-production-22904/main'
    ),
    // Alternative Firestore paths
    join(
      home,
      'Library/Containers/com.copilot.production/Data/Library',
      'Application Support/Copilot/FirestoreDB/data'
    ),
    // Potential future locations
    join(home, 'Library/Application Support/Copilot/FirestoreDB/data'),
    join(home, 'Library/Containers/com.copilot.production/Data/Documents/FirestoreDB'),
  ];

  // Also try to dynamically find paths matching patterns
  const containerBase = join(
    home,
    'Library/Containers/com.copilot.production/Data/Library/Application Support'
  );
  if (existsSync(containerBase)) {
    try {
      // Look for firestore directories
      const firestorePath = join(containerBase, 'firestore/__FIRAPP_DEFAULT');
      if (existsSync(firestorePath)) {
        const entries = readdirSync(firestorePath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith('copilot-')) {
            const mainPath = join(firestorePath, entry.name, 'main');
            if (existsSync(mainPath)) {
              possiblePaths.unshift(mainPath); // Add to front as highest priority
            }
          }
        }
      }
    } catch {
      // Ignore errors during dynamic discovery
    }
  }

  // Check each path for validity (contains .ldb files)
  for (const path of possiblePaths) {
    try {
      if (existsSync(path)) {
        const files = readdirSync(path);
        if (files.some((file) => file.endsWith('.ldb'))) {
          return path;
        }
      }
    } catch {
      // Continue to next path
    }
  }

  return undefined;
}

/**
 * Abstraction layer for querying Copilot Money data.
 *
 * Wraps the decoder and provides filtering capabilities.
 */
export class CopilotDatabase {
  private dbPath: string | undefined;
  private _transactions: Transaction[] | null = null;
  private _accounts: Account[] | null = null;
  private _recurring: Recurring[] | null = null;
  private _budgets: Budget[] | null = null;
  private _goals: Goal[] | null = null;
  private _userCategories: Category[] | null = null;
  private _categoryNameMap: Map<string, string> | null = null;

  /**
   * Initialize database connection.
   *
   * @param dbPath - Path to LevelDB database directory.
   *                If undefined, auto-detects Copilot Money location.
   */
  constructor(dbPath?: string) {
    if (dbPath) {
      this.dbPath = dbPath;
    } else {
      // Auto-detect database location
      this.dbPath = findCopilotDatabase();
    }
  }

  /**
   * Get the database path, throwing if not available.
   */
  private requireDbPath(): string {
    if (!this.dbPath) {
      throw new Error(
        'Database not found. Please ensure Copilot Money is installed and has synced data.'
      );
    }
    return this.dbPath;
  }

  /**
   * Check if database exists and is accessible.
   */
  isAvailable(): boolean {
    try {
      if (!this.dbPath || !existsSync(this.dbPath)) {
        return false;
      }

      // Check if directory contains .ldb files
      const files = readdirSync(this.dbPath);
      return files.some((file) => file.endsWith('.ldb'));
    } catch {
      return false;
    }
  }

  /**
   * Get transactions with optional filters.
   *
   * @param options - Filter options
   * @param options.startDate - Filter by date >= this (YYYY-MM-DD)
   * @param options.endDate - Filter by date <= this (YYYY-MM-DD)
   * @param options.category - Filter by category_id (case-insensitive substring match)
   * @param options.merchant - Filter by merchant name (case-insensitive substring match)
   * @param options.accountId - Filter by account_id
   * @param options.minAmount - Filter by amount >= this
   * @param options.maxAmount - Filter by amount <= this
   * @param options.limit - Maximum number of transactions to return (default: 1000)
   * @returns List of filtered transactions, sorted by date descending
   */
  getTransactions(
    options: {
      startDate?: string;
      endDate?: string;
      category?: string;
      merchant?: string;
      accountId?: string;
      minAmount?: number;
      maxAmount?: number;
      limit?: number;
    } = {}
  ): Transaction[] {
    const {
      startDate,
      endDate,
      category,
      merchant,
      accountId,
      minAmount,
      maxAmount,
      limit = 1000,
    } = options;

    // Lazy load transactions
    if (this._transactions === null) {
      this._transactions = decodeTransactions(this.requireDbPath());
    }

    let result = [...this._transactions];

    // Apply date range filter
    if (startDate) {
      result = result.filter((txn) => txn.date >= startDate);
    }
    if (endDate) {
      result = result.filter((txn) => txn.date <= endDate);
    }

    // Apply category filter (case-insensitive)
    if (category) {
      const categoryLower = category.toLowerCase();
      result = result.filter(
        (txn) => txn.category_id && txn.category_id.toLowerCase().includes(categoryLower)
      );
    }

    // Apply merchant filter (case-insensitive, check display_name)
    if (merchant) {
      const merchantLower = merchant.toLowerCase();
      result = result.filter((txn) =>
        getTransactionDisplayName(txn).toLowerCase().includes(merchantLower)
      );
    }

    // Apply account ID filter
    if (accountId) {
      result = result.filter((txn) => txn.account_id === accountId);
    }

    // Apply amount range filter
    if (minAmount !== undefined) {
      result = result.filter((txn) => txn.amount >= minAmount);
    }
    if (maxAmount !== undefined) {
      result = result.filter((txn) => txn.amount <= maxAmount);
    }

    // Apply limit
    return result.slice(0, limit);
  }

  /**
   * Free-text search of transactions.
   *
   * Searches in merchant name (display_name).
   *
   * @param query - Search query (case-insensitive)
   * @param limit - Maximum results (default: 50)
   * @returns List of matching transactions
   */
  searchTransactions(query: string, limit = 50): Transaction[] {
    // Lazy load transactions
    if (this._transactions === null) {
      this._transactions = decodeTransactions(this.requireDbPath());
    }

    const queryLower = query.toLowerCase();
    const result = this._transactions.filter((txn) =>
      getTransactionDisplayName(txn).toLowerCase().includes(queryLower)
    );

    return result.slice(0, limit);
  }

  /**
   * Get all accounts.
   *
   * @param accountType - Optional filter by account type
   *                     (checking, savings, credit, investment)
   *                     Also checks subtype field for better matching.
   * @returns List of accounts
   */
  getAccounts(accountType?: string): Account[] {
    // Lazy load accounts
    if (this._accounts === null) {
      this._accounts = decodeAccounts(this.requireDbPath());
    }

    let result = [...this._accounts];

    // Apply account type filter if specified
    // Check both account_type and subtype fields for better matching
    if (accountType) {
      const accountTypeLower = accountType.toLowerCase();
      result = result.filter((acc) => {
        // Check account_type field
        if (acc.account_type && acc.account_type.toLowerCase().includes(accountTypeLower)) {
          return true;
        }
        // Check subtype field (e.g., "checking" when account_type is "depository")
        if (acc.subtype && acc.subtype.toLowerCase().includes(accountTypeLower)) {
          return true;
        }
        return false;
      });
    }

    return result;
  }

  /**
   * Get recurring transactions from Copilot's native subscription tracking.
   *
   * @param activeOnly - If true, only return active recurring transactions
   * @returns List of recurring transactions
   */
  getRecurring(activeOnly = false): Recurring[] {
    // Lazy load recurring
    if (this._recurring === null) {
      this._recurring = decodeRecurring(this.requireDbPath());
    }

    let result = [...this._recurring];

    if (activeOnly) {
      // Filter for active subscriptions:
      // - is_active === true: explicitly marked as active
      // - is_active === undefined: status field not set in Firestore, treat as potentially active
      //   (better to show potentially active subscriptions than hide real ones)
      // - is_active === false: explicitly canceled, excluded
      result = result.filter((rec) => rec.is_active === true || rec.is_active === undefined);
    }

    return result;
  }

  /**
   * Get budgets from Copilot's native budget tracking.
   *
   * @param activeOnly - If true, only return active budgets
   * @returns List of budgets
   */
  getBudgets(activeOnly = false): Budget[] {
    // Lazy load budgets
    if (this._budgets === null) {
      this._budgets = decodeBudgets(this.requireDbPath());
    }

    let result = [...this._budgets];

    if (activeOnly) {
      // Filter for active budgets:
      // - is_active === true: explicitly marked as active
      // - is_active === undefined: status field not set in Firestore, treat as potentially active
      //   (better to show potentially active budgets than hide real ones)
      // - is_active === false: explicitly disabled, excluded
      result = result.filter(
        (budget) => budget.is_active === true || budget.is_active === undefined
      );
    }

    return result;
  }

  /**
   * Get financial goals from the database.
   *
   * @param activeOnly - If true, only return active goals (default: false)
   * @returns Array of Goal objects
   */
  getGoals(activeOnly = false): Goal[] {
    // Lazy load goals
    if (this._goals === null) {
      this._goals = decodeGoals(this.requireDbPath());
    }

    let result = [...this._goals];

    if (activeOnly) {
      // Filter for active goals (status === 'active')
      result = result.filter((goal) => goal.savings?.status === 'active');
    }

    return result;
  }

  /**
   * Get goal history (monthly snapshots) from the database.
   *
   * Goal history is stored in the subcollection:
   * /users/{user_id}/financial_goals/{goal_id}/financial_goal_history/{month}
   *
   * Each document represents a monthly snapshot with:
   * - current_amount: Amount saved as of that month
   * - daily_data: Nested object with daily snapshots
   * - contributions: Array of deposits/withdrawals (if available)
   *
   * @param goalId - Optional goal ID to filter history for a specific goal
   * @param options - Filter options
   * @param options.startMonth - Filter by month >= this (YYYY-MM)
   * @param options.endMonth - Filter by month <= this (YYYY-MM)
   * @param options.limit - Maximum number of history entries to return
   * @returns Array of GoalHistory objects, sorted by goal_id and month (newest first)
   */
  getGoalHistory(
    goalId?: string,
    options: {
      startMonth?: string;
      endMonth?: string;
      limit?: number;
    } = {}
  ): GoalHistory[] {
    const { startMonth, endMonth, limit } = options;

    // Decode goal history from the database
    // Note: We don't cache this as it can be large and change frequently
    let result = decodeGoalHistory(this.requireDbPath(), goalId);

    // Apply month range filters
    if (startMonth) {
      result = result.filter((h) => h.month >= startMonth);
    }
    if (endMonth) {
      result = result.filter((h) => h.month <= endMonth);
    }

    // Apply limit if specified
    if (limit && limit > 0) {
      result = result.slice(0, limit);
    }

    return result;
  }

  /**
   * Get user-defined categories from Firestore.
   *
   * These are custom categories created by the user in the Copilot Money app,
   * stored in /users/{user_id}/categories/{category_id}.
   *
   * @returns List of user-defined categories with full metadata
   */
  getUserCategories(): Category[] {
    // Lazy load user categories
    if (this._userCategories === null) {
      this._userCategories = decodeCategories(this.requireDbPath());
    }
    return [...this._userCategories];
  }

  /**
   * Build a map of category ID to category name from user-defined categories.
   *
   * This map can be used for efficient category name lookups.
   * The map is cached after the first call.
   *
   * @returns Map from category_id to category name
   */
  getCategoryNameMap(): Map<string, string> {
    // Return cached map if available
    if (this._categoryNameMap !== null) {
      return this._categoryNameMap;
    }

    const userCategories = this.getUserCategories();
    const nameMap = new Map<string, string>();

    for (const category of userCategories) {
      if (category.name) {
        nameMap.set(category.category_id, category.name);
      }
    }

    this._categoryNameMap = nameMap;
    return nameMap;
  }

  /**
   * Get all unique categories from transactions.
   *
   * Combines user-defined categories from Firestore with categories
   * referenced in transactions. User-defined categories take precedence
   * for naming.
   *
   * @returns List of unique categories with human-readable names
   */
  getCategories(): Category[] {
    // Load transactions
    if (this._transactions === null) {
      this._transactions = decodeTransactions(this.requireDbPath());
    }

    // Get user-defined categories (which have the actual names)
    const userCategories = this.getUserCategories();
    const userCategoryMap = new Map<string, Category>();
    for (const cat of userCategories) {
      userCategoryMap.set(cat.category_id, cat);
    }

    // Extract unique category IDs from transactions
    const categoryIdsFromTxns = new Set<string>();
    for (const txn of this._transactions) {
      if (txn.category_id) {
        categoryIdsFromTxns.add(txn.category_id);
      }
    }

    // Build result: prefer user-defined categories, fall back to static mapping
    const uniqueCategories: Category[] = [];
    const seenIds = new Set<string>();

    // First, add all user-defined categories
    for (const cat of userCategories) {
      uniqueCategories.push(cat);
      seenIds.add(cat.category_id);
    }

    // Then add any transaction categories not in user-defined list
    for (const categoryId of categoryIdsFromTxns) {
      if (!seenIds.has(categoryId)) {
        // Fall back to static mapping for standard Plaid categories
        const category: Category = {
          category_id: categoryId,
          name: getCategoryName(categoryId),
        };
        uniqueCategories.push(category);
        seenIds.add(categoryId);
      }
    }

    // Sort by name for easier browsing
    return uniqueCategories.sort((a, b) => {
      const nameA = a.name ?? a.category_id;
      const nameB = b.name ?? b.category_id;
      return nameA.localeCompare(nameB);
    });
  }

  /**
   * Get all transactions (unfiltered) - useful for internal aggregations.
   *
   * @returns All transactions
   */
  getAllTransactions(): Transaction[] {
    // Lazy load transactions
    if (this._transactions === null) {
      this._transactions = decodeTransactions(this.requireDbPath());
    }
    return [...this._transactions];
  }

  /**
   * Get database path, or undefined if not found.
   */
  getDbPath(): string | undefined {
    return this.dbPath;
  }

  /**
   * Get investment prices from the database.
   *
   * Investment prices are stored in:
   * /investment_prices/{hash}/daily/{month} - Historical monthly data
   * /investment_prices/{hash}/hf/{date} - High-frequency intraday data
   *
   * @param options - Filter options
   * @param options.tickerSymbol - Filter by ticker symbol (e.g., "AAPL", "BTC-USD")
   * @param options.startDate - Filter by date >= this (YYYY-MM or YYYY-MM-DD)
   * @param options.endDate - Filter by date <= this (YYYY-MM or YYYY-MM-DD)
   * @param options.priceType - Filter by price type ("daily" or "hf")
   * @returns Array of InvestmentPrice objects, sorted by investment_id and date (newest first)
   */
  getInvestmentPrices(
    options: {
      tickerSymbol?: string;
      startDate?: string;
      endDate?: string;
      priceType?: 'daily' | 'hf';
    } = {}
  ): InvestmentPrice[] {
    // Note: We don't cache investment prices as they can be very large (10K+ records)
    // and may change frequently with high-frequency data
    return decodeInvestmentPrices(this.requireDbPath(), options);
  }

  /**
   * Get investment splits from the database.
   *
   * Investment splits are stored in:
   * /investment_splits/{split_id}
   *
   * Each document contains split information including ticker symbol,
   * split date, split ratio (e.g., "4:1"), and calculated multipliers.
   *
   * @param options - Filter options
   * @param options.tickerSymbol - Filter by ticker symbol (e.g., "AAPL", "TSLA")
   * @param options.startDate - Filter by split date >= this (YYYY-MM-DD)
   * @param options.endDate - Filter by split date <= this (YYYY-MM-DD)
   * @returns Array of InvestmentSplit objects, sorted by ticker and date (newest first)
   */
  getInvestmentSplits(
    options: {
      tickerSymbol?: string;
      startDate?: string;
      endDate?: string;
    } = {}
  ): InvestmentSplit[] {
    // Note: We don't cache investment splits as they are relatively small
    // and accessed infrequently
    return decodeInvestmentSplits(this.requireDbPath(), options);
  }

  /**
   * Get connected institutions (Plaid items) from the database.
   *
   * Items represent connections to financial institutions via Plaid.
   * Each item can have multiple accounts (e.g., checking + savings at same bank).
   *
   * @param options - Filter options
   * @param options.connectionStatus - Filter by connection status ("active", "error", etc.)
   * @param options.institutionId - Filter by Plaid institution ID
   * @param options.needsUpdate - Filter by needs_update flag
   * @returns Array of Item objects, sorted by institution name
   */
  getItems(
    options: {
      connectionStatus?: string;
      institutionId?: string;
      needsUpdate?: boolean;
    } = {}
  ): Item[] {
    // Note: We don't cache items as they may change frequently
    // with connection status updates
    return decodeItems(this.requireDbPath(), options);
  }
}
