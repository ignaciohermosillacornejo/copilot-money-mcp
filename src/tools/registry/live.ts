/**
 * Live (GraphQL-backed) tool definitions.
 *
 * Schemas are owned by the per-domain modules in `../live/` (each module
 * pairs a tool class with its schema factory); this module wraps them into
 * `ToolDefinition`s so the server derives listing, dispatch, and the
 * `--live-reads` gate from the registry. All of these tools are listed only
 * when the server runs with `--live-reads`; dispatch without the flag
 * returns an isError result pointing at it (`requiresLiveReads`).
 *
 * Handlers use `ctx.live!` — the server guards dispatch so live handlers
 * are only invoked when live mode is on.
 */

import { defineTool } from './types.js';
import { createLiveToolSchemas, type LiveTransactionsTools } from '../live/transactions.js';
import { createLiveAccountsToolSchema, type LiveAccountsTools } from '../live/accounts.js';
import { createLiveCategoriesToolSchema, type LiveCategoriesTools } from '../live/categories.js';
import { createLiveTagsToolSchema, type LiveTagsTools } from '../live/tags.js';
import { createLiveBudgetsToolSchema, type LiveBudgetsTools } from '../live/budgets.js';
import { createLiveRecurringToolSchema, type LiveRecurringTools } from '../live/recurring.js';
import { createLiveNetworthToolSchema, type LiveNetworthTools } from '../live/networth.js';
import {
  createLiveUpcomingRecurringsToolSchema,
  type LiveUpcomingRecurringsTools,
} from '../live/upcoming-recurrings.js';
import {
  createLiveMonthlySpendToolSchema,
  type LiveMonthlySpendTools,
} from '../live/monthly-spend.js';
import { createLiveHoldingsToolSchema, type LiveHoldingsTools } from '../live/holdings.js';
import {
  createLiveBalanceHistoryToolSchema,
  type LiveBalanceHistoryTools,
} from '../live/balance-history.js';
import {
  createLiveInvestmentPricesToolSchema,
  type LiveInvestmentPricesTools,
} from '../live/investment-prices.js';
import { createRefreshCacheToolSchema, type RefreshCacheTool } from '../live/refresh-cache.js';

export const getTransactionsLiveTool = defineTool({
  schema: createLiveToolSchemas()[0]!,
  readOnly: true,
  requiresLiveReads: true,
  handler: (ctx, args) =>
    ctx.live!.transactions.getTransactions(
      (args as Parameters<LiveTransactionsTools['getTransactions']>[0]) || {}
    ),
});

export const getAccountsLiveTool = defineTool({
  schema: createLiveAccountsToolSchema(),
  readOnly: true,
  requiresLiveReads: true,
  handler: (ctx, args) =>
    ctx.live!.accounts.getAccounts((args as Parameters<LiveAccountsTools['getAccounts']>[0]) ?? {}),
});

export const getCategoriesLiveTool = defineTool({
  schema: createLiveCategoriesToolSchema(),
  readOnly: true,
  requiresLiveReads: true,
  handler: (ctx, args) =>
    ctx.live!.categories.getCategories(
      (args as Parameters<LiveCategoriesTools['getCategories']>[0]) ?? {}
    ),
});

export const getTagsLiveTool = defineTool({
  schema: createLiveTagsToolSchema(),
  readOnly: true,
  requiresLiveReads: true,
  handler: (ctx, args) =>
    ctx.live!.tags.getTags((args as Parameters<LiveTagsTools['getTags']>[0]) ?? {}),
});

export const getBudgetsLiveTool = defineTool({
  schema: createLiveBudgetsToolSchema(),
  readOnly: true,
  requiresLiveReads: true,
  handler: (ctx, args) =>
    ctx.live!.budgets.getBudgets((args as Parameters<LiveBudgetsTools['getBudgets']>[0]) ?? {}),
});

export const getRecurringLiveTool = defineTool({
  schema: createLiveRecurringToolSchema(),
  readOnly: true,
  requiresLiveReads: true,
  handler: (ctx, args) =>
    ctx.live!.recurring.getRecurring(
      (args as Parameters<LiveRecurringTools['getRecurring']>[0]) ?? {}
    ),
});

export const getNetworthLiveTool = defineTool({
  schema: createLiveNetworthToolSchema(),
  readOnly: true,
  requiresLiveReads: true,
  handler: (ctx, args) =>
    ctx.live!.networth.getNetworth((args as Parameters<LiveNetworthTools['getNetworth']>[0]) ?? {}),
});

export const getUpcomingRecurringsLiveTool = defineTool({
  schema: createLiveUpcomingRecurringsToolSchema(),
  readOnly: true,
  requiresLiveReads: true,
  handler: (ctx, args) =>
    ctx.live!.upcomingRecurrings.getUpcomingRecurrings(
      (args as Parameters<LiveUpcomingRecurringsTools['getUpcomingRecurrings']>[0]) ?? {}
    ),
});

export const getMonthlySpendLiveTool = defineTool({
  schema: createLiveMonthlySpendToolSchema(),
  readOnly: true,
  requiresLiveReads: true,
  handler: (ctx, args) =>
    ctx.live!.monthlySpend.getMonthlySpend(
      (args as Parameters<LiveMonthlySpendTools['getMonthlySpend']>[0]) ?? {}
    ),
});

export const getHoldingsLiveTool = defineTool({
  schema: createLiveHoldingsToolSchema(),
  readOnly: true,
  requiresLiveReads: true,
  handler: (ctx, args) =>
    ctx.live!.holdings.getHoldings((args as Parameters<LiveHoldingsTools['getHoldings']>[0]) ?? {}),
});

export const getBalanceHistoryLiveTool = defineTool({
  schema: createLiveBalanceHistoryToolSchema(),
  readOnly: true,
  requiresLiveReads: true,
  // item_id and account_id are required by the schema; the runtime
  // validation (in getBalanceHistory) surfaces a clean error if a caller
  // bypasses the schema.
  handler: (ctx, args) =>
    ctx.live!.balanceHistory.getBalanceHistory(
      (args ?? {}) as unknown as Parameters<LiveBalanceHistoryTools['getBalanceHistory']>[0]
    ),
});

export const getInvestmentPricesLiveTool = defineTool({
  schema: createLiveInvestmentPricesToolSchema(),
  readOnly: true,
  requiresLiveReads: true,
  // security_id is required by the schema; the runtime validation (in
  // getInvestmentPrices) surfaces a clean error if a caller bypasses the
  // schema.
  handler: (ctx, args) =>
    ctx.live!.investmentPrices.getInvestmentPrices(
      (args ?? {}) as unknown as Parameters<LiveInvestmentPricesTools['getInvestmentPrices']>[0]
    ),
});

export const refreshCacheTool = defineTool({
  schema: createRefreshCacheToolSchema(),
  readOnly: true,
  requiresLiveReads: true,
  handler: (ctx, args) =>
    ctx.live!.refreshCache.refresh((args as Parameters<RefreshCacheTool['refresh']>[0]) ?? {}),
  // Historical behavior: refresh_cache errors are returned verbatim
  // (no `Error: ` prefix).
  formatError: (message) => message,
});
