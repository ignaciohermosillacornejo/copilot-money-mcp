/**
 * Account + system tool definitions (cache-mode reads).
 *
 * "System" covers the cache-introspection tools (get_cache_info,
 * refresh_database, get_connection_status) that report on the local
 * LevelDB cache rather than a financial entity.
 */

import { defineTool } from './types.js';

export const getCacheInfoTool = defineTool({
  schema: {
    name: 'get_cache_info',
    description:
      'Get information about the local data cache, including the date range of cached transactions ' +
      'and total count. Useful for understanding data availability before running historical queries. ' +
      'This tool reads from a local cache that may not contain your complete transaction history. ' +
      'Also reports decode_health: per-collection counts of documents dropped on schema validation ' +
      'failure (a "degraded" status means some cached documents are missing from results).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  readOnly: true,
  handler: (ctx) => ctx.tools.getCacheInfo(),
});

export const refreshDatabaseTool = defineTool({
  schema: {
    name: 'refresh_database',
    description:
      'Refresh the in-memory cache by reloading data from the local Copilot Money database. ' +
      'Use this when the user has recently synced new transactions in the Copilot Money app, ' +
      'or when you suspect the cached data is stale. The cache also auto-refreshes every 5 minutes. ' +
      'Returns the updated cache info after refresh.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  readOnly: true,
  handler: (ctx) => ctx.tools.refreshDatabase(),
});

export const getAccountsTool = defineTool({
  schema: {
    name: 'get_accounts',
    description:
      'Get all accounts with balances, plus summary fields: total_balance (net worth = assets minus liabilities), ' +
      'total_assets, and total_liabilities. Optionally filter by account type ' +
      '(checking, savings, credit, investment). Checks both account_type ' +
      'and subtype fields for better filtering (e.g., finds checking accounts ' +
      "even when account_type is 'depository'). By default, hidden accounts are excluded.",
    inputSchema: {
      type: 'object',
      properties: {
        account_type: {
          type: 'string',
          description:
            'Filter by account type (checking, savings, credit, loan, investment, depository). ' +
            'Note: summary totals (total_assets, total_liabilities, total_balance) reflect only the filtered subset.',
        },
        include_hidden: {
          type: 'boolean',
          description: 'Include hidden accounts (default: false)',
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
  handler: (ctx, args) => ctx.tools.getAccounts(args),
});

export const getConnectionStatusTool = defineTool({
  schema: {
    name: 'get_connection_status',
    description:
      'Get connection status for all linked financial institutions. ' +
      'Shows per-institution sync health including last successful update timestamps ' +
      'for transactions and investments, login requirements, and error states. ' +
      'Use this to check when accounts were last synced or to identify connections needing attention. ' +
      'Also reports decode_health: per-collection counts of cached documents dropped on schema ' +
      'validation failure (a "degraded" status means some documents are missing from results). ' +
      'Also reports scheduled_smoke: the last scheduled API-drift check (pass / fail / ' +
      'auth-missing with timestamp), or null if the weekly job is not installed.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  readOnly: true,
  handler: (ctx) => ctx.tools.getConnectionStatus(),
});
