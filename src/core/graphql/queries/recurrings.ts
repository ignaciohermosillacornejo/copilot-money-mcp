/**
 * GraphQL query wrapper for Recurrings.
 *
 * Returns a flat list — Copilot's Recurrings query takes a $filter arg
 * (RecurringFilter), but we always pass null (server defaults to all
 * user-confirmed recurrings). One round-trip per call; the SnapshotCache
 * caches the full set with a 6h TTL.
 *
 * The captured query at docs/graphql-capture/operations/queries/Recurrings.md
 * exposes id, name, state, frequency, nextPaymentAmount, nextPaymentDate,
 * categoryId, emoji, icon, plus embedded rule + payments. The category
 * fragment is @client-only and stripped by the generator.
 */

import { z } from 'zod';
import type { GraphQLClient } from '../client.js';
import { RECURRINGS } from '../operations.generated.js';

export interface RecurringIcon {
  __typename: 'EmojiUnicode' | 'Genmoji';
  unicode?: string;
  id?: string;
  src?: string;
}

export interface RecurringRuleNode {
  nameContains: string | null;
  minAmount: number | null;
  maxAmount: number | null;
  days: number[] | null;
}

export interface RecurringPaymentNode {
  amount: number;
  isPaid: boolean;
  date: string;
}

export interface RecurringNode {
  id: string;
  name: string;
  state: string;
  frequency: string;
  nextPaymentAmount: number | null;
  nextPaymentDate: string | null;
  categoryId: string | null;
  emoji: string | null;
  icon: RecurringIcon | null;
  rule: RecurringRuleNode | null;
  payments: RecurringPaymentNode[];
}

export interface RecurringsResponse {
  recurrings: RecurringNode[];
}

interface RecurringsVariables {
  filter: null;
}

export async function fetchRecurrings(client: GraphQLClient): Promise<RecurringNode[]> {
  const data = await client.query<RecurringsVariables, RecurringsResponse>(
    'Recurrings',
    RECURRINGS,
    { filter: null }
  );
  return data.recurrings;
}

/** Shared EmojiUnicode|Genmoji icon shape. `__typename` permissive so a new
 * icon variant doesn't warn; optional subfields mirror RecurringIcon. */
const RecurringIconSchema = z.looseObject({
  __typename: z.string(),
  unicode: z.string().optional(),
  id: z.string().optional(),
  src: z.string().optional(),
});

/** Zod mirror of `RecurringNode` (RecurringFields + rule + payments), shared
 * by the Recurrings and UpcomingRecurrings queries (#537). */
export const RecurringNodeSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  frequency: z.string(),
  nextPaymentAmount: z.number().nullable(),
  nextPaymentDate: z.string().nullable(),
  categoryId: z.string().nullable(),
  emoji: z.string().nullable(),
  icon: RecurringIconSchema.nullable(),
  rule: z
    .looseObject({
      nameContains: z.string().nullable(),
      minAmount: z.number().nullable(),
      maxAmount: z.number().nullable(),
      days: z.array(z.number()).nullable(),
    })
    .nullable(),
  payments: z.array(
    z.looseObject({
      amount: z.number(),
      isPaid: z.boolean(),
      date: z.string(),
    })
  ),
});

/** Zod mirror of `RecurringsResponse`. */
export const RecurringsResponseSchema = z.looseObject({
  recurrings: z.array(RecurringNodeSchema),
});
