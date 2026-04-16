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

/**
 * Caller-facing rule shape — amounts are strings at the MCP boundary
 * (consistent with setBudget). Converted to numbers at the wire layer
 * because the server's schema expects Float.
 */
export interface EditRecurringInputRule {
  nameContains?: string;
  minAmount?: string;
  maxAmount?: string;
  days?: number[];
}

export interface EditRecurringInput {
  state?: string;
  rule?: EditRecurringInputRule;
}

export interface EditRecurringChanges {
  state?: string;
  rule?: EditRecurringInputRule;
}

// Wire shape with amounts as numbers (what the GraphQL server expects).
interface EditRecurringWireRule {
  nameContains?: string;
  minAmount?: number;
  maxAmount?: number;
  days?: number[];
}

interface EditRecurringResponse {
  // Captured wire shape: editRecurring wraps a nested `recurring` object.
  // We deliberately do NOT select `rule { ... }` on the response (issue #288):
  // `RecurringRule.nameContains` is non-nullable in Copilot's schema but the
  // server returns null for recurrings matched by amount-only rules, which
  // made every EditRecurring call throw regardless of what we were updating.
  // `changed.rule` in the caller-facing result is now populated from the
  // caller's input rather than read back from the server.
  editRecurring: {
    recurring: {
      id: string;
      state: string;
    };
  };
}

function toFloatOrThrow(value: string, path: string): number {
  // parseFloat('10abc') returns 10; guard with a regex to require a clean decimal.
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`editRecurring: invalid ${path} ${value}`);
  }
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`editRecurring: invalid ${path} ${value}`);
  }
  return n;
}

export async function editRecurring(
  client: GraphQLClient,
  args: { id: string; input: EditRecurringInput }
): Promise<{ id: string; changed: EditRecurringChanges }> {
  // Convert MCP string amounts to wire Float. Keeps MCP contract stable;
  // matches what setBudget does for its amount field.
  const wireInput: { state?: string; rule?: EditRecurringWireRule } = {};
  if ('state' in args.input) wireInput.state = args.input.state;
  if ('rule' in args.input && args.input.rule) {
    const rule = args.input.rule;
    const wireRule: EditRecurringWireRule = {};
    if ('nameContains' in rule) wireRule.nameContains = rule.nameContains;
    if ('minAmount' in rule && rule.minAmount !== undefined) {
      wireRule.minAmount = toFloatOrThrow(rule.minAmount, 'rule.minAmount');
    }
    if ('maxAmount' in rule && rule.maxAmount !== undefined) {
      wireRule.maxAmount = toFloatOrThrow(rule.maxAmount, 'rule.maxAmount');
    }
    if ('days' in rule) wireRule.days = rule.days;
    wireInput.rule = wireRule;
  }

  const data = await client.mutate<
    { id: string; input: { state?: string; rule?: EditRecurringWireRule } },
    EditRecurringResponse
  >('EditRecurring', EDIT_RECURRING, { id: args.id, input: wireInput });
  const recurring = data.editRecurring.recurring;
  // Report back fields the caller named in args.input — keyed by presence,
  // not by value. The `state` echo uses the server-confirmed value; the
  // `rule` echo is the caller's input (see EditRecurring wire-shape comment
  // above — we intentionally don't read the rule back to sidestep the
  // non-nullable-nameContains server error). In practice tools.ts builds
  // args.input via conditional spread, so explicit-undefined shouldn't reach us.
  const changed: EditRecurringChanges = {};
  if ('state' in args.input) changed.state = recurring.state;
  if ('rule' in args.input && args.input.rule) {
    changed.rule = { ...args.input.rule };
  }
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
