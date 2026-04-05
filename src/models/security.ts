/**
 * Security model for Copilot Money data.
 *
 * Represents security master data — stocks, ETFs, mutual funds, cash equivalents.
 * Based on Firestore document structure in the securities collection.
 */

import { z } from 'zod';

/**
 * Security schema with validation.
 */
export const SecuritySchema = z
  .object({
    // Required fields
    security_id: z.string(),

    // Security identification
    ticker_symbol: z.string().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    provider_type: z.string().optional(),

    // Pricing
    close_price: z.number().optional(),
    current_price: z.number().optional(),
    close_price_as_of: z.string().nullable().optional(),

    // Classification
    is_cash_equivalent: z.boolean().optional(),
    iso_currency_code: z.string().optional(),

    // External identifiers
    isin: z.string().nullable().optional(),
    cusip: z.string().nullable().optional(),
    sedol: z.string().nullable().optional(),
    institution_id: z.string().nullable().optional(),
    institution_security_id: z.string().nullable().optional(),
    market_identifier_code: z.string().nullable().optional(),

    // Update metadata
    last_update: z.string().optional(),
    next_update: z.string().optional(),
    update_frequency: z.number().optional(),
    source: z.string().optional(),

    // Flags
    comparison: z.boolean().optional(),
    trades_24_7: z.boolean().optional(),

    // Rarely used
    unofficial_currency_code: z.string().nullable().optional(),
    cik: z.string().nullable().optional(),
    proxy_security_id: z.string().nullable().optional(),

    // Additional fields
    option_contract: z.string().nullable().optional(),
    _origin: z.string().optional(),
    info: z.record(z.string(), z.unknown()).optional(),
    update_datetime: z.string().nullable().optional(),
  })
  .passthrough();

export type Security = z.infer<typeof SecuritySchema>;
