/**
 * Additional tests to improve coverage for CopilotDatabase.
 *
 * Covers uncovered lines:
 * - 367-379: getGoals method
 * - 401-427: getGoalHistory method
 * - 505-514: getInvestmentPrices method
 * - 533-541: getInvestmentSplits method
 * - 557-565: getItems method
 *
 * Uses the same private field override approach as database.test.ts
 * to avoid polluting other tests with module mocks.
 */

import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { CopilotDatabase } from '../../src/core/database.js';
import * as decoder from '../../src/core/decoder.js';
import type {
  Goal,
  GoalHistory,
  InvestmentPrice,
  InvestmentSplit,
  Item,
  Budget,
} from '../../src/models/index.js';

// Mock data for goals
const mockGoals: Goal[] = [
  {
    goal_id: 'goal_active1',
    name: 'Emergency Fund',
    savings: {
      status: 'active',
      target_amount: 10000,
      tracking_type: 'monthly_contribution',
      tracking_type_monthly_contribution: 500,
    },
  },
  {
    goal_id: 'goal_paused1',
    name: 'Vacation Fund',
    savings: {
      status: 'paused',
      target_amount: 5000,
    },
  },
  {
    goal_id: 'goal_no_status',
    name: 'New Car',
    savings: {
      target_amount: 20000,
    },
  },
];

const mockGoalHistory: GoalHistory[] = [
  {
    month: '2024-01',
    goal_id: 'goal_active1',
    current_amount: 1000,
    target_amount: 10000,
  },
  {
    month: '2024-02',
    goal_id: 'goal_active1',
    current_amount: 1500,
    target_amount: 10000,
  },
  {
    month: '2024-03',
    goal_id: 'goal_active1',
    current_amount: 2000,
    target_amount: 10000,
  },
  {
    month: '2024-02',
    goal_id: 'goal_paused1',
    current_amount: 500,
    target_amount: 5000,
  },
];

const mockInvestmentPrices: InvestmentPrice[] = [
  {
    investment_id: 'inv_aapl',
    ticker_symbol: 'AAPL',
    price: 180.5,
    date: '2024-01-15',
    price_type: 'daily',
  },
  {
    investment_id: 'inv_aapl',
    ticker_symbol: 'AAPL',
    price: 182.0,
    date: '2024-01-16',
    price_type: 'daily',
  },
  {
    investment_id: 'inv_btc',
    ticker_symbol: 'BTC-USD',
    price: 45000,
    date: '2024-01-15',
    price_type: 'hf',
  },
];

const mockInvestmentSplits: InvestmentSplit[] = [
  {
    split_id: 'split_aapl_2020',
    ticker_symbol: 'AAPL',
    split_date: '2020-08-31',
    split_ratio: '4:1',
    multiplier: 4,
  },
  {
    split_id: 'split_tsla_2022',
    ticker_symbol: 'TSLA',
    split_date: '2022-08-25',
    split_ratio: '3:1',
    multiplier: 3,
  },
];

const mockItems: Item[] = [
  {
    item_id: 'item_chase1',
    institution_name: 'Chase',
    institution_id: 'ins_3',
    connection_status: 'active',
    needs_update: false,
  },
  {
    item_id: 'item_bofa1',
    institution_name: 'Bank of America',
    institution_id: 'ins_4',
    connection_status: 'error',
    needs_update: true,
    error_code: 'ITEM_LOGIN_REQUIRED',
  },
  {
    item_id: 'item_wells1',
    institution_name: 'Wells Fargo',
    institution_id: 'ins_5',
    connection_status: 'active',
    needs_update: false,
  },
];

const mockBudgets: Budget[] = [
  {
    budget_id: 'budget_active1',
    name: 'Groceries',
    limit_amount: 500,
    is_active: true,
  },
  {
    budget_id: 'budget_inactive1',
    name: 'Entertainment',
    limit_amount: 200,
    is_active: false,
  },
  {
    budget_id: 'budget_undefined',
    name: 'Shopping',
    limit_amount: 300,
    // is_active is undefined - should be treated as active
  },
];

