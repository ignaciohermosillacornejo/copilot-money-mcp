/**
 * Unit tests for investment split functionality.
 *
 * Tests the investment split model, schema validation, and helper functions.
 */

import { describe, test, expect } from 'bun:test';
import {
  InvestmentSplitSchema,
  parseSplitRatio,
  getSplitMultiplier,
  getSplitDisplayString,
  getSplitDisplayName,
  isReverseSplit,
  adjustPriceForSplit,
  adjustSharesForSplit,
  formatSplitDate,
  type InvestmentSplit,
} from '../../src/models/investment-split.js';

describe('InvestmentSplitSchema', () => {
  test('validates valid investment split with all fields', () => {
    const validSplit = {
      split_id: 'split_123abc',
      ticker_symbol: 'AAPL',
      investment_id: 'inv_abc123',
      split_date: '2020-08-31',
      split_ratio: '4:1',
      from_factor: 1,
      to_factor: 4,
      multiplier: 4.0,
      announcement_date: '2020-07-30',
      record_date: '2020-08-24',
      ex_date: '2020-08-31',
      description: 'Apple 4-for-1 stock split',
      source: 'plaid',
    };

    const result = InvestmentSplitSchema.safeParse(validSplit);
    expect(result.success).toBe(true);
  });

  test('validates split with minimal required fields', () => {
    const minimalSplit = {
      split_id: 'split_minimal123',
    };

    const result = InvestmentSplitSchema.safeParse(minimalSplit);
    expect(result.success).toBe(true);
  });

  test('validates split with only split_ratio', () => {
    const splitWithRatio = {
      split_id: 'split_ratio_only',
      ticker_symbol: 'TSLA',
      split_date: '2022-08-25',
      split_ratio: '3:1',
    };

    const result = InvestmentSplitSchema.safeParse(splitWithRatio);
    expect(result.success).toBe(true);
  });

  test('validates split with only factors', () => {
    const splitWithFactors = {
      split_id: 'split_factors_only',
      ticker_symbol: 'GOOGL',
      split_date: '2022-07-15',
      from_factor: 1,
      to_factor: 20,
    };

    const result = InvestmentSplitSchema.safeParse(splitWithFactors);
    expect(result.success).toBe(true);
  });

  test('rejects invalid date format', () => {
    const invalid = {
      split_id: 'split_bad_date',
      split_date: '2020-8-31', // Should be 2020-08-31
    };

    const result = InvestmentSplitSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test('passes through unknown fields', () => {
    const withExtra = {
      split_id: 'split_extra',
      ticker_symbol: 'TEST',
      custom_field: 'extra_data',
    };

    const result = InvestmentSplitSchema.safeParse(withExtra);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty('custom_field');
    }
  });
});

describe('parseSplitRatio', () => {
  test('parses standard forward split ratio (4:1)', () => {
    const result = parseSplitRatio('4:1');
    expect(result).not.toBeNull();
    expect(result!.to).toBe(4);
    expect(result!.from).toBe(1);
    expect(result!.multiplier).toBe(4);
  });

  test('parses 2:1 split', () => {
    const result = parseSplitRatio('2:1');
    expect(result).not.toBeNull();
    expect(result!.to).toBe(2);
    expect(result!.from).toBe(1);
    expect(result!.multiplier).toBe(2);
  });

  test('parses 3:2 split', () => {
    const result = parseSplitRatio('3:2');
    expect(result).not.toBeNull();
    expect(result!.to).toBe(3);
    expect(result!.from).toBe(2);
    expect(result!.multiplier).toBe(1.5);
  });

  test('parses large split ratio (20:1)', () => {
    const result = parseSplitRatio('20:1');
    expect(result).not.toBeNull();
    expect(result!.to).toBe(20);
    expect(result!.from).toBe(1);
    expect(result!.multiplier).toBe(20);
  });

  test('parses reverse split ratio (1:2)', () => {
    const result = parseSplitRatio('1:2');
    expect(result).not.toBeNull();
    expect(result!.to).toBe(1);
    expect(result!.from).toBe(2);
    expect(result!.multiplier).toBe(0.5);
  });

  test('returns null for invalid format', () => {
    expect(parseSplitRatio('4-1')).toBeNull();
    expect(parseSplitRatio('4/1')).toBeNull();
    expect(parseSplitRatio('4 to 1')).toBeNull();
    expect(parseSplitRatio('4:1:0')).toBeNull();
    expect(parseSplitRatio('')).toBeNull();
  });

  test('returns null for zero denominator', () => {
    const result = parseSplitRatio('4:0');
    expect(result).toBeNull();
  });
});

describe('getSplitMultiplier', () => {
  test('returns pre-calculated multiplier when available', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      multiplier: 4.0,
      split_ratio: '2:1', // Should be ignored
      to_factor: 10,
      from_factor: 5, // Should be ignored
    };

    expect(getSplitMultiplier(split)).toBe(4.0);
  });

  test('calculates from factors when multiplier not available', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      to_factor: 4,
      from_factor: 1,
    };

    expect(getSplitMultiplier(split)).toBe(4);
  });

  test('calculates fractional multiplier from factors', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      to_factor: 3,
      from_factor: 2,
    };

    expect(getSplitMultiplier(split)).toBe(1.5);
  });

  test('parses from split_ratio when factors not available', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: '4:1',
    };

    expect(getSplitMultiplier(split)).toBe(4);
  });

  test('returns undefined when no data available', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
    };

    expect(getSplitMultiplier(split)).toBeUndefined();
  });

  test('returns undefined for zero from_factor', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      to_factor: 4,
      from_factor: 0,
    };

    expect(getSplitMultiplier(split)).toBeUndefined();
  });
});

