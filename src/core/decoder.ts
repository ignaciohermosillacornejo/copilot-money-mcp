/**
 * LevelDB/Protobuf decoder for Copilot Money Firestore data.
 *
 * Based on working decoder code from REVERSE_ENGINEERING_FINDING.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  Transaction,
  TransactionSchema,
  getTransactionDisplayName,
} from '../models/transaction.js';
import { Account, AccountSchema, getAccountDisplayName } from '../models/account.js';
import { Recurring, RecurringSchema } from '../models/recurring.js';
import { Budget, BudgetSchema } from '../models/budget.js';
import { Goal, GoalSchema } from '../models/goal.js';
import { GoalHistory, GoalHistorySchema, DailySnapshot } from '../models/goal-history.js';
import { InvestmentPrice, InvestmentPriceSchema } from '../models/investment-price.js';
import { InvestmentSplit, InvestmentSplitSchema } from '../models/investment-split.js';
import { Item, ItemSchema } from '../models/item.js';
import { Category, CategorySchema } from '../models/category.js';

/**
 * Find a field in a Firestore binary record and extract its string value.
 *
 * Searches for a field name pattern in the buffer, then looks for a string
 * value tag (0x8a 0x01) followed by the length and UTF-8 encoded string content.
 *
 * @param data - The buffer containing the Firestore binary record
 * @param fieldName - The field name pattern to search for (created by fieldPattern)
 * @returns The extracted string value, or null if not found or invalid
 */
function extractStringValue(data: Buffer, fieldName: Buffer): string | null {
  const idx = data.indexOf(fieldName);
  if (idx === -1) {
    return null;
  }

  // Look for string value tag (0x8a 0x01) after field name
  const searchStart = idx + fieldName.length;
  const searchEnd = Math.min(data.length, searchStart + 50);
  const after = data.subarray(searchStart, searchEnd);

  for (let i = 0; i < after.length - 3; i++) {
    const byte0 = after[i];
    const byte1 = after[i + 1];
    const strLen = after[i + 2];
    if (byte0 === 0x8a && byte1 === 0x01 && strLen !== undefined) {
      if (strLen > 0 && strLen < 100) {
        try {
          const value = after.subarray(i + 3, i + 3 + strLen).toString('utf-8');
          // Check if string is printable (no control characters except space)
          if (/^[\x20-\x7E\u00A0-\uFFFF]*$/.test(value)) {
            return value;
          }
        } catch {
          // Unicode decode error
        }
      }
    }
  }

  return null;
}

/**
 * Extract a double-precision floating point value from a buffer.
 *
 * Searches for a double value tag (0x19) within the specified range,
 * then reads an 8-byte little-endian double following the tag.
 * Values are validated to be within a reasonable range (-10M to 10M)
 * and rounded to 2 decimal places.
 *
 * @param data - The buffer to search in
 * @param startPos - The starting position to search from
 * @param maxSearch - Maximum number of bytes to search (default: 20)
 * @returns The extracted double value rounded to 2 decimals, or null if not found
 */
function extractDoubleValue(data: Buffer, startPos: number, maxSearch: number = 20): number | null {
  const chunk = data.subarray(startPos, startPos + maxSearch);

  for (let i = 0; i < chunk.length - 9; i++) {
    if (chunk[i] === 0x19) {
      // Double value tag
      try {
        const val = chunk.readDoubleLE(i + 1);
        if (val > -10_000_000 && val < 10_000_000) {
          return Math.round(val * 100) / 100; // Round to 2 decimal places
        }
      } catch {
        // Read error
      }
    }
  }

  return null;
}

/**
 * Extract a double value for a named field in a Firestore record.
 *
 * Combines field searching with double extraction - finds the field name
 * pattern in the buffer, then extracts the double value that follows.
 *
 * @param data - The buffer containing the Firestore binary record
 * @param fieldName - The field name pattern to search for (created by fieldPattern)
 * @returns The extracted double value, or null if field not found or no valid double
 */
function extractDoubleField(data: Buffer, fieldName: Buffer): number | null {
  const idx = data.indexOf(fieldName);
  if (idx === -1) {
    return null;
  }
  return extractDoubleValue(data, idx + fieldName.length);
}

/**
 * Create a length-prefixed field pattern for searching Firestore field names.
 *
 * Firestore stores field names with a specific binary format:
 * - 0x0a prefix byte (field marker)
 * - 1-byte length
 * - UTF-8 encoded field name
 *
 * @param name - The field name to create a pattern for (e.g., "amount", "date")
 * @returns A Buffer containing the binary pattern to search for
 * @example
 * fieldPattern('amount') // Returns Buffer with bytes [0x0a, 0x06, 'a', 'm', 'o', 'u', 'n', 't']
 */
function fieldPattern(name: string): Buffer {
  return Buffer.from([0x0a, name.length, ...Buffer.from(name)]);
}

/**
 * Extract a boolean value for a named field in a Firestore record.
 *
 * Supports two binary formats used by Firestore:
 * 1. Firestore format: \x0a{len}fieldname\x12\x02\x08{value}
 * 2. Simple format: fieldname\x08{value}
 *
 * Where value byte is 0x00 (false) or 0x01 (true).
 *
 * @param data - The buffer containing the Firestore binary record
 * @param fieldName - The field name pattern to search for (created by fieldPattern)
 * @returns true if value byte is non-zero, false if zero, null if field not found
 */
function extractBooleanValue(data: Buffer, fieldName: Buffer): boolean | null {
  const idx = data.indexOf(fieldName);
  if (idx === -1) {
    return null;
  }

  const searchStart = idx + fieldName.length;
  const searchEnd = Math.min(data.length, searchStart + 20);
  const after = data.subarray(searchStart, searchEnd);

  // Try Firestore format first: \x12\x02\x08{value}
  for (let i = 0; i < after.length - 3; i++) {
    if (after[i] === 0x12 && after[i + 1] === 0x02 && after[i + 2] === 0x08) {
      return Boolean(after[i + 3]);
    }
  }

  // Fall back to simple format: \x08{value}
  for (let i = 0; i < after.length - 1; i++) {
    if (after[i] === 0x08) {
      return Boolean(after[i + 1]);
    }
  }

  return null;
}

/**
 * Decode all transactions from LevelDB files.
 */
