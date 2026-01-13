/**
 * Financial Goal History model for Copilot Money data.
 *
 * Represents monthly snapshots of goal progress stored in Copilot's
 * /users/{user_id}/financial_goals/{goal_id}/financial_goal_history/{month}
 * Firestore subcollection.
 *
 * Each document is a monthly snapshot containing:
 * - Current accumulated amount toward the goal
 * - Daily snapshots of progress throughout the month
 * - Contribution tracking (deposits/withdrawals)
 */

import { z } from 'zod';

/**
 * Date format regex for YYYY-MM-DD validation.
 */
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Month format regex for YYYY-MM validation.
 */
const MONTH_REGEX = /^\d{4}-\d{2}$/;

/**
 * Daily snapshot data nested within a month's history.
 *
 * Structure: daily_data: { "YYYY-MM-DD": { amount: number, ... }, ... }
 */
export const DailySnapshotSchema = z
  .object({
    amount: z.number().optional(), // Amount at this point in time
    date: z.string().regex(DATE_REGEX, 'Must be YYYY-MM-DD format').optional(),
    timestamp: z.number().optional(), // Unix timestamp
  })
  .passthrough();

export type DailySnapshot = z.infer<typeof DailySnapshotSchema>;

/**
 * Contribution/transaction within the goal history.
 */
export const GoalContributionSchema = z
  .object({
    amount: z.number(), // Positive for deposits, negative for withdrawals
    date: z.string().regex(DATE_REGEX, 'Must be YYYY-MM-DD format').optional(),
    transaction_id: z.string().optional(),
    description: z.string().optional(),
    type: z.string().optional(), // "deposit", "withdrawal", "transfer", etc.
  })
  .passthrough();

export type GoalContribution = z.infer<typeof GoalContributionSchema>;

/**
 * Financial Goal History schema with validation.
 *
 * Represents a monthly snapshot of progress toward a financial goal.
 * Document ID is typically in format: "YYYY-MM" (e.g., "2024-01", "2024-02")
 */
export const GoalHistorySchema = z
  .object({
    // Document identifiers
    month: z.string().regex(MONTH_REGEX, 'Must be YYYY-MM format'), // Document ID
    goal_id: z.string(),
    user_id: z.string().optional(),

    // Current state for this month
    current_amount: z.number().optional(), // Amount saved as of end of month
    target_amount: z.number().optional(), // Target at time of snapshot

    // Daily snapshots (nested object with date keys)
    daily_data: z.record(z.string(), DailySnapshotSchema).optional(),

    // Contributions/transactions for this month
    contributions: z.array(GoalContributionSchema).optional(),

    // Metadata
    last_updated: z.string().optional(), // Last update timestamp
    created_date: z.string().regex(DATE_REGEX, 'Must be YYYY-MM-DD format').optional(),
  })
  .passthrough(); // Allow additional fields we haven't discovered yet

export type GoalHistory = z.infer<typeof GoalHistorySchema>;

/**
 * Get the current amount from a goal history snapshot.
 */
export function getHistoryCurrentAmount(history: GoalHistory): number {
  return history.current_amount ?? 0;
}

/**
 * Get progress percentage for a history snapshot.
 */
export function getHistoryProgress(history: GoalHistory): number | undefined {
  if (!history.target_amount || !history.current_amount) {
    return undefined;
  }
  return Math.min(100, (history.current_amount / history.target_amount) * 100);
}

/**
 * Get the latest daily snapshot from a history entry.
 */
export function getLatestDailySnapshot(history: GoalHistory): DailySnapshot | undefined {
  if (!history.daily_data) {
    return undefined;
  }

  const dates = Object.keys(history.daily_data).sort();
  if (dates.length === 0) {
    return undefined;
  }

  const latestDate = dates[dates.length - 1];
  return latestDate ? history.daily_data[latestDate] : undefined;
}

/**
 * Get all daily snapshots sorted by date.
 */
export function getDailySnapshotsSorted(
  history: GoalHistory
): Array<DailySnapshot & { date: string }> {
  if (!history.daily_data) {
    return [];
  }

  return Object.entries(history.daily_data)
    .map(([date, snapshot]) => ({ ...snapshot, date }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Calculate total contributions for a month.
 */
export function getTotalContributions(history: GoalHistory): {
  total: number;
  deposits: number;
  withdrawals: number;
  count: number;
} {
  if (!history.contributions || history.contributions.length === 0) {
    return { total: 0, deposits: 0, withdrawals: 0, count: 0 };
  }

  let deposits = 0;
  let withdrawals = 0;

  for (const contribution of history.contributions) {
    if (contribution.amount > 0) {
      deposits += contribution.amount;
    } else if (contribution.amount < 0) {
      withdrawals += Math.abs(contribution.amount);
    }
  }

  return {
    total: deposits - withdrawals,
    deposits,
    withdrawals,
    count: history.contributions.length,
  };
}

/**
 * Calculate average daily amount for a month.
 */
export function getAverageDailyAmount(history: GoalHistory): number | undefined {
  const snapshots = getDailySnapshotsSorted(history);
  if (snapshots.length === 0) {
    return undefined;
  }

  const total = snapshots.reduce((sum, snapshot) => sum + (snapshot.amount ?? 0), 0);
  return total / snapshots.length;
}

/**
 * Get start and end amounts for the month.
 */
export function getMonthStartEnd(history: GoalHistory): {
  start_amount?: number;
  end_amount?: number;
  change_amount?: number;
  change_percent?: number;
} {
  const snapshots = getDailySnapshotsSorted(history);
  if (snapshots.length === 0) {
    return {};
  }

  const startAmount = snapshots[0]?.amount;
  const endAmount = snapshots[snapshots.length - 1]?.amount ?? history.current_amount;

  if (startAmount === undefined || endAmount === undefined) {
    return {
      start_amount: startAmount,
      end_amount: endAmount,
    };
  }

  const changeAmount = endAmount - startAmount;
  const changePercent = startAmount !== 0 ? (changeAmount / startAmount) * 100 : undefined;

  return {
    start_amount: startAmount,
    end_amount: endAmount,
    change_amount: changeAmount,
    change_percent: changePercent,
  };
}
