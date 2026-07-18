import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

describe('fetchTopMovers', () => {
  test('returns the topMovers array as-is from the GraphQL response', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          topMovers: [
            {
              security: {
                id: 's1',
                name: 'Synthetic ETF',
                symbol: 'SYN',
                type: 'EQUITY',
                currentPrice: 100,
                lastUpdate: 1_777_593_600_000,
                marketInfo: { closeTime: 1700000000000, openTime: 1700000000000 },
              },
              values: [
                { id: 'p1', timestamp: 1700000000000, price: 95 },
                { id: 'p2', timestamp: 1700003600000, price: 100 },
              ],
              change: 5,
            },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchTopMovers } = await import('../../../../src/core/graphql/queries/top-movers.js');
    const rows = await fetchTopMovers(client, { filter: 'PRICE_CHANGE' });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.change).toBe(5);
    expect(rows[0]?.values).toHaveLength(2);
  });

  test('passes the filter variable through', async () => {
    const client = {
      query: mock(() => Promise.resolve({ topMovers: [] })),
    } as unknown as GraphQLClient;

    const { fetchTopMovers } = await import('../../../../src/core/graphql/queries/top-movers.js');
    await fetchTopMovers(client, { filter: 'MY_EQUITY_CHANGE' });

    expect(client.query).toHaveBeenCalledWith('TopMovers', expect.any(String), {
      filter: 'MY_EQUITY_CHANGE',
    });
  });

  test('omits filter when no opts are passed', async () => {
    const client = {
      query: mock(() => Promise.resolve({ topMovers: [] })),
    } as unknown as GraphQLClient;

    const { fetchTopMovers } = await import('../../../../src/core/graphql/queries/top-movers.js');
    const rows = await fetchTopMovers(client);

    expect(rows).toEqual([]);
    expect(client.query).toHaveBeenCalledWith('TopMovers', expect.any(String), {
      filter: undefined,
    });
  });
});
