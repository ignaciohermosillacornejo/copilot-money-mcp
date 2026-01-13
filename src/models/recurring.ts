/**
 * Recurring transaction model for Copilot Money data.
 *
 * Represents subscriptions and recurring charges stored in Copilot's
 * /recurring/ Firestore collection.
 */

import { z } from 'zod';

/**
 * Recurring transaction schema with validation.
 *
 * This represents Copilot's native subscription tracking data,
 * separate from pattern-based detection.
 */
export const RecurringSchema = z
  .object({
    // Required fields
    recurring_id: z.string(),

    // Transaction details
    name: z.string().optional(),
    merchant_name: z.string().optional(),
    amount: z.number().optional(),

    // Frequency and schedule
    frequency: z.string().optional(), // "monthly", "weekly", "yearly", "biweekly"
    next_date: z.string().optional(), // YYYY-MM-DD
    last_date: z.string().optional(), // YYYY-MM-DD

    // References
    category_id: z.string().optional(),
    account_id: z.string().optional(),

    // Status
    is_active: z.boolean().optional(),

    // Metadata
    iso_currency_code: z.string().optional(),
  })
  .strict();

export type Recurring = z.infer<typeof RecurringSchema>;

/**
 * Get the best display name for a recurring transaction.
 */
export function getRecurringDisplayName(recurring: Recurring): string {
  return recurring.name ?? recurring.merchant_name ?? 'Unknown';
}
