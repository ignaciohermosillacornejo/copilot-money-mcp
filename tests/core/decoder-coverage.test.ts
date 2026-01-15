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
} from '../../src/core/decoder.js';
import { createTestDatabase, cleanupAllTempDatabases } from '../../src/core/leveldb-reader.js';
import type { FirestoreValue } from '../../src/core/protobuf-parser.js';
import path from 'node:path';
import fs from 'node:fs';

const FIXTURES_DIR = path.join(__dirname, '../fixtures/decoder-coverage-tests');

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

      expect(prices.length).toBeGreaterThan(0);
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
});
