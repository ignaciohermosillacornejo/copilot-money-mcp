import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

describe('fetchInvestmentBalance', () => {
  test('returns the investmentBalance array as-is from the GraphQL response', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          investmentBalance: [
            { id: 'd1', date: '2026-04-01', balance: 100 },
            { id: 'd2', date: '2026-04-02', balance: 200 },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchInvestmentBalance } =
      await import('../../../../src/core/graphql/queries/investment-balance.js');
    const rows = await fetchInvestmentBalance(client, { timeFrame: 'ONE_MONTH' });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.balance).toBe(100);
    expect(rows[1]?.date).toBe('2026-04-02');
  });

  test('passes timeFrame through as a variable', async () => {
    const client = {
      query: mock(() => Promise.resolve({ investmentBalance: [] })),
    } as unknown as GraphQLClient;

    const { fetchInvestmentBalance } =
      await import('../../../../src/core/graphql/queries/investment-balance.js');
    await fetchInvestmentBalance(client, { timeFrame: 'ALL' });

    expect(client.query).toHaveBeenCalledWith('InvestmentBalance', expect.any(String), {
      timeFrame: 'ALL',
    });
  });

  test('handles empty response with default opts', async () => {
    const client = {
      query: mock(() => Promise.resolve({ investmentBalance: [] })),
    } as unknown as GraphQLClient;

    const { fetchInvestmentBalance } =
      await import('../../../../src/core/graphql/queries/investment-balance.js');
    const rows = await fetchInvestmentBalance(client);

    expect(rows).toEqual([]);
    expect(client.query).toHaveBeenCalledWith('InvestmentBalance', expect.any(String), {
      timeFrame: undefined,
    });
  });
});
