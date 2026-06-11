/**
 * Investment tool definitions (cache-mode reads).
 */

import { defineTool, type ToolMethodArgs } from './types.js';
import { BALANCE_HISTORY_GRANULARITIES } from '../constants.js';
import { PRICE_TYPES } from '../../models/index.js';

export const getInvestmentPricesTool = defineTool({
  schema: {
    name: 'get_investment_prices',
    description:
      'Get investment price history for portfolio tracking. Returns daily and high-frequency ' +
      'price data for stocks, ETFs, mutual funds, and crypto. Filter by ticker symbol, date range, ' +
      'or price type (daily/hf). Includes OHLCV data when available.',
    inputSchema: {
      type: 'object',
      properties: {
        ticker_symbol: {
          type: 'string',
          description: 'Filter by ticker symbol (e.g., "AAPL", "BTC-USD", "VTSAX")',
        },
        start_date: { type: 'string', description: 'Start date (YYYY-MM-DD or YYYY-MM)' },
        end_date: { type: 'string', description: 'End date (YYYY-MM-DD or YYYY-MM)' },
        price_type: {
          type: 'string',
          enum: [...PRICE_TYPES],
          description:
            'Filter by price type: daily (monthly aggregates) or hf (high-frequency intraday)',
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
  handler: (ctx, args) => ctx.tools.getInvestmentPrices(args || {}),
});

export const getInvestmentSplitsTool = defineTool({
  schema: {
    name: 'get_investment_splits',
    description:
      'Get stock split events from the local Firestore cache. Returns one row ' +
      'per (security, effective_date) with the adjustment multiplier (e.g. 0.1 ' +
      'for a 10-for-1 split — multiply pre-split prices/quantities by this value ' +
      'to convert to the post-split equivalent). Joined with the securities ' +
      'collection so each row includes ticker and name. ' +
      'IMPORTANT: prices returned by `get_investment_prices` and ' +
      '`get_investment_prices_live` are ALREADY split-adjusted by Copilot. ' +
      'Use this tool only when you need the split events themselves (e.g., for ' +
      'narrative or historical-analysis purposes) — you do NOT need to apply ' +
      'these multipliers to the prices yourself. Securities that have never ' +
      'split are not included in the output. Coverage is limited to securities ' +
      'Copilot currently syncs in your local cache (typically currently-held ' +
      'or recently-held).',
    inputSchema: {
      type: 'object',
      properties: {
        ticker_symbol: {
          type: 'string',
          description: 'Optional. Case-insensitive ticker filter (e.g. "NVDA").',
        },
        start_date: {
          type: 'string',
          description: 'Optional. Inclusive lower bound on effective_date (YYYY-MM-DD).',
        },
        end_date: {
          type: 'string',
          description: 'Optional. Inclusive upper bound on effective_date (YYYY-MM-DD).',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of rows. Default 100, max 10000.',
          default: 100,
        },
        offset: {
          type: 'integer',
          description: 'Pagination offset, default 0.',
          default: 0,
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  readOnly: true,
  handler: (ctx, args) => ctx.tools.getInvestmentSplits(args || {}),
});

export const getHoldingsTool = defineTool({
  schema: {
    name: 'get_holdings',
    description:
      'Get current investment holdings with position-level detail. Returns ticker, name, ' +
      'quantity, current price, equity value, average cost, and total return per holding. ' +
      'Joins data from account holdings, securities, and optionally historical snapshots. ' +
      'Filter by account or ticker symbol. Note: cost_basis may be unavailable for ' +
      'cash-equivalent positions.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Filter by investment account ID' },
        ticker_symbol: {
          type: 'string',
          description: 'Filter by ticker symbol (e.g., "AAPL", "SCHX")',
        },
        include_history: {
          type: 'boolean',
          description: 'Include monthly price/quantity snapshots per holding (default: false)',
          default: false,
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
  swappedOutInLiveMode: true,
  handler: (ctx, args) => ctx.tools.getHoldings(args || {}),
});

// Deliberately NOT `swappedOutInLiveMode`: get_balance_history_live's
// GraphQL backing is strictly narrower than cache mode — single-account,
// timeFrame-enum only, no weekly/monthly downsampling, no name/limit
// enrichment. Both tools coexist so callers can pick the right shape per
// use case.
export const getBalanceHistoryTool = defineTool({
  schema: {
    name: 'get_balance_history',
    description:
      'Get daily balance snapshots for accounts over time. Each entry returns current_balance, ' +
      'available_balance, limit, account_id, and account_name. The response also includes an ' +
      '`accounts` array listing the distinct account IDs in the paginated page. Requires a ' +
      `granularity parameter (${BALANCE_HISTORY_GRANULARITIES.join(', ')}) to control response size. Weekly and ` +
      'monthly modes downsample by keeping the last data point per period. Filter by ' +
      'account_id and date range.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: {
          type: 'string',
          description: 'Filter by account ID',
        },
        start_date: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD)',
        },
        end_date: {
          type: 'string',
          description: 'End date (YYYY-MM-DD)',
        },
        granularity: {
          type: 'string',
          enum: [...BALANCE_HISTORY_GRANULARITIES],
          description:
            'Required. Controls response density: daily (every day), weekly (one per week), ' +
            'or monthly (one per month). Use weekly or monthly for longer time ranges.',
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
      required: ['granularity'],
    },
    annotations: { readOnlyHint: true },
  },
  readOnly: true,
  handler: (ctx, args) =>
    ctx.tools.getBalanceHistory((args as ToolMethodArgs<'getBalanceHistory'>) || {}),
});