export function decodeTransactions(dbPath: string): Transaction[] {
  const transactions: Transaction[] = [];

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database path not found: ${dbPath}`);
  }

  const stat = fs.statSync(dbPath);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${dbPath}`);
  }

  // Get all .ldb files
  const files = fs.readdirSync(dbPath);
  const ldbFiles = files.filter((f) => f.endsWith('.ldb')).map((f) => path.join(dbPath, f));

  for (const filepath of ldbFiles) {
    const data = fs.readFileSync(filepath);

    // Skip files without transaction data
    if (!data.includes(Buffer.from('amount')) || !data.includes(Buffer.from('original_name'))) {
      continue;
    }

    // Find all amount fields
    let searchPos = 0;
    const amountPattern = Buffer.from([0x0a, 0x06, 0x61, 0x6d, 0x6f, 0x75, 0x6e, 0x74]); // "\x0a\x06amount"

    let idx = data.indexOf(amountPattern, searchPos);
    while (idx !== -1) {
      searchPos = idx + 1;

      // Extract amount value
      const amount = extractDoubleValue(data, idx + 8);
      if (amount === null || amount === 0) {
        idx = data.indexOf(amountPattern, searchPos);
        continue;
      }

      // Get surrounding record context
      const recordStart = Math.max(0, idx - 1500);
      const recordEnd = Math.min(data.length, idx + 1500);
      const record = data.subarray(recordStart, recordEnd);

      // Extract all string fields
      const name = extractStringValue(record, fieldPattern('name'));
      const originalName = extractStringValue(record, fieldPattern('original_name'));
      const originalCleanName = extractStringValue(record, fieldPattern('original_clean_name'));
      const date = extractStringValue(record, fieldPattern('original_date'));
      const originalDate = extractStringValue(record, fieldPattern('original_date'));
      const categoryId = extractStringValue(record, fieldPattern('category_id'));
      const plaidCategoryId = extractStringValue(record, fieldPattern('plaid_category_id'));
      const categoryIdSource = extractStringValue(record, fieldPattern('category_id_source'));
      const accountId = extractStringValue(record, fieldPattern('account_id'));
      const itemId = extractStringValue(record, fieldPattern('item_id'));
      const userId = extractStringValue(record, fieldPattern('user_id'));
      const transactionId = extractStringValue(record, fieldPattern('transaction_id'));
      const pendingTransactionId = extractStringValue(
        record,
        fieldPattern('pending_transaction_id')
      );
      const isoCurrencyCode = extractStringValue(record, fieldPattern('iso_currency_code'));
      const transactionType = extractStringValue(record, fieldPattern('transaction_type'));
      const plaidTransactionType = extractStringValue(
        record,
        fieldPattern('plaid_transaction_type')
      );
      const paymentMethod = extractStringValue(record, fieldPattern('payment_method'));
      const paymentProcessor = extractStringValue(record, fieldPattern('payment_processor'));
      const city = extractStringValue(record, fieldPattern('city'));
      const region = extractStringValue(record, fieldPattern('region'));
      const address = extractStringValue(record, fieldPattern('address'));
      const postalCode = extractStringValue(record, fieldPattern('postal_code'));
      const country = extractStringValue(record, fieldPattern('country'));
      const referenceNumber = extractStringValue(record, fieldPattern('reference_number'));
      const ppdId = extractStringValue(record, fieldPattern('ppd_id'));
      const byOrderOf = extractStringValue(record, fieldPattern('by_order_of'));
      const fromInvestment = extractStringValue(record, fieldPattern('from_investment'));
      // Copilot type field: "internal_transfer", "income", "regular", etc.
      const copilotType = extractStringValue(record, fieldPattern('type'));

      // Extract boolean fields
      const pending = extractBooleanValue(record, fieldPattern('pending'));
      const excluded = extractBooleanValue(record, fieldPattern('excluded'));
      const userReviewed = extractBooleanValue(record, fieldPattern('user_reviewed'));
      const plaidDeleted = extractBooleanValue(record, fieldPattern('plaid_deleted'));
      const isAmazon = extractBooleanValue(record, fieldPattern('is_amazon'));
      const accountDashboardActive = extractBooleanValue(
        record,
        fieldPattern('account_dashboard_active')
      );

      // Extract numeric fields
      const originalAmount = extractDoubleField(record, fieldPattern('original_amount'));
      const lat = extractDoubleField(record, fieldPattern('lat'));
      const lon = extractDoubleField(record, fieldPattern('lon'));

      // Derive internal_transfer from copilot type
      const isInternalTransfer = copilotType === 'internal_transfer';

      // Use name or original_name as display name
      const displayName = name || originalName;

      if (displayName && transactionId && date) {
        try {
          // Build transaction object with all extracted fields
          const txnData: Record<string, string | number | boolean> = {
            transaction_id: transactionId,
            amount,
            date,
          };

          // String fields
          if (name) txnData.name = name;
          if (originalName) txnData.original_name = originalName;
          if (originalCleanName) txnData.original_clean_name = originalCleanName;
          if (accountId) txnData.account_id = accountId;
          if (itemId) txnData.item_id = itemId;
          if (userId) txnData.user_id = userId;
          if (categoryId) txnData.category_id = categoryId;
          if (plaidCategoryId) txnData.plaid_category_id = plaidCategoryId;
          if (categoryIdSource) txnData.category_id_source = categoryIdSource;
          if (originalDate) txnData.original_date = originalDate;
          if (pendingTransactionId) txnData.pending_transaction_id = pendingTransactionId;
          if (isoCurrencyCode) txnData.iso_currency_code = isoCurrencyCode;
          if (transactionType) txnData.transaction_type = transactionType;
          if (plaidTransactionType) txnData.plaid_transaction_type = plaidTransactionType;
          if (paymentMethod) txnData.payment_method = paymentMethod;
          if (paymentProcessor) txnData.payment_processor = paymentProcessor;
          if (city) txnData.city = city;
          if (region) txnData.region = region;
          if (address) txnData.address = address;
          if (postalCode) txnData.postal_code = postalCode;
          if (country) txnData.country = country;
          if (referenceNumber) txnData.reference_number = referenceNumber;
          if (ppdId) txnData.ppd_id = ppdId;
          if (byOrderOf) txnData.by_order_of = byOrderOf;
          if (fromInvestment) txnData.from_investment = fromInvestment;

          // Boolean fields
          if (pending !== null) txnData.pending = pending;
          if (excluded !== null) txnData.excluded = excluded;
          if (isInternalTransfer) txnData.internal_transfer = isInternalTransfer;
          if (userReviewed !== null) txnData.user_reviewed = userReviewed;
          if (plaidDeleted !== null) txnData.plaid_deleted = plaidDeleted;
          if (isAmazon !== null) txnData.is_amazon = isAmazon;
          if (accountDashboardActive !== null)
            txnData.account_dashboard_active = accountDashboardActive;

          // Numeric fields
          if (originalAmount !== null) txnData.original_amount = originalAmount;
          if (lat !== null) txnData.lat = lat;
          if (lon !== null) txnData.lon = lon;

          // Validate with Zod
          const txn = TransactionSchema.parse(txnData);
          transactions.push(txn);
        } catch {
          // Skip invalid transactions
        }
      }

      idx = data.indexOf(amountPattern, searchPos);
    }
  }

  // Deduplicate by (display_name, amount, date)
  const seen = new Set<string>();
  const unique: Transaction[] = [];

  for (const txn of transactions) {
    const displayName = getTransactionDisplayName(txn);
    const key = `${displayName}|${txn.amount}|${txn.date}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(txn);
    }
  }

  // Sort by date descending
  unique.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));

  return unique;
}

/**
 * Decode account information from LevelDB files.
 */
export function decodeAccounts(dbPath: string): Account[] {
  const accounts: Account[] = [];

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database path not found: ${dbPath}`);
  }

  const stat = fs.statSync(dbPath);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${dbPath}`);
  }

  // Get all .ldb files
  const files = fs.readdirSync(dbPath);
  const ldbFiles = files.filter((f) => f.endsWith('.ldb')).map((f) => path.join(dbPath, f));

  for (const filepath of ldbFiles) {
    const data = fs.readFileSync(filepath);

    if (!data.includes(Buffer.from('/accounts/'))) {
      continue;
    }

    // Find account records
    let searchPos = 0;
    const balancePattern = Buffer.from('current_balance');

    let idx = data.indexOf(balancePattern, searchPos);
    while (idx !== -1) {
      searchPos = idx + 1;

      // Use wider window to capture all account fields
      const recordStart = Math.max(0, idx - 2500);
      const recordEnd = Math.min(data.length, idx + 2500);
      const record = data.subarray(recordStart, recordEnd);

      // Calculate balance position within window based on original position
      const balanceIdx = idx - recordStart;
      const balance = extractDoubleValue(record, balanceIdx + 15);

      if (balance !== null) {
        // Search for fields after the balance position to avoid finding data from previous records
        const afterBalance = record.subarray(balanceIdx);

        const name = extractStringValue(afterBalance, fieldPattern('name'));
        const officialName = extractStringValue(afterBalance, fieldPattern('official_name'));
        const accountType = extractStringValue(afterBalance, fieldPattern('type'));
        const subtype = extractStringValue(afterBalance, fieldPattern('subtype'));
        const mask = extractStringValue(afterBalance, fieldPattern('mask'));
        const institutionName = extractStringValue(afterBalance, fieldPattern('institution_name'));

        // Additional account fields
        const itemId = extractStringValue(afterBalance, fieldPattern('item_id'));
        const availableBalance = extractDoubleField(
          afterBalance,
          fieldPattern('available_balance')
        );
        const isoCurrencyCode = extractStringValue(afterBalance, fieldPattern('iso_currency_code'));
        const institutionId = extractStringValue(afterBalance, fieldPattern('institution_id'));

        // Try account_id first, then fall back to 'id' field
        let accountId = extractStringValue(afterBalance, fieldPattern('account_id'));
        if (!accountId) {
          accountId = extractStringValue(afterBalance, fieldPattern('id'));
        }

        // If still no account ID, try extracting from /accounts/ path (search before balance)
        if (!accountId) {
          const beforeBalance = record.subarray(0, balanceIdx);
          const accountsPathIdx = beforeBalance.lastIndexOf(Buffer.from('/accounts/'));
          if (accountsPathIdx !== -1) {
            // Extract ID after /accounts/
            const afterPath = beforeBalance.subarray(accountsPathIdx + 10, accountsPathIdx + 60);
            const match = afterPath.toString('utf-8').match(/^([a-zA-Z0-9_-]+)/);
            // Only use as ID if it looks like a valid ID (not a field name)
            // Valid IDs are usually 20+ chars with mixed case/numbers
            if (match?.[1] && match[1].length >= 15 && /[A-Z]/.test(match[1])) {
              accountId = match[1];
            }
          }
        }

        if (accountId && (name || officialName)) {
          try {
            // Build account object with optional fields
            const accData: {
              account_id: string;
              current_balance: number;
              name?: string;
              official_name?: string;
              account_type?: string;
              subtype?: string;
              mask?: string;
              institution_name?: string;
              item_id?: string;
              available_balance?: number;
              iso_currency_code?: string;
              institution_id?: string;
            } = {
              account_id: accountId,
              current_balance: balance,
            };

            if (name) accData.name = name;
            if (officialName) accData.official_name = officialName;
            if (accountType) accData.account_type = accountType;
            if (subtype) accData.subtype = subtype;
            if (mask) accData.mask = mask;
            if (institutionName) accData.institution_name = institutionName;
            if (itemId) accData.item_id = itemId;
            if (availableBalance !== null) accData.available_balance = availableBalance;
            if (isoCurrencyCode) accData.iso_currency_code = isoCurrencyCode;
            if (institutionId) accData.institution_id = institutionId;

            // Validate with Zod
            const account = AccountSchema.parse(accData);
            accounts.push(account);
          } catch {
            // Skip invalid accounts
          }
        }
      }

      idx = data.indexOf(balancePattern, searchPos);
    }
  }

  // Deduplicate by (name, mask)
  const seen = new Set<string>();
  const unique: Account[] = [];

  for (const acc of accounts) {
    const displayName = getAccountDisplayName(acc);
    const key = `${displayName}|${acc.mask ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(acc);
    }
  }

  return unique;
}

