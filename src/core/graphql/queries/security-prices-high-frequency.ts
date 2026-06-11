/**
 * GraphQL query wrapper for SecurityPricesHighFrequency.
 *
 * Returns an intraday price series for a single security. Use for short
 * ranges only: `ONE_DAY` (minute-bar granularity) and `ONE_WEEK`
 * (sub-hourly). Longer ranges should use `fetchSecurityPrices`, which
 * returns one row per market day.
 *
 * The wrapper does not enforce the timeFrame restriction — the server
 * validates and will reject other values. Documented here so callers don't
 * waste a round-trip discovering it.
 *
 * The captured query at docs/graphql-capture/operations/queries/SecurityPricesHighFrequency.md
 * declares its security argument as `$id: ID!` in the operation signature
 * but passes it to the resolver as `securityId: $id`.
 */

import type { GraphQLClient } from '../client.js';
import { SECURITY_PRICES_HIGH_FREQUENCY } from '../operations.generated.js';
import type { TimeFrame } from './_shared.js';

/**
 * A single intraday price point.
 *
 * `timestamp` is whatever opaque numeric the server returns. The captured
 * payload does not disambiguate epoch-millis vs epoch-seconds; treat as
 * an ordered key for plotting.
 */
export interface HighFrequencyPricePointNode {
  id: string;
  timestamp: number;
  price: number;
}

export interface FetchSecurityPricesHighFrequencyOpts {
  id: string;
  timeFrame?: TimeFrame;
}

export interface SecurityPricesHighFrequencyResponse {
  securityPricesHighFrequency: HighFrequencyPricePointNode[];
}

export async function fetchSecurityPricesHighFrequency(
  client: GraphQLClient,
  opts: FetchSecurityPricesHighFrequencyOpts
): Promise<HighFrequencyPricePointNode[]> {
  const data = await client.query<
    { id: string; timeFrame?: TimeFrame },
    SecurityPricesHighFrequencyResponse
  >('SecurityPricesHighFrequency', SECURITY_PRICES_HIGH_FREQUENCY, {
    id: opts.id,
    timeFrame: opts.timeFrame,
  });
  return data.securityPricesHighFrequency;
}
