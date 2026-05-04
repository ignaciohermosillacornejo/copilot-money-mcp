import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

describe('fetchMonthlySpend', () => {
  test('returns the daily spending list as-is from the GraphQL response', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          monthlySpending: [
            { id: 'd1', date: '2026-04-01', totalAmount: '100', comparisonAmount: '90' },
            { id: 'd2', date: '2026-04-02', totalAmount: '200', comparisonAmount: '180' },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchMonthlySpend } =
      await import('../../../../src/core/graphql/queries/monthly-spend.js');
    const rows = await fetchMonthlySpend(client);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(['d1', 'd2']);
    expect(rows[0]?.date).toBe('2026-04-01');
    expect(rows[0]?.totalAmount).toBe('100');
    expect(rows[0]?.comparisonAmount).toBe('90');
  });

  test('passes no variables (MonthlySpend query takes none)', async () => {
    const client = {
      query: mock(() => Promise.resolve({ monthlySpending: [] })),
    } as unknown as GraphQLClient;

    const { fetchMonthlySpend } =
      await import('../../../../src/core/graphql/queries/monthly-spend.js');
    await fetchMonthlySpend(client);

    expect(client.query).toHaveBeenCalledWith('MonthlySpend', expect.any(String), {});
  });

  test('handles empty response without throwing', async () => {
    const client = {
      query: mock(() => Promise.resolve({ monthlySpending: [] })),
    } as unknown as GraphQLClient;

    const { fetchMonthlySpend } =
      await import('../../../../src/core/graphql/queries/monthly-spend.js');
    const rows = await fetchMonthlySpend(client);
    expect(rows).toEqual([]);
  });

  test('preserves null amount fields (future-dated rows)', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          monthlySpending: [
            { id: 'd1', date: '2026-04-01', totalAmount: '100', comparisonAmount: '90' },
            { id: 'd2', date: '2026-04-30', totalAmount: null, comparisonAmount: null },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchMonthlySpend } =
      await import('../../../../src/core/graphql/queries/monthly-spend.js');
    const rows = await fetchMonthlySpend(client);

    expect(rows[1]?.totalAmount).toBeNull();
    expect(rows[1]?.comparisonAmount).toBeNull();
  });
});