/**
 * Decode recurring transactions from Copilot Money LevelDB files.
 *
 * Extracts subscription/recurring payment data from Copilot's native
 * /recurring/ Firestore collection.
 *
 * @param dbPath - Path to LevelDB database directory
 * @returns Array of recurring transactions
 */
export function decodeRecurring(dbPath: string): Recurring[] {
  const recurring: Recurring[] = [];

  // Return empty array if path doesn't exist (graceful degradation)
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const stat = fs.statSync(dbPath);
  if (!stat.isDirectory()) {
    return [];
  }

  // Configuration constants for record extraction
  const RECORD_WINDOW_BEFORE = 500; // Bytes to search before path marker
  const RECORD_WINDOW_AFTER = 2000; // Bytes to search after path marker
  const MIN_RECURRING_ID_LENGTH = 10; // Minimum length for valid Firestore document IDs

  // Get all .ldb files
  const files = fs.readdirSync(dbPath);
  const ldbFiles = files.filter((f) => f.endsWith('.ldb')).map((f) => path.join(dbPath, f));

  const recurringPathMarker = Buffer.from('/recurring/');

  for (const filepath of ldbFiles) {
    const data = fs.readFileSync(filepath);

    if (!data.includes(recurringPathMarker)) {
      continue;
    }

    // Find recurring records by searching for the path marker
    let searchPos = 0;
    let idx = data.indexOf(recurringPathMarker, searchPos);

    while (idx !== -1) {
      searchPos = idx + 1;

      // Use a window around the path marker to capture all fields
      const recordStart = Math.max(0, idx - RECORD_WINDOW_BEFORE);
      const recordEnd = Math.min(data.length, idx + RECORD_WINDOW_AFTER);
      const record = data.subarray(recordStart, recordEnd);

      // Try to extract recurring_id from the path (e.g., /recurring/{id})
      const pathIdx = idx - recordStart;
      const afterPath = record.subarray(pathIdx + recurringPathMarker.length, pathIdx + 100);
      const idMatch = afterPath.toString('utf-8').match(/^([a-zA-Z0-9_-]+)/);
      const recurringId = idMatch?.[1];

      if (recurringId && recurringId.length >= MIN_RECURRING_ID_LENGTH) {
        // Extract fields from the record
        const name = extractStringValue(record, fieldPattern('name'));
        const merchantName = extractStringValue(record, fieldPattern('merchant_name'));
        const amount = extractDoubleField(record, fieldPattern('amount'));
        const frequency = extractStringValue(record, fieldPattern('frequency'));
        const nextDate = extractStringValue(record, fieldPattern('next_date'));
        const lastDate = extractStringValue(record, fieldPattern('last_date'));
        const categoryId = extractStringValue(record, fieldPattern('category_id'));
        const accountId = extractStringValue(record, fieldPattern('account_id'));
        const isActive = extractBooleanValue(record, fieldPattern('is_active'));
        const isoCurrencyCode = extractStringValue(record, fieldPattern('iso_currency_code'));

        // Build recurring object
        const recData: {
          recurring_id: string;
          name?: string;
          merchant_name?: string;
          amount?: number;
          frequency?: string;
          next_date?: string;
          last_date?: string;
          category_id?: string;
          account_id?: string;
          is_active?: boolean;
          iso_currency_code?: string;
        } = {
          recurring_id: recurringId,
        };

        if (name) recData.name = name;
        if (merchantName) recData.merchant_name = merchantName;
        if (amount !== null) recData.amount = amount;
        if (frequency) recData.frequency = frequency;
        if (nextDate) recData.next_date = nextDate;
        if (lastDate) recData.last_date = lastDate;
        if (categoryId) recData.category_id = categoryId;
        if (accountId) recData.account_id = accountId;
        if (isActive !== null) recData.is_active = isActive;
        if (isoCurrencyCode) recData.iso_currency_code = isoCurrencyCode;

        try {
          const rec = RecurringSchema.parse(recData);
          recurring.push(rec);
        } catch (error) {
          // Skip invalid records - log in development for debugging
          if (process.env.NODE_ENV === 'development' || process.env.DEBUG) {
            console.warn('Skipping invalid recurring record:', error);
          }
        }
      }

      idx = data.indexOf(recurringPathMarker, searchPos);
    }
  }

  // Deduplicate by recurring_id
  const seen = new Set<string>();
  const unique: Recurring[] = [];

  for (const rec of recurring) {
    if (!seen.has(rec.recurring_id)) {
      seen.add(rec.recurring_id);
      unique.push(rec);
    }
  }

  return unique;
}

/**
 * Decode budgets from Copilot Money database.
 *
 * Extracts budget data from /budgets/ Firestore collection.
 * Returns empty array if database is unavailable (graceful degradation).
 *
 * @param dbPath - Path to LevelDB database directory
 * @returns Array of Budget objects
 */
export function decodeBudgets(dbPath: string): Budget[] {
  const budgets: Budget[] = [];

  // Return empty array if path doesn't exist (graceful degradation)
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const stat = fs.statSync(dbPath);
  if (!stat.isDirectory()) {
    return [];
  }

  // Configuration constants for record extraction
  const RECORD_WINDOW_BEFORE = 500; // Bytes to search before path marker
  const RECORD_WINDOW_AFTER = 2000; // Bytes to search after path marker
  const MIN_BUDGET_ID_LENGTH = 10; // Minimum length for valid Firestore document IDs

  // Get all .ldb files
  const files = fs.readdirSync(dbPath);
  const ldbFiles = files.filter((f) => f.endsWith('.ldb')).map((f) => path.join(dbPath, f));

  const budgetPathMarker = Buffer.from('/budgets/');

  for (const filepath of ldbFiles) {
    const data = fs.readFileSync(filepath);

    if (!data.includes(budgetPathMarker)) {
      continue;
    }

    // Find budget records by searching for the path marker
    let searchPos = 0;
    let idx = data.indexOf(budgetPathMarker, searchPos);

    while (idx !== -1) {
      searchPos = idx + 1;

      // Use a window around the path marker to capture all fields
      const recordStart = Math.max(0, idx - RECORD_WINDOW_BEFORE);
      const recordEnd = Math.min(data.length, idx + RECORD_WINDOW_AFTER);
      const record = data.subarray(recordStart, recordEnd);

      // Try to extract budget_id from the path (e.g., /budgets/{id})
      const pathIdx = idx - recordStart;
      const afterPath = record.subarray(pathIdx + budgetPathMarker.length, pathIdx + 100);
      const idMatch = afterPath.toString('utf-8').match(/^([a-zA-Z0-9_-]+)/);
      const budgetId = idMatch?.[1];

      if (budgetId && budgetId.length >= MIN_BUDGET_ID_LENGTH) {
        // Extract fields from the record
        const name = extractStringValue(record, fieldPattern('name'));
        const amount = extractDoubleField(record, fieldPattern('amount'));
        const period = extractStringValue(record, fieldPattern('period'));
        const categoryId = extractStringValue(record, fieldPattern('category_id'));
        const startDate = extractStringValue(record, fieldPattern('start_date'));
        const endDate = extractStringValue(record, fieldPattern('end_date'));
        const isActive = extractBooleanValue(record, fieldPattern('is_active'));
        const isoCurrencyCode = extractStringValue(record, fieldPattern('iso_currency_code'));

        // Build budget object
        const budgetData: {
          budget_id: string;
          name?: string;
          amount?: number;
          period?: string;
          category_id?: string;
          start_date?: string;
          end_date?: string;
          is_active?: boolean;
          iso_currency_code?: string;
        } = {
          budget_id: budgetId,
        };

        if (name) budgetData.name = name;
        if (amount !== null) budgetData.amount = amount;
        if (period) budgetData.period = period;
        if (categoryId) budgetData.category_id = categoryId;
        if (startDate) budgetData.start_date = startDate;
        if (endDate) budgetData.end_date = endDate;
        if (isActive !== null) budgetData.is_active = isActive;
        if (isoCurrencyCode) budgetData.iso_currency_code = isoCurrencyCode;

        try {
          const budget = BudgetSchema.parse(budgetData);
          budgets.push(budget);
        } catch (error) {
          // Skip invalid records - log in development for debugging
          if (process.env.NODE_ENV === 'development' || process.env.DEBUG) {
            console.warn('Skipping invalid budget record:', error);
          }
        }
      }

      idx = data.indexOf(budgetPathMarker, searchPos);
    }
  }

  // Deduplicate by budget_id
  const seen = new Set<string>();
  const unique: Budget[] = [];

  for (const budget of budgets) {
    if (!seen.has(budget.budget_id)) {
      seen.add(budget.budget_id);
      unique.push(budget);
    }
  }

  return unique;
}

/**
 * Decode financial goals from the Copilot Money database.
 *
 * Goals are stored in: /users/{user_id}/financial_goals/{goal_id}
 *
 * @param dbPath - Path to the LevelDB database directory
 * @returns Array of decoded Goal objects
 */
