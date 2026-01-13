/**
 * Unit tests for investment price functionality.
 *
 * Tests the investment price model, schema validation, and helper functions.
 */

import { describe, test, expect } from 'bun:test';
import {
  InvestmentPriceSchema,
  getBestPrice,
  getPriceDate,
  isHighFrequencyPrice,
  isDailyPrice,
  getInvestmentDisplayName,
  formatPrice,
  type InvestmentPrice,
} from '../../src/models/investment-price.js';

describe('InvestmentPriceSchema', () => {
  test('validates valid investment price with date (hf data)', () => {
    const validPrice = {
      investment_id: 'hash_123',
      ticker_symbol: 'AAPL',
      close_price: 150.25,
      date: '2024-01-15',
      currency: 'USD',
      price_type: 'hf',
    };

    const result = InvestmentPriceSchema.safeParse(validPrice);
    expect(result.success).toBe(true);
  });

  test('validates valid investment price with month (daily data)', () => {
    const validPrice = {
      investment_id: 'hash_456',
      ticker_symbol: 'BTC-USD',
      price: 45000.0,
      month: '2024-01',
      currency: 'USD',
      price_type: 'daily',
    };

    const result = InvestmentPriceSchema.safeParse(validPrice);
    expect(result.success).toBe(true);
  });

  test('validates investment price with OHLCV data', () => {
    const priceWithOHLCV = {
      investment_id: 'hash_789',
      ticker_symbol: 'VTSAX',
      close_price: 110.5,
      open: 109.8,
      high: 111.2,
      low: 109.5,
      volume: 1000000,
      date: '2024-01-15',
      currency: 'USD',
    };

    const result = InvestmentPriceSchema.safeParse(priceWithOHLCV);
    expect(result.success).toBe(true);
  });

  test('validates investment price with multiple price fields', () => {
    const priceMultiple = {
      investment_id: 'hash_999',
      ticker_symbol: 'TSLA',
      price: 200.0,
      close_price: 199.5,
      current_price: 200.5,
      institution_price: 199.8,
      date: '2024-01-15',
    };

    const result = InvestmentPriceSchema.safeParse(priceMultiple);
    expect(result.success).toBe(true);
  });

  test('rejects invalid date format', () => {
    const invalid = {
      investment_id: 'hash_123',
      date: '2024-1-15', // Should be 2024-01-15
    };

    const result = InvestmentPriceSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test('rejects invalid month format', () => {
    const invalid = {
      investment_id: 'hash_123',
      month: '2024-1', // Should be 2024-01
    };

    const result = InvestmentPriceSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test('allows price record with no ticker_symbol', () => {
    const noTicker = {
      investment_id: 'hash_abc',
      price: 50.0,
      date: '2024-01-15',
    };

    const result = InvestmentPriceSchema.safeParse(noTicker);
    expect(result.success).toBe(true);
  });

  test('passes through unknown fields', () => {
    const withExtra = {
      investment_id: 'hash_xyz',
      price: 100.0,
      date: '2024-01-15',
      custom_field: 'extra_data',
    };

    const result = InvestmentPriceSchema.safeParse(withExtra);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty('custom_field');
    }
  });
});

describe('getBestPrice', () => {
  test('returns current_price when available (highest priority)', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      current_price: 100.0,
      close_price: 99.0,
      price: 98.0,
      institution_price: 97.0,
    };

    expect(getBestPrice(price)).toBe(100.0);
  });

  test('returns close_price when current_price unavailable', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      close_price: 99.0,
      price: 98.0,
      institution_price: 97.0,
    };

    expect(getBestPrice(price)).toBe(99.0);
  });

  test('returns price when current_price and close_price unavailable', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      price: 98.0,
      institution_price: 97.0,
    };

    expect(getBestPrice(price)).toBe(98.0);
  });

  test('returns institution_price as last fallback', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      institution_price: 97.0,
    };

    expect(getBestPrice(price)).toBe(97.0);
  });

  test('returns undefined when no price fields available', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      ticker_symbol: 'TEST',
    };

    expect(getBestPrice(price)).toBeUndefined();
  });
});

describe('getPriceDate', () => {
  test('returns date when available (hf data)', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      date: '2024-01-15',
    };

    expect(getPriceDate(price)).toBe('2024-01-15');
  });

  test('returns month when date unavailable (daily data)', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      month: '2024-01',
    };

    expect(getPriceDate(price)).toBe('2024-01');
  });

  test('prefers date over month when both available', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      date: '2024-01-15',
      month: '2024-01',
    };

    expect(getPriceDate(price)).toBe('2024-01-15');
  });

  test('returns undefined when neither date nor month available', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
    };

    expect(getPriceDate(price)).toBeUndefined();
  });
});

