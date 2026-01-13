/**
 * Core functionality for Copilot Money data access.
 */

export { CopilotDatabase } from './database.js';
export {
  decodeTransactions,
  decodeAccounts,
  decodeRecurring,
  decodeBudgets,
  decodeGoals,
  decodeGoalHistory,
  decodeInvestmentPrices,
  decodeInvestmentSplits,
} from './decoder.js';
