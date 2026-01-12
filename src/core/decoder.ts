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
 * Extract a boolean value for a field.
 */
function extractBooleanValue(data: Buffer, fieldName: Buffer): boolean | null {
  const idx = data.indexOf(fieldName);
  if (idx === -1) {
    return null;
  }

  const searchStart = idx + fieldName.length;
  const searchEnd = Math.min(data.length, searchStart + 20);
  const after = data.subarray(searchStart, searchEnd);

  for (let i = 0; i < after.length - 2; i++) {
    if (after[i] === 0x08) {
      // Boolean tag
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

      // Extract fields
      const name = extractStringValue(record, Buffer.from([0x0a, 0x04, 0x6e, 0x61, 0x6d, 0x65])); // "\x0a\x04name"
      const originalName = extractStringValue(record, Buffer.from('original_name'));
      const date = extractStringValue(record, Buffer.from('original_date'));
      const categoryId = extractStringValue(record, Buffer.from('category_id'));
      const accountId = extractStringValue(record, Buffer.from('account_id'));
      const transactionId = extractStringValue(record, Buffer.from('transaction_id'));
      const isoCurrencyCode = extractStringValue(record, Buffer.from('iso_currency_code'));
      const pending = extractBooleanValue(record, Buffer.from('pending'));
      const city = extractStringValue(record, Buffer.from([0x0a, 0x04, 0x63, 0x69, 0x74, 0x79])); // "\x0a\x04city"
      const region = extractStringValue(
        record,
        Buffer.from([0x0a, 0x06, 0x72, 0x65, 0x67, 0x69, 0x6f, 0x6e])
      ); // "\x0a\x06region"

      // Use name or original_name as display name
      const displayName = name || originalName;

      if (displayName && transactionId && date) {
        try {
          // Build transaction object with optional fields
          const txnData: {
            transaction_id: string;
            amount: number;
            date: string;
            name?: string;
            original_name?: string;
            account_id?: string;
            category_id?: string;
            iso_currency_code?: string;
            pending?: boolean;
            city?: string;
            region?: string;
          } = {
            transaction_id: transactionId,
            amount,
            date,
          };

          if (name) txnData.name = name;
          if (originalName) txnData.original_name = originalName;
          if (accountId) txnData.account_id = accountId;
          if (categoryId) txnData.category_id = categoryId;
          if (isoCurrencyCode) txnData.iso_currency_code = isoCurrencyCode;
          if (pending !== null) txnData.pending = pending;
          if (city) txnData.city = city;
          if (region) txnData.region = region;

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

      const recordStart = Math.max(0, idx - 1000);
      const recordEnd = Math.min(data.length, idx + 1000);
      const record = data.subarray(recordStart, recordEnd);

      const balanceIdx = record.indexOf(balancePattern);
      const balance = extractDoubleValue(record, balanceIdx + 15);

      if (balance !== null) {
        const name = extractStringValue(record, Buffer.from([0x0a, 0x04, 0x6e, 0x61, 0x6d, 0x65])); // "\x0a\x04name"
        const officialName = extractStringValue(record, Buffer.from('official_name'));
        const accountType = extractStringValue(
          record,
          Buffer.from([0x0a, 0x04, 0x74, 0x79, 0x70, 0x65])
        ); // "\x0a\x04type"
        const subtype = extractStringValue(record, Buffer.from('subtype'));
        const mask = extractStringValue(record, Buffer.from([0x0a, 0x04, 0x6d, 0x61, 0x73, 0x6b])); // "\x0a\x04mask"
        const institutionName = extractStringValue(record, Buffer.from('institution_name'));
        const accountId = extractStringValue(record, Buffer.from('account_id'));

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
