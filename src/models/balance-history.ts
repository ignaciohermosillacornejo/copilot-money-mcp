/**
 * Balance history model — daily balance snapshots for accounts.
 *
 * Firestore path: items/{item_id}/accounts/{account_id}/balance_history/{date}
 * The document ID is the date (YYYY-MM-DD).
 */

import { z } from 'zod';

export const BalanceHistorySchema = z
  .object({
    balance_id: z.string(), // constructed: {item_id}:{account_id}:{date}
    date: z.string(),
    item_id: z.string(),
    account_id: z.string(),
    current_balance: z.number().optional(),
    available_balance: z.number().optional(),
    limit: z.number().nullable().optional(),
    _origin: z.string().optional(),
  })
  .passthrough();

export type BalanceHistory = z.infer<typeof BalanceHistorySchema>;
