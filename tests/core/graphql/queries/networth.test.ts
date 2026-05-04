import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

describe('fetchNetworthHistory', () => {
  test('returns the flat list as-is from the GraphQL response', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          networthHistory: [
            { date: '2026-01-01', assets: '100000', debt: '5000' },
            { date: '2026-01-02', assets: '101000', debt: '5100' },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchNetworthHistory } = await import(
      '../../../../src/core/graphql/queries/networth.js'
    );
    const rows = await fetchNetworthHistory(client, { timeFrame: 'ALL' });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.date).toBe('2026-01-01');
    expect(rows[0]?.assets).toBe('100000');
    expect(rows[0]?.debt).toBe('5000');
  });

  test('passes timeFrame variable to the query', async () => {
    const client = {
      query: mock(() => Promise.resolve({ networthHistory: [] })),
    } as unknown as GraphQLClient;

    const { fetchNetworthHistory } = await import(
      '../../../../src/core/graphql/queries/networth.js'
    );
    await fetchNetworthHistory(client, { timeFrame: 'YEAR' });

    expect(client.query).toHaveBeenCalledWith('Networth', expect.any(String), {
      timeFrame: 'YEAR',
    });
  });

  test('handles empty response without throwing', async () => {
    const client = {
      query: mock(() => Promise.resolve({ networthHistory: [] })),
    } as unknown as GraphQLClient;

    const { fetchNetworthHistory } = await import(
      '../../../../src/core/graphql/queries/networth.js'
    );
    const rows = await fetchNetworthHistory(client, { timeFrame: 'ALL' });
    expect(rows).toEqual([]);
  });

  test('passes through nullable assets/debt fields (early dates can be null)', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          networthHistory: [{ date: '2022-09-13', assets: null, debt: '500' }],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchNetworthHistory } = await import(
      '../../../../src/core/graphql/queries/networth.js'
    );
    const rows = await fetchNetworthHistory(client, { timeFrame: 'ALL' });

    expect(rows[0]?.assets).toBeNull();
    expect(rows[0]?.debt).toBe('500');
  });
});
