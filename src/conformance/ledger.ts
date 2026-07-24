/**
 * Conformance ledger (issue #435, Epic B #421).
 *
 * Machine-readable inventory of every assumption this codebase makes about
 * Copilot Money's external GraphQL surface — enum value sets, input-type
 * fields, operation signatures, and response shapes — together with the
 * oracle (if any) that re-verifies each assumption and the strongest class
 * of verification it currently has.
 *
 * Why: the 2026-06 write-field audit found that bugs lived in the gap
 * between our local model and Copilot's server reality, and nothing tracked
 * WHICH assumptions had independent verification. The ledger makes "we
 * forgot to verify" a red build instead of a silent state:
 *
 * - `tests/conformance/ledger.test.ts` (plain unit test — runs in cloud CI,
 *   no auth, no network) enforces that every param/enum reachable from
 *   `createWriteToolSchemas()` has a ledger entry, that every named smoke
 *   oracle maps to an existing `scripts/smoke/` script, and that `gated`
 *   entries carry a non-null oracle. A new write-tool param without a
 *   ledger entry fails the build.
 * - `bun run smoke` prints the class distribution at the end — the
 *   "are we getting better" number.
 *
 * Surface naming convention:
 * - `enum`           → GraphQL enum type name, e.g. `TransactionType`
 * - `input-field`    → `<InputType>.<field>`, e.g. `CreateTransactionInput.tagIds`
 *                      (nested input objects use `<InputType>.<field>.<subfield>`)
 * - `operation`      → `Mutation.<fieldName>` or `Query.<fieldName>`, e.g.
 *                      `Mutation.createTransaction`, `Query.accounts`
 *                      (covers the operation's existence + top-level args)
 * - `response-shape` → `Mutation.<fieldName>:response` / `Query.<fieldName>:response`
 * - `applies`        → `Mutation.<fieldName>:applies` — the mutation's effect
 *                      is actually persisted and visible on an independent
 *                      re-read (not just echoed). Verified by the Tier-2
 *                      round-trip smoke (B4, issue #438).
 *
 * How to update:
 * - Adding a write-tool param? Add (or extend) an entry whose `toolParams`
 *   includes the new `<tool>.<param>` path, classed `unverified` until a
 *   live probe or smoke gate exists.
 * - Landed a one-shot live probe? Upgrade the entry to `verified-once` and
 *   cite the PR in `evidence`.
 * - Landed a recurring verifier? Set `oracle` and upgrade to `gated`.
 */

import { TRANSACTION_TYPES } from '../core/graphql/transactions.js';
import { RECURRING_FREQUENCIES, RECURRING_STATE_VALUES } from '../core/graphql/recurrings.js';
import { COLOR_NAMES } from '../core/graphql/colors.js';
import { ALL_TIME_FRAMES } from '../core/graphql/queries/_shared.js';
import {
  RESPONSE_SHAPE_RUNTIME_CHECK,
  RUNTIME_CHECK_NAMES,
} from '../core/graphql/response-validation.js';
import { TRANSACTIONS_READ_SHAPE_RUNTIME_CHECK } from '../core/graphql/read-validation.js';
import { READ_RESPONSE_SHAPE_RUNTIME_CHECK } from '../core/graphql/read-response-validation.js';
export { RUNTIME_CHECK_NAMES };

/** What kind of external surface the assumption is about. */
export const SURFACE_KINDS = [
  'enum',
  'input-field',
  'response-shape',
  'operation',
  'applies',
] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/**
 * Verification classes, strongest first:
 * - `gated`         — a recurring oracle re-verifies the assumption; drift
 *                     turns a build/smoke run red. Requires a non-null oracle.
 * - `verified-once` — independently verified against production at least
 *                     once (cite the probe in `evidence`), but nothing
 *                     re-checks it; the server can drift silently.
 * - `unverified`    — transcribed from captures/recon and never confirmed
 *                     by an independent probe.
 */
export const CONFORMANCE_CLASSES = ['gated', 'verified-once', 'unverified'] as const;
export type ConformanceClass = (typeof CONFORMANCE_CLASSES)[number];

/**
 * Recurring oracle that re-verifies an assumption.
 * - `smoke:<name>`   → `scripts/smoke/<name>.ts` (existence enforced by the
 *                      ledger test; runs locally pre-push, needs auth)
 * - `runtime:<name>` → an always-on runtime check; `<name>` must be
 *                      registered in `RUNTIME_CHECK_NAMES` (existence
 *                      enforced by the ledger test, same as smoke scripts)
 */
