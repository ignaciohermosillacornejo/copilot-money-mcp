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
 * - `operation`      → `Mutation.<fieldName>`, e.g. `Mutation.createTransaction`
 *                      (covers the operation's existence + top-level args)
 * - `response-shape` → `Mutation.<fieldName>:response`
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
import { ALL_TIME_FRAMES } from '../core/graphql/queries/_shared.js';

/** What kind of external surface the assumption is about. */
export const SURFACE_KINDS = ['enum', 'input-field', 'response-shape', 'operation'] as const;
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
 * reference. Empty until B3 (#437) lands the zod warn-mode response
 * validators; B3 should register e.g. 'zod-warn' here when it ships.
 */
export const RUNTIME_CHECK_NAMES: readonly string[] = [];

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

/** Response-shape interfaces are hand-written mirrors of captured
 * responses; nothing validates live responses against them at runtime. */
const RESPONSE_SHAPE_UNVERIFIED =
  'Hand-written TS interface mirrors captured responses; no runtime schema ' +
  'validation, drift would surface only as downstream undefineds';

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

function responseShape(name: string, overrides?: Partial<LedgerEntry>): LedgerEntry {
  return {
    surface: `Mutation.${name}:response`,
    kind: 'response-shape',
    oracle: null,
    class: 'unverified',
    evidence: RESPONSE_SHAPE_UNVERIFIED,
    ...overrides,
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
    toolParams: ['create_transaction.type'],
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
    oracle: null,
    class: 'unverified',
    evidence:
      'String union transcribed from web-app captures (src/core/graphql/queries/_shared.ts); per-operation server validation never probed',
    values: ALL_TIME_FRAMES,
    // Read-side only (live-reads tools); not reachable from write schemas.
    // If TimeFrame is ever added to a write tool, add `toolParams` to THIS
    // entry (don't create a duplicate) so the enum matcher in the ledger
    // test resolves to it.
  },

  // ----- Transactions -----------------------------------------------------
  operation('createTransaction', ['create_transaction.account_id', 'create_transaction.item_id']),
  inputField('CreateTransactionInput.name', ['create_transaction.name']),
  inputField('CreateTransactionInput.date', ['create_transaction.date']),
  inputField('CreateTransactionInput.amount', ['create_transaction.amount']),
  inputField('CreateTransactionInput.categoryId', ['create_transaction.category_id']),
  inputField('CreateTransactionInput.type', ['create_transaction.type']),
  inputField('CreateTransactionInput.tagIds', ['create_transaction.tag_ids']),
  inputField('CreateTransactionInput.userNotes', ['create_transaction.note']),
  inputField('CreateTransactionInput.recurringId', ['create_transaction.recurring_id']),
  responseShape('createTransaction'),

  operation('editTransaction', [
    'update_transaction.transaction_id',
    'review_transactions.transaction_ids',
  ]),
  inputField('EditTransactionInput.name', ['update_transaction.name']),
  inputField('EditTransactionInput.categoryId', ['update_transaction.category_id']),
  inputField('EditTransactionInput.userNotes', ['update_transaction.note']),
  inputField('EditTransactionInput.tagIds', ['update_transaction.tag_ids']),
  inputField('EditTransactionInput.isReviewed', ['review_transactions.reviewed']),
  responseShape('editTransaction'),

  operation('deleteTransaction', [
    'delete_transaction.transaction_id',
    'delete_transaction.account_id',
    'delete_transaction.item_id',
  ]),
  responseShape('deleteTransaction'),

  operation('addTransactionToRecurring', [
    'add_transaction_to_recurring.transaction_id',
    'add_transaction_to_recurring.account_id',
    'add_transaction_to_recurring.item_id',
  ]),
  inputField('AddTransactionToRecurringInput.recurringId', [
    'add_transaction_to_recurring.recurring_id',
  ]),
  responseShape('addTransactionToRecurring'),

  operation('splitTransaction', [
    'split_transaction.transaction_id',
    'split_transaction.account_id',
    'split_transaction.item_id',
    'split_transaction.splits', // the [SplitTransactionInput!]! list arg itself
  ]),
  inputField('SplitTransactionInput.name', ['split_transaction.splits[].name']),
  inputField('SplitTransactionInput.date', ['split_transaction.splits[].date']),
  inputField('SplitTransactionInput.amount', ['split_transaction.splits[].amount']),
  inputField('SplitTransactionInput.categoryId', ['split_transaction.splits[].category_id']),
  responseShape('splitTransaction'),

  // ----- Tags ---------------------------------------------------------------
  // No top-level args beyond the input object (covered by CreateTagInput.*).
  operation('createTag'),
  inputField('CreateTagInput.name', ['create_tag.name']),
  inputField('CreateTagInput.colorName', ['create_tag.color_name']),
  responseShape('createTag'),

  operation('editTag', ['update_tag.tag_id']),
  inputField('EditTagInput.name', ['update_tag.name']),
  inputField('EditTagInput.colorName', ['update_tag.color_name']),
  responseShape('editTag'),

  operation('deleteTag', ['delete_tag.tag_id']),
  responseShape('deleteTag'),

  // ----- Categories ---------------------------------------------------------
  // No top-level args beyond the input object (covered by CreateCategoryInput.*).
  operation('createCategory'),
  inputField('CreateCategoryInput.name', ['create_category.name']),
  inputField('CreateCategoryInput.colorName', ['create_category.color_name']),
  inputField('CreateCategoryInput.emoji', ['create_category.emoji']),
  inputField('CreateCategoryInput.isExcluded', ['create_category.is_excluded']),
  responseShape('createCategory'),

  operation('editCategory', ['update_category.category_id']),
  inputField('EditCategoryInput.name', ['update_category.name']),
  inputField('EditCategoryInput.colorName', ['update_category.color_name']),
  inputField('EditCategoryInput.emoji', ['update_category.emoji']),
  inputField('EditCategoryInput.isExcluded', ['update_category.is_excluded']),
  responseShape('editCategory'),

  operation('deleteCategory', ['delete_category.category_id']),
  responseShape('deleteCategory'),

  // ----- Budgets ------------------------------------------------------------
  // The single set_budget MCP tool fans out to one of two mutations
  // (editCategoryBudgetMonthly when `month` is given, editCategoryBudget
  // otherwise), so set_budget.category_id / set_budget.amount are
  // intentionally claimed by BOTH operations' entries. Note the coverage
  // consequence: deleting one entry would not fail the param-coverage test
  // (the other still claims the paths) — it would only fail the
  // unique-surface inventory expectations downstream.
  operation('editCategoryBudget', ['set_budget.category_id']),
  inputField('EditCategoryBudgetInput.amount', ['set_budget.amount']),
  responseShape('editCategoryBudget'),

  operation('editCategoryBudgetMonthly', ['set_budget.category_id']),
  inputField('EditCategoryBudgetMonthlyInput.amount', ['set_budget.amount']),
  inputField('EditCategoryBudgetMonthlyInput.month', ['set_budget.month']),
  responseShape('editCategoryBudgetMonthly'),

  // ----- Recurrings ---------------------------------------------------------
  // No top-level args beyond the input object (covered by CreateRecurringInput.*).
  operation('createRecurring'),
  inputField('CreateRecurringInput.frequency', ['create_recurring.frequency']),
  inputField('CreateRecurringInput.transaction', ['create_recurring.transaction_id']),
  responseShape('createRecurring'),

  operation('editRecurring', ['set_recurring_state.recurring_id', 'update_recurring.recurring_id']),
  inputField('EditRecurringInput.name', ['update_recurring.name']),
  inputField('EditRecurringInput.categoryId', ['update_recurring.category_id']),
  inputField('EditRecurringInput.frequency', ['update_recurring.frequency']),
  inputField('EditRecurringInput.state', ['set_recurring_state.state', 'update_recurring.state']),
  inputField('EditRecurringInput.rule', ['update_recurring.rule']),
  inputField('EditRecurringInput.rule.nameContains', ['update_recurring.rule.name_contains']),
  inputField('EditRecurringInput.rule.minAmount', ['update_recurring.rule.min_amount']),
  inputField('EditRecurringInput.rule.maxAmount', ['update_recurring.rule.max_amount']),
  inputField('EditRecurringInput.rule.days', ['update_recurring.rule.days']),
  responseShape('editRecurring'),

  operation('deleteRecurring', ['delete_recurring.recurring_id']),
  responseShape('deleteRecurring'),

  // ----- Accounts -----------------------------------------------------------
  // editAccount has a GraphQL wrapper (src/core/graphql/accounts.ts) but no
  // MCP write tool yet, so no toolParams. Tracked here because the wrapper's
  // assumptions are still external assumptions.
  operation('editAccount'),
  inputField('EditAccountInput.name'),
  inputField('EditAccountInput.isUserHidden'),
  responseShape('editAccount'),
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
