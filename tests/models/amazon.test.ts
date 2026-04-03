/**
 * Unit tests for Amazon schema validation.
 */

import { describe, test, expect } from 'bun:test';
import { AmazonIntegrationSchema, AmazonOrderSchema } from '../../src/models/amazon.js';

describe('AmazonIntegrationSchema', () => {
  test('validates minimal document with just amazon_id', () => {
    const result = AmazonIntegrationSchema.safeParse({
      amazon_id: 'amz-user-123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amazon_id).toBe('amz-user-123');
    }
  });

  test('passes through unknown fields', () => {
    const result = AmazonIntegrationSchema.safeParse({
      amazon_id: 'amz-user-123',
      some_future_field: 'hello',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).some_future_field).toBe('hello');
    }
  });

  test('rejects missing amazon_id', () => {
    const result = AmazonIntegrationSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('AmazonOrderSchema', () => {
  test('validates minimal order with just order_id', () => {
    const result = AmazonOrderSchema.safeParse({
      order_id: 'order-456',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.order_id).toBe('order-456');
    }
  });

  test('validates full order with items and details', () => {
    const result = AmazonOrderSchema.safeParse({
      order_id: 'order-789',
      amazon_user_id: 'amz-user-123',
      date: '2025-03-15',
      account_id: 'acc-1',
      match_state: 'matched',
      items: [
        {
          id: 'item-1',
          name: 'USB Cable',
          price: 9.99,
          quantity: 2,
          link: 'https://www.amazon.com/dp/B00EXAMPLE',
        },
        {
          id: 'item-2',
          name: 'Phone Case',
          price: 14.99,
          quantity: 1,
        },
      ],
      details: {
        beforeTax: 34.97,
        shipping: 0,
        subtotal: 34.97,
        tax: 2.87,
        total: 37.84,
      },
      payment: {
        card: 'Visa ending in 1234',
      },
      transactions: ['txn-abc', 'txn-def'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.order_id).toBe('order-789');
      expect(result.data.amazon_user_id).toBe('amz-user-123');
      expect(result.data.items).toHaveLength(2);
      expect(result.data.items![0].name).toBe('USB Cable');
      expect(result.data.details!.total).toBe(37.84);
      expect(result.data.payment!.card).toBe('Visa ending in 1234');
      expect(result.data.transactions).toEqual(['txn-abc', 'txn-def']);
    }
  });

  test('passes through unknown fields on order, items, details, and payment', () => {
    const result = AmazonOrderSchema.safeParse({
      order_id: 'order-1',
      future_field: true,
      items: [{ unknown_prop: 42 }],
      details: { extra: 'data' },
      payment: { method: 'credit' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).future_field).toBe(true);
      expect((result.data.items![0] as Record<string, unknown>).unknown_prop).toBe(42);
      expect((result.data.details as Record<string, unknown>).extra).toBe('data');
      expect((result.data.payment as Record<string, unknown>).method).toBe('credit');
    }
  });

  test('rejects missing order_id', () => {
    const result = AmazonOrderSchema.safeParse({
      date: '2025-03-15',
    });
    expect(result.success).toBe(false);
  });
});
