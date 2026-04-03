/**
 * Unit tests for BalanceHistory schema validation.
 */

import { describe, test, expect } from 'bun:test';
import { BalanceHistorySchema } from '../../src/models/balance-history.js';

describe('BalanceHistorySchema', () => {
  test('validates minimal document with required fields', () => {
    const result = BalanceHistorySchema.safeParse({
      balance_id: 'item-1:acc-1:2025-01-15',
      date: '2025-01-15',
      item_id: 'item-1',
      account_id: 'acc-1',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.balance_id).toBe('item-1:acc-1:2025-01-15');
      expect(result.data.date).toBe('2025-01-15');
      expect(result.data.item_id).toBe('item-1');
      expect(result.data.account_id).toBe('acc-1');
    }
  });

  test('validates full document with all fields', () => {
    const result = BalanceHistorySchema.safeParse({
      balance_id: 'item-1:acc-1:2025-01-15',
      date: '2025-01-15',
      item_id: 'item-1',
      account_id: 'acc-1',
      current_balance: 5000.5,
      available_balance: 4500.0,
      limit: 10000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.balance_id).toBe('item-1:acc-1:2025-01-15');
      expect(result.data.date).toBe('2025-01-15');
      expect(result.data.item_id).toBe('item-1');
      expect(result.data.account_id).toBe('acc-1');
      expect(result.data.current_balance).toBe(5000.5);
      expect(result.data.available_balance).toBe(4500.0);
      expect(result.data.limit).toBe(10000);
    }
  });

  test('allows null limit', () => {
    const result = BalanceHistorySchema.safeParse({
      balance_id: 'item-1:acc-1:2025-01-15',
      date: '2025-01-15',
      item_id: 'item-1',
      account_id: 'acc-1',
      limit: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBeNull();
    }
  });

  test('passes through unknown fields', () => {
    const result = BalanceHistorySchema.safeParse({
      balance_id: 'item-1:acc-1:2025-01-15',
      date: '2025-01-15',
      item_id: 'item-1',
      account_id: 'acc-1',
      some_future_field: 'hello',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).some_future_field).toBe('hello');
    }
  });

  test('rejects missing balance_id', () => {
    const result = BalanceHistorySchema.safeParse({
      date: '2025-01-15',
      current_balance: 5000,
    });
    expect(result.success).toBe(false);
  });
});
