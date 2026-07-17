/**
 * GraphQL query wrapper for Holdings.
 *
 * Returns the user's investment positions — one row per (account, security)
 * pair. Each row carries the security definition, the held quantity, and a
 * `metrics` block with cost-basis / return numbers.
 *
 * `metrics` is `null` for non-investable positions — most commonly CASH
 * sleeves inside investment accounts, where average cost / cost basis /
 * total return are not meaningful. Callers must null-check before using.
 *
 * `costBasis` is the absolute total cost (quantity-weighted), not per-share.
 * `totalReturn` is a dollar amount and can be negative; the web UI derives
 * the displayed percentage as `totalReturn / costBasis`.
 *
 * The captured query at docs/graphql-capture/operations/queries/Holdings.md
 * takes no variables. One round-trip per call.
 */

import { z } from 'zod';
import type { GraphQLClient } from '../client.js';
import { HOLDINGS } from '../operations.generated.js';
import type { SecurityNode } from './_shared.js';
import { SecurityNodeSchema } from './_shared.js';

export interface HoldingMetricNode {
  averageCost: number;
  costBasis: number;
  totalReturn: number;
}

export interface HoldingNode {
  id: string;
  accountId: string;
  itemId: string;
  quantity: number;
  security: SecurityNode;
  metrics: HoldingMetricNode | null;
}

export interface HoldingsResponse {
  holdings: HoldingNode[];
}

export async function fetchHoldings(client: GraphQLClient): Promise<HoldingNode[]> {
  const data = await client.query<Record<string, never>, HoldingsResponse>(
    'Holdings',
    HOLDINGS,
    {}
  );
  return data.holdings;
}

/** Zod mirror of `HoldingsResponse` (#537). metrics is null for
 * non-investable (CASH) positions. */
export const HoldingsResponseSchema = z.looseObject({
  holdings: z.array(
    z.looseObject({
      id: z.string(),
      accountId: z.string(),
      itemId: z.string(),
      quantity: z.number(),
      security: SecurityNodeSchema,
      metrics: z
        .looseObject({
          averageCost: z.number(),
          costBasis: z.number(),
          totalReturn: z.number(),
        })
        .nullable(),
    })
  ),
});
