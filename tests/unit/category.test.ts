import { describe, test, expect } from 'bun:test';
import { CategorySchema } from '../../src/models/category.js';

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
