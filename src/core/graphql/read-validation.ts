/**
 * Read-shape validation (#512): warn-and-skip per-node validation for
 * GraphQL READ responses. Mutations are covered by response-validation.ts;
 * this module covers reads whose nodes feed write-critical state — today
 * only the Transactions query, whose accountId/itemId flow into
 * EditTransaction/CreateRecurring variables via the meta index (#508).
 *
 * Policy (design 2026-07-06): a malformed node must never brick reads or
 * poison writes — it is dropped from the returned page (and therefore from
 * the window cache and meta index, which are fed downstream of this strip),
 * counted, and surfaced via _dropped_invalid_rows plus a deduped stderr
 * warning. Strict only on write-critical fields; unknown extra fields and
 * unrecognized enum values never fail a node.
 */

import { z } from 'zod';
import type { TransactionsPage } from './queries/transactions.js';

/** Registered in RUNTIME_CHECK_NAMES; the Query.transactions:response
 *  ledger entry's oracle is `runtime:${this}`. */
export const TRANSACTIONS_READ_SHAPE_RUNTIME_CHECK = 'transactions-read-shape' as const;

export interface InvalidNodeInfo {
  /** The node's id when itself readable, else null. */
  id: string | null;
  /** The strict fields that failed validation. */
  fields: string[];
}

// Strict on write-critical fields (id/accountId/itemId/date/amount/name:
// value constraints); everything else typed-permissive per the
// TransactionNode interface. "Typed-permissive" means permissive on VALUE
// (any string satisfies `type`, unknown extra fields pass), but PRESENCE of
// every listed field is still required: the fragment selects them, and a
// node missing a typed field would leak `undefined` into downstream
// sorting/filters — a visible drop (counter + warning) is safer than
// silent undefined propagation. looseObject(): unknown extra fields are
// fine, never a failure.
const transactionNodeSchema = z.looseObject({
  id: z.string().min(1),
  accountId: z.string().min(1),
  itemId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number().finite(),
  name: z.string(),
  categoryId: z.string().nullable(),
  recurringId: z.string().nullable(),
  parentId: z.string().nullable(),
  isReviewed: z.boolean(),
  isPending: z.boolean(),
  type: z.string(),
  userNotes: z.string().nullable(),
  tipAmount: z.number().nullable(),
  suggestedCategoryIds: z.array(z.string()),
  isoCurrencyCode: z.string().nullable(),
  createdAt: z.number(),
  // A tag missing `id` drops the whole node deliberately: tag ids from
  // reads round-trip into update_transaction.tag_ids write params, so a
  // malformed tag is write-relevant drift, not cosmetic.
  tags: z.array(z.looseObject({ id: z.string() })),
  goal: z.unknown(),
});

/**
 * The same definition, for a row a MUTATION returned, before the live cache
 * stores it (#864). Mutation responses are validated warn-only, so this is
 * the one check between a drifted mutation row and the cache the read path
 * protects with the schema above: one definition of a usable row for both
 * paths, so a field the reads require is required here without a second
 * list to keep in sync. Omitted, and why:
 *  - parentId, isoCurrencyCode: the mutation fragment does not select them
 *    (see CreatedTransaction); upsertLiveTransaction defaults both.
 *  - accountId, itemId: routing drift has its own handling there (an empty
 *    or non-string id never overwrites a cached one, and a row without them
 *    is never inserted), which a refusal here would pre-empt.
 */
const mutationRowSchema = transactionNodeSchema.omit({
  parentId: true,
  isoCurrencyCode: true,
  accountId: true,
  itemId: true,
});

/**
 * The top-level fields of a mutation's returned transaction row that fail
 * {@link mutationRowSchema}; empty when the row is usable. Field NAMES only,
 * never values.
 */
