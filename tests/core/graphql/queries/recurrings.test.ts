import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

describe('fetchRecurrings', () => {
  test('returns the flat list as-is from the GraphQL response', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          recurrings: [
            {
              id: 'r1',
              name: 'Netflix',
              state: 'ACTIVE',
              frequency: 'MONTHLY',
              nextPaymentAmount: 15.99,
              nextPaymentDate: '2026-06-01',
              categoryId: 'cat-streaming',
              emoji: '🎬',
              icon: { __typename: 'EmojiUnicode', unicode: '🎬' },
              rule: { nameContains: 'NETFLIX', minAmount: 15, maxAmount: 17, days: [1] },
              payments: [{ amount: 15.99, isPaid: true, date: '2026-05-01' }],
            },
            {
              id: 'r2',
              name: 'Spotify',
              state: 'ACTIVE',
              frequency: 'MONTHLY',
              nextPaymentAmount: 10.99,
              nextPaymentDate: '2026-06-15',
              categoryId: 'cat-streaming',
              emoji: '🎵',
              icon: { __typename: 'EmojiUnicode', unicode: '🎵' },
              rule: null,
              payments: [],
            },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchRecurrings } = await import('../../../../src/core/graphql/queries/recurrings.js');
    const rows = await fetchRecurrings(client);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(rows[0]?.name).toBe('Netflix');
    expect(rows[0]?.rule?.nameContains).toBe('NETFLIX');
    expect(rows[1]?.rule).toBeNull();
  });

  test('passes empty filter (Recurrings server defaults)', async () => {
    const client = {
      query: mock(() => Promise.resolve({ recurrings: [] })),
    } as unknown as GraphQLClient;

    const { fetchRecurrings } = await import('../../../../src/core/graphql/queries/recurrings.js');
    await fetchRecurrings(client);

    expect(client.query).toHaveBeenCalledWith('Recurrings', expect.any(String), {
      filter: null,
    });
  });

  test('handles empty response without throwing', async () => {
    const client = {
      query: mock(() => Promise.resolve({ recurrings: [] })),
    } as unknown as GraphQLClient;

    const { fetchRecurrings } = await import('../../../../src/core/graphql/queries/recurrings.js');
    const rows = await fetchRecurrings(client);
    expect(rows).toEqual([]);
  });
});
