import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

describe('fetchTags', () => {
  test('returns the flat list as-is from the GraphQL response', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          tags: [
            { id: 't1', name: 'travel', colorName: 'BLUE1' },
            { id: 't2', name: 'work', colorName: 'PINK1' },
          ],
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchTags } = await import('../../../../src/core/graphql/queries/tags.js');
    const rows = await fetchTags(client);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(['t1', 't2']);
    expect(rows[0]?.name).toBe('travel');
  });

  test('passes no variables (Tags query takes none)', async () => {
    const client = {
      query: mock(() => Promise.resolve({ tags: [] })),
    } as unknown as GraphQLClient;

    const { fetchTags } = await import('../../../../src/core/graphql/queries/tags.js');
    await fetchTags(client);

    expect(client.query).toHaveBeenCalledWith('Tags', expect.any(String), {});
  });

  test('handles empty response without throwing', async () => {
    const client = {
      query: mock(() => Promise.resolve({ tags: [] })),
    } as unknown as GraphQLClient;

    const { fetchTags } = await import('../../../../src/core/graphql/queries/tags.js');
    const rows = await fetchTags(client);
    expect(rows).toEqual([]);
  });
});
