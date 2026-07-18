/**
 * Warn-mode Zod validation for mutation response payloads (issue #437,
 * Epic B #421).
 *
 * Why: the write path's response shapes are hand-typed casts (e.g.
 * `CreatedTransaction` in transactions.ts). If Copilot renames or removes a
 * response field, downstream code reads `undefined` and output degrades
 * silently. The read path already solved this pattern — `src/core/
 * schema-warn.ts` validates and warns with dedup. This module is the same
 * idea pointed at GraphQL mutation responses.
 *
 * Semantics — strictly WARN-MODE:
 * - A mismatched response NEVER throws and NEVER drops data. The caller
 *   always receives the server payload unchanged; validation only logs a
 *   structured drift warning (deduped per process, like schema-warn) and
 *   increments a per-surface drift counter (exposed via
 *   `getResponseDriftStats()` so C3's drop-visibility work can surface it).
 * - Schemas mirror the hand-written response interfaces in the per-domain
 *   modules (transactions.ts, tags.ts, ...) field-for-field, but use
 *   `z.looseObject` everywhere so NEW server fields (and `__typename`)
 *   flow through without warnings. Drift = a field we READ going missing
 *   or changing type, not the server adding things.
 *
 * This is the `runtime:zod-warn` oracle in the conformance ledger
 * (src/conformance/ledger.ts): every `Mutation.<name>:response` surface it
 * gates must have a schema registered here — enforced bidirectionally by
 * `tests/conformance/ledger.test.ts`.
 */

import { z, type ZodType } from 'zod';
import { TRANSACTION_TYPES } from './transactions.js';
import { TRANSACTIONS_READ_SHAPE_RUNTIME_CHECK } from './read-validation.js';
import { READ_RESPONSE_SHAPE_RUNTIME_CHECK } from './read-response-validation.js';
import { normalizeDriftPath } from './drift-path.js';

/**
 * Name of this runtime check as registered in the ledger's
 * RUNTIME_CHECK_NAMES. `runtime:zod-warn` oracles point here.
 */
export const RESPONSE_SHAPE_RUNTIME_CHECK = 'zod-warn' as const;

export const RUNTIME_CHECK_NAMES: readonly string[] = [
  RESPONSE_SHAPE_RUNTIME_CHECK,
  TRANSACTIONS_READ_SHAPE_RUNTIME_CHECK,
  READ_RESPONSE_SHAPE_RUNTIME_CHECK,
];

// ---------------------------------------------------------------------------
// Schemas — mirror the response interfaces in the per-domain modules.
// Keep every object `loose`: unknown keys are expected (new server fields,
// __typename) and must pass through silently.
// ---------------------------------------------------------------------------

/** Mirrors the tag objects selected by TagFields (tags.ts). */
const TagSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  colorName: z.string(),
});

/**
 * Mirrors `CreatedTransaction` (transactions.ts), the TransactionFields shape.
 *
 * Note: `type` is gated by the TransactionType enum on purpose — if the
 * server ever ships a NEW transaction type, responses carrying it will
 * warn until TRANSACTION_TYPES (and its smoke conformance probe) are
 * updated. That first warn is the drift signal working, not a bug.
 *
 * Write-critical ids (`id`, `accountId`, `itemId`) are validated with
 * `.min(1)` to mirror read-validation.ts — empty strings are drift,
 * symmetric with read-side schema enforcement (#526).
 */
const CreatedTransactionSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  date: z.string(),
  amount: z.number(),
  categoryId: z.string(),
  type: z.enum(TRANSACTION_TYPES),
  accountId: z.string().min(1),
  itemId: z.string().min(1),
  isPending: z.boolean(),
  isReviewed: z.boolean(),
  createdAt: z.number(),
  recurringId: z.string().nullable(),
  userNotes: z.string().nullable(),
  tipAmount: z.number().nullable(),
  suggestedCategoryIds: z.array(z.string()),
  tags: z.array(TagSchema),
  goal: z.looseObject({ id: z.string(), name: z.string() }).nullable(),
});

