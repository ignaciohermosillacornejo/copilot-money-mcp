import { describe, test, expect } from 'bun:test';
import {
  CategorySchema,
  getCategoryDisplayName,
  type Category,
} from '../../src/models/category.js';

describe('getCategoryDisplayName', () => {
  test('returns name when available', () => {
    const category: Category = {
      category_id: 'cat_123',
      name: 'Groceries',
    };

    expect(getCategoryDisplayName(category)).toBe('Groceries');
  });

  test('returns category_id when name is missing', () => {
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

  test('returns empty name when name is an empty string', () => {
    const category: Category = {
      category_id: 'cat_123',
      name: '',
    };

    // Empty string is truthy for `??` (only null/undefined trigger the
    // fallback), so the empty name is returned verbatim rather than
    // falling back to category_id.
    expect(getCategoryDisplayName(category)).toBe('');
  });

  test('prefers name over category_id even when both set with all fields', () => {
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

  test('allows unknown fields (passthrough mode)', () => {
    const result = CategorySchema.safeParse({
      category_id: 'cat_3',
      unknown_field: 'should pass',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).unknown_field).toBe('should pass');
    }
  });
});
