import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

describe('fetchHoldings', () => {
  test('returns the holdings array as-is from the GraphQL response', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          holdings: [
            {
              id: 'h1',
              accountId: 'a1',
              itemId: 'i1',
              quantity: 10,
              security: {
                id: 's1',
                name: 'Synthetic ETF',
                symbol: 'SYN',
                type: 'EQUITY',
                currentPrice: 100,
                lastUpdate: '2026-05-01T00:00:00Z',
                marketInfo: { closeTime: 1700000000000, openTime: 1700000000000 },
              },
              metrics: { averageCost: 80, costBasis: 800, totalReturn: 200 },
            },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchHoldings } = await import('../../../../src/core/graphql/queries/holdings.js');
    const rows = await fetchHoldings(client);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('h1');
    expect(rows[0]?.security.symbol).toBe('SYN');
    expect(rows[0]?.metrics?.costBasis).toBe(800);
  });

  test('passes no variables (Holdings query takes none)', async () => {
    const client = {
      query: mock(() => Promise.resolve({ holdings: [] })),
    } as unknown as GraphQLClient;

    const { fetchHoldings } = await import('../../../../src/core/graphql/queries/holdings.js');
    await fetchHoldings(client);

    expect(client.query).toHaveBeenCalledWith('Holdings', expect.any(String), {});
  });

  test('preserves null metrics for CASH positions', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          holdings: [
            {
              id: 'h2',
              accountId: 'a1',
              itemId: 'i1',
              quantity: 562.5,
              security: {
                id: 's-cash',
                name: 'Cash',
                symbol: 'CASH',
                type: 'CASH',
                currentPrice: 1,
                lastUpdate: '2026-05-01T00:00:00Z',
                marketInfo: { closeTime: null, openTime: null },
              },
              metrics: null,
            },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchHoldings } = await import('../../../../src/core/graphql/queries/holdings.js');
    const rows = await fetchHoldings(client);

    expect(rows[0]?.metrics).toBeNull();
    expect(rows[0]?.security.marketInfo.closeTime).toBeNull();
  });
});
