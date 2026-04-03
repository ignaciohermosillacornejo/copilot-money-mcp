/**
 * Unit tests for app metadata schema validation.
 */

import { describe, test, expect } from 'bun:test';
import {
  SubscriptionSchema,
  InviteSchema,
  UserItemsSchema,
  FeatureTrackingSchema,
  SupportSchema,
} from '../../src/models/app-metadata.js';

describe('SubscriptionSchema', () => {
  test('validates minimal document with just subscription_id', () => {
    const result = SubscriptionSchema.safeParse({
      subscription_id: 'sub-123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subscription_id).toBe('sub-123');
    }
  });

  test('validates full document with all fields', () => {
    const result = SubscriptionSchema.safeParse({
      subscription_id: 'sub-123',
      product_id: 'copilot_yearly',
      provider: 'apple',
      environment: 'Production',
      price: 69.99,
      user_id: 'user-1',
      will_auto_renew: true,
      is_eligible_for_initial_offer: false,
      expires_date_ms: '1735689600000',
      created_timestamp: '2024-01-01T00:00:00Z',
      original_transaction_id: 'txn-orig-1',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.product_id).toBe('copilot_yearly');
      expect(result.data.price).toBe(69.99);
      expect(result.data.will_auto_renew).toBe(true);
    }
  });

  test('passes through unknown fields', () => {
    const result = SubscriptionSchema.safeParse({
      subscription_id: 'sub-123',
      some_future_field: 'hello',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).some_future_field).toBe('hello');
    }
  });

  test('accepts numeric expires_date_ms', () => {
    const result = SubscriptionSchema.safeParse({
      subscription_id: 'sub-123',
      expires_date_ms: 1735689600000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.expires_date_ms).toBe(1735689600000);
    }
  });

  test('rejects missing subscription_id', () => {
    const result = SubscriptionSchema.safeParse({
      product_id: 'copilot_yearly',
    });
    expect(result.success).toBe(false);
  });
});

describe('InviteSchema', () => {
  test('validates minimal document with just invite_id', () => {
    const result = InviteSchema.safeParse({
      invite_id: 'inv-1',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.invite_id).toBe('inv-1');
    }
  });

  test('validates full document with all fields', () => {
    const result = InviteSchema.safeParse({
      invite_id: 'inv-1',
      code: 'FRIEND2024',
      inviter_id: 'user-1',
      is_available: true,
      is_unlimited: false,
      assigned: false,
      product_id: 'copilot_monthly',
      offer_reviewed: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe('FRIEND2024');
      expect(result.data.is_available).toBe(true);
    }
  });

  test('passes through unknown fields', () => {
    const result = InviteSchema.safeParse({
      invite_id: 'inv-1',
      extra: 42,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).extra).toBe(42);
    }
  });

  test('rejects missing invite_id', () => {
    const result = InviteSchema.safeParse({
      code: 'FRIEND2024',
    });
    expect(result.success).toBe(false);
  });
});

describe('UserItemsSchema', () => {
  test('validates minimal document', () => {
    const result = UserItemsSchema.safeParse({
      user_items_id: 'ui-1',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.user_items_id).toBe('ui-1');
    }
  });

  test('passes through unknown fields', () => {
    const result = UserItemsSchema.safeParse({
      user_items_id: 'ui-1',
      items: ['item-1', 'item-2'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).items).toEqual(['item-1', 'item-2']);
    }
  });

  test('rejects missing user_items_id', () => {
    const result = UserItemsSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('FeatureTrackingSchema', () => {
  test('validates minimal document', () => {
    const result = FeatureTrackingSchema.safeParse({
      feature_tracking_id: 'ft-1',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.feature_tracking_id).toBe('ft-1');
    }
  });

  test('passes through unknown fields', () => {
    const result = FeatureTrackingSchema.safeParse({
      feature_tracking_id: 'ft-1',
      onboarding_complete: true,
      steps_completed: ['step1', 'step2'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).onboarding_complete).toBe(true);
    }
  });

  test('rejects missing feature_tracking_id', () => {
    const result = FeatureTrackingSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('SupportSchema', () => {
  test('validates minimal document', () => {
    const result = SupportSchema.safeParse({
      support_id: 'sup-1',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.support_id).toBe('sup-1');
    }
  });

  test('passes through unknown fields', () => {
    const result = SupportSchema.safeParse({
      support_id: 'sup-1',
      feature_flags: { dark_mode: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).feature_flags).toEqual({ dark_mode: true });
    }
  });

  test('rejects missing support_id', () => {
    const result = SupportSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
