import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

describe('fetchInvestmentLiveBalance', () => {
  test('returns the single investmentLiveBalance row as-is', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          investmentLiveBalance: { id: 'live1', date: '2026-05-04', balance: 562.5 },
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchInvestmentLiveBalance } =
      await import('../../../../src/core/graphql/queries/investment-live-balance.js');
    const row = await fetchInvestmentLiveBalance(client);

    expect(row.id).toBe('live1');
    expect(row.balance).toBe(562.5);
    expect(row.date).toBe('2026-05-04');
  });

  test('passes no variables (InvestmentLiveBalance query takes none)', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          investmentLiveBalance: { id: 'live1', date: '2026-05-04', balance: 100 },
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchInvestmentLiveBalance } =
      await import('../../../../src/core/graphql/queries/investment-live-balance.js');
    await fetchInvestmentLiveBalance(client);

    expect(client.query).toHaveBeenCalledWith('InvestmentLiveBalance', expect.any(String), {});
  });

  test('preserves a zero balance faithfully', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          investmentLiveBalance: { id: 'live2', date: '2026-05-04', balance: 0 },
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchInvestmentLiveBalance } =
      await import('../../../../src/core/graphql/queries/investment-live-balance.js');
    const row = await fetchInvestmentLiveBalance(client);

    expect(row.balance).toBe(0);
  });
});
