/**
 * Unit tests for item (Plaid connection) functionality.
 *
 * Tests the item model, schema validation, and helper functions.
 */

import { describe, test, expect } from 'bun:test';
import {
  ItemSchema,
  getItemDisplayName,
  isItemHealthy,
  itemNeedsAttention,
  getItemStatusDescription,
  getItemAccountCount,
  formatLastUpdate,
  isConsentExpiringSoon,
  type Item,
} from '../../src/models/item.js';

describe('ItemSchema', () => {
  test('validates valid item with all fields', () => {
    const validItem = {
      item_id: 'item_abc123def456',
      user_id: 'user_xyz789',
      institution_id: 'ins_3',
      institution_name: 'Chase',
      connection_status: 'active',
      last_successful_update: '2024-01-15T10:30:00Z',
      error_code: 'ITEM_NO_ERROR',
      needs_update: false,
      accounts: ['acc_1', 'acc_2', 'acc_3'],
      account_count: 3,
      created_at: '2023-06-01T00:00:00Z',
      updated_at: '2024-01-15T10:30:00Z',
    };

    const result = ItemSchema.safeParse(validItem);
    expect(result.success).toBe(true);
  });

  test('validates item with minimal required fields', () => {
    const minimalItem = {
      item_id: 'item_minimal123',
    };

    const result = ItemSchema.safeParse(minimalItem);
    expect(result.success).toBe(true);
  });

  test('validates item with error state', () => {
    const errorItem = {
      item_id: 'item_error123',
      institution_name: 'Wells Fargo',
      connection_status: 'error',
      error_code: 'ITEM_LOGIN_REQUIRED',
      error_message: 'Please re-authenticate your account',
      error_type: 'ITEM_ERROR',
      needs_update: true,
    };

    const result = ItemSchema.safeParse(errorItem);
    expect(result.success).toBe(true);
  });

  test('validates item with available products', () => {
    const itemWithProducts = {
      item_id: 'item_products123',
      institution_name: 'Bank of America',
      available_products: ['transactions', 'balance', 'investments'],
      billed_products: ['transactions', 'balance'],
    };

    const result = ItemSchema.safeParse(itemWithProducts);
    expect(result.success).toBe(true);
  });

  test('passes through unknown fields', () => {
    const withExtra = {
      item_id: 'item_extra123',
      custom_field: 'extra_data',
    };

    const result = ItemSchema.safeParse(withExtra);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty('custom_field');
    }
  });
});

describe('getItemDisplayName', () => {
  test('returns institution_name when available', () => {
    const item: Item = {
      item_id: 'item_123',
      institution_name: 'Chase',
      institution_id: 'ins_3',
    };

    expect(getItemDisplayName(item)).toBe('Chase');
  });

  test('returns institution_id when name unavailable', () => {
    const item: Item = {
      item_id: 'item_123',
      institution_id: 'ins_3',
    };

    expect(getItemDisplayName(item)).toBe('ins_3');
  });

  test('returns item_id as fallback', () => {
    const item: Item = {
      item_id: 'item_123abc',
    };

    expect(getItemDisplayName(item)).toBe('item_123abc');
  });
});

describe('isItemHealthy', () => {
  test('returns true for active item with no errors', () => {
    const item: Item = {
      item_id: 'item_1',
      connection_status: 'active',
      error_code: 'ITEM_NO_ERROR',
      needs_update: false,
    };

    expect(isItemHealthy(item)).toBe(true);
  });

  test('returns true for item with minimal data (no status)', () => {
    const item: Item = {
      item_id: 'item_1',
    };

    expect(isItemHealthy(item)).toBe(true);
  });

  test('returns false for error status', () => {
    const item: Item = {
      item_id: 'item_1',
      connection_status: 'error',
    };

    expect(isItemHealthy(item)).toBe(false);
  });

  test('returns false for disconnected status', () => {
    const item: Item = {
      item_id: 'item_1',
      connection_status: 'disconnected',
    };

    expect(isItemHealthy(item)).toBe(false);
  });

  test('returns false when needs_update is true', () => {
    const item: Item = {
      item_id: 'item_1',
      connection_status: 'active',
      needs_update: true,
    };

    expect(isItemHealthy(item)).toBe(false);
  });

  test('returns false when error_code indicates problem', () => {
    const item: Item = {
      item_id: 'item_1',
      connection_status: 'active',
      error_code: 'ITEM_LOGIN_REQUIRED',
    };

    expect(isItemHealthy(item)).toBe(false);
  });
});