export function invalidMutationRowFields(node: unknown): string[] {
  const parsed = mutationRowSchema.safeParse(node);
  if (parsed.success) return [];
  return [
    ...new Set(parsed.error.issues.map((i) => (i.path[0] != null ? String(i.path[0]) : '<root>'))),
  ];
}

/** Whether a mutation's returned transaction row passes {@link mutationRowSchema}. */
export function isUsableMutationTransactionRow(node: unknown): boolean {
  return invalidMutationRowFields(node).length === 0;
}

/** Ledger surface for the assumption {@link mutationRowSchema} rests on. */
export const MUTATION_ROW_READ_SCHEMA_SURFACE =
  'Mutation.TransactionFields:read-schema-parity' as const;

/**
 * Return the page with invalid nodes removed. Valid nodes are returned as
 * the ORIGINAL objects (validation only — no transformation). Each removal
 * invokes onInvalidNode with the node id (when readable) and the failed
 * strict fields.
 */
export function stripInvalidTransactionNodes(
  page: TransactionsPage,
  onInvalidNode?: (info: InvalidNodeInfo) => void
): TransactionsPage {
  const edges = page.edges.filter((edge) => {
    const parsed = transactionNodeSchema.safeParse(edge.node);
    if (parsed.success) return true;
    const fields = [
      ...new Set(
        parsed.error.issues.map((i) => (i.path[0] != null ? String(i.path[0]) : '<root>'))
      ),
    ];
    const rawId = (edge.node as { id?: unknown })?.id;
    const id =
      typeof rawId === 'string' && rawId.length > 0 && !fields.includes('id') ? rawId : null;
    onInvalidNode?.({ id, fields });
    return false;
  });
  if (edges.length === page.edges.length) return page;
  return { edges, pageInfo: page.pageInfo };
}

// Dedupe stderr warnings per (op, failed-field set) so a drifted server
// can't spam one line per row.
const warned = new Set<string>();

/** Test hook — dedupe state is module-level. */
export function __resetReadShapeWarnDedupe(): void {
  warned.clear();
}

/**
 * The write-side counterpart of {@link warnReadShapeDrift} (#864): a row a
 * mutation returned was refused by the live cache. Warn once per failed-field
 * set, naming the fields and never their values, so a systematic drift that
 * turns every write into a month refetch is visible rather than silent.
 * `droppedMonths` is how many cached months the refusal actually dropped, so
 * the line reports the outcome instead of promising a refetch that a write
 * to an uncached month never needs (#875).
 */
export function warnMutationRowRefused(info: InvalidNodeInfo, droppedMonths: number): void {
  const key = `mutation-row:${[...info.fields].sort().join(',')}`;
  if (warned.has(key)) return;
  warned.add(key);
  const outcome =
    droppedMonths > 0
      ? `the ${droppedMonths === 1 ? 'cached month' : `${droppedMonths} cached months`} it ` +
        `touched ${droppedMonths === 1 ? 'was' : 'were'} dropped, so the next read refetches ` +
        `from the server`
      : 'no cached month held it, so nothing was dropped and the next read of its month ' +
        'fetches from the server';
  console.warn(
    `[copilot-money-mcp] mutation-row drift: transaction ${info.id ?? '<unreadable id>'} not ` +
      `stored in the live cache (invalid ${info.fields.join(', ')}); ${outcome} — see ` +
      `${MUTATION_ROW_READ_SCHEMA_SURFACE} in the conformance ledger ` +
      `(src/conformance/ledger.ts). Further identical refusals this session are not logged.`
  );
}

export function warnReadShapeDrift(op: string, info: InvalidNodeInfo): void {
  const key = `${op}:${[...info.fields].sort().join(',')}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    `[copilot-money-mcp] read-shape drift: ${op} node ${info.id ?? '<unreadable id>'} dropped ` +
      `(invalid ${info.fields.join(', ')}) — see Query.transactions:response in the conformance ledger ` +
      `(src/conformance/ledger.ts). Further identical drops this session are counted but not logged.`
  );
}
