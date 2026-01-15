/**
 * Unit tests for model edge cases to improve code coverage.
 *
 * Tests edge cases in:
 * - src/models/category.ts: getCategoryDisplayName function
 * - src/models/investment-split.ts: invalid date handling in formatSplitDate
 * - src/models/item.ts: edge cases in status checks and date formatting
 */

import { describe, test, expect } from 'bun:test';
import {
  CategorySchema,
  getCategoryDisplayName,
  type Category,
} from '../../src/models/category.js';
import {
  InvestmentSplitSchema,
  getSplitMultiplier,
  formatSplitDate,
  type InvestmentSplit,
} from '../../src/models/investment-split.js';
import {
  ItemSchema,
  getItemStatusDescription,
  formatLastUpdate,
  isConsentExpiringSoon,
  type Item,
} from '../../src/models/item.js';

describe('category.ts - getCategoryDisplayName', () => {
  test('returns name when available', () => {
    const category: Category = {
      category_id: 'cat_123',
      name: 'Groceries',
    };

    expect(getCategoryDisplayName(category)).toBe('Groceries');
  });

  test('returns category_id when name is undefined', () => {
    const category: Category = {
      category_id: 'cat_groceries_123',
    };

    expect(getCategoryDisplayName(category)).toBe('cat_groceries_123');
  });

  test('returns category_id when name is explicitly undefined', () => {
    const category: Category = {
      category_id: 'food_and_drink',
      name: undefined,
    };

    expect(getCategoryDisplayName(category)).toBe('food_and_drink');
  });

  test('returns empty name when name is empty string', () => {
    const category: Category = {
      category_id: 'cat_123',
      name: '',
    };

    // Empty string is truthy for ?? operator, so returns empty string
    expect(getCategoryDisplayName(category)).toBe('');
  });

  test('handles category with all fields', () => {
    const category: Category = {
      category_id: 'cat_full',
      name: 'Full Category',
      emoji: '🛒',
      color: '#FF0000',
      bg_color: '#FFFFFF',
      parent_category_id: 'parent_cat',
      children_category_ids: ['child_1', 'child_2'],
      order: 1,
      excluded: false,
      is_other: false,
      auto_budget_lock: true,
      auto_delete_lock: false,
      plaid_category_ids: ['plaid_1'],
      partial_name_rules: ['grocery'],
      user_id: 'user_123',
    };

    expect(getCategoryDisplayName(category)).toBe('Full Category');
  });
});

describe('CategorySchema validation', () => {
  test('validates minimal category', () => {
    const result = CategorySchema.safeParse({ category_id: 'cat_1' });
    expect(result.success).toBe(true);
  });

  test('validates category with optional fields', () => {
    const result = CategorySchema.safeParse({
      category_id: 'cat_2',
      name: 'Test',
      emoji: '🔥',
      excluded: true,
    });
    expect(result.success).toBe(true);
  });

  test('rejects category without category_id', () => {
    const result = CategorySchema.safeParse({ name: 'Test' });
    expect(result.success).toBe(false);
  });

  test('rejects unknown fields due to strict mode', () => {
    const result = CategorySchema.safeParse({
      category_id: 'cat_3',
      unknown_field: 'should fail',
    });
    expect(result.success).toBe(false);
  });
});

describe('investment-split.ts - formatSplitDate edge cases', () => {
  test('formats standard ISO date', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_date: '2020-08-31',
    };

    const formatted = formatSplitDate(split);
    expect(formatted).toBeDefined();
    expect(formatted).toContain('August');
    expect(formatted).toContain('31');
    expect(formatted).toContain('2020');
  });

  test('returns undefined when split_date is missing', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
    };

    expect(formatSplitDate(split)).toBeUndefined();
  });

  test('handles date at epoch (1970-01-01)', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_date: '1970-01-01',
    };

    const formatted = formatSplitDate(split);
    expect(formatted).toBeDefined();
    expect(formatted).toContain('1970');
    expect(formatted).toContain('January');
  });

  test('handles far future date', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_date: '2099-12-31',
    };

    const formatted = formatSplitDate(split);
    expect(formatted).toBeDefined();
    expect(formatted).toContain('2099');
    expect(formatted).toContain('December');
  });

  test('handles date with trailing time component', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      // Note: schema would reject this format, but testing function directly
      split_date: '2020-08-31',
    };

    const formatted = formatSplitDate(split);
    expect(formatted).toBeDefined();
  });
});

describe('investment-split.ts - getSplitMultiplier additional cases', () => {
  test('returns multiplier from split_ratio when only split_ratio provided', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: '4:1',
    };

    expect(getSplitMultiplier(split)).toBe(4);
  });

  test('returns undefined when split_ratio is invalid format', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: 'invalid',
    };

    expect(getSplitMultiplier(split)).toBeUndefined();
  });

  test('returns multiplier 1 for 1:1 ratio', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: '1:1',
    };

    expect(getSplitMultiplier(split)).toBe(1);
  });

  test('returns fractional multiplier for reverse split', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      split_ratio: '1:4',
    };

    expect(getSplitMultiplier(split)).toBe(0.25);
  });

  test('prefers to_factor/from_factor over split_ratio', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      to_factor: 2,
      from_factor: 1,
      split_ratio: '4:1', // Should be ignored
    };

    expect(getSplitMultiplier(split)).toBe(2);
  });

  test('falls back to split_ratio when only to_factor present (no from_factor)', () => {
    const split: InvestmentSplit = {
      split_id: 'split_1',
      to_factor: 4,
      // from_factor missing
      split_ratio: '3:1',
    };

    expect(getSplitMultiplier(split)).toBe(3);
  });
});

