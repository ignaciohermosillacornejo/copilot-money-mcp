/**
 * Tests for recurring.ts to improve function coverage.
 */
import { describe, expect, test } from 'bun:test';
import {
  RecurringSchema,
  getRecurringDisplayName,
  KNOWN_FREQUENCIES,
  type Recurring,
  type KnownFrequency,
} from '../../src/models/recurring';

describe('recurring.ts', () => {
  describe('getRecurringDisplayName', () => {
    test('returns name when available', () => {
      const recurring: Recurring = {
        recurring_id: 'rec-1',
        name: 'Netflix',
        merchant_name: 'Netflix Inc',
      };
      expect(getRecurringDisplayName(recurring)).toBe('Netflix');
    });

    test('returns merchant_name when name is not available', () => {
      const recurring: Recurring = {
        recurring_id: 'rec-2',
        merchant_name: 'Spotify AB',
      };
      expect(getRecurringDisplayName(recurring)).toBe('Spotify AB');
    });

    test('returns Unknown when neither name nor merchant_name is available', () => {
      const recurring: Recurring = {
        recurring_id: 'rec-3',
      };
      expect(getRecurringDisplayName(recurring)).toBe('Unknown');
    });

    test('prefers name over merchant_name', () => {
      const recurring: Recurring = {
        recurring_id: 'rec-4',
        name: 'Custom Name',
        merchant_name: 'Original Merchant',
      };
      expect(getRecurringDisplayName(recurring)).toBe('Custom Name');
    });
  });

  describe('RecurringSchema', () => {
    test('validates minimal recurring with only required fields', () => {
      const result = RecurringSchema.safeParse({
        recurring_id: 'rec-1',
      });
      expect(result.success).toBe(true);
    });

    test('validates full recurring object', () => {
      const recurring = {
        recurring_id: 'rec-1',
        name: 'Netflix',
        merchant_name: 'Netflix Inc',
        amount: 15.99,
        frequency: 'monthly',
        next_date: '2024-02-01',
        last_date: '2024-01-01',
        category_id: 'cat-1',
        account_id: 'acc-1',
        is_active: true,
        iso_currency_code: 'USD',
      };
      const result = RecurringSchema.safeParse(recurring);
      expect(result.success).toBe(true);
    });

    test('rejects invalid date format for next_date', () => {
      const result = RecurringSchema.safeParse({
        recurring_id: 'rec-1',
        next_date: '01-02-2024', // wrong format
      });
      expect(result.success).toBe(false);
    });

    test('rejects invalid date format for last_date', () => {
      const result = RecurringSchema.safeParse({
        recurring_id: 'rec-1',
        last_date: '2024/01/01', // wrong format
      });
      expect(result.success).toBe(false);
    });

    test('rejects unknown properties (strict mode)', () => {
      const result = RecurringSchema.safeParse({
        recurring_id: 'rec-1',
        unknown_field: 'value',
      });
      expect(result.success).toBe(false);
    });

    test('validates all known frequency values', () => {
      for (const frequency of KNOWN_FREQUENCIES) {
        const result = RecurringSchema.safeParse({
          recurring_id: 'rec-1',
          frequency,
        });
        expect(result.success).toBe(true);
      }
    });

    test('rejects invalid frequency values', () => {
      const result = RecurringSchema.safeParse({
        recurring_id: 'rec-1',
        frequency: 'semi-annually', // not a valid enum value
      });
      expect(result.success).toBe(false);
    });
  });

  describe('KNOWN_FREQUENCIES', () => {
    test('contains expected frequency values', () => {
      expect(KNOWN_FREQUENCIES).toContain('daily');
      expect(KNOWN_FREQUENCIES).toContain('weekly');
      expect(KNOWN_FREQUENCIES).toContain('biweekly');
      expect(KNOWN_FREQUENCIES).toContain('monthly');
      expect(KNOWN_FREQUENCIES).toContain('quarterly');
      expect(KNOWN_FREQUENCIES).toContain('yearly');
    });

    test('has exactly 6 frequency values', () => {
      expect(KNOWN_FREQUENCIES.length).toBe(6);
    });
  });

  describe('KnownFrequency type', () => {
    test('allows assignment of valid frequencies', () => {
      const freq1: KnownFrequency = 'daily';
      const freq2: KnownFrequency = 'monthly';
      const freq3: KnownFrequency = 'yearly';
      expect(freq1).toBe('daily');
      expect(freq2).toBe('monthly');
      expect(freq3).toBe('yearly');
    });
  });
});
