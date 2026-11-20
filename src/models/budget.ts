/**
 * Budget model for Copilot Money data.
 *
 * Represents budget rules and limits stored in Copilot's
 * /budgets/ Firestore collection.
 */

import { z } from 'zod';
import { calendarDateField } from './calendar-date.js';

/**
 * Known period values for budgets.
 * Used for documentation and type hints.
 */
export const KNOWN_PERIODS = ['monthly', 'yearly', 'weekly', 'daily'] as const;

export type KnownPeriod = (typeof KNOWN_PERIODS)[number];

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
    start_date: calendarDateField().optional(),
    end_date: calendarDateField().optional(),

    // Status
    is_active: z.boolean().optional(),

    // Metadata
    iso_currency_code: z.string().optional(),

    // Additional fields
    amounts: z.record(z.string(), z.number()).optional(),
    id: z.string().optional(),
  })
  .passthrough();

export type Budget = z.infer<typeof BudgetSchema>;

/**
 * Get the best display name for a budget.
 */
export function getBudgetDisplayName(budget: Budget): string {
  return budget.name ?? budget.category_id ?? 'Unknown Budget';
}