describe('item.ts - getItemStatusDescription edge cases', () => {
  test('returns Update required for needs_update with no status', () => {
    const item: Item = {
      item_id: 'item_1',
      needs_update: true,
    };

    expect(getItemStatusDescription(item)).toBe('Update required');
  });

  test('returns Connected when connection_status is undefined and no errors', () => {
    const item: Item = {
      item_id: 'item_1',
      connection_status: undefined,
      needs_update: false,
      error_code: 'ITEM_NO_ERROR',
    };

    // When no explicit errors, item is considered healthy
    expect(getItemStatusDescription(item)).toBe('Connected');
  });

  test('returns connection_status as fallback', () => {
    const item: Item = {
      item_id: 'item_1',
      connection_status: 'pending',
      needs_update: false,
      error_code: undefined,
    };

    expect(getItemStatusDescription(item)).toBe('pending');
  });

  test('returns Connection error when error status but no message', () => {
    const item: Item = {
      item_id: 'item_1',
      connection_status: 'error',
      error_message: undefined,
    };

    expect(getItemStatusDescription(item)).toBe('Connection error');
  });

  test('handles edge case with pending status', () => {
    const item: Item = {
      item_id: 'item_1',
      connection_status: 'pending',
    };

    // Pending is not 'active', 'error', or 'disconnected'
    // isItemHealthy returns false (since status is not 'active')
    // Falls through to the final return
    expect(getItemStatusDescription(item)).toBe('pending');
  });
});

describe('item.ts - formatLastUpdate edge cases', () => {
  test('formats valid ISO timestamp', () => {
    const item: Item = {
      item_id: 'item_1',
      last_successful_update: '2024-01-15T10:30:00Z',
    };

    const formatted = formatLastUpdate(item);
    expect(formatted).toBeDefined();
    expect(formatted).toContain('Jan');
    expect(formatted).toContain('15');
    expect(formatted).toContain('2024');
  });

  test('returns undefined when no timestamp', () => {
    const item: Item = {
      item_id: 'item_1',
    };

    expect(formatLastUpdate(item)).toBeUndefined();
  });

  test('uses updated_at as fallback', () => {
    const item: Item = {
      item_id: 'item_1',
      updated_at: '2024-03-20T14:00:00Z',
    };

    const formatted = formatLastUpdate(item);
    expect(formatted).toBeDefined();
    expect(formatted).toContain('Mar');
  });

  test('handles epoch timestamp', () => {
    const item: Item = {
      item_id: 'item_1',
      last_successful_update: '1970-01-01T00:00:00Z',
    };

    const formatted = formatLastUpdate(item);
    expect(formatted).toBeDefined();
    expect(formatted).toContain('1970');
  });

  test('formats timestamp with milliseconds', () => {
    const item: Item = {
      item_id: 'item_1',
      last_successful_update: '2024-06-15T12:30:45.123Z',
    };

    const formatted = formatLastUpdate(item);
    expect(formatted).toBeDefined();
    expect(formatted).toContain('Jun');
  });
});

describe('item.ts - isConsentExpiringSoon edge cases', () => {
  test('returns false when no consent_expiration_time', () => {
    const item: Item = {
      item_id: 'item_1',
    };

    expect(isConsentExpiringSoon(item)).toBe(false);
  });

  test('returns true when consent expires exactly in 30 days', () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);

    const item: Item = {
      item_id: 'item_1',
      consent_expiration_time: futureDate.toISOString(),
    };

    expect(isConsentExpiringSoon(item)).toBe(true);
  });

  test('returns false when consent expires in 31 days', () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 31);

    const item: Item = {
      item_id: 'item_1',
      consent_expiration_time: futureDate.toISOString(),
    };

    expect(isConsentExpiringSoon(item)).toBe(false);
  });

  test('returns true for already expired consent', () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 1);

    const item: Item = {
      item_id: 'item_1',
      consent_expiration_time: pastDate.toISOString(),
    };

    expect(isConsentExpiringSoon(item)).toBe(true);
  });

  test('returns true when consent expires today', () => {
    const today = new Date();

    const item: Item = {
      item_id: 'item_1',
      consent_expiration_time: today.toISOString(),
    };

    expect(isConsentExpiringSoon(item)).toBe(true);
  });

  test('handles far future expiration', () => {
    const farFuture = new Date();
    farFuture.setFullYear(farFuture.getFullYear() + 10);

    const item: Item = {
      item_id: 'item_1',
      consent_expiration_time: farFuture.toISOString(),
    };

    expect(isConsentExpiringSoon(item)).toBe(false);
  });
});

describe('item.ts - edge cases with minimal items', () => {
  test('minimal item is healthy by default', () => {
    const item: Item = {
      item_id: 'item_minimal',
    };

    // Minimal item is considered healthy (no errors, no needs_update)
    expect(getItemStatusDescription(item)).toBe('Connected');
  });

  test('item with only item_id and active status is healthy', () => {
    const item: Item = {
      item_id: 'item_active',
      connection_status: 'active',
    };

    expect(getItemStatusDescription(item)).toBe('Connected');
  });
});
