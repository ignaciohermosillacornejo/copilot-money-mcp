/**
 * Budget model for Copilot Money data.
 *
 * Represents budget rules and limits stored in Copilot's
 * /budgets/ Firestore collection.
 */

import { z } from 'zod';

/**
 * Known period values for budgets.
 * Used for documentation and type hints.
 */
export const KNOWN_PERIODS = ['monthly', 'yearly', 'weekly', 'daily'] as const;

export type KnownPeriod = (typeof KNOWN_PERIODS)[number];

/**
 * Date format regex for YYYY-MM-DD validation.
 */
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Budget schema with validation.
 *
 * Represents user-defined spending limits and budget rules.
 */
export const BudgetSchema = z
  .object({
    // Required fields
    budget_id: z.string(),

    // Budget details
    name: z.string().optional(),
    amount: z.number().optional(),
    period: z.enum(['monthly', 'yearly', 'weekly', 'daily']).optional(),

    // Category association
    category_id: z.string().optional(),

    // Date range
    start_date: z.string().regex(DATE_REGEX, 'Must be YYYY-MM-DD format').optional(),
    end_date: z.string().regex(DATE_REGEX, 'Must be YYYY-MM-DD format').optional(),

    // Status
    is_active: z.boolean().optional(),

    // Metadata
    iso_currency_code: z.string().optional(),
  })
  .strict();

export type Budget = z.infer<typeof BudgetSchema>;

/**
 * Get the best display name for a budget.
 */
export function getBudgetDisplayName(budget: Budget): string {
  return budget.name ?? budget.category_id ?? 'Unknown Budget';
}
