/**
 * Unit tests for goal history functionality.
 *
 * Tests the goal history model, decoder, and tool implementations.
 */

import { describe, test, expect } from 'bun:test';
import {
  GoalHistorySchema,
  getHistoryCurrentAmount,
  getHistoryProgress,
  getLatestDailySnapshot,
  getDailySnapshotsSorted,
  getTotalContributions,
  getAverageDailyAmount,
  getMonthStartEnd,
  type GoalHistory,
} from '../../src/models/goal-history.js';
import {
  estimateGoalCompletion,
  calculateProgressVelocity,
  type Goal,
} from '../../src/models/goal.js';

describe('GoalHistorySchema', () => {
  test('validates valid goal history', () => {
    const validHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
      current_amount: 1000.0,
      target_amount: 5000.0,
    };

    const result = GoalHistorySchema.safeParse(validHistory);
    expect(result.success).toBe(true);
  });

  test('validates goal history with daily_data', () => {
    const historyWithDaily = {
      month: '2024-01',
      goal_id: 'goal_123',
      current_amount: 1000.0,
      daily_data: {
        '2024-01-01': { amount: 950.0, date: '2024-01-01' },
        '2024-01-15': { amount: 975.0, date: '2024-01-15' },
        '2024-01-31': { amount: 1000.0, date: '2024-01-31' },
      },
    };

    const result = GoalHistorySchema.safeParse(historyWithDaily);
    expect(result.success).toBe(true);
  });

  test('rejects invalid month format', () => {
    const invalid = {
      month: '2024-1', // Should be 2024-01
      goal_id: 'goal_123',
    };

    const result = GoalHistorySchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test('rejects invalid date in daily_data', () => {
    const invalid = {
      month: '2024-01',
      goal_id: 'goal_123',
      daily_data: {
        '2024-1-1': { amount: 100, date: '2024-1-1' }, // Invalid date format
      },
    };

    const result = GoalHistorySchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});

describe('getHistoryCurrentAmount', () => {
  test('returns current_amount when present', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
      current_amount: 1500.0,
    };

    expect(getHistoryCurrentAmount(history)).toBe(1500.0);
  });

  test('returns 0 when current_amount is undefined', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
    };

    expect(getHistoryCurrentAmount(history)).toBe(0);
  });
});

describe('getHistoryProgress', () => {
  test('calculates progress percentage correctly', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
      current_amount: 2500.0,
      target_amount: 5000.0,
    };

    expect(getHistoryProgress(history)).toBe(50);
  });

  test('caps progress at 100%', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
      current_amount: 6000.0,
      target_amount: 5000.0,
    };

    expect(getHistoryProgress(history)).toBe(100);
  });

  test('returns undefined when target_amount is missing', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
      current_amount: 1000.0,
    };

    expect(getHistoryProgress(history)).toBeUndefined();
  });

  test('returns undefined when current_amount is missing', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
      target_amount: 5000.0,
    };

    expect(getHistoryProgress(history)).toBeUndefined();
  });
});

describe('getDailySnapshotsSorted', () => {
  test('returns empty array when no daily_data', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
    };

    expect(getDailySnapshotsSorted(history)).toEqual([]);
  });

  test('returns sorted daily snapshots', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
      daily_data: {
        '2024-01-15': { amount: 975.0 },
        '2024-01-01': { amount: 950.0 },
        '2024-01-31': { amount: 1000.0 },
      },
    };

    const snapshots = getDailySnapshotsSorted(history);

    expect(snapshots.length).toBe(3);
    expect(snapshots[0].date).toBe('2024-01-01');
    expect(snapshots[0].amount).toBe(950.0);
    expect(snapshots[1].date).toBe('2024-01-15');
    expect(snapshots[2].date).toBe('2024-01-31');
    expect(snapshots[2].amount).toBe(1000.0);
  });
});

describe('getLatestDailySnapshot', () => {
  test('returns latest snapshot by date', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
      daily_data: {
        '2024-01-01': { amount: 950.0 },
        '2024-01-31': { amount: 1000.0 },
        '2024-01-15': { amount: 975.0 },
      },
    };

    const latest = getLatestDailySnapshot(history);

    expect(latest).toBeDefined();
    expect(latest?.amount).toBe(1000.0);
  });

  test('returns undefined when no daily_data', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
    };

    expect(getLatestDailySnapshot(history)).toBeUndefined();
  });

  test('returns undefined when daily_data is empty object', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
      daily_data: {},
    };

    expect(getLatestDailySnapshot(history)).toBeUndefined();
  });
});

describe('getMonthStartEnd', () => {
  test('calculates month start and end amounts', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
      current_amount: 1000.0,
      daily_data: {
        '2024-01-01': { amount: 900.0 },
        '2024-01-15': { amount: 950.0 },
        '2024-01-31': { amount: 1000.0 },
      },
    };

    const result = getMonthStartEnd(history);

    expect(result.start_amount).toBe(900.0);
    expect(result.end_amount).toBe(1000.0);
    expect(result.change_amount).toBe(100.0);
    expect(result.change_percent).toBeCloseTo(11.11, 1);
  });

  test('returns empty object when no daily_data', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
    };

    expect(getMonthStartEnd(history)).toEqual({});
  });

  test('handles zero start amount', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
      daily_data: {
        '2024-01-01': { amount: 0 },
        '2024-01-31': { amount: 500.0 },
      },
    };

    const result = getMonthStartEnd(history);

    expect(result.start_amount).toBe(0);
    expect(result.end_amount).toBe(500.0);
    expect(result.change_amount).toBe(500.0);
    expect(result.change_percent).toBeUndefined(); // Can't calculate percent from 0
  });

  test('returns partial data when start amount is undefined', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
      daily_data: {
        '2024-01-01': {}, // No amount
        '2024-01-31': { amount: 500.0 },
      },
    };

    const result = getMonthStartEnd(history);

    expect(result.start_amount).toBeUndefined();
    expect(result.end_amount).toBe(500.0);
    expect(result.change_amount).toBeUndefined();
    expect(result.change_percent).toBeUndefined();
  });

  test('returns partial data when end amount is undefined', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
      daily_data: {
        '2024-01-01': { amount: 100.0 },
        '2024-01-31': {}, // No amount
      },
    };

    const result = getMonthStartEnd(history);

    expect(result.start_amount).toBe(100.0);
    expect(result.end_amount).toBeUndefined();
    expect(result.change_amount).toBeUndefined();
    expect(result.change_percent).toBeUndefined();
  });
});

