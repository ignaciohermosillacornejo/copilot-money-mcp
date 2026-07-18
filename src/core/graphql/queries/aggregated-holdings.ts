/**
 * GraphQL query wrapper for AggregatedHoldings.
 *
 * Returns one row per security with aggregated `value` (current market
 * value of the user's position) and `change` (period-over-period delta
 * scoped by `timeFrame`). Useful for an investments overview table that
 * collapses per-account rows into per-security totals.
 *
 * The captured query at docs/graphql-capture/operations/queries/AggregatedHoldings.md
 * accepts an optional `timeFrame`, an opaque `filter` input object (the
 * server schema is `AggregatedHoldingsFilter`; structure not captured —
 * accept as `Record<string, unknown>[]` for now), plus optional `accountId` / `itemId`
 * scope filters.
 *
 * NOTE: the embedded `security` block in this query intentionally omits
 * `currentPrice` — the aggregated view exposes `value` (already
 * quantity-weighted) instead. See the capture doc for the exact selected
 * fields. We declare a slimmer `AggregatedSecurityNode` rather than reuse
 * `SecurityNode` from `_shared.ts` to keep the type honest.
 */

import { z } from 'zod';
import type { GraphQLClient } from '../client.js';
import { AGGREGATED_HOLDINGS } from '../operations.generated.js';
import type { MarketInfoNode, TimeFrame } from './_shared.js';
import { MarketInfoNodeSchema } from './_shared.js';

/**
 * Slimmer Security shape used by AggregatedHoldings only.
 *
 * Distinct from `SecurityNode` because the captured AggregatedHoldings
 * query does NOT select `currentPrice` — the aggregated row carries
 * `value` (quantity * currentPrice) instead, so `currentPrice` would be
 * redundant. Keeping the missing field out of the type prevents callers
 * from reaching for an undefined property at runtime.
 */
export interface AggregatedSecurityNode {
  id: string;
  name: string;
  symbol: string;
  type: string;
  /**
   * Epoch-ms timestamp, or null. Server type drift — mislabeled `string` —
   * caught by the read-shape smoke on 2026-07-17 (#537); same class as
   * latestBalanceUpdate (#551).
   */
  lastUpdate: number | null;
  marketInfo: MarketInfoNode;
}

export interface AggregatedHoldingNode {
  security: AggregatedSecurityNode;
  change: number;
  value: number;
}

export interface FetchAggregatedHoldingsOpts {
  timeFrame?: TimeFrame;
  filter?: Record<string, unknown>[];
  accountId?: string;
  itemId?: string;
}

export interface AggregatedHoldingsResponse {
  aggregatedHoldings: AggregatedHoldingNode[];
}

export async function fetchAggregatedHoldings(
  client: GraphQLClient,
  opts: FetchAggregatedHoldingsOpts = {}
): Promise<AggregatedHoldingNode[]> {
  const data = await client.query<
    {
      timeFrame?: TimeFrame;
      filter?: Record<string, unknown>[];
      accountId?: string;
      itemId?: string;
    },
    AggregatedHoldingsResponse
  >('AggregatedHoldings', AGGREGATED_HOLDINGS, {
    timeFrame: opts.timeFrame,
    filter: opts.filter,
    accountId: opts.accountId,
    itemId: opts.itemId,
  });
  return data.aggregatedHoldings;
}

/** Slimmer security shape (no currentPrice) — mirrors AggregatedSecurityNode. */
const AggregatedSecurityNodeSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  symbol: z.string(),
  type: z.string(),
  lastUpdate: z.number().nullable(),
  marketInfo: MarketInfoNodeSchema,
});

/** Zod mirror of `AggregatedHoldingsResponse` (#537). */
export const AggregatedHoldingsResponseSchema = z.looseObject({
  aggregatedHoldings: z.array(
    z.looseObject({
      security: AggregatedSecurityNodeSchema,
      change: z.number(),
      value: z.number(),
    })
  ),
});