describe('getSplitDisplayString', () => {
  test('returns display string for forward split from factors', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      to_factor: 4,
      from_factor: 1,
    };

    expect(getSplitDisplayString(split)).toBe('4-for-1 split');
  });

  test('returns display string from split_ratio', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: '3:1',
    };

    expect(getSplitDisplayString(split)).toBe('3-for-1 split');
  });

  test('returns reverse split string when multiplier < 1', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      to_factor: 1,
      from_factor: 2,
    };

    expect(getSplitDisplayString(split)).toBe('1-for-2 reverse split');
  });

  test('returns generic string when no data available', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
    };

    expect(getSplitDisplayString(split)).toBe('Stock split');
  });

  test('handles large splits (20:1)', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: '20:1',
    };

    expect(getSplitDisplayString(split)).toBe('20-for-1 split');
  });
});

describe('getSplitDisplayName', () => {
  test('returns ticker_symbol when available', () => {
    const split: InvestmentSplit = {
      split_id: 'split_abc123',
      ticker_symbol: 'AAPL',
      investment_id: 'inv_123',
    };

    expect(getSplitDisplayName(split)).toBe('AAPL');
  });

  test('returns investment_id when ticker_symbol unavailable', () => {
    const split: InvestmentSplit = {
      split_id: 'split_abc123',
      investment_id: 'inv_123',
    };

    expect(getSplitDisplayName(split)).toBe('inv_123');
  });

  test('returns split_id as fallback', () => {
    const split: InvestmentSplit = {
      split_id: 'split_abc123',
    };

    expect(getSplitDisplayName(split)).toBe('split_abc123');
  });
});

describe('isReverseSplit', () => {
  test('returns false for forward split', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: '4:1',
    };

    expect(isReverseSplit(split)).toBe(false);
  });

  test('returns true for reverse split', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: '1:4',
    };

    expect(isReverseSplit(split)).toBe(true);
  });

  test('returns false for 1:1 split', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: '1:1',
    };

    expect(isReverseSplit(split)).toBe(false);
  });

  test('returns undefined when no data available', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
    };

    expect(isReverseSplit(split)).toBeUndefined();
  });

  test('returns true for reverse split from factors', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      to_factor: 1,
      from_factor: 10,
    };

    expect(isReverseSplit(split)).toBe(true);
  });
});

describe('adjustPriceForSplit', () => {
  test('adjusts price for 4:1 split', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: '4:1',
    };

    // $400 pre-split = $100 post-split
    expect(adjustPriceForSplit(400, split)).toBe(100);
  });

  test('adjusts price for 2:1 split', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: '2:1',
    };

    // $200 pre-split = $100 post-split
    expect(adjustPriceForSplit(200, split)).toBe(100);
  });

  test('adjusts price for reverse split', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: '1:2',
    };

    // $50 pre-split = $100 post-split (fewer shares, higher price)
    expect(adjustPriceForSplit(50, split)).toBe(100);
  });

  test('returns original price when no split data', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
    };

    expect(adjustPriceForSplit(100, split)).toBe(100);
  });

  test('rounds to 2 decimal places', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: '3:1',
    };

    // $100 / 3 = $33.33...
    expect(adjustPriceForSplit(100, split)).toBe(33.33);
  });
});