describe('itemNeedsAttention', () => {
  test('returns true when needs_update is true', () => {
    const item: Item = {
      item_id: 'item_1',
      needs_update: true,
    };

    expect(itemNeedsAttention(item)).toBe(true);
  });

  test('returns true for error status', () => {
    const item: Item = {
      item_id: 'item_1',
      connection_status: 'error',
    };

    expect(itemNeedsAttention(item)).toBe(true);
  });

  test('returns true for disconnected status', () => {
    const item: Item = {
      item_id: 'item_1',
      connection_status: 'disconnected',
    };

    expect(itemNeedsAttention(item)).toBe(true);
  });

  test('returns true for login required error', () => {
    const item: Item = {
      item_id: 'item_1',
      error_code: 'ITEM_LOGIN_REQUIRED',
    };

    expect(itemNeedsAttention(item)).toBe(true);
  });

  test('returns true for invalid credentials error', () => {
    const item: Item = {
      item_id: 'item_1',
      error_code: 'INVALID_CREDENTIALS',
    };

    expect(itemNeedsAttention(item)).toBe(true);
  });

  test('returns true for invalid MFA error', () => {
    const item: Item = {
      item_id: 'item_1',
      error_code: 'INVALID_MFA',
    };

    expect(itemNeedsAttention(item)).toBe(true);
  });

  test('returns false for healthy item', () => {
    const item: Item = {
      item_id: 'item_1',
      connection_status: 'active',
      needs_update: false,
      error_code: 'ITEM_NO_ERROR',
    };

    expect(itemNeedsAttention(item)).toBe(false);
  });

  test('returns false for minimal healthy item', () => {
    const item: Item = {
      item_id: 'item_1',
    };

    expect(itemNeedsAttention(item)).toBe(false);
  });
});

describe('getItemStatusDescription', () => {
  test('returns Connected for healthy item', () => {
    const item: Item = {
      item_id: 'item_1',
      connection_status: 'active',
    };

    expect(getItemStatusDescription(item)).toBe('Connected');
  });

  test('returns appropriate message for login required', () => {
    const item: Item = {
      item_id: 'item_1',
      error_code: 'ITEM_LOGIN_REQUIRED',
    };

    expect(getItemStatusDescription(item)).toBe('Re-authentication required');
  });

  test('returns appropriate message for invalid credentials', () => {
    const item: Item = {
      item_id: 'item_1',
      error_code: 'INVALID_CREDENTIALS',
    };

    expect(getItemStatusDescription(item)).toBe('Invalid credentials');
  });

  test('returns appropriate message for institution down', () => {
    const item: Item = {
      item_id: 'item_1',
      error_code: 'INSTITUTION_DOWN',
    };

    expect(getItemStatusDescription(item)).toBe('Institution temporarily unavailable');
  });

  test('returns Disconnected for disconnected status', () => {
    const item: Item = {
      item_id: 'item_1',
      connection_status: 'disconnected',
    };

    expect(getItemStatusDescription(item)).toBe('Disconnected');
  });

  test('returns error message when available', () => {
    const item: Item = {
      item_id: 'item_1',
      connection_status: 'error',
      error_message: 'Custom error message',
    };

    expect(getItemStatusDescription(item)).toBe('Custom error message');
  });

  test('returns Update required when needs_update is true', () => {
    const item: Item = {
      item_id: 'item_1',
      needs_update: true,
    };

    expect(getItemStatusDescription(item)).toBe('Update required');
  });
});

describe('getItemAccountCount', () => {
  test('returns account_count when available', () => {
    const item: Item = {
      item_id: 'item_1',
      account_count: 5,
      accounts: ['acc_1', 'acc_2'], // Should be ignored
    };

    expect(getItemAccountCount(item)).toBe(5);
  });

  test('returns accounts array length when account_count unavailable', () => {
    const item: Item = {
      item_id: 'item_1',
      accounts: ['acc_1', 'acc_2', 'acc_3'],
    };

    expect(getItemAccountCount(item)).toBe(3);
  });

  test('returns 0 when no account data available', () => {
    const item: Item = {
      item_id: 'item_1',
    };

    expect(getItemAccountCount(item)).toBe(0);
  });
});

