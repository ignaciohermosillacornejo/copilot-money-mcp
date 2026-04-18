/**
 * Schema tests for AccountSchema, focused on holdings field nullability.
 *
 * Regression: brokerage / IRA / Roth / CMA accounts cache holdings where
 * `vested_quantity` and `vested_value` come through as literal null (only
 * stock-plan accounts populate these with numbers). Before the fix, those
 * nulls tripped Zod validation and the entire account was silently dropped
 * by `processAccount` in the decoder, so `get_accounts` underreported.
 */

import { describe, test, expect } from 'bun:test';
import { AccountSchema } from '../../src/models/account.js';

describe('AccountSchema', () => {
  test('accepts holding with null vested_quantity and vested_value', () => {
    const result = AccountSchema.safeParse({
      account_id: 'acc1',
      current_balance: 100,
      name: 'Individual Brokerage',
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
    const result = AccountSchema.safeParse({
      account_id: 'acc1',
      current_balance: 100,
      name: 'Stock Plan',
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
    const result = AccountSchema.safeParse({
      account_id: 'acc1',
      current_balance: 100,
      holdings: [{ security_id: 'sec1', quantity: 10 }],
    });

    expect(result.success).toBe(true);
  });
});
