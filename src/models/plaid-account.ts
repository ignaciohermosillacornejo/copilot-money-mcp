/**
 * Plaid account model — represents raw Plaid account data stored under items/{id}/accounts/{id}.
 *
 * These are the Plaid-level account records, distinct from the user-facing Account model.
 * They include holdings data for investment accounts (cost basis, quantities, etc.).
 */

import { z } from 'zod';

const HoldingSchema = z
  .object({
    security_id: z.string().optional(),
    account_id: z.string().optional(),
    cost_basis: z.number().nullable().optional(),
    institution_price: z.number().optional(),
    institution_value: z.number().optional(),
    quantity: z.number().optional(),
    iso_currency_code: z.string().optional(),
    vested_quantity: z.number().optional(),
    vested_value: z.number().optional(),
  })
  .passthrough();

export const PlaidAccountSchema = z
  .object({
    plaid_account_id: z.string(),
    account_id: z.string().optional(),
    item_id: z.string().optional(),
    name: z.string().optional(),
    official_name: z.string().optional(),
    mask: z.string().optional(),
    account_type: z.string().optional(),
    subtype: z.string().optional(),
    current_balance: z.number().optional(),
    available_balance: z.number().optional(),
    limit: z.number().nullable().optional(),
    iso_currency_code: z.string().optional(),
    holdings: z.array(HoldingSchema).optional(),
  })
  .passthrough();

export type PlaidAccount = z.infer<typeof PlaidAccountSchema>;
export type Holding = z.infer<typeof HoldingSchema>;
