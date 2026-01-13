/**
 * Investment holding model for Copilot Money data.
 *
 * Represents investment positions stored in Copilot's
 * /holdings_history/ Firestore collection.
 */

import { z } from 'zod';

/**
 * Investment holding schema with validation.
 *
 * Each entry represents a security position in an investment account.
 */
export const HoldingSchema = z
  .object({
    // Required fields
    holding_id: z.string(),

    // Account reference
    account_id: z.string().optional(),

    // Security details
    security_name: z.string().optional(),
    ticker: z.string().optional(),

    // Position data
    quantity: z.number().optional(),
    price: z.number().optional(),
    value: z.number().optional(),
    cost_basis: z.number().optional(),

    // Metadata
    iso_currency_code: z.string().optional(),
    date: z.string().optional(), // YYYY-MM-DD - snapshot date
  })
  .strict();

export type Holding = z.infer<typeof HoldingSchema>;

/**
 * Get the best display name for a holding.
 */
export function getHoldingDisplayName(holding: Holding): string {
  if (holding.ticker && holding.security_name) {
    return `${holding.ticker} - ${holding.security_name}`;
  }
  return holding.ticker ?? holding.security_name ?? 'Unknown';
}
