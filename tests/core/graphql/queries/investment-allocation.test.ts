import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

describe('fetchInvestmentAllocation', () => {
  test('returns the investmentAllocation array as-is from the GraphQL response', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          investmentAllocation: [
            { id: 'a1', type: 'EQUITY', amount: 800, percentage: 80 },
            { id: 'a2', type: 'CASH', amount: 200, percentage: 20 },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchInvestmentAllocation } =
      await import('../../../../src/core/graphql/queries/investment-allocation.js');
    const rows = await fetchInvestmentAllocation(client);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.type).toBe('EQUITY');
    expect(rows[1]?.amount).toBe(200);
  });

  test('passes filter through as a variable', async () => {
    const client = {
      query: mock(() => Promise.resolve({ investmentAllocation: [] })),
    } as unknown as GraphQLClient;

    const { fetchInvestmentAllocation } =
      await import('../../../../src/core/graphql/queries/investment-allocation.js');
    await fetchInvestmentAllocation(client, { filter: { accountId: 'a1', itemId: 'i1' } });

    expect(client.query).toHaveBeenCalledWith('InvestmentAllocation', expect.any(String), {
      filter: { accountId: 'a1', itemId: 'i1' },
    });
  });

  test('handles empty response with no filter', async () => {
    const client = {
      query: mock(() => Promise.resolve({ investmentAllocation: [] })),
    } as unknown as GraphQLClient;

    const { fetchInvestmentAllocation } =
      await import('../../../../src/core/graphql/queries/investment-allocation.js');
    const rows = await fetchInvestmentAllocation(client);

    expect(rows).toEqual([]);
    expect(client.query).toHaveBeenCalledWith('InvestmentAllocation', expect.any(String), {
      filter: undefined,
    });
  });
});
