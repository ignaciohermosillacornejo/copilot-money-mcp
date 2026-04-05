/**
 * Additional tests for decoder.ts to achieve 100% code coverage.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import {
  extractValue,
  decodeInvestmentPrices,
  decodeUserAccounts,
  decodeItems,
  decodeInvestmentSplits,
  decodeAllCollections,
  decodeGoalHistory,
  decodeTransactions,
  decodeCategories,
  getDecodeTimeoutMs,
} from '../../src/core/decoder.js';
import {
  createTestDatabase,
  cleanupAllTempDatabases,
  LevelDBReader,
} from '../../src/core/leveldb-reader.js';
import type { FirestoreValue } from '../../src/core/protobuf-parser.js';
import { encodeFirestoreDocument } from '../../src/core/protobuf-parser.js';
import path from 'node:path';
import fs from 'node:fs';

const FIXTURES_DIR = path.join(__dirname, '../fixtures/decoder-coverage-tests');

/**
 * Create a binary-encoded Firestore LevelDB key.
 * Format: \x85remote_document\x00\x01[\xBE{segment}\x00\x01]...\x80
 *
 * This is needed for deep subcollection paths (5+ segments after documents/)
 * that the string-format regex can't parse.
 */
function encodeBinaryKey(collectionPath: string, documentId: string): Buffer {
  const fullPath = `${collectionPath}/${documentId}`;
  const segments = fullPath.split('/');

  const parts: Buffer[] = [];
  // Start marker + "remote_document" + separator
  parts.push(Buffer.from([0x85]));
  parts.push(Buffer.from('remote_document', 'utf8'));
  parts.push(Buffer.from([0x00, 0x01]));

  for (const segment of segments) {
    parts.push(Buffer.from([0xbe]));
    parts.push(Buffer.from(segment, 'utf8'));
    parts.push(Buffer.from([0x00, 0x01]));
  }

  // End marker
  parts.push(Buffer.from([0x80]));

  return Buffer.concat(parts);
}

/**
 * Create a test database with binary-encoded keys for deep subcollection paths.
 * Falls back to string keys for paths with 4 or fewer segments.
 */
async function createDeepTestDatabase(
  dbPath: string,
  documents: Array<{ collection: string; id: string; fields: Record<string, unknown> }>
): Promise<void> {
  // Use classic-level directly since LevelDBReader.putDocument uses string keys
  const { ClassicLevel } = await import('classic-level');
  const db = new ClassicLevel<Buffer, Buffer>(dbPath, {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
    createIfMissing: true,
  });
  await db.open();

  try {
    for (const doc of documents) {
      const totalSegments = doc.collection.split('/').length + 1; // +1 for doc ID
      if (totalSegments > 4) {
        // Deep path - use binary key format
        const key = encodeBinaryKey(doc.collection, doc.id);
        const value = encodeFirestoreDocument(doc.fields);
        await db.put(key, value);
      } else {
        // Shallow path - use string key format
        const key = Buffer.from(
          `remote_document/projects/copilot-production-22904/databases/(default)/documents/${doc.collection}/${doc.id}`,
          'utf8'
        );
        const value = encodeFirestoreDocument(doc.fields);
        await db.put(key, value);
      }
    }
  } finally {
    await db.close();
  }
}

afterEach(() => {
  cleanupAllTempDatabases();
  if (fs.existsSync(FIXTURES_DIR)) {
    fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
  }
});

beforeEach(() => {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
});

