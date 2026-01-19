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
  decodeUserAccounts,
  decodeAllCollections,
  UserAccountCustomization,
  AllCollectionsResult,
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

  // Check each path for validity (contains .ldb files or is a valid LevelDB directory)
  for (const path of possiblePaths) {
    try {
      if (existsSync(path)) {
        const files = readdirSync(path);
        // Check for .ldb files or LevelDB manifest files
        if (files.some((file) => file.endsWith('.ldb') || file.startsWith('MANIFEST-'))) {
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
 * All data access methods are async due to LevelDB iteration.
 */
export class CopilotDatabase {
  private dbPath: string | undefined;
  private _transactions: Transaction[] | null = null;
  private _accounts: Account[] | null = null;
  private _recurring: Recurring[] | null = null;
  private _budgets: Budget[] | null = null;
  private _goals: Goal[] | null = null;
  private _goalHistory: GoalHistory[] | null = null;
  private _investmentPrices: InvestmentPrice[] | null = null;
  private _investmentSplits: InvestmentSplit[] | null = null;
  private _items: Item[] | null = null;
  private _userCategories: Category[] | null = null;
  private _categoryNameMap: Map<string, string> | null = null;
  private _userAccounts: UserAccountCustomization[] | null = null;
  private _accountNameMap: Map<string, string> | null = null;

  // Promises for in-flight loads to prevent duplicate loading
  private _loadingTransactions: Promise<Transaction[]> | null = null;
  private _loadingAccounts: Promise<Account[]> | null = null;
  private _loadingRecurring: Promise<Recurring[]> | null = null;
  private _loadingBudgets: Promise<Budget[]> | null = null;
  private _loadingGoals: Promise<Goal[]> | null = null;
  private _loadingGoalHistory: Promise<GoalHistory[]> | null = null;
  private _loadingInvestmentPrices: Promise<InvestmentPrice[]> | null = null;
  private _loadingInvestmentSplits: Promise<InvestmentSplit[]> | null = null;
  private _loadingItems: Promise<Item[]> | null = null;
  private _loadingUserCategories: Promise<Category[]> | null = null;
  private _loadingUserAccounts: Promise<UserAccountCustomization[]> | null = null;

  // Batch loading state
  private _loadingAllCollections: Promise<AllCollectionsResult> | null = null;
  private _allCollectionsLoaded = false;

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

      // Check if directory contains .ldb files or LevelDB manifest
      const files = readdirSync(this.dbPath);
      return files.some((file) => file.endsWith('.ldb') || file.startsWith('MANIFEST-'));
    } catch {
      return false;
    }
  }

  /**
   * Load all collections in a single database pass for optimal performance.
   *
   * This is ~10x faster than loading each collection individually because
   * it only iterates through the database once instead of once per collection.
   */
  private async loadAllCollections(): Promise<void> {
    // Return if already loaded
    if (this._allCollectionsLoaded) {
      return;
    }

    // Return in-flight promise if loading
    if (this._loadingAllCollections !== null) {
      await this._loadingAllCollections;
      return;
    }

    // Start batch loading
    this._loadingAllCollections = decodeAllCollections(this.requireDbPath());
    try {
      const result = await this._loadingAllCollections;

      // Populate all caches
      this._transactions = result.transactions;
      this._accounts = result.accounts;
      this._recurring = result.recurring;
      this._budgets = result.budgets;
      this._goals = result.goals;
      this._goalHistory = result.goalHistory;
      this._investmentPrices = result.investmentPrices;
      this._investmentSplits = result.investmentSplits;
      this._items = result.items;
      this._userCategories = result.categories;
      this._userAccounts = result.userAccounts;

      this._allCollectionsLoaded = true;
    } finally {
      this._loadingAllCollections = null;
    }
  }

  /**
   * Load transactions with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadTransactions(): Promise<Transaction[]> {
    // Return cached data if available
    if (this._transactions !== null) {
      return this._transactions;
    }

    // Use batch loading for optimal performance
    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._transactions!;
    }

    // Fallback to individual loading (shouldn't normally happen)
    if (this._loadingTransactions !== null) {
      return this._loadingTransactions;
    }

    this._loadingTransactions = decodeTransactions(this.requireDbPath());
    try {
      this._transactions = await this._loadingTransactions;
      return this._transactions;
    } finally {
      this._loadingTransactions = null;
    }
  }

  /**
   * Load accounts with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadAccounts(): Promise<Account[]> {
    if (this._accounts !== null) {
      return this._accounts;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._accounts!;
    }

    if (this._loadingAccounts !== null) {
      return this._loadingAccounts;
    }

    this._loadingAccounts = decodeAccounts(this.requireDbPath());
    try {
      this._accounts = await this._loadingAccounts;
      return this._accounts;
    } finally {
      this._loadingAccounts = null;
    }
  }

  /**
   * Load recurring with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadRecurring(): Promise<Recurring[]> {
    if (this._recurring !== null) {
      return this._recurring;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._recurring!;
    }

    if (this._loadingRecurring !== null) {
      return this._loadingRecurring;
    }

    this._loadingRecurring = decodeRecurring(this.requireDbPath());
    try {
      this._recurring = await this._loadingRecurring;
      return this._recurring;
    } finally {
      this._loadingRecurring = null;
    }
  }

  /**
   * Load budgets with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadBudgets(): Promise<Budget[]> {
    if (this._budgets !== null) {
      return this._budgets;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._budgets!;
    }

    if (this._loadingBudgets !== null) {
      return this._loadingBudgets;
    }

    this._loadingBudgets = decodeBudgets(this.requireDbPath());
    try {
      this._budgets = await this._loadingBudgets;
      return this._budgets;
    } finally {
      this._loadingBudgets = null;
    }
  }

  /**
   * Load goals with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadGoals(): Promise<Goal[]> {
    if (this._goals !== null) {
      return this._goals;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._goals!;
    }

    if (this._loadingGoals !== null) {
      return this._loadingGoals;
    }

    this._loadingGoals = decodeGoals(this.requireDbPath());
    try {
      this._goals = await this._loadingGoals;
      return this._goals;
    } finally {
      this._loadingGoals = null;
    }
  }

  /**
   * Load goal history with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadGoalHistory(): Promise<GoalHistory[]> {
    if (this._goalHistory !== null) {
      return this._goalHistory;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._goalHistory!;
    }

    if (this._loadingGoalHistory !== null) {
      return this._loadingGoalHistory;
    }

    this._loadingGoalHistory = decodeGoalHistory(this.requireDbPath());
    try {
      this._goalHistory = await this._loadingGoalHistory;
      return this._goalHistory;
    } finally {
      this._loadingGoalHistory = null;
    }
  }

  /**
   * Load investment prices with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadInvestmentPrices(): Promise<InvestmentPrice[]> {
    if (this._investmentPrices !== null) {
      return this._investmentPrices;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._investmentPrices!;
    }

    if (this._loadingInvestmentPrices !== null) {
      return this._loadingInvestmentPrices;
    }

    this._loadingInvestmentPrices = decodeInvestmentPrices(this.requireDbPath(), {});
    try {
      this._investmentPrices = await this._loadingInvestmentPrices;
      return this._investmentPrices;
    } finally {
      this._loadingInvestmentPrices = null;
    }
  }

  /**
   * Load investment splits with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadInvestmentSplits(): Promise<InvestmentSplit[]> {
    if (this._investmentSplits !== null) {
      return this._investmentSplits;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._investmentSplits!;
    }

    if (this._loadingInvestmentSplits !== null) {
      return this._loadingInvestmentSplits;
    }

    this._loadingInvestmentSplits = decodeInvestmentSplits(this.requireDbPath());
    try {
      this._investmentSplits = await this._loadingInvestmentSplits;
      return this._investmentSplits;
    } finally {
      this._loadingInvestmentSplits = null;
    }
  }

  /**
   * Load items with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadItems(): Promise<Item[]> {
    if (this._items !== null) {
      return this._items;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._items!;
    }

    if (this._loadingItems !== null) {
      return this._loadingItems;
    }

    this._loadingItems = decodeItems(this.requireDbPath());
    try {
      this._items = await this._loadingItems;
      return this._items;
    } finally {
      this._loadingItems = null;
    }
  }

  /**
   * Load user categories with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadUserCategories(): Promise<Category[]> {
    if (this._userCategories !== null) {
      return this._userCategories;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._userCategories!;
    }

    if (this._loadingUserCategories !== null) {
      return this._loadingUserCategories;
    }

    this._loadingUserCategories = decodeCategories(this.requireDbPath());
    try {
      this._userCategories = await this._loadingUserCategories;
      return this._userCategories;
    } finally {
      this._loadingUserCategories = null;
    }
  }

  /**
   * Load user accounts with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadUserAccounts(): Promise<UserAccountCustomization[]> {
    if (this._userAccounts !== null) {
      return this._userAccounts;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._userAccounts!;
    }

    if (this._loadingUserAccounts !== null) {
      return this._loadingUserAccounts;
    }

    this._loadingUserAccounts = decodeUserAccounts(this.requireDbPath());
    try {
      this._userAccounts = await this._loadingUserAccounts;
      return this._userAccounts;
    } finally {
      this._loadingUserAccounts = null;
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
  async getTransactions(
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
  ): Promise<Transaction[]> {
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

    const transactions = await this.loadTransactions();
    let result = [...transactions];

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

    // Apply amount range filter (using absolute value for intuitive filtering)
    // With standard accounting (negative = expense), users expect minAmount: 50
    // to find transactions with magnitude >= 50 (e.g., -50, -100, not -25)
    if (minAmount !== undefined) {
      result = result.filter((txn) => Math.abs(txn.amount) >= minAmount);
    }
    if (maxAmount !== undefined) {
      result = result.filter((txn) => Math.abs(txn.amount) <= maxAmount);
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
  async searchTransactions(query: string, limit = 50): Promise<Transaction[]> {
    const transactions = await this.loadTransactions();

    const queryLower = query.toLowerCase();
    const result = transactions.filter((txn) =>
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
  async getAccounts(accountType?: string): Promise<Account[]> {
    const accounts = await this.loadAccounts();
    let result = [...accounts];

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
  async getRecurring(activeOnly = false): Promise<Recurring[]> {
    const recurring = await this.loadRecurring();
    let result = [...recurring];

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
  async getBudgets(activeOnly = false): Promise<Budget[]> {
    const budgets = await this.loadBudgets();
    let result = [...budgets];

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
  async getGoals(activeOnly = false): Promise<Goal[]> {
    const goals = await this.loadGoals();
    let result = [...goals];

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
  async getGoalHistory(
    goalId?: string,
    options: {
      startMonth?: string;
      endMonth?: string;
      limit?: number;
    } = {}
  ): Promise<GoalHistory[]> {
    const { startMonth, endMonth, limit } = options;

    // Load goal history with caching
    const allHistory = await this.loadGoalHistory();
    let result = [...allHistory];

    // Apply goal ID filter
    if (goalId) {
      result = result.filter((h) => h.goal_id === goalId);
    }

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
  async getUserCategories(): Promise<Category[]> {
    const userCategories = await this.loadUserCategories();
    return [...userCategories];
  }

  /**
   * Build a map of category ID to category name from user-defined categories.
   *
   * This map can be used for efficient category name lookups.
   * The map is cached after the first call.
   *
   * @returns Map from category_id to category name
   */
  async getCategoryNameMap(): Promise<Map<string, string>> {
    // Return cached map if available
    if (this._categoryNameMap !== null) {
      return this._categoryNameMap;
    }

    const userCategories = await this.loadUserCategories();
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
   * Get user-defined account customizations from Firestore.
   *
   * These are user settings for accounts stored in the Copilot Money app,
   * stored in /users/{user_id}/accounts/{account_id}.
   *
   * This includes user-defined account names (e.g., "Chase Sapphire Preferred")
   * which override the bank's internal names (e.g., "CHASE CREDIT CRD AUTOPAY").
   *
   * @returns List of user account customizations
   */
  async getUserAccounts(): Promise<UserAccountCustomization[]> {
    const userAccounts = await this.loadUserAccounts();
    return [...userAccounts];
  }

  /**
   * Build a map of account ID to user-defined account name.
   *
   * This map can be used to look up user-friendly account names.
   * The map is cached after the first call.
   *
   * @returns Map from account_id to user-defined account name
   */
  async getAccountNameMap(): Promise<Map<string, string>> {
    // Return cached map if available
    if (this._accountNameMap !== null) {
      return this._accountNameMap;
    }

    const userAccounts = await this.loadUserAccounts();
    const nameMap = new Map<string, string>();

    for (const userAccount of userAccounts) {
      if (userAccount.name) {
        nameMap.set(userAccount.account_id, userAccount.name);
      }
    }

    this._accountNameMap = nameMap;
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
  async getCategories(): Promise<Category[]> {
    const [transactions, userCategories] = await Promise.all([
      this.loadTransactions(),
      this.loadUserCategories(),
    ]);

    // Build map of user-defined categories
    const userCategoryMap = new Map<string, Category>();
    for (const cat of userCategories) {
      userCategoryMap.set(cat.category_id, cat);
    }

    // Extract unique category IDs from transactions
    const categoryIdsFromTxns = new Set<string>();
    for (const txn of transactions) {
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
  async getAllTransactions(): Promise<Transaction[]> {
    const transactions = await this.loadTransactions();
    return [...transactions];
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
  async getInvestmentPrices(
    options: {
      tickerSymbol?: string;
      startDate?: string;
      endDate?: string;
      priceType?: 'daily' | 'hf';
    } = {}
  ): Promise<InvestmentPrice[]> {
    const { tickerSymbol, startDate, endDate, priceType } = options;

    // Load investment prices with caching
    const allPrices = await this.loadInvestmentPrices();
    let result = [...allPrices];

    // Apply ticker symbol filter
    if (tickerSymbol) {
      result = result.filter((p) => p.ticker_symbol === tickerSymbol);
    }

    // Apply date range filters
    if (startDate) {
      result = result.filter((p) => p.date && p.date >= startDate);
    }
    if (endDate) {
      result = result.filter((p) => p.date && p.date <= endDate);
    }

    // Apply price type filter
    if (priceType) {
      result = result.filter((p) => p.price_type === priceType);
    }

    return result;
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
  async getInvestmentSplits(
    options: {
      tickerSymbol?: string;
      startDate?: string;
      endDate?: string;
    } = {}
  ): Promise<InvestmentSplit[]> {
    const { tickerSymbol, startDate, endDate } = options;

    // Load investment splits with caching
    const allSplits = await this.loadInvestmentSplits();
    let result = [...allSplits];

    // Apply ticker symbol filter
    if (tickerSymbol) {
      result = result.filter((s) => s.ticker_symbol === tickerSymbol);
    }

    // Apply date range filters
    if (startDate) {
      result = result.filter((s) => s.split_date && s.split_date >= startDate);
    }
    if (endDate) {
      result = result.filter((s) => s.split_date && s.split_date <= endDate);
    }

    return result;
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
  async getItems(
    options: {
      connectionStatus?: string;
      institutionId?: string;
      needsUpdate?: boolean;
    } = {}
  ): Promise<Item[]> {
    const { connectionStatus, institutionId, needsUpdate } = options;

    // Load items with caching
    const allItems = await this.loadItems();
    let result = [...allItems];

    // Apply connection status filter
    if (connectionStatus) {
      result = result.filter((item) => item.connection_status === connectionStatus);
    }

    // Apply institution ID filter
    if (institutionId) {
      result = result.filter((item) => item.institution_id === institutionId);
    }

    // Apply needs update filter
    if (needsUpdate !== undefined) {
      result = result.filter((item) => item.needs_update === needsUpdate);
    }

    return result;
  }

  /**
   * Get cache information including date range and transaction count.
   * Useful for warning users when queries may be limited by cache size.
   *
   * @returns Cache metadata including date range and count
   */
  async getCacheInfo(): Promise<{
    oldest_transaction_date: string | null;
    newest_transaction_date: string | null;
    transaction_count: number;
    cache_note: string;
  }> {
    const transactions = await this.loadTransactions();
    if (transactions.length === 0) {
      return {
        oldest_transaction_date: null,
        newest_transaction_date: null,
        transaction_count: 0,
        cache_note: 'No transactions in local cache. Open Copilot Money app to sync data.',
      };
    }

    const dates = transactions.map((t) => t.date).sort();
    const oldestDate = dates[0] ?? null;
    const newestDate = dates[dates.length - 1] ?? null;

    return {
      oldest_transaction_date: oldestDate,
      newest_transaction_date: newestDate,
      transaction_count: transactions.length,
      cache_note:
        `Local cache contains ${transactions.length} transactions from ${oldestDate} to ${newestDate}. ` +
        'This is a subset of your full transaction history. ' +
        'Open Copilot Money app and browse transactions to sync more data.',
    };
  }

  /**
   * Check if a date range query may be limited by cache availability.
   * Returns a warning message if the query extends before the oldest cached transaction.
   *
   * @param startDate - Query start date (YYYY-MM-DD)
   * @param endDate - Query end date (YYYY-MM-DD) - optional
   * @returns Warning message if cache may limit results, null otherwise
   */
  async checkCacheLimitation(startDate?: string, _endDate?: string): Promise<string | null> {
    if (!startDate) return null;

    const cacheInfo = await this.getCacheInfo();
    if (!cacheInfo.oldest_transaction_date) return null;

    // If query starts before oldest cached data, warn the user
    if (startDate < cacheInfo.oldest_transaction_date) {
      return (
        `Note: Your query starts at ${startDate}, but local cache only contains transactions from ` +
        `${cacheInfo.oldest_transaction_date} to ${cacheInfo.newest_transaction_date} (${cacheInfo.transaction_count} total). ` +
        'Earlier transactions may exist in Copilot Money but are not cached locally. ' +
        'Open the Copilot Money app and scroll through older transactions to cache more data.'
      );
    }

    return null;
  }
}
