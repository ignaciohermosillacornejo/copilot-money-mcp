/**
 * Unit tests for Tag schema validation.
 */

import { describe, test, expect } from 'bun:test';
import { TagSchema } from '../../src/models/tag.js';

describe('TagSchema', () => {
  test('validates minimal document with just tag_id', () => {
    const result = TagSchema.safeParse({
      tag_id: 'tag-abc123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tag_id).toBe('tag-abc123');
    }
  });

  test('validates full document with all fields', () => {
    const result = TagSchema.safeParse({
      tag_id: 'tag-abc123',
      name: 'Vacation',
      color_name: 'blue',
      hex_color: '#3B82F6',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tag_id).toBe('tag-abc123');
      expect(result.data.name).toBe('Vacation');
      expect(result.data.color_name).toBe('blue');
      expect(result.data.hex_color).toBe('#3B82F6');
    }
  });

  test('passes through unknown fields', () => {
    const result = TagSchema.safeParse({
      tag_id: 'tag-abc123',
      some_future_field: 'hello',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).some_future_field).toBe('hello');
    }
  });

  test('rejects missing tag_id', () => {
    const result = TagSchema.safeParse({
      name: 'Vacation',
    });
    expect(result.success).toBe(false);
  });
});
