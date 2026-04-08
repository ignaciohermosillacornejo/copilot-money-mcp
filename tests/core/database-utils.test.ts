/**
 * Unit tests for CopilotDatabase utility methods:
 * searchTransactions, getCacheInfo, checkCacheLimitation.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotDatabase } from '../../src/core/database.js';
import type { Transaction } from '../../src/models/index.js';

const mockTransactions: Transaction[] = [
  {
    transaction_id: 'txn1',
    amount: 50,
    date: '2025-01-15',
    name: 'Starbucks',
    original_name: 'Coffee Shop',
    category_id: 'food',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn2',
    amount: 120,
    date: '2025-01-20',
    name: 'Grocery Store',
    category_id: 'groceries',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn3',
    amount: 10,
    date: '2025-01-10',
    name: 'Parking Fee',
    category_id: 'transport',
    account_id: 'acc1',
  },
];

describe('searchTransactions', () => {
  let db: CopilotDatabase;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    db._injectDataForTesting({ transactions: [...mockTransactions] });
  });

  test('finds transactions by name (case-insensitive)', async () => {
    const results = await db.searchTransactions('starbucks');
    expect(results).toHaveLength(1);
    expect(results[0].transaction_id).toBe('txn1');
  });

  test('returns empty array when no match', async () => {
    const results = await db.searchTransactions('nonexistent');
    expect(results).toHaveLength(0);
  });

  test('respects limit parameter', async () => {
    // All three transactions contain letters that would match a broad query
    // Use a partial match that hits multiple transactions
    const results = await db.searchTransactions('', 2);
    expect(results).toHaveLength(2);
  });

  test('uses display name (name takes priority over original_name)', async () => {
    // txn1 has name='Starbucks' and original_name='Coffee Shop'
    // getTransactionDisplayName returns name ?? original_name ?? 'Unknown'
    // So searching for 'Starbucks' (name) should match
    const byName = await db.searchTransactions('Starbucks');
    expect(byName).toHaveLength(1);
    expect(byName[0].transaction_id).toBe('txn1');

    // Searching for 'Coffee Shop' (original_name) should NOT match
    // because name is set and takes priority
    const byOriginal = await db.searchTransactions('Coffee Shop');
    expect(byOriginal).toHaveLength(0);

    // Verify fallback: a transaction with only original_name is searchable by it
    const dbFallback = new CopilotDatabase('/fake/path');
    dbFallback._injectDataForTesting({
      transactions: [
        {
          transaction_id: 'txn_fallback',
          amount: 5,
          date: '2025-02-01',
          original_name: 'Fallback Name',
          category_id: 'misc',
          account_id: 'acc1',
        },
      ],
    });
    const fallbackResults = await dbFallback.searchTransactions('Fallback');
    expect(fallbackResults).toHaveLength(1);
    expect(fallbackResults[0].transaction_id).toBe('txn_fallback');
  });
});

describe('getCacheInfo', () => {
  test('returns null dates and count 0 when no transactions', async () => {
    const db = new CopilotDatabase('/fake/path');
    db._injectDataForTesting({ transactions: [] });

    const info = await db.getCacheInfo();
    expect(info.oldest_transaction_date).toBeNull();
    expect(info.newest_transaction_date).toBeNull();
    expect(info.transaction_count).toBe(0);
    expect(info.cache_note).toContain('No transactions');
  });

  test('returns correct oldest/newest dates and count', async () => {
    const db = new CopilotDatabase('/fake/path');
    db._injectDataForTesting({ transactions: [...mockTransactions] });

    const info = await db.getCacheInfo();
    expect(info.oldest_transaction_date).toBe('2025-01-10');
    expect(info.newest_transaction_date).toBe('2025-01-20');
    expect(info.transaction_count).toBe(3);
    expect(info.cache_note).toContain('2025-01-10');
    expect(info.cache_note).toContain('2025-01-20');
  });

  test('handles single transaction', async () => {
    const db = new CopilotDatabase('/fake/path');
    db._injectDataForTesting({
      transactions: [
        {
          transaction_id: 'txn_only',
          amount: 42,
          date: '2025-03-01',
          name: 'Solo Transaction',
          category_id: 'misc',
          account_id: 'acc1',
        },
      ],
    });

    const info = await db.getCacheInfo();
    expect(info.oldest_transaction_date).toBe('2025-03-01');
    expect(info.newest_transaction_date).toBe('2025-03-01');
    expect(info.transaction_count).toBe(1);
  });
});

describe('checkCacheLimitation', () => {
  let db: CopilotDatabase;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    db._injectDataForTesting({ transactions: [...mockTransactions] });
  });

  test('returns null when no startDate provided', async () => {
    const result = await db.checkCacheLimitation();
    expect(result).toBeNull();
  });

  test('returns null when no transactions in cache', async () => {
    const emptyDb = new CopilotDatabase('/fake/path');
    emptyDb._injectDataForTesting({ transactions: [] });

    const result = await emptyDb.checkCacheLimitation('2024-01-01');
    expect(result).toBeNull();
  });

  test('returns null when startDate is within cache range', async () => {
    const result = await db.checkCacheLimitation('2025-01-12');
    expect(result).toBeNull();
  });

  test('returns warning when startDate is before oldest cached transaction', async () => {
    const result = await db.checkCacheLimitation('2024-06-01');
    expect(result).not.toBeNull();
    expect(result).toContain('2024-06-01');
    expect(result).toContain('2025-01-10');
  });
});
