import type { GraphQLClient } from './client.js';
import { committedPayload } from './graphql-error.js';
import {
  ADD_TRANSACTION_TO_RECURRING,
  BULK_EDIT_TRANSACTIONS,
  CREATE_TRANSACTION,
  DELETE_TRANSACTION,
  EDIT_TRANSACTION,
  SPLIT_TRANSACTION,
} from './operations.generated.js';

/**
 * TransactionType enum values accepted by Copilot's GraphQL schema.
 *
 * Verified exhaustively against the live endpoint on 2026-04-21:
 *   - Typo probes (REGULR, INCOM, INTERNA_TRANSFER, etc.) surface "Did you
 *     mean REGULAR / INCOME / INTERNAL_TRANSFER" — no other enum values
 *     appeared across broad sweeps.
 *   - Accepted values pass the enum layer and fail downstream on ID
 *     validation, confirming the enum match.
 */
export const TRANSACTION_TYPES = ['REGULAR', 'INCOME', 'INTERNAL_TRANSFER'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export interface CreateTransactionInput {
  name: string;
  date: string; // YYYY-MM-DD
  amount: number;
  categoryId: string;
  type: TransactionType;
  tagIds?: string[];
  userNotes?: string | null;
  recurringId?: string;
}

export interface CreateTransactionArgs {
  accountId: string;
  itemId: string;
  input: CreateTransactionInput;
}

/**
 * A transaction as every transaction mutation returns it: the mutations'
 * TransactionFields fragment (createTransaction, editTransaction,
 * addTransactionToRecurring, splitTransaction, bulkEditTransactions).
 *
 * This is also what the live window cache is patched from after a write
 * (`LiveCopilotDatabase.upsertLiveTransaction`, #820/#821), so every field
 * here is consumed. Note what the mutation fragment does NOT select, unlike
 * the Transactions query's: `parentId` (except bulkEditTransactions) and
 * `isoCurrencyCode`.
 */
export interface CreatedTransaction {
  id: string;
  name: string;
  date: string;
  amount: number;
  categoryId: string;
  type: TransactionType;
  accountId: string;
  itemId: string;
  isPending: boolean;
  isReviewed: boolean;
  createdAt: number;
  recurringId: string | null;
  userNotes: string | null;
  tipAmount: number | null;
  suggestedCategoryIds: string[];
  tags: Array<{ id: string; name: string; colorName: string }>;
  goal: { id: string; name: string } | null;
}

export interface CreateTransactionResponse {
  createTransaction: CreatedTransaction;
}

export async function createTransaction(
  client: GraphQLClient,
  args: CreateTransactionArgs
): Promise<CreatedTransaction> {
  const data = await client.mutate<CreateTransactionArgs, CreateTransactionResponse>(
    'CreateTransaction',
    CREATE_TRANSACTION,
    args
  );
  return committedPayload<CreatedTransaction>(
    'CreateTransaction',
    (data as Partial<CreateTransactionResponse> | null)?.createTransaction,
    'createTransaction'
  );
}

export interface EditTransactionInput {
  name?: string;
  categoryId?: string;
  userNotes?: string | null;
  tagIds?: string[];
  isReviewed?: boolean;
  type?: TransactionType;
  date?: string; // YYYY-MM-DD
  amount?: number;
}

export interface EditTransactionArgs {
  id: string;
  accountId: string;
  itemId: string;
  input: EditTransactionInput;
}

export interface EditTransactionResponse {
  editTransaction: {
    /** The full TransactionFields selection — see {@link CreatedTransaction}. */
    transaction: CreatedTransaction;
  };
}

export interface EditTransactionChanges {
  name?: string;
  categoryId?: string;
  userNotes?: string | null;
  isReviewed?: boolean;
  tagIds?: string[];
  type?: TransactionType;
  date?: string;
  amount?: number;
}

/**
 * The five fields `BulkEditTransactionInput` actually accepts.
 *
 * Enumerated exhaustively by error-leak probe (2026-08-01): every other
 * candidate — `name`, `date`, `amount`, `userNotes`, `tagIds`, `recurringId`,
 * `goalId`, `parentId`, `isExcluded` — came back "not defined by type
 * BulkEditTransactionInput". Those remain `editTransaction`-only, which is why
 * the per-row fan-out cannot be retired.
 *
 * Note `addTagIds`/`removeTagIds`: tags are add/remove here, NOT set. There is
 * no bulk "replace the tag list" operation, so this is not interchangeable
 * with `EditTransactionInput.tagIds`.
 */
export interface BulkEditTransactionInput {
  categoryId?: string;
  addTagIds?: string[];
  removeTagIds?: string[];
  type?: TransactionType;
  isReviewed?: boolean;
}

/** One row's routing triple. All three are `ID!` server-side. */
export interface TransactionIdentifierInput {
  id: string;
  accountId: string;
  itemId: string;
}

/**
 * Args for {@link bulkEditTransactions}.
 *
 * `ids` is a REQUIRED non-empty tuple type, not an optional filter. That is
 * deliberate and load-bearing: the wire signature is
 * `bulkEditTransactions(filter: TransactionFilter, input: BulkEditTransactionInput!)`
 * where **filter is nullable**, so a filterless call is valid GraphQL whose row
 * set is unbounded — it would apply `input` to every transaction the server
 * decides to match. `TransactionFilter` also accepts `dates`, `categoryIds`,
 * `isReviewed`, `types`, … any of which would silently widen the blast radius.
 *
 * This wrapper therefore exposes ONLY id-targeting and makes the dangerous
 * shapes unrepresentable rather than merely discouraged. Do not add a
 * pass-through `filter` parameter.
 */
export interface BulkEditTransactionsArgs {
  ids: [TransactionIdentifierInput, ...TransactionIdentifierInput[]];
  input: BulkEditTransactionInput;
}

export interface BulkEditTransactionsResponse {
  bulkEditTransactions: {
    /**
     * The full TransactionFields selection. Bulk's fragment, unlike the other
     * transaction mutations', also selects `parentId`.
     */
    updated: Array<CreatedTransaction & { parentId: string | null }>;
    failed: Array<{
      transaction: { id: string } | null;
      error: string | null;
      errorCode: string;
    }>;
  };
}

export interface BulkEditTransactionsResult {
  /** Rows the server confirmed it wrote, in server order. */
  updated: BulkEditTransactionsResponse['bulkEditTransactions']['updated'];
  /** Per-row server rejections. Empty in every probe to date — see `skipped`. */
  failed: BulkEditTransactionsResponse['bulkEditTransactions']['failed'];
  /**
   * Requested ids the server neither updated NOR reported in `failed`.
   *
   * This is the load-bearing half of the result. Verified live (2026-08-01):
   * an id that does not exist is **silently dropped** from the row set — it
   * does not raise, and it does not appear in `failed[]`. Trusting `failed[]`
   * alone would report a clean success for a batch that wrote nothing.
   * Callers must treat a non-empty `skipped` as a partial failure.
   */
  skipped: string[];
}

/**
 * Apply ONE edit to MANY transactions in a single request.
 *
 * Semantics that differ from `editTransaction` and bite if assumed away
 * (all verified live 2026-08-01 against disposable rows):
 *
 * - **One input, many rows.** There is no per-row input. This is "same change
 *   to this set", not a batch of independent edits.
 * - **No referential validation.** A `categoryId` that does not exist is
 *   accepted verbatim and persisted as a dangling reference; a nonexistent tag
 *   id is silently dropped. The server validates neither, so callers MUST
 *   validate ids before calling.
 * - **Unknown ids vanish silently** — see {@link BulkEditTransactionsResult.skipped}.
 * - **`type: INCOME | INTERNAL_TRANSFER` clears the category** server-side,
 *   same as `editTransaction`.
 */
export async function bulkEditTransactions(
  client: GraphQLClient,
  args: BulkEditTransactionsArgs
): Promise<BulkEditTransactionsResult> {
  // Defense in depth: the type system already forbids an empty tuple, but this
  // module is reachable from JS callers and the failure mode is unbounded
  // writes, so re-check at runtime rather than trusting the cast.
  // mutation-guard: bulk write refuses an unbounded row set
  if (!Array.isArray(args.ids) || args.ids.length === 0) {
    throw new Error(
      'bulkEditTransactions: refusing to send without explicit target ids — ' +
        'an unfiltered bulk edit applies to an unbounded row set'
    );
  }
  const data = await client.mutate<
    { input: BulkEditTransactionInput; filter: { ids: TransactionIdentifierInput[] } },
    BulkEditTransactionsResponse
  >('BulkEditTransactions', BULK_EDIT_TRANSACTIONS, {
    input: args.input,
    // `ids` is the ONLY filter key ever sent. See BulkEditTransactionsArgs.
    // mutation-guard: bulk filter carries only ids
    filter: { ids: args.ids.map(({ id, accountId, itemId }) => ({ id, accountId, itemId })) },
  });
  // The batch has committed by now. Response validation is warn-only, so a
  // drifted `updated` or `failed` that is not an array is read as empty rather
  // than thrown on: its rows then surface as `skipped`, whose live months the
  // tool layer drops (#864 review).
  const response = data.bulkEditTransactions as Partial<
    BulkEditTransactionsResponse['bulkEditTransactions']
  > | null;
  // Elements too: an `updated` row without a string id, or a `failed` entry
  // that is not an object, is dropped here, so the ids it stood for land in
  // `skipped` instead of throwing in a caller's loop.
  const updated = (Array.isArray(response?.updated) ? response.updated : []).filter(
    (t: unknown) =>
      t !== null && typeof t === 'object' && typeof (t as { id?: unknown }).id === 'string'
  );
  const failed = (Array.isArray(response?.failed) ? response.failed : []).filter(
    (f: unknown) => f !== null && typeof f === 'object'
  );
  const accountedFor = new Set<string>([
    ...updated.map((t) => t.id),
    ...failed.map((f) => f.transaction?.id).filter((id): id is string => typeof id === 'string'),
  ]);
  return {
    updated,
    failed,
    skipped: args.ids.map((t) => t.id).filter((id) => !accountedFor.has(id)),
  };
}

export interface DeleteTransactionArgs {
  id: string;
  accountId: string;
  itemId: string;
}

export interface DeleteTransactionResponse {
  deleteTransaction: boolean;
}

/**
 * Permanently delete a transaction. Requires all three IDs — the server
 * has no "look up the other two from id" fallback, and the tool layer
 * deliberately does not supply one so a typo in any single field fails
 * with "Transaction not found" rather than silently hitting a different
 * transaction.
 *
 * Returns the raw Boolean from the server unchanged. Copilot returns
 * `true` on success; any other value surfaces through untouched so
 * callers can observe drift from the documented contract.
 */
export async function deleteTransaction(
  client: GraphQLClient,
  args: DeleteTransactionArgs
): Promise<boolean> {
  const data = await client.mutate<DeleteTransactionArgs, DeleteTransactionResponse>(
    'DeleteTransaction',
    DELETE_TRANSACTION,
    args
  );
  return data.deleteTransaction;
}

export interface AddTransactionToRecurringInput {
  recurringId: string; // the only field accepted by the server
}

export interface AddTransactionToRecurringArgs {
  id: string; // transaction to attach
  accountId: string;
  itemId: string;
  input: AddTransactionToRecurringInput;
}

export interface AddTransactionToRecurringResponse {
  addTransactionToRecurring: {
    transaction: CreatedTransaction;
  };
}

/**
 * Manually link an existing transaction to an existing recurring series.
 *
 * The mutation's output type has exactly one field (`transaction`), and
 * the transaction it returns matches the same TransactionFields shape as
 * createTransaction. We unwrap the `transaction` level here so callers get
 * the same CreatedTransaction shape in both cases.
 *
 * The input type accepts only `recurringId: ID!` — probes for `date`,
 * `isReviewed`, `notes`, and `tagIds` all returned "not defined" (see
 * hidden-mutations.md). Downstream metadata edits require a follow-up
 * `editTransaction` call.
 */
export async function addTransactionToRecurring(
  client: GraphQLClient,
  args: AddTransactionToRecurringArgs
): Promise<CreatedTransaction> {
  const data = await client.mutate<
    AddTransactionToRecurringArgs,
    AddTransactionToRecurringResponse
  >('AddTransactionToRecurring', ADD_TRANSACTION_TO_RECURRING, args);
  return committedPayload<CreatedTransaction>(
    'AddTransactionToRecurring',
    (data as Partial<AddTransactionToRecurringResponse> | null)?.addTransactionToRecurring
      ?.transaction,
    'addTransactionToRecurring.transaction'
  );
}

export interface SplitTransactionInput {
  name: string; // required — no per-split default on the server side
  date: string; // YYYY-MM-DD; required — server rejects missing date
  amount: number; // required; children must sum to parent.amount (server-enforced)
  categoryId: string; // required
}

export interface SplitTransactionArgs {
  id: string; // the parent transaction being split
  accountId: string;
  itemId: string;
  input: SplitTransactionInput[]; // one entry per child
}

export interface SplitTransactionResult {
  parentTransaction: CreatedTransaction;
  splitTransactions: CreatedTransaction[];
}

export interface SplitTransactionResponse {
  splitTransaction: SplitTransactionResult;
}

/**
 * Split one parent transaction into N child transactions.
 *
 * SplitTransactionOutput has exactly two fields — `parentTransaction` and
 * `splitTransactions` — both matching the same TransactionFields shape as
 * createTransaction. The wrapper returns both levels so callers can emit
 * a combined response (the parent is hidden by Copilot's UI after a split
 * but not deleted — the children carry `parent_transaction_id` back to it,
 * and there is no reversal mutation).
 *
 * Probed input optionals (`tagIds`, `notes`, `isReviewed`) all rejected by
 * the server as "not defined by type SplitTransactionInput" — any post-split
 * metadata edits require per-child `editTransaction` calls.
 */
export async function splitTransaction(
  client: GraphQLClient,
  args: SplitTransactionArgs
): Promise<SplitTransactionResult> {
  const data = await client.mutate<SplitTransactionArgs, SplitTransactionResponse>(
    'SplitTransaction',
    SPLIT_TRANSACTION,
    args
  );
  // Only the envelope is required here: split_transaction already tolerates
  // drift inside it (its children array, each child's fields), and needs the
  // write classified as applied so it can record the split parent (#822).
  return committedPayload<SplitTransactionResult>(
    'SplitTransaction',
    (data as Partial<SplitTransactionResponse> | null)?.splitTransaction,
    'splitTransaction'
  );
}

/**
 * The tag ids on a row the server returned, or undefined when it carries no
 * `tags` array or any entry has no string id. All or nothing: a partly
 * drifted list is not shortened into a list that looks authoritative.
 * Response validation is warn-only, so a drifted response must not throw a
 * TypeError out of a write the server has already applied (#864 review);
 * callers fall back to what they asked for, or leave the cache alone.
 */
export function returnedTagIds(tags: unknown): string[] | undefined {
  if (!Array.isArray(tags)) return undefined;
  const ids: string[] = [];
  for (const t of tags as unknown[]) {
    const id = (t as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') return undefined;
    ids.push(id);
  }
  return ids;
}

export async function editTransaction(
  client: GraphQLClient,
  args: EditTransactionArgs
): Promise<{ id: string; changed: EditTransactionChanges; transaction: CreatedTransaction }> {
  const data = await client.mutate<EditTransactionArgs, EditTransactionResponse>(
    'EditTransaction',
    EDIT_TRANSACTION,
    args
  );
  // A null row after a committed edit is classified, not a TypeError (#875):
  // the caller's catch then drops the live months instead of patching them.
  const tx = committedPayload<CreatedTransaction>(
    'EditTransaction',
    (data as Partial<EditTransactionResponse> | null)?.editTransaction?.transaction,
    'editTransaction.transaction'
  );
  const changed: EditTransactionChanges = {};
  // Report back fields the caller named in args.input — keyed by presence,
  // not by value. Lets callers explicitly "change to undefined" if ever needed;
  // tools.ts builds args.input via conditional spread so explicit-undefined
  // shouldn't normally reach us.
  if ('name' in args.input) changed.name = tx.name;
  if ('categoryId' in args.input) changed.categoryId = tx.categoryId;
  if ('userNotes' in args.input) changed.userNotes = tx.userNotes;
  if ('isReviewed' in args.input) changed.isReviewed = tx.isReviewed;
  // Callers read only which keys `changed` has; the value is informational,
  // and the guard keeps a drifted response from throwing after the write.
  if ('tagIds' in args.input) changed.tagIds = returnedTagIds(tx.tags);
  if ('type' in args.input) changed.type = tx.type;
  if ('date' in args.input) changed.date = tx.date;
  if ('amount' in args.input) changed.amount = tx.amount;
  // `transaction` is the server's whole post-edit row, for the live cache
  // write-through (#821) — patch from what the server says, not from a
  // locally-translated copy of the input.
  return { id: tx.id, changed, transaction: tx };
}