export type ConformanceOracle = `smoke:${string}` | `runtime:${string}`;

/**
 * Registered always-on runtime checks that `runtime:<name>` oracles may
 * reference. Defined in src/core/graphql/response-validation.ts and
 * re-exported here for backward compatibility.
 * - `zod-warn` (B3, #437): every mutation response is validated warn-mode
 *   against a Zod schema mirroring the hand-written response interface;
 *   drift logs a structured warning and increments a per-surface counter.
 * - `transactions-read-shape` (#512): per-node Zod validation for the
 *   Transactions read query; invalid nodes are dropped, counted, and
 *   surfaced via _dropped_invalid_rows.
 */
// RUNTIME_CHECK_NAMES is imported from response-validation.ts and re-exported above.

export interface LedgerEntry {
  /** External assumption surface (see naming convention above). Unique. */
  surface: string;
  kind: SurfaceKind;
  /** Recurring oracle that re-verifies this assumption, or null if none. */
  oracle: ConformanceOracle | null;
  class: ConformanceClass;
  /** Human-readable evidence trail, e.g. 'PR #418 live probe, 2026-06-08'. */
  evidence: string;
  /**
   * MCP write-tool parameter paths that exercise this surface, e.g.
   * 'create_transaction.type' or 'split_transaction.splits[].amount'.
   * The ledger test checks these bidirectionally against
   * `createWriteToolSchemas()`: every reachable param must appear in some
   * entry, and every listed path must still exist (no stale entries).
   */
  toolParams?: readonly string[];
  /**
   * For `kind: 'enum'`: the exact value set assumed locally. The ledger
   * test matches every `enum:` array found in the write-tool schemas
   * against one of these sets, so an enum surface can never be added to a
   * tool schema without a ledger entry.
   */
  values?: readonly string[];
}

// ---------------------------------------------------------------------------
// Shared evidence strings
// ---------------------------------------------------------------------------

/** 2026-06 write-field audit: live validation probes mapped which input
 * fields each mutation really accepts (and which it rejects). */
const WRITE_FIELD_AUDIT =
  'Write-field audit live probes, PR #414/#417/#418/#420 lineage (2026-06-08)';

/** Every GraphQL wrapper PR runs a live smoke script before merge (repo
 * policy); the operation signature was exercised against production then. */
const SHIPPED_WITH_LIVE_SMOKE =
  'Operation exercised against production by the live smoke run in its shipping PR ' +
  '(scripts/smoke/, per-PR smoke policy) and the #414/#417/#418/#420 audit lineage';

/** B2 (#436): per-field name probes with an unknown-field control, run by
 * the recurring smoke gate. Builds on the write-field audit lineage. */
const FIELD_PROBE_GATED =
  'Write-field audit lineage (PR #414/#417/#418/#420) + per-field name probe with ' +
  'unknown-field control; gated by scripts/smoke/conformance.ts (issue #436, PR #456)';

/** B3 (#437): response-shape interfaces are mirrored into Zod schemas and
 * every live mutation response is validated against them warn-mode, so
 * drift surfaces as a structured warning + counter instead of downstream
 * undefineds. */
const RESPONSE_SHAPE_GATED =
  'Hand-written TS interface mirrored into a Zod schema; every mutation response ' +
  'is validated warn-mode at runtime (src/core/graphql/response-validation.ts, ' +
  'issue #437, PR #467)';

/** B5 (#439): every read query is fired against production on each smoke
 * run, asserting the wrapper-critical fields. Gates the operation
 * signature; the full response interface stays a separate surface. */
const READ_SMOKE_GATED =
  'Tier-0 read smoke fires the operation against production and asserts the ' +
  'wrapper-critical fields on every run; gated by scripts/smoke/reads.ts ' +
  '(issues #439/#460)';

/** B4 (#438): one reversible round-trip per write tool — every write is
 * re-read through the corresponding query after mutating (create→verify→
 * delete or set→verify→revert), so an accepted-but-ignored write turns the
 * run red. MUTATING — maintainer-run attended gate, never scheduled. */
