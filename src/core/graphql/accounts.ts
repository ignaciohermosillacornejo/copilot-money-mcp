import type { GraphQLClient } from './client.js';
import { EDIT_ACCOUNT } from './operations.generated.js';

export interface EditAccountInput {
  name?: string;
  isUserHidden?: boolean;
}

export interface EditAccountChanges {
  name?: string;
  isUserHidden?: boolean;
}

interface EditAccountResponse {
  editAccount: {
    account: {
      id: string;
      name: string;
      isUserHidden: boolean;
    };
  };
}

export async function editAccount(
  client: GraphQLClient,
  args: { id: string; itemId: string; input: EditAccountInput }
): Promise<{ id: string; changed: EditAccountChanges }> {
  const data = await client.mutate<
    { id: string; itemId: string; input: EditAccountInput },
    EditAccountResponse
  >('EditAccount', EDIT_ACCOUNT, args);
  const account = data.editAccount.account;
  // Report back fields the caller named in args.input — keyed by presence,
  // not by value. Lets callers explicitly "change to undefined" if ever needed;
  // tools.ts builds args.input via conditional spread so explicit-undefined
  // shouldn't normally reach us.
  const changed: EditAccountChanges = {};
  if ('name' in args.input) changed.name = account.name;
  if ('isUserHidden' in args.input) changed.isUserHidden = account.isUserHidden;
  return { id: account.id, changed };
}
