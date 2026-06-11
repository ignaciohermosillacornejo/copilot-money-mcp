/**
 * Tool value-set constants shared between the tool handlers
 * (`tools.ts`) and the tool registry (`registry/`).
 *
 * Kept in a leaf module (no imports) so registry modules can reference
 * these values without creating a runtime import cycle with `tools.ts`.
 */

/**
 * Special transaction-type filters accepted by `get_transactions` (cache mode).
 * Single source of truth for the param type, schema enum, tool description,
 * and `_filterByTransactionType` branching. The live tool supports a subset —
 * see `LIVE_TRANSACTION_TYPES` in `live/transactions.ts`.
 */
export const TRANSACTION_TYPE_FILTERS = [
  'foreign',
  'refunds',
  'credits',
  'duplicates',
  'hsa_eligible',
  'tagged',
] as const;
export type TransactionTypeFilter = (typeof TRANSACTION_TYPE_FILTERS)[number];

/** View modes accepted by `get_categories` (param type + schema enum + handler branching). */
export const CATEGORY_VIEWS = ['list', 'tree', 'search'] as const;
export type CategoryView = (typeof CATEGORY_VIEWS)[number];

/**
 * Downsampling granularities accepted by `get_balance_history`
 * (param type + runtime guard + error messages + schema enum).
 */
export const BALANCE_HISTORY_GRANULARITIES = ['daily', 'weekly', 'monthly'] as const;
export type BalanceHistoryGranularity = (typeof BALANCE_HISTORY_GRANULARITIES)[number];
