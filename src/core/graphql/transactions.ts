import type { GraphQLClient } from './client.js';
import {
  CREATE_TRANSACTION,
  DELETE_TRANSACTION,
  EDIT_TRANSACTION,
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
export type TransactionType = 'REGULAR' | 'INCOME' | 'INTERNAL_TRANSFER';

export interface CreateTransactionInput {
  name: string;
  date: string; // YYYY-MM-DD
  amount: number;
  categoryId: string;
  type: TransactionType;
}

export interface CreateTransactionArgs {
  accountId: string;
  itemId: string;
  input: CreateTransactionInput;
}

/**
 * GraphQL response shape for CreateTransaction. Mirrors the Transaction
 * type selected by the generated query (TransactionFields fragment). Kept
 * as `unknown`-tolerant for optional/client-computed fields that the
 * server may or may not populate; only `id` is strictly required by
 * downstream callers.
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

interface CreateTransactionResponse {
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
  return data.createTransaction;
}

export interface EditTransactionInput {
  categoryId?: string;
  userNotes?: string | null;
  tagIds?: string[];
  isReviewed?: boolean;
}

export interface EditTransactionArgs {
  id: string;
  accountId: string;
  itemId: string;
  input: EditTransactionInput;
}

interface EditTransactionResponse {
  editTransaction: {
    transaction: {
      id: string;
      categoryId: string;
      userNotes: string | null;
      isReviewed: boolean;
      tags: Array<{ id: string }>;
    };
  };
}

export interface EditTransactionChanges {
  categoryId?: string;
  userNotes?: string | null;
  isReviewed?: boolean;
  tagIds?: string[];
}

export interface DeleteTransactionArgs {
  id: string;
  accountId: string;
  itemId: string;
}

interface DeleteTransactionResponse {
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

export async function editTransaction(
  client: GraphQLClient,
  args: EditTransactionArgs
): Promise<{ id: string; changed: EditTransactionChanges }> {
  const data = await client.mutate<EditTransactionArgs, EditTransactionResponse>(
    'EditTransaction',
    EDIT_TRANSACTION,
    args
  );
  const tx = data.editTransaction.transaction;
  const changed: EditTransactionChanges = {};
  // Report back fields the caller named in args.input — keyed by presence,
  // not by value. Lets callers explicitly "change to undefined" if ever needed;
  // tools.ts builds args.input via conditional spread so explicit-undefined
  // shouldn't normally reach us.
  if ('categoryId' in args.input) changed.categoryId = tx.categoryId;
  if ('userNotes' in args.input) changed.userNotes = tx.userNotes;
  if ('isReviewed' in args.input) changed.isReviewed = tx.isReviewed;
  if ('tagIds' in args.input) changed.tagIds = tx.tags.map((t) => t.id);
  return { id: tx.id, changed };
}
