/**
 * GraphQL query wrapper for SecurityPrices.
 *
 * Returns a date-sorted price series for a single security at daily
 * granularity. Use for medium- to long-range views: `ONE_MONTH`,
 * `THREE_MONTHS`, `YTD`, `ONE_YEAR`, `ALL`. For intraday ranges
 * (`ONE_DAY`, `ONE_WEEK`), use `fetchSecurityPricesHighFrequency` instead
 * — that variant returns intraday timestamps rather than per-day rows.
 *
 * The captured query at docs/graphql-capture/operations/queries/SecurityPrices.md
 * declares its security argument as `$id: ID!` in the operation signature
 * but passes it to the resolver as `securityId: $id`. The wrapper exposes
 * the user-facing variable name `id` to match the operation signature.
 */

import { z } from 'zod';
import type { GraphQLClient } from '../client.js';
import { SECURITY_PRICES } from '../operations.generated.js';
import type { TimeFrame } from './_shared.js';

export interface SecurityPricePointNode {
  id: string;
  /**
   * Daily close for the security. NULL for a day the security has no price
   * (e.g. the earliest day in the requested window). Live-verified via
   * `bun run smoke:reads` on 2026-07-12. Downstream (get_investment_prices_live)
   * drops null points; this wrapper passes them through so the read-shape gate
   * can observe them.
   */
  price: number | null;
  /** ISO YYYY-MM-DD; one row per market day in the requested range. */
  date: string;
}

export interface FetchSecurityPricesOpts {
  id: string;
  timeFrame?: TimeFrame;
}

export interface SecurityPricesResponse {
  securityPrices: SecurityPricePointNode[];
}

export async function fetchSecurityPrices(
  client: GraphQLClient,
  opts: FetchSecurityPricesOpts
): Promise<SecurityPricePointNode[]> {
  const data = await client.query<{ id: string; timeFrame?: TimeFrame }, SecurityPricesResponse>(
    'SecurityPrices',
    SECURITY_PRICES,
    { id: opts.id, timeFrame: opts.timeFrame }
  );
  return data.securityPrices;
}

/** Zod mirror of `SecurityPricesResponse` (#537). price is null for a day the
 * security has no close (live-verified). */
export const SecurityPricesResponseSchema = z.looseObject({
  securityPrices: z.array(
    z.looseObject({
      id: z.string(),
      price: z.number().nullable(),
      date: z.string(),
    })
  ),
});
