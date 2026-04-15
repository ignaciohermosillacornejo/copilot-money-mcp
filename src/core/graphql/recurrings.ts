import type { GraphQLClient } from './client.js';
import { CREATE_RECURRING, EDIT_RECURRING, DELETE_RECURRING } from './operations.generated.js';

export interface CreateRecurringInput {
  frequency: string;
  transaction: { accountId: string; itemId: string; transactionId: string };
}

interface CreateRecurringResponse {
  createRecurring: {
    id: string;
    name: string;
    state: string;
    frequency: string;
  };
}

export async function createRecurring(
  client: GraphQLClient,
  args: { input: CreateRecurringInput }
): Promise<{ id: string; name: string; state: string; frequency: string }> {
  const data = await client.mutate<{ input: CreateRecurringInput }, CreateRecurringResponse>(
    'CreateRecurring',
    CREATE_RECURRING,
    args
  );
  return {
    id: data.createRecurring.id,
    name: data.createRecurring.name,
    state: data.createRecurring.state,
    frequency: data.createRecurring.frequency,
  };
}

export interface EditRecurringInput {
  state?: string;
  rule?: { nameContains?: string; minAmount?: string; maxAmount?: string; days?: number[] };
}

export interface EditRecurringChanges {
  state?: string;
  rule?: EditRecurringInput['rule'];
}

interface EditRecurringResponse {
  // Captured wire shape: editRecurring wraps a nested `recurring` object.
  editRecurring: {
    recurring: {
      id: string;
      state: string;
      rule?: EditRecurringInput['rule'];
    };
  };
}

export async function editRecurring(
  client: GraphQLClient,
  args: { id: string; input: EditRecurringInput }
): Promise<{ id: string; changed: EditRecurringChanges }> {
  const data = await client.mutate<
    { id: string; input: EditRecurringInput },
    EditRecurringResponse
  >('EditRecurring', EDIT_RECURRING, args);
  const recurring = data.editRecurring.recurring;
  // Report back fields the caller named in args.input — keyed by presence,
  // not by value. Lets callers explicitly "change to undefined" if ever needed;
  // tools.ts builds args.input via conditional spread so explicit-undefined
  // shouldn't normally reach us.
  const changed: EditRecurringChanges = {};
  if ('state' in args.input) changed.state = recurring.state;
  if ('rule' in args.input) changed.rule = recurring.rule;
  return { id: recurring.id, changed };
}

export async function deleteRecurring(
  client: GraphQLClient,
  args: { id: string }
): Promise<{ id: string; deleted: true }> {
  // Note: variable is named `deleteRecurringId`, not `id` — preserved from captured wire shape.
  await client.mutate<{ deleteRecurringId: string }, { deleteRecurring: boolean }>(
    'DeleteRecurring',
    DELETE_RECURRING,
    { deleteRecurringId: args.id }
  );
  return { id: args.id, deleted: true };
}
