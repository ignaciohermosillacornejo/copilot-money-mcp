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

    test('deduplicates transactions by display name, amount, and date', async () => {
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
            name: 'Coffee Shop', // Same name/amount/date = duplicate
          },
        },
      ]);

      const result = await decodeAllCollections(dbPath);

      // Should be deduplicated to 1
      expect(result.transactions.length).toBe(1);
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
  });
});
