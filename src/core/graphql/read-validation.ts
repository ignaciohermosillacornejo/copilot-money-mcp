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

// Strict on write-critical fields; everything else typed-permissive per the
// TransactionNode interface. looseObject(): unknown extra fields are fine.
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
  tags: z.array(z.looseObject({ id: z.string() })),
  goal: z.unknown().nullable(),
});

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
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
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