const ROUNDTRIP_GATED =
  'Reversible round-trip smoke: write, then verify by independent re-read, then ' +
  'delete/revert; gated by scripts/smoke/roundtrip.ts (issue #438). ' +
  'tests/scripts/roundtrip-coverage.test.ts ratchets the write-tool ↔ round-trip bijection';

/** #537: read response-shape interfaces are mirrored into looseObject Zod
 * schemas and every live read response is validated warn-mode at runtime, so
 * drift surfaces as a structured warning + per-surface counter instead of
 * downstream undefineds. Read analogue of RESPONSE_SHAPE_GATED. */
const READ_RESPONSE_SHAPE_GATED =
  'Hand-written TS response interface mirrored into a looseObject Zod schema; every ' +
  'live read response is validated warn-mode at runtime ' +
  '(src/core/graphql/read-response-validation.ts, issue #537)';

// ---------------------------------------------------------------------------
// Entry factories (keep the inventory compact; pass overrides to upgrade an
// entry's class/oracle/evidence as verification lands)
// ---------------------------------------------------------------------------

function operation(
  name: string,
  toolParams?: readonly string[],
  overrides?: Partial<LedgerEntry>
): LedgerEntry {
  return {
    surface: `Mutation.${name}`,
    kind: 'operation',
    oracle: null,
    class: 'verified-once',
    evidence: SHIPPED_WITH_LIVE_SMOKE,
    ...(toolParams && toolParams.length > 0 ? { toolParams } : {}),
    ...overrides,
  };
}

function inputField(
  surface: string,
  toolParams?: readonly string[],
  overrides?: Partial<LedgerEntry>
): LedgerEntry {
  return {
    surface,
    kind: 'input-field',
    oracle: null,
    class: 'verified-once',
    evidence: WRITE_FIELD_AUDIT,
    ...(toolParams && toolParams.length > 0 ? { toolParams } : {}),
    ...overrides,
  };
}

/**
 * An input-field whose NAME is re-verified on every smoke run by the B2
 * field-name probes (scripts/smoke/field-conformance-checks.ts). The probe
 * gates the field's existence on the server input type — value semantics
 * are still only as strong as the write-field audit.
 */
function gatedInputField(surface: string, toolParams?: readonly string[]): LedgerEntry {
  return inputField(surface, toolParams, {
    oracle: 'smoke:conformance',
    class: 'gated',
    evidence: FIELD_PROBE_GATED,
  });
}

/**
 * A mutation whose persisted effect is re-verified by the Tier-2 round-trip
 * smoke (B4, #438): the round-trip writes, RE-READS the object through the
 * corresponding query, and asserts the written values are visible — then
 * deletes/reverts. `name` is the Mutation field, e.g. 'createTransaction'.
 */
function appliesSurface(name: string): LedgerEntry {
  return {
    surface: `Mutation.${name}:applies`,
    kind: 'applies',
    oracle: 'smoke:roundtrip',
    class: 'gated',
    evidence: ROUNDTRIP_GATED,
  };
}

function responseShape(name: string, overrides?: Partial<LedgerEntry>): LedgerEntry {
  return {
    surface: `Mutation.${name}:response`,
    kind: 'response-shape',
    oracle: `runtime:${RESPONSE_SHAPE_RUNTIME_CHECK}`,
    class: 'gated',
    evidence: RESPONSE_SHAPE_GATED,
    ...overrides,
  };
}

/**
 * A read query whose operation signature is re-fired against production by
 * the Tier-0 read smoke on every run (issues #439/#460). `name` is the root
 * Query field, e.g. 'accounts'. The companion `gatedQueryResponseShape` entry
 * tracks the hand-written response interface separately — every read
 * response shape is now either runtime-gated via `read-zod-warn` (#537) or,
 * for Query.transactions:response, via the transactions-read-shape check
 * (#512).
 */
function queryOperation(name: string): LedgerEntry {
  return {
    surface: `Query.${name}`,
    kind: 'operation',
    oracle: 'smoke:reads',
    class: 'gated',
    evidence: READ_SMOKE_GATED,
  };
}

/**
 * A read query whose response shape is validated warn-mode at runtime by the
 * read-side Zod registry (#537). Read analogue of `responseShape` for
 * mutations. `name` is the root Query field, e.g. 'accounts'. Every name
 * passed here MUST have a matching QUERY_RESPONSE_SCHEMAS entry — enforced
 * bidirectionally by tests/conformance/ledger.test.ts.
 */