describe('isHighFrequencyPrice', () => {
  test('returns true when price_type is hf', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      price_type: 'hf',
    };

    expect(isHighFrequencyPrice(price)).toBe(true);
  });

  test('returns true when date is present but month is not', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      date: '2024-01-15',
    };

    expect(isHighFrequencyPrice(price)).toBe(true);
  });

  test('returns false when price_type is daily even with date', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      price_type: 'daily',
      month: '2024-01',
    };

    expect(isHighFrequencyPrice(price)).toBe(false);
  });

  test('returns false when month is present', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      month: '2024-01',
    };

    expect(isHighFrequencyPrice(price)).toBe(false);
  });

  test('returns false when both date and month are present', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      date: '2024-01-15',
      month: '2024-01',
    };

    expect(isHighFrequencyPrice(price)).toBe(false);
  });
});

describe('isDailyPrice', () => {
  test('returns true when price_type is daily', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      price_type: 'daily',
    };

    expect(isDailyPrice(price)).toBe(true);
  });

  test('returns true when month is present but date is not', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      month: '2024-01',
    };

    expect(isDailyPrice(price)).toBe(true);
  });

  test('returns false when price_type is hf even with month', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      price_type: 'hf',
      date: '2024-01-15',
    };

    expect(isDailyPrice(price)).toBe(false);
  });

  test('returns false when date is present', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      date: '2024-01-15',
    };

    expect(isDailyPrice(price)).toBe(false);
  });

  test('returns false when both date and month are present', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      date: '2024-01-15',
      month: '2024-01',
    };

    expect(isDailyPrice(price)).toBe(false);
  });
});

describe('getInvestmentDisplayName', () => {
  test('returns ticker_symbol when available', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_abc123',
      ticker_symbol: 'AAPL',
    };

    expect(getInvestmentDisplayName(price)).toBe('AAPL');
  });

  test('returns investment_id when ticker_symbol unavailable', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_abc123',
    };

    expect(getInvestmentDisplayName(price)).toBe('hash_abc123');
  });

  test('prefers ticker_symbol over investment_id', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_long_id_here',
      ticker_symbol: 'BTC-USD',
    };

    expect(getInvestmentDisplayName(price)).toBe('BTC-USD');
  });
});

describe('formatPrice', () => {
  test('formats USD price correctly', () => {
    const formatted = formatPrice(150.25, 'USD');
    expect(formatted).toBe('$150.25');
  });

  test('formats large USD price with commas', () => {
    const formatted = formatPrice(45000.0, 'USD');
    expect(formatted).toBe('$45,000.00');
  });

  test('uses USD as default currency', () => {
    const formatted = formatPrice(99.99);
    expect(formatted).toBe('$99.99');
  });

  test('rounds to 2 decimal places', () => {
    const formatted = formatPrice(100.123456, 'USD');
    expect(formatted).toBe('$100.12');
  });

  test('formats EUR price correctly', () => {
    const formatted = formatPrice(200.5, 'EUR');
    expect(formatted).toContain('200.50');
  });

  test('handles zero price', () => {
    const formatted = formatPrice(0, 'USD');
    expect(formatted).toBe('$0.00');
  });

  test('handles negative price', () => {
    const formatted = formatPrice(-50.0, 'USD');
    expect(formatted).toContain('-');
    expect(formatted).toContain('50.00');
  });
});

describe('InvestmentPrice helper functions integration', () => {
  test('getBestPrice and formatPrice work together', () => {
    const price: InvestmentPrice = {
      investment_id: 'hash_1',
      ticker_symbol: 'AAPL',
      current_price: 175.5,
      currency: 'USD',
    };

    const bestPrice = getBestPrice(price);
    expect(bestPrice).toBeDefined();
    if (bestPrice !== undefined) {
      const formatted = formatPrice(bestPrice, price.currency);
      expect(formatted).toBe('$175.50');
    }
  });

  test('type detection functions are mutually exclusive for pure data', () => {
    // Pure hf data
    const hfPrice: InvestmentPrice = {
      investment_id: 'hash_1',
      date: '2024-01-15',
      price_type: 'hf',
    };
    expect(isHighFrequencyPrice(hfPrice)).toBe(true);
    expect(isDailyPrice(hfPrice)).toBe(false);

    // Pure daily data
    const dailyPrice: InvestmentPrice = {
      investment_id: 'hash_2',
      month: '2024-01',
      price_type: 'daily',
    };
    expect(isHighFrequencyPrice(dailyPrice)).toBe(false);
    expect(isDailyPrice(dailyPrice)).toBe(true);
  });

  test('complete investment price record has all fields accessible', () => {
    const completePrice: InvestmentPrice = {
      investment_id: 'hash_complete',
      ticker_symbol: 'TSLA',
      price: 200.0,
      close_price: 199.5,
      current_price: 200.5,
      institution_price: 199.8,
      open: 198.0,
      high: 202.0,
      low: 197.0,
      volume: 5000000,
      date: '2024-01-15',
      currency: 'USD',
      source: 'plaid',
      price_type: 'hf',
    };

    expect(getBestPrice(completePrice)).toBe(200.5); // current_price
    expect(getPriceDate(completePrice)).toBe('2024-01-15');
    expect(isHighFrequencyPrice(completePrice)).toBe(true); // price_type='hf' takes precedence
    expect(getInvestmentDisplayName(completePrice)).toBe('TSLA');

    const formatted = formatPrice(getBestPrice(completePrice)!, completePrice.currency);
    expect(formatted).toBe('$200.50');
  });
});