describe('getAverageDailyAmount', () => {
  test('calculates average of daily amounts', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
      daily_data: {
        '2024-01-01': { amount: 900.0 },
        '2024-01-15': { amount: 950.0 },
        '2024-01-31': { amount: 1050.0 },
      },
    };

    const average = getAverageDailyAmount(history);

    expect(average).toBe(966.6666666666666); // (900 + 950 + 1050) / 3
  });

  test('returns undefined when no daily_data', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
    };

    expect(getAverageDailyAmount(history)).toBeUndefined();
  });
});

describe('estimateGoalCompletion', () => {
  test('estimates completion date based on monthly contribution', () => {
    const goal: Goal = {
      goal_id: 'goal_123',
      savings: {
        target_amount: 5000.0,
      },
    };

    const currentAmount = 2000.0;
    const monthlyContribution = 500.0;

    const result = estimateGoalCompletion(goal, currentAmount, monthlyContribution);

    expect(result).toBeDefined();
    // Should need 6 months: (5000 - 2000) / 500 = 6
    expect(result).toMatch(/^\d{4}-\d{2}$/); // YYYY-MM format
  });

  test('returns undefined when goal is already complete', () => {
    const goal: Goal = {
      goal_id: 'goal_123',
      savings: {
        target_amount: 5000.0,
      },
    };

    const currentAmount = 5000.0;
    const monthlyContribution = 500.0;

    expect(estimateGoalCompletion(goal, currentAmount, monthlyContribution)).toBeUndefined();
  });

  test('returns undefined when no contributions', () => {
    const goal: Goal = {
      goal_id: 'goal_123',
      savings: {
        target_amount: 5000.0,
      },
    };

    const currentAmount = 2000.0;
    const monthlyContribution = 0;

    expect(estimateGoalCompletion(goal, currentAmount, monthlyContribution)).toBeUndefined();
  });

  test('returns undefined when negative contributions', () => {
    const goal: Goal = {
      goal_id: 'goal_123',
      savings: {
        target_amount: 5000.0,
      },
    };

    const currentAmount = 2000.0;
    const monthlyContribution = -100.0;

    expect(estimateGoalCompletion(goal, currentAmount, monthlyContribution)).toBeUndefined();
  });
});

describe('calculateProgressVelocity', () => {
  test('calculates average monthly change', () => {
    const amounts = [
      { month: '2024-01', amount: 1000.0 },
      { month: '2024-02', amount: 1500.0 },
      { month: '2024-03', amount: 2100.0 },
    ];

    const velocity = calculateProgressVelocity(amounts);

    expect(velocity).toBeDefined();
    // Changes: +500, +600 -> average = 550
    expect(velocity).toBe(550.0);
  });

  test('handles unsorted input', () => {
    const amounts = [
      { month: '2024-03', amount: 2100.0 },
      { month: '2024-01', amount: 1000.0 },
      { month: '2024-02', amount: 1500.0 },
    ];

    const velocity = calculateProgressVelocity(amounts);

    expect(velocity).toBeDefined();
    expect(velocity).toBe(550.0);
  });

  test('returns undefined with insufficient data', () => {
    const amounts = [{ month: '2024-01', amount: 1000.0 }];

    expect(calculateProgressVelocity(amounts)).toBeUndefined();
  });

  test('handles negative velocity (withdrawals)', () => {
    const amounts = [
      { month: '2024-01', amount: 2000.0 },
      { month: '2024-02', amount: 1500.0 },
      { month: '2024-03', amount: 1200.0 },
    ];

    const velocity = calculateProgressVelocity(amounts);

    expect(velocity).toBeDefined();
    // Changes: -500, -300 -> average = -400
    expect(velocity).toBe(-400.0);
  });
});

describe('getTotalContributions', () => {
  test('returns zeros when no contributions', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
    };

    const result = getTotalContributions(history);

    expect(result.total).toBe(0);
    expect(result.deposits).toBe(0);
    expect(result.withdrawals).toBe(0);
    expect(result.count).toBe(0);
  });

  test('calculates contributions correctly', () => {
    const history: GoalHistory = {
      month: '2024-01',
      goal_id: 'goal_123',
      contributions: [
        { amount: 500.0, date: '2024-01-05' },
        { amount: 250.0, date: '2024-01-15' },
        { amount: -100.0, date: '2024-01-20' }, // Withdrawal
        { amount: 300.0, date: '2024-01-25' },
      ],
    };

    const result = getTotalContributions(history);

    expect(result.deposits).toBe(1050.0); // 500 + 250 + 300
    expect(result.withdrawals).toBe(100.0); // abs(-100)
    expect(result.total).toBe(950.0); // 1050 - 100
    expect(result.count).toBe(4);
  });
});