export function decodeGoals(dbPath: string): Goal[] {
  const goals: Goal[] = [];

  // Return empty array if path doesn't exist (graceful degradation)
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const stat = fs.statSync(dbPath);
  if (!stat.isDirectory()) {
    return [];
  }

  // Configuration constants for record extraction
  const RECORD_WINDOW_BEFORE = 500; // Bytes to search before path marker
  const RECORD_WINDOW_AFTER = 3000; // Bytes to search after path marker (larger for nested objects)
  const MIN_GOAL_ID_LENGTH = 10; // Minimum length for valid Firestore document IDs

  // Get all .ldb files
  const files = fs.readdirSync(dbPath);
  const ldbFiles = files.filter((f) => f.endsWith('.ldb')).map((f) => path.join(dbPath, f));

  // Goals are stored in Firestore under /users/{user_id}/financial_goals/{goal_id}
  // In LevelDB, we search for the financial_goals collection marker
  const goalPathMarker = Buffer.from('financial_goals/');

  for (const filepath of ldbFiles) {
    const data = fs.readFileSync(filepath);

    if (!data.includes(goalPathMarker)) {
      continue;
    }

    // Find goal records by searching for the path marker
    let searchPos = 0;
    let idx = data.indexOf(goalPathMarker, searchPos);

    while (idx !== -1) {
      searchPos = idx + 1;

      // Use a window around the path marker to capture all fields
      const recordStart = Math.max(0, idx - RECORD_WINDOW_BEFORE);
      const recordEnd = Math.min(data.length, idx + RECORD_WINDOW_AFTER);
      const record = data.subarray(recordStart, recordEnd);

      // Try to extract goal_id from the path (e.g., /financial_goals/{id})
      const pathIdx = idx - recordStart;
      const afterPath = record.subarray(pathIdx + goalPathMarker.length, pathIdx + 100);
      const idMatch = afterPath.toString('utf-8').match(/^([a-zA-Z0-9_-]+)/);
      const goalId = idMatch?.[1];

      if (goalId && goalId.length >= MIN_GOAL_ID_LENGTH) {
        // Extract user_id from the path (before /financial_goals/)
        const beforePath = record.subarray(0, pathIdx);
        const userIdMatch = beforePath
          .toString('utf-8')
          .match(/\/users\/([a-zA-Z0-9_-]+)\/financial_goals/);
        const userId = userIdMatch?.[1] ?? undefined;

        // IMPORTANT: Only search AFTER the goal ID to avoid picking up fields from adjacent documents
        // The goal document fields come after the path marker
        const afterGoalId = record.subarray(pathIdx + goalPathMarker.length + goalId.length);

        // Extract top-level fields from the document (after the goal ID)
        const name = extractStringValue(afterGoalId, fieldPattern('name'));
        const recommendationId = extractStringValue(afterGoalId, fieldPattern('recommendation_id'));
        const emoji = extractStringValue(afterGoalId, fieldPattern('emoji'));
        const createdDate = extractStringValue(afterGoalId, fieldPattern('created_date'));
        const createdWithAllocations = extractBooleanValue(
          afterGoalId,
          fieldPattern('created_with_allocations')
        );

        // Extract nested savings object fields (also from after the goal ID)
        const savingsType = extractStringValue(afterGoalId, fieldPattern('type'));
        const savingsStatus = extractStringValue(afterGoalId, fieldPattern('status'));
        const targetAmount = extractDoubleField(afterGoalId, fieldPattern('target_amount'));
        const trackingType = extractStringValue(afterGoalId, fieldPattern('tracking_type'));
        const monthlyContribution = extractDoubleField(
          afterGoalId,
          fieldPattern('tracking_type_monthly_contribution')
        );
        const startDate = extractStringValue(afterGoalId, fieldPattern('start_date'));
        const modifiedStartDate = extractBooleanValue(
          afterGoalId,
          fieldPattern('modified_start_date')
        );
        const inflatesBudget = extractBooleanValue(afterGoalId, fieldPattern('inflates_budget'));
        const isOngoing = extractBooleanValue(afterGoalId, fieldPattern('is_ongoing'));

        // Build goal object
        const goalData: {
          goal_id: string;
          user_id?: string;
          name?: string;
          recommendation_id?: string;
          emoji?: string;
          created_date?: string;
          created_with_allocations?: boolean;
          savings?: {
            type?: string;
            status?: string;
            target_amount?: number;
            tracking_type?: string;
            tracking_type_monthly_contribution?: number;
            start_date?: string;
            modified_start_date?: boolean;
            inflates_budget?: boolean;
            is_ongoing?: boolean;
          };
        } = {
          goal_id: goalId,
        };

        // Add optional top-level fields
        if (userId) goalData.user_id = userId;
        if (name) goalData.name = name;
        if (recommendationId) goalData.recommendation_id = recommendationId;
        if (emoji) goalData.emoji = emoji;
        if (createdDate) goalData.created_date = createdDate;
        if (createdWithAllocations !== null)
          goalData.created_with_allocations = createdWithAllocations;

        // Build nested savings object if any savings fields exist
        const hasSavingsFields =
          savingsType ||
          savingsStatus ||
          targetAmount !== null ||
          trackingType ||
          monthlyContribution !== null ||
          startDate ||
          modifiedStartDate !== null ||
          inflatesBudget !== null ||
          isOngoing !== null;

        if (hasSavingsFields) {
          goalData.savings = {};
          if (savingsType) goalData.savings.type = savingsType;
          if (savingsStatus) goalData.savings.status = savingsStatus;
          if (targetAmount !== null) goalData.savings.target_amount = targetAmount;
          if (trackingType) goalData.savings.tracking_type = trackingType;
          if (monthlyContribution !== null)
            goalData.savings.tracking_type_monthly_contribution = monthlyContribution;
          if (startDate) goalData.savings.start_date = startDate;
          if (modifiedStartDate !== null) goalData.savings.modified_start_date = modifiedStartDate;
          if (inflatesBudget !== null) goalData.savings.inflates_budget = inflatesBudget;
          if (isOngoing !== null) goalData.savings.is_ongoing = isOngoing;
        }

        try {
          const goal = GoalSchema.parse(goalData);
          goals.push(goal);
        } catch (error) {
          // Skip invalid records - log in development for debugging
          if (process.env.NODE_ENV === 'development' || process.env.DEBUG) {
            console.warn('Skipping invalid goal record:', error);
          }
        }
      }

      idx = data.indexOf(goalPathMarker, searchPos);
    }
  }

  // Deduplicate by goal_id
  const seen = new Set<string>();
  const unique: Goal[] = [];

  for (const goal of goals) {
    if (!seen.has(goal.goal_id)) {
      seen.add(goal.goal_id);
      unique.push(goal);
    }
  }

  return unique;
}

/**
 * Decode financial goal history from the Copilot Money database.
 *
 * Goal history is stored in subcollection:
 * /users/{user_id}/financial_goals/{goal_id}/financial_goal_history/{month}
 *
 * Each document represents a monthly snapshot with:
 * - current_amount: Amount saved as of that month
 * - daily_data: Nested object with daily snapshots
 * - contributions: Array of deposits/withdrawals
 *
 * @param dbPath - Path to the LevelDB database directory
 * @param goalId - Optional goal ID to filter history for a specific goal
 * @returns Array of decoded GoalHistory objects
 */