describe('decoder coverage', () => {
  describe('extractValue', () => {
    test('extracts string value', () => {
      const value: FirestoreValue = { type: 'string', value: 'hello' };
      expect(extractValue(value)).toBe('hello');
    });

    test('extracts integer value', () => {
      const value: FirestoreValue = { type: 'integer', value: 42 };
      expect(extractValue(value)).toBe(42);
    });

    test('extracts double value', () => {
      const value: FirestoreValue = { type: 'double', value: 3.14 };
      expect(extractValue(value)).toBe(3.14);
    });

    test('extracts boolean value', () => {
      const value: FirestoreValue = { type: 'boolean', value: true };
      expect(extractValue(value)).toBe(true);
    });

    test('extracts reference value', () => {
      const value: FirestoreValue = { type: 'reference', value: 'projects/test/doc' };
      expect(extractValue(value)).toBe('projects/test/doc');
    });

    test('extracts null value', () => {
      const value: FirestoreValue = { type: 'null', value: null };
      expect(extractValue(value)).toBeNull();
    });

    test('extracts timestamp value as date string', () => {
      // January 15, 2024
      const value: FirestoreValue = { type: 'timestamp', value: { seconds: 1705276800, nanos: 0 } };
      const result = extractValue(value);
      expect(result).toBe('2024-01-15');
    });

    test('extracts geopoint value', () => {
      const value: FirestoreValue = {
        type: 'geopoint',
        value: { latitude: 40.7128, longitude: -74.006 },
      };
      expect(extractValue(value)).toEqual({ lat: 40.7128, lon: -74.006 });
    });

    test('extracts map value', () => {
      const innerMap = new Map<string, FirestoreValue>([
        ['name', { type: 'string', value: 'Test' }],
      ]);
      const value: FirestoreValue = { type: 'map', value: innerMap };
      expect(extractValue(value)).toEqual({ name: 'Test' });
    });

    test('extracts array value', () => {
      const arr: FirestoreValue[] = [
        { type: 'integer', value: 1 },
        { type: 'string', value: 'two' },
      ];
      const value: FirestoreValue = { type: 'array', value: arr };
      expect(extractValue(value)).toEqual([1, 'two']);
    });

    test('extracts bytes value', () => {
      const buf = Buffer.from([1, 2, 3]);
      const value: FirestoreValue = { type: 'bytes', value: buf };
      expect(extractValue(value)).toEqual(buf);
    });

    test('returns undefined for undefined input', () => {
      expect(extractValue(undefined)).toBeUndefined();
    });
  });

  describe('decodeInvestmentPrices', () => {
    test('decodes investment prices from database', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'investment-prices-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'investment_prices',
          id: 'price1',
          fields: {
            investment_id: 'inv1',
            ticker_symbol: 'AAPL',
            price: 150.5,
            close_price: 149.0,
            date: '2024-01-15',
            currency: 'USD',
            high: 152.0,
            low: 148.0,
            open: 149.5,
            volume: 1000000,
          },
        },
        {
          collection: 'investment_prices',
          id: 'price2',
          fields: {
            investment_id: 'inv2',
            ticker_symbol: 'GOOGL',
            current_price: 140.0,
            month: '2024-01',
          },
        },
      ]);

      const prices = await decodeInvestmentPrices(dbPath);

      expect(prices.length).toBe(2);
    });

    test('filters by ticker symbol', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'investment-prices-filter-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'investment_prices',
          id: 'price1',
          fields: {
            investment_id: 'inv1',
            ticker_symbol: 'AAPL',
            price: 150.0,
            date: '2024-01-15',
          },
        },
        {
          collection: 'investment_prices',
          id: 'price2',
          fields: {
            investment_id: 'inv2',
            ticker_symbol: 'GOOGL',
            price: 140.0,
            date: '2024-01-15',
          },
        },
      ]);

      const prices = await decodeInvestmentPrices(dbPath, { tickerSymbol: 'AAPL' });

      expect(prices.every((p) => p.ticker_symbol === 'AAPL')).toBe(true);
    });

    test('filters by date range', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'investment-prices-date-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'investment_prices',
          id: 'price1',
          fields: {
            investment_id: 'inv1',
            price: 150.0,
            date: '2024-01-10',
          },
        },
        {
          collection: 'investment_prices',
          id: 'price2',
          fields: {
            investment_id: 'inv2',
            price: 155.0,
            date: '2024-01-20',
          },
        },
        {
          collection: 'investment_prices',
          id: 'price3',
          fields: {
            investment_id: 'inv3',
            price: 160.0,
            date: '2024-01-30',
          },
        },
      ]);

      const prices = await decodeInvestmentPrices(dbPath, {
        startDate: '2024-01-15',
        endDate: '2024-01-25',
      });

      expect(prices.every((p) => p.date! >= '2024-01-15' && p.date! <= '2024-01-25')).toBe(true);
    });

    test('returns empty array for empty database', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'empty-prices-db');
      await createTestDatabase(dbPath, []);

      const prices = await decodeInvestmentPrices(dbPath);

      expect(prices).toEqual([]);
    });
  });

  describe('decodeUserAccounts', () => {
    test('decodes user account customizations', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'user-accounts-db');
      // User accounts are in subcollection: users/{user_id}/accounts
      await createTestDatabase(dbPath, [
        {
          collection: 'users/user123/accounts',
          id: 'acc1',
          fields: {
            account_id: 'acc1',
            name: 'My Checking',
            hidden: false,
            order: 1,
          },
        },
        {
          collection: 'users/user123/accounts',
          id: 'acc2',
          fields: {
            account_id: 'acc2',
            name: 'My Savings',
            hidden: true,
            order: 2,
          },
        },
      ]);

      const userAccounts = await decodeUserAccounts(dbPath);

      expect(userAccounts.length).toBe(2);
      expect(userAccounts[0]?.name).toBe('My Checking');
      expect(userAccounts[0]?.user_id).toBe('user123');
    });

    test('skips user accounts without name', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'user-accounts-no-name-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'users/user123/accounts',
          id: 'acc1',
          fields: {
            account_id: 'acc1',
            // No name - should be skipped
            hidden: false,
          },
        },
        {
          collection: 'users/user123/accounts',
          id: 'acc2',
          fields: {
            account_id: 'acc2',
            name: 'Valid Account',
          },
        },
      ]);

      const userAccounts = await decodeUserAccounts(dbPath);

      expect(userAccounts.length).toBe(1);
      expect(userAccounts[0]?.name).toBe('Valid Account');
    });

    test('skips non-user-account collections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'mixed-collections-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'accounts', // Not a user subcollection
          id: 'acc1',
          fields: {
            account_id: 'acc1',
            name: 'Regular Account',
          },
        },
        {
          collection: 'users/user123/accounts',
          id: 'acc2',
          fields: {
            account_id: 'acc2',
            name: 'User Account',
          },
        },
      ]);

      const userAccounts = await decodeUserAccounts(dbPath);

      expect(userAccounts.length).toBe(1);
      expect(userAccounts[0]?.name).toBe('User Account');
    });

    test('deduplicates user accounts by account_id', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'duplicate-user-accounts-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'users/user1/accounts',
          id: 'acc1',
          fields: {
            account_id: 'acc1',
            name: 'First Name',
          },
        },
        {
          collection: 'users/user2/accounts',
          id: 'acc1',
          fields: {
            account_id: 'acc1',
            name: 'Second Name',
          },
        },
      ]);

      const userAccounts = await decodeUserAccounts(dbPath);

      // Should deduplicate by account_id
      expect(userAccounts.length).toBe(1);
    });
  });

  describe('decodeItems', () => {
    test('decodes items with all fields', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'items-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'items',
          id: 'item1',
          fields: {
            item_id: 'item1',
            institution_name: 'Test Bank',
            institution_id: 'ins_123',
            connection_status: 'connected',
            needs_update: false,
            error_code: null,
            error_message: null,
            last_successful_update: '2024-01-15T10:00:00Z',
            consent_expiration_time: '2025-01-15T10:00:00Z',
          },
        },
      ]);

      const items = await decodeItems(dbPath);

      expect(items.length).toBe(1);
      expect(items[0]?.item_id).toBe('item1');
      expect(items[0]?.institution_name).toBe('Test Bank');
    });

    test('handles items with error state', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'items-error-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'items',
          id: 'item1',
          fields: {
            item_id: 'item1',
            institution_name: 'Test Bank',
            connection_status: 'disconnected',
            needs_update: true,
            error_code: 'ITEM_LOGIN_REQUIRED',
            error_message: 'Please re-authenticate',
          },
        },
      ]);

      const items = await decodeItems(dbPath);

      expect(items.length).toBe(1);
      expect(items[0]?.error_code).toBe('ITEM_LOGIN_REQUIRED');
    });

    test('decodes per-product sync timestamps from real Firestore field names', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'items-sync-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'items',
          id: 'item1',
          fields: {
            item_id: 'item1',
            institution_name: 'Test Bank',
            institution_id: 'ins_123',
            status_transactions_last_successful_update: '2026-03-08T06:22:07.086Z',
            status_transactions_last_failed_update: '2025-12-31T01:22:59.825Z',
            status_investments_last_successful_update: '2026-03-07T10:19:36.388Z',
            latest_fetch: '2026-03-08T06:22:13.305Z',
            login_required: false,
            disconnected: false,
            billed_products: ['transactions'],
          },
        },
      ]);

      const items = await decodeItems(dbPath);

      expect(items.length).toBe(1);
      expect(items[0]?.status_transactions_last_successful_update).toBe('2026-03-08T06:22:07.086Z');
      expect(items[0]?.status_transactions_last_failed_update).toBe('2025-12-31T01:22:59.825Z');
      expect(items[0]?.status_investments_last_successful_update).toBe('2026-03-07T10:19:36.388Z');
      expect(items[0]?.latest_fetch).toBe('2026-03-08T06:22:13.305Z');
      expect(items[0]?.login_required).toBe(false);
      expect(items[0]?.disconnected).toBe(false);
    });

    test('decodes login_required flag correctly', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'items-login-required-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'items',
          id: 'item1',
          fields: {
            item_id: 'item1',
            institution_name: 'Test Bank',
            login_required: true,
            disconnected: false,
          },
        },
      ]);

      const items = await decodeItems(dbPath);

      expect(items.length).toBe(1);
      expect(items[0]?.login_required).toBe(true);
      expect(items[0]?.disconnected).toBe(false);
    });
  });

  describe('decodeInvestmentSplits', () => {
    test('decodes investment splits', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'splits-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'investment_splits',
          id: 'split1',
          fields: {
            split_id: 'split1',
            ticker_symbol: 'AAPL',
            split_date: '2024-01-15',
            split_ratio: '4:1',
            from_factor: 1,
            to_factor: 4,
            announcement_date: '2024-01-01',
            record_date: '2024-01-14',
            ex_date: '2024-01-15',
            description: '4-for-1 stock split',
          },
        },
      ]);

      const splits = await decodeInvestmentSplits(dbPath);

      expect(splits.length).toBe(1);
      expect(splits[0]?.ticker_symbol).toBe('AAPL');
      expect(splits[0]?.split_ratio).toBe('4:1');
    });

    test('filters splits by ticker symbol', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'splits-filter-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'investment_splits',
          id: 'split1',
          fields: {
            split_id: 'split1',
            ticker_symbol: 'AAPL',
            split_date: '2024-01-15',
          },
        },
        {
          collection: 'investment_splits',
          id: 'split2',
          fields: {
            split_id: 'split2',
            ticker_symbol: 'GOOGL',
            split_date: '2024-01-15',
          },
        },
      ]);

      const splits = await decodeInvestmentSplits(dbPath, { tickerSymbol: 'AAPL' });

      expect(splits.length).toBe(1);
      expect(splits[0]?.ticker_symbol).toBe('AAPL');
    });

    test('filters splits by date range', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'splits-date-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'investment_splits',
          id: 'split1',
          fields: {
            split_id: 'split1',
            ticker_symbol: 'AAPL',
            split_date: '2024-01-10',
          },
        },
        {
          collection: 'investment_splits',
          id: 'split2',
          fields: {
            split_id: 'split2',
            ticker_symbol: 'AAPL',
            split_date: '2024-01-20',
          },
        },
      ]);

      const splits = await decodeInvestmentSplits(dbPath, {
        startDate: '2024-01-15',
        endDate: '2024-01-25',
      });

      expect(splits.length).toBe(1);
      expect(splits[0]?.split_date).toBe('2024-01-20');
    });
  });

  describe('decodeGoalHistory', () => {
    test('decodes goal history from database', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'goal-history-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'financial_goals/goal1/financial_goal_history',
          id: '2024-01',
          fields: {
            goal_id: 'goal1',
            current_amount: 5000,
            target_amount: 10000,
            user_id: 'user1',
          },
        },
      ]);

      const histories = await decodeGoalHistory(dbPath);

      expect(histories.length).toBe(1);
      expect(histories[0]?.goal_id).toBe('goal1');
      expect(histories[0]?.month).toBe('2024-01');
      expect(histories[0]?.current_amount).toBe(5000);
    });

    test('filters goal history by goalId', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'goal-history-filter-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'financial_goals/goal1/financial_goal_history',
          id: '2024-01',
          fields: {
            goal_id: 'goal1',
            current_amount: 5000,
          },
        },
        {
          collection: 'financial_goals/goal2/financial_goal_history',
          id: '2024-01',
          fields: {
            goal_id: 'goal2',
            current_amount: 3000,
          },
        },
      ]);

      const histories = await decodeGoalHistory(dbPath, 'goal1');

      expect(histories.length).toBe(1);
      expect(histories[0]?.goal_id).toBe('goal1');
    });

    test('deduplicates and sorts goal history', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'goal-history-sort-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'financial_goals/goal1/financial_goal_history',
          id: '2024-01',
          fields: {
            goal_id: 'goal1',
            current_amount: 5000,
          },
        },
        {
          collection: 'financial_goals/goal1/financial_goal_history',
          id: '2024-02',
          fields: {
            goal_id: 'goal1',
            current_amount: 6000,
          },
        },
        {
          collection: 'financial_goals/goal2/financial_goal_history',
          id: '2024-01',
          fields: {
            goal_id: 'goal2',
            current_amount: 3000,
          },
        },
      ]);

      const histories = await decodeGoalHistory(dbPath);

      // Should be sorted by goal_id, then month (newest first)
      expect(histories.length).toBe(3);
      expect(histories[0]?.goal_id).toBe('goal1');
      expect(histories[0]?.month).toBe('2024-02');
      expect(histories[1]?.goal_id).toBe('goal1');
      expect(histories[1]?.month).toBe('2024-01');
      expect(histories[2]?.goal_id).toBe('goal2');
    });
  });

  describe('decodeAllCollections', () => {
    test('decodes all collection types in a single pass', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'all-collections-db');
      await createTestDatabase(dbPath, [
        // Transaction
        {
          collection: 'transactions',
          id: 'txn1',
          fields: {
            transaction_id: 'txn1',
            amount: 50.0,
            date: '2024-01-15',
            name: 'Coffee Shop',
          },
        },
        // Account
        {
          collection: 'accounts',
          id: 'acc1',
          fields: {
            account_id: 'acc1',
            name: 'Checking',
            current_balance: 1000.0,
            account_type: 'depository',
          },
        },
        // Recurring
        {
          collection: 'recurring',
          id: 'rec1',
          fields: {
            recurring_id: 'rec1',
            name: 'Netflix',
            amount: 15.99,
            frequency: 'monthly',
          },
        },
        // Budget
        {
          collection: 'budgets',
          id: 'bud1',
          fields: {
            budget_id: 'bud1',
            name: 'Food Budget',
            amount: 500,
          },
        },
        // Goal
        {
          collection: 'financial_goals',
          id: 'goal1',
          fields: {
            goal_id: 'goal1',
            name: 'Emergency Fund',
          },
        },
        // Item
        {
          collection: 'items',
          id: 'item1',
          fields: {
            item_id: 'item1',
            institution_name: 'Chase',
          },
        },
        // Category
        {
          collection: 'categories',
          id: 'cat1',
          fields: {
            category_id: 'cat1',
            name: 'Food & Drink',
          },
        },
        // Investment price
        {
          collection: 'investment_prices',
          id: 'price1',
          fields: {
            investment_id: 'inv1',
            ticker_symbol: 'AAPL',
            price: 150.0,
            date: '2024-01-15',
          },
        },
        // Investment split
        {
          collection: 'investment_splits',
          id: 'split1',
          fields: {
            split_id: 'split1',
            ticker_symbol: 'AAPL',
            split_ratio: '4:1',
          },
        },
        // Goal history
        {
          collection: 'financial_goals/goal1/financial_goal_history',
          id: '2024-01',
          fields: {
            goal_id: 'goal1',
            current_amount: 5000,
            target_amount: 10000,
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      // Verify all collections were decoded
      expect(result.transactions.length).toBe(1);
      expect(result.transactions[0]?.name).toBe('Coffee Shop');

      expect(result.accounts.length).toBe(1);
      expect(result.accounts[0]?.name).toBe('Checking');

      expect(result.recurring.length).toBe(1);
      expect(result.recurring[0]?.name).toBe('Netflix');

      expect(result.budgets.length).toBe(1);
      expect(result.budgets[0]?.name).toBe('Food Budget');

      expect(result.goals.length).toBe(1);
      expect(result.goals[0]?.name).toBe('Emergency Fund');

      expect(result.goalHistory.length).toBe(1);
      expect(result.goalHistory[0]?.goal_id).toBe('goal1');

      expect(result.items.length).toBe(1);
      expect(result.items[0]?.institution_name).toBe('Chase');

      expect(result.categories.length).toBe(1);
      expect(result.categories[0]?.name).toBe('Food & Drink');

      expect(result.investmentPrices.length).toBe(1);
      expect(result.investmentPrices[0]?.ticker_symbol).toBe('AAPL');

      expect(result.investmentSplits.length).toBe(1);
      expect(result.investmentSplits[0]?.split_ratio).toBe('4:1');
    });

    test('deduplicates transactions by transaction_id, not by name/amount/date', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'all-collections-dedupe-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'transactions',
          id: 'txn1',
          fields: {
            transaction_id: 'txn1',
            amount: 50.0,
            date: '2024-01-15',
            name: 'Coffee Shop',
          },
        },
        {
          collection: 'transactions',
          id: 'txn2',
          fields: {
            transaction_id: 'txn2',
            amount: 50.0,
            date: '2024-01-15',
            name: 'Coffee Shop', // Same name/amount/date but different transaction_id
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      // Both should be kept — they are distinct transactions with different IDs
      expect(result.transactions.length).toBe(2);
    });

    test('deduplicates true LevelDB duplicates (same transaction_id)', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'all-collections-true-dedupe-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'transactions',
          id: 'doc-key-a',
          fields: {
            transaction_id: 'txn1',
            amount: 50.0,
            date: '2024-01-15',
            name: 'Coffee Shop',
          },
        },
        {
          collection: 'transactions',
          id: 'doc-key-b',
          fields: {
            transaction_id: 'txn1',
            amount: 50.0,
            date: '2024-01-15',
            name: 'Coffee Shop',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      // Same transaction_id = true duplicate, should be collapsed to 1
      expect(result.transactions.length).toBe(1);
    });

    test('reconciles pending and posted versions of same transaction', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'all-collections-pending-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'transactions',
          id: 'pending-txn-1',
          fields: {
            transaction_id: 'pending-txn-1',
            amount: 75.0,
            date: '2024-01-15',
            name: 'BRIGHT HORIZONS PAYMENT',
            pending: true,
            category_id: 'childcare',
          },
        },
        {
          collection: 'transactions',
          id: 'posted-txn-1',
          fields: {
            transaction_id: 'posted-txn-1',
            amount: 75.0,
            date: '2024-01-15',
            name: 'BRIGHT HORIZONS',
            pending: false,
            pending_transaction_id: 'pending-txn-1',
            category_id: 'childcare',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      // Pending version should be dropped since posted version references it
      expect(result.transactions.length).toBe(1);
      expect(result.transactions[0]?.transaction_id).toBe('posted-txn-1');
      expect(result.transactions[0]?.pending).toBe(false);
    });

    test('keeps pending transactions when no posted version exists', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'all-collections-pending-only-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'transactions',
          id: 'pending-txn-1',
          fields: {
            transaction_id: 'pending-txn-1',
            amount: 75.0,
            date: '2024-01-15',
            name: 'BRIGHT HORIZONS PAYMENT',
            pending: true,
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      // Pending transaction with no posted counterpart should be kept
      expect(result.transactions.length).toBe(1);
      expect(result.transactions[0]?.pending).toBe(true);
    });

    test('decodeTransactions: reconciles pending/posted pairs', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'decode-txns-pending-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'transactions',
          id: 'pending-1',
          fields: {
            transaction_id: 'pending-1',
            amount: 50.0,
            date: '2024-01-15',
            name: 'BRIGHT HORIZONS PAYMENT',
            pending: true,
          },
        },
        {
          collection: 'transactions',
          id: 'posted-1',
          fields: {
            transaction_id: 'posted-1',
            amount: 50.0,
            date: '2024-01-15',
            name: 'BRIGHT HORIZONS',
            pending: false,
            pending_transaction_id: 'pending-1',
          },
        },
      ]);

      const txns = await decodeTransactions(dbPath);
      expect(txns.length).toBe(1);
      expect(txns[0]?.transaction_id).toBe('posted-1');
    });

    test('extracts all new transaction fields', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'txn-new-fields-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'transactions',
          id: 'txn-full',
          fields: {
            transaction_id: 'txn-full',
            amount: 42.5,
            date: '2024-03-10',
            name: 'Coffee Shop',
            original_name: 'COFFEE SHOP #123',
            original_clean_name: 'Coffee Shop',
            name_override: 'My Coffee',
            original_transaction_id: 'orig-txn-1',
            created_timestamp: { __type: 'timestamp', seconds: 1710000000, nanos: 0 },
            user_note: 'Weekly coffee',
            plaid_category_strings: ['Food and Drink', 'Coffee Shop'],
            is_manual: false,
            recurring: true,
            recurring_id: 'rec-123',
            skip_balance_adjust: false,
            intelligence_suggested_category_ids: ['cat-1', 'cat-2'],
            intelligence_chosen_category_id: 'cat-1',
            intelligence_powered: true,
            pending_amount: 40.0,
            plaid_pending_transaction_id: 'plaid-pending-1',
            posted_transaction_id: 'posted-txn-1',
            tag_ids: ['tag-a', 'tag-b'],
            internal_tx_match: { match_id: 'match-1', confidence: 0.95 },
            old_category_id: 'old-cat-1',
            venmo_extra_data: { sender: 'alice', note: 'lunch' },
            _origin: 'plaid',
            account_type: 'checking',
            user_deleted: false,
            from_investment: 'true_string',
          },
        },
        {
          // Test from_investment as boolean
          collection: 'transactions',
          id: 'txn-invest-bool',
          fields: {
            transaction_id: 'txn-invest-bool',
            amount: 100.0,
            date: '2024-03-11',
            from_investment: true,
          },
        },
      ]);

      const txns = await decodeTransactions(dbPath);
      expect(txns.length).toBe(2);

      const full = txns.find((t) => t.transaction_id === 'txn-full')!;
      expect(full).toBeDefined();
      expect(full.original_clean_name).toBe('Coffee Shop');
      expect(full.name_override).toBe('My Coffee');
      expect(full.original_transaction_id).toBe('orig-txn-1');
      expect(full.created_timestamp).toBe('2024-03-09');
      expect(full.user_note).toBe('Weekly coffee');
      expect(full.plaid_category_strings).toEqual(['Food and Drink', 'Coffee Shop']);
      expect(full.is_manual).toBe(false);
      expect(full.recurring).toBe(true);
      expect(full.recurring_id).toBe('rec-123');
      expect(full.skip_balance_adjust).toBe(false);
      expect(full.intelligence_suggested_category_ids).toEqual(['cat-1', 'cat-2']);
      expect(full.intelligence_chosen_category_id).toBe('cat-1');
      expect(full.intelligence_powered).toBe(true);
      expect(full.pending_amount).toBe(40.0);
      expect(full.plaid_pending_transaction_id).toBe('plaid-pending-1');
      expect(full.posted_transaction_id).toBe('posted-txn-1');
      expect(full.tag_ids).toEqual(['tag-a', 'tag-b']);
      expect(full.internal_tx_match).toEqual({ match_id: 'match-1', confidence: 0.95 });
      expect(full.old_category_id).toBe('old-cat-1');
      expect(full.venmo_extra_data).toEqual({ sender: 'alice', note: 'lunch' });
      expect(full._origin).toBe('plaid');
      expect(full.account_type).toBe('checking');
      expect(full.user_deleted).toBe(false);
      expect(full.from_investment).toBe('true_string');

      // Test from_investment as boolean fallback
      const investBool = txns.find((t) => t.transaction_id === 'txn-invest-bool')!;
      expect(investBool).toBeDefined();
      expect(investBool.from_investment).toBe(true);
    });

    test('handles empty database', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'all-collections-empty-db');
      await createTestDatabase(dbPath, []);

      const result = await decodeAllCollections(dbPath);

      expect(result.transactions).toEqual([]);
      expect(result.accounts).toEqual([]);
      expect(result.recurring).toEqual([]);
      expect(result.budgets).toEqual([]);
      expect(result.goals).toEqual([]);
      expect(result.goalHistory).toEqual([]);
      expect(result.investmentPrices).toEqual([]);
      expect(result.investmentSplits).toEqual([]);
      expect(result.items).toEqual([]);
      expect(result.categories).toEqual([]);
      expect(result.userAccounts).toEqual([]);
    });

    test('handles user accounts in subcollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'all-collections-user-accounts-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'users/user123/accounts',
          id: 'acc1',
          fields: {
            account_id: 'acc1',
            name: 'My Custom Account Name',
            hidden: false,
            order: 1,
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.userAccounts.length).toBe(1);
      expect(result.userAccounts[0]?.name).toBe('My Custom Account Name');
      expect(result.userAccounts[0]?.user_id).toBe('user123');
    });

    test('handles internal_transfer transactions', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'internal-transfer-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'transactions',
          id: 'txn1',
          fields: {
            transaction_id: 'txn1',
            amount: 500.0,
            date: '2024-01-15',
            name: 'Transfer to Savings',
            type: 'internal_transfer',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.transactions.length).toBe(1);
      expect(result.transactions[0]?.internal_transfer).toBe(true);
    });

    test('handles accounts with available_balance', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'available-balance-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'accounts',
          id: 'acc1',
          fields: {
            account_id: 'acc1',
            name: 'Checking',
            current_balance: 1000.0,
            available_balance: 950.0,
            account_type: 'depository',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.accounts.length).toBe(1);
      expect(result.accounts[0]?.available_balance).toBe(950);
    });

    test('handles accounts with user_deleted flag', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'user-deleted-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'accounts',
          id: 'acc1',
          fields: {
            account_id: 'acc1',
            name: 'Old Account',
            current_balance: 0,
            user_deleted: true,
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.accounts.length).toBe(1);
      expect(result.accounts[0]?.user_deleted).toBe(true);
    });

    test('skips accounts without balance', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'no-balance-account-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'accounts',
          id: 'acc1',
          fields: {
            account_id: 'acc1',
            name: 'Bad Account',
            // No current_balance - should be skipped
          },
        },
        {
          collection: 'accounts',
          id: 'acc2',
          fields: {
            account_id: 'acc2',
            name: 'Good Account',
            current_balance: 100,
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.accounts.length).toBe(1);
      expect(result.accounts[0]?.account_id).toBe('acc2');
    });

    test('skips accounts without name or official_name', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'no-name-account-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'accounts',
          id: 'acc1',
          fields: {
            account_id: 'acc1',
            current_balance: 100,
            // No name or official_name - should be skipped
          },
        },
        {
          collection: 'accounts',
          id: 'acc2',
          fields: {
            account_id: 'acc2',
            official_name: 'My Official Account',
            current_balance: 200,
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.accounts.length).toBe(1);
      expect(result.accounts[0]?.official_name).toBe('My Official Account');
    });

    test('handles recurring with transaction_ids array', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'recurring-txn-ids-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'recurring',
          id: 'rec1',
          fields: {
            recurring_id: 'rec1',
            name: 'Netflix',
            amount: 15.99,
            frequency: 'monthly',
            transaction_ids: ['txn1', 'txn2', 'txn3'],
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.recurring.length).toBe(1);
      expect(result.recurring[0]?.transaction_ids).toEqual(['txn1', 'txn2', 'txn3']);
    });

    test('handles recurring with emoji field', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'recurring-emoji-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'recurring',
          id: 'rec1',
          fields: {
            recurring_id: 'rec1',
            name: 'Spotify',
            amount: 9.99,
            frequency: 'monthly',
            emoji: '🎵',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.recurring.length).toBe(1);
      expect(result.recurring[0]?.emoji).toBe('🎵');
    });

    test('handles recurring with state field', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'recurring-state-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'recurring',
          id: 'rec1',
          fields: {
            recurring_id: 'rec1',
            name: 'Old Subscription',
            amount: 20.0,
            frequency: 'monthly',
            state: 'paused',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.recurring.length).toBe(1);
      expect(result.recurring[0]?.state).toBe('paused');
    });

    test('calculates next_date from latest_date and frequency', async () => {
      // Note: Copilot uses 'latest_date' field, and next_date is calculated from it
      const dbPath = path.join(FIXTURES_DIR, 'recurring-next-date-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'recurring',
          id: 'rec1',
          fields: {
            recurring_id: 'rec1',
            name: 'Weekly Sub',
            amount: 10.0,
            frequency: 'weekly',
            latest_date: '2024-01-15', // Use latest_date (Copilot's field name)
          },
        },
        {
          collection: 'recurring',
          id: 'rec2',
          fields: {
            recurring_id: 'rec2',
            name: 'Biweekly Sub',
            amount: 20.0,
            frequency: 'biweekly',
            latest_date: '2024-01-15',
          },
        },
        {
          collection: 'recurring',
          id: 'rec3',
          fields: {
            recurring_id: 'rec3',
            name: 'Quarterly Sub',
            amount: 30.0,
            frequency: 'quarterly',
            latest_date: '2024-01-15',
          },
        },
        {
          collection: 'recurring',
          id: 'rec4',
          fields: {
            recurring_id: 'rec4',
            name: 'Yearly Sub',
            amount: 100.0,
            frequency: 'yearly',
            latest_date: '2024-01-15',
          },
        },
        {
          collection: 'recurring',
          id: 'rec5',
          fields: {
            recurring_id: 'rec5',
            name: 'Semiannual Sub',
            amount: 50.0,
            frequency: 'semiannually',
            latest_date: '2024-01-15',
          },
        },
        {
          collection: 'recurring',
          id: 'rec6',
          fields: {
            recurring_id: 'rec6',
            name: 'Daily Sub',
            amount: 1.0,
            frequency: 'daily',
            latest_date: '2024-01-15',
          },
        },
        {
          collection: 'recurring',
          id: 'rec7',
          fields: {
            recurring_id: 'rec7',
            name: 'Bimonthly Sub',
            amount: 25.0,
            frequency: 'bimonthly',
            latest_date: '2024-01-15',
          },
        },
        {
          collection: 'recurring',
          id: 'rec8',
          fields: {
            recurring_id: 'rec8',
            name: 'Quadmonthly Sub',
            amount: 40.0,
            frequency: 'quadmonthly',
            latest_date: '2024-01-15',
          },
        },
        {
          collection: 'recurring',
          id: 'rec9',
          fields: {
            recurring_id: 'rec9',
            name: 'Unknown Freq Sub',
            amount: 5.0,
            frequency: 'unknown_frequency',
            latest_date: '2024-01-15',
          },
        },
        {
          collection: 'recurring',
          id: 'rec10',
          fields: {
            recurring_id: 'rec10',
            name: 'Monthly Sub',
            amount: 15.0,
            frequency: 'monthly',
            latest_date: '2024-01-15',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.recurring.length).toBe(10);

      // Find each recurring by name and verify next_date calculation
      const weekly = result.recurring.find((r) => r.name === 'Weekly Sub');
      expect(weekly?.next_date).toBe('2024-01-22'); // +7 days

      const biweekly = result.recurring.find((r) => r.name === 'Biweekly Sub');
      expect(biweekly?.next_date).toBe('2024-01-29'); // +14 days

      const quarterly = result.recurring.find((r) => r.name === 'Quarterly Sub');
      expect(quarterly?.next_date).toBe('2024-04-15'); // +3 months

      const yearly = result.recurring.find((r) => r.name === 'Yearly Sub');
      expect(yearly?.next_date).toBe('2025-01-15'); // +1 year

      const semiannual = result.recurring.find((r) => r.name === 'Semiannual Sub');
      expect(semiannual?.next_date).toBe('2024-07-15'); // +6 months

      const daily = result.recurring.find((r) => r.name === 'Daily Sub');
      expect(daily?.next_date).toBe('2024-01-16'); // +1 day

      const bimonthly = result.recurring.find((r) => r.name === 'Bimonthly Sub');
      expect(bimonthly?.next_date).toBe('2024-03-15'); // +2 months

      const quadmonthly = result.recurring.find((r) => r.name === 'Quadmonthly Sub');
      expect(quadmonthly?.next_date).toBe('2024-05-15'); // +4 months

      const unknown = result.recurring.find((r) => r.name === 'Unknown Freq Sub');
      expect(unknown?.next_date).toBe('2024-02-15'); // default monthly

      const monthly = result.recurring.find((r) => r.name === 'Monthly Sub');
      expect(monthly?.next_date).toBe('2024-02-15'); // +1 month
    });

    test('handles investment prices with sorting', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'investment-prices-sort-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'investment_prices',
          id: 'price1',
          fields: {
            investment_id: 'inv1',
            ticker_symbol: 'AAPL',
            price: 150.0,
            date: '2024-01-10',
          },
        },
        {
          collection: 'investment_prices',
          id: 'price2',
          fields: {
            investment_id: 'inv1',
            ticker_symbol: 'AAPL',
            price: 155.0,
            date: '2024-01-20',
          },
        },
        {
          collection: 'investment_prices',
          id: 'price3',
          fields: {
            investment_id: 'inv2',
            ticker_symbol: 'GOOGL',
            price: 140.0,
            date: '2024-01-15',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      // Should be sorted by investment_id, then by date (newest first)
      expect(result.investmentPrices.length).toBe(3);
      // First investment sorted by date desc
      expect(result.investmentPrices[0]?.investment_id).toBe('inv1');
      expect(result.investmentPrices[0]?.date).toBe('2024-01-20');
      expect(result.investmentPrices[1]?.investment_id).toBe('inv1');
      expect(result.investmentPrices[1]?.date).toBe('2024-01-10');
      // Then second investment
      expect(result.investmentPrices[2]?.investment_id).toBe('inv2');
    });

    test('handles investment splits with sorting', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'investment-splits-sort-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'investment_splits',
          id: 'split1',
          fields: {
            split_id: 'split1',
            ticker_symbol: 'AAPL',
            split_date: '2024-01-10',
          },
        },
        {
          collection: 'investment_splits',
          id: 'split2',
          fields: {
            split_id: 'split2',
            ticker_symbol: 'AAPL',
            split_date: '2024-01-20',
          },
        },
        {
          collection: 'investment_splits',
          id: 'split3',
          fields: {
            split_id: 'split3',
            ticker_symbol: 'GOOGL',
            split_date: '2024-01-15',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      // Should be sorted by ticker_symbol, then by split_date (newest first)
      expect(result.investmentSplits.length).toBe(3);
      // AAPL first (alphabetically), newest date first
      expect(result.investmentSplits[0]?.ticker_symbol).toBe('AAPL');
      expect(result.investmentSplits[0]?.split_date).toBe('2024-01-20');
      expect(result.investmentSplits[1]?.ticker_symbol).toBe('AAPL');
      expect(result.investmentSplits[1]?.split_date).toBe('2024-01-10');
      // Then GOOGL
      expect(result.investmentSplits[2]?.ticker_symbol).toBe('GOOGL');
    });

    test('decodes investment performance via decodeAllCollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'inv-perf-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'investment_performance',
          id: 'perf1',
          fields: {
            security_id: 'sec123',
            type: 'stock',
            user_id: 'user1',
            last_update: '2024-01-15',
            position: 5,
            access: ['read', 'write'],
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.investmentPerformance.length).toBe(1);
      expect(result.investmentPerformance[0]?.performance_id).toBe('perf1');
      expect(result.investmentPerformance[0]?.security_id).toBe('sec123');
      expect(result.investmentPerformance[0]?.type).toBe('stock');
      expect(result.investmentPerformance[0]?.user_id).toBe('user1');
      expect(result.investmentPerformance[0]?.last_update).toBe('2024-01-15');
      expect(result.investmentPerformance[0]?.position).toBe(5);
      expect(result.investmentPerformance[0]?.access).toEqual(['read', 'write']);
    });

    test('decodes TWR holdings via decodeAllCollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'twr-holding-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'investment_performance/hash123/twr_holding',
          id: '2024-01',
          fields: {
            security_id: 'sec456',
            history: {
              '1705276800000': { value: 1.05 },
              '1705363200000': { value: 1.08 },
            },
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.twrHoldings.length).toBe(1);
      expect(result.twrHoldings[0]?.security_id).toBe('sec456');
      expect(result.twrHoldings[0]?.month).toBe('2024-01');
      expect(result.twrHoldings[0]?.history).toBeDefined();
    });

    test('decodes plaid accounts via decodeAllCollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'plaid-acc-db');
      // Plaid account docs sit at items/{item_id}/accounts/{account_id} in Firestore.
      // The routing requires collection.includes('/accounts/') which needs the full path.
      // Using binary keys so the parser reconstructs the full collection path.
      await createDeepTestDatabase(dbPath, [
        {
          collection: 'items/item1/accounts/pacc1',
          id: 'data',
          fields: {
            account_id: 'acc_plaid_1',
            name: 'Plaid Checking',
            official_name: 'CHECKING ACCT',
            mask: '1234',
            account_type: 'depository',
            subtype: 'checking',
            iso_currency_code: 'USD',
            current_balance: 5000,
            available_balance: 4800,
            limit: null,
            holdings: [
              {
                security_id: 'sec1',
                quantity: 10,
                cost_basis: 1500,
              },
            ],
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.plaidAccounts.length).toBe(1);
      expect(result.plaidAccounts[0]?.plaid_account_id).toBe('data');
      expect(result.plaidAccounts[0]?.item_id).toBe('item1');
      expect(result.plaidAccounts[0]?.name).toBe('Plaid Checking');
      expect(result.plaidAccounts[0]?.official_name).toBe('CHECKING ACCT');
      expect(result.plaidAccounts[0]?.mask).toBe('1234');
      expect(result.plaidAccounts[0]?.account_type).toBe('depository');
      expect(result.plaidAccounts[0]?.subtype).toBe('checking');
      expect(result.plaidAccounts[0]?.iso_currency_code).toBe('USD');
      expect(result.plaidAccounts[0]?.current_balance).toBe(5000);
      expect(result.plaidAccounts[0]?.available_balance).toBe(4800);
      expect(result.plaidAccounts[0]?.limit).toBeNull();
      expect(result.plaidAccounts[0]?.holdings).toHaveLength(1);
    });

    test('decodes tags via decodeAllCollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'tags-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'users/user1/tags',
          id: 'tag1',
          fields: {
            name: 'Travel',
            color_name: 'blue',
            hex_color: '#0000FF',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.tags.length).toBe(1);
      expect(result.tags[0]?.tag_id).toBe('tag1');
      expect(result.tags[0]?.name).toBe('Travel');
      expect(result.tags[0]?.color_name).toBe('blue');
      expect(result.tags[0]?.hex_color).toBe('#0000FF');
    });

    test('decodes balance history via decodeAllCollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'balance-hist-db');
      await createDeepTestDatabase(dbPath, [
        {
          collection: 'items/item1/accounts/acc1/balance_history',
          id: '2024-01-15',
          fields: {
            current_balance: 5000,
            available_balance: 4800,
            limit: null,
          },
        },
        {
          collection: 'items/item1/accounts/acc1/balance_history',
          id: '2024-01-10',
          fields: {
            current_balance: 4500,
          },
        },
        {
          collection: 'items/item1/accounts/acc2/balance_history',
          id: '2024-01-16',
          fields: {
            current_balance: 3000,
            available_balance: 2800,
          },
        },
        // Invalid date format doc ID - should be skipped
        {
          collection: 'items/item1/accounts/acc1/balance_history',
          id: 'not-a-date',
          fields: {
            current_balance: 1000,
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      // Should skip the invalid date doc, keep 3 valid entries
      expect(result.balanceHistory.length).toBe(3);
      // Should be sorted by account_id then date desc
      expect(result.balanceHistory[0]?.account_id).toBe('acc1');
      expect(result.balanceHistory[0]?.date).toBe('2024-01-15');
      expect(result.balanceHistory[0]?.current_balance).toBe(5000);
      expect(result.balanceHistory[0]?.limit).toBeNull();
      expect(result.balanceHistory[1]?.account_id).toBe('acc1');
      expect(result.balanceHistory[1]?.date).toBe('2024-01-10');
      expect(result.balanceHistory[2]?.account_id).toBe('acc2');
    });

    test('decodes holdings history meta via decodeAllCollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'hh-meta-db');
      await createDeepTestDatabase(dbPath, [
        {
          collection: 'items/item1/accounts/acc1/holdings_history',
          id: 'sechash1',
          fields: {
            some_field: 'some_value',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.holdingsHistoryMeta.length).toBe(1);
      expect(result.holdingsHistoryMeta[0]?.holdings_history_id).toBe('sechash1');
      expect(result.holdingsHistoryMeta[0]?.security_id).toBe('sechash1');
      expect(result.holdingsHistoryMeta[0]?.item_id).toBe('item1');
      expect(result.holdingsHistoryMeta[0]?.account_id).toBe('acc1');
    });

    test('decodes holdings history via decodeAllCollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'hh-history-db');
      await createDeepTestDatabase(dbPath, [
        {
          collection: 'items/item1/accounts/acc1/holdings_history/sechash1/history',
          id: '2024-01',
          fields: {
            history: {
              '1705276800000': { price: 150.5, quantity: 10 },
              '1705363200000': { price: 152.0, quantity: 10 },
            },
            extra_field: 'extra_value',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.holdingsHistory.length).toBe(1);
      expect(result.holdingsHistory[0]?.security_id).toBe('sechash1');
      expect(result.holdingsHistory[0]?.month).toBe('2024-01');
      expect(result.holdingsHistory[0]?.item_id).toBe('item1');
      expect(result.holdingsHistory[0]?.account_id).toBe('acc1');
      expect(result.holdingsHistory[0]?.history).toBeDefined();
    });

    test('decodes changes and sub-changes via decodeAllCollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'changes-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'changes',
          id: 'change1',
          fields: {
            timestamp: '2024-01-15T10:00:00Z',
          },
        },
        {
          collection: 'changes/change1/t',
          id: 'tc1',
          fields: {
            action: 'create',
          },
        },
        {
          collection: 'changes/change1/a',
          id: 'ac1',
          fields: {
            action: 'update',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.changes.length).toBe(1);
      expect(result.changes[0]?.change_id).toBe('change1');

      expect(result.transactionChanges.length).toBe(1);
      expect(result.transactionChanges[0]?.change_id).toBe('tc1');
      expect(result.transactionChanges[0]?.parent_change_id).toBe('change1');

      expect(result.accountChanges.length).toBe(1);
      expect(result.accountChanges[0]?.change_id).toBe('ac1');
      expect(result.accountChanges[0]?.parent_change_id).toBe('change1');
    });

    test('decodes securities via decodeAllCollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'securities-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'securities',
          id: 'sec1',
          fields: {
            ticker_symbol: 'AAPL',
            name: 'Apple Inc.',
            type: 'equity',
            provider_type: 'plaid',
            close_price: 190.5,
            current_price: 191.0,
            close_price_as_of: '2024-01-15',
            iso_currency_code: 'USD',
            isin: 'US0378331005',
            cusip: '037833100',
            sedol: null,
            institution_id: null,
            institution_security_id: null,
            market_identifier_code: 'XNAS',
            last_update: '2024-01-15',
            next_update: '2024-01-16',
            update_frequency: 86400,
            source: 'plaid',
            unofficial_currency_code: null,
            cik: '0000320193',
            proxy_security_id: null,
            is_cash_equivalent: false,
            comparison: true,
            trades_24_7: false,
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.securities.length).toBe(1);
      expect(result.securities[0]?.security_id).toBe('sec1');
      expect(result.securities[0]?.ticker_symbol).toBe('AAPL');
      expect(result.securities[0]?.name).toBe('Apple Inc.');
      expect(result.securities[0]?.close_price).toBe(190.5);
      expect(result.securities[0]?.is_cash_equivalent).toBe(false);
      expect(result.securities[0]?.comparison).toBe(true);
    });

    test('decodes user profiles via decodeAllCollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'user-profiles-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'users',
          id: 'user1',
          fields: {
            public_id: 'pub123',
            last_cold_open: '2024-01-15',
            last_warm_open: '2024-01-15',
            last_month_reviewed: '2024-01',
            last_year_reviewed: '2024',
            account_creation_timestamp: '2023-01-01',
            onboarding_completed_timestamp: '2023-01-02',
            onboarding_last_completed_step: 'connect_bank',
            service_ends_on_ms: 1705276800000,
            items_disconnect_on_ms: 1705363200000,
            intelligence_categories_review_count: 5,
            budgeting_enabled: true,
            authentication_required: false,
            data_initialized: true,
            onboarding_completed: true,
            logged_out: false,
            match_internal_txs_enabled: true,
            rollovers_enabled: false,
            investments_performance_initialized: true,
            finance_goals_monthly_summary_mode_enabled: false,
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.userProfiles.length).toBe(1);
      expect(result.userProfiles[0]?.user_id).toBe('user1');
      expect(result.userProfiles[0]?.public_id).toBe('pub123');
      expect(result.userProfiles[0]?.budgeting_enabled).toBe(true);
      expect(result.userProfiles[0]?.service_ends_on_ms).toBe(1705276800000);
    });

    test('skips empty user profile docs (sentinel docs)', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'user-profiles-empty-db');
      await createTestDatabase(dbPath, [
        // Sentinel doc with no fields - should be skipped by processUserProfile
        {
          collection: 'users',
          id: 'user_sentinel',
          fields: {},
        },
        {
          collection: 'users',
          id: 'user2',
          fields: {
            public_id: 'pub456',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      // Only the non-empty doc should be included
      expect(result.userProfiles.length).toBe(1);
      expect(result.userProfiles[0]?.user_id).toBe('user2');
    });

    test('decodes amazon integrations via decodeAllCollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'amazon-int-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'amazon',
          id: 'amz1',
          fields: {
            status: 'connected',
            email: 'user@example.com',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.amazonIntegrations.length).toBe(1);
      expect(result.amazonIntegrations[0]?.amazon_id).toBe('amz1');
    });

    test('decodes amazon orders via decodeAllCollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'amazon-orders-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'amazon/user1/orders',
          id: 'order1',
          fields: {
            date: '2024-01-20',
            account_id: 'acc1',
            match_state: 'matched',
            items: [
              {
                id: 'item1',
                name: 'Widget',
                price: 29.99,
                quantity: 1,
                link: 'https://amzn.to/xyz',
              },
            ],
            details: {
              beforeTax: 29.99,
              shipping: 0,
              subtotal: 29.99,
              tax: 2.4,
              total: 32.39,
            },
            payment: {
              card: 'Visa ending 4242',
            },
            transactions: ['txn1', 'txn2'],
          },
        },
        {
          collection: 'amazon/user1/orders',
          id: 'order2',
          fields: {
            date: '2024-01-25',
            account_id: 'acc1',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.amazonOrders.length).toBe(2);
      // Sorted by date desc
      expect(result.amazonOrders[0]?.date).toBe('2024-01-25');
      expect(result.amazonOrders[1]?.date).toBe('2024-01-20');
      expect(result.amazonOrders[1]?.amazon_user_id).toBe('user1');
      expect(result.amazonOrders[1]?.items).toHaveLength(1);
      expect(result.amazonOrders[1]?.details?.total).toBe(32.39);
      expect(result.amazonOrders[1]?.payment?.card).toBe('Visa ending 4242');
      expect(result.amazonOrders[1]?.transactions).toEqual(['txn1', 'txn2']);
    });

    test('decodes subscriptions via decodeAllCollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'subscriptions-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'subscriptions',
          id: 'sub1',
          fields: {
            product_id: 'com.copilot.annual',
            provider: 'apple',
            environment: 'production',
            user_id: 'user1',
            expires_date_ms: '1705276800000',
            created_timestamp: '2023-01-01T00:00:00Z',
            original_transaction_id: 'txn_orig_1',
            price: 99.99,
            will_auto_renew: true,
            is_eligible_for_initial_offer: false,
            extra_field: 'extra_value',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.subscriptions.length).toBe(1);
      expect(result.subscriptions[0]?.subscription_id).toBe('sub1');
      expect(result.subscriptions[0]?.product_id).toBe('com.copilot.annual');
      expect(result.subscriptions[0]?.provider).toBe('apple');
      expect(result.subscriptions[0]?.price).toBe(99.99);
      expect(result.subscriptions[0]?.will_auto_renew).toBe(true);
      expect(result.subscriptions[0]?.is_eligible_for_initial_offer).toBe(false);
      expect(result.subscriptions[0]?.expires_date_ms).toBe('1705276800000');
    });

    test('decodes invites via decodeAllCollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'invites-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'invites',
          id: 'inv1',
          fields: {
            code: 'ABCD1234',
            inviter_id: 'user1',
            product_id: 'com.copilot.annual',
            is_available: true,
            is_unlimited: false,
            assigned: false,
            offer_reviewed: true,
            extra_field: 'extra_value',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.invites.length).toBe(1);
      expect(result.invites[0]?.invite_id).toBe('inv1');
      expect(result.invites[0]?.code).toBe('ABCD1234');
      expect(result.invites[0]?.inviter_id).toBe('user1');
      expect(result.invites[0]?.is_available).toBe(true);
      expect(result.invites[0]?.is_unlimited).toBe(false);
      expect(result.invites[0]?.assigned).toBe(false);
      expect(result.invites[0]?.offer_reviewed).toBe(true);
    });

    test('decodes user_items via decodeAllCollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'user-items-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'user_items',
          id: 'ui1',
          fields: {
            some_field: 'some_value',
            another_field: 42,
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.userItems.length).toBe(1);
      expect(result.userItems[0]?.user_items_id).toBe('ui1');
    });

    test('decodes feature_tracking via decodeAllCollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'feature-tracking-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'feature_tracking',
          id: 'ft1',
          fields: {
            feature_name: 'dark_mode',
            enabled: true,
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.featureTracking.length).toBe(1);
      expect(result.featureTracking[0]?.feature_tracking_id).toBe('ft1');
    });

    test('decodes support docs via decodeAllCollections', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'support-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'support',
          id: 'sup1',
          fields: {
            topic: 'billing',
            status: 'resolved',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.supportDocs.length).toBe(1);
      expect(result.supportDocs[0]?.support_id).toBe('sup1');
    });

    test('handles financial_goals sentinel docs (parent pointers)', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'fg-sentinel-db');
      // Sentinel docs exist at users/{uid}/financial_goals/{goal_id} — these are
      // parent-pointer docs that anchor the financial_goal_history subcollection.
      // The collection path includes '/financial_goals/' and does NOT end with
      // '/financial_goal_history', so they match the sentinel routing branch.
      await createDeepTestDatabase(dbPath, [
        // Sentinel doc: collection is users/user1/financial_goals/goal1, doc is a leaf
        {
          collection: 'users/user1/financial_goals/goal1',
          id: 'sentinel',
          fields: {},
        },
        // Actual goal history under the subcollection
        {
          collection: 'users/user1/financial_goals/goal1/financial_goal_history',
          id: '2024-01',
          fields: {
            goal_id: 'goal1',
            current_amount: 5000,
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      // The sentinel doc should be silently consumed without errors
      // The goal history should still be decoded
      expect(result.goalHistory.length).toBe(1);
      expect(result.goalHistory[0]?.goal_id).toBe('goal1');
    });

    test('decodes goal with savings map', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'goal-savings-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'financial_goals',
          id: 'goal1',
          fields: {
            goal_id: 'goal1',
            name: 'Emergency Fund',
            emoji: '🏦',
            created_date: '2024-01-01',
            user_id: 'user1',
            recommendation_id: 'emergency-fund',
            created_with_allocations: true,
            savings: {
              type: 'savings',
              status: 'active',
              tracking_type: 'monthly_contribution',
              start_date: '2024-01-01',
              target_amount: 10000,
              tracking_type_monthly_contribution: 500,
              modified_start_date: false,
              inflates_budget: true,
              is_ongoing: false,
            },
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.goals.length).toBe(1);
      expect(result.goals[0]?.name).toBe('Emergency Fund');
      expect(result.goals[0]?.savings).toBeDefined();
      expect(result.goals[0]?.savings?.type).toBe('savings');
      expect(result.goals[0]?.savings?.status).toBe('active');
      expect(result.goals[0]?.savings?.tracking_type).toBe('monthly_contribution');
      expect(result.goals[0]?.savings?.start_date).toBe('2024-01-01');
      expect(result.goals[0]?.savings?.target_amount).toBe(10000);
      expect(result.goals[0]?.savings?.tracking_type_monthly_contribution).toBe(500);
      expect(result.goals[0]?.savings?.modified_start_date).toBe(false);
      expect(result.goals[0]?.savings?.inflates_budget).toBe(true);
      expect(result.goals[0]?.savings?.is_ongoing).toBe(false);
      expect(result.goals[0]?.created_with_allocations).toBe(true);
    });

    test('goal history sorting with multiple goals and months', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'goal-hist-sort-db');
      await createDeepTestDatabase(dbPath, [
        {
          collection: 'users/user1/financial_goals/goalB/financial_goal_history',
          id: '2024-01',
          fields: { goal_id: 'goalB', current_amount: 1000 },
        },
        {
          collection: 'users/user1/financial_goals/goalA/financial_goal_history',
          id: '2024-02',
          fields: { goal_id: 'goalA', current_amount: 3000 },
        },
        {
          collection: 'users/user1/financial_goals/goalA/financial_goal_history',
          id: '2024-01',
          fields: { goal_id: 'goalA', current_amount: 2000 },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      // goalA:2024-01, goalA:2024-02, goalB:2024-01 = 3
      expect(result.goalHistory.length).toBe(3);
      // Sorted by goal_id asc, then month desc
      expect(result.goalHistory[0]?.goal_id).toBe('goalA');
      expect(result.goalHistory[0]?.month).toBe('2024-02');
      expect(result.goalHistory[1]?.goal_id).toBe('goalA');
      expect(result.goalHistory[1]?.month).toBe('2024-01');
      expect(result.goalHistory[2]?.goal_id).toBe('goalB');
      expect(result.goalHistory[2]?.month).toBe('2024-01');
    });

    test('items sorting by institution_name then item_id', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'items-sort-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'items',
          id: 'item2',
          fields: { item_id: 'item2', institution_name: 'Chase' },
        },
        {
          collection: 'items',
          id: 'item1',
          fields: { item_id: 'item1', institution_name: 'Chase' },
        },
        {
          collection: 'items',
          id: 'item3',
          fields: { item_id: 'item3', institution_name: 'Bank of America' },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.items.length).toBe(3);
      expect(result.items[0]?.institution_name).toBe('Bank of America');
      expect(result.items[1]?.item_id).toBe('item1');
      expect(result.items[2]?.item_id).toBe('item2');
    });

    test('categories sorting by order then name', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'categories-sort-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'categories',
          id: 'cat3',
          fields: {
            category_id: 'cat3',
            name: 'Zebra Category',
            order: 1,
          },
        },
        {
          collection: 'categories',
          id: 'cat1',
          fields: {
            category_id: 'cat1',
            name: 'Alpha Category',
            order: 1,
          },
        },
        {
          collection: 'categories',
          id: 'cat2',
          fields: {
            category_id: 'cat2',
            name: 'Beta Category',
            order: 2,
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.categories.length).toBe(3);
      // Same order -> sorted by name
      expect(result.categories[0]?.name).toBe('Alpha Category');
      expect(result.categories[1]?.name).toBe('Zebra Category');
      // Different order
      expect(result.categories[2]?.name).toBe('Beta Category');
    });
  });

  describe('getDecodeTimeoutMs', () => {
    test('returns default timeout when env var is not set', () => {
      const original = process.env.DECODE_TIMEOUT_MS;
      delete process.env.DECODE_TIMEOUT_MS;

      expect(getDecodeTimeoutMs()).toBe(90_000);

      if (original !== undefined) process.env.DECODE_TIMEOUT_MS = original;
    });

    test('returns custom timeout from env var', () => {
      const original = process.env.DECODE_TIMEOUT_MS;
      process.env.DECODE_TIMEOUT_MS = '30000';

      expect(getDecodeTimeoutMs()).toBe(30000);

      if (original !== undefined) {
        process.env.DECODE_TIMEOUT_MS = original;
      } else {
        delete process.env.DECODE_TIMEOUT_MS;
      }
    });

    test('returns default timeout when env var is invalid', () => {
      const original = process.env.DECODE_TIMEOUT_MS;
      process.env.DECODE_TIMEOUT_MS = 'not-a-number';

      expect(getDecodeTimeoutMs()).toBe(90_000);

      if (original !== undefined) {
        process.env.DECODE_TIMEOUT_MS = original;
      } else {
        delete process.env.DECODE_TIMEOUT_MS;
      }
    });

    test('returns default timeout when env var is zero', () => {
      const original = process.env.DECODE_TIMEOUT_MS;
      process.env.DECODE_TIMEOUT_MS = '0';

      expect(getDecodeTimeoutMs()).toBe(90_000);

      if (original !== undefined) {
        process.env.DECODE_TIMEOUT_MS = original;
      } else {
        delete process.env.DECODE_TIMEOUT_MS;
      }
    });

    test('returns default timeout when env var is negative', () => {
      const original = process.env.DECODE_TIMEOUT_MS;
      process.env.DECODE_TIMEOUT_MS = '-5000';

      expect(getDecodeTimeoutMs()).toBe(90_000);

      if (original !== undefined) {
        process.env.DECODE_TIMEOUT_MS = original;
      } else {
        delete process.env.DECODE_TIMEOUT_MS;
      }
    });
  });

  describe('decodeAllCollectionsIsolated', () => {
    test('decodes via worker thread and returns results', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'isolated-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'transactions',
          id: 'txn1',
          fields: {
            transaction_id: 'txn1',
            amount: 50.0,
            date: '2024-01-15',
            name: 'Test Transaction',
          },
        },
        {
          collection: 'accounts',
          id: 'acc1',
          fields: {
            account_id: 'acc1',
            name: 'Test Account',
            current_balance: 1000,
          },
        },
      ]);

      const { decodeAllCollectionsIsolated } = await import('../../src/core/decoder.js');
      const result = await decodeAllCollectionsIsolated(dbPath);

      expect(result.transactions.length).toBe(1);
      expect(result.transactions[0]?.name).toBe('Test Transaction');
      expect(result.accounts.length).toBe(1);
      expect(result.accounts[0]?.name).toBe('Test Account');
    }, 30_000);

    test('rejects on timeout', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'isolated-timeout-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'transactions',
          id: 'txn1',
          fields: {
            transaction_id: 'txn1',
            amount: 50.0,
            date: '2024-01-15',
            name: 'Test',
          },
        },
      ]);

      const { decodeAllCollectionsIsolated } = await import('../../src/core/decoder.js');
      // 1ms timeout — worker can't possibly finish in time
      await expect(decodeAllCollectionsIsolated(dbPath, 1)).rejects.toThrow('timed out');
    }, 30_000);
  });

  describe('Firestore timestamp and reference encoding', () => {
    test('transactions with timestamp-typed date field', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'timestamp-date-db');
      // Use the __type marker to encode a real Firestore timestamp
      await createTestDatabase(dbPath, [
        {
          collection: 'transactions',
          id: 'txn1',
          fields: {
            transaction_id: 'txn1',
            amount: 50.0,
            // Firestore timestamp for 2024-01-15T00:00:00Z
            date: { __type: 'timestamp', seconds: 1705276800, nanos: 0 },
            name: 'Timestamp Test',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.transactions.length).toBe(1);
      expect(result.transactions[0]?.date).toBe('2024-01-15');
      expect(result.transactions[0]?.name).toBe('Timestamp Test');
    });

    test('account with reference-typed account_id field', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'reference-field-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'accounts',
          id: 'acc1',
          fields: {
            // Reference type — getString() handles this (line 110-111)
            account_id: {
              __type: 'reference',
              value: 'projects/copilot/databases/default/documents/accounts/acc1',
            },
            name: 'Reference Account',
            current_balance: 500.0,
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.accounts.length).toBe(1);
      // getString extracts the reference value as a string
      expect(result.accounts[0]?.account_id).toContain('acc1');
    });
  });

  describe('camelCase fallback fields', () => {
    test('investment performance with camelCase field names', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'camelcase-perf-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'investment_performance',
          id: 'perf1',
          fields: {
            // Use camelCase variants that the decoder falls back to
            securityId: 'sec123',
            userId: 'user456',
            lastUpdate: '2024-01-15',
            type: 'twr',
            position: 1,
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.investmentPerformance.length).toBe(1);
      expect(result.investmentPerformance[0]?.security_id).toBe('sec123');
      expect(result.investmentPerformance[0]?.user_id).toBe('user456');
      expect(result.investmentPerformance[0]?.last_update).toBe('2024-01-15');
    });
  });

  describe('original_* fallback fields', () => {
    test('account with original_current_balance fallback', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'original-balance-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'accounts',
          id: 'acc1',
          fields: {
            account_id: 'acc1',
            name: 'Fallback Account',
            // No current_balance — should fall back to original_current_balance
            original_current_balance: 1234.56,
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.accounts.length).toBe(1);
      expect(result.accounts[0]?.current_balance).toBe(1234.56);
    });

    test('account with original_type and original_subtype fallbacks', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'original-type-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'accounts',
          id: 'acc1',
          fields: {
            account_id: 'acc1',
            name: 'Type Fallback Account',
            current_balance: 100.0,
            // No type/account_type — fall back to original_type
            original_type: 'depository',
            // No subtype — fall back to original_subtype
            original_subtype: 'checking',
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.accounts.length).toBe(1);
      expect(result.accounts[0]?.account_type).toBe('depository');
      expect(result.accounts[0]?.subtype).toBe('checking');
    });
  });

  describe('goal history with daily_data and total_contribution', () => {
    test('goal history with daily_data map and total_contribution', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'goal-history-daily-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'financial_goals/goal1/financial_goal_history',
          id: '2024-01',
          fields: {
            goal_id: 'goal1',
            total_contribution: 500,
            target_amount: 10000,
            daily_data: {
              '2024-01-15': { balance: 5000 },
              '2024-01-20': { balance: 5500 },
            },
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.goalHistory.length).toBe(1);
      const gh = result.goalHistory[0]!;
      expect(gh.total_contribution).toBe(500);
      expect(gh.target_amount).toBe(10000);
      // current_amount should be derived from latest daily_data entry
      expect(gh.current_amount).toBe(5500);
      // daily_data should have 2 entries
      expect(gh.daily_data).toBeDefined();
      expect(Object.keys(gh.daily_data!).length).toBe(2);
      expect(gh.daily_data!['2024-01-20']?.amount).toBe(5500);
    });

    test('goal history with current_amount takes precedence over daily_data', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'goal-history-explicit-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'financial_goals/goal1/financial_goal_history',
          id: '2024-02',
          fields: {
            goal_id: 'goal1',
            current_amount: 7000,
            daily_data: {
              '2024-02-15': { balance: 6000 },
            },
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.goalHistory.length).toBe(1);
      // Explicit current_amount should NOT be overridden by daily_data
      expect(result.goalHistory[0]?.current_amount).toBe(7000);
    });

    test('goal history with invalid month format is skipped', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'goal-history-bad-month-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'financial_goals/goal1/financial_goal_history',
          id: 'not-a-month', // Invalid format
          fields: {
            goal_id: 'goal1',
            current_amount: 5000,
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      expect(result.goalHistory.length).toBe(0);
    });
  });

  describe('sort comparators with equal primary keys', () => {
    test('investment prices sort by date when investment_id matches', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'sort-prices-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'investment_prices',
          id: 'p1',
          fields: { investment_id: 'inv1', price: 100, date: '2024-01-10' },
        },
        {
          collection: 'investment_prices',
          id: 'p2',
          fields: { investment_id: 'inv1', price: 110, date: '2024-01-20' },
        },
      ]);

      const prices = await decodeInvestmentPrices(dbPath);

      expect(prices.length).toBe(2);
      expect(prices[0]?.date).toBe('2024-01-20'); // newest first
      expect(prices[1]?.date).toBe('2024-01-10');
    });

    test('investment splits sort by ticker then date', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'sort-splits-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'investment_splits',
          id: 's1',
          fields: { split_id: 's1', ticker_symbol: 'GOOGL', split_date: '2024-01-10' },
        },
        {
          collection: 'investment_splits',
          id: 's2',
          fields: { split_id: 's2', ticker_symbol: 'AAPL', split_date: '2024-01-20' },
        },
        {
          collection: 'investment_splits',
          id: 's3',
          fields: { split_id: 's3', ticker_symbol: 'AAPL', split_date: '2024-01-10' },
        },
      ]);

      const splits = await decodeInvestmentSplits(dbPath);

      expect(splits.length).toBe(3);
      // AAPL first (alphabetical), newest date first
      expect(splits[0]?.ticker_symbol).toBe('AAPL');
      expect(splits[0]?.split_date).toBe('2024-01-20');
      expect(splits[1]?.ticker_symbol).toBe('AAPL');
      expect(splits[1]?.split_date).toBe('2024-01-10');
      expect(splits[2]?.ticker_symbol).toBe('GOOGL');
    });

    test('items sort by institution_name then item_id', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'sort-items-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'items',
          id: 'item_b',
          fields: { item_id: 'item_b', institution_name: 'Chase' },
        },
        {
          collection: 'items',
          id: 'item_a',
          fields: { item_id: 'item_a', institution_name: 'Chase' },
        },
        {
          collection: 'items',
          id: 'item_c',
          fields: { item_id: 'item_c', institution_name: 'Bank of America' },
        },
      ]);

      const items = await decodeItems(dbPath);

      expect(items.length).toBe(3);
      // Bank of America first (alphabetical), then Chase items by item_id
      expect(items[0]?.institution_name).toBe('Bank of America');
      expect(items[1]?.item_id).toBe('item_a');
      expect(items[2]?.item_id).toBe('item_b');
    });

    test('categories sort by order then name', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'sort-categories-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'categories',
          id: 'cat_b',
          fields: { category_id: 'cat_b', name: 'Zebra', order: 1 },
        },
        {
          collection: 'categories',
          id: 'cat_a',
          fields: { category_id: 'cat_a', name: 'Apple', order: 1 },
        },
        {
          collection: 'categories',
          id: 'cat_c',
          fields: { category_id: 'cat_c', name: 'Middle', order: 0 },
        },
      ]);

      const categories = await decodeCategories(dbPath);

      expect(categories.length).toBe(3);
      // Order 0 first, then order 1 alphabetically
      expect(categories[0]?.name).toBe('Middle');
      expect(categories[1]?.name).toBe('Apple');
      expect(categories[2]?.name).toBe('Zebra');
    });
  });

  describe('balance history edge cases', () => {
    test('rejects balance history with bad collection path', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'bad-bh-path-db');
      // Path ends with /balance_history but has no items/{id}/accounts/{id} structure
      // Must use deep (binary) encoding so the full path is preserved
      await createDeepTestDatabase(dbPath, [
        {
          collection: 'something/other/balance_history',
          id: '2024-01-15',
          fields: { current_balance: 1000 },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      // processBalanceHistory returns null because path can't be parsed (no items/accounts)
      expect(result.balanceHistory.length).toBe(0);
    });
  });
});
