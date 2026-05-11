import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

describe('fetchSecurityPricesHighFrequency', () => {
  test('returns the securityPricesHighFrequency array as-is', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          securityPricesHighFrequency: [
            { id: 'p1', timestamp: 1700000000000, price: 100 },
            { id: 'p2', timestamp: 1700000060000, price: 200 },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchSecurityPricesHighFrequency } =
      await import('../../../../src/core/graphql/queries/security-prices-high-frequency.js');
    const rows = await fetchSecurityPricesHighFrequency(client, {
      id: 's1',
      timeFrame: 'ONE_DAY',
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.timestamp).toBe(1700000000000);
    expect(rows[1]?.price).toBe(200);
  });

  test('passes id and timeFrame through as variables', async () => {
    const client = {
      query: mock(() => Promise.resolve({ securityPricesHighFrequency: [] })),
    } as unknown as GraphQLClient;

    const { fetchSecurityPricesHighFrequency } =
      await import('../../../../src/core/graphql/queries/security-prices-high-frequency.js');
    await fetchSecurityPricesHighFrequency(client, { id: 's1', timeFrame: 'ONE_WEEK' });

    expect(client.query).toHaveBeenCalledWith('SecurityPricesHighFrequency', expect.any(String), {
      id: 's1',
      timeFrame: 'ONE_WEEK',
    });
  });

  test('handles empty intraday response', async () => {
    const client = {
      query: mock(() => Promise.resolve({ securityPricesHighFrequency: [] })),
    } as unknown as GraphQLClient;

    const { fetchSecurityPricesHighFrequency } =
      await import('../../../../src/core/graphql/queries/security-prices-high-frequency.js');
    const rows = await fetchSecurityPricesHighFrequency(client, { id: 's1' });

    expect(rows).toEqual([]);
  });
});