export function decodeGoalHistory(dbPath: string, goalId?: string): GoalHistory[] {
  const histories: GoalHistory[] = [];

  // Return empty array if path doesn't exist (graceful degradation)
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const stat = fs.statSync(dbPath);
  if (!stat.isDirectory()) {
    return [];
  }

  // Configuration constants for record extraction
  const RECORD_WINDOW_BEFORE = 500; // Bytes to search before path marker
  const RECORD_WINDOW_AFTER = 5000; // Larger window for daily_data nested objects
  const MIN_MONTH_LENGTH = 7; // YYYY-MM format

  // Get all .ldb files
  const files = fs.readdirSync(dbPath);
  const ldbFiles = files.filter((f) => f.endsWith('.ldb')).map((f) => path.join(dbPath, f));

  // Goal history is in subcollection: financial_goal_history
  const historyPathMarker = Buffer.from('financial_goal_history/');

  for (const filepath of ldbFiles) {
    const data = fs.readFileSync(filepath);

    if (!data.includes(historyPathMarker)) {
      continue;
    }

    // Find history records by searching for the path marker
    let searchPos = 0;
    let idx = data.indexOf(historyPathMarker, searchPos);

    while (idx !== -1) {
      searchPos = idx + 1;

      // Use a window around the path marker to capture all fields
      const recordStart = Math.max(0, idx - RECORD_WINDOW_BEFORE);
      const recordEnd = Math.min(data.length, idx + RECORD_WINDOW_AFTER);
      const record = data.subarray(recordStart, recordEnd);

      // Try to extract month (document ID) from the path
      // Path format: /financial_goals/{goal_id}/financial_goal_history/{month}
      const pathIdx = idx - recordStart;
      const afterPath = record.subarray(pathIdx + historyPathMarker.length, pathIdx + 100);
      const monthMatch = afterPath.toString('utf-8').match(/^(\d{4}-\d{2})/);
      const month = monthMatch?.[1];

      if (month && month.length >= MIN_MONTH_LENGTH) {
        // Extract goal_id from before the history marker
        const beforePath = record.subarray(0, pathIdx);
        const goalIdMatch = beforePath
          .toString('utf-8')
          .match(/financial_goals\/([a-zA-Z0-9_-]+)\/financial_goal_history/);
        const extractedGoalId = goalIdMatch?.[1];

        // If filtering by goalId, skip if doesn't match
        if (goalId && extractedGoalId !== goalId) {
          idx = data.indexOf(historyPathMarker, searchPos);
          continue;
        }

        // Extract user_id from the path (before /financial_goals/)
        const userIdMatch = beforePath
          .toString('utf-8')
          .match(/\/users\/([a-zA-Z0-9_-]+)\/financial_goals/);
        const userId = userIdMatch?.[1] ?? undefined;

        // Only search AFTER the month ID to avoid picking up fields from adjacent documents
        const afterMonthId = record.subarray(pathIdx + historyPathMarker.length + month.length);

        // Extract top-level fields
        const currentAmount = extractDoubleField(afterMonthId, fieldPattern('current_amount'));
        const targetAmount = extractDoubleField(afterMonthId, fieldPattern('target_amount'));
        const lastUpdated = extractStringValue(afterMonthId, fieldPattern('last_updated'));
        const createdDate = extractStringValue(afterMonthId, fieldPattern('created_date'));

        // Extract daily_data nested object
        // This is more complex - daily_data is a map: { "YYYY-MM-DD": { amount: number, ... }, ... }
        const dailyData: Record<string, DailySnapshot> = {};

        // Look for date patterns in the record (YYYY-MM-DD format)
        const datePattern = /(\d{4}-\d{2}-\d{2})/g;
        const recordStr = afterMonthId.toString('utf-8', 0, Math.min(4000, afterMonthId.length));
        let dateMatch;

        while ((dateMatch = datePattern.exec(recordStr)) !== null) {
          const date = dateMatch[1];
          // Only include dates from this month
          if (date && date.startsWith(month)) {
            // Try to find amount associated with this date
            const dateIdx = afterMonthId.indexOf(Buffer.from(date));
            if (dateIdx !== -1) {
              const afterDate = afterMonthId.subarray(dateIdx, dateIdx + 100);
              const amount = extractDoubleValue(afterDate, 0, 50);
              if (amount !== null) {
                dailyData[date] = { amount, date };
              }
            }
          }
        }

        // Build goal history object
        const historyData: {
          month: string;
          goal_id: string;
          user_id?: string;
          current_amount?: number;
          target_amount?: number;
          daily_data?: Record<string, DailySnapshot>;
          last_updated?: string;
          created_date?: string;
        } = {
          month,
          goal_id: extractedGoalId || 'unknown',
        };

        if (userId) historyData.user_id = userId;
        if (currentAmount !== null) historyData.current_amount = currentAmount;
        if (targetAmount !== null) historyData.target_amount = targetAmount;
        if (Object.keys(dailyData).length > 0) historyData.daily_data = dailyData;
        if (lastUpdated) historyData.last_updated = lastUpdated;
        if (createdDate) historyData.created_date = createdDate;

        try {
          const history = GoalHistorySchema.parse(historyData);
          histories.push(history);
        } catch (error) {
          // Skip invalid records - log in development for debugging
          if (process.env.NODE_ENV === 'development' || process.env.DEBUG) {
            console.warn('Skipping invalid goal history record:', error);
          }
        }
      }

      idx = data.indexOf(historyPathMarker, searchPos);
    }
  }

  // Deduplicate by goal_id + month
  const seen = new Set<string>();
  const unique: GoalHistory[] = [];

  for (const history of histories) {
    const key = `${history.goal_id}:${history.month}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(history);
    }
  }

  // Sort by goal_id and then by month (newest first)
  unique.sort((a, b) => {
    if (a.goal_id !== b.goal_id) {
      return a.goal_id.localeCompare(b.goal_id);
    }
    return b.month.localeCompare(a.month); // Newest first
  });

  return unique;
}
/**
 * Decode investment prices from the Copilot Money database.
 *
 * Investment prices are stored in collection:
 * /investment_prices/{hash}/daily/{month}  (historical monthly data)
 * /investment_prices/{hash}/hf/{date}      (high-frequency intraday data)
 *
 * Each document contains price information for stocks, crypto, ETFs, etc.
 * The hash is typically a SHA-256 hash (64 hex chars) or shorter ID.
 *
 * @param dbPath - Path to the LevelDB database directory
 * @param options - Filter options
 * @returns Array of decoded InvestmentPrice objects
 */
export function decodeInvestmentPrices(
  dbPath: string,
  options: {
    tickerSymbol?: string;
    startDate?: string; // YYYY-MM or YYYY-MM-DD
    endDate?: string; // YYYY-MM or YYYY-MM-DD
    priceType?: 'daily' | 'hf';
  } = {}
): InvestmentPrice[] {
  const prices: InvestmentPrice[] = [];
  const { tickerSymbol, startDate, endDate, priceType } = options;

  // Return empty array if path doesn't exist (graceful degradation)
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const stat = fs.statSync(dbPath);
  if (!stat.isDirectory()) {
    return [];
  }

  // Configuration constants for record extraction
  const RECORD_WINDOW_BEFORE = 500; // Bytes to search before path marker
  const RECORD_WINDOW_AFTER = 2000; // Bytes to search after investment ID
  const MIN_HASH_LENGTH = 20; // Minimum length for investment ID

  // Get all .ldb files
  const files = fs.readdirSync(dbPath);
  const ldbFiles = files.filter((f) => f.endsWith('.ldb')).map((f) => path.join(dbPath, f));

  // Investment prices are in: /investment_prices/{hash}/daily/{month} or /hf/{date}
  const pricePathMarker = Buffer.from('investment_prices');
  const dailyMarker = Buffer.from('/daily/');
  const hfMarker = Buffer.from('/hf/');

  for (const filepath of ldbFiles) {
    const data = fs.readFileSync(filepath);

    if (!data.includes(pricePathMarker)) {
      continue;
    }

    // Find price records by searching for the path marker
    let searchPos = 0;
    let idx = data.indexOf(pricePathMarker, searchPos);

    while (idx !== -1) {
      searchPos = idx + 1;

      // Use a window around the path marker to capture all fields
      const recordStart = Math.max(0, idx - RECORD_WINDOW_BEFORE);
      const recordEnd = Math.min(data.length, idx + pricePathMarker.length + 200);
      const record = data.subarray(recordStart, recordEnd);

      // Try to extract investment ID (hash) from the path
      // Path format: /investment_prices/{hash}/daily/{month} or /hf/{date}
      const pathIdx = idx - recordStart;
      const afterPath = record.subarray(pathIdx + pricePathMarker.length, pathIdx + 200);

      // Look for hash after investment_prices/ - SHA-256 (64 hex) or shorter IDs (20+)
      const hashMatch = afterPath.toString('utf-8').match(/^\/([a-f0-9]{64}|[a-zA-Z0-9_-]{20,})/);
      const investmentId = hashMatch?.[1];

      if (!investmentId || investmentId.length < MIN_HASH_LENGTH) {
        idx = data.indexOf(pricePathMarker, searchPos);
        continue;
      }

      // Determine if this is daily or high-frequency data
      const isDailyData = record.includes(dailyMarker);
      const isHfData = record.includes(hfMarker);

      // Skip if filtering by price type
      if (priceType === 'daily' && !isDailyData) {
        idx = data.indexOf(pricePathMarker, searchPos);
        continue;
      }
      if (priceType === 'hf' && !isHfData) {
        idx = data.indexOf(pricePathMarker, searchPos);
        continue;
      }

      // Expand search window for price fields
      const extendedEnd = Math.min(
        data.length,
        idx + pricePathMarker.length + investmentId.length + RECORD_WINDOW_AFTER
      );
      const extendedRecord = data.subarray(
        idx + pricePathMarker.length + investmentId.length,
        extendedEnd
      );

      // Extract ticker symbol if present
      const ticker = extractStringValue(extendedRecord, fieldPattern('ticker_symbol'));

      // Skip if filtering by ticker and doesn't match
      if (tickerSymbol && ticker !== tickerSymbol) {
        idx = data.indexOf(pricePathMarker, searchPos);
        continue;
      }

      // Extract date/month based on data type
      let date: string | undefined;
      let month: string | undefined;

      if (isDailyData) {
        month = extractStringValue(extendedRecord, fieldPattern('month')) ?? undefined;
      } else if (isHfData) {
        date = extractStringValue(extendedRecord, fieldPattern('date')) ?? undefined;
      }

      // Apply date range filters
      const recordDate = date ?? month;
      if (recordDate) {
        if (startDate && recordDate < startDate) {
          idx = data.indexOf(pricePathMarker, searchPos);
          continue;
        }
        if (endDate && recordDate > endDate) {
          idx = data.indexOf(pricePathMarker, searchPos);
          continue;
        }
      }

      // Extract price fields (multiple types available)
      const price = extractDoubleField(extendedRecord, fieldPattern('price'));
      const closePrice = extractDoubleField(extendedRecord, fieldPattern('close_price'));
      const currentPrice = extractDoubleField(extendedRecord, fieldPattern('current_price'));
      const institutionPrice = extractDoubleField(
        extendedRecord,
        fieldPattern('institution_price')
      );

      // Extract OHLCV data
      const high = extractDoubleField(extendedRecord, fieldPattern('high'));
      const low = extractDoubleField(extendedRecord, fieldPattern('low'));
      const open = extractDoubleField(extendedRecord, fieldPattern('open'));
      const volume = extractDoubleField(extendedRecord, fieldPattern('volume'));

      // Extract metadata
      const currency = extractStringValue(extendedRecord, fieldPattern('currency'));
      const source = extractStringValue(extendedRecord, fieldPattern('source'));
      const closePriceAsOf = extractStringValue(extendedRecord, fieldPattern('close_price_as_of'));

      // Build price object
      const priceData: {
        investment_id: string;
        ticker_symbol?: string;
        price?: number;
        close_price?: number;
        current_price?: number;
        institution_price?: number;
        date?: string;
        month?: string;
        close_price_as_of?: string;
        high?: number;
        low?: number;
        open?: number;
        volume?: number;
        currency?: string;
        source?: string;
        price_type?: string;
      } = {
        investment_id: investmentId,
      };

      if (ticker) priceData.ticker_symbol = ticker;
      if (price !== null) priceData.price = price;
      if (closePrice !== null) priceData.close_price = closePrice;
      if (currentPrice !== null) priceData.current_price = currentPrice;
      if (institutionPrice !== null) priceData.institution_price = institutionPrice;
      if (date) priceData.date = date;
      if (month) priceData.month = month;
      if (closePriceAsOf) priceData.close_price_as_of = closePriceAsOf;
      if (high !== null) priceData.high = high;
      if (low !== null) priceData.low = low;
      if (open !== null) priceData.open = open;
      if (volume !== null) priceData.volume = volume;
      if (currency) priceData.currency = currency;
      if (source) priceData.source = source;
      priceData.price_type = isDailyData ? 'daily' : 'hf';

      // Validate and add to results
      const validated = InvestmentPriceSchema.safeParse(priceData);
      if (validated.success) {
        prices.push(validated.data);
      }

      idx = data.indexOf(pricePathMarker, searchPos);
    }
  }

  // Deduplicate by investment_id + date/month combination
  const seen = new Set<string>();
  const unique: InvestmentPrice[] = [];

  for (const price of prices) {
    const key = `${price.investment_id}-${price.date || price.month || 'unknown'}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(price);
    }
  }

  // Sort by investment_id, then by date/month (newest first)
  unique.sort((a, b) => {
    if (a.investment_id !== b.investment_id) {
      return a.investment_id.localeCompare(b.investment_id);
    }
    const dateA = a.date || a.month || '';
    const dateB = b.date || b.month || '';
    return dateB.localeCompare(dateA); // Newest first
  });

  return unique;
}

