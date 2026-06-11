/**
 * Budget + goal tool definitions (cache-mode reads + the set_budget write).
 *
 * Goals are cache-only: Copilot's GraphQL endpoint does not expose goal
 * data, so the goal reads have no live counterparts.
 */

import { defineTool, type ToolMethodArgs } from './types.js';

export const getBudgetsTool = defineTool({
  schema: {
    name: 'get_budgets',
    description:
      "Get budgets from Copilot's native budget tracking. " +
      'Returns the current-month effective budget per category plus the full ' +
      '`amounts` map of per-month overrides for history lookups. For parent ' +
      'categories, the returned `amount` is the resolved total (children + ' +
      'rollovers) that Copilot displays in the Budgets view. Totals use the ' +
      'current-month effective amount.',
    inputSchema: {
      type: 'object',
      properties: {
        active_only: {
          type: 'boolean',
          description: 'Only return active budgets (default: false)',
          default: false,
        },
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  readOnly: true,
  swappedOutInLiveMode: true,
  handler: (ctx, args) => ctx.tools.getBudgets(args || {}),
});

export const setBudgetTool = defineTool({
  schema: {
    name: 'set_budget',
    description:
      'Set the monthly budget amount for a category. amount="0" clears the budget. ' +
      'Pass month="YYYY-MM" for a single-month override; omit for the all-months default. ' +
      'Note: if the user has disabled "Enable budgeting" or "Enable rollover" in ' +
      'Copilot → Settings → General, the budget write still succeeds on the server, but ' +
      'the value will not appear in the Copilot UI until those toggles are re-enabled. ' +
      'Rollover behavior also depends on the "Rollover categories" selection in the same ' +
      'settings pane, which is not writable through this tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category_id: {
          type: 'string' as const,
          description: 'ID of the category to budget.',
        },
        amount: {
          type: 'string' as const,
          description: 'Decimal amount as a string (e.g. "250.00"). "0" clears the budget.',
        },
        month: {
          type: 'string' as const,
          description:
            'Optional. YYYY-MM for a single-month override. Omit to set the all-months default.',
        },
      },
      required: ['category_id', 'amount'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  readOnly: false,
  handler: (ctx, args) => ctx.tools.setBudget(args as ToolMethodArgs<'setBudget'>),
});

export const getGoalsTool = defineTool({
  schema: {
    name: 'get_goals',
    description:
      "Get financial goals from Copilot's native goal tracking. " +
      'Retrieves user-defined savings goals, debt payoff targets, and investment goals. ' +
      'Returns goal details including target amounts, monthly contributions, status (active/paused), ' +
      'start dates, and tracking configuration. Calculates total target amount across all goals. ' +
      "Cache-only: no live-mode (`--live-reads`) counterpart exists because Copilot's GraphQL endpoint " +
      'does not expose goal data, so this tool always returns cached LevelDB data regardless of the ' +
      '`--live-reads` flag.',
    inputSchema: {
      type: 'object',
      properties: {
        active_only: {
          type: 'boolean',
          description: 'Only return active goals (default: false)',
          default: false,
        },
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  readOnly: true,
  handler: (ctx, args) => ctx.tools.getGoals(args || {}),
});

export const getGoalHistoryTool = defineTool({
  schema: {
    name: 'get_goal_history',
    description:
      'Get monthly progress snapshots for financial goals. Returns current_amount, ' +
      'target_amount, daily data points, and contribution records per month. ' +
      'Filter by goal_id or month range (YYYY-MM). ' +
      "Cache-only: no live-mode (`--live-reads`) counterpart exists because Copilot's GraphQL endpoint " +
      'does not expose goal data, so this tool always returns cached LevelDB data regardless of the ' +
      '`--live-reads` flag.',
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: {
          type: 'string',
          description: 'Filter by goal ID',
        },
        start_month: {
          type: 'string',
          description: 'Start month (YYYY-MM)',
        },
        end_month: {
          type: 'string',
          description: 'End month (YYYY-MM)',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of results (default: 100, max: 10000)',
          default: 100,
        },
        offset: {
          type: 'integer',
          description: 'Number of results to skip for pagination (default: 0)',
          default: 0,
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  readOnly: true,
  handler: (ctx, args) => ctx.tools.getGoalHistory(args || {}),
});
