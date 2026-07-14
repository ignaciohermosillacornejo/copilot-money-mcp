/**
 * Tool registry — one `ToolDefinition` per MCP tool.
 *
 * The server derives its tool list, dispatch, write gating, and live-reads
 * gating from this registry; `createToolSchemas()` /
 * `createWriteToolSchemas()` (and through them `scripts/sync-manifest.ts`
 * and the conformance ledger walk) are projections of the same definitions,
 * so there are no parallel lists to keep in sync.
 */

import type { ToolDefinition } from './types.js';
import {
  getTransactionsTool,
  createTransactionTool,
  deleteTransactionTool,
  addTransactionToRecurringTool,
  splitTransactionTool,
  updateTransactionTool,
  reviewTransactionsTool,
} from './transactions.js';
import {
  getCategoriesTool,
  createCategoryTool,
  updateCategoryTool,
  deleteCategoryTool,
} from './categories.js';
import { createTagTool, deleteTagTool, updateTagTool } from './tags.js';
import {
  getRecurringTransactionsTool,
  setRecurringStateTool,
  deleteRecurringTool,
  createRecurringTool,
  updateRecurringTool,
} from './recurring.js';
import {
  getBudgetsTool,
  setBudgetTool,
  getGoalsTool,
  getGoalHistoryTool,
} from './budgets-goals.js';
import {
  getInvestmentPricesTool,
  getInvestmentSplitsTool,
  getHoldingsTool,
  getBalanceHistoryTool,
} from './investments.js';
import {
  getCacheInfoTool,
  refreshDatabaseTool,
  getAccountsTool,
  getConnectionStatusTool,
} from './accounts-system.js';
import {
  getTransactionsLiveTool,
  getAccountsLiveTool,
  getCategoriesLiveTool,
  getTagsLiveTool,
  getBudgetsLiveTool,
  getRecurringLiveTool,
  getNetworthLiveTool,
  getUpcomingRecurringsLiveTool,
  getMonthlySpendLiveTool,
  getHoldingsLiveTool,
  getBalanceHistoryLiveTool,
  getInvestmentPricesLiveTool,
  getInvestmentAllocationLiveTool,
  refreshCacheTool,
} from './live.js';

export type { ToolDefinition, ToolContext, LiveToolContext } from './types.js';

/**
 * Cache-mode read tools, in MCP tool-list order. Tools with
 * `swappedOutInLiveMode` are hidden from the list when --live-reads is on
 * (their `_live` counterpart replaces them).
 */
export const READ_TOOL_DEFS: readonly ToolDefinition[] = [
  getTransactionsTool,
  getCacheInfoTool,
  refreshDatabaseTool,
  getAccountsTool,
  getConnectionStatusTool,
  getCategoriesTool,
  getRecurringTransactionsTool,
  getBudgetsTool,
  getGoalsTool,
  getInvestmentPricesTool,
  getInvestmentSplitsTool,
  getHoldingsTool,
  getBalanceHistoryTool,
  getGoalHistoryTool,
];

/**
 * Live (GraphQL-backed) tools, in MCP tool-list order. Listed and
 * dispatchable only when the server runs with --live-reads.
 */
export const LIVE_TOOL_DEFS: readonly ToolDefinition[] = [
  getTransactionsLiveTool,
  getAccountsLiveTool,
  getCategoriesLiveTool,
  getTagsLiveTool,
  getBudgetsLiveTool,
  getRecurringLiveTool,
  getNetworthLiveTool,
  getUpcomingRecurringsLiveTool,
  getMonthlySpendLiveTool,
  getHoldingsLiveTool,
  getBalanceHistoryLiveTool,
  getInvestmentPricesLiveTool,
  getInvestmentAllocationLiveTool,
  refreshCacheTool,
];

/**
 * Write tools, in MCP tool-list order. Listed and dispatchable only when
 * the server runs with --write.
 */
export const WRITE_TOOL_DEFS: readonly ToolDefinition[] = [
  createTransactionTool,
  deleteTransactionTool,
  addTransactionToRecurringTool,
  splitTransactionTool,
  updateTransactionTool,
  reviewTransactionsTool,
  createTagTool,
  deleteTagTool,
  createCategoryTool,
  updateCategoryTool,
  deleteCategoryTool,
  setBudgetTool,
  setRecurringStateTool,
  deleteRecurringTool,
  updateTagTool,
  createRecurringTool,
  updateRecurringTool,
];

/** Every tool definition, in MCP tool-list order (reads, live, writes). */
export const ALL_TOOL_DEFS: readonly ToolDefinition[] = [
  ...READ_TOOL_DEFS,
  ...LIVE_TOOL_DEFS,
  ...WRITE_TOOL_DEFS,
];

/** Name → definition lookup used by the server's dispatch. */
export const TOOL_REGISTRY: ReadonlyMap<string, ToolDefinition> = new Map(
  ALL_TOOL_DEFS.map((def) => [def.name, def])
);

if (TOOL_REGISTRY.size !== ALL_TOOL_DEFS.length) {
  throw new Error('Tool registry contains duplicate tool names');
}
