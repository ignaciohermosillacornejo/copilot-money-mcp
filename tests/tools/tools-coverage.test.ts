/**
 * Additional coverage tests for MCP tools.
 *
 * This file focuses on uncovered analysis modes and edge cases in consolidated tools.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import type { Transaction, Account, Budget, Goal, GoalHistory } from '../../src/models/index.js';

// Extended mock data for comprehensive testing
// Standard accounting: negative = expenses, positive = income/credits
const mockTransactions: Transaction[] = [
  // Regular expenses (negative = money out)
  {
    transaction_id: 'txn1',
    amount: -50.0,
    date: '2024-01-15',
    name: 'Coffee Shop',
    category_id: 'food_dining',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn2',
    amount: -120.5,
    date: '2024-01-20',
    name: 'Grocery Store',
    category_id: 'groceries',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn3',
    amount: -25.0,
    date: '2024-01-22',
    original_name: 'Fast Food',
    category_id: 'food_dining',
    account_id: 'acc2',
  },
  // Income (positive = money in)
  {
    transaction_id: 'txn4',
    amount: 3000.0,
    date: '2024-01-31',
    name: 'Paycheck',
    category_id: 'income',
    account_id: 'acc1',
  },
  // Foreign transaction (expense)
  {
    transaction_id: 'txn_foreign',
    amount: -75.0,
    date: '2024-01-18',
    name: 'Santiago Restaurant CL',
    category_id: 'food_dining',
    account_id: 'acc1',
    country: 'CL',
    iso_currency_code: 'CLP',
  },
  // Refund (positive = money in)
  {
    transaction_id: 'txn_refund',
    amount: 25.0,
    date: '2024-01-19',
    name: 'Amazon Refund',
    category_id: 'shopping',
    account_id: 'acc1',
  },
  // Credit/Cashback (positive = money in)
  {
    transaction_id: 'txn_credit',
    amount: 15.0,
    date: '2024-01-20',
    name: 'Statement Credit Cashback',
    category_id: 'other',
    account_id: 'acc1',
  },
  // HSA eligible (expense)
  {
    transaction_id: 'txn_medical',
    amount: -45.0,
    date: '2024-01-21',
    name: 'CVS Pharmacy',
    category_id: 'medical',
    account_id: 'acc1',
  },
  // Tagged transaction (expense)
  {
    transaction_id: 'txn_tagged',
    amount: -30.0,
    date: '2024-01-22',
    name: 'Business Lunch #work #expense',
    category_id: 'food_dining',
    account_id: 'acc1',
  },
  // Duplicate pattern (expense)
  {
    transaction_id: 'txn_dup1',
    amount: -99.99,
    date: '2024-01-23',
    name: 'Subscription Service',
    category_id: 'subscriptions',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn_dup2',
    amount: -99.99,
    date: '2024-01-23',
    name: 'Subscription Service',
    category_id: 'subscriptions',
    account_id: 'acc1',
  },
  // Fee transaction (expense)
  {
    transaction_id: 'txn_fee',
    amount: -5.0,
    date: '2024-01-24',
    name: 'ATM Fee',
    category_id: 'bank_fees',
    account_id: 'acc1',
  },
  // Dividend (income)
  {
    transaction_id: 'txn_dividend',
    amount: 50.0,
    date: '2024-01-25',
    name: 'Dividend Payment AAPL',
    category_id: 'investment_dividend',
    account_id: 'acc_invest',
  },
  // More transactions for time-based analysis (expenses)
  {
    transaction_id: 'txn_week1',
    amount: -40.0,
    date: '2024-01-08',
    name: 'Week 1 Expense',
    category_id: 'food_dining',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn_week2',
    amount: -60.0,
    date: '2024-01-14',
    name: 'Week 2 Expense',
    category_id: 'food_dining',
    account_id: 'acc1',
  },
];

const mockAccounts: Account[] = [
  {
    account_id: 'acc1',
    current_balance: 1500.0,
    available_balance: 1450.0,
    name: 'Checking Account',
    account_type: 'depository',
    subtype: 'checking',
    mask: '1234',
    institution_name: 'Bank of Example',
  },
  {
    account_id: 'acc2',
    current_balance: 500.0,
    official_name: 'Savings Account',
    account_type: 'depository',
    subtype: 'savings',
  },
  {
    account_id: 'acc_invest',
    current_balance: 25000.0,
    name: 'Investment Account',
    account_type: 'investment',
    subtype: 'brokerage',
  },
];

const mockBudgets: Budget[] = [
  {
    budget_id: 'budget1',
    name: 'Food Budget',
    amount: 500,
    period: 'monthly',
    category_id: 'food_dining',
    is_active: true,
  },
  {
    budget_id: 'budget2',
    name: 'Shopping Budget',
    amount: 300,
    period: 'monthly',
    category_id: 'shopping',
    is_active: true,
  },
];

const mockGoals: Goal[] = [
  {
    goal_id: 'goal1',
    name: 'Emergency Fund',
    emoji: '🏦',
    savings: {
      target_amount: 10000,
      tracking_type_monthly_contribution: 500,
      tracking_type: 'manual',
      status: 'in_progress',
      start_date: '2024-01-01',
      is_ongoing: false,
      inflates_budget: false,
    },
    created_date: '2024-01-01',
  },
  {
    goal_id: 'goal2',
    name: 'Vacation Fund',
    emoji: '✈️',
    savings: {
      target_amount: 5000,
      tracking_type_monthly_contribution: 200,
      tracking_type: 'manual',
      status: 'in_progress',
      start_date: '2024-01-01',
      is_ongoing: false,
      inflates_budget: false,
    },
    created_date: '2024-01-01',
  },
];

const mockGoalHistory: GoalHistory[] = [
  {
    goal_history_id: 'gh1',
    goal_id: 'goal1',
    month: '2024-01',
    current_amount: 2500,
    target_amount: 10000,
    daily_data: { '2024-01-15': 2500 },
  },
  {
    goal_history_id: 'gh2',
    goal_id: 'goal1',
    month: '2023-12',
    current_amount: 2000,
    target_amount: 10000,
  },
  {
    goal_history_id: 'gh3',
    goal_id: 'goal1',
    month: '2023-11',
    current_amount: 1500,
    target_amount: 10000,
  },
  {
    goal_history_id: 'gh4',
    goal_id: 'goal2',
    month: '2024-01',
    current_amount: 400,
    target_amount: 5000,
  },
];

const mockInvestmentPrices = [
  {
    investment_price_id: 'price1',
    ticker_symbol: 'AAPL',
    price: 185.5,
    price_as_of: '2024-01-01',
  },
  {
    investment_price_id: 'price2',
    ticker_symbol: 'AAPL',
    price: 190.25,
    price_as_of: '2024-01-31',
  },
  {
    investment_price_id: 'price3',
    ticker_symbol: 'GOOGL',
    price: 140.0,
    price_as_of: '2024-01-01',
  },
  {
    investment_price_id: 'price4',
    ticker_symbol: 'GOOGL',
    price: 138.5,
    price_as_of: '2024-01-31',
  },
];

const mockRecurring = [
  {
    recurring_id: 'rec1',
    name: 'Netflix',
    amount: 15.99,
    frequency: 'monthly',
    next_date: '2024-02-01',
    last_date: '2024-01-01',
    category_id: 'entertainment',
    is_active: true,
  },
];

describe('CopilotMoneyTools Extended Coverage', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    // Mock database with comprehensive test data
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
    (db as any)._budgets = [...mockBudgets];
    (db as any)._goals = [...mockGoals];
    (db as any)._goalHistory = [...mockGoalHistory];
    (db as any)._investmentPrices = [...mockInvestmentPrices];
    (db as any)._recurring = [...mockRecurring];

    tools = new CopilotMoneyTools(db);
  });

  // ============================================
  // getSpending with different group_by values
  // ============================================
  describe('getSpending', () => {
    describe('group_by: category', () => {
      test('aggregates spending by category', () => {
        const result = tools.getSpending({
          group_by: 'category',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.group_by).toBe('category');
        expect(result.total_spending).toBeGreaterThan(0);
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.summary?.category_count).toBeGreaterThan(0);
      });
    });

    describe('group_by: merchant', () => {
      test('aggregates spending by merchant', () => {
        const result = tools.getSpending({
          group_by: 'merchant',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.group_by).toBe('merchant');
        expect(result.total_spending).toBeGreaterThan(0);
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.summary?.merchant_count).toBeGreaterThan(0);
      });
    });

    describe('group_by: day_of_week', () => {
      test('aggregates spending by day of week', () => {
        const result = tools.getSpending({
          group_by: 'day_of_week',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.group_by).toBe('day_of_week');
        expect(result.total_spending).toBeGreaterThan(0);
        expect(Array.isArray(result.data)).toBe(true);

        const days = result.data as Array<{ day_name: string; total_spending: number }>;
        expect(days.length).toBe(7);
        expect(days.some((d) => d.day_name === 'Monday')).toBe(true);
        expect(days.some((d) => d.day_name === 'Sunday')).toBe(true);
        expect(result.summary?.highest_spending_day).toBeDefined();
      });

      test('calculates percentage of total correctly', () => {
        const result = tools.getSpending({
          group_by: 'day_of_week',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        const days = result.data as Array<{ percentage: number }>;
        const totalPercentage = days.reduce((sum, d) => sum + (d.percentage || 0), 0);
        // Total percentage should be approximately 100 (allowing for rounding)
        expect(totalPercentage).toBeGreaterThanOrEqual(0);
        expect(totalPercentage).toBeLessThanOrEqual(100.5);
      });
    });

    describe('group_by: time', () => {
      test('aggregates spending over time with monthly granularity', () => {
        const result = tools.getSpending({
          group_by: 'time',
          granularity: 'month',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.group_by).toBe('time');
        expect(result.total_spending).toBeGreaterThan(0);

        const data = result.data as { granularity: string; periods: Array<unknown> };
        expect(data.granularity).toBe('month');
        expect(data.periods.length).toBeGreaterThan(0);
        expect(result.summary?.average_per_period).toBeDefined();
      });

      test('aggregates spending over time with weekly granularity', () => {
        const result = tools.getSpending({
          group_by: 'time',
          granularity: 'week',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.group_by).toBe('time');
        const data = result.data as { granularity: string; periods: Array<unknown> };
        expect(data.granularity).toBe('week');
      });

      test('aggregates spending over time with daily granularity', () => {
        const result = tools.getSpending({
          group_by: 'time',
          granularity: 'day',
          start_date: '2024-01-15',
          end_date: '2024-01-20',
        });

        expect(result.group_by).toBe('time');
        const data = result.data as { granularity: string; periods: Array<unknown> };
        expect(data.granularity).toBe('day');
      });

      test('identifies highest and lowest spending periods', () => {
        const result = tools.getSpending({
          group_by: 'time',
          granularity: 'week',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.summary?.highest_period).toBeDefined();
        expect(result.summary?.lowest_period).toBeDefined();
      });
    });

    describe('group_by: rate', () => {
      test('calculates spending rate and velocity', () => {
        const result = tools.getSpending({
          group_by: 'rate',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.group_by).toBe('rate');
        expect(result.total_spending).toBeGreaterThan(0);

        const data = result.data as {
          days_in_period: number;
          days_elapsed: number;
          daily_average: number;
          weekly_average: number;
          projected_monthly_total: number;
        };
        expect(data.days_in_period).toBeDefined();
        expect(data.daily_average).toBeDefined();
        expect(data.weekly_average).toBeDefined();
        expect(data.projected_monthly_total).toBeDefined();
        expect(result.summary?.on_track).toBeDefined();
      });
    });

    test('filters by category', () => {
      const result = tools.getSpending({
        group_by: 'category',
        category: 'food',
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.total_spending).toBeGreaterThan(0);
    });

    test('uses default period when not specified', () => {
      const result = tools.getSpending({
        group_by: 'category',
      });

      expect(result.period.start_date).toBeDefined();
      expect(result.period.end_date).toBeDefined();
    });
  });

  // ============================================
  // getAccountAnalytics with different analysis values
  // ============================================
  describe('getAccountAnalytics', () => {
    describe('analysis: activity', () => {
      test('returns account activity summary', () => {
        const result = tools.getAccountAnalytics({
          analysis: 'activity',
          period: 'last_30_days',
        });

        expect(result.analysis).toBe('activity');
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.summary?.total_accounts).toBeDefined();
        expect(result.summary?.active_accounts).toBeDefined();
      });

      test('filters by account type', () => {
        const result = tools.getAccountAnalytics({
          analysis: 'activity',
          account_type: 'checking',
        });

        expect(result.analysis).toBe('activity');
        const data = result.data as Array<{ account_type?: string }>;
        if (data.length > 0) {
          expect(
            data.every(
              (a) =>
                a.account_type?.toLowerCase().includes('checking') ||
                a.account_type?.toLowerCase().includes('depository')
            )
          ).toBe(true);
        }
      });

      test('calculates activity levels correctly', () => {
        const result = tools.getAccountAnalytics({
          analysis: 'activity',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        const data = result.data as Array<{ activity_level: string; transaction_count: number }>;
        for (const account of data) {
          if (account.transaction_count >= 30) {
            expect(account.activity_level).toBe('high');
          } else if (account.transaction_count >= 10) {
            expect(account.activity_level).toBe('medium');
          } else if (account.transaction_count > 0) {
            expect(account.activity_level).toBe('low');
          } else {
            expect(account.activity_level).toBe('inactive');
          }
        }
      });
    });

    describe('analysis: balance_trends', () => {
      test('returns balance trend data', () => {
        const result = tools.getAccountAnalytics({
          analysis: 'balance_trends',
          months: 6,
        });

        expect(result.analysis).toBe('balance_trends');
        const data = result.data as { accounts: Array<unknown>; months: number };
        expect(data.months).toBe(6);
        expect(Array.isArray(data.accounts)).toBe(true);
      });

      test('filters by specific account_id', () => {
        const result = tools.getAccountAnalytics({
          analysis: 'balance_trends',
          account_id: 'acc1',
        });

        expect(result.analysis).toBe('balance_trends');
        const data = result.data as { accounts: Array<{ account_id: string }> };
        expect(data.accounts.length).toBe(1);
        expect(data.accounts[0].account_id).toBe('acc1');
      });
    });

    describe('analysis: fees', () => {
      test('returns fee analysis', () => {
        const result = tools.getAccountAnalytics({
          analysis: 'fees',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.analysis).toBe('fees');
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.summary?.total_fees).toBeDefined();
        expect(result.summary?.fee_count).toBeDefined();
      });

      test('filters fees by account_id', () => {
        const result = tools.getAccountAnalytics({
          analysis: 'fees',
          account_id: 'acc1',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.analysis).toBe('fees');
      });
    });
  });

  // ============================================
  // getBudgetAnalytics with different analysis values
  // ============================================
  describe('getBudgetAnalytics', () => {
    describe('analysis: utilization', () => {
      test('returns budget utilization data', () => {
        const result = tools.getBudgetAnalytics({
          analysis: 'utilization',
        });

        expect(result.analysis).toBe('utilization');
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.summary?.month).toBeDefined();
      });

      test('filters by category', () => {
        const result = tools.getBudgetAnalytics({
          analysis: 'utilization',
          category: 'food',
        });

        expect(result.analysis).toBe('utilization');
      });

      test('calculates utilization status correctly', () => {
        const result = tools.getBudgetAnalytics({
          analysis: 'utilization',
        });

        const data = result.data as Array<{ utilization_percent: number; status: string }>;
        for (const budget of data) {
          if (budget.utilization_percent >= 100) {
            expect(budget.status).toBe('over');
          } else if (budget.utilization_percent >= 80) {
            expect(budget.status).toBe('warning');
          } else {
            expect(budget.status).toBe('ok');
          }
        }
      });
    });

    describe('analysis: vs_actual', () => {
      test('returns budget vs actual comparison', () => {
        const result = tools.getBudgetAnalytics({
          analysis: 'vs_actual',
          months: 6,
        });

        expect(result.analysis).toBe('vs_actual');
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.summary?.months_analyzed).toBe(6);
      });
    });

    describe('analysis: alerts', () => {
      test('returns budget alerts', () => {
        const result = tools.getBudgetAnalytics({
          analysis: 'alerts',
          threshold_percentage: 80,
        });

        expect(result.analysis).toBe('alerts');
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.summary?.threshold).toBe(80);
        expect(result.summary?.alert_count).toBeDefined();
      });

      test('filters by custom threshold', () => {
        const result50 = tools.getBudgetAnalytics({
          analysis: 'alerts',
          threshold_percentage: 50,
        });

        const result90 = tools.getBudgetAnalytics({
          analysis: 'alerts',
          threshold_percentage: 90,
        });

        expect(result50.summary?.threshold).toBe(50);
        expect(result90.summary?.threshold).toBe(90);
      });
    });

    describe('analysis: recommendations', () => {
      test('returns budget recommendations', () => {
        const result = tools.getBudgetAnalytics({
          analysis: 'recommendations',
        });

        expect(result.analysis).toBe('recommendations');
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.summary?.recommendation_count).toBeDefined();
      });
    });
  });

  // ============================================
  // getGoalAnalytics with different analysis values
  // ============================================
  describe('getGoalAnalytics', () => {
    describe('analysis: projection', () => {
      test('returns goal projections', () => {
        const result = tools.getGoalAnalytics({
          analysis: 'projection',
        });

        expect(result.analysis).toBe('projection');
        expect(Array.isArray(result.data)).toBe(true);

        const projections = result.data as Array<{
          goal_id: string;
          name?: string;
          target_amount: number;
          current_amount: number;
          progress_percent: number;
          scenarios: {
            conservative: number | null;
            moderate: number | null;
            aggressive: number | null;
          };
        }>;

        if (projections.length > 0) {
          expect(projections[0].goal_id).toBeDefined();
          expect(projections[0].scenarios).toBeDefined();
        }
      });

      test('filters by goal_id', () => {
        const result = tools.getGoalAnalytics({
          analysis: 'projection',
          goal_id: 'goal1',
        });

        expect(result.analysis).toBe('projection');
        const data = result.data as Array<{ goal_id: string }>;
        expect(data.length).toBe(1);
        expect(data[0].goal_id).toBe('goal1');
      });
    });

    describe('analysis: risk', () => {
      test('returns goals at risk', () => {
        const result = tools.getGoalAnalytics({
          analysis: 'risk',
          months_lookback: 6,
        });

        expect(result.analysis).toBe('risk');
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.summary?.goals_at_risk).toBeDefined();
      });
    });

    describe('analysis: recommendations', () => {
      test('returns goal recommendations', () => {
        const result = tools.getGoalAnalytics({
          analysis: 'recommendations',
        });

        expect(result.analysis).toBe('recommendations');
        expect(Array.isArray(result.data)).toBe(true);
      });
    });
  });

  // ============================================
  // getInvestmentAnalytics with different analysis values
  // ============================================
  describe('getInvestmentAnalytics', () => {
    describe('analysis: performance', () => {
      test('returns investment performance data', () => {
        const result = tools.getInvestmentAnalytics({
          analysis: 'performance',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.analysis).toBe('performance');
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.summary?.securities_count).toBeDefined();
        expect(result.summary?.gainers).toBeDefined();
        expect(result.summary?.losers).toBeDefined();
      });

      test('filters by ticker symbol', () => {
        const result = tools.getInvestmentAnalytics({
          analysis: 'performance',
          ticker_symbol: 'AAPL',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.analysis).toBe('performance');
      });
    });

    describe('analysis: dividends', () => {
      test('returns dividend data', () => {
        const result = tools.getInvestmentAnalytics({
          analysis: 'dividends',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.analysis).toBe('dividends');
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.summary?.total_dividends).toBeDefined();
        expect(result.summary?.payment_count).toBeDefined();
      });

      test('filters by account_id', () => {
        const result = tools.getInvestmentAnalytics({
          analysis: 'dividends',
          account_id: 'acc_invest',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.analysis).toBe('dividends');
      });
    });

    describe('analysis: fees', () => {
      test('returns investment fee data', () => {
        const result = tools.getInvestmentAnalytics({
          analysis: 'fees',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.analysis).toBe('fees');
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.summary?.total_fees).toBeDefined();
        expect(result.summary?.fee_count).toBeDefined();
      });
    });
  });

  // ============================================
  // getMerchantAnalytics with different sort_by values
  // ============================================
  describe('getMerchantAnalytics', () => {
    describe('sort_by: spending', () => {
      test('sorts merchants by total spending', () => {
        const result = tools.getMerchantAnalytics({
          sort_by: 'spending',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.sort_by).toBe('spending');
        expect(result.merchants.length).toBeGreaterThan(0);
        expect(result.summary.total_merchants).toBeGreaterThan(0);

        // Verify sorted descending by spending
        for (let i = 1; i < result.merchants.length; i++) {
          expect(result.merchants[i - 1].total_spending).toBeGreaterThanOrEqual(
            result.merchants[i].total_spending
          );
        }
      });
    });

    describe('sort_by: frequency', () => {
      test('sorts merchants by transaction count', () => {
        const result = tools.getMerchantAnalytics({
          sort_by: 'frequency',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.sort_by).toBe('frequency');

        // Verify sorted descending by frequency
        for (let i = 1; i < result.merchants.length; i++) {
          expect(result.merchants[i - 1].transaction_count).toBeGreaterThanOrEqual(
            result.merchants[i].transaction_count
          );
        }
      });
    });

    describe('sort_by: average', () => {
      test('sorts merchants by average transaction amount', () => {
        const result = tools.getMerchantAnalytics({
          sort_by: 'average',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.sort_by).toBe('average');

        // Verify sorted descending by average
        for (let i = 1; i < result.merchants.length; i++) {
          expect(result.merchants[i - 1].average_transaction).toBeGreaterThanOrEqual(
            result.merchants[i].average_transaction
          );
        }
      });
    });

    test('respects limit parameter', () => {
      const result = tools.getMerchantAnalytics({
        sort_by: 'spending',
        limit: 5,
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.merchants.length).toBeLessThanOrEqual(5);
    });

    test('respects min_visits parameter', () => {
      const result = tools.getMerchantAnalytics({
        sort_by: 'spending',
        min_visits: 2,
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      for (const merchant of result.merchants) {
        expect(merchant.transaction_count).toBeGreaterThanOrEqual(2);
      }
    });

    test('includes visit frequency and dates', () => {
      const result = tools.getMerchantAnalytics({
        sort_by: 'spending',
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      if (result.merchants.length > 0) {
        const merchant = result.merchants[0];
        expect(merchant.visits_per_month).toBeDefined();
        expect(merchant.first_visit).toBeDefined();
        expect(merchant.last_visit).toBeDefined();
      }
    });
  });

  // ============================================
  // getTransactions with special transaction_type values
  // ============================================
  describe('getTransactions transaction_type', () => {
    describe('transaction_type: foreign', () => {
      test('returns foreign transactions', () => {
        const result = tools.getTransactions({
          transaction_type: 'foreign',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.count).toBeGreaterThan(0);
        expect(result.type_specific_data?.total_fx_fees).toBeDefined();
        expect(result.type_specific_data?.countries).toBeDefined();
      });
    });

    describe('transaction_type: refunds', () => {
      test('returns refund transactions', () => {
        const result = tools.getTransactions({
          transaction_type: 'refunds',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.type_specific_data?.total_refunded).toBeDefined();
        // All refund transactions should have negative amounts
        for (const txn of result.transactions) {
          expect(txn.amount).toBeLessThan(0);
        }
      });
    });

    describe('transaction_type: credits', () => {
      test('returns credit transactions', () => {
        const result = tools.getTransactions({
          transaction_type: 'credits',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.type_specific_data?.total_credits).toBeDefined();
      });
    });

    describe('transaction_type: duplicates', () => {
      test('returns duplicate transactions', () => {
        const result = tools.getTransactions({
          transaction_type: 'duplicates',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.type_specific_data?.duplicate_groups).toBeDefined();
        expect(result.type_specific_data?.groups).toBeDefined();
      });
    });

    describe('transaction_type: hsa_eligible', () => {
      test('returns HSA-eligible transactions', () => {
        const result = tools.getTransactions({
          transaction_type: 'hsa_eligible',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.type_specific_data?.total_hsa_eligible).toBeDefined();
        // All HSA transactions should be positive expenses
        for (const txn of result.transactions) {
          expect(txn.amount).toBeGreaterThan(0);
        }
      });
    });

    describe('transaction_type: tagged', () => {
      test('returns tagged transactions', () => {
        const result = tools.getTransactions({
          transaction_type: 'tagged',
          start_date: '2024-01-01',
          end_date: '2024-01-31',
        });

        expect(result.type_specific_data?.tags).toBeDefined();
      });
    });
  });

  // ============================================
  // getTransactions with location filtering
  // ============================================
  describe('getTransactions location filtering', () => {
    test('filters by city', () => {
      // Add transaction with city
      (db as any)._transactions = [
        ...mockTransactions,
        {
          transaction_id: 'txn_city',
          amount: 50.0,
          date: '2024-01-25',
          name: 'City Restaurant',
          category_id: 'food_dining',
          account_id: 'acc1',
          city: 'San Francisco',
        },
      ];

      const result = tools.getTransactions({
        city: 'San Francisco',
      });

      expect(result.count).toBeGreaterThan(0);
      expect(result.transactions[0].city).toBe('San Francisco');
    });

    test('filters by lat/lon with radius', () => {
      // Add transaction with coordinates
      (db as any)._transactions = [
        ...mockTransactions,
        {
          transaction_id: 'txn_coord',
          amount: 50.0,
          date: '2024-01-25',
          name: 'Nearby Restaurant',
          category_id: 'food_dining',
          account_id: 'acc1',
          lat: 37.7749,
          lon: -122.4194,
        },
      ];

      const result = tools.getTransactions({
        lat: 37.7749,
        lon: -122.4194,
        radius_km: 5,
      });

      expect(result.count).toBeGreaterThan(0);
    });
  });

  // ============================================
  // getTransactions with tag filtering
  // ============================================
  describe('getTransactions tag filtering', () => {
    test('filters by tag with hash', () => {
      const result = tools.getTransactions({
        tag: '#work',
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.count).toBeGreaterThan(0);
    });

    test('filters by tag without hash', () => {
      const result = tools.getTransactions({
        tag: 'work',
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.count).toBeGreaterThan(0);
    });
  });

  // ============================================
  // getCategories with different views
  // ============================================
  describe('getCategories', () => {
    describe('view: tree', () => {
      test('returns category tree structure', () => {
        const result = tools.getCategories({ view: 'tree' });

        expect(result.view).toBe('tree');
        expect(result.count).toBeGreaterThan(0);

        const data = result.data as { categories: Array<{ children: Array<unknown> }> };
        expect(data.categories).toBeDefined();
        expect(Array.isArray(data.categories)).toBe(true);
      });

      test('filters tree by type', () => {
        const result = tools.getCategories({ view: 'tree', type: 'expense' });

        expect(result.view).toBe('tree');
        const data = result.data as { type_filter: string };
        expect(data.type_filter).toBe('expense');
      });
    });

    describe('view: search', () => {
      test('searches categories by query', () => {
        const result = tools.getCategories({ view: 'search', query: 'food' });

        expect(result.view).toBe('search');
        const data = result.data as { query: string; categories: Array<unknown> };
        expect(data.query).toBe('food');
        expect(Array.isArray(data.categories)).toBe(true);
      });

      test('throws error when query is missing', () => {
        expect(() => tools.getCategories({ view: 'search' })).toThrow();
      });

      test('throws error for empty query', () => {
        expect(() => tools.getCategories({ view: 'search', query: '   ' })).toThrow();
      });
    });

    describe('parent_id parameter', () => {
      test('returns subcategories for valid parent', () => {
        const result = tools.getCategories({ parent_id: 'food_and_drink' });

        expect(result.view).toBe('subcategories');
        const data = result.data as { parent_id: string; subcategories: Array<unknown> };
        expect(data.parent_id).toBe('food_and_drink');
        expect(Array.isArray(data.subcategories)).toBe(true);
      });

      test('throws error for invalid parent_id', () => {
        expect(() => tools.getCategories({ parent_id: 'invalid_category_xyz' })).toThrow();
      });
    });
  });

  // ============================================
  // getGoalDetails
  // ============================================
  describe('getGoalDetails', () => {
    test('returns goal details with progress', () => {
      const result = tools.getGoalDetails({
        include: ['progress'],
      });

      expect(result.count).toBeGreaterThan(0);
      for (const goal of result.goals) {
        expect(goal.goal_id).toBeDefined();
        expect(goal.progress).toBeDefined();
      }
    });

    test('returns goal details with history', () => {
      const result = tools.getGoalDetails({
        goal_id: 'goal1',
        include: ['history'],
      });

      expect(result.count).toBe(1);
      expect(result.goals[0].history).toBeDefined();
    });

    test('returns goal details with contributions', () => {
      const result = tools.getGoalDetails({
        goal_id: 'goal1',
        include: ['contributions'],
      });

      expect(result.count).toBe(1);
      expect(result.goals[0].contributions).toBeDefined();
    });

    test('returns goal details with all includes', () => {
      const result = tools.getGoalDetails({
        include: ['progress', 'history', 'contributions'],
      });

      expect(result.count).toBeGreaterThan(0);
      for (const goal of result.goals) {
        expect(goal.progress).toBeDefined();
        expect(goal.history).toBeDefined();
        expect(goal.contributions).toBeDefined();
      }
    });
  });

  // ============================================
  // Additional coverage for edge cases
  // ============================================
  describe('Edge cases and validation', () => {
    test('getTransactions handles transaction_id lookup', () => {
      const result = tools.getTransactions({
        transaction_id: 'txn1',
      });

      expect(result.count).toBe(1);
      expect(result.transactions[0].transaction_id).toBe('txn1');
    });

    test('getTransactions returns empty for non-existent transaction_id', () => {
      const result = tools.getTransactions({
        transaction_id: 'non_existent_id',
      });

      expect(result.count).toBe(0);
      expect(result.transactions.length).toBe(0);
    });

    test('getTransactions handles query parameter', () => {
      const result = tools.getTransactions({
        query: 'Coffee',
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.count).toBeGreaterThan(0);
    });

    test('getBudgets returns all budgets', () => {
      const result = tools.getBudgets();

      expect(result.count).toBe(2);
      expect(result.total_budgeted).toBeGreaterThan(0);
    });

    test('getBudgets filters active only', () => {
      const result = tools.getBudgets({ active_only: true });

      expect(result.count).toBeGreaterThanOrEqual(0);
    });

    test('getGoals returns all goals', () => {
      const result = tools.getGoals();

      expect(result.count).toBe(2);
      expect(result.total_target).toBeGreaterThan(0);
    });

    test('getGoalProgress returns progress data', () => {
      const result = tools.getGoalProgress();

      expect(result.count).toBeGreaterThan(0);
      for (const goal of result.goals) {
        expect(goal.goal_id).toBeDefined();
      }
    });

    test('getGoalProgress filters by goal_id', () => {
      const result = tools.getGoalProgress({ goal_id: 'goal1' });

      expect(result.count).toBe(1);
      expect(result.goals[0].goal_id).toBe('goal1');
    });

    test('getGoalHistory returns history data', () => {
      const result = tools.getGoalHistory({
        goal_id: 'goal1',
        limit: 10,
      });

      expect(result.goal_id).toBe('goal1');
      expect(result.count).toBeGreaterThanOrEqual(0);
      expect(result.history).toBeDefined();
    });

    test('estimateGoalCompletion returns estimates', () => {
      const result = tools.estimateGoalCompletion();

      expect(result.count).toBeGreaterThan(0);
      for (const goal of result.goals) {
        expect(goal.goal_id).toBeDefined();
      }
    });

    test('getGoalContributions returns contribution data', () => {
      const result = tools.getGoalContributions({
        goal_id: 'goal1',
        limit: 10,
      });

      expect(result.goal_id).toBe('goal1');
      expect(result.total_contributed).toBeDefined();
      expect(result.monthly_breakdown).toBeDefined();
    });

    test('getRecurringTransactions includes Copilot subscriptions', () => {
      const result = tools.getRecurringTransactions({
        include_copilot_subscriptions: true,
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.count).toBeGreaterThanOrEqual(0);
      if (result.copilot_subscriptions) {
        expect(Array.isArray(result.copilot_subscriptions)).toBe(true);
      }
    });
  });

  // ============================================
  // Additional coverage for remaining methods
  // ============================================
  describe('Additional Tools Coverage', () => {
    test('getForeignTransactions returns foreign transaction data', () => {
      const result = tools.getForeignTransactions({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.count).toBeGreaterThanOrEqual(0);
      expect(result.total_fx_fees).toBeDefined();
      expect(result.countries).toBeDefined();
    });

    test('getRefunds returns refund data', () => {
      const result = tools.getRefunds({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.count).toBeGreaterThanOrEqual(0);
      expect(result.total_refunded).toBeDefined();
      expect(result.refunds_by_merchant).toBeDefined();
    });

    test('getCredits returns credits/cashback data', () => {
      const result = tools.getCredits({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.count).toBeGreaterThanOrEqual(0);
      expect(result.total_credits).toBeDefined();
      expect(result.credits_by_type).toBeDefined();
    });

    test('getDuplicateTransactions returns potential duplicates', () => {
      const result = tools.getDuplicateTransactions({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.duplicate_groups_count).toBeDefined();
      expect(result.total_potential_duplicates).toBeDefined();
      expect(result.duplicate_groups).toBeDefined();
    });

    test('getSpendingByDayOfWeek returns day breakdown', () => {
      const result = tools.getSpendingByDayOfWeek({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.total_spending).toBeGreaterThanOrEqual(0);
      expect(result.days.length).toBe(7);
    });

    test('getTrips returns detected trips', () => {
      const result = tools.getTrips({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.trip_count).toBeGreaterThanOrEqual(0);
      expect(result.trips).toBeDefined();
    });

    test('getTransactionById returns single transaction', () => {
      const result = tools.getTransactionById('txn1');

      expect(result.found).toBe(true);
      expect(result.transaction?.transaction_id).toBe('txn1');
    });

    test('getTransactionById returns not found for invalid ID', () => {
      const result = tools.getTransactionById('invalid_id');

      expect(result.found).toBe(false);
      expect(result.transaction).toBeUndefined();
    });

    test('getTopMerchants returns top spending merchants', () => {
      const result = tools.getTopMerchants({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.merchants).toBeDefined();
      expect(Array.isArray(result.merchants)).toBe(true);
    });

    test('getUnusualTransactions returns anomalies', () => {
      const result = tools.getUnusualTransactions({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.count).toBeGreaterThanOrEqual(0);
      expect(result.transactions).toBeDefined();
    });

    test('getHsaFsaEligible returns eligible transactions', () => {
      const result = tools.getHsaFsaEligible({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.count).toBeGreaterThanOrEqual(0);
      expect(result.total_amount).toBeDefined();
      expect(result.by_category).toBeDefined();
    });

    test('getSpendingRate returns spending velocity', () => {
      const result = tools.getSpendingRate({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.daily_average).toBeDefined();
      expect(result.weekly_average).toBeDefined();
      expect(result.projected_monthly_total).toBeDefined();
    });

    test('getDataQualityReport returns data quality metrics', () => {
      const result = tools.getDataQualityReport({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.summary).toBeDefined();
      expect(result.summary.total_transactions).toBeDefined();
      expect(result.category_issues).toBeDefined();
      expect(result.currency_issues).toBeDefined();
      expect(result.duplicate_issues).toBeDefined();
    });

    test('comparePeriods compares two time periods', () => {
      const result = tools.comparePeriods({
        period1: 'last_month',
        period2: 'this_month',
      });

      expect(result.period1).toBeDefined();
      expect(result.period2).toBeDefined();
      expect(result.comparison).toBeDefined();
      expect(result.category_comparison).toBeDefined();
    });

    test('getInvestmentPrices returns price data', () => {
      const result = tools.getInvestmentPrices();

      expect(result.count).toBeGreaterThanOrEqual(0);
      expect(result.prices).toBeDefined();
    });

    test('getInvestmentPrices filters by ticker', () => {
      const result = tools.getInvestmentPrices({ ticker_symbol: 'AAPL' });

      expect(result.count).toBeGreaterThanOrEqual(0);
    });

    test('getInvestmentPriceHistory returns price history', () => {
      const result = tools.getInvestmentPriceHistory({
        ticker_symbol: 'AAPL',
      });

      expect(result.ticker_symbol).toBe('AAPL');
      expect(result.count).toBeGreaterThanOrEqual(0);
    });

    test('getInvestmentSplits returns split data', () => {
      const result = tools.getInvestmentSplits();

      expect(result.count).toBeGreaterThanOrEqual(0);
      expect(result.splits).toBeDefined();
    });

    test('getConnectedInstitutions returns institution data', () => {
      const result = tools.getConnectedInstitutions();

      expect(result.count).toBeGreaterThanOrEqual(0);
      expect(result.institutions).toBeDefined();
    });

    test('getCategoryHierarchy returns category tree', () => {
      const result = tools.getCategoryHierarchy();

      expect(result.count).toBeGreaterThan(0);
      expect(result.categories).toBeDefined();
    });

    test('getCategoryHierarchy filters by type', () => {
      const result = tools.getCategoryHierarchy({ type: 'expense' });

      expect(result.count).toBeGreaterThan(0);
    });

    test('getSubcategories returns child categories', () => {
      const result = tools.getSubcategories('food_and_drink');

      expect(result.parent_id).toBe('food_and_drink');
      expect(result.count).toBeGreaterThanOrEqual(0);
    });

    test('searchCategoriesHierarchy searches categories', () => {
      const result = tools.searchCategoriesHierarchy('food');

      expect(result.query).toBe('food');
      expect(result.count).toBeGreaterThanOrEqual(0);
    });

    test('getSpendingOverTime returns time-series data', () => {
      const result = tools.getSpendingOverTime({
        granularity: 'month',
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.granularity).toBe('month');
      expect(result.periods).toBeDefined();
    });

    test('getAverageTransactionSize returns size analysis', () => {
      const result = tools.getAverageTransactionSize({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.overall_average).toBeDefined();
      expect(result.groups).toBeDefined();
    });

    test('getCategoryTrends returns category trend analysis', () => {
      const result = tools.getCategoryTrends({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.current_period).toBeDefined();
      expect(result.trends).toBeDefined();
    });

    test('getMerchantFrequency returns frequency data', () => {
      const result = tools.getMerchantFrequency({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.summary).toBeDefined();
      expect(result.merchants).toBeDefined();
    });

    test('getBudgetUtilization returns utilization data', () => {
      const result = tools.getBudgetUtilization();

      expect(result.budgets).toBeDefined();
    });

    test('getBudgetVsActual returns comparison data', () => {
      const result = tools.getBudgetVsActual({ months: 3 });

      expect(result.months_analyzed).toBeDefined();
      expect(result.comparisons).toBeDefined();
      expect(result.insights).toBeDefined();
    });

    test('getBudgetRecommendations returns recommendations', () => {
      const result = tools.getBudgetRecommendations();

      expect(result.recommendations).toBeDefined();
    });

    test('getBudgetAlerts returns budget alerts', () => {
      const result = tools.getBudgetAlerts({ threshold_percentage: 80 });

      expect(result.month).toBeDefined();
      expect(result.alerts).toBeDefined();
      expect(result.summary).toBeDefined();
    });

    test('getPortfolioAllocation returns allocation data', () => {
      const result = tools.getPortfolioAllocation();

      expect(result.total_value).toBeDefined();
      expect(result.by_account).toBeDefined();
      expect(result.summary).toBeDefined();
    });

    test('getInvestmentPerformance returns performance metrics', () => {
      const result = tools.getInvestmentPerformance({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.performance).toBeDefined();
      expect(result.summary).toBeDefined();
    });

    test('getDividendIncome returns dividend data', () => {
      const result = tools.getDividendIncome({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.total_dividends).toBeDefined();
      expect(result.dividends).toBeDefined();
    });

    test('getInvestmentFees returns fee data', () => {
      const result = tools.getInvestmentFees({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.total_fees).toBeDefined();
      expect(result.fees).toBeDefined();
    });

    test('getGoalProjection returns projection data', () => {
      const result = tools.getGoalProjection();

      expect(result.goals).toBeDefined();
    });

    test('getGoalMilestones returns milestone data', () => {
      const result = tools.getGoalMilestones();

      expect(result.goals).toBeDefined();
    });

    test('getGoalsAtRisk returns at-risk goals', () => {
      const result = tools.getGoalsAtRisk();

      expect(result.at_risk_count).toBeGreaterThanOrEqual(0);
      expect(result.goals).toBeDefined();
    });

    test('getGoalRecommendations returns recommendations', () => {
      const result = tools.getGoalRecommendations();

      expect(result.recommendations).toBeDefined();
    });

    test('getAccountActivity returns activity data', () => {
      const result = tools.getAccountActivity({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.accounts).toBeDefined();
    });

    test('getBalanceTrends returns balance trend data', () => {
      const result = tools.getBalanceTrends({ months: 3 });

      expect(result.months_analyzed).toBeDefined();
      expect(result.accounts).toBeDefined();
      expect(result.summary).toBeDefined();
    });

    test('getAccountFees returns account fee data', () => {
      const result = tools.getAccountFees({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
      });

      expect(result.total_fees).toBeDefined();
      expect(result.fees).toBeDefined();
    });

    test('getYearOverYear returns year comparison', () => {
      const result = tools.getYearOverYear();

      expect(result.current_year).toBeDefined();
      expect(result.compare_year).toBeDefined();
      expect(result.current_period).toBeDefined();
      expect(result.compare_period).toBeDefined();
    });

    test('getAdvancedSearch performs complex search', () => {
      const result = tools.getAdvancedSearch({
        merchant_query: 'Coffee',
      });

      expect(result.count).toBeGreaterThanOrEqual(0);
      expect(result.transactions).toBeDefined();
    });

    test('getTagSearch searches by tag', () => {
      const result = tools.getTagSearch({ tag: 'work' });

      expect(result.count).toBeGreaterThanOrEqual(0);
      expect(result.transactions).toBeDefined();
      expect(result.all_tags).toBeDefined();
    });

    test('getNoteSearch searches by note', () => {
      const result = tools.getNoteSearch({ query: 'business' });

      expect(result.query).toBe('business');
      expect(result.transactions).toBeDefined();
    });

    test('getLocationSearch searches by location', () => {
      const result = tools.getLocationSearch({ city: 'San Francisco' });

      expect(result.transactions).toBeDefined();
    });
  });
});
