/**
 * Transaction model for Copilot Money data.
 *
 * Based on Firestore document structure documented in REVERSE_ENGINEERING_FINDING.md.
 */

import { z } from 'zod';

/**
 * Transaction schema with validation.
 *
 * Amount sign convention (Copilot Money format):
 * - Positive amounts = expenses (money going OUT)
 * - Negative amounts = income/credits (money coming IN)
 *
 * Note: This is the opposite of standard accounting convention.
 */
export const TransactionSchema = z
  .object({
    // Required fields
    transaction_id: z.string(),
    amount: z.number().refine((val) => Math.abs(val) <= 10_000_000, {
      message: 'Amount exceeds maximum allowed value',
    }),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),

    // Merchant/name fields
    name: z.string().optional(),
    original_name: z.string().optional(),
    original_clean_name: z.string().optional(),
    name_override: z.string().optional(),

    // Account & categorization
    account_id: z.string().optional(),
    item_id: z.string().optional(),
    user_id: z.string().optional(),
    category_id: z.string().optional(),
    plaid_category_id: z.string().optional(),
    category_id_source: z.string().optional(),
    plaid_category_strings: z.array(z.string()).optional(),
    account_type: z.string().optional(),

    // Dates
    original_date: z.string().optional(),
    created_timestamp: z.string().optional(),

    // Amounts
    original_amount: z.number().optional(),
    pending_amount: z.number().optional(),

    // Status flags
    pending: z.boolean().optional(),
    pending_transaction_id: z.string().optional(),
    user_reviewed: z.boolean().optional(),
    plaid_deleted: z.boolean().optional(),
    excluded: z.boolean().optional(), // True if excluded from spending calculations
    internal_transfer: z.boolean().optional(), // True if this is an internal transfer between accounts
    is_manual: z.boolean().optional(),
    recurring: z.boolean().optional(),
    skip_balance_adjust: z.boolean().optional(),
    user_deleted: z.boolean().optional(),

    // Transaction type
    transaction_type: z.string().optional(), // "place", "special", "digital", etc.

    // Payment info
    payment_method: z.string().optional(),
    payment_processor: z.string().optional(),

    // Location
    city: z.string().optional(),
    region: z.string().optional(),
    address: z.string().optional(),
    postal_code: z.string().optional(),
    country: z.string().optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),

    // Metadata
    iso_currency_code: z.string().optional(),
    plaid_transaction_type: z.string().optional(),
    is_amazon: z.boolean().optional(),
    from_investment: z.union([z.string(), z.boolean()]).optional(),
    account_dashboard_active: z.boolean().optional(),
    user_note: z.string().optional(),
    _origin: z.string().optional(),

    // Intelligence fields
    intelligence_suggested_category_ids: z.array(z.string()).optional(),
    intelligence_chosen_category_id: z.string().optional(),
    intelligence_powered: z.boolean().optional(),

    // Recurring references
    recurring_id: z.string().optional(),

    // Pending/posted references
    plaid_pending_transaction_id: z.string().optional(),
    posted_transaction_id: z.string().optional(),
    original_transaction_id: z.string().optional(),

    // Split-transaction linkage. When the user splits a transaction in Copilot,
    // the original doc gains `children_transaction_ids` and each new child doc
    // gets `parent_transaction_id`. Both fields are bidirectional pointers.
    parent_transaction_id: z.string().optional(),
    children_transaction_ids: z.array(z.string()).optional(),

    // Tags
    tag_ids: z.array(z.string()).optional(),

    // Goal link
    goal_id: z.string().optional(), // Financial goal this transaction is linked to

    // Complex nested data
    internal_tx_match: z.record(z.string(), z.unknown()).optional(),
    venmo_extra_data: z.record(z.string(), z.unknown()).optional(),
    old_category_id: z.string().optional(),

    // References
    reference_number: z.string().optional(),
    ppd_id: z.string().optional(),
    by_order_of: z.string().optional(),
  })
  .passthrough();

export type Transaction = z.infer<typeof TransactionSchema>;

/**
 * Get the best display name for a transaction.
 */
export function getTransactionDisplayName(transaction: Transaction): string {
  return transaction.name ?? transaction.original_name ?? 'Unknown';
}

/**
 * Extended transaction with computed display_name field.
 */
export interface TransactionWithDisplayName extends Transaction {
  display_name: string;
}

/**
 * Add display_name to a transaction object.
 */
export function withDisplayName(transaction: Transaction): TransactionWithDisplayName {
  return {
    ...transaction,
    display_name: getTransactionDisplayName(transaction),
  };
}
