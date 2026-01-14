/**
 * Integration tests for the LevelDB-based decoder.
 *
 * These tests verify that the decoder properly reads from LevelDB databases.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import {
  decodeTransactions,
  decodeAccounts,
  decodeRecurring,
  decodeBudgets,
  decodeGoals,
  decodeGoalHistory,
  decodeCategories,
} from '../../src/core/decoder.js';
import {
  createTransactionDb,
  createAccountDb,
  createRecurringDb,
  createBudgetDb,
  createGoalDb,
  createGoalHistoryDb,
  createCategoryDb,
  createEmptyDb,
  cleanupTestDb,
  type TestTransaction,
  type TestAccount,
  type TestRecurring,
  type TestBudget,
  type TestGoal,
  type TestGoalHistory,
  type TestCategory,
} from '../helpers/test-db.js';
import path from 'node:path';
import fs from 'node:fs';

const FIXTURES_DIR = path.join(__dirname, '../fixtures/leveldb-tests');

// Cleanup all test databases after each test
afterEach(() => {
  if (fs.existsSync(FIXTURES_DIR)) {
    fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
  }
});

// Ensure fixtures directory exists
beforeEach(() => {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
});

describe('LevelDB Decoder', () => {
  describe('path validation', () => {
    test('throws error for non-existent path', async () => {
      await expect(decodeTransactions('/nonexistent/path/that/does/not/exist')).rejects.toThrow(
        'Database path not found'
      );
    });

    test('throws error for file instead of directory', async () => {
      const tempFile = path.join(FIXTURES_DIR, 'test-file.txt');
      fs.writeFileSync(tempFile, 'test');

      await expect(decodeTransactions(tempFile)).rejects.toThrow('Path is not a directory');
    });

    test('returns empty array for empty database', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'empty-db');
      await createEmptyDb(dbPath);

      const result = await decodeTransactions(dbPath);
      expect(result).toEqual([]);
    });
  });

  describe('decodeTransactions', () => {
    test('decodes a single transaction', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'single-txn-db');
      const transactions: TestTransaction[] = [
        {
          transaction_id: 'txn_001',
          account_id: 'acc_001',
          amount: 50.0,
          date: '2024-01-15',
          name: 'Coffee Shop',
          original_name: 'COFFEE SHOP LLC',
          category_id: 'cat_food',
        },
      ];

      await createTransactionDb(dbPath, transactions);
      const result = await decodeTransactions(dbPath);

      expect(result.length).toBe(1);
      expect(result[0]?.transaction_id).toBe('txn_001');
      expect(result[0]?.amount).toBe(50.0);
      expect(result[0]?.date).toBe('2024-01-15');
      expect(result[0]?.name).toBe('Coffee Shop');
    });

    test('decodes multiple transactions', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'multi-txn-db');
      const transactions: TestTransaction[] = [
        {
          transaction_id: 'txn_001',
          amount: 50.0,
          date: '2024-01-15',
          name: 'Coffee Shop',
        },
        {
          transaction_id: 'txn_002',
          amount: 100.0,
          date: '2024-01-16',
          name: 'Grocery Store',
        },
        {
          transaction_id: 'txn_003',
          amount: 25.5,
          date: '2024-01-17',
          name: 'Gas Station',
        },
      ];

      await createTransactionDb(dbPath, transactions);
      const result = await decodeTransactions(dbPath);

      expect(result.length).toBe(3);
    });

    test('skips transactions without required fields', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'incomplete-txn-db');
      const transactions: TestTransaction[] = [
        {
          transaction_id: 'txn_001',
          // Missing amount - should be skipped
          date: '2024-01-15',
          name: 'Missing Amount',
        },
        {
          transaction_id: 'txn_002',
          amount: 50.0,
          // Missing date - should be skipped
          name: 'Missing Date',
        },
        {
          transaction_id: 'txn_003',
          amount: 75.0,
          date: '2024-01-17',
          name: 'Complete Transaction',
        },
      ];

      await createTransactionDb(dbPath, transactions);
      const result = await decodeTransactions(dbPath);

      // Only the complete transaction should be returned
      expect(result.length).toBe(1);
      expect(result[0]?.transaction_id).toBe('txn_003');
    });

    test('skips transactions with zero amount', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'zero-amount-db');
      const transactions: TestTransaction[] = [
        {
          transaction_id: 'txn_001',
          amount: 0,
          date: '2024-01-15',
          name: 'Zero Amount',
        },
        {
          transaction_id: 'txn_002',
          amount: 50.0,
          date: '2024-01-16',
          name: 'Valid Amount',
        },
      ];

      await createTransactionDb(dbPath, transactions);
      const result = await decodeTransactions(dbPath);

      expect(result.length).toBe(1);
      expect(result[0]?.transaction_id).toBe('txn_002');
    });
  });

  describe('decodeAccounts', () => {
    test('decodes a single account', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'single-acc-db');
      const accounts: TestAccount[] = [
        {
          account_id: 'acc_001',
          name: 'Checking Account',
          account_type: 'depository',
          subtype: 'checking',
          current_balance: 1500.0,
          institution_name: 'Test Bank',
        },
      ];

      await createAccountDb(dbPath, accounts);
      const result = await decodeAccounts(dbPath);

      expect(result.length).toBe(1);
      expect(result[0]?.account_id).toBe('acc_001');
      expect(result[0]?.name).toBe('Checking Account');
      expect(result[0]?.current_balance).toBe(1500.0);
    });

    test('decodes multiple accounts', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'multi-acc-db');
      const accounts: TestAccount[] = [
        {
          account_id: 'acc_001',
          name: 'Checking',
          account_type: 'depository',
          current_balance: 1500.0,
        },
        {
          account_id: 'acc_002',
          name: 'Savings',
          account_type: 'depository',
          current_balance: 5000.0,
        },
        {
          account_id: 'acc_003',
          name: 'Credit Card',
          account_type: 'credit',
          current_balance: -500.0,
        },
      ];

      await createAccountDb(dbPath, accounts);
      const result = await decodeAccounts(dbPath);

      expect(result.length).toBe(3);
    });
  });

  describe('decodeRecurring', () => {
    test('decodes recurring transactions', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'recurring-db');
      const recurring: TestRecurring[] = [
        {
          recurring_id: 'rec_001',
          name: 'Netflix',
          amount: 15.99,
          frequency: 'monthly',
          next_date: '2024-02-01',
          is_active: true,
        },
        {
          recurring_id: 'rec_002',
          name: 'Gym Membership',
          amount: 50.0,
          frequency: 'monthly',
          next_date: '2024-02-15',
          is_active: true,
        },
      ];

      await createRecurringDb(dbPath, recurring);
      const result = await decodeRecurring(dbPath);

      expect(result.length).toBe(2);
      expect(result[0]?.recurring_id).toBe('rec_001');
    });
  });

  describe('decodeBudgets', () => {
    test('decodes budgets', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'budget-db');
      const budgets: TestBudget[] = [
        {
          budget_id: 'budget_001',
          category_id: 'cat_food',
          amount: 500.0,
          month: '2024-01',
          is_active: true,
        },
        {
          budget_id: 'budget_002',
          category_id: 'cat_entertainment',
          amount: 200.0,
          month: '2024-01',
          is_active: true,
        },
      ];

      await createBudgetDb(dbPath, budgets);
      const result = await decodeBudgets(dbPath);

      expect(result.length).toBe(2);
      expect(result[0]?.budget_id).toBe('budget_001');
    });
  });

  describe('decodeGoals', () => {
    test('decodes goals with basic fields', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'goal-db');
      // Goals in Firestore have a nested structure - testing minimal top-level fields
      const goals: TestGoal[] = [
        {
          goal_id: 'goal_001',
          name: 'Emergency Fund',
        },
      ];

      await createGoalDb(dbPath, goals);
      const result = await decodeGoals(dbPath);

      expect(result.length).toBe(1);
      expect(result[0]?.goal_id).toBe('goal_001');
      expect(result[0]?.name).toBe('Emergency Fund');
    });
  });

  describe('decodeCategories', () => {
    test('decodes user-defined categories', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'category-db');
      const categories: TestCategory[] = [
        {
          category_id: 'cat_001',
          name: 'Coffee',
          user_id: 'user_001',
        },
        {
          category_id: 'cat_002',
          name: 'Subscriptions',
          user_id: 'user_001',
        },
      ];

      await createCategoryDb(dbPath, categories);
      const result = await decodeCategories(dbPath);

      expect(result.length).toBe(2);
    });
  });
});