export interface ResponseShapeEntry {
  /** Conformance ledger surface this schema verifies. */
  surface: `Mutation.${string}:response`;
  schema: ZodType;
}

function entry(mutationField: string, schema: ZodType): ResponseShapeEntry {
  return { surface: `Mutation.${mutationField}:response`, schema };
}

/**
 * Registry keyed by GraphQL OPERATION name (the first argument modules pass
 * to `client.mutate(...)`) — note operation names don't always match the
 * mutation field name (EditBudget → editCategoryBudget).
 *
 * Every mutation the codebase sends must be registered here; an
 * unregistered operation name gets a (deduped) warning at runtime, and the
 * ledger test enforces that registered surfaces exactly match the
 * `runtime:zod-warn`-gated response-shape entries.
 */
export const MUTATION_RESPONSE_SCHEMAS: Readonly<Record<string, ResponseShapeEntry>> = {
  // ----- Transactions (transactions.ts) -----
  CreateTransaction: entry(
    'createTransaction',
    z.looseObject({ createTransaction: CreatedTransactionSchema })
  ),
  // Mirrors EditTransactionResponse — deliberately the SUBSET of
  // TransactionFields the wrapper actually reads back (no `type`, `amount`,
  // etc.). The wire selection returns more, but only fields code consumes
  // are drift-gated; the rest flow through loose.
  EditTransaction: entry(
    'editTransaction',
    z.looseObject({
      editTransaction: z.looseObject({
        transaction: z.looseObject({
          id: z.string(),
          name: z.string(),
          categoryId: z.string(),
          userNotes: z.string().nullable(),
          isReviewed: z.boolean(),
          tags: z.array(z.looseObject({ id: z.string() })),
        }),
      }),
    })
  ),
  DeleteTransaction: entry('deleteTransaction', z.looseObject({ deleteTransaction: z.boolean() })),
  AddTransactionToRecurring: entry(
    'addTransactionToRecurring',
    z.looseObject({
      addTransactionToRecurring: z.looseObject({ transaction: CreatedTransactionSchema }),
    })
  ),
  SplitTransaction: entry(
    'splitTransaction',
    z.looseObject({
      splitTransaction: z.looseObject({
        parentTransaction: CreatedTransactionSchema,
        splitTransactions: z.array(CreatedTransactionSchema),
      }),
    })
  ),

  // ----- Tags (tags.ts) -----
  CreateTag: entry('createTag', z.looseObject({ createTag: TagSchema })),
  EditTag: entry('editTag', z.looseObject({ editTag: TagSchema })),
  DeleteTag: entry('deleteTag', z.looseObject({ deleteTag: z.boolean() })),

  // ----- Categories (categories.ts) -----
  CreateCategory: entry(
    'createCategory',
    z.looseObject({
      createCategory: z.looseObject({ id: z.string(), name: z.string(), colorName: z.string() }),
    })
  ),
  EditCategory: entry(
    'editCategory',
    z.looseObject({
      editCategory: z.looseObject({
        category: z.looseObject({ id: z.string(), name: z.string(), colorName: z.string() }),
      }),
    })
  ),
  DeleteCategory: entry('deleteCategory', z.looseObject({ deleteCategory: z.boolean() })),

  // ----- Budgets (budgets.ts) — operation names ≠ mutation field names -----
  EditBudget: entry('editCategoryBudget', z.looseObject({ editCategoryBudget: z.boolean() })),
  EditBudgetMonthly: entry(
    'editCategoryBudgetMonthly',
    z.looseObject({ editCategoryBudgetMonthly: z.boolean() })
  ),

  // ----- Recurrings (recurrings.ts) -----
  CreateRecurring: entry(
    'createRecurring',
    z.looseObject({
      createRecurring: z.looseObject({
        id: z.string(),
        name: z.string(),
        state: z.string(),
        frequency: z.string(),
      }),
    })
  ),
  EditRecurring: entry(
    'editRecurring',
    z.looseObject({
      editRecurring: z.looseObject({
        recurring: z.looseObject({
          id: z.string(),
          name: z.string(),
          categoryId: z.string(),
          frequency: z.string(),
          state: z.string(),
        }),
      }),
    })
  ),
  DeleteRecurring: entry('deleteRecurring', z.looseObject({ deleteRecurring: z.boolean() })),

  // ----- Accounts (accounts.ts) -----
  EditAccount: entry(
    'editAccount',
    z.looseObject({
      editAccount: z.looseObject({
        account: z.looseObject({
          id: z.string(),
          name: z.string(),
          isUserHidden: z.boolean(),
        }),
      }),
    })
  ),
};

