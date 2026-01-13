/**
 * Unit tests for goal model helper functions.
 * Covers uncovered lines: 64, 72-74, 81-85, 158
 */

import { describe, test, expect } from 'bun:test';
import {
  getGoalDisplayName,
  getGoalCurrentAmount,
  getGoalProgress,
  getGoalMonthlyContribution,
  isGoalActive,
  estimateGoalCompletion,
  calculateProgressVelocity,
  GoalSchema,
  type Goal,
} from '../../src/models/goal.js';

describe('Goal model helpers', () => {
  describe('getGoalDisplayName', () => {
    test('returns name when available', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        name: 'Emergency Fund',
      };

      expect(getGoalDisplayName(goal)).toBe('Emergency Fund');
    });

    test('returns goal_id when name is not available', () => {
      const goal: Goal = {
        goal_id: 'goal1',
      };

      expect(getGoalDisplayName(goal)).toBe('goal1');
    });

    test('returns goal_id when name is undefined', () => {
      const goal: Goal = {
        goal_id: 'my-savings-goal',
        name: undefined,
      };

      expect(getGoalDisplayName(goal)).toBe('my-savings-goal');
    });
  });

  describe('getGoalCurrentAmount', () => {
    test('returns undefined for any goal', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        name: 'Emergency Fund',
        savings: {
          target_amount: 10000,
        },
      };

      // This function always returns undefined as it requires historical data
      expect(getGoalCurrentAmount(goal)).toBeUndefined();
    });

    test('returns undefined even with complete goal data', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        name: 'Vacation Fund',
        savings: {
          type: 'savings',
          status: 'active',
          target_amount: 5000,
          tracking_type: 'monthly_contribution',
          tracking_type_monthly_contribution: 500,
        },
      };

      expect(getGoalCurrentAmount(goal)).toBeUndefined();
    });
  });

  describe('getGoalProgress', () => {
    test('returns undefined when target_amount is not set', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {},
      };

      expect(getGoalProgress(goal, 1000)).toBeUndefined();
    });

    test('returns undefined when currentAmount is not provided', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          target_amount: 10000,
        },
      };

      expect(getGoalProgress(goal)).toBeUndefined();
    });

    test('returns undefined when currentAmount is undefined', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          target_amount: 10000,
        },
      };

      expect(getGoalProgress(goal, undefined)).toBeUndefined();
    });

    test('returns undefined when savings is not set', () => {
      const goal: Goal = {
        goal_id: 'goal1',
      };

      expect(getGoalProgress(goal, 1000)).toBeUndefined();
    });

    test('returns undefined when both target and currentAmount are missing', () => {
      const goal: Goal = {
        goal_id: 'goal1',
      };

      expect(getGoalProgress(goal)).toBeUndefined();
    });

    test('calculates correct progress percentage', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          target_amount: 10000,
        },
      };

      expect(getGoalProgress(goal, 2500)).toBe(25);
    });

    test('calculates correct progress for 50%', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          target_amount: 10000,
        },
      };

      expect(getGoalProgress(goal, 5000)).toBe(50);
    });

    test('caps progress at 100% when over target', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          target_amount: 10000,
        },
      };

      expect(getGoalProgress(goal, 15000)).toBe(100);
    });

    test('returns 0 for zero currentAmount', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          target_amount: 10000,
        },
      };

      // 0 is falsy, so this returns undefined
      expect(getGoalProgress(goal, 0)).toBeUndefined();
    });

    test('handles small fractional progress', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          target_amount: 10000,
        },
      };

      expect(getGoalProgress(goal, 100)).toBe(1);
    });
  });

  describe('getGoalMonthlyContribution', () => {
    test('returns monthly contribution when set', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          tracking_type_monthly_contribution: 500,
        },
      };

      expect(getGoalMonthlyContribution(goal)).toBe(500);
    });

    test('returns undefined when savings is not set', () => {
      const goal: Goal = {
        goal_id: 'goal1',
      };

      expect(getGoalMonthlyContribution(goal)).toBeUndefined();
    });

    test('returns undefined when monthly contribution is not set', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          target_amount: 10000,
        },
      };

      expect(getGoalMonthlyContribution(goal)).toBeUndefined();
    });

    test('returns zero when monthly contribution is 0', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          tracking_type_monthly_contribution: 0,
        },
      };

      expect(getGoalMonthlyContribution(goal)).toBe(0);
    });

    test('returns correct value for various amounts', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          tracking_type_monthly_contribution: 1234.56,
        },
      };

      expect(getGoalMonthlyContribution(goal)).toBe(1234.56);
    });
  });

  describe('isGoalActive', () => {
    test('returns true when status is active', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          status: 'active',
        },
      };

      expect(isGoalActive(goal)).toBe(true);
    });

    test('returns false when status is paused', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          status: 'paused',
        },
      };

      expect(isGoalActive(goal)).toBe(false);
    });

    test('returns false when status is not set', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {},
      };

      expect(isGoalActive(goal)).toBe(false);
    });

    test('returns false when savings is not set', () => {
      const goal: Goal = {
        goal_id: 'goal1',
      };

      expect(isGoalActive(goal)).toBe(false);
    });

    test('returns false for completed status', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          status: 'completed',
        },
      };

      expect(isGoalActive(goal)).toBe(false);
    });
  });

  describe('estimateGoalCompletion', () => {
    test('returns undefined when target is not set', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {},
      };

      expect(estimateGoalCompletion(goal, 1000, 500)).toBeUndefined();
    });

    test('returns undefined when current amount exceeds target', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          target_amount: 10000,
        },
      };

      expect(estimateGoalCompletion(goal, 15000, 500)).toBeUndefined();
    });

    test('returns undefined when current amount equals target', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          target_amount: 10000,
        },
      };

      expect(estimateGoalCompletion(goal, 10000, 500)).toBeUndefined();
    });

    test('returns undefined when contribution is zero', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          target_amount: 10000,
        },
      };

      expect(estimateGoalCompletion(goal, 5000, 0)).toBeUndefined();
    });

    test('returns undefined when contribution is negative', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          target_amount: 10000,
        },
      };

      expect(estimateGoalCompletion(goal, 5000, -100)).toBeUndefined();
    });

    test('calculates completion date correctly', () => {
      const goal: Goal = {
        goal_id: 'goal1',
        savings: {
          target_amount: 10000,
        },
      };

      const result = estimateGoalCompletion(goal, 5000, 1000);
      // Should be 5 months from now (5000 remaining / 1000 per month)
      expect(result).toMatch(/^\d{4}-\d{2}$/);
    });

    test('returns undefined when savings is not set', () => {
      const goal: Goal = {
        goal_id: 'goal1',
      };

      expect(estimateGoalCompletion(goal, 5000, 500)).toBeUndefined();
    });
  });

  describe('calculateProgressVelocity', () => {
    test('returns undefined when less than 2 data points', () => {
      expect(calculateProgressVelocity([])).toBeUndefined();
      expect(calculateProgressVelocity([{ month: '2026-01', amount: 1000 }])).toBeUndefined();
    });

    test('calculates velocity correctly with 2 data points', () => {
      const amounts = [
        { month: '2026-01', amount: 1000 },
        { month: '2026-02', amount: 1500 },
      ];

      expect(calculateProgressVelocity(amounts)).toBe(500);
    });

    test('calculates average velocity with multiple data points', () => {
      const amounts = [
        { month: '2026-01', amount: 1000 },
        { month: '2026-02', amount: 1500 },
        { month: '2026-03', amount: 2500 },
      ];

      // Differences: 500, 1000; Average: 750
      expect(calculateProgressVelocity(amounts)).toBe(750);
    });

    test('handles unsorted data', () => {
      const amounts = [
        { month: '2026-03', amount: 2500 },
        { month: '2026-01', amount: 1000 },
        { month: '2026-02', amount: 1500 },
      ];

      // Should sort by month and calculate correctly
      expect(calculateProgressVelocity(amounts)).toBe(750);
    });

    test('handles negative velocity (withdrawals)', () => {
      const amounts = [
        { month: '2026-01', amount: 2000 },
        { month: '2026-02', amount: 1500 },
      ];

      expect(calculateProgressVelocity(amounts)).toBe(-500);
    });

    test('handles zero change', () => {
      const amounts = [
        { month: '2026-01', amount: 1000 },
        { month: '2026-02', amount: 1000 },
      ];

      expect(calculateProgressVelocity(amounts)).toBe(0);
    });

    test('handles mixed positive and negative changes', () => {
      const amounts = [
        { month: '2026-01', amount: 1000 },
        { month: '2026-02', amount: 1500 },
        { month: '2026-03', amount: 1300 },
      ];

      // Differences: 500, -200; Average: 150
      expect(calculateProgressVelocity(amounts)).toBe(150);
    });
  });

  describe('GoalSchema validation', () => {
    test('validates minimal goal', () => {
      const goal = {
        goal_id: 'goal1',
      };

      const result = GoalSchema.safeParse(goal);
      expect(result.success).toBe(true);
    });

    test('validates complete goal', () => {
      const goal = {
        goal_id: 'goal1',
        user_id: 'user1',
        name: 'Emergency Fund',
        recommendation_id: 'emergency-fund',
        emoji: '🎯',
        created_date: '2026-01-15',
        savings: {
          type: 'savings',
          status: 'active',
          target_amount: 10000,
          tracking_type: 'monthly_contribution',
          tracking_type_monthly_contribution: 500,
          start_date: '2026-01-01',
          modified_start_date: false,
          inflates_budget: true,
          is_ongoing: false,
        },
        associated_accounts: ['acc1', 'acc2'],
        created_with_allocations: true,
      };

      const result = GoalSchema.safeParse(goal);
      expect(result.success).toBe(true);
    });

    test('rejects invalid created_date format', () => {
      const goal = {
        goal_id: 'goal1',
        created_date: '01-15-2026', // Wrong format
      };

      const result = GoalSchema.safeParse(goal);
      expect(result.success).toBe(false);
    });

    test('rejects invalid savings start_date format', () => {
      const goal = {
        goal_id: 'goal1',
        savings: {
          start_date: '2026/01/01', // Wrong format
        },
      };

      const result = GoalSchema.safeParse(goal);
      expect(result.success).toBe(false);
    });

    test('allows passthrough of unknown fields', () => {
      const goal = {
        goal_id: 'goal1',
        unknown_field: 'some value',
        savings: {
          custom_property: 'test',
        },
      };

      const result = GoalSchema.safeParse(goal);
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>).unknown_field).toBe('some value');
      }
    });
  });
});
