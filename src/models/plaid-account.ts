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
    historical_update: z.boolean().optional(),
    institution_id: z.string().optional(),
    institution_name: z.string().optional(),
    investments_performance_enabled: z.boolean().optional(),
    holdings_initialized: z.boolean().optional(),
    latest_balance_update: z.string().optional(),
    original_current_balance: z.number().optional(),
    original_subtype: z.string().optional(),
    original_type: z.string().optional(),
    provider_deleted: z.boolean().optional(),
    savings_active: z.boolean().optional(),
    color: z.string().optional(),
    logo: z.string().optional(),
    logo_content_type: z.string().optional(),
    dashboard_active: z.boolean().optional(),
    live_balance_backend_disabled: z.boolean().optional(),
    live_balance_user_disabled: z.boolean().optional(),
    nickname: z.string().optional(),
    verification_status: z.string().nullable().optional(),
    user_hidden: z.boolean().optional(),
    user_deleted: z.boolean().optional(),
    _origin: z.string().optional(),
    id: z.string().optional(),
    user_id: z.string().optional(),
    is_manual: z.boolean().optional(),
    custom_color: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    group_id: z.string().optional(),
    group_leader: z.boolean().optional(),
    merged: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type PlaidAccount = z.infer<typeof PlaidAccountSchema>;
export type Holding = z.infer<typeof HoldingSchema>;
