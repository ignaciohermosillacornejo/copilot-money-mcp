/**
 * Unit tests for PlaidAccount schema validation.
 */

import { describe, test, expect } from 'bun:test';
import { PlaidAccountSchema } from '../../src/models/plaid-account.js';

describe('PlaidAccountSchema', () => {
  test('validates minimal document with just plaid_account_id', () => {
    const result = PlaidAccountSchema.safeParse({
      plaid_account_id: 'plaid-acc-001',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plaid_account_id).toBe('plaid-acc-001');
    }
  });

  test('validates full document with holdings array', () => {
    const result = PlaidAccountSchema.safeParse({
      plaid_account_id: 'plaid-acc-002',
      account_id: 'acc-123',
      item_id: 'item-456',
      name: 'Brokerage Account',
      official_name: 'Individual Brokerage',
      mask: '1234',
      account_type: 'investment',
      subtype: 'brokerage',
      current_balance: 50000,
      available_balance: 50000,
      limit: null,
      iso_currency_code: 'USD',
      holdings: [
        {
          security_id: 'sec-001',
          account_id: 'acc-123',
          cost_basis: 10000,
          institution_price: 150.5,
          institution_value: 15050,
          quantity: 100,
          iso_currency_code: 'USD',
          vested_quantity: 100,
          vested_value: 15050,
        },
        {
          security_id: 'sec-002',
          cost_basis: null,
          institution_price: 25.0,
          institution_value: 2500,
          quantity: 100,
          iso_currency_code: 'USD',
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plaid_account_id).toBe('plaid-acc-002');
      expect(result.data.name).toBe('Brokerage Account');
      expect(result.data.holdings).toHaveLength(2);
      expect(result.data.holdings![0].cost_basis).toBe(10000);
      expect(result.data.holdings![1].cost_basis).toBeNull();
      expect(result.data.limit).toBeNull();
    }
  });

  test('passes through unknown fields', () => {
    const result = PlaidAccountSchema.safeParse({
      plaid_account_id: 'plaid-acc-003',
      some_unknown_field: 'hello',
      another_field: 42,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plaid_account_id).toBe('plaid-acc-003');
      expect((result.data as Record<string, unknown>).some_unknown_field).toBe('hello');
      expect((result.data as Record<string, unknown>).another_field).toBe(42);
    }
  });

  test('passes through unknown fields in holdings', () => {
    const result = PlaidAccountSchema.safeParse({
      plaid_account_id: 'plaid-acc-004',
      holdings: [
        {
          security_id: 'sec-001',
          unofficial_currency_code: 'BTC',
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.holdings![0].security_id).toBe('sec-001');
      expect((result.data.holdings![0] as Record<string, unknown>).unofficial_currency_code).toBe(
        'BTC'
      );
    }
  });

  test('rejects document without plaid_account_id', () => {
    const result = PlaidAccountSchema.safeParse({
      account_id: 'acc-123',
      name: 'Some Account',
    });
    expect(result.success).toBe(false);
  });

  /**
   * Regression: brokerage / IRA / Roth / CMA plaid accounts cache holdings
   * where `vested_quantity` and `vested_value` come through as literal null
   * (only stock-plan accounts populate these with numbers). Before the fix,
   * those nulls tripped Zod validation and the entire plaid account was
   * silently dropped by `processPlaidAccount` in the decoder.
   *
   * Parallel to PR #302, which fixed the same pattern in AccountHoldingSchema.
   */
  describe('holdings vested field nullability (parallel to #302)', () => {
    test('accepts holding with null vested_quantity and vested_value', () => {
      const result = PlaidAccountSchema.safeParse({
        plaid_account_id: 'plaid-acc-nullable',
        holdings: [
          {
            security_id: 'sec1',
            account_id: 'acc1',
            institution_price: 42.5,
            institution_value: 425,
            quantity: 10,
            cost_basis: null,
            vested_quantity: null,
            vested_value: null,
          },
        ],
      });

      expect(result.success).toBe(true);
    });

    test('accepts holding with numeric vested_quantity and vested_value', () => {
      const result = PlaidAccountSchema.safeParse({
        plaid_account_id: 'plaid-acc-numeric',
        holdings: [
          {
            security_id: 'sec1',
            quantity: 10,
            vested_quantity: 7,
            vested_value: 297.5,
          },
        ],
      });

      expect(result.success).toBe(true);
    });

    test('accepts holding when vested fields are omitted', () => {
      const result = PlaidAccountSchema.safeParse({
        plaid_account_id: 'plaid-acc-omitted',
        holdings: [{ security_id: 'sec1', quantity: 10 }],
      });

      expect(result.success).toBe(true);
    });
  });
});