/**
 * Decode investment splits from the Copilot Money database.
 *
 * Investment splits are stored in collection:
 * /investment_splits/{split_id}
 *
 * Each document contains split information for stocks/ETFs including:
 * - ticker_symbol: Stock ticker (e.g., "AAPL", "TSLA")
 * - split_date: Date of the split (YYYY-MM-DD)
 * - split_ratio: Ratio string (e.g., "4:1", "2:1")
 * - to_factor/from_factor: Numeric split factors
 * - multiplier: Calculated multiplier (to_factor / from_factor)
 *
 * @param dbPath - Path to the LevelDB database directory
 * @param options - Filter options
 * @returns Array of decoded InvestmentSplit objects
 */
export function decodeInvestmentSplits(
  dbPath: string,
  options: {
    tickerSymbol?: string;
    startDate?: string; // YYYY-MM-DD
    endDate?: string; // YYYY-MM-DD
  } = {}
): InvestmentSplit[] {
  const splits: InvestmentSplit[] = [];
  const { tickerSymbol, startDate, endDate } = options;

  // Return empty array if path doesn't exist (graceful degradation)
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const stat = fs.statSync(dbPath);
  if (!stat.isDirectory()) {
    return [];
  }

  // Configuration constants for record extraction
  const RECORD_WINDOW_BEFORE = 500; // Bytes to search before path marker
  const RECORD_WINDOW_AFTER = 1500; // Bytes to search after path marker
  const MIN_SPLIT_ID_LENGTH = 10; // Minimum length for valid Firestore document IDs

  // Get all .ldb files
  const files = fs.readdirSync(dbPath);
  const ldbFiles = files.filter((f) => f.endsWith('.ldb')).map((f) => path.join(dbPath, f));

  // Investment splits are in: /investment_splits/{split_id}
  const splitPathMarker = Buffer.from('investment_splits/');

  for (const filepath of ldbFiles) {
    const data = fs.readFileSync(filepath);

    if (!data.includes(splitPathMarker)) {
      continue;
    }

    // Find split records by searching for the path marker
    let searchPos = 0;
    let idx = data.indexOf(splitPathMarker, searchPos);

    while (idx !== -1) {
      searchPos = idx + 1;

      // Use a window around the path marker to capture all fields
      const recordStart = Math.max(0, idx - RECORD_WINDOW_BEFORE);
      const recordEnd = Math.min(data.length, idx + RECORD_WINDOW_AFTER);
      const record = data.subarray(recordStart, recordEnd);

      // Try to extract split_id from the path (e.g., /investment_splits/{id})
      const pathIdx = idx - recordStart;
      const afterPath = record.subarray(pathIdx + splitPathMarker.length, pathIdx + 100);
      const idMatch = afterPath.toString('utf-8').match(/^([a-zA-Z0-9_-]+)/);
      const splitId = idMatch?.[1];

      if (splitId && splitId.length >= MIN_SPLIT_ID_LENGTH) {
        // Only search AFTER the split ID to avoid picking up fields from adjacent documents
        const afterSplitId = record.subarray(pathIdx + splitPathMarker.length + splitId.length);

        // Extract fields from the record
        const ticker = extractStringValue(afterSplitId, fieldPattern('ticker_symbol'));
        const splitDate = extractStringValue(afterSplitId, fieldPattern('split_date'));
        const splitRatio = extractStringValue(afterSplitId, fieldPattern('split_ratio'));
        const investmentId = extractStringValue(afterSplitId, fieldPattern('investment_id'));

        // Extract numeric factors
        const fromFactor = extractDoubleField(afterSplitId, fieldPattern('from_factor'));
        const toFactor = extractDoubleField(afterSplitId, fieldPattern('to_factor'));
        const multiplier = extractDoubleField(afterSplitId, fieldPattern('multiplier'));

        // Extract additional metadata
        const announcementDate = extractStringValue(
          afterSplitId,
          fieldPattern('announcement_date')
        );
        const recordDate = extractStringValue(afterSplitId, fieldPattern('record_date'));
        const exDate = extractStringValue(afterSplitId, fieldPattern('ex_date'));
        const description = extractStringValue(afterSplitId, fieldPattern('description'));
        const source = extractStringValue(afterSplitId, fieldPattern('source'));

        // Skip if filtering by ticker and doesn't match
        if (tickerSymbol && ticker !== tickerSymbol) {
          idx = data.indexOf(splitPathMarker, searchPos);
          continue;
        }

        // Apply date range filters
        if (splitDate) {
          if (startDate && splitDate < startDate) {
            idx = data.indexOf(splitPathMarker, searchPos);
            continue;
          }
          if (endDate && splitDate > endDate) {
            idx = data.indexOf(splitPathMarker, searchPos);
            continue;
          }
        }

        // Build split object
        const splitData: {
          split_id: string;
          ticker_symbol?: string;
          investment_id?: string;
          split_date?: string;
          split_ratio?: string;
          from_factor?: number;
          to_factor?: number;
          multiplier?: number;
          announcement_date?: string;
          record_date?: string;
          ex_date?: string;
          description?: string;
          source?: string;
        } = {
          split_id: splitId,
        };

        if (ticker) splitData.ticker_symbol = ticker;
        if (investmentId) splitData.investment_id = investmentId;
        if (splitDate) splitData.split_date = splitDate;
        if (splitRatio) splitData.split_ratio = splitRatio;
        if (fromFactor !== null) splitData.from_factor = fromFactor;
        if (toFactor !== null) splitData.to_factor = toFactor;
        if (multiplier !== null) splitData.multiplier = multiplier;
        if (announcementDate) splitData.announcement_date = announcementDate;
        if (recordDate) splitData.record_date = recordDate;
        if (exDate) splitData.ex_date = exDate;
        if (description) splitData.description = description;
        if (source) splitData.source = source;

        // Validate and add to results
        const validated = InvestmentSplitSchema.safeParse(splitData);
        if (validated.success) {
          splits.push(validated.data);
        }
      }

      idx = data.indexOf(splitPathMarker, searchPos);
    }
  }

  // Deduplicate by split_id
  const seen = new Set<string>();
  const unique: InvestmentSplit[] = [];

  for (const split of splits) {
    if (!seen.has(split.split_id)) {
      seen.add(split.split_id);
      unique.push(split);
    }
  }

  // Sort by ticker_symbol, then by split_date (newest first)
  unique.sort((a, b) => {
    const tickerA = a.ticker_symbol || '';
    const tickerB = b.ticker_symbol || '';
    if (tickerA !== tickerB) {
      return tickerA.localeCompare(tickerB);
    }
    const dateA = a.split_date || '';
    const dateB = b.split_date || '';
    return dateB.localeCompare(dateA); // Newest first
  });

  return unique;
}

/**
 * Decode Plaid items (institution connections) from the Copilot Money database.
 *
 * Items are stored in collection:
 * /users/{user_id}/items/{item_id}
 *
 * Each document represents a connection to a financial institution via Plaid,
 * including connection status, error information, and linked accounts.
 *
 * @param dbPath - Path to the LevelDB database directory
 * @param options - Filter options
 * @returns Array of decoded Item objects
 */
