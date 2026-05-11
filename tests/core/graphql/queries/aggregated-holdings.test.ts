import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

describe('fetchAggregatedHoldings', () => {
  test('returns the aggregatedHoldings array as-is from the GraphQL response', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          aggregatedHoldings: [
            {
              security: {
                id: 's1',
                name: 'Synthetic ETF',
                symbol: 'SYN',
                type: 'EQUITY',
                lastUpdate: '2026-05-01T00:00:00Z',
                marketInfo: { closeTime: 1700000000000, openTime: 1700000000000 },
              },
              change: 50,
              value: 1000,
            },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchAggregatedHoldings } =
      await import('../../../../src/core/graphql/queries/aggregated-holdings.js');
    const rows = await fetchAggregatedHoldings(client, { timeFrame: 'ONE_MONTH' });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(1000);
    expect(rows[0]?.security.symbol).toBe('SYN');
  });

  test('passes timeFrame, filter, accountId, itemId through', async () => {
    const client = {
      query: mock(() => Promise.resolve({ aggregatedHoldings: [] })),
    } as unknown as GraphQLClient;

    const { fetchAggregatedHoldings } =
      await import('../../../../src/core/graphql/queries/aggregated-holdings.js');
    await fetchAggregatedHoldings(client, {
      timeFrame: 'YTD',
      filter: [],
      accountId: 'a1',
      itemId: 'i1',
    });

    expect(client.query).toHaveBeenCalledWith('AggregatedHoldings', expect.any(String), {
      timeFrame: 'YTD',
      filter: [],
      accountId: 'a1',
      itemId: 'i1',
    });
  });

  test('handles empty response with default opts', async () => {
    const client = {
      query: mock(() => Promise.resolve({ aggregatedHoldings: [] })),
    } as unknown as GraphQLClient;

    const { fetchAggregatedHoldings } =
      await import('../../../../src/core/graphql/queries/aggregated-holdings.js');
    const rows = await fetchAggregatedHoldings(client);

    expect(rows).toEqual([]);
    expect(client.query).toHaveBeenCalledWith('AggregatedHoldings', expect.any(String), {
      timeFrame: undefined,
      filter: undefined,
      accountId: undefined,
      itemId: undefined,
    });
  });
});
