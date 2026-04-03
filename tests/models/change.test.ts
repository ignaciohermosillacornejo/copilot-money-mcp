/**
 * Unit tests for Change schema validation.
 */

import { describe, test, expect } from 'bun:test';
import {
  ChangeSchema,
  TransactionChangeSchema,
  AccountChangeSchema,
} from '../../src/models/change.js';

describe('ChangeSchema', () => {
  test('validates minimal document with just change_id', () => {
    const result = ChangeSchema.safeParse({ change_id: 'change-abc' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.change_id).toBe('change-abc');
    }
  });

  test('passes through unknown fields', () => {
    const result = ChangeSchema.safeParse({
      change_id: 'change-abc',
      some_future_field: 42,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).some_future_field).toBe(42);
    }
  });

  test('rejects missing change_id', () => {
    const result = ChangeSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('TransactionChangeSchema', () => {
  test('validates minimal document with just change_id', () => {
    const result = TransactionChangeSchema.safeParse({ change_id: 'tc-1' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.change_id).toBe('tc-1');
      expect(result.data.parent_change_id).toBeUndefined();
    }
  });

  test('validates document with parent_change_id', () => {
    const result = TransactionChangeSchema.safeParse({
      change_id: 'tc-1',
      parent_change_id: 'change-abc',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.change_id).toBe('tc-1');
      expect(result.data.parent_change_id).toBe('change-abc');
    }
  });

  test('passes through unknown fields', () => {
    const result = TransactionChangeSchema.safeParse({
      change_id: 'tc-1',
      extra: 'value',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).extra).toBe('value');
    }
  });

  test('rejects missing change_id', () => {
    const result = TransactionChangeSchema.safeParse({ parent_change_id: 'abc' });
    expect(result.success).toBe(false);
  });
});

describe('AccountChangeSchema', () => {
  test('validates minimal document with just change_id', () => {
    const result = AccountChangeSchema.safeParse({ change_id: 'ac-1' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.change_id).toBe('ac-1');
      expect(result.data.parent_change_id).toBeUndefined();
    }
  });

  test('validates document with parent_change_id', () => {
    const result = AccountChangeSchema.safeParse({
      change_id: 'ac-1',
      parent_change_id: 'change-xyz',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.change_id).toBe('ac-1');
      expect(result.data.parent_change_id).toBe('change-xyz');
    }
  });

  test('passes through unknown fields', () => {
    const result = AccountChangeSchema.safeParse({
      change_id: 'ac-1',
      unknown_field: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).unknown_field).toBe(true);
    }
  });

  test('rejects missing change_id', () => {
    const result = AccountChangeSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