export function decodeItems(
  dbPath: string,
  options: {
    connectionStatus?: string;
    institutionId?: string;
    needsUpdate?: boolean;
  } = {}
): Item[] {
  const items: Item[] = [];
  const { connectionStatus, institutionId, needsUpdate } = options;

  // Return empty array if path doesn't exist (graceful degradation)
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const stat = fs.statSync(dbPath);
  if (!stat.isDirectory()) {
    return [];
  }

  // Configuration constants for record extraction
  const RECORD_WINDOW_BEFORE = 500; // Bytes to search before path marker
  const RECORD_WINDOW_AFTER = 2000; // Bytes to search after path marker
  const MIN_ITEM_ID_LENGTH = 10; // Minimum length for valid Firestore document IDs

  // Get all .ldb files
  const files = fs.readdirSync(dbPath);
  const ldbFiles = files.filter((f) => f.endsWith('.ldb')).map((f) => path.join(dbPath, f));

  // Items are in: /users/{user_id}/items/{item_id}
  const itemPathMarker = Buffer.from('/items/');

  for (const filepath of ldbFiles) {
    const data = fs.readFileSync(filepath);

    if (!data.includes(itemPathMarker)) {
      continue;
    }

    // Find item records by searching for the path marker
    let searchPos = 0;
    let idx = data.indexOf(itemPathMarker, searchPos);

    while (idx !== -1) {
      searchPos = idx + 1;

      // Use a window around the path marker to capture all fields
      const recordStart = Math.max(0, idx - RECORD_WINDOW_BEFORE);
      const recordEnd = Math.min(data.length, idx + RECORD_WINDOW_AFTER);
      const record = data.subarray(recordStart, recordEnd);

      // Try to extract item_id from the path (e.g., /items/{id})
      const pathIdx = idx - recordStart;
      const afterPath = record.subarray(pathIdx + itemPathMarker.length, pathIdx + 100);
      const idMatch = afterPath.toString('utf-8').match(/^([a-zA-Z0-9_-]+)/);
      const itemId = idMatch?.[1];

      if (itemId && itemId.length >= MIN_ITEM_ID_LENGTH) {
        // Extract user_id from before /items/
        const beforePath = record.subarray(0, pathIdx);
        const userIdMatch = beforePath.toString('utf-8').match(/\/users\/([a-zA-Z0-9_-]+)\/items/);
        const userId = userIdMatch?.[1] ?? undefined;

        // Only search AFTER the item ID to avoid picking up fields from adjacent documents
        const afterItemId = record.subarray(pathIdx + itemPathMarker.length + itemId.length);

        // Extract institution fields
        const instId = extractStringValue(afterItemId, fieldPattern('institution_id'));
        const instName = extractStringValue(afterItemId, fieldPattern('institution_name'));

        // Extract connection status fields
        const status = extractStringValue(afterItemId, fieldPattern('connection_status'));
        const lastSuccessfulUpdate = extractStringValue(
          afterItemId,
          fieldPattern('last_successful_update')
        );
        const lastFailedUpdate = extractStringValue(
          afterItemId,
          fieldPattern('last_failed_update')
        );
        const consentExpiration = extractStringValue(
          afterItemId,
          fieldPattern('consent_expiration_time')
        );

        // Extract error fields
        const errorCode = extractStringValue(afterItemId, fieldPattern('error_code'));
        const errorMessage = extractStringValue(afterItemId, fieldPattern('error_message'));
        const errorType = extractStringValue(afterItemId, fieldPattern('error_type'));
        const needsUpdateFlag = extractBooleanValue(afterItemId, fieldPattern('needs_update'));

        // Extract metadata
        const createdAt = extractStringValue(afterItemId, fieldPattern('created_at'));
        const updatedAt = extractStringValue(afterItemId, fieldPattern('updated_at'));
        const webhook = extractStringValue(afterItemId, fieldPattern('webhook'));

        // Apply filters
        if (connectionStatus && status !== connectionStatus) {
          idx = data.indexOf(itemPathMarker, searchPos);
          continue;
        }

        if (institutionId && instId !== institutionId) {
          idx = data.indexOf(itemPathMarker, searchPos);
          continue;
        }

        if (needsUpdate !== undefined && needsUpdateFlag !== needsUpdate) {
          idx = data.indexOf(itemPathMarker, searchPos);
          continue;
        }

        // Build item object
        const itemData: {
          item_id: string;
          user_id?: string;
          institution_id?: string;
          institution_name?: string;
          connection_status?: string;
          last_successful_update?: string;
          last_failed_update?: string;
          consent_expiration_time?: string;
          error_code?: string;
          error_message?: string;
          error_type?: string;
          needs_update?: boolean;
          created_at?: string;
          updated_at?: string;
          webhook?: string;
        } = {
          item_id: itemId,
        };

        if (userId) itemData.user_id = userId;
        if (instId) itemData.institution_id = instId;
        if (instName) itemData.institution_name = instName;
        if (status) itemData.connection_status = status;
        if (lastSuccessfulUpdate) itemData.last_successful_update = lastSuccessfulUpdate;
        if (lastFailedUpdate) itemData.last_failed_update = lastFailedUpdate;
        if (consentExpiration) itemData.consent_expiration_time = consentExpiration;
        if (errorCode) itemData.error_code = errorCode;
        if (errorMessage) itemData.error_message = errorMessage;
        if (errorType) itemData.error_type = errorType;
        if (needsUpdateFlag !== null) itemData.needs_update = needsUpdateFlag;
        if (createdAt) itemData.created_at = createdAt;
        if (updatedAt) itemData.updated_at = updatedAt;
        if (webhook) itemData.webhook = webhook;

        // Validate and add to results
        const validated = ItemSchema.safeParse(itemData);
        if (validated.success) {
          items.push(validated.data);
        }
      }

      idx = data.indexOf(itemPathMarker, searchPos);
    }
  }

  // Deduplicate by item_id
  const seen = new Set<string>();
  const unique: Item[] = [];

  for (const item of items) {
    if (!seen.has(item.item_id)) {
      seen.add(item.item_id);
      unique.push(item);
    }
  }

  // Sort by institution_name, then by item_id
  unique.sort((a, b) => {
    const nameA = a.institution_name || '';
    const nameB = b.institution_name || '';
    if (nameA !== nameB) {
      return nameA.localeCompare(nameB);
    }
    return a.item_id.localeCompare(b.item_id);
  });

  return unique;
}

/**
 * Decode user-defined categories from the Copilot Money database.
 *
 * Categories are stored in collection:
 * /users/{user_id}/categories/{category_id}
 *
 * Each document contains category information including:
 * - name: Human-readable category name (e.g., "Restaurants", "Groceries")
 * - emoji: Icon for display
 * - color/bg_color: Display colors
 * - parent_category_id: For hierarchical categories
 * - plaid_category_ids: Links to standard Plaid categories
 *
 * @param dbPath - Path to the LevelDB database directory
 * @returns Array of decoded Category objects
 */
