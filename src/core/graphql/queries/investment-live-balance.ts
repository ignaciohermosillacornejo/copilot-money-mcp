/**
 * GraphQL query wrapper for InvestmentLiveBalance.
 *
 * Returns the current-moment combined investment balance — a single
 * `{id, date, balance}` row. This is the "live dot" companion to the
 * timeseries returned by `fetchInvestmentBalance`; the web app fires both
 * on /investments load (one for the chart, one for the current value).
 *
 * The captured query at docs/graphql-capture/operations/queries/InvestmentLiveBalance.md
 * takes no variables. One round-trip per call.
 *
 * The row shape is identical to `InvestmentBalanceNode`, so we reuse that
 * type rather than declare a parallel one.
 */

import type { GraphQLClient } from '../client.js';
import { INVESTMENT_LIVE_BALANCE } from '../operations.generated.js';
import type { InvestmentBalanceNode } from './investment-balance.js';

interface InvestmentLiveBalanceResponse {
  investmentLiveBalance: InvestmentBalanceNode;
}

export async function fetchInvestmentLiveBalance(
  client: GraphQLClient
): Promise<InvestmentBalanceNode> {
  const data = await client.query<Record<string, never>, InvestmentLiveBalanceResponse>(
    'InvestmentLiveBalance',
    INVESTMENT_LIVE_BALANCE,
    {}
  );
  return data.investmentLiveBalance;
}