describe('CopilotDatabase Coverage Tests', () => {
  let db: CopilotDatabase;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
  });

  describe('getGoals', () => {
    beforeEach(() => {
      // Override private _goals field like database.test.ts does
      (db as any)._goals = [...mockGoals];
    });

    test('returns all goals when activeOnly is false', () => {
      const result = db.getGoals(false);
      expect(result).toHaveLength(3);
    });

    test('returns all goals when no parameter passed', () => {
      const result = db.getGoals();
      expect(result).toHaveLength(3);
    });

    test('filters to only active goals when activeOnly is true', () => {
      const result = db.getGoals(true);
      expect(result).toHaveLength(1);
      expect(result[0].goal_id).toBe('goal_active1');
      expect(result[0].savings?.status).toBe('active');
    });

    test('excludes paused goals when activeOnly is true', () => {
      const result = db.getGoals(true);
      const pausedGoal = result.find((g) => g.goal_id === 'goal_paused1');
      expect(pausedGoal).toBeUndefined();
    });

    test('excludes goals without status when activeOnly is true', () => {
      const result = db.getGoals(true);
      const noStatusGoal = result.find((g) => g.goal_id === 'goal_no_status');
      expect(noStatusGoal).toBeUndefined();
    });

    test('caches goals after first load', () => {
      const result1 = db.getGoals();
      const result2 = db.getGoals();
      // Both calls should return same content (from cache)
      expect(result1).toHaveLength(result2.length);
    });
  });

  describe('getGoalHistory', () => {
    let spy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      spy = spyOn(decoder, 'decodeGoalHistory').mockImplementation(
        (_dbPath: string, goalId?: string) => {
          if (goalId) {
            return mockGoalHistory.filter((h) => h.goal_id === goalId);
          }
          return [...mockGoalHistory];
        }
      );
    });

    test('returns all goal history when no filters applied', () => {
      const result = db.getGoalHistory();
      expect(result).toHaveLength(4);
      expect(spy).toHaveBeenCalled();
    });

    test('filters by goalId', () => {
      const result = db.getGoalHistory('goal_active1');
      expect(result).toHaveLength(3);
      expect(result.every((h) => h.goal_id === 'goal_active1')).toBe(true);
    });

    test('filters by startMonth', () => {
      const result = db.getGoalHistory(undefined, { startMonth: '2024-02' });
      expect(result).toHaveLength(3);
      expect(result.every((h) => h.month >= '2024-02')).toBe(true);
    });

    test('filters by endMonth', () => {
      const result = db.getGoalHistory(undefined, { endMonth: '2024-02' });
      expect(result).toHaveLength(3);
      expect(result.every((h) => h.month <= '2024-02')).toBe(true);
    });

    test('filters by both startMonth and endMonth', () => {
      const result = db.getGoalHistory(undefined, {
        startMonth: '2024-02',
        endMonth: '2024-02',
      });
      expect(result).toHaveLength(2);
      expect(result.every((h) => h.month === '2024-02')).toBe(true);
    });

    test('applies limit correctly', () => {
      const result = db.getGoalHistory(undefined, { limit: 2 });
      expect(result).toHaveLength(2);
    });

    test('combines goalId and filters', () => {
      const result = db.getGoalHistory('goal_active1', {
        startMonth: '2024-02',
        limit: 1,
      });
      expect(result).toHaveLength(1);
      expect(result[0].goal_id).toBe('goal_active1');
      expect(result[0].month).toBe('2024-02');
    });

    test('returns empty array for non-existent goalId', () => {
      const result = db.getGoalHistory('nonexistent_goal');
      expect(result).toHaveLength(0);
    });

    test('handles zero limit', () => {
      const result = db.getGoalHistory(undefined, { limit: 0 });
      expect(result).toHaveLength(4); // No slicing for 0 limit
    });

    test('handles negative limit', () => {
      const result = db.getGoalHistory(undefined, { limit: -1 });
      expect(result).toHaveLength(4); // No slicing for negative limit
    });
  });

  describe('getInvestmentPrices', () => {
    let spy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      spy = spyOn(decoder, 'decodeInvestmentPrices').mockImplementation(
        (
          _dbPath: string,
          options: {
            tickerSymbol?: string;
            startDate?: string;
            endDate?: string;
            priceType?: string;
          }
        ) => {
          let result = [...mockInvestmentPrices];
          if (options.tickerSymbol) {
            result = result.filter((p) => p.ticker_symbol === options.tickerSymbol);
          }
          if (options.priceType) {
            result = result.filter((p) => p.price_type === options.priceType);
          }
          if (options.startDate) {
            result = result.filter((p) => p.date && p.date >= options.startDate!);
          }
          if (options.endDate) {
            result = result.filter((p) => p.date && p.date <= options.endDate!);
          }
          return result;
        }
      );
    });

    test('returns all investment prices when no filters applied', () => {
      const result = db.getInvestmentPrices();
      expect(result).toHaveLength(3);
      expect(spy).toHaveBeenCalled();
    });

    test('filters by tickerSymbol', () => {
      const result = db.getInvestmentPrices({ tickerSymbol: 'AAPL' });
      expect(result).toHaveLength(2);
      expect(result.every((p) => p.ticker_symbol === 'AAPL')).toBe(true);
    });

    test('filters by startDate', () => {
      const result = db.getInvestmentPrices({ startDate: '2024-01-16' });
      expect(result).toHaveLength(1);
      expect(result[0].date).toBe('2024-01-16');
    });

    test('filters by endDate', () => {
      const result = db.getInvestmentPrices({ endDate: '2024-01-15' });
      expect(result).toHaveLength(2);
    });

    test('filters by priceType', () => {
      const result = db.getInvestmentPrices({ priceType: 'hf' });
      expect(result).toHaveLength(1);
      expect(result[0].ticker_symbol).toBe('BTC-USD');
    });

    test('combines multiple filters', () => {
      const result = db.getInvestmentPrices({
        tickerSymbol: 'AAPL',
        startDate: '2024-01-15',
        endDate: '2024-01-15',
      });
      expect(result).toHaveLength(1);
      expect(result[0].date).toBe('2024-01-15');
    });

    test('returns empty array for non-existent ticker', () => {
      const result = db.getInvestmentPrices({ tickerSymbol: 'NONEXISTENT' });
      expect(result).toHaveLength(0);
    });
  });

  describe('getInvestmentSplits', () => {
    let spy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      spy = spyOn(decoder, 'decodeInvestmentSplits').mockImplementation(
        (
          _dbPath: string,
          options: { tickerSymbol?: string; startDate?: string; endDate?: string }
        ) => {
          let result = [...mockInvestmentSplits];
          if (options.tickerSymbol) {
            result = result.filter((s) => s.ticker_symbol === options.tickerSymbol);
          }
          if (options.startDate) {
            result = result.filter((s) => s.split_date && s.split_date >= options.startDate!);
          }
          if (options.endDate) {
            result = result.filter((s) => s.split_date && s.split_date <= options.endDate!);
          }
          return result;
        }
      );
    });

    test('returns all investment splits when no filters applied', () => {
      const result = db.getInvestmentSplits();
      expect(result).toHaveLength(2);
      expect(spy).toHaveBeenCalled();
    });

    test('filters by tickerSymbol', () => {
      const result = db.getInvestmentSplits({ tickerSymbol: 'AAPL' });
      expect(result).toHaveLength(1);
      expect(result[0].ticker_symbol).toBe('AAPL');
    });

    test('filters by startDate', () => {
      const result = db.getInvestmentSplits({ startDate: '2022-01-01' });
      expect(result).toHaveLength(1);
      expect(result[0].ticker_symbol).toBe('TSLA');
    });

    test('filters by endDate', () => {
      const result = db.getInvestmentSplits({ endDate: '2021-01-01' });
      expect(result).toHaveLength(1);
      expect(result[0].ticker_symbol).toBe('AAPL');
    });

    test('combines multiple filters', () => {
      const result = db.getInvestmentSplits({
        tickerSymbol: 'TSLA',
        startDate: '2022-01-01',
        endDate: '2023-01-01',
      });
      expect(result).toHaveLength(1);
      expect(result[0].split_date).toBe('2022-08-25');
    });

    test('returns empty array for non-existent ticker', () => {
      const result = db.getInvestmentSplits({ tickerSymbol: 'NONEXISTENT' });
      expect(result).toHaveLength(0);
    });
  });

  describe('getItems', () => {
    let spy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      spy = spyOn(decoder, 'decodeItems').mockImplementation(
        (
          _dbPath: string,
          options: { connectionStatus?: string; institutionId?: string; needsUpdate?: boolean }
        ) => {
          let result = [...mockItems];
          if (options.connectionStatus) {
            result = result.filter((i) => i.connection_status === options.connectionStatus);
          }
          if (options.institutionId) {
            result = result.filter((i) => i.institution_id === options.institutionId);
          }
          if (options.needsUpdate !== undefined) {
            result = result.filter((i) => i.needs_update === options.needsUpdate);
          }
          return result;
        }
      );
    });

    test('returns all items when no filters applied', () => {
      const result = db.getItems();
      expect(result).toHaveLength(3);
      expect(spy).toHaveBeenCalled();
    });

    test('filters by connectionStatus', () => {
      const result = db.getItems({ connectionStatus: 'active' });
      expect(result).toHaveLength(2);
      expect(result.every((i) => i.connection_status === 'active')).toBe(true);
    });

    test('filters by connectionStatus error', () => {
      const result = db.getItems({ connectionStatus: 'error' });
      expect(result).toHaveLength(1);
      expect(result[0].institution_name).toBe('Bank of America');
    });

    test('filters by institutionId', () => {
      const result = db.getItems({ institutionId: 'ins_3' });
      expect(result).toHaveLength(1);
      expect(result[0].institution_name).toBe('Chase');
    });

    test('filters by needsUpdate true', () => {
      const result = db.getItems({ needsUpdate: true });
      expect(result).toHaveLength(1);
      expect(result[0].institution_name).toBe('Bank of America');
    });

    test('filters by needsUpdate false', () => {
      const result = db.getItems({ needsUpdate: false });
      expect(result).toHaveLength(2);
      expect(result.every((i) => i.needs_update === false)).toBe(true);
    });

    test('combines multiple filters', () => {
      const result = db.getItems({
        connectionStatus: 'active',
        needsUpdate: false,
      });
      expect(result).toHaveLength(2);
    });

    test('returns empty array when no items match', () => {
      const result = db.getItems({ institutionId: 'nonexistent' });
      expect(result).toHaveLength(0);
    });
  });

  describe('getBudgets (additional coverage)', () => {
    beforeEach(() => {
      // Override private _budgets field
      (db as any)._budgets = [...mockBudgets];
    });

    test('returns all budgets when activeOnly is false', () => {
      const result = db.getBudgets(false);
      expect(result).toHaveLength(3);
    });

    test('returns all budgets when no parameter passed', () => {
      const result = db.getBudgets();
      expect(result).toHaveLength(3);
    });

    test('filters to only active when activeOnly is true', () => {
      const result = db.getBudgets(true);
      // Should include active (budget_active1) and undefined (budget_undefined)
      expect(result).toHaveLength(2);
      const ids = result.map((b) => b.budget_id);
      expect(ids).toContain('budget_active1');
      expect(ids).toContain('budget_undefined');
      expect(ids).not.toContain('budget_inactive1');
    });

    test('includes undefined is_active as active when activeOnly is true', () => {
      const result = db.getBudgets(true);
      const undefinedBudget = result.find((b) => b.budget_id === 'budget_undefined');
      expect(undefinedBudget).toBeDefined();
      expect(undefinedBudget?.is_active).toBeUndefined();
    });

    test('excludes explicitly inactive budgets when activeOnly is true', () => {
      const result = db.getBudgets(true);
      const inactive = result.find((b) => b.is_active === false);
      expect(inactive).toBeUndefined();
    });
  });
});