export function decodeCategories(dbPath: string): Category[] {
  const categories: Category[] = [];

  const isDebug = process.env.NODE_ENV === 'development' || process.env.DEBUG;

  // Return empty array if path doesn't exist (graceful degradation)
  if (!fs.existsSync(dbPath)) {
    if (isDebug) {
      console.warn(`[decodeCategories] Database path does not exist: ${dbPath}`);
    }
    return [];
  }

  let stat;
  try {
    stat = fs.statSync(dbPath);
  } catch (error) {
    if (isDebug) {
      console.warn(`[decodeCategories] Failed to stat database path: ${dbPath}`, error);
    }
    return [];
  }

  if (!stat.isDirectory()) {
    if (isDebug) {
      console.warn(`[decodeCategories] Path is not a directory: ${dbPath}`);
    }
    return [];
  }

  // Configuration constants for record extraction
  const RECORD_WINDOW_BEFORE = 500; // Bytes to search before path marker
  const RECORD_WINDOW_AFTER = 2000; // Bytes to search after path marker
  const MIN_CATEGORY_ID_LENGTH = 15; // Minimum length for valid Firestore document IDs

  // Get all .ldb files
  let files;
  try {
    files = fs.readdirSync(dbPath);
  } catch (error) {
    if (isDebug) {
      console.warn(`[decodeCategories] Failed to read directory: ${dbPath}`, error);
    }
    return [];
  }
  const ldbFiles = files.filter((f) => f.endsWith('.ldb')).map((f) => path.join(dbPath, f));

  // Categories are in: /users/{user_id}/categories/{category_id}
  const categoryPathMarker = Buffer.from('/categories/');

  for (const filepath of ldbFiles) {
    let data;
    try {
      data = fs.readFileSync(filepath);
    } catch (error) {
      if (isDebug) {
        console.warn(`[decodeCategories] Failed to read file: ${filepath}`, error);
      }
      continue;
    }

    if (!data.includes(categoryPathMarker)) {
      continue;
    }

    // Find category records by searching for the path marker
    let searchPos = 0;
    let idx = data.indexOf(categoryPathMarker, searchPos);

    while (idx !== -1) {
      searchPos = idx + 1;

      // Use a window around the path marker to capture all fields
      const recordStart = Math.max(0, idx - RECORD_WINDOW_BEFORE);
      const recordEnd = Math.min(data.length, idx + RECORD_WINDOW_AFTER);
      const record = data.subarray(recordStart, recordEnd);

      // Try to extract category_id from the path (e.g., /categories/{id})
      const pathIdx = idx - recordStart;
      const afterPath = record.subarray(pathIdx + categoryPathMarker.length, pathIdx + 100);
      const idMatch = afterPath.toString('utf-8').match(/^([a-zA-Z0-9_-]+)/);
      const categoryId = idMatch?.[1];

      // Skip if this looks like a subcollection path (e.g., /categories/xxx/something)
      // We want the actual category documents, not nested paths
      if (categoryId && categoryId.length >= MIN_CATEGORY_ID_LENGTH) {
        // Extract user_id from before /categories/
        const beforePath = record.subarray(0, pathIdx);
        const userIdMatch = beforePath
          .toString('utf-8')
          .match(/\/users\/([a-zA-Z0-9_-]+)\/categories/);
        const userId = userIdMatch?.[1] ?? undefined;

        // Only search AFTER the category ID to avoid picking up fields from adjacent documents
        const afterCategoryId = record.subarray(
          pathIdx + categoryPathMarker.length + categoryId.length
        );

        // Extract fields from the record
        const name = extractStringValue(afterCategoryId, fieldPattern('name'));
        const emoji = extractStringValue(afterCategoryId, fieldPattern('emoji'));
        const color = extractStringValue(afterCategoryId, fieldPattern('color'));
        const bgColor = extractStringValue(afterCategoryId, fieldPattern('bg_color'));
        const parentCategoryId = extractStringValue(
          afterCategoryId,
          fieldPattern('parent_category_id')
        );

        // Extract boolean fields
        const excluded = extractBooleanValue(afterCategoryId, fieldPattern('excluded'));
        const isOther = extractBooleanValue(afterCategoryId, fieldPattern('is_other'));
        const autoBudgetLock = extractBooleanValue(
          afterCategoryId,
          fieldPattern('auto_budget_lock')
        );
        const autoDeleteLock = extractBooleanValue(
          afterCategoryId,
          fieldPattern('auto_delete_lock')
        );

        // Extract order (numeric)
        const order = extractDoubleField(afterCategoryId, fieldPattern('order'));

        // Build category object - only include if we have a name
        // (categories without names are not useful for display)
        if (name) {
          const categoryData: {
            category_id: string;
            name?: string;
            emoji?: string;
            color?: string;
            bg_color?: string;
            parent_category_id?: string;
            order?: number;
            excluded?: boolean;
            is_other?: boolean;
            auto_budget_lock?: boolean;
            auto_delete_lock?: boolean;
            user_id?: string;
          } = {
            category_id: categoryId,
          };

          if (name) categoryData.name = name;
          if (emoji) categoryData.emoji = emoji;
          if (color) categoryData.color = color;
          if (bgColor) categoryData.bg_color = bgColor;
          if (parentCategoryId) categoryData.parent_category_id = parentCategoryId;
          if (order !== null) categoryData.order = order;
          if (excluded !== null) categoryData.excluded = excluded;
          if (isOther !== null) categoryData.is_other = isOther;
          if (autoBudgetLock !== null) categoryData.auto_budget_lock = autoBudgetLock;
          if (autoDeleteLock !== null) categoryData.auto_delete_lock = autoDeleteLock;
          if (userId) categoryData.user_id = userId;

          // Validate and add to results
          const validated = CategorySchema.safeParse(categoryData);
          if (validated.success) {
            categories.push(validated.data);
          }
        }
      }

      idx = data.indexOf(categoryPathMarker, searchPos);
    }
  }

  // Deduplicate by category_id
  const seen = new Set<string>();
  const unique: Category[] = [];

  for (const category of categories) {
    if (!seen.has(category.category_id)) {
      seen.add(category.category_id);
      unique.push(category);
    }
  }

  // Sort by order, then by name
  unique.sort((a, b) => {
    const orderA = a.order ?? 999;
    const orderB = b.order ?? 999;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    const nameA = a.name || '';
    const nameB = b.name || '';
    return nameA.localeCompare(nameB);
  });

  return unique;
}

/**
 * User account customization data.
 *
 * This represents user-defined account settings stored in the
 * /users/{user_id}/accounts/{account_id} collection.
 */
export interface UserAccountCustomization {
  account_id: string;
  name?: string;
  user_id?: string;
  hidden?: boolean;
  order?: number;
}

/**
 * Decode user-defined account customizations from the Copilot Money database.
 *
 * User account customizations are stored in collection:
 * /users/{user_id}/accounts/{account_id}
 *
 * Each document contains user customizations including:
 * - name: User-defined account name (e.g., "Chase Sapphire Preferred")
 * - hidden: Whether the account is hidden from views
 * - order: Display order preference
 *
 * This is separate from raw Plaid account data in /accounts/ which contains
 * the bank's internal names (e.g., "CHASE CREDIT CRD AUTOPAY").
 *
 * @param dbPath - Path to the LevelDB database directory
 * @returns Array of user account customization objects
 */
export function decodeUserAccounts(dbPath: string): UserAccountCustomization[] {
  const userAccounts: UserAccountCustomization[] = [];

  const isDebug = process.env.NODE_ENV === 'development' || process.env.DEBUG;

  // Return empty array if path doesn't exist (graceful degradation)
  if (!fs.existsSync(dbPath)) {
    if (isDebug) {
      console.warn(`[decodeUserAccounts] Database path does not exist: ${dbPath}`);
    }
    return [];
  }

  let stat;
  try {
    stat = fs.statSync(dbPath);
  } catch (error) {
    if (isDebug) {
      console.warn(`[decodeUserAccounts] Failed to stat database path: ${dbPath}`, error);
    }
    return [];
  }

  if (!stat.isDirectory()) {
    if (isDebug) {
      console.warn(`[decodeUserAccounts] Path is not a directory: ${dbPath}`);
    }
    return [];
  }

  // Configuration constants for record extraction
  const RECORD_WINDOW_BEFORE = 500; // Bytes to search before path marker
  const RECORD_WINDOW_AFTER = 2000; // Bytes to search after path marker
  const MIN_ACCOUNT_ID_LENGTH = 15; // Minimum length for valid Firestore document IDs

  // Get all .ldb files
  let files;
  try {
    files = fs.readdirSync(dbPath);
  } catch (error) {
    if (isDebug) {
      console.warn(`[decodeUserAccounts] Failed to read directory: ${dbPath}`, error);
    }
    return [];
  }
  const ldbFiles = files.filter((f) => f.endsWith('.ldb')).map((f) => path.join(dbPath, f));

  // User accounts are in: /users/{user_id}/accounts/{account_id}
  // We need to find the /accounts/ marker that comes AFTER /users/
  const usersPathMarker = Buffer.from('/users/');

  for (const filepath of ldbFiles) {
    let data;
    try {
      data = fs.readFileSync(filepath);
    } catch (error) {
      if (isDebug) {
        console.warn(`[decodeUserAccounts] Failed to read file: ${filepath}`, error);
      }
      continue;
    }

    // Quick check: file must contain /users/ to have user account data
    if (!data.includes(usersPathMarker)) {
      continue;
    }

    // Find user account records by searching for /users/.../accounts/ pattern
    let searchPos = 0;
    let idx = data.indexOf(usersPathMarker, searchPos);

    while (idx !== -1) {
      searchPos = idx + 1;

      // Use a window around the users path marker
      const recordStart = Math.max(0, idx - RECORD_WINDOW_BEFORE);
      const recordEnd = Math.min(data.length, idx + RECORD_WINDOW_AFTER);
      const record = data.subarray(recordStart, recordEnd);

      // Calculate position within the window
      const pathIdx = idx - recordStart;
      const afterUsers = record.subarray(pathIdx);

      // Look for /users/{user_id}/accounts/{account_id} pattern
      const pathMatch = afterUsers
        .toString('utf-8')
        .match(/^\/users\/([a-zA-Z0-9_-]+)\/accounts\/([a-zA-Z0-9_-]+)/);

      if (pathMatch) {
        const userId = pathMatch[1];
        const accountId = pathMatch[2];

        // Validate account ID length (Firestore IDs are typically 20+ chars)
        if (accountId && accountId.length >= MIN_ACCOUNT_ID_LENGTH) {
          // Calculate where to start searching for fields
          const fullPathLength = pathMatch[0].length;
          const afterAccountId = record.subarray(pathIdx + fullPathLength);

          // Extract user-defined account name
          const name = extractStringValue(afterAccountId, fieldPattern('name'));
          const hidden = extractBooleanValue(afterAccountId, fieldPattern('hidden'));
          const order = extractDoubleField(afterAccountId, fieldPattern('order'));

          // Build user account object - include even if name is undefined
          // (the account_id mapping is still useful for other customizations)
          const userAccountData: UserAccountCustomization = {
            account_id: accountId,
          };

          if (name) userAccountData.name = name;
          if (userId) userAccountData.user_id = userId;
          if (hidden !== null) userAccountData.hidden = hidden;
          if (order !== null) userAccountData.order = order;

          // Only add if we have a name (the primary use case for this function)
          if (name) {
            userAccounts.push(userAccountData);
          }
        }
      }

      idx = data.indexOf(usersPathMarker, searchPos);
    }
  }

  // Deduplicate by account_id (keep first occurrence which has most recent data)
  const seen = new Set<string>();
  const unique: UserAccountCustomization[] = [];

  for (const userAccount of userAccounts) {
    if (!seen.has(userAccount.account_id)) {
      seen.add(userAccount.account_id);
      unique.push(userAccount);
    }
  }

  return unique;
}
