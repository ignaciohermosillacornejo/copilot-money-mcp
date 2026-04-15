import { describe, test, expect, mock } from 'bun:test';
import { editAccount } from '../../../src/core/graphql/accounts.js';
import { EDIT_ACCOUNT } from '../../../src/core/graphql/operations.generated.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';

function createMockClient(response: unknown): GraphQLClient {
  return {
    mutate: mock((_op: string, _q: string, _v: unknown) => Promise.resolve(response)),
  } as unknown as GraphQLClient;
}

describe('editAccount', () => {
  test('sends EditAccount with id + itemId + input', async () => {
    const client = createMockClient({
      editAccount: { account: { id: 'a1', isUserHidden: true, name: 'Checking' } },
    });
    await editAccount(client, { id: 'a1', itemId: 'i1', input: { isUserHidden: true } });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('EditAccount');
    expect(call[1]).toBe(EDIT_ACCOUNT);
    expect(call[2]).toEqual({ id: 'a1', itemId: 'i1', input: { isUserHidden: true } });
  });

  test('returns compact { id, changed }', async () => {
    const client = createMockClient({
      editAccount: { account: { id: 'a1', name: 'Checking 2', isUserHidden: false } },
    });
    const out = await editAccount(client, {
      id: 'a1',
      itemId: 'i1',
      input: { name: 'Checking 2' },
    });
    expect(out).toEqual({ id: 'a1', changed: { name: 'Checking 2' } });
  });
});