describe('adjustSharesForSplit', () => {
  test('adjusts shares for 4:1 split', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: '4:1',
    };

    // 100 shares pre-split = 400 shares post-split
    expect(adjustSharesForSplit(100, split)).toBe(400);
  });

  test('adjusts shares for 2:1 split', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: '2:1',
    };

    // 50 shares pre-split = 100 shares post-split
    expect(adjustSharesForSplit(50, split)).toBe(100);
  });

  test('adjusts shares for reverse split', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: '1:2',
    };

    // 100 shares pre-split = 50 shares post-split
    expect(adjustSharesForSplit(100, split)).toBe(50);
  });

  test('returns original shares when no split data', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
    };

    expect(adjustSharesForSplit(100, split)).toBe(100);
  });

  test('handles fractional shares from reverse splits', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: '1:3',
    };

    // 100 shares * (1/3) = 33.33 shares
    expect(adjustSharesForSplit(100, split)).toBe(33.33);
  });
});

describe('formatSplitDate', () => {
  test('formats valid date', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_date: '2020-08-31',
    };

    const formatted = formatSplitDate(split);
    expect(formatted).toContain('August');
    expect(formatted).toContain('31');
    expect(formatted).toContain('2020');
  });

  test('returns undefined when no date', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
    };

    expect(formatSplitDate(split)).toBeUndefined();
  });

  test('handles different dates', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_date: '2022-07-15',
    };

    const formatted = formatSplitDate(split);
    expect(formatted).toContain('July');
    expect(formatted).toContain('15');
    expect(formatted).toContain('2022');
  });
});

describe('Investment Split integration', () => {
  test('all helper functions work together for AAPL 4:1 split', () => {
    const appleSplit: InvestmentSplit = {
      split_id: 'aapl_split_2020',
      ticker_symbol: 'AAPL',
      split_date: '2020-08-31',
      split_ratio: '4:1',
      from_factor: 1,
      to_factor: 4,
    };

    expect(getSplitDisplayName(appleSplit)).toBe('AAPL');
    expect(getSplitMultiplier(appleSplit)).toBe(4);
    expect(getSplitDisplayString(appleSplit)).toBe('4-for-1 split');
    expect(isReverseSplit(appleSplit)).toBe(false);
    expect(adjustPriceForSplit(500, appleSplit)).toBe(125);
    expect(adjustSharesForSplit(100, appleSplit)).toBe(400);
    expect(formatSplitDate(appleSplit)).toContain('August');
  });

  test('all helper functions work together for reverse split', () => {
    const reverseSplit: InvestmentSplit = {
      split_id: 'reverse_split_123',
      ticker_symbol: 'XYZ',
      split_date: '2023-01-15',
      split_ratio: '1:10',
      from_factor: 10,
      to_factor: 1,
    };

    expect(getSplitDisplayName(reverseSplit)).toBe('XYZ');
    expect(getSplitMultiplier(reverseSplit)).toBe(0.1);
    expect(getSplitDisplayString(reverseSplit)).toBe('1-for-10 reverse split');
    expect(isReverseSplit(reverseSplit)).toBe(true);
    expect(adjustPriceForSplit(10, reverseSplit)).toBe(100);
    expect(adjustSharesForSplit(1000, reverseSplit)).toBe(100);
  });

  test('schema validates and functions work on parsed data', () => {
    const rawData = {
      split_id: 'googl_split_2022',
      ticker_symbol: 'GOOGL',
      split_date: '2022-07-15',
      split_ratio: '20:1',
    };

    const result = InvestmentSplitSchema.safeParse(rawData);
    expect(result.success).toBe(true);

    if (result.success) {
      const split = result.data;
      expect(getSplitMultiplier(split)).toBe(20);
      expect(getSplitDisplayString(split)).toBe('20-for-1 split');
      expect(isReverseSplit(split)).toBe(false);
    }
  });
});
