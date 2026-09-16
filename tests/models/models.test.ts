/**
 * Unit tests for model helper functions.
 */

import { describe, test, expect } from 'bun:test';
import { preferredAccountName } from '../../src/models/account.js';
import {
  getTransactionDisplayName,
  withDisplayName as withTransactionDisplayName,
  type Transaction,
} from '../../src/models/transaction.js';

describe('Account model helpers', () => {
  describe('preferredAccountName', () => {
    // The canonical helper (#663). Before this block it was covered only
    // indirectly, through the four-surface parity tests, which exercised two
    // of its input classes. These tests pin the rest directly. Blank-vs-absent
    // is the axis worth the coverage: that is where the rule's trimmed
    // truthiness parts company with a nullish check, and where #663 went in
    // reverse.
    const base = { account_id: 'acc1', current_balance: 1000 } as const;

    test('nickname wins over both provider labels', () => {
      expect(
        preferredAccountName({ ...base, nickname: 'Rainy Day', name: 'N', official_name: 'O' })
      ).toBe('Rainy Day');
    });

    test('a BLANK nickname is not a name, so the provider label wins', () => {
      // Truthiness, not `??` — the #663-in-reverse bug was `'' ?? name` === ''.
      expect(preferredAccountName({ ...base, nickname: '', name: 'PROVIDER' })).toBe('PROVIDER');
    });

    test('a WHITESPACE-ONLY nickname is blank too', () => {
      // `'   '` is truthy, so bare truthiness would return it — and it is
      // exactly as unidentifiable as `''`, which is the reason the docblock
      // gives for treating blank as not-a-name. Nothing upstream trims:
      // `nickname` is z.string().optional() with no transform and the decoder
      // passes it through.
      expect(preferredAccountName({ ...base, nickname: '   ', name: 'PROVIDER' })).toBe('PROVIDER');
    });

    test('a nickname with surrounding space keeps its own spelling', () => {
      // Blank-detection trims; the returned value does not. Trimming the
      // answer would silently rewrite a name the user typed.
      expect(preferredAccountName({ ...base, nickname: ' Rainy Day ', name: 'P' })).toBe(
        ' Rainy Day '
      );
    });

    test('falls back to official_name when there is no name at all', () => {
      // `name` is optional on AccountSchema, so this shape is representable.
      expect(preferredAccountName({ ...base, official_name: 'OFFICIAL' })).toBe('OFFICIAL');
    });

    test('a BLANK provider `name` is not a name either, so official_name wins', () => {
      // The blank rule is about identifiability, so it holds for every input,
      // not only the nickname. `src/core/decoder.ts` drops an account only when
      // `name` AND `official_name` are both absent, so this shape reaches the
      // helper. Before the widening, `'   '` was truthy and beat a perfectly
      // good `official_name` — the same defect the nickname trim was added for,
      // one operand over.
      expect(preferredAccountName({ ...base, name: '   ', official_name: 'OFFICIAL' })).toBe(
        'OFFICIAL'
      );
      expect(preferredAccountName({ ...base, name: '', official_name: 'OFFICIAL' })).toBe(
        'OFFICIAL'
      );
    });

    test('a blank official_name is not a last resort — undefined beats whitespace', () => {
      // The end of the chain gets the rule too. Returning `'   '` here would
      // hand a caller a name that renders as nothing and compares equal to
      // nothing; `undefined` is the honest answer and the one the final test
      // below already pins for the empty case.
      expect(preferredAccountName({ ...base, official_name: '   ' })).toBeUndefined();
    });

    test('a provider name with surrounding space keeps its own spelling', () => {
      // Same asymmetry as the nickname case: blank-detection trims, the
      // returned value does not.
      expect(preferredAccountName({ ...base, name: ' Everyday ' })).toBe(' Everyday ');
    });

    test('returns undefined when nothing is set — it does NOT invent "Unknown"', () => {
      // A caller that wants a placeholder picks one; this helper says it
      // does not know.
      expect(preferredAccountName(base)).toBeUndefined();
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
