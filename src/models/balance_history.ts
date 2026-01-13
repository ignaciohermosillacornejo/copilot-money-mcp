/**
 * Balance history model for Copilot Money data.
 *
 * Represents historical account balance snapshots stored in Copilot's
 * /balance_history/ Firestore collection.
 */

import { z } from 'zod';

/**
 * Balance history entry schema with validation.
 *
 * Each entry represents a balance snapshot for an account at a specific date.
 */
export const BalanceHistorySchema = z
  .object({
    // Required fields
    account_id: z.string(),
    date: z.string(), // YYYY-MM-DD
    balance: z.number(),

    // Optional metadata
    iso_currency_code: z.string().optional(),
  })
  .strict();

export type BalanceHistory = z.infer<typeof BalanceHistorySchema>;