describe('formatLastUpdate', () => {
  test('formats last_successful_update', () => {
    const item: Item = {
      item_id: 'item_1',
      last_successful_update: '2024-01-15T10:30:00Z',
    };

    const formatted = formatLastUpdate(item);
    expect(formatted).toContain('Jan');
    expect(formatted).toContain('15');
    expect(formatted).toContain('2024');
  });

  test('falls back to updated_at', () => {
    const item: Item = {
      item_id: 'item_1',
      updated_at: '2024-03-20T14:00:00Z',
    };

    const formatted = formatLastUpdate(item);
    expect(formatted).toContain('Mar');
    expect(formatted).toContain('20');
    expect(formatted).toContain('2024');
  });

  test('returns undefined when no timestamp available', () => {
    const item: Item = {
      item_id: 'item_1',
    };

    expect(formatLastUpdate(item)).toBeUndefined();
  });

  test('prefers last_successful_update over updated_at', () => {
    const item: Item = {
      item_id: 'item_1',
      last_successful_update: '2024-01-15T10:30:00Z',
      updated_at: '2024-03-20T14:00:00Z',
    };

    const formatted = formatLastUpdate(item);
    expect(formatted).toContain('Jan');
    expect(formatted).toContain('15');
  });
});

describe('isConsentExpiringSoon', () => {
  test('returns false when no consent_expiration_time', () => {
    const item: Item = {
      item_id: 'item_1',
    };

    expect(isConsentExpiringSoon(item)).toBe(false);
  });

  test('returns true when consent expires within 30 days', () => {
    // Set expiration to 10 days from now
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 10);

    const item: Item = {
      item_id: 'item_1',
      consent_expiration_time: futureDate.toISOString(),
    };

    expect(isConsentExpiringSoon(item)).toBe(true);
  });

  test('returns false when consent expires in more than 30 days', () => {
    // Set expiration to 60 days from now
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 60);

    const item: Item = {
      item_id: 'item_1',
      consent_expiration_time: futureDate.toISOString(),
    };

    expect(isConsentExpiringSoon(item)).toBe(false);
  });

  test('returns true when consent already expired', () => {
    // Set expiration to 10 days ago
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 10);

    const item: Item = {
      item_id: 'item_1',
      consent_expiration_time: pastDate.toISOString(),
    };

    expect(isConsentExpiringSoon(item)).toBe(true);
  });
});

describe('Item helper functions integration', () => {
  test('all helper functions work together for healthy Chase item', () => {
    const chaseItem: Item = {
      item_id: 'item_chase_123',
      institution_id: 'ins_3',
      institution_name: 'Chase',
      connection_status: 'active',
      error_code: 'ITEM_NO_ERROR',
      needs_update: false,
      accounts: ['acc_checking', 'acc_savings', 'acc_credit'],
      account_count: 3,
      last_successful_update: '2024-01-15T10:30:00Z',
    };

    expect(getItemDisplayName(chaseItem)).toBe('Chase');
    expect(isItemHealthy(chaseItem)).toBe(true);
    expect(itemNeedsAttention(chaseItem)).toBe(false);
    expect(getItemStatusDescription(chaseItem)).toBe('Connected');
    expect(getItemAccountCount(chaseItem)).toBe(3);
    expect(formatLastUpdate(chaseItem)).toContain('Jan');
  });

  test('all helper functions work together for item needing attention', () => {
    const errorItem: Item = {
      item_id: 'item_error_456',
      institution_name: 'Wells Fargo',
      connection_status: 'error',
      error_code: 'ITEM_LOGIN_REQUIRED',
      error_message: 'Please re-authenticate',
      needs_update: true,
      account_count: 2,
    };

    expect(getItemDisplayName(errorItem)).toBe('Wells Fargo');
    expect(isItemHealthy(errorItem)).toBe(false);
    expect(itemNeedsAttention(errorItem)).toBe(true);
    expect(getItemStatusDescription(errorItem)).toBe('Re-authentication required');
    expect(getItemAccountCount(errorItem)).toBe(2);
  });

  test('schema validates and functions work on parsed data', () => {
    const rawData = {
      item_id: 'item_parsed_789',
      institution_name: 'Bank of America',
      connection_status: 'active',
      accounts: ['acc_1', 'acc_2'],
    };

    const result = ItemSchema.safeParse(rawData);
    expect(result.success).toBe(true);

    if (result.success) {
      const item = result.data;
      expect(getItemDisplayName(item)).toBe('Bank of America');
      expect(isItemHealthy(item)).toBe(true);
      expect(itemNeedsAttention(item)).toBe(false);
      expect(getItemAccountCount(item)).toBe(2);
    }
  });
});
