/**
 * GraphQL query wrapper for MonthlySpend.
 *
 * Despite the operation name, the response is a daily series for the
 * current month. Each row carries `totalAmount` — CUMULATIVE month-to-date
 * non-recurring spend, see src/tools/live/monthly-spend.ts for the measured
 * semantics (#823) — and `comparisonAmount`, whose meaning is unconfirmed.
 *
 * For dates beyond today the response pads the full month with placeholder
 * rows (captured with both `totalAmount` and `comparisonAmount` null).
 * Filtering them out — every row with no `totalAmount` — is the projection
 * layer's job; this wrapper preserves
 * them verbatim so the cache can serve a faithful copy of the response.
 *
 * The captured query at docs/graphql-capture/operations/queries/MonthlySpend.md
 * exposes only `id`, `date`, `totalAmount`, `comparisonAmount` per row and
 * takes no variables. One round-trip per call; the SnapshotCache caches the
 * full set with a 1h TTL.
 */

import { z } from 'zod';
import type { GraphQLClient } from '../client.js';
import { MONTHLY_SPEND } from '../operations.generated.js';

export interface DailySpendNode {
  id: string;
  date: string;
  totalAmount: number | null;
  comparisonAmount: number | null;
}

export interface MonthlySpendResponse {
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

/** Zod mirror of `MonthlySpendResponse` (#537). totalAmount/comparisonAmount
 * are numbers on the wire (interface previously mislabeled them string;
 * probe-confirmed 2026-07-17). */
export const MonthlySpendResponseSchema = z.looseObject({
  monthlySpending: z.array(
    z.looseObject({
      id: z.string(),
      date: z.string(),
      totalAmount: z.number().nullable(),
      comparisonAmount: z.number().nullable(),
    })
  ),
});
