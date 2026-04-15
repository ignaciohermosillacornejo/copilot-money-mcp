import type { GraphQLClient } from './client.js';
import { EDIT_TRANSACTION } from './operations.generated.js';

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
      categoryId?: string;
      userNotes?: string | null;
      isReviewed?: boolean;
      tags?: Array<{ id: string }>;
    };
  };
}

export async function editTransaction(
  client: GraphQLClient,
  args: EditTransactionArgs
): Promise<{ id: string; changed: Record<string, unknown> }> {
  const data = await client.mutate<EditTransactionArgs, EditTransactionResponse>(
    'EditTransaction',
    EDIT_TRANSACTION,
    args
  );
  const tx = data.editTransaction.transaction;
  const changed: Record<string, unknown> = {};
  // Only report back the fields the caller asked to change.
  if ('categoryId' in args.input) changed.categoryId = tx.categoryId;
  if ('userNotes' in args.input) changed.userNotes = tx.userNotes;
  if ('isReviewed' in args.input) changed.isReviewed = tx.isReviewed;
  if ('tagIds' in args.input) changed.tagIds = (tx.tags ?? []).map((t) => t.id);
  return { id: tx.id, changed };
}
