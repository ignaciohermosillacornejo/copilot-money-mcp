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

/**
 * Find a field and extract its string value.
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
 * Extract a double value after a given position.
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
 * Extract a double value for a named field.
 */
function extractDoubleField(data: Buffer, fieldName: Buffer): number | null {
  const idx = data.indexOf(fieldName);
  if (idx === -1) {
    return null;
  }
  return extractDoubleValue(data, idx + fieldName.length);
}

/**
 * Create a length-prefixed field pattern for Firestore field names.
 * Format: \x0a{length}{fieldname}
 */
function fieldPattern(name: string): Buffer {
  return Buffer.from([0x0a, name.length, ...Buffer.from(name)]);
}

/**
 * Extract a boolean value for a field.
 * Supports two formats:
 * 1. Firestore format: \x0a{len}fieldname\x12\x02\x08{value}
 * 2. Simple format: fieldname\x08{value}
 * where value is 0x00 (false) or 0x01 (true)
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
