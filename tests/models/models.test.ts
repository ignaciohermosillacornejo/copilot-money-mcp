/**
 * Unit tests for model helper functions.
 */

import { describe, test, expect } from 'bun:test';
import {
  getAccountDisplayName,
  withDisplayName as withAccountDisplayName,
  type Account,
} from '../../src/models/account.js';
import {
  getTransactionDisplayName,
  withDisplayName as withTransactionDisplayName,
  type Transaction,
} from '../../src/models/transaction.js';

describe('Account model helpers', () => {
  describe('getAccountDisplayName', () => {
    test('returns name when available', () => {
      const account: Account = {
        account_id: 'acc1',
        current_balance: 1000,
        name: 'My Checking',
        official_name: 'Official Checking Account',
      };

      expect(getAccountDisplayName(account)).toBe('My Checking');
    });

    test('returns official_name when name is not available', () => {
      const account: Account = {
        account_id: 'acc1',
        current_balance: 1000,
        official_name: 'Official Checking Account',
      };

      expect(getAccountDisplayName(account)).toBe('Official Checking Account');
    });

    test('returns "Unknown" when neither name nor official_name is available', () => {
      const account: Account = {
        account_id: 'acc1',
        current_balance: 1000,
      };

      expect(getAccountDisplayName(account)).toBe('Unknown');
    });
  });

  describe('withDisplayName (account)', () => {
    test('adds display_name field to account with name', () => {
      const account: Account = {
        account_id: 'acc1',
        current_balance: 1000,
        name: 'My Checking',
      };

      const result = withAccountDisplayName(account);

      expect(result.display_name).toBe('My Checking');
      expect(result.account_id).toBe('acc1');
      expect(result.current_balance).toBe(1000);
      expect(result.name).toBe('My Checking');
    });

    test('adds display_name field to account with official_name only', () => {
      const account: Account = {
        account_id: 'acc1',
        current_balance: 1000,
        official_name: 'Official Account',
      };

      const result = withAccountDisplayName(account);

      expect(result.display_name).toBe('Official Account');
      expect(result.account_id).toBe('acc1');
    });

    test('adds display_name "Unknown" when no names available', () => {
      const account: Account = {
        account_id: 'acc1',
        current_balance: 1000,
      };

      const result = withAccountDisplayName(account);

      expect(result.display_name).toBe('Unknown');
    });

    test('preserves all original account fields', () => {
      const account: Account = {
        account_id: 'acc1',
        current_balance: 1000,
        name: 'Test Account',
        account_type: 'checking',
        mask: '1234',
        institution_name: 'Test Bank',
      };

      const result = withAccountDisplayName(account);

      expect(result.account_id).toBe('acc1');
      expect(result.current_balance).toBe(1000);
      expect(result.name).toBe('Test Account');
      expect(result.account_type).toBe('checking');
      expect(result.mask).toBe('1234');
      expect(result.institution_name).toBe('Test Bank');
      expect(result.display_name).toBe('Test Account');
    });
  });
});

describe('Transaction model helpers', () => {
  describe('getTransactionDisplayName', () => {
    test('returns name when available', () => {
      const transaction: Transaction = {
        transaction_id: 'txn1',
        amount: 50,
        date: '2025-01-15',
        name: 'Starbucks',
        original_name: 'STARBUCKS #12345',
      };

      expect(getTransactionDisplayName(transaction)).toBe('Starbucks');
    });

    test('returns original_name when name is not available', () => {
      const transaction: Transaction = {
        transaction_id: 'txn1',
        amount: 50,
        date: '2025-01-15',
        original_name: 'STARBUCKS #12345',
      };

      expect(getTransactionDisplayName(transaction)).toBe('STARBUCKS #12345');
    });

    test('returns "Unknown" when neither name nor original_name is available', () => {
      const transaction: Transaction = {
        transaction_id: 'txn1',
        amount: 50,
        date: '2025-01-15',
      };

      expect(getTransactionDisplayName(transaction)).toBe('Unknown');
    });
  });

  describe('withDisplayName (transaction)', () => {
    test('adds display_name field to transaction with name', () => {
      const transaction: Transaction = {
        transaction_id: 'txn1',
        amount: 50,
        date: '2025-01-15',
        name: 'Starbucks',
      };

      const result = withTransactionDisplayName(transaction);

      expect(result.display_name).toBe('Starbucks');
      expect(result.transaction_id).toBe('txn1');
      expect(result.amount).toBe(50);
      expect(result.date).toBe('2025-01-15');
      expect(result.name).toBe('Starbucks');
    });

    test('adds display_name field to transaction with original_name only', () => {
      const transaction: Transaction = {
        transaction_id: 'txn1',
        amount: 50,
        date: '2025-01-15',
        original_name: 'STARBUCKS #12345',
      };

      const result = withTransactionDisplayName(transaction);

      expect(result.display_name).toBe('STARBUCKS #12345');
      expect(result.transaction_id).toBe('txn1');
    });

    test('adds display_name "Unknown" when no names available', () => {
      const transaction: Transaction = {
        transaction_id: 'txn1',
        amount: 50,
        date: '2025-01-15',
      };

      const result = withTransactionDisplayName(transaction);

      expect(result.display_name).toBe('Unknown');
    });

    test('preserves all original transaction fields', () => {
      const transaction: Transaction = {
        transaction_id: 'txn1',
        amount: 50,
        date: '2025-01-15',
        name: 'Starbucks',
        category_id: 'food_dining',
        account_id: 'acc1',
        pending: false,
        city: 'New York',
      };

      const result = withTransactionDisplayName(transaction);

      expect(result.transaction_id).toBe('txn1');
      expect(result.amount).toBe(50);
      expect(result.date).toBe('2025-01-15');
      expect(result.name).toBe('Starbucks');
      expect(result.category_id).toBe('food_dining');
      expect(result.account_id).toBe('acc1');
      expect(result.pending).toBe(false);
      expect(result.city).toBe('New York');
      expect(result.display_name).toBe('Starbucks');
    });
  });
});
