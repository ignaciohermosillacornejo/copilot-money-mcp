/**
 * Financial Goal model for Copilot Money data.
 *
 * Represents savings goals and targets stored in Copilot's
 * /users/{user_id}/financial_goals/{goal_id} Firestore collection.
 */

import { z } from 'zod';

/**
 * Known goal status values.
 */
export const KNOWN_GOAL_STATUSES = ['active', 'paused', 'completed', 'cancelled'] as const;

export type KnownGoalStatus = (typeof KNOWN_GOAL_STATUSES)[number];

/**
 * Known goal types.
 */
export const KNOWN_GOAL_TYPES = ['savings', 'debt', 'investment'] as const;

export type KnownGoalType = (typeof KNOWN_GOAL_TYPES)[number];

/**
 * Date format regex for YYYY-MM-DD validation.
 */
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Savings configuration nested object schema.
 */
const SavingsConfigSchema = z
  .object({
    type: z.string().optional(), // "savings", "debt", etc.
    status: z.string().optional(), // "active", "paused", etc.
    target_amount: z.number().optional(),
    tracking_type: z.string().optional(), // "monthly_contribution", etc.
    tracking_type_monthly_contribution: z.number().optional(),
    start_date: z.string().regex(DATE_REGEX, 'Must be YYYY-MM-DD format').optional(),
    modified_start_date: z.boolean().optional(),
    inflates_budget: z.boolean().optional(),
    is_ongoing: z.boolean().optional(),
  })
  .passthrough();

/**
 * Financial Goal schema with validation.
 *
 * Represents user-defined financial goals like savings targets,
 * debt payoff goals, or investment targets.
 */
export const GoalSchema = z
  .object({
    // Required fields
    goal_id: z.string(),
    user_id: z.string().optional(),

    // Basic information
    name: z.string().optional(),
    recommendation_id: z.string().optional(), // slug form like "emergency-fund"
    emoji: z.string().optional(),
    created_date: z.string().regex(DATE_REGEX, 'Must be YYYY-MM-DD format').optional(),

    // Savings configuration (nested object)
    savings: SavingsConfigSchema.optional(),

    // Related data
    associated_accounts: z.array(z.string()).optional(),
    created_with_allocations: z.boolean().optional(),
  })
  .passthrough(); // Allow additional fields we haven't discovered yet

export type Goal = z.infer<typeof GoalSchema>;

/**
 * Get the display name for a goal.
 */
export function getGoalDisplayName(goal: Goal): string {
  return goal.name ?? goal.goal_id;
}

/**
 * Get the current amount saved toward a goal.
 * This would need to be calculated from goal_history subcollection.
 */
export function getGoalCurrentAmount(_goal: Goal): number | undefined {
  // This would require querying the financial_goal_history subcollection
  // For now, return undefined as we need historical data
  return undefined;
}

/**
 * Calculate goal progress percentage.
 */
export function getGoalProgress(goal: Goal, currentAmount?: number): number | undefined {
  const target = goal.savings?.target_amount;
  if (!target || !currentAmount) {
    return undefined;
  }
  return Math.min(100, (currentAmount / target) * 100);
}

/**
 * Calculate estimated completion date based on historical progress.
 *
 * @param goal - The goal to estimate completion for
 * @param currentAmount - Current amount saved
 * @param averageMonthlyContribution - Average monthly contribution from history
 * @returns Estimated completion date in YYYY-MM format, or undefined if cannot estimate
 */
export function estimateGoalCompletion(
  goal: Goal,
  currentAmount: number,
  averageMonthlyContribution: number
): string | undefined {
  const target = goal.savings?.target_amount;
  if (!target || currentAmount >= target) {
    return undefined; // Already complete or no target
  }

  if (averageMonthlyContribution <= 0) {
    return undefined; // No contributions or withdrawals
  }

  const remaining = target - currentAmount;
  const monthsToComplete = Math.ceil(remaining / averageMonthlyContribution);

  // Calculate target month
  const today = new Date();
  const targetDate = new Date(today.getFullYear(), today.getMonth() + monthsToComplete, 1);

  const year = targetDate.getFullYear();
  const month = String(targetDate.getMonth() + 1).padStart(2, '0');

  return `${year}-${month}`;
}

/**
 * Calculate progress velocity (amount per month).
 *
 * @param historicalAmounts - Array of amounts over time
 * @returns Average monthly change, or undefined if insufficient data
 */
export function calculateProgressVelocity(
  historicalAmounts: Array<{ month: string; amount: number }>
): number | undefined {
  if (historicalAmounts.length < 2) {
    return undefined;
  }

  // Sort by month
  const sorted = [...historicalAmounts].sort((a, b) => a.month.localeCompare(b.month));

  // Calculate differences between consecutive months
  const differences: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const previous = sorted[i - 1];
    if (current && previous) {
      differences.push(current.amount - previous.amount);
    }
  }

  // Return average difference
  const sum = differences.reduce((acc, val) => acc + val, 0);
  return sum / differences.length;
}

/**
 * Get the monthly contribution amount for a goal.
 */
export function getGoalMonthlyContribution(goal: Goal): number | undefined {
  return goal.savings?.tracking_type_monthly_contribution;
}

/**
 * Check if a goal is active.
 */
export function isGoalActive(goal: Goal): boolean {
  return goal.savings?.status === 'active';
}
