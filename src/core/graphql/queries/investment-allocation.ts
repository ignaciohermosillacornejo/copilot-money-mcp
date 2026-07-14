/**
 * GraphQL query wrapper for InvestmentAllocation.
 *
 * Returns one row per asset class describing the user's portfolio mix —
 * an `amount` (dollar value), a `percentage` (of total invested), and a
 * categorical `type` string (e.g. `"EQUITY"`, `"CASH"`, `"FIXED_INCOME"`).
 *
 * The captured query at docs/graphql-capture/operations/queries/InvestmentAllocation.md
 * accepts an optional `$filter: AllocationFilter` input object with
 * `accountId` and `itemId` fields for scope filtering. When omitted, the
 * server returns the allocation across all investment accounts.
 */

import type { GraphQLClient } from '../client.js';
import { INVESTMENT_ALLOCATION } from '../operations.generated.js';

export interface AllocationFilter {
  accountId?: string;
  itemId?: string;
}

export interface AllocationNode {
  id: string;
  /** Asset class label — e.g. "EQUITY", "CASH", "FIXED_INCOME". */
  type: string;
  amount: number;
  /**
   * Share of total invested, as a percent (0..100) — live-verified against a
   * real response (#539), not a fraction. Passed through unscaled by the
   * get_investment_allocation_live tool.
   */
  percentage: number;
}

export interface FetchInvestmentAllocationOpts {
  filter?: AllocationFilter;
}

export interface InvestmentAllocationResponse {
  investmentAllocation: AllocationNode[];
}

export async function fetchInvestmentAllocation(
  client: GraphQLClient,
  opts: FetchInvestmentAllocationOpts = {}
): Promise<AllocationNode[]> {
  const data = await client.query<{ filter?: AllocationFilter }, InvestmentAllocationResponse>(
    'InvestmentAllocation',
    INVESTMENT_ALLOCATION,
    { filter: opts.filter }
  );
  return data.investmentAllocation;
}
