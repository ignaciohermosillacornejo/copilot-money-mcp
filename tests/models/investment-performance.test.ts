/**
 * Unit tests for InvestmentPerformance and TwrHolding schemas.
 */

import { describe, expect, test } from 'bun:test';
import {
  InvestmentPerformanceSchema,
  TwrHoldingSchema,
} from '../../src/models/investment-performance.js';

describe('InvestmentPerformanceSchema', () => {
  test('validates minimal object with only performance_id', () => {
    const result = InvestmentPerformanceSchema.safeParse({
      performance_id: 'abc123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.performance_id).toBe('abc123');
    }
  });

  test('validates full object with all fields', () => {
    const result = InvestmentPerformanceSchema.safeParse({
      performance_id: 'perf-001',
      security_id: 'sec-xyz',
      type: 'overall-security',
      user_id: 'user-123',
      access: ['read', 'write'],
      position: 5,
      last_update: '2025-01-15T10:30:00Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.performance_id).toBe('perf-001');
      expect(result.data.security_id).toBe('sec-xyz');
      expect(result.data.type).toBe('overall-security');
      expect(result.data.user_id).toBe('user-123');
      expect(result.data.access).toEqual(['read', 'write']);
      expect(result.data.position).toBe(5);
      expect(result.data.last_update).toBe('2025-01-15T10:30:00Z');
    }
  });

  test('passes through unknown fields', () => {
    const result = InvestmentPerformanceSchema.safeParse({
      performance_id: 'perf-002',
      unknown_field: 'some value',
      another_field: 42,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.performance_id).toBe('perf-002');
      expect((result.data as Record<string, unknown>).unknown_field).toBe('some value');
      expect((result.data as Record<string, unknown>).another_field).toBe(42);
    }
  });

  test('rejects object without performance_id', () => {
    const result = InvestmentPerformanceSchema.safeParse({
      security_id: 'sec-xyz',
    });
    expect(result.success).toBe(false);
  });
});

describe('TwrHoldingSchema', () => {
  test('validates minimal object with only twr_id', () => {
    const result = TwrHoldingSchema.safeParse({
      twr_id: 'hash123:2025-01',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.twr_id).toBe('hash123:2025-01');
    }
  });

  test('validates full object with history data', () => {
    const result = TwrHoldingSchema.safeParse({
      twr_id: 'hash456:2025-03',
      security_id: 'sec-abc',
      month: '2025-03',
      history: {
        '1709251200000': { value: 1.05 },
        '1709337600000': { value: 1.08 },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.twr_id).toBe('hash456:2025-03');
      expect(result.data.security_id).toBe('sec-abc');
      expect(result.data.month).toBe('2025-03');
      expect(result.data.history).toBeDefined();
      expect(result.data.history!['1709251200000'].value).toBe(1.05);
      expect(result.data.history!['1709337600000'].value).toBe(1.08);
    }
  });

  test('passes through unknown fields', () => {
    const result = TwrHoldingSchema.safeParse({
      twr_id: 'hash789:2025-02',
      extra_data: 'test',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.twr_id).toBe('hash789:2025-02');
      expect((result.data as Record<string, unknown>).extra_data).toBe('test');
    }
  });

  test('rejects object without twr_id', () => {
    const result = TwrHoldingSchema.safeParse({
      security_id: 'sec-abc',
      month: '2025-01',
    });
    expect(result.success).toBe(false);
  });

  test('validates history with passthrough on value objects', () => {
    const result = TwrHoldingSchema.safeParse({
      twr_id: 'hash:2025-01',
      history: {
        '1700000000000': { value: 0.99, extra: 'data' },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const entry = result.data.history!['1700000000000'] as Record<string, unknown>;
      expect(entry.value).toBe(0.99);
      expect(entry.extra).toBe('data');
    }
  });
});
