/**
 * Unit tests for Tag schema validation.
 */

import { describe, test, expect } from 'bun:test';
import { TagSchema, getTagDisplayName } from '../../src/models/tag.js';

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

describe('getTagDisplayName', () => {
  test('returns name when available', () => {
    expect(getTagDisplayName({ tag_id: 'tag-1', name: 'Vacation' })).toBe('Vacation');
  });

  test('falls back to tag_id when name is undefined', () => {
    expect(getTagDisplayName({ tag_id: 'tag-abc123' })).toBe('tag-abc123');
  });

  test('falls back to tag_id when name is empty string', () => {
    expect(getTagDisplayName({ tag_id: 'tag-1', name: '' })).toBe('tag-1');
  });
});
