/**
 * Data models for Copilot Money.
 */

export {
  TransactionSchema,
  type Transaction,
  type TransactionWithDisplayName,
  getTransactionDisplayName,
  withDisplayName as withTransactionDisplayName,
} from './transaction.js';

export {
  AccountSchema,
  type Account,
  type AccountWithDisplayName,
  getAccountDisplayName,
  withDisplayName as withAccountDisplayName,
} from './account.js';

export { CategorySchema, type Category } from './category.js';

export { RecurringSchema, type Recurring, getRecurringDisplayName } from './recurring.js';

export { BudgetSchema, type Budget, getBudgetDisplayName } from './budget.js';

export {
  GoalSchema,
  type Goal,
  getGoalDisplayName,
  getGoalCurrentAmount,
  getGoalProgress,
  getGoalMonthlyContribution,
  isGoalActive,
  estimateGoalCompletion,
  calculateProgressVelocity,
} from './goal.js';

export {
  GoalHistorySchema,
  type GoalHistory,
  DailySnapshotSchema,
  type DailySnapshot,
  GoalContributionSchema,
  type GoalContribution,
  getHistoryCurrentAmount,
  getHistoryProgress,
  getLatestDailySnapshot,
  getDailySnapshotsSorted,
  getTotalContributions,
  getAverageDailyAmount,
  getMonthStartEnd,
} from './goal-history.js';

export {
  InvestmentPriceSchema,
  type InvestmentPrice,
  getBestPrice,
  getPriceDate,
  isHighFrequencyPrice,
  isDailyPrice,
  getInvestmentDisplayName,
  formatPrice,
} from './investment-price.js';

export {
  InvestmentSplitSchema,
  type InvestmentSplit,
  type ParsedSplitRatio,
  parseSplitRatio,
  getSplitMultiplier,
  getSplitDisplayString,
  getSplitDisplayName,
  isReverseSplit,
  adjustPriceForSplit,
  adjustSharesForSplit,
  formatSplitDate,
} from './investment-split.js';
