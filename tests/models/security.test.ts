/**
 * Unit tests for Security schema validation.
 */

import { describe, test, expect } from 'bun:test';
import { SecuritySchema } from '../../src/models/security.js';

describe('SecuritySchema', () => {
  test('validates minimal document with just security_id', () => {
    const result = SecuritySchema.safeParse({
      security_id: 'sec-abc123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.security_id).toBe('sec-abc123');
    }
  });

  test('validates full document with all fields', () => {
    const result = SecuritySchema.safeParse({
      security_id: 'sec-abc123',
      ticker_symbol: 'AAPL',
      name: 'Apple Inc.',
      type: 'equity',
      provider_type: 'plaid',
      close_price: 178.72,
      current_price: 179.5,
      close_price_as_of: '2025-03-28',
      is_cash_equivalent: false,
      iso_currency_code: 'USD',
      isin: 'US0378331005',
      cusip: '037833100',
      sedol: null,
      institution_id: 'ins-1',
      institution_security_id: 'inst-sec-1',
      market_identifier_code: 'XNAS',
      last_update: '2025-03-28T20:00:00Z',
      next_update: '2025-03-29T20:00:00Z',
      update_frequency: 86400,
      source: 'plaid',
      comparison: false,
      trades_24_7: false,
      unofficial_currency_code: null,
      cik: null,
      proxy_security_id: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.security_id).toBe('sec-abc123');
      expect(result.data.ticker_symbol).toBe('AAPL');
      expect(result.data.name).toBe('Apple Inc.');
      expect(result.data.type).toBe('equity');
      expect(result.data.close_price).toBe(178.72);
      expect(result.data.current_price).toBe(179.5);
      expect(result.data.is_cash_equivalent).toBe(false);
      expect(result.data.iso_currency_code).toBe('USD');
      expect(result.data.isin).toBe('US0378331005');
      expect(result.data.sedol).toBeNull();
    }
  });

  test('passes through unknown fields', () => {
    const result = SecuritySchema.safeParse({
      security_id: 'sec-abc123',
      some_future_field: 'hello',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).some_future_field).toBe('hello');
    }
  });

  test('validates cash equivalent security', () => {
    const result = SecuritySchema.safeParse({
      security_id: 'sec-cash-1',
      ticker_symbol: 'CUR:USD',
      name: 'US Dollar',
      type: 'cash',
      is_cash_equivalent: true,
      iso_currency_code: 'USD',
      close_price: 1.0,
      current_price: 1.0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.is_cash_equivalent).toBe(true);
      expect(result.data.ticker_symbol).toBe('CUR:USD');
      expect(result.data.close_price).toBe(1.0);
    }
  });

  test('rejects missing security_id', () => {
    const result = SecuritySchema.safeParse({
      ticker_symbol: 'AAPL',
      name: 'Apple Inc.',
    });
    expect(result.success).toBe(false);
  });
});
