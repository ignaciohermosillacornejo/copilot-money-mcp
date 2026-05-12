/**
 * Shared types used across multiple investments query wrappers.
 *
 * Kept in a single module to avoid duplicating the TimeFrame string union
 * across the five wrappers that take it. SecurityNode and MarketInfoNode
 * are also shared between holdings.ts and top-movers.ts (aggregated-holdings.ts
 * uses a slimmer variant that omits `currentPrice` — see its JSDoc).
 */

/**
 * Server-recognized timeframe enum values for investments queries.
 *
 * Not all values are accepted by every query — for example, the
 * high-frequency security-prices endpoint only accepts `ONE_DAY` and
 * `ONE_WEEK`. The server validates per-operation; we keep the union open
 * here so callers can pass any captured value without per-wrapper unions.
 */
export type TimeFrame =
  | 'ONE_DAY'
  | 'ONE_WEEK'
  | 'ONE_MONTH'
  | 'THREE_MONTHS'
  | 'YTD'
  | 'ONE_YEAR'
  | 'ALL';

/**
 * All TimeFrame values, in display order. Use for MCP tool schema
 * `enum:` constraints so the option list cannot drift from the union above.
 */
export const ALL_TIME_FRAMES: TimeFrame[] = [
  'ONE_DAY',
  'ONE_WEEK',
  'ONE_MONTH',
  'THREE_MONTHS',
  'YTD',
  'ONE_YEAR',
  'ALL',
];

/**
 * Market hours metadata attached to each Security.
 *
 * Both fields are epoch milliseconds and may be `null` (e.g. for CASH
 * positions or securities the server cannot resolve a market calendar for).
 */
export interface MarketInfoNode {
  closeTime: number | null;
  openTime: number | null;
}

/**
 * Canonical SecurityFields fragment shape (per
 * `docs/graphql-capture/operations/queries/Holdings.md`).
 *
 * Used by holdings.ts and top-movers.ts. `aggregated-holdings.ts` uses a
 * slimmer variant (AggregatedSecurityNode) that omits `currentPrice`.
 */
export interface SecurityNode {
  id: string;
  name: string;
  symbol: string;
  type: string;
  currentPrice: number;
  lastUpdate: string;
  marketInfo: MarketInfoNode;
}
