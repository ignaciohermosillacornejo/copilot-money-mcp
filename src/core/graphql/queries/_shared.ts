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
 * Compile-time pin for a wire node's two hand-maintained declarations: the TS
 * interface, and its zod mirror. A row type in src/tools/live/ spreads the
 * INTERFACE, while the wire-parity tests compare against the MIRROR, and
 * nothing else links the pair — read validation uses `z.looseObject` precisely
 * so new server fields flow through without warnings, so the read smokes keep
 * a mirror honest in the remove and type-change directions but not the add
 * one. Without a pin, adding a field to the operation document and the
 * interface while forgetting the mirror drifts silently into every caller's
 * row (#537 was exactly that, one hop earlier).
 *
 * Resolves to `false` rather than `never` on a mismatch on purpose: `never` is
 * assignable to everything, so a `never`-based pin satisfies any annotation
 * and detects nothing.
 *
 * Usage — one line per interface/mirror twin, assigned `true`:
 *
 *   export const FOO_NODE_MIRROR_IS_EXACT: ExactKeys<
 *     keyof FooNode,
 *     keyof typeof FooNodeSchema.shape
 *   > = true;
 *
 * Export the const rather than declaring it locally: an unused local would be
 * deleted by a future no-unused-vars sweep, taking the pin with it.
 */
export type ExactKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

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
  /**
   * Epoch-ms timestamp, or null. Server type drift — mislabeled `string` —
   * caught by the read-shape smoke on 2026-07-17 (#537); same class as
   * latestBalanceUpdate (#551).
   */
  lastUpdate: number | null;
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
  lastUpdate: z.number().nullable(),
  marketInfo: MarketInfoNodeSchema,
});

/** See {@link ExactKeys}. Pins the two shared investments nodes. */
export const MARKET_INFO_NODE_MIRROR_IS_EXACT: ExactKeys<
  keyof MarketInfoNode,
  keyof typeof MarketInfoNodeSchema.shape
> = true;
export const SECURITY_NODE_MIRROR_IS_EXACT: ExactKeys<
  keyof SecurityNode,
  keyof typeof SecurityNodeSchema.shape
> = true;
