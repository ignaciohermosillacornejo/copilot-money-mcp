/**
 * Recurring transaction model for Copilot Money data.
 *
 * Represents subscriptions and recurring charges stored in Copilot's
 * /recurring/ Firestore collection.
 */

import { z } from 'zod';

/**
 * Known frequency values for recurring transactions.
 * Used for documentation and type hints; the schema accepts any string
 * to handle unexpected values from the database.
 */
export const KNOWN_FREQUENCIES = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'yearly',
] as const;

export type KnownFrequency = (typeof KNOWN_FREQUENCIES)[number];

/**
 * Date format regex for YYYY-MM-DD validation.
 */
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

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
    frequency: z.enum(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']).optional(),
    next_date: z.string().regex(DATE_REGEX, 'Must be YYYY-MM-DD format').optional(),
    last_date: z.string().regex(DATE_REGEX, 'Must be YYYY-MM-DD format').optional(),

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
