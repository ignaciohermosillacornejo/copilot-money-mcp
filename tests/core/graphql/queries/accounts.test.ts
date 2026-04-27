import { describe, expect, test, mock } from 'bun:test';
import { fetchAccounts, type AccountNode } from '../../../../src/core/graphql/queries/accounts.js';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';
import { ACCOUNTS } from '../../../../src/core/graphql/operations.generated.js';

describe('fetchAccounts', () => {
  test('returns the accounts array from a successful query', async () => {
    const fakeClient = {
      query: mock(async () => ({
        accounts: [
          {
            id: 'acc1',
            itemId: 'item1',
            name: 'Checking',
            balance: 1000,
            liveBalance: true,
            type: 'depository',
            subType: 'checking',
            mask: '0001',
            isUserHidden: false,
            isUserClosed: false,
            isManual: false,
            color: '#fff',
            limit: null,
            institutionId: 'inst1',
            hasHistoricalUpdates: true,
            hasLiveBalance: true,
            latestBalanceUpdate: '2026-04-25T00:00:00Z',
          } as AccountNode,
        ],
      })),
    } as unknown as GraphQLClient;

    const rows = await fetchAccounts(fakeClient);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Checking');
    expect(rows[0]?.id).toBe('acc1');
  });

  test('returns empty array when accounts is empty', async () => {
    const fakeClient = {
      query: mock(async () => ({ accounts: [] })),
    } as unknown as GraphQLClient;

    const rows = await fetchAccounts(fakeClient);
    expect(rows).toEqual([]);
  });

  test('passes the ACCOUNTS query string to client.query', async () => {
    const queryFn = mock(async () => ({ accounts: [] }));
    const fakeClient = { query: queryFn } as unknown as GraphQLClient;

    await fetchAccounts(fakeClient);

    expect(queryFn.mock.calls.length).toBe(1);
    const [opName, opString] = queryFn.mock.calls[0] as unknown as [string, string];
    expect(opName).toBe('Accounts');
    expect(opString).toBe(ACCOUNTS);
  });
});