// ---------------------------------------------------------------------------
// Warn-mode validation + drift counters
// ---------------------------------------------------------------------------

/**
 * Per-surface drift counts accumulated over the process lifetime: how many
 * mutation responses failed shape validation. NOT deduped (unlike the
 * warnings) so the counters reflect the true number of drifted responses —
 * same split as schema-warn's `dropped` counter vs its warn dedup.
 */
export type ResponseDriftStats = Record<string, number>;

const driftCounts = new Map<string, number>();

// Dedupe key = `${operationName}::${normalizeDriftPath(issue.path)}::${issue.code}`.
// Array indices in the path normalize to `*` (#552) so one drift across an
// array's elements (e.g. every splitTransaction child) warns once, not once
// per element. One warn per unique key per process — prevents log flood when
// every call to the same mutation drifts the same way.
const warnedKeys = new Set<string>();

/** Snapshot of the per-surface drift counters (copy, safe to mutate). */
export function getResponseDriftStats(): ResponseDriftStats {
  return Object.fromEntries(driftCounts);
}

/**
 * Validate a mutation response payload against its registered schema,
 * warn-mode. Never throws; never alters `data` — callers keep using the
 * raw server payload regardless of the outcome.
 */
export function validateMutationResponse(operationName: string, data: unknown): void {
  const registered = MUTATION_RESPONSE_SCHEMAS[operationName];
  if (!registered) {
    const key = `${operationName}::<unregistered>`;
    if (!warnedKeys.has(key)) {
      warnedKeys.add(key);
      // console.warn writes to stderr in Node/Bun — safe for the MCP stdio
      // transport (stdout carries JSON-RPC).
      console.warn(
        `[copilot-money-mcp] response shape drift: operation=${operationName} has no registered ` +
          'response schema — register it in MUTATION_RESPONSE_SCHEMAS ' +
          '(src/core/graphql/response-validation.ts) and the conformance ledger'
      );
    }
    return;
  }

  const result = registered.schema.safeParse(data);
  if (result.success) return;

  driftCounts.set(registered.surface, (driftCounts.get(registered.surface) ?? 0) + 1);

  // Warn for EVERY issue (a response dropping several fields at once should
  // name all of them), each deduped per (operation, path, code) per process
  // — so the unique drift inventory is logged in full while repeats stay
  // silent. The dedupe set bounds total output regardless of call volume.
  for (const issue of result.error.issues) {
    const pathStr = issue.path.join('.');
    const key = `${operationName}::${normalizeDriftPath(issue.path)}::${issue.code}`;
    if (warnedKeys.has(key)) continue;
    warnedKeys.add(key);
    // `message` describes expected/received TYPES (and enum option lists over
    // system-controlled values like TransactionType) — it does not embed the
    // user's data; stderr stays local to the user's machine either way.
    console.warn(
      `[copilot-money-mcp] response shape drift: operation=${operationName} ` +
        `surface=${registered.surface} path=${pathStr} code=${issue.code} message="${issue.message}"`
    );
  }
}

// Exposed for tests only: clears the dedupe set and drift counters.
export function __resetResponseDriftState(): void {
  driftCounts.clear();
  warnedKeys.clear();
}
