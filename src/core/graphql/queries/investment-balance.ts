/**
 * GraphQL query wrapper for InvestmentBalance.
 *
 * Returns a date-sorted balance timeseries across all investment accounts
 * combined. One row per day in the requested `timeFrame`. Use for the
 * investments-page top-of-page chart.
 *
 * For the current-moment value rather than the timeseries, use
 * `fetchInvestmentLiveBalance` — same row shape, but a single point.
 *
 * The captured query at docs/graphql-capture/operations/queries/InvestmentBalance.md
 * takes an optional `$timeFrame: TimeFrame`. When omitted, the server
 * applies its own default range.
 */

import type { GraphQLClient } from '../client.js';
import { INVESTMENT_BALANCE } from '../operations.generated.js';
import type { TimeFrame } from './_shared.js';

export interface InvestmentBalanceNode {
  id: string;
  /** ISO YYYY-MM-DD; one row per day in the requested range. */
  date: string;
  balance: number;
}

export interface FetchInvestmentBalanceOpts {
  timeFrame?: TimeFrame;
}

export interface InvestmentBalanceResponse {
  investmentBalance: InvestmentBalanceNode[];
}

export async function fetchInvestmentBalance(
  client: GraphQLClient,
  opts: FetchInvestmentBalanceOpts = {}
): Promise<InvestmentBalanceNode[]> {
  const data = await client.query<{ timeFrame?: TimeFrame }, InvestmentBalanceResponse>(
    'InvestmentBalance',
    INVESTMENT_BALANCE,
    { timeFrame: opts.timeFrame }
  );
  return data.investmentBalance;
}
