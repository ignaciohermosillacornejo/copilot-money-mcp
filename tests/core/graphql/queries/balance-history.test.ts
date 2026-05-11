import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

describe('fetchAccountBalanceHistory', () => {
  test('returns the accountBalanceHistory array as-is from the GraphQL response', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          accountBalanceHistory: [
            { date: '2026-04-01', balance: 100 },
            { date: '2026-04-02', balance: 200 },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchAccountBalanceHistory } =
      await import('../../../../src/core/graphql/queries/balance-history.js');
    const rows = await fetchAccountBalanceHistory(client, {
      itemId: 'i1',
      accountId: 'a1',
      timeFrame: 'ONE_MONTH',
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.date).toBe('2026-04-01');
    expect(rows[1]?.balance).toBe(200);
  });

  test('passes itemId, accountId, timeFrame through as variables', async () => {
    const client = {
      query: mock(() => Promise.resolve({ accountBalanceHistory: [] })),
    } as unknown as GraphQLClient;

    const { fetchAccountBalanceHistory } =
      await import('../../../../src/core/graphql/queries/balance-history.js');
    await fetchAccountBalanceHistory(client, {
      itemId: 'i1',
      accountId: 'a1',
      timeFrame: 'YTD',
    });

    expect(client.query).toHaveBeenCalledWith('BalanceHistory', expect.any(String), {
      itemId: 'i1',
      accountId: 'a1',
      timeFrame: 'YTD',
    });
  });

  test('handles empty response and omits timeFrame when not provided', async () => {
    const client = {
      query: mock(() => Promise.resolve({ accountBalanceHistory: [] })),
    } as unknown as GraphQLClient;

    const { fetchAccountBalanceHistory } =
      await import('../../../../src/core/graphql/queries/balance-history.js');
    const rows = await fetchAccountBalanceHistory(client, { itemId: 'i1', accountId: 'a1' });

    expect(rows).toEqual([]);
    expect(client.query).toHaveBeenCalledWith('BalanceHistory', expect.any(String), {
      itemId: 'i1',
      accountId: 'a1',
      timeFrame: undefined,
    });
  });
});
