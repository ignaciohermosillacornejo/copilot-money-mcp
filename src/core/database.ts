/**
 * Database abstraction layer for Copilot Money data.
 *
 * Provides filtered access to transactions and accounts with
 * proper error handling.
 */

import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { decodeAccounts, decodeTransactions } from './decoder.js';
import { Account, Transaction, Category, getTransactionDisplayName } from '../models/index.js';
import { getCategoryName } from '../utils/categories.js';

/**
 * Abstraction layer for querying Copilot Money data.
 *
 * Wraps the decoder and provides filtering capabilities.
 */
export class CopilotDatabase {
  private dbPath: string;
  private _transactions: Transaction[] | null = null;
  private _accounts: Account[] | null = null;

  /**
   * Initialize database connection.
   *
   * @param dbPath - Path to LevelDB database directory.
   *                If undefined, uses default Copilot Money location.
   */
  constructor(dbPath?: string) {
    if (!dbPath) {
      // Default Copilot Money location (macOS)
      dbPath = join(
        homedir(),
        'Library/Containers/com.copilot.production/Data/Library',
        'Application Support/firestore/__FIRAPP_DEFAULT',
        'copilot-production-22904/main'
      );
    }

    this.dbPath = dbPath;
  }

  /**
   * Check if database exists and is accessible.
   */
  isAvailable(): boolean {
    try {
      if (!existsSync(this.dbPath)) {
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
      this._transactions = decodeTransactions(this.dbPath);
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
      this._transactions = decodeTransactions(this.dbPath);
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
      this._accounts = decodeAccounts(this.dbPath);
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
   * Get all unique categories from transactions.
   *
   * @returns List of unique categories with human-readable names
   */
  getCategories(): Category[] {
    // Load transactions
    if (this._transactions === null) {
      this._transactions = decodeTransactions(this.dbPath);
    }

    // Extract unique category IDs and count transactions
    const categoryStats = new Map<string, { count: number; totalAmount: number }>();

    for (const txn of this._transactions) {
      if (txn.category_id) {
        const stats = categoryStats.get(txn.category_id) || {
          count: 0,
          totalAmount: 0,
        };
        stats.count++;
        stats.totalAmount += Math.abs(txn.amount);
        categoryStats.set(txn.category_id, stats);
      }
    }

    // Create Category objects with human-readable names
    const uniqueCategories: Category[] = [];
    for (const categoryId of categoryStats.keys()) {
      const category: Category = {
        category_id: categoryId,
        name: getCategoryName(categoryId),
      };
      uniqueCategories.push(category);
    }

    // Sort by name for easier browsing
    return uniqueCategories.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get all transactions (unfiltered) - useful for internal aggregations.
   *
   * @returns All transactions
   */
  getAllTransactions(): Transaction[] {
    // Lazy load transactions
    if (this._transactions === null) {
      this._transactions = decodeTransactions(this.dbPath);
    }
    return [...this._transactions];
  }

  /**
   * Get database path.
   */
  getDbPath(): string {
    return this.dbPath;
  }
}
