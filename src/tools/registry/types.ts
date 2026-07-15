/**
 * Tool registry core types.
 *
 * Each MCP tool has exactly one `ToolDefinition` — schema, handler, and
 * classification in a single object. The server's tool list, dispatch,
 * write gating, and manifest sync are all derived from these definitions
 * (see `registry/index.ts`), so there are no parallel lists to keep in sync.
 *
 * Runtime-leaf module: all imports are type-only, so domain modules can
 * depend on it without creating import cycles with `tools.ts`.
 */

import type { CopilotMoneyTools, ToolSchema } from '../tools.js';
import type { LiveTransactionsTools } from '../live/transactions.js';
import type { LiveAccountsTools } from '../live/accounts.js';
import type { LiveCategoriesTools } from '../live/categories.js';
import type { LiveTagsTools } from '../live/tags.js';
import type { LiveBudgetsTools } from '../live/budgets.js';
import type { LiveRecurringTools } from '../live/recurring.js';
import type { LiveNetworthTools } from '../live/networth.js';
import type { LiveUpcomingRecurringsTools } from '../live/upcoming-recurrings.js';
import type { LiveMonthlySpendTools } from '../live/monthly-spend.js';
import type { LiveHoldingsTools } from '../live/holdings.js';
import type { LiveBalanceHistoryTools } from '../live/balance-history.js';
import type { LiveInvestmentPricesTools } from '../live/investment-prices.js';
import type { LiveInvestmentAllocationTools } from '../live/investment-allocation.js';
import type { LiveTopMoversTools } from '../live/top-movers.js';
import type { LiveAggregatedHoldingsTools } from '../live/aggregated-holdings.js';
import type { RefreshCacheTool } from '../live/refresh-cache.js';

/**
 * Live (GraphQL-backed) tool instances, available only when the server
 * runs with `--live-reads`.
 */
export interface LiveToolContext {
  transactions: LiveTransactionsTools;
  accounts: LiveAccountsTools;
  categories: LiveCategoriesTools;
  tags: LiveTagsTools;
  budgets: LiveBudgetsTools;
  recurring: LiveRecurringTools;
  networth: LiveNetworthTools;
  upcomingRecurrings: LiveUpcomingRecurringsTools;
  monthlySpend: LiveMonthlySpendTools;
  holdings: LiveHoldingsTools;
  balanceHistory: LiveBalanceHistoryTools;
  investmentPrices: LiveInvestmentPricesTools;
  investmentAllocation: LiveInvestmentAllocationTools;
  topMovers: LiveTopMoversTools;
  aggregatedHoldings: LiveAggregatedHoldingsTools;
  refreshCache: RefreshCacheTool;
}

/**
 * Per-call context handed to tool handlers. Built by the server from its
 * current `CopilotMoneyTools` instance (and live instances when enabled).
 */
export interface ToolContext {
  tools: CopilotMoneyTools;
  /** Present only when the server runs with `--live-reads`. */
  live?: LiveToolContext;
}

/**
 * First (options/args) parameter of a `CopilotMoneyTools` method —
 * mirrors the `Parameters<typeof this.tools.x>[0]` casts that previously
 * lived in the server's dispatch switch.
 */
export type ToolMethodArgs<M extends keyof CopilotMoneyTools> = CopilotMoneyTools[M] extends (
  ...params: infer P
) => unknown
  ? P[0]
  : never;

/**
 * One MCP tool: schema, handler, and classification in a single definition.
 */
export interface ToolDefinition {
  /** Tool name as exposed over MCP. Always equals `schema.name`. */
  name: string;
  /** MCP schema (name, description, inputSchema, annotations). */
  schema: ToolSchema;
  /**
   * Executes the tool. Receives the per-call context and the raw MCP
   * arguments; argument casting/defaulting is the handler's job so each
   * definition preserves its exact historical semantics.
   *
   * Handlers of live tools may use `ctx.live!` — the server guards
   * dispatch so they are only invoked when live mode is on.
   */
  handler: (ctx: ToolContext, args: Record<string, unknown> | undefined) => Promise<unknown>;
  /**
   * `false` ⇔ write tool: listed only with `--write` and blocked at
   * dispatch otherwise. Matches `annotations.readOnlyHint`.
   */
  readOnly: boolean;
  /**
   * Live tool: listed only with `--live-reads`; dispatch otherwise
   * returns an isError result pointing at the flag.
   */
  requiresLiveReads?: boolean;
  /**
   * Cache-mode read that has a `_live` replacement: hidden from the tool
   * list when `--live-reads` is on (but still dispatchable if called).
   */
  swappedOutInLiveMode?: boolean;
  /**
   * Formats the text of an isError response for errors thrown by the
   * handler. Defaults to `Error: ${message}`.
   */
  formatError?: (message: string) => string;
}

/** Build a `ToolDefinition`, deriving `name` from the schema. */
export function defineTool(def: Omit<ToolDefinition, 'name'>): ToolDefinition {
  return { name: def.schema.name, ...def };
}
