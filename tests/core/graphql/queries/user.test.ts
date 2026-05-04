import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

describe('fetchUser', () => {
  test('returns budgetingConfig with rolloversConfig.isEnabled', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          user: {
            id: 'user-1',
            budgetingConfig: {
              isEnabled: true,
              rolloversConfig: {
                isEnabled: true,
                startDate: '2026-01',
              },
            },
          },
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchUser } = await import('../../../../src/core/graphql/queries/user.js');
    const node = await fetchUser(client);

    expect(node.id).toBe('user-1');
    expect(node.budgetingConfig?.isEnabled).toBe(true);
    expect(node.budgetingConfig?.rolloversConfig?.isEnabled).toBe(true);
  });

  test('handles a user with budgeting disabled', async () => {
    const client = {
      query: mock(() =>
        Promise.resolve({
          user: {
            id: 'user-2',
            budgetingConfig: {
              isEnabled: false,
              rolloversConfig: null,
            },
          },
        })
      ),
    } as unknown as GraphQLClient;

    const { fetchUser } = await import('../../../../src/core/graphql/queries/user.js');
    const node = await fetchUser(client);

    expect(node.budgetingConfig?.isEnabled).toBe(false);
    expect(node.budgetingConfig?.rolloversConfig).toBeNull();
  });

  test('passes no variables (User query takes none)', async () => {
    const client = {
      query: mock(() => Promise.resolve({ user: { id: 'u', budgetingConfig: null } })),
    } as unknown as GraphQLClient;

    const { fetchUser } = await import('../../../../src/core/graphql/queries/user.js');
    await fetchUser(client);

    expect(client.query).toHaveBeenCalledWith('User', expect.any(String), {});
  });
});
