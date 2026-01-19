/**
 * Recurring transaction model for Copilot Money data.
 *
 * Represents subscriptions and recurring charges stored in Copilot's
 * /recurring/ Firestore collection.
 */

import { z } from 'zod';

/**
 * Known frequency values for recurring transactions.
 * Maps raw frequency strings to display-friendly names.
 */
export const KNOWN_FREQUENCIES = [
  'daily',
  'weekly',
  'biweekly', // Every 2 weeks
  'monthly',
  'bimonthly', // Every 2 months
  'quarterly', // Every 3 months
  'quadmonthly', // Every 4 months
  'semiannually', // Every 6 months
  'yearly',
] as const;

export type KnownFrequency = (typeof KNOWN_FREQUENCIES)[number];

/**
 * State values for recurring items.
 */
export const RECURRING_STATES = ['active', 'paused', 'archived'] as const;
export type RecurringState = (typeof RECURRING_STATES)[number];

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
    min_amount: z.number().optional(),
    max_amount: z.number().optional(),
    emoji: z.string().optional(),

    // Frequency and schedule
    frequency: z.string().optional(), // Accept any string since Copilot uses various values
    next_date: z.string().regex(DATE_REGEX, 'Must be YYYY-MM-DD format').optional(),
    last_date: z.string().regex(DATE_REGEX, 'Must be YYYY-MM-DD format').optional(),
    days_filter: z.number().optional(), // Day of month filter

    // References
    category_id: z.string().optional(),
    plaid_category_id: z.string().optional(),
    account_id: z.string().optional(),

    // Status - state is the primary field, is_active derived for compatibility
    state: z.enum(['active', 'paused', 'archived']).optional(),
    is_active: z.boolean().optional(),

    // Matching rules
    match_string: z.string().optional(),

    // Associated transactions
    transaction_ids: z.array(z.string()).optional(),

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
