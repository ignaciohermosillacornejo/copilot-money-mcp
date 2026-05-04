/**
 * GraphQL query wrapper for Networth (net-worth-over-time history).
 *
 * Returns a flat, date-sorted list of `{date, assets, debt}` snapshots.
 * The captured `Networth` query takes a `$timeFrame: TimeFrame` enum
 * (commonly `"ALL"`, `"YEAR"`, `"MONTH"`); response shape is a simple
 * array (no nesting, no pagination).
 *
 * The response includes a client-side `total` field stripped by the
 * operations generator — net worth at each point is `assets - debt`.
 *
 * The captured query at docs/graphql-capture/operations/queries/Networth.md
 * exposes only `assets`, `debt`, `date` on each NetworthHistory entry
 * (after the @client `total` is stripped). `assets` and `debt` are
 * nullable strings — early dates in the user's history may have
 * `assets: null` until backfilled.
 */

import type { GraphQLClient } from '../client.js';
import { NETWORTH } from '../operations.generated.js';

export interface NetworthHistoryNode {
  date: string;
  assets: string | null;
  debt: string | null;
}

export interface FetchNetworthHistoryOpts {
  timeFrame: string;
}

interface NetworthResponse {
  networthHistory: NetworthHistoryNode[];
}

export async function fetchNetworthHistory(
  client: GraphQLClient,
  opts: FetchNetworthHistoryOpts
): Promise<NetworthHistoryNode[]> {
  const data = await client.query<{ timeFrame: string }, NetworthResponse>(
    'Networth',
    NETWORTH,
    { timeFrame: opts.timeFrame }
  );
  return data.networthHistory;
}
