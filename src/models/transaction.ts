/**
 * Transaction model for Copilot Money data.
 *
 * Based on Firestore document structure documented in REVERSE_ENGINEERING_FINDING.md.
 */

import { z } from 'zod';

/**
 * Transaction schema with validation.
 *
 * Positive amounts = expenses
 * Negative amounts = income/credits
 */
export const TransactionSchema = z
  .object({
    // Required fields
    transaction_id: z.string(),
    amount: z
      .number()
      .refine((val) => Math.abs(val) <= 10_000_000, {
        message: 'Amount exceeds maximum allowed value',
      }),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),

    // Merchant/name fields
    name: z.string().optional(),
    original_name: z.string().optional(),
    original_clean_name: z.string().optional(),

    // Account & categorization
    account_id: z.string().optional(),
    item_id: z.string().optional(),
    user_id: z.string().optional(),
    category_id: z.string().optional(),
    plaid_category_id: z.string().optional(),
    category_id_source: z.string().optional(),

    // Dates
    original_date: z.string().optional(),

    // Amounts
    original_amount: z.number().optional(),

    // Status flags
    pending: z.boolean().optional(),
    pending_transaction_id: z.string().optional(),
    user_reviewed: z.boolean().optional(),
    plaid_deleted: z.boolean().optional(),

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
    from_investment: z.string().optional(),
    account_dashboard_active: z.boolean().optional(),

    // References
    reference_number: z.string().optional(),
    ppd_id: z.string().optional(),
    by_order_of: z.string().optional(),
  })
  .strict();

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
