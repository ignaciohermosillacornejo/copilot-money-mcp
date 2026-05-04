import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

describe('fetchUpcomingRecurrings', () => {
  test('returns the unpaidUpcomingRecurrings list as-is from the GraphQL response', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          unpaidUpcomingRecurrings: [
            {
              id: 'r1',
              name: 'Subscription A',
              state: 'ACTIVE',
              frequency: 'MONTHLY',
              nextPaymentAmount: 100,
              nextPaymentDate: '2026-05-10',
              categoryId: 'cat-1',
              emoji: 'A',
              icon: { __typename: 'EmojiUnicode', unicode: 'A' },
              rule: { nameContains: 'A', minAmount: 99, maxAmount: 101, days: [10] },
              payments: [{ amount: 100, isPaid: false, date: '2026-05-10' }],
            },
            {
              id: 'r2',
              name: 'Subscription B',
              state: 'ACTIVE',
              frequency: 'MONTHLY',
              nextPaymentAmount: 200,
              nextPaymentDate: '2026-05-15',
              categoryId: 'cat-2',
              emoji: 'B',
              icon: { __typename: 'EmojiUnicode', unicode: 'B' },
              rule: null,
              payments: [],
            },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchUpcomingRecurrings } = await import(
      '../../../../src/core/graphql/queries/upcoming-recurrings.js'
    );
    const rows = await fetchUpcomingRecurrings(client);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(rows[0]?.nextPaymentDate).toBe('2026-05-10');
    expect(rows[0]?.rule?.nameContains).toBe('A');
    expect(rows[1]?.rule).toBeNull();
  });

  test('calls UpcomingRecurrings operation with no variables', async () => {
    const client = {
      query: mock(() => Promise.resolve({ unpaidUpcomingRecurrings: [] })),
    } as unknown as GraphQLClient;

    const { fetchUpcomingRecurrings } = await import(
      '../../../../src/core/graphql/queries/upcoming-recurrings.js'
    );
    await fetchUpcomingRecurrings(client);

    expect(client.query).toHaveBeenCalledWith('UpcomingRecurrings', expect.any(String), {});
  });

  test('handles empty response without throwing', async () => {
    const client = {
      query: mock(() => Promise.resolve({ unpaidUpcomingRecurrings: [] })),
    } as unknown as GraphQLClient;

    const { fetchUpcomingRecurrings } = await import(
      '../../../../src/core/graphql/queries/upcoming-recurrings.js'
    );
    const rows = await fetchUpcomingRecurrings(client);
    expect(rows).toEqual([]);
  });
});
