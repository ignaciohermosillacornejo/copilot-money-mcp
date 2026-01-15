/**
 * Tests for error handling paths in database.ts and decoder.ts.
 *
 * These tests focus on coverage for error conditions that are difficult
 * to trigger in normal operation.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotDatabase } from '../../src/core/database.js';
import { extractValue } from '../../src/core/decoder.js';
import type { FirestoreValue } from '../../src/core/protobuf-parser.js';

describe('CopilotDatabase error handling', () => {
  describe('requireDbPath error path', () => {
    test('getTransactions throws when dbPath is undefined and cache is empty', async () => {
      // Create database with no path specified - simulates auto-detection failure
      const db = new CopilotDatabase();

      // Force dbPath to be undefined (auto-detection will fail on test systems)
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;

      // Clear any cached data to force loading from disk
      // @ts-expect-error - accessing private property for testing
      db._transactions = null;

      await expect(db.getTransactions()).rejects.toThrow(
        'Database not found. Please ensure Copilot Money is installed and has synced data.'
      );
    });

    test('getAccounts throws when dbPath is undefined and cache is empty', async () => {
      const db = new CopilotDatabase();
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;
      // @ts-expect-error - accessing private property for testing
      db._accounts = null;

      await expect(db.getAccounts()).rejects.toThrow(
        'Database not found. Please ensure Copilot Money is installed and has synced data.'
      );
    });

    test('getRecurring throws when dbPath is undefined and cache is empty', async () => {
      const db = new CopilotDatabase();
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;
      // @ts-expect-error - accessing private property for testing
      db._recurring = null;

      await expect(db.getRecurring()).rejects.toThrow(
        'Database not found. Please ensure Copilot Money is installed and has synced data.'
      );
    });

    test('getBudgets throws when dbPath is undefined and cache is empty', async () => {
      const db = new CopilotDatabase();
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;
      // @ts-expect-error - accessing private property for testing
      db._budgets = null;

      await expect(db.getBudgets()).rejects.toThrow(
        'Database not found. Please ensure Copilot Money is installed and has synced data.'
      );
    });

    test('getGoals throws when dbPath is undefined and cache is empty', async () => {
      const db = new CopilotDatabase();
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;
      // @ts-expect-error - accessing private property for testing
      db._goals = null;

      await expect(db.getGoals()).rejects.toThrow(
        'Database not found. Please ensure Copilot Money is installed and has synced data.'
      );
    });

    test('getGoalHistory throws when dbPath is undefined and cache is empty', async () => {
      const db = new CopilotDatabase();
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;
      // @ts-expect-error - accessing private property for testing
      db._goalHistory = null;

      await expect(db.getGoalHistory()).rejects.toThrow(
        'Database not found. Please ensure Copilot Money is installed and has synced data.'
      );
    });

    test('getInvestmentPrices throws when dbPath is undefined and cache is empty', async () => {
      const db = new CopilotDatabase();
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;
      // @ts-expect-error - accessing private property for testing
      db._investmentPrices = null;

      await expect(db.getInvestmentPrices()).rejects.toThrow(
        'Database not found. Please ensure Copilot Money is installed and has synced data.'
      );
    });

    test('getInvestmentSplits throws when dbPath is undefined and cache is empty', async () => {
      const db = new CopilotDatabase();
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;
      // @ts-expect-error - accessing private property for testing
      db._investmentSplits = null;

      await expect(db.getInvestmentSplits()).rejects.toThrow(
        'Database not found. Please ensure Copilot Money is installed and has synced data.'
      );
    });

    test('getItems throws when dbPath is undefined and cache is empty', async () => {
      const db = new CopilotDatabase();
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;
      // @ts-expect-error - accessing private property for testing
      db._items = null;

      await expect(db.getItems()).rejects.toThrow(
        'Database not found. Please ensure Copilot Money is installed and has synced data.'
      );
    });

    test('getUserCategories throws when dbPath is undefined and cache is empty', async () => {
      const db = new CopilotDatabase();
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;
      // @ts-expect-error - accessing private property for testing
      db._userCategories = null;

      await expect(db.getUserCategories()).rejects.toThrow(
        'Database not found. Please ensure Copilot Money is installed and has synced data.'
      );
    });

    test('getUserAccounts throws when dbPath is undefined and cache is empty', async () => {
      const db = new CopilotDatabase();
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;
      // @ts-expect-error - accessing private property for testing
      db._userAccounts = null;

      await expect(db.getUserAccounts()).rejects.toThrow(
        'Database not found. Please ensure Copilot Money is installed and has synced data.'
      );
    });

    test('getCategoryNameMap throws when dbPath is undefined and cache is empty', async () => {
      const db = new CopilotDatabase();
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;
      // @ts-expect-error - accessing private property for testing
      db._categoryNameMap = null;
      // @ts-expect-error - accessing private property for testing
      db._userCategories = null;

      await expect(db.getCategoryNameMap()).rejects.toThrow(
        'Database not found. Please ensure Copilot Money is installed and has synced data.'
      );
    });

    test('getAccountNameMap throws when dbPath is undefined and cache is empty', async () => {
      const db = new CopilotDatabase();
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;
      // @ts-expect-error - accessing private property for testing
      db._accountNameMap = null;
      // @ts-expect-error - accessing private property for testing
      db._userAccounts = null;

      await expect(db.getAccountNameMap()).rejects.toThrow(
        'Database not found. Please ensure Copilot Money is installed and has synced data.'
      );
    });

    test('getCategories throws when dbPath is undefined and transaction cache is empty', async () => {
      const db = new CopilotDatabase();
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;
      // @ts-expect-error - accessing private property for testing
      db._transactions = null;
      // @ts-expect-error - accessing private property for testing
      db._userCategories = null;

      await expect(db.getCategories()).rejects.toThrow(
        'Database not found. Please ensure Copilot Money is installed and has synced data.'
      );
    });

    test('getAllTransactions throws when dbPath is undefined and cache is empty', async () => {
      const db = new CopilotDatabase();
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;
      // @ts-expect-error - accessing private property for testing
      db._transactions = null;

      await expect(db.getAllTransactions()).rejects.toThrow(
        'Database not found. Please ensure Copilot Money is installed and has synced data.'
      );
    });

    test('searchTransactions throws when dbPath is undefined and cache is empty', async () => {
      const db = new CopilotDatabase();
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;
      // @ts-expect-error - accessing private property for testing
      db._transactions = null;

      await expect(db.searchTransactions('test')).rejects.toThrow(
        'Database not found. Please ensure Copilot Money is installed and has synced data.'
      );
    });
  });

  describe('isAvailable edge cases', () => {
    test('returns false when dbPath is null-ish', () => {
      const db = new CopilotDatabase();
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;
      expect(db.isAvailable()).toBe(false);

      // @ts-expect-error - setting to empty string
      db.dbPath = '';
      expect(db.isAvailable()).toBe(false);
    });
  });
});

describe('extractValue error handling', () => {
  test('returns undefined for unknown FirestoreValue type', () => {
    // Create a FirestoreValue with an unknown type to trigger the default case
    // This simulates a scenario where the Firestore SDK adds a new type we don't handle
    const unknownValue = {
      type: 'unknown_future_type',
      value: 'some data',
    } as unknown as FirestoreValue;

    const result = extractValue(unknownValue);
    expect(result).toBeUndefined();
  });

  test('returns undefined for malformed FirestoreValue object', () => {
    // Create a malformed value that doesn't match any known type
    const malformedValue = {
      type: 'not_a_real_type',
      value: { nested: 'data' },
    } as unknown as FirestoreValue;

    const result = extractValue(malformedValue);
    expect(result).toBeUndefined();
  });

  test('returns undefined for empty type string', () => {
    const emptyTypeValue = {
      type: '',
      value: 'data',
    } as unknown as FirestoreValue;

    const result = extractValue(emptyTypeValue);
    expect(result).toBeUndefined();
  });
});
