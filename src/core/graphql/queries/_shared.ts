/**
 * Shared types used across multiple investments query wrappers.
 *
 * Kept in a single module to avoid duplicating the TimeFrame string union
 * across the five wrappers that take it. SecurityNode and MarketInfoNode
 * are also shared between holdings.ts and top-movers.ts (aggregated-holdings.ts
 * uses a slimmer variant that omits `currentPrice` — see its JSDoc).
 */

import { z } from 'zod';

/**
 * Server-recognized timeframe enum values for investments queries.
 *
 * Not all values are accepted by every query — for example, the
 * high-frequency security-prices endpoint only accepts `ONE_DAY` and
 * `ONE_WEEK`. The server validates per-operation; we keep the union open
 * here so callers can pass any captured value without per-wrapper unions.
 */
export type TimeFrame =
  'ONE_DAY' | 'ONE_WEEK' | 'ONE_MONTH' | 'THREE_MONTHS' | 'YTD' | 'ONE_YEAR' | 'ALL';

/**
 * All TimeFrame values, in display order. Use for MCP tool schema
 * `enum:` constraints so the option list cannot drift from the union above.
 *
 * `satisfies readonly TimeFrame[]` ensures every element is a valid member
 * of the union — extra-entry drift (a typo, or a value removed from the
 * union) is caught at compile time. Missing-entry drift (a new variant
 * added to the union but not added here) is NOT caught; TypeScript will
 * stay silent in that case.
 */
export const ALL_TIME_FRAMES = [
  'ONE_DAY',
  'ONE_WEEK',
  'ONE_MONTH',
  'THREE_MONTHS',
  'YTD',
  'ONE_YEAR',
  'ALL',
] as const satisfies readonly TimeFrame[];

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

/** Zod mirror of MarketInfoNode (#537). Both epoch-ms fields nullable. */
export const MarketInfoNodeSchema = z.looseObject({
  closeTime: z.number().nullable(),
  openTime: z.number().nullable(),
});

/** Zod mirror of SecurityNode (SecurityFields fragment) (#537). Shared by
 * holdings + top-movers; aggregated-holdings uses a slimmer variant. */
export const SecurityNodeSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  symbol: z.string(),
  type: z.string(),
  currentPrice: z.number(),
  lastUpdate: z.string(),
  marketInfo: MarketInfoNodeSchema,
});
