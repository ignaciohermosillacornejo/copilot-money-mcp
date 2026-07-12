import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

describe('fetchSecurityPrices', () => {
  test('returns the securityPrices array as-is from the GraphQL response', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          securityPrices: [
            { id: 'p1', date: '2026-04-01', price: 100 },
            { id: 'p2', date: '2026-04-02', price: 200 },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchSecurityPrices } =
      await import('../../../../src/core/graphql/queries/security-prices.js');
    const rows = await fetchSecurityPrices(client, { id: 's1', timeFrame: 'ONE_MONTH' });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.date).toBe('2026-04-01');
    expect(rows[0]?.price).toBe(100);
  });

  test('passes id and timeFrame through as variables', async () => {
    const client = {
      query: mock(() => Promise.resolve({ securityPrices: [] })),
    } as unknown as GraphQLClient;

    const { fetchSecurityPrices } =
      await import('../../../../src/core/graphql/queries/security-prices.js');
    await fetchSecurityPrices(client, { id: 's1', timeFrame: 'YTD' });

    expect(client.query).toHaveBeenCalledWith('SecurityPrices', expect.any(String), {
      id: 's1',
      timeFrame: 'YTD',
    });
  });

  test('omits timeFrame when not provided', async () => {
    const client = {
      query: mock(() => Promise.resolve({ securityPrices: [] })),
    } as unknown as GraphQLClient;

    const { fetchSecurityPrices } =
      await import('../../../../src/core/graphql/queries/security-prices.js');
    const rows = await fetchSecurityPrices(client, { id: 's1' });

    expect(rows).toEqual([]);
    expect(client.query).toHaveBeenCalledWith('SecurityPrices', expect.any(String), {
      id: 's1',
      timeFrame: undefined,
    });
  });

  test('passes a null-price point through unchanged (#534)', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          securityPrices: [
            { id: 'sec-A', price: null, date: '2026-01-01' },
            { id: 'sec-A', price: 101, date: '2026-01-02' },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchSecurityPrices } =
      await import('../../../../src/core/graphql/queries/security-prices.js');
    const rows = await fetchSecurityPrices(client, { id: 'sec-A', timeFrame: 'ONE_MONTH' });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.price).toBeNull();
    expect(rows[1]?.price).toBe(101);
  });
});
