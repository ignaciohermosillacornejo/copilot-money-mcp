/**
 * Account model for Copilot Money data.
 *
 * Based on Firestore document structure documented in REVERSE_ENGINEERING_FINDING.md.
 */

import { z } from 'zod';

/**
 * Account schema with validation.
 */
export const AccountSchema = z
  .object({
    // Required fields
    account_id: z.string(),
    current_balance: z.number(),

    // Account identification
    name: z.string().optional(),
    official_name: z.string().optional(),
    mask: z.string().optional(), // Last 4 digits

    // Account type
    account_type: z.string().optional(), // checking, savings, credit, investment, loan
    subtype: z.string().optional(),

    // Balances
    available_balance: z.number().optional(),

    // Institution
    item_id: z.string().optional(),
    institution_id: z.string().optional(),
    institution_name: z.string().optional(),

    // Metadata
    iso_currency_code: z.string().optional(),
  })
  .strict();

export type Account = z.infer<typeof AccountSchema>;

/**
 * Get the best display name for an account.
 */
export function getAccountDisplayName(account: Account): string {
  return account.name ?? account.official_name ?? 'Unknown';
}

/**
 * Extended account with computed display_name field.
 */
export interface AccountWithDisplayName extends Account {
  display_name: string;
}

/**
 * Add display_name to an account object.
 */
export function withDisplayName(account: Account): AccountWithDisplayName {
  return {
    ...account,
    display_name: getAccountDisplayName(account),
  };
}
