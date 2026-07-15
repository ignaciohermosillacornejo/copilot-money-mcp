/**
 * GraphQL query wrapper for TopMovers.
 *
 * Returns the biggest movers across the user's holdings — one row per
 * security with a recent-price series and a single aggregate `change`
 * number. The web app fires this query twice on /investments load, once
 * per `filter` value:
 *
 * - `PRICE_CHANGE`: ranks by raw security price change.
 * - `MY_EQUITY_CHANGE`: ranks by the dollar impact on the user's position
 *   (price change weighted by held quantity).
 *
 * The captured query at docs/graphql-capture/operations/queries/TopMovers.md
 * takes an optional `$filter: TopMoversFilter`. When omitted, the server
 * applies its own default; callers usually pass an explicit filter.
 */

import type { GraphQLClient } from '../client.js';
import { TOP_MOVERS } from '../operations.generated.js';
import type { SecurityNode } from './_shared.js';

export type TopMoversFilter = 'PRICE_CHANGE' | 'MY_EQUITY_CHANGE';

/**
 * A single price point in a `TopMoverNode.values` series.
 *
 * `timestamp` is epoch milliseconds — live-verified (#540 Task 4, 13-digit
 * magnitude ~1.7e12). Passed through unscaled by get_top_movers_live.
 */
export interface PricePointNode {
  id: string;
  timestamp: number;
  price: number;
}

export interface TopMoverNode {
  security: SecurityNode;
  values: PricePointNode[];
  change: number;
}

export interface FetchTopMoversOpts {
  filter?: TopMoversFilter;
}

export interface TopMoversResponse {
  topMovers: TopMoverNode[];
}

export async function fetchTopMovers(
  client: GraphQLClient,
  opts: FetchTopMoversOpts = {}
): Promise<TopMoverNode[]> {
  const data = await client.query<{ filter?: TopMoversFilter }, TopMoversResponse>(
    'TopMovers',
    TOP_MOVERS,
    { filter: opts.filter }
  );
  return data.topMovers;
}