function gatedQueryResponseShape(name: string): LedgerEntry {
  return {
    surface: `Query.${name}:response`,
    kind: 'response-shape',
    oracle: `runtime:${READ_RESPONSE_SHAPE_RUNTIME_CHECK}`,
    class: 'gated',
    evidence: READ_RESPONSE_SHAPE_GATED,
  };
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export const CONFORMANCE_LEDGER: readonly LedgerEntry[] = [
  // ----- Enums ------------------------------------------------------------
  {
    surface: 'TransactionType',
    kind: 'enum',
    oracle: 'smoke:conformance',
    class: 'gated',
    evidence:
      'Per-value live probes + invalid-value control; gated by scripts/smoke/conformance.ts (issue #421, PR #422)',
    values: TRANSACTION_TYPES,
    toolParams: ['create_transaction.type', 'update_transaction.type'],
  },
  {
    surface: 'RecurringFrequency',
    kind: 'enum',
    oracle: 'smoke:conformance',
    class: 'gated',
    evidence:
      'All 8 values verified against production (issue #419); gated by scripts/smoke/conformance.ts (issue #421, PR #422)',
    values: RECURRING_FREQUENCIES,
    toolParams: ['create_recurring.frequency', 'update_recurring.frequency'],
  },
  {
    surface: 'RecurringState',
    kind: 'enum',
    oracle: 'smoke:conformance',
    class: 'gated',
    evidence:
      'Per-value live probes + invalid-value control; gated by scripts/smoke/conformance.ts (issue #421, PR #422)',
    values: RECURRING_STATE_VALUES,
    toolParams: ['set_recurring_state.state', 'update_recurring.state'],
  },
  {
    surface: 'TimeFrame',
    kind: 'enum',
    oracle: 'smoke:conformance',
    class: 'gated',
    evidence:
      'Per-value live probes (all 7 values accepted, YEAR control rejected, 2026-06-11); ' +
      'gated by scripts/smoke/conformance.ts (issue #439)',
    values: ALL_TIME_FRAMES,
    // Read-side only (live-reads tools); not reachable from write schemas.
    // If TimeFrame is ever added to a write tool, add `toolParams` to THIS
    // entry (don't create a duplicate) so the enum matcher in the ledger
    // test resolves to it.
  },
  {
    surface: 'ColorName',
    kind: 'enum',
    oracle: 'smoke:conformance',
    class: 'gated',
    evidence:
      'Value set discovered by error-leak harvesting (40-base × 5-suffix sweep converged on ' +
      '16 values, "Did you mean" suggestions matched exactly, 2026-06-11); gated by ' +
      'scripts/smoke/conformance.ts (issue #439)',
    values: COLOR_NAMES,
    toolParams: [
      'create_tag.color_name',
      'update_tag.color_name',
      'create_category.color_name',
      'update_category.color_name',
    ],
  },

  // ----- Transactions -----------------------------------------------------
  operation('createTransaction', ['create_transaction.account_id', 'create_transaction.item_id']),
  gatedInputField('CreateTransactionInput.name', ['create_transaction.name']),
  gatedInputField('CreateTransactionInput.date', ['create_transaction.date']),
  gatedInputField('CreateTransactionInput.amount', ['create_transaction.amount']),
  gatedInputField('CreateTransactionInput.categoryId', ['create_transaction.category_id']),
  gatedInputField('CreateTransactionInput.type', ['create_transaction.type']),
  gatedInputField('CreateTransactionInput.tagIds', ['create_transaction.tag_ids']),
  gatedInputField('CreateTransactionInput.userNotes', ['create_transaction.note']),
  gatedInputField('CreateTransactionInput.recurringId', ['create_transaction.recurring_id']),
  responseShape('createTransaction'),
  appliesSurface('createTransaction'),

  operation('editTransaction', [
    'update_transaction.transaction_id',
    'update_transaction.account_id',
    'update_transaction.item_id',
    'review_transactions.transaction_ids',
    'review_transactions.rows',
    'review_transactions.rows[].transaction_id',
    'review_transactions.rows[].account_id',
    'review_transactions.rows[].item_id',
  ]),
  gatedInputField('EditTransactionInput.name', ['update_transaction.name']),
  gatedInputField('EditTransactionInput.categoryId', ['update_transaction.category_id']),
  gatedInputField('EditTransactionInput.userNotes', ['update_transaction.note']),
  gatedInputField('EditTransactionInput.tagIds', ['update_transaction.tag_ids']),
  gatedInputField('EditTransactionInput.isReviewed', [
    'review_transactions.reviewed',
    'update_transaction.reviewed',
  ]),
  gatedInputField('EditTransactionInput.type', ['update_transaction.type']),
  responseShape('editTransaction'),
  appliesSurface('editTransaction'),
  {
    surface: 'Mutation.editTransaction:routing',
    kind: 'operation',
    oracle: null,
    class: 'verified-once',
    evidence:
      'Live probe 2026-07-05: EditTransaction validates the full (id, accountId, itemId) ' +
      'binding, not mere existence — fabricated accountId → "accountId … Not Found"; ' +
      'real-but-wrong pair → "Transaction not found" (server scopes the txn lookup under ' +
      'account/item); correct pair → edit applied. Routing ids therefore cannot be ' +
      'defaulted or faked; the true pair must come from resolveTransactionMeta or, on the ' +
      'out-of-window bypass paths, from the caller (update_transaction account_id/item_id or ' +
      'review_transactions rows entries, taken from a live read) — a wrong pair fails loudly ' +
      'either way.',
  },

  operation('deleteTransaction', [
    'delete_transaction.transaction_id',
    'delete_transaction.account_id',
    'delete_transaction.item_id',
  ]),
  responseShape('deleteTransaction'),
  appliesSurface('deleteTransaction'),

  operation('addTransactionToRecurring', [
    'add_transaction_to_recurring.transaction_id',
    'add_transaction_to_recurring.account_id',
    'add_transaction_to_recurring.item_id',
  ]),
  gatedInputField('AddTransactionToRecurringInput.recurringId', [
    'add_transaction_to_recurring.recurring_id',
  ]),
  responseShape('addTransactionToRecurring'),
  appliesSurface('addTransactionToRecurring'),

  operation('splitTransaction', [
    'split_transaction.transaction_id',
    'split_transaction.account_id',
    'split_transaction.item_id',
    'split_transaction.splits', // the [SplitTransactionInput!]! list arg itself
  ]),
  gatedInputField('SplitTransactionInput.name', ['split_transaction.splits[].name']),
  gatedInputField('SplitTransactionInput.date', ['split_transaction.splits[].date']),
  gatedInputField('SplitTransactionInput.amount', ['split_transaction.splits[].amount']),
  gatedInputField('SplitTransactionInput.categoryId', ['split_transaction.splits[].category_id']),
  responseShape('splitTransaction'),
  appliesSurface('splitTransaction'),
  {
    surface: 'Mutation.splitTransaction:sum',
    kind: 'operation',
    oracle: null,
    class: 'verified-once',
    evidence:
      'Live probe 2026-07-23 (PR #570 review): wrong-sum split (5 + 4 on a 10 parent) ' +
      'rejected — "Split amounts (9) must sum to parent amount (10)"; matching-sum control ' +
      'on the same parent succeeded, so the rejection is sum-caused, not a formation error. ' +
      'Confirms the error-leak recon (docs/graphql-capture/hidden-mutations.md, ' +
      'SplitTransactionInput.amount). Load-bearing for the out-of-window split bypass, which ' +
      'skips the client-side sum check and leaves the server as the sole enforcer on that path.',
  },

  // ----- Tags ---------------------------------------------------------------
  // No top-level args beyond the input object (covered by CreateTagInput.*).
  operation('createTag'),
  gatedInputField('CreateTagInput.name', ['create_tag.name']),
  gatedInputField('CreateTagInput.colorName', ['create_tag.color_name']),
  responseShape('createTag'),
  appliesSurface('createTag'),

  operation('editTag', ['update_tag.tag_id']),
  gatedInputField('EditTagInput.name', ['update_tag.name']),
  gatedInputField('EditTagInput.colorName', ['update_tag.color_name']),
  responseShape('editTag'),
  appliesSurface('editTag'),

  operation('deleteTag', ['delete_tag.tag_id']),
  responseShape('deleteTag'),
  appliesSurface('deleteTag'),

  // ----- Categories ---------------------------------------------------------
  // No top-level args beyond the input object (covered by CreateCategoryInput.*).
  operation('createCategory'),
  gatedInputField('CreateCategoryInput.name', ['create_category.name']),
  gatedInputField('CreateCategoryInput.colorName', ['create_category.color_name']),
  gatedInputField('CreateCategoryInput.emoji', ['create_category.emoji']),
  gatedInputField('CreateCategoryInput.isExcluded', ['create_category.is_excluded']),
  responseShape('createCategory'),
  appliesSurface('createCategory'),

  operation('editCategory', ['update_category.category_id']),
  gatedInputField('EditCategoryInput.name', ['update_category.name']),
  gatedInputField('EditCategoryInput.colorName', ['update_category.color_name']),
  gatedInputField('EditCategoryInput.emoji', ['update_category.emoji']),
  gatedInputField('EditCategoryInput.isExcluded', ['update_category.is_excluded']),
  responseShape('editCategory'),
  appliesSurface('editCategory'),

  operation('deleteCategory', ['delete_category.category_id']),
  responseShape('deleteCategory'),
  appliesSurface('deleteCategory'),

  // ----- Budgets ------------------------------------------------------------
  // The single set_budget MCP tool fans out to one of two mutations
  // (editCategoryBudgetMonthly when `month` is given, editCategoryBudget
  // otherwise), so set_budget.category_id / set_budget.amount are
  // intentionally claimed by BOTH operations' entries. Note the coverage
  // consequence: deleting one entry would not fail the param-coverage test
  // (the other still claims the paths) — it would only fail the
  // unique-surface inventory expectations downstream.
  operation('editCategoryBudget', ['set_budget.category_id']),
  // Budget input types are field-probed by smoke:conformance (validation-only,
  // Technique 4). The mutations return a scalar Boolean, so the probes carry no
  // selection set — see the Budgets section of field-conformance-checks.ts.
  gatedInputField('EditCategoryBudgetInput.amount', ['set_budget.amount']),
  responseShape('editCategoryBudget'),
  appliesSurface('editCategoryBudget'),

  operation('editCategoryBudgetMonthly', ['set_budget.category_id']),
  gatedInputField('EditCategoryBudgetMonthlyInput.amount', ['set_budget.amount']),
  gatedInputField('EditCategoryBudgetMonthlyInput.month', ['set_budget.month']),
  responseShape('editCategoryBudgetMonthly'),
  appliesSurface('editCategoryBudgetMonthly'),

  // ----- Recurrings ---------------------------------------------------------
  // No top-level args beyond the input object (covered by CreateRecurringInput.*).
  operation('createRecurring'),
  gatedInputField('CreateRecurringInput.frequency', ['create_recurring.frequency']),
  gatedInputField('CreateRecurringInput.transaction', ['create_recurring.transaction_id']),
  responseShape('createRecurring'),
  appliesSurface('createRecurring'),

  operation('editRecurring', ['set_recurring_state.recurring_id', 'update_recurring.recurring_id']),
  gatedInputField('EditRecurringInput.name', ['update_recurring.name']),
  gatedInputField('EditRecurringInput.categoryId', ['update_recurring.category_id']),
  gatedInputField('EditRecurringInput.frequency', ['update_recurring.frequency']),
  gatedInputField('EditRecurringInput.state', [
    'set_recurring_state.state',
    'update_recurring.state',
  ]),
  gatedInputField('EditRecurringInput.rule', ['update_recurring.rule']),
  gatedInputField('EditRecurringInput.rule.nameContains', ['update_recurring.rule.name_contains']),
  gatedInputField('EditRecurringInput.rule.minAmount', ['update_recurring.rule.min_amount']),
  gatedInputField('EditRecurringInput.rule.maxAmount', ['update_recurring.rule.max_amount']),
  gatedInputField('EditRecurringInput.rule.days', ['update_recurring.rule.days']),
  responseShape('editRecurring'),
  appliesSurface('editRecurring'),

  operation('deleteRecurring', ['delete_recurring.recurring_id']),
  responseShape('deleteRecurring'),
  appliesSurface('deleteRecurring'),

  // ----- Accounts -----------------------------------------------------------
  // editAccount has a GraphQL wrapper (src/core/graphql/accounts.ts) but no
  // MCP write tool yet, so no toolParams. Tracked here because the wrapper's
  // assumptions are still external assumptions.
  operation('editAccount'),
  gatedInputField('EditAccountInput.name'),
  gatedInputField('EditAccountInput.isUserHidden'),
  responseShape('editAccount'),
  // No `applies` entry for editAccount: there is no MCP write tool for it,
  // so the B4 round-trip suite (one round-trip PER WRITE TOOL) does not
  // cover the wrapper. Add appliesSurface('editAccount') + a round-trip
  // check when an update_account tool ships.

  // ----- Read queries (issues #439/#460) -------------------------------------
  // One operation + one response-shape entry per QUERY in
  // operations.generated.ts, named by root Query field.
  // `tests/scripts/read-smoke-coverage.test.ts` enforces this list stays in
  // lockstep with the generated operations AND with the Tier-0 read smoke
  // checks (scripts/smoke/read-checks.ts) — a new query cannot ship without
  // both a smoke check and these entries.
  queryOperation('user'),
  gatedQueryResponseShape('user'),
  queryOperation('accounts'),
  gatedQueryResponseShape('accounts'),
  // Singular Account: generated document exists but has no hand-written
  // wrapper; the read smoke probes the document directly.
  queryOperation('account'),
  gatedQueryResponseShape('account'),
  queryOperation('transactions'),
  {
    surface: 'Query.transactions:response',
    kind: 'response-shape',
    oracle: `runtime:${TRANSACTIONS_READ_SHAPE_RUNTIME_CHECK}`,
    class: 'gated',
    evidence:
      'Per-node Zod validation at fetchTransactionsPage (warn-and-skip, #512): ' +
      'invalid nodes are dropped from rows and all cache/index feeds, counted, and ' +
      'surfaced via _dropped_invalid_rows + a deduped stderr warning.',
  },
  queryOperation('categories'),
  gatedQueryResponseShape('categories'),
  queryOperation('tags'),
  gatedQueryResponseShape('tags'),
  queryOperation('recurrings'),
  gatedQueryResponseShape('recurrings'),
  queryOperation('unpaidUpcomingRecurrings'),
  gatedQueryResponseShape('unpaidUpcomingRecurrings'),
  queryOperation('monthlySpending'),
  gatedQueryResponseShape('monthlySpending'),
  queryOperation('networthHistory'),
  gatedQueryResponseShape('networthHistory'),
  queryOperation('accountBalanceHistory'),
  gatedQueryResponseShape('accountBalanceHistory'),
  queryOperation('holdings'),
  gatedQueryResponseShape('holdings'),
  queryOperation('aggregatedHoldings'),
  gatedQueryResponseShape('aggregatedHoldings'),
  queryOperation('investmentBalance'),
  gatedQueryResponseShape('investmentBalance'),
  queryOperation('investmentLiveBalance'),
  gatedQueryResponseShape('investmentLiveBalance'),
  queryOperation('investmentAllocation'),
  gatedQueryResponseShape('investmentAllocation'),
  queryOperation('topMovers'),
  gatedQueryResponseShape('topMovers'),
  queryOperation('securityPrices'),
  gatedQueryResponseShape('securityPrices'),
  queryOperation('securityPricesHighFrequency'),
  gatedQueryResponseShape('securityPricesHighFrequency'),
];

// ---------------------------------------------------------------------------
// Class distribution — the "are we getting better" number
// ---------------------------------------------------------------------------

export function classDistribution(
  entries: readonly LedgerEntry[] = CONFORMANCE_LEDGER
): Record<ConformanceClass, number> {
  const dist: Record<ConformanceClass, number> = { gated: 0, 'verified-once': 0, unverified: 0 };
  for (const entry of entries) dist[entry.class] += 1;
  return dist;
}

/** Multi-line human-readable distribution, printed at the end of `bun run smoke`. */
export function formatClassDistribution(
  entries: readonly LedgerEntry[] = CONFORMANCE_LEDGER
): string {
  const dist = classDistribution(entries);
  const total = entries.length;
  const width = Math.max(...CONFORMANCE_CLASSES.map((c) => c.length));
  const lines = CONFORMANCE_CLASSES.map((cls) => {
    const count = dist[cls];
    const pct = total === 0 ? 0 : Math.round((count / total) * 100);
    return `  ${cls.padEnd(width)}  ${String(count).padStart(3)}  (${pct}%)`;
  });
  return [`[ledger] Conformance class distribution (${total} surfaces):`, ...lines].join('\n');
}
