/**
 * GraphQL query wrapper for MonthlySpend.
 *
 * Despite the operation name, the response is a daily series for the
 * current month (or comparison period). Each row carries `totalAmount`
 * (this period's spend on `date`) and `comparisonAmount` (same-day-of
 * prior-period spend, used by the web app for "vs last month" deltas).
 *
 * For dates beyond today, both `totalAmount` and `comparisonAmount` are
 * `null` — the response pads the full month with placeholder rows.
 * Filtering those out is the projection layer's job; this wrapper preserves
 * them verbatim so the cache can serve a faithful copy of the response.
 *
 * The captured query at docs/graphql-capture/operations/queries/MonthlySpend.md
 * exposes only `id`, `date`, `totalAmount`, `comparisonAmount` per row and
 * takes no variables. One round-trip per call; the SnapshotCache caches the
 * full set with a 1h TTL.
 */

import type { GraphQLClient } from '../client.js';
import { MONTHLY_SPEND } from '../operations.generated.js';

export interface DailySpendNode {
  id: string;
  date: string;
  totalAmount: string | null;
  comparisonAmount: string | null;
}

interface MonthlySpendResponse {
  monthlySpending: DailySpendNode[];
}

export async function fetchMonthlySpend(client: GraphQLClient): Promise<DailySpendNode[]> {
  const data = await client.query<Record<string, never>, MonthlySpendResponse>(
    'MonthlySpend',
    MONTHLY_SPEND,
    {}
  );
  return data.monthlySpending;
}
