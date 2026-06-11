/**
 * GraphQL query wrapper for BalanceHistory.
 *
 * Returns a date-sorted balance timeseries for a single account. One row
 * per day in the requested `timeFrame`. The web app fires this query when
 * the user clicks a time-range button (1W / 1M / 3M / YTD / 1Y / ALL) on
 * an account detail page.
 *
 * The operation is named `BalanceHistory`, but the resolver returns the
 * data under the `accountBalanceHistory` field — that's what the wrapper
 * reads. Verified against
 * docs/graphql-capture/operations/queries/BalanceHistory.md.
 *
 * Both `itemId` and `accountId` are required (the server enforces the
 * non-null `ID!` annotation).
 */

import type { GraphQLClient } from '../client.js';
import { BALANCE_HISTORY } from '../operations.generated.js';
import type { TimeFrame } from './_shared.js';

export interface BalanceHistoryPointNode {
  /** ISO YYYY-MM-DD; one row per day in the requested range. */
  date: string;
  balance: number;
}

export interface FetchAccountBalanceHistoryOpts {
  itemId: string;
  accountId: string;
  timeFrame?: TimeFrame;
}

export interface BalanceHistoryResponse {
  accountBalanceHistory: BalanceHistoryPointNode[];
}

export async function fetchAccountBalanceHistory(
  client: GraphQLClient,
  opts: FetchAccountBalanceHistoryOpts
): Promise<BalanceHistoryPointNode[]> {
  const data = await client.query<
    { itemId: string; accountId: string; timeFrame?: TimeFrame },
    BalanceHistoryResponse
  >('BalanceHistory', BALANCE_HISTORY, {
    itemId: opts.itemId,
    accountId: opts.accountId,
    timeFrame: opts.timeFrame,
  });
  return data.accountBalanceHistory;
}
