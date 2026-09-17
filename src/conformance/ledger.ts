/**
 * Conformance ledger (issue #435, Epic B #421).
 *
 * Machine-readable inventory of every assumption this codebase makes about
 * Copilot Money's external GraphQL surface — enum value sets, input-type
 * fields, operation signatures, and response shapes — together with the
 * oracle (if any) that re-verifies each assumption and the strongest class
 * of verification it currently has.
 *
 * Also, since #722, the ONE non-Copilot external surface the server depends
 * on: Google's Firebase token-exchange endpoint. It is here for the same
 * reason everything else is — the auth loop branches on how that endpoint
 * rejects things, so those are assumptions about a system we do not control,
 * and the #478 post-mortem recorded their absence from this ledger as a gap.
 * They carry no `toolParams` and no oracle: the bijection tests walk the
 * write-tool schemas, which never reach them.
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
 *                      (covers the operation's existence + top-level args).
 *                      Also takes a `:<aspect>` suffix for a claim about ONE
 *                      behaviour of that operation rather than its existence
 *                      — `Mutation.editTransaction:routing`,
 *                      `Mutation.splitTransaction:sum`,
 *                      `Mutation.bulkEditTransactions:silent-skip`. Several
 *                      live entries already use it; documented here for the
 *                      same reason as the `response-shape` form below. (No
 *                      count on purpose: a present-tense tally in a comment
 *                      goes silently false on the next entry — a claim with
 *                      no detector. NOT #705's class, which is the narrower
 *                      one of a guard you can satisfy by writing the guarded
 *                      thing where it has no effect.)
 *                      THE ASPECT SUFFIX is `Mutation.`-only — the bullet's
 *                      bare `Query.<fieldName>` form is fine and live (see
 *                      `queryOperation`). Only the suffixed form is barred,
 *                      by the reserved-prefix note under `response-shape`,
 *                      which applies to every kind.
 *                      One deliberate exception, added with the entries that
 *                      needed it (#722): a third-party HTTP endpoint is named
 *                      `<Service>.<path>:<aspect>`, e.g.
 *                      `Securetoken.v1Token:foreignProject`. It is neither a
 *                      Copilot operation nor a query, so neither ratchet
 *                      applies; the `:<aspect>` half means the same thing.
 *                      A SECOND exception, on the same precedent (#666): an
 *                      assumption about a Copilot FIRESTORE CACHE document
 *                      rather than the GraphQL wire is named
 *                      `Firestore<Collection>.<field>:<aspect>`, e.g.
 *                      `FirestoreAccount.dashboard_active:notVisibility`. The
 *                      cache is a Copilot-controlled data surface this server
 *                      reads and does not own — the same reason everything
 *                      else is in here — and the `Firestore` prefix keeps it
 *                      from being mistaken for the `Account` GraphQL type,
 *                      whose fields are a different set. SUCH AN ENTRY TAKES
 *                      `kind: 'response-shape'` — a cache document is data
 *                      Copilot sends us and we read, which is what that kind
 *                      means here; `operation` (the kind the Securetoken
 *                      entries take) describes something we CALL, and there is
 *                      no call. Neither fits perfectly and nothing validates
 *                      the choice, so it is written down to stop the next
 *                      Firestore entry picking the other one.
 * - `response-shape` → `Mutation.<fieldName>:response` / `Query.<fieldName>:response`
 *                      for a whole operation's shape. For an assumption about
 *                      ONE FIELD's semantics rather than the operation's keys,
 *                      use `<Node>.<field>:<aspect>` — e.g.
 *                      `Transaction.excluded:synthesized` (we invent it),
 *                      `AccountNode.name:resolvesNickname` (the server resolves
 *                      it before sending). Two of those read as exceptions;
 *                      three are a convention, so it is written down here.
 *                      (That count survives the no-tallies rule above because
 *                      it is RETROSPECTIVE — it narrates why the form got
 *                      documented at a moment in time, and stays true however
 *                      many entries accrue. Only a tally of today rots.)
 *
 *                      NOTE the `Query.` prefix is effectively RESERVED:
 *                      `tests/scripts/read-smoke-coverage.test.ts` requires
 *                      every `Query.*` surface to name a real generated root
 *                      field after stripping `:response`. An assumption about
 *                      a query that is not about its response keys therefore
 *                      cannot use `Query.<field>:<aspect>` without extending
 *                      that ratchet — name it off the type instead.
 *
 *                      SECOND DELIBERATE STRETCH of this kind, added with the
 *                      entries that needed it (#718): a field of a Firestore
 *                      CACHE document is named
 *                      `<Collection>Document.<field>:wireType`, e.g.
 *                      `TransactionDocument.amazon:wireType`. Nothing about
 *                      it is a GraphQL response — it is the decode boundary —
 *                      but the claim has the same shape (one field of a
 *                      structure Copilot controls and we transcribe), and
 *                      inventing a kind per boundary would fragment the
 *                      class distribution that `bun run smoke` reports.
 *                      The `Document` suffix is what keeps a cache surface
 *                      from colliding with the GraphQL node of the same
 *                      name: `Transaction.excluded:synthesized` is the wire
 *                      type; `TransactionDocument.amazon:wireType` is the
 *                      cached one.
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
function gatedQueryResponseShape(name: string, overrides?: Partial<LedgerEntry>): LedgerEntry {
  return {
    surface: `Query.${name}:response`,
    kind: 'response-shape',
    oracle: `runtime:${READ_RESPONSE_SHAPE_RUNTIME_CHECK}`,
    class: 'gated',
    evidence: READ_RESPONSE_SHAPE_GATED,
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
    toolParams: [
      'create_transaction.type',
      'update_transaction.type',
      'bulk_edit_transactions.type',
      'update_transactions.edits[].type',
    ],
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

  // update_transaction (one edit) and update_transactions (many, per-row
  // heterogeneous) are two arities over the SAME mutation — neither adds an
  // external surface. The batching params (`edits`) and the client-side policy
  // knob (`continue_on_error`) ride on this operation entry because that is
  // what they parameterise: update_transactions is a client-side fan-out of
  // editTransaction, not a distinct server operation.
  //
  // review_transactions is deliberately NOT here any more: it now issues
  // Copilot's native `bulkEditTransactions` in one request, so its params live
  // on that operation's entry. update_transactions stays on the fan-out
  // because the native endpoint supports neither per-row inputs nor
  // name/date/amount/note — see docs/bulk-edit-transactions.md.
  operation('editTransaction', [
    'update_transaction.transaction_id',
    'update_transaction.account_id',
    'update_transaction.item_id',
    'update_transactions.edits', // the list arg itself
    'update_transactions.edits[].transaction_id',
    'update_transactions.edits[].account_id',
    'update_transactions.edits[].item_id',
    'update_transactions.continue_on_error',
  ]),
  gatedInputField('EditTransactionInput.name', [
    'update_transaction.name',
    'update_transactions.edits[].name',
  ]),
  gatedInputField('EditTransactionInput.categoryId', [
    'update_transaction.category_id',
    'update_transactions.edits[].category_id',
  ]),
  gatedInputField('EditTransactionInput.userNotes', [
    'update_transaction.note',
    'update_transactions.edits[].note',
  ]),
  gatedInputField('EditTransactionInput.tagIds', [
    'update_transaction.tag_ids',
    'update_transactions.edits[].tag_ids',
  ]),
  gatedInputField('EditTransactionInput.isReviewed', [
    'update_transaction.reviewed',
    'update_transactions.edits[].reviewed',
  ]),
  gatedInputField('EditTransactionInput.type', [
    'update_transaction.type',
    'update_transactions.edits[].type',
  ]),
  gatedInputField('EditTransactionInput.date', [
    'update_transaction.date',
    'update_transactions.edits[].date',
  ]),
  gatedInputField('EditTransactionInput.amount', [
    'update_transaction.amount',
    'update_transactions.edits[].amount',
  ]),
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

  // --- bulkEditTransactions (captured 2026-07-31, adopted 2026-08-01) ---
  // Copilot's own multi-select bar fires this; it applies ONE input to MANY
  // rows. Both consumers (review_transactions, bulk_edit_transactions) send
  // exactly one filter key — `ids` — because `filter` is nullable server-side
  // and any other filter field would widen the row set. See
  // docs/graphql-capture/operations/mutations/BulkEditTransactions.md.
  operation('bulkEditTransactions', [
    'bulk_edit_transactions.transaction_ids',
    'bulk_edit_transactions.rows',
    'bulk_edit_transactions.rows[].transaction_id',
    'bulk_edit_transactions.rows[].account_id',
    'bulk_edit_transactions.rows[].item_id',
    'review_transactions.transaction_ids',
    'review_transactions.rows',
    'review_transactions.rows[].transaction_id',
    'review_transactions.rows[].account_id',
    'review_transactions.rows[].item_id',
  ]),
  gatedInputField('BulkEditTransactionInput.categoryId', ['bulk_edit_transactions.category_id']),
  gatedInputField('BulkEditTransactionInput.addTagIds', ['bulk_edit_transactions.add_tag_ids']),
  gatedInputField('BulkEditTransactionInput.removeTagIds', [
    'bulk_edit_transactions.remove_tag_ids',
  ]),
  gatedInputField('BulkEditTransactionInput.type', ['bulk_edit_transactions.type']),
  gatedInputField('BulkEditTransactionInput.isReviewed', [
    'bulk_edit_transactions.reviewed',
    'review_transactions.reviewed',
  ]),
  // The routing triple inside filter.ids. Not smoke:conformance-gated like the
  // input fields above: the field-probe harness injects into a top-level
  // `input` object, and these live nested inside `filter.ids[]`. They are
  // instead exercised end-to-end on every round-trip run — a rename would fail
  // the bulk_edit_transactions check immediately, because the ids would stop
  // matching and every row would land in skipped[].
  ...(['id', 'accountId', 'itemId'] as const).map((field) =>
    inputField(`TransactionIdentifierInput.${field}`, undefined, {
      class: 'verified-once',
      evidence:
        'Error-leak probe 2026-08-01: an empty `filter: { ids: [{}] }` enumerated the type as ' +
        'exactly { itemId: ID!, accountId: ID!, id: ID! }, all three required, and a bogus key ' +
        'returned "not defined by type TransactionIdentifierInput". Re-exercised live on every ' +
        'round-trip smoke run via the bulk_edit_transactions check.',
    })
  ),
  responseShape('bulkEditTransactions'),
  appliesSurface('bulkEditTransactions'),
  {
    surface: 'BulkEditTransactionInput:closed-field-set',
    kind: 'input-field',
    oracle: null,
    class: 'verified-once',
    evidence:
      'Error-leak probe 2026-08-01 enumerated the type exhaustively: categoryId, addTagIds, ' +
      'removeTagIds, type, isReviewed exist; name, date, amount, userNotes, notes, tagIds, ' +
      'setTagIds, recurringId, goalId, parentId, isExcluded, isHidden, isPending and tipAmount ' +
      'all returned "not defined by type BulkEditTransactionInput". Near-miss probes on each ' +
      'real field surfaced no additional siblings. Consequence: name/date/amount/note are NOT ' +
      'bulk-editable and the per-row editTransaction path cannot be retired. If a future ' +
      'Copilot release adds a field, this entry is what goes stale — re-probe before assuming ' +
      'the set is still five.',
  },
  {
    surface: 'Mutation.bulkEditTransactions:filter-selects',
    kind: 'operation',
    oracle: null,
    class: 'verified-once',
    evidence:
      'Live probe 2026-08-02: sent filter { matchString } with NO ids and addTagIds as the ' +
      'edit. The server selected and wrote exactly the rows matching that string; a control ' +
      'row on the same account and date, differing only in name, was untouched. This proves ' +
      'the mutation honours TransactionFilter fields OTHER than ids — it is not an ids-only ' +
      'endpoint that merely accepts a wider type — so a broad filter really can rewrite a ' +
      'large slice of the account, and the nullable `filter` is a live hazard rather than a ' +
      'theoretical one. Bounded by read-gating the identical filter through the Transactions ' +
      'query first, a reversible edit, and untagging by explicit id afterwards. `filter: {}` ' +
      'and an omitted filter remain untested by design: they have no read-verifiable match ' +
      'set, so that gate cannot bound them. This entry is why bulkEditTransactions() exposes ' +
      'no `filter` parameter at all and only ever emits `ids`.',
  },
  {
    surface: 'Mutation.bulkEditTransactions:silent-skip',
    kind: 'operation',
    oracle: null,
    class: 'verified-once',
    evidence:
      'Live probe 2026-08-01: an id in filter.ids that does not exist is silently omitted from ' +
      'the row set — it does NOT raise and does NOT appear in failed[]. Likewise an unknown ' +
      'tag id in addTagIds is dropped without error. Callers therefore cannot trust failed[] ' +
      'to mean "everything else worked"; both consumers diff updated[] against the requested ' +
      'ids and throw on any gap (BulkEditTransactionsResult.skipped).',
  },
  {
    surface: 'Mutation.bulkEditTransactions:no-referential-validation',
    kind: 'operation',
    oracle: null,
    class: 'verified-once',
    evidence:
      'Live probe 2026-08-01: a categoryId that does not exist is accepted VERBATIM and ' +
      'persisted, leaving a dangling category reference on every targeted row (confirmed on a ' +
      'REGULAR transaction, so it is not the INCOME category-clearing path). The server ' +
      'performs no referential check, so client-side validateCategoryId/validateTagIds before ' +
      'the write is the only guard against corrupting rows.',
  },
  {
    surface: 'ErrorCode',
    kind: 'enum',
    oracle: null,
    class: 'unverified',
    evidence:
      'BulkEditTransactionsOutput.failed[] is typed TransactionError { transaction, error, ' +
      'errorCode: ErrorCode! } (probe-confirmed), but seven live probes — nonexistent ' +
      'transaction, tag and category ids — all returned failed: [], so no ErrorCode value has ' +
      'ever been observed and the enum members are unknown. The response schema deliberately ' +
      'types errorCode as a plain string rather than a z.enum: a value gate we cannot populate ' +
      'would warn on the first genuine failure, which is exactly when the payload matters. ' +
      'Close this by capturing a real failure (a permissions or split-parent case may do it).',
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
  gatedInputField('CreateRecurringInput.transaction', [
    'create_recurring.transaction_id',
    'create_recurring.account_id',
    'create_recurring.item_id',
  ]),
  responseShape('createRecurring'),
  appliesSurface('createRecurring'),
  {
    surface: 'Mutation.createRecurring:routing',
    kind: 'operation',
    oracle: null,
    class: 'verified-once',
    evidence:
      'Live probe 2026-07-24 (#571): CreateRecurring validates the full (transactionId, ' +
      'accountId, itemId) binding on the nested transaction ref, mirroring ' +
      'Mutation.editTransaction:routing — fabricated pair → "Transaction not found"; ' +
      'real-but-wrong pair (another real account\'s ids) → "Transaction not found"; correct ' +
      'pair → recurring created. Load-bearing for the create_recurring routing bypass, which ' +
      'forwards a caller-supplied pair verbatim: a wrong pair fails loudly rather than ' +
      'seeding the recurring from a different transaction.',
  },

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
  // operations.generated.ts, named by root Query field — plus any field-level
  // `<Node>.<field>:<aspect>` entries, filed beside the query they concern
  // rather than in a section of their own, so a reader auditing that query
  // finds them together.
  // `tests/scripts/read-smoke-coverage.test.ts` enforces this list stays in
  // lockstep with the generated operations AND with the Tier-0 read smoke
  // checks (scripts/smoke/read-checks.ts) — a new query cannot ship without
  // both a smoke check and these entries.
  queryOperation('user'),
  gatedQueryResponseShape('user'),
  queryOperation('accounts'),
  {
    surface: 'AccountNode.name:resolvesNickname',
    kind: 'response-shape',
    oracle: null,
    class: 'verified-once',
    evidence:
      "Both get_accounts and get_accounts_live tell callers `name` is the user's Copilot " +
      'nickname when one is set, and that it is therefore user-editable and unsafe as a key ' +
      '(#665). Cache mode EARNS that by mapping `nickname` -> `name` itself; live mode does ' +
      'no nickname handling at all and returns AccountNode.name straight off the wire, so the ' +
      'live half of the claim rests entirely on the server resolving it. ' +
      'PROBE 2026-09-14 against real data: for every cache account whose `nickname` differs ' +
      'from its provider `name`, the live `name` matched the NICKNAME, not the provider ' +
      "label. The server resolves it, so the two modes agree and cache's explicit mapping " +
      'brings cache INTO line rather than away from it. ' +
      'ONE INPUT THE PROBE COULD NOT COVER: cache mode treats a BLANK label as no label ' +
      '(`preferredAccountName` trims before testing, so `nickname: "   "` falls through to ' +
      'the provider label, and so does `name: "   "`). Live mode does no such handling and ' +
      'returns AccountNode.name as sent, so the two modes agree on every input EXCEPT a ' +
      'whitespace-only nickname — for which cache reports the provider label and live ' +
      'reports the whitespace, if the server passes it through. No account in the probe had ' +
      'one, so which side is right is unknown; it is recorded because this entry exists to ' +
      'say where the claim rests on the server and nothing re-checks it. ' +
      'Classed verified-once rather than left unrecorded: nothing re-checks it. If Copilot ' +
      'stopped resolving the nickname, AccountNode.name would keep its key and its type, the ' +
      'gated read-shape entry for Query.accounts would stay green because it gates KEYS not ' +
      "SEMANTICS, and get_accounts_live's description would quietly become false for exactly " +
      'the write-capable callers it was added for. ' +
      "TO GATE: an oracle would have to compare live `name` against the cache document's " +
      '`nickname` for an account that has one — which needs real data, so it belongs in a ' +
      'smoke rather than in CI.',
  },
  {
    surface: 'AccountNode.hiddenAccounts:returnedUnfiltered',
    kind: 'response-shape',
    oracle: null,
    class: 'unverified',
    evidence:
      '#683 makes get_holdings_live join the Accounts snapshot to drop positions on hidden ' +
      'and closed accounts, which ASSUMES the Accounts query returns those accounts rather ' +
      'than filtering them server-side. If Copilot ever started filtering, hiddenAccountIds ' +
      'would come back EMPTY and get_holdings_live would silently revert to the #683 ' +
      'double-count — with no test failing, because the live parity test stubs a client that ' +
      'always returns the hidden accounts. ' +
      'Evidence is solid but INDIRECT: get_accounts_live applies its own client-side ' +
      'isUserHidden/isUserClosed filter, which would be dead code if the server already ' +
      'filtered, and a 2026-09-14 probe against real data saw hidden accounts in the ' +
      'Accounts response. That is why this is `unverified` rather than absent: nothing ' +
      're-checks it. ' +
      'THE PARITY WAS MOVED, NOT ELIMINATED, and this is the half to watch. ' +
      'get_investment_balance_live, get_aggregated_holdings_live and ' +
      'get_investment_allocation_live are SERVER-COMPUTED totals with no per-account rows to ' +
      "filter. If Copilot's aggregation does NOT exclude hidden accounts, get_holdings_live " +
      'now sums to LESS than those three — a fresh disagreement about the same money, in the ' +
      'opposite direction, created by the fix. The same probe could not settle it: the only ' +
      'hidden accounts in that dataset hold nothing, so every comparison is trivially equal ' +
      'and proves neither side. Filtering remains the right default because get_accounts_live ' +
      'is the parity a caller actually reaches for, but it is a trade made under uncertainty. ' +
      'TO SETTLE: hide an account that HOLDS something, then compare the sum of ' +
      'get_holdings_live institution_value against get_investment_balance_live. ' +
      'KNOWN RESIDUAL: an EMPTY accounts response yields an empty hidden set, so holdings come ' +
      'back unfiltered — the one input that reaches that path without an error. Treating it as ' +
      'a contradiction (zero accounts, non-zero holdings) was tried and backed out: it conflicts ' +
      "with the filter's own rule that a holding whose account is absent from the snapshot is " +
      'KEPT, since unknown is not hidden. Both halves of that rule are pinned in ' +
      'tests/tools/live/holdings.test.ts — the EMPTY-snapshot case and the ' +
      'POPULATED-snapshot-omitting-the-account case — so the behaviour is a decision ' +
      'rather than a discovery. ' +
      'NAMING: this is an assumption about the accounts QUERY, so `Query.accounts:...` reads ' +
      'more naturally — but that prefix is reserved. ' +
      'tests/scripts/read-smoke-coverage.test.ts requires every `Query.*` surface to name a ' +
      'real generated root field after stripping `:response`, so `Query.accounts:hiddenReturned` ' +
      'fails that ratchet (verified, not assumed). Type-scoped it is.',
  },
  {
    surface: 'FirestoreAccount.dashboard_active:notVisibility',
    kind: 'response-shape',
    oracle: null,
    class: 'verified-once',
    evidence:
      'The cache account document carries `dashboard_active`, and #624 filed it as the third ' +
      'of three account customizations Copilot migrated onto that document, beside `nickname` ' +
      'and `user_hidden`. The other two each had a consumer to restore (#624, #660); #666 ' +
      'proposed the symmetric move for this one — add it to the default `get_accounts` ' +
      'visibility filter. THE ASSUMPTION RECORDED HERE IS THAT IT IS NOT A VISIBILITY FLAG, ' +
      'so `isVisibleAccount` deliberately ignores it. ' +
      'PROBE 2026-09-16, two independent sources. Cache cross-tab (counts only): of 21 ' +
      'account documents all 21 carry the field, 8 are `false`, and 6 of those 8 carry no ' +
      '`user_hidden` at all — the split tracks account TYPE, every `false` document being an ' +
      'investment account and every `true` one not. Live round-trip the same day: the ' +
      'Accounts query returned those same 6 with `isUserHidden: false, isUserClosed: false`. ' +
      'Filtering on the flag would therefore have dropped every investment account from the ' +
      'default account list. ' +
      'CORROBORATION FROM OUR OWN WIRE: `AccountFields`, the fragment we send for an account, ' +
      'has no counterpart field, so live mode could not implement such a filter even if the ' +
      'reading were right — any cache-side behaviour built on it would be a cache/live ' +
      'divergence of the #663/#683 kind, and invisible to the parity tests because only one ' +
      'mode has the field. ' +
      'WHY verified-once RATHER THAN gated: `scripts/smoke/cache.ts` check 7 re-measures the ' +
      'independence on whatever real cache it runs and reports four outcomes, but it WARNS ' +
      'rather than fails when the evidence goes away — a cache whose only `false` accounts ' +
      'happen to be hidden is ambiguous, not wrong — and `smoke:cache` is not yet in any ' +
      'composite or schedule. A WARN nothing runs automatically is not a gate. ' +
      'TO GATE: wire `smoke:cache` into the scheduled drift check (blocked on the reporting ' +
      'gap noted in package.json) and decide whether `indistinguishable` should be fatal. ' +
      'WHAT DRIFT WOULD LOOK LIKE: Copilot repurposing the flag, at which point cache-mode ' +
      '`get_accounts` would list accounts the app hides — #624 again, in the mode where it ' +
      'was already found once.',
  },
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
  // ----- Synthesized transaction row fields (#604) ---------------------------
  // Not fields Copilot returns: fields this repo INVENTS on live rows so both
  // names are SELECTABLE under `fields: ["default"]` and MEAN the same thing in
  // cache mode and live mode.
  //
  // Not the same key COUNT, and an earlier revision of this header claimed it
  // was: live's mappers always emit a boolean, while cache projects a document
  // and omits optional fields the row does not carry. A categorized cache row
  // that is neither pending nor a transfer comes back 8 keys wide — no
  // `pending`, no `internal_transfer` — against live's 10, which is why the
  // measured headline in CHANGELOG.md reads 9 and not 10. An UNCATEGORIZED
  // cache row is 7: `category_name` resolves to `undefined` and serialization
  // drops it, the same mechanism that makes an uncategorized live row 9.
  // Live's 10 is itself a ceiling rather than a constant: `category_name`
  // resolves to `undefined` for a row with no category, or one whose category
  // id is missing from the index, and JSON.stringify drops the key — so an
  // uncategorized live row reaches the caller 9 wide. It is the only preset
  // name that can vanish this way, and it is pinned by 'an uncategorized live
  // row is 9 keys ON THE WIRE, not 10' in tests/tools/live/transactions.test.ts.
  // Boolean reads still agree (an absent key is falsy); `Object.keys().length`
  // does not. `excluded` is the exception that is always present on both
  // surfaces, because it is DERIVED rather than copied — a derivation always
  // has a value.
  //
  // Each one is an assumption about Copilot's data model, so each gets its own
  // entry — they are not equally strong, and collapsing them into one would
  // launder the weaker of the two.
  {
    surface: 'Transaction.internalTransfer:synthesized',
    kind: 'response-shape',
    oracle: null,
    class: 'verified-once',
    evidence:
      'Probe 2026-09-11: the transfer spellings `internalTransfer`, `isInternalTransfer` and ' +
      '`isTransfer` all return `Cannot query field "<name>" on type "Transaction"` with no ' +
      "did-you-mean suggestions, and the web app's own TransactionFields fragment selects none " +
      'of them — ' +
      'live models a transfer as `type === INTERNAL_TRANSFER`. Derivation measured against ' +
      'real data the same day: 600 live rows paginated, 506 joined to cache documents by id, ' +
      '506/506 agreement including all 46 rows that are transfers on either side, zero ' +
      'deviations. DERIVED BUT EXACT; nothing re-checks it, so a server-side change to how ' +
      'transfers are typed would drift silently. ' +
      'CACHE SIDE: cache reports the RAW document flag for this field, not the union its ' +
      'exclude_transfers filter applies (isTransferCategory also matches credit_card and ' +
      '*payment* ids, because it is a spend heuristic rather than a claim about what the ' +
      'transaction is). Deliberate: field parity ACROSS modes wins over field/filter symmetry ' +
      'WITHIN one mode. A SECOND run the same day, joining 508 rows rather than the 506 of ' +
      'the run above, measured both choices — 0 rows differ, so nothing observable turns on ' +
      'the decision today and it rests on the reasoning alone. Pinned by "a TRANSFER-CATEGORY ' +
      'row without the raw flag reports internal_transfer falsy" in tests/tools/tools.test.ts, ' +
      'so a later "fix the asymmetry" fails a test instead of merely contradicting prose.',
  },
  {
    surface: 'Transaction.excluded:synthesized',
    kind: 'response-shape',
    oracle: null,
    class: 'unverified',
    evidence:
      'Probe 2026-09-11: the exclusion spellings `excluded`, `isExcluded`, `userExcluded`, ' +
      '`isUserExcluded` and `excludeFromSpending` all return `Cannot query field "<name>" on ' +
      'type "Transaction"`. Together with the three transfer spellings on the sibling entry ' +
      'that is 8 spellings, and all 8 are WATCHED by scripts/smoke/output-field-absence-checks.ts ' +
      '— the count and the watched list are pinned to each other by ' +
      'tests/scripts/synthesized-field-coverage.test.ts, because an earlier revision of these ' +
      'entries claimed 11 on the strength of a probe transcript that no longer exists (the three ' +
      'further names were never recorded, so nothing watches them and nothing can cite them). ' +
      '`isExcluded` exists ' +
      'ONLY on CreateCategoryInput/EditCategoryInput, and neither EditTransactionInput nor ' +
      'CreateTransactionInput accepts it either — there is no per-transaction exclusion ' +
      'anywhere on the GraphQL surface, read or write. The app writes the flag straight to ' +
      'Firestore, where src/core/decoder.ts reads it. BOTH surfaces therefore report ' +
      '`excluded` as "is this row excluded from spending?", each computed with the predicate ' +
      "its own exclude_excluded filter applies: cache = raw per-transaction flag OR the row's " +
      'category being user-excluded; live = the category half alone, which is all GraphQL ' +
      'exposes. ' +
      'MEASURED 2026-09-11 with a real transaction created in a user-excluded category: the ' +
      'synced Firestore document carried `excluded: undefined` — Copilot does NOT stamp the ' +
      'per-transaction flag when the category is excluded — so reporting the raw flag made ' +
      'cache mode answer "not excluded" for a row live mode called excluded. Deriving the ' +
      'union fixes that, and was verified against that same row (cache now `true`, live ' +
      '`true`). ' +
      'Still classed unverified, for the half that remains: a transaction excluded ' +
      'INDIVIDUALLY in the app reads `excluded: true` in cache mode and `false` in live ' +
      'mode, and no probe has exercised it — 0 of 521 cache rows carried the raw flag, so ' +
      "the parity run's agreement on that half is trivially false === false, not evidence.",
  },

  queryOperation('categories'),
  gatedQueryResponseShape('categories', {
    evidence:
      READ_RESPONSE_SHAPE_GATED +
      '; budget.month ordering/anchoring is guarded by get_budgets_live synthetic tests ' +
      '(tests/tools/live/budgets.test.ts, issue #598) and the budgets live smoke ' +
      '(scripts/smoke/budgets.ts).',
  }),
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

  // -------------------------------------------------------------------------
  // Google Firebase securetoken (#722) — not Copilot's surface, but external,
  // and the cold-path auth loop branches on all three of these. Candidates are
  // scraped out of raw browser LevelDB bytes, so the loop must decide, per
  // rejection, whether to try the next candidate or stop.
  // -------------------------------------------------------------------------
  {
    surface: 'Securetoken.v1Token:foreignProject',
    kind: 'operation',
    oracle: null,
    class: 'verified-once',
    evidence:
      'A refresh token belonging to a different Firebase project is rejected with ' +
      'PROJECT_NUMBER_MISMATCH. Observed repeatedly against production during live-session ' +
      'work (issue #454, fixed in PR #478) — real foreign tokens, no controlled probe, and ' +
      'nothing re-checks it. `isForeignProjectError` in src/core/auth/firebase-auth.ts is ' +
      'why a foreign candidate is skipped rather than reported as a failure — one of two ' +
      'reasons a rejection is treated as already explained, alongside DEAD_TOKEN_CODES; ' +
      '`isExplainedByLoggedOut` is the branch condition that combines them.',
  },
  {
    surface: 'Securetoken.v1Token:invalidCandidate',
    kind: 'operation',
    oracle: null,
    class: 'verified-once',
    evidence:
      'An `AMf-`-shaped string that is not a usable refresh token is rejected with HTTP 400 ' +
      'and code INVALID_REFRESH_TOKEN — NOT PROJECT_NUMBER_MISMATCH. One-shot probe for ' +
      'issue #722: a synthetic non-token posted to the documented endpoint with the public ' +
      'web API key returned 400 / INVALID_REFRESH_TOKEN. This is why a non-mismatch 4xx is ' +
      'no longer read as "the candidate was Copilot\'s": the token regex scans raw LevelDB ' +
      'bytes, so a truncated match from ANY site lands here.',
  },
  {
    surface: 'Securetoken.v1Token:endpointFailure',
    kind: 'operation',
    oracle: null,
    class: 'unverified',
    evidence:
      'PARTLY probed for issue #722, and the probe refuted the simple version. Key-level ' +
      'failures do NOT arrive as 5xx: a request with an invalid API key returns HTTP 400 ' +
      'with reason API_KEY_INVALID — the same status a bad refresh token uses — and a ' +
      'request with no key at all returns HTTP 403 PERMISSION_DENIED. So status alone ' +
      'cannot separate "this candidate is bad" from "our key is bad", and ' +
      '`isCandidateRejection` in src/core/auth/firebase-auth.ts classifies on 403/429 plus ' +
      'a body-code list (ENDPOINT_LEVEL_ERROR_CODES). STILL UNVERIFIED: that securetoken ' +
      'reports its own unavailability with a 5xx or no response, that 429 is only ever ' +
      'rate-limiting (RESOURCE_EXHAUSTED / TOO_MANY_ATTEMPTS_TRY_LATER), and that the ' +
      'body-code list is exhaustive — no probe induced any of those. If the list is ' +
      'incomplete the failure is benign in the privacy direction (a raw error surfaced ' +
      'after the budget, not a wrong answer), but the user-facing message degrades to the ' +
      'unactionable "no session" one, which is the bug #722 was about.',
  },

  // -------------------------------------------------------------------------
  // Firestore CACHE DOCUMENT fields (#718) — the decode boundary, not the
  // GraphQL one. Copilot's app writes these documents and src/core/decoder.ts
  // reads them, so a field's wire type is an assumption about a system we do
  // not control in exactly the sense this ledger exists for. Three of them
  // were added by Copilot after the decoder coverage-warn triage closed at
  // zero (#317), and `bun run smoke:cache` is what noticed.
  //
  // NAMING: `<Collection>Document.<field>:wireType`. The `Query.` prefix is
  // reserved (see the header), and these are not query responses anyway; the
  // `response-shape` KIND is reused rather than a new one added, the same
  // stretch the Securetoken entries above make with `operation`.
  //
  // EVIDENCE CLASS is `verified-once` for all three, and the oracle is null on
  // purpose: `smoke:cache` DOES re-read the real cache, but it gates decode
  // invariants (total decode loss, joins, non-finite values) and would stay
  // green if `amazon` started arriving as an array, because the decoder's
  // `getMap` would return undefined and the field would simply vanish. A
  // silent disappearance is the failure mode these entries record, and nothing
  // re-checks for it today.
  // -------------------------------------------------------------------------
  {
    surface: 'TransactionDocument.amazon:wireType',
    kind: 'response-shape',
    oracle: null,
    class: 'verified-once',
    evidence:
      'PROBE 2026-09-16 over the real local cache, types only, no values read: `amazon` is a ' +
      'MAP on 26 of 1040 non-empty transaction documents, 26/26 map, no other wire type ' +
      'observed. Sub-shape across those 26 documents and their 34 items: `order_id` string ' +
      '(26/26); `items` array (26/26) of maps (34/34) with `id`/`name`/`link` string (34/34 ' +
      'each), `price` and `quantity` number; `other` map (26/26) with numeric ' +
      '`giftWrapping`/`rewards`/`savings`/`shipping`/`tax`. ' +
      'THE SUB-SHAPE IS RECORDED BUT NOT ASSERTED. `price` arrived as a Firestore `double` ' +
      'on 33 items and an `integer` on 1, and four of the five `other` keys mixed both types ' +
      'across the same 26 documents — a single sample would have "proved" either one. ' +
      'src/models/transaction.ts therefore types the field as an opaque map, so drift in a ' +
      'sub-field cannot drop the transaction it hangs off (the #302/#659 class). What IS ' +
      "asserted is only the outer type, which is what the decoder's `getMap` requires. " +
      'WHY IT MATTERS BEYOND DECODE: `order_id` and `items` are the data ' +
      'skills/amazon-sync/SKILL.md obtains today from a manually exported Amazon CSV.',
  },
  {
    surface: 'TransactionDocument.user_changed_type:wireType',
    kind: 'response-shape',
    oracle: null,
    class: 'verified-once',
    evidence:
      'PROBE 2026-09-16 over the real local cache, types only: BOOLEAN, present on 1 of 1040 ' +
      'non-empty transaction documents. ' +
      'ONE SAMPLE IS THE WHOLE EVIDENCE, and it is worth saying so rather than letting the ' +
      '`verified-once` class imply more: a boolean flag has nowhere much to drift, but the ' +
      'cardinality means the type rests on a single document. The exposure if it is wrong is ' +
      'bounded — `getBoolean` returns undefined for any non-boolean, so a re-typed field ' +
      'would make this read absent rather than wrong, and absent already means "not ' +
      'overridden". It is NOT in DEFAULT_TRANSACTION_FIELDS, so no default response changes ' +
      'either way.',
  },
  {
    surface: 'AccountDocument.creation_timestamp:wireType',
    kind: 'response-shape',
    oracle: null,
    class: 'verified-once',
    evidence:
      'PROBE 2026-09-16 over the real local cache, types only: Firestore TIMESTAMP, present ' +
      'on 1 of 21 non-empty account documents — Copilot appears to have started stamping it ' +
      'recently, so absence means unknown rather than old. Decoded through the same ' +
      '`getDateString` as `latest_balance_update`, which accepts a timestamp OR an ' +
      'already-formatted string and narrows both to YYYY-MM-DD, so the one drift this field ' +
      'could plausibly undergo is already absorbed. ' +
      'NOT ADDED to the sibling `plaid_accounts` processor: the probe saw the field only on ' +
      '`accounts`, and decoding it there on the strength of "the collections look alike" ' +
      'would be exactly the guess this ledger exists to prevent.',
  },

  // NOT IN THIS LEDGER: `accounts.apy`, the fourth field #718 names. It is
  // present on 15 account documents and NULL on all 15, so its wire type is
  // unproven — writing `apy: z.number()` would assert a type no sample
  // demonstrated, which is the #537 class run backwards. A passthrough
  // (`z.unknown()`) is not a middle ground: it surfaces the value while
  // asserting nothing, which is how a wrong type reaches a caller
  // unannounced. #718 stays open for that field alone, labelled `help wanted`,
  // and what would close it is one cache in which `apy` is non-null.
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
