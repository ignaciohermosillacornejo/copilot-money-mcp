/**
 * Per-input-type field-conformance check definitions (issue #436, Epic B #421).
 *
 * Each check bundles what `assertFieldConformance` needs for one GraphQL input
 * type: the type label, the declared field names under test, a known-bad
 * control field, and a `buildQuery` that inlines one field assignment into a
 * VALIDATION-ONLY probe (Technique 4, docs/graphql-capture/introspection-recon.md).
 *
 * Field lists are DERIVED FROM THE CONFORMANCE LEDGER (src/conformance/ledger.ts)
 * rather than re-typed here, so the probes and the ledger can never disagree
 * about what "covered" means: every `<InputType>.<field>` surface the ledger
 * marks gated-by-smoke is exactly what gets probed.
 *
 * Probe safety (rules of engagement, introspection-recon.md):
 *   - every id arg is the fake "x" — nothing real is addressed;
 *   - the probed field gets the value `{ z: 1 }`, which no scalar, enum,
 *     list, or input-object field accepts, so validation fails before any
 *     resolver runs;
 *   - where the input type has a second known field, a malformed sibling
 *     (`<sibling>: { z: 1 }`) is added as defense in depth (same pattern as
 *     the enum probes); single-field input types rely on the probed value
 *     alone, which is still validation-fatal;
 *   - `bulkEditTransactions` is NEVER probed — it reaches the data layer on
 *     empty input (see introspection-recon.md) and is permanently off-limits.
 */

import { CONFORMANCE_LEDGER } from '../../src/conformance/ledger.js';

export { assertFieldConformance, type FieldConformanceResult } from './_field-conformance.js';

/** Control field name — must not exist on ANY Copilot input type. */
export const KNOWN_BAD_FIELD = 'zzNotARealField';

/** A value no scalar, enum, list, or input-object field can accept. */
const BOGUS_VALUE = '{ z: 1 }';

export interface FieldConformanceCheck {
  /** Our local input-type name ('EditRecurringInput.rule' for the nested rule). */
  inputTypeName: string;
  fields: readonly string[];
  knownBadField: string;
  buildQuery: (fieldName: string) => string;
}

/**
 * Direct fields of `inputTypeName` recorded in the conformance ledger
 * (nested `a.b.c` surfaces belong to their own nested-type check).
 */
function ledgerFields(inputTypeName: string): readonly string[] {
  const prefix = `${inputTypeName}.`;
  const fields = CONFORMANCE_LEDGER.filter(
    (entry) => entry.kind === 'input-field' && entry.surface.startsWith(prefix)
  )
    .map((entry) => entry.surface.slice(prefix.length))
    .filter((rest) => !rest.includes('.'));
  if (fields.length === 0) {
    throw new Error(`No input-field ledger entries found for ${inputTypeName}`);
  }
  return fields;
}

/**
 * `<field>: { z: 1 }` plus the first sibling ≠ field, also malformed.
 * `siblings` lists known-existing fields of the type to draw the malformed
 * sibling from; empty for single-field input types (the probed value alone
 * still guarantees validation failure).
 */
function assignments(field: string, siblings: readonly string[]): string {
  const sibling = siblings.find((candidate) => candidate !== field);
  const probe = `${field}: ${BOGUS_VALUE}`;
  return sibling ? `${probe}, ${sibling}: ${BOGUS_VALUE}` : probe;
}

function check(
  inputTypeName: string,
  siblings: readonly string[],
  wrap: (fieldAssignments: string) => string
): FieldConformanceCheck {
  return {
    inputTypeName,
    fields: ledgerFields(inputTypeName),
    knownBadField: KNOWN_BAD_FIELD,
    buildQuery: (fieldName) => wrap(assignments(fieldName, siblings)),
  };
}

/**
 * All input-field conformance checks, in runner order. Covers the 11 input
 * types from #436 plus the nested EditRecurringInput.rule object.
 */
export const ALL_FIELD_CONFORMANCE_CHECKS: readonly FieldConformanceCheck[] = [
  // ----- Transactions -------------------------------------------------------
  check(
    'CreateTransactionInput',
    ['categoryId', 'name'],
    (a) => `mutation FieldProbe {
  createTransaction(itemId: "x", accountId: "x", input: { ${a} }) {
    __typename
  }
}`
  ),
  check(
    'EditTransactionInput',
    ['categoryId', 'name'],
    (a) => `mutation FieldProbe {
  editTransaction(itemId: "x", accountId: "x", id: "x", input: { ${a} }) {
    __typename
  }
}`
  ),
  check(
    'SplitTransactionInput',
    ['categoryId', 'name'],
    (a) => `mutation FieldProbe {
  splitTransaction(itemId: "x", accountId: "x", id: "x", input: [{ ${a} }]) {
    __typename
  }
}`
  ),
  // Single-field input type — no sibling exists; the probed value alone is
  // validation-fatal (ID/unknown-field both fail before execution).
  check(
    'AddTransactionToRecurringInput',
    [],
    (a) => `mutation FieldProbe {
  addTransactionToRecurring(itemId: "x", accountId: "x", id: "x", input: { ${a} }) {
    __typename
  }
}`
  ),

  // ----- Recurrings ---------------------------------------------------------
  check(
    'CreateRecurringInput',
    ['frequency', 'transaction'],
    (a) => `mutation FieldProbe {
  createRecurring(input: { ${a} }) {
    __typename
  }
}`
  ),
  check(
    'EditRecurringInput',
    ['frequency', 'state'],
    (a) => `mutation FieldProbe {
  editRecurring(id: "x", input: { ${a} }) {
    __typename
  }
}`
  ),
  // Nested rule object: probed field sits INSIDE rule; the malformed sibling
  // (`frequency: { z: 1 }`) sits at the outer level, so the request fails
  // validation even if every rule subfield were somehow accepted.
  check(
    'EditRecurringInput.rule',
    [],
    (a) => `mutation FieldProbe {
  editRecurring(id: "x", input: { rule: { ${a} }, frequency: ${BOGUS_VALUE} }) {
    __typename
  }
}`
  ),

  // ----- Categories ---------------------------------------------------------
  check(
    'CreateCategoryInput',
    ['isExcluded', 'name'],
    (a) => `mutation FieldProbe {
  createCategory(input: { ${a} }) {
    __typename
  }
}`
  ),
  check(
    'EditCategoryInput',
    ['isExcluded', 'name'],
    (a) => `mutation FieldProbe {
  editCategory(id: "x", input: { ${a} }) {
    __typename
  }
}`
  ),

  // ----- Tags ---------------------------------------------------------------
  check(
    'CreateTagInput',
    ['colorName', 'name'],
    (a) => `mutation FieldProbe {
  createTag(input: { ${a} }) {
    __typename
  }
}`
  ),
  check(
    'EditTagInput',
    ['colorName', 'name'],
    (a) => `mutation FieldProbe {
  editTag(id: "x", input: { ${a} }) {
    __typename
  }
}`
  ),

  // ----- Accounts -----------------------------------------------------------
  check(
    'EditAccountInput',
    ['isUserHidden', 'name'],
    (a) => `mutation FieldProbe {
  editAccount(itemId: "x", id: "x", input: { ${a} }) {
    __typename
  }
}`
  ),
];
