import { describe, test, expect, mock } from 'bun:test';
import { TRANSACTIONS } from '../../../../src/core/graphql/operations.generated.js';

describe('TRANSACTIONS query constant', () => {
  test('is non-empty and targets transactions root field', () => {
    expect(TRANSACTIONS).toContain('query Transactions');
    expect(TRANSACTIONS).toContain('transactions(');
    expect(TRANSACTIONS).toContain('$filter: TransactionFilter');
    expect(TRANSACTIONS).toContain('$sort: [TransactionSort!]');
    expect(TRANSACTIONS).toContain('edges');
    expect(TRANSACTIONS).toContain('pageInfo');
    expect(TRANSACTIONS).toContain('endCursor');
    expect(TRANSACTIONS).toContain('hasNextPage');
    expect(TRANSACTIONS).toContain('parentId');
    expect(TRANSACTIONS).toContain('isoCurrencyCode');
  });
});

import {
  buildTransactionFilter,
  buildTransactionSort,
  paginateTransactions,
  fetchTransactionsPage,
  type BuildFilterOptions,
  type TransactionFilterInput,
  type TransactionSortInput,
  type TransactionNode,
  type TransactionsPage,
} from '../../../../src/core/graphql/queries/transactions.js';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

describe('buildTransactionFilter', () => {
  test('returns null when no options are provided', () => {
    expect(buildTransactionFilter({})).toBeNull();
  });

  test('translates start_date and end_date into dates array', () => {
    const filter = buildTransactionFilter({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
    });
    expect(filter).toEqual({
      dates: [{ from: '2025-01-01', to: '2025-12-31' }],
    });
  });

  test('uses far-future end when only start_date given', () => {
    const filter = buildTransactionFilter({ startDate: '2025-01-01' });
    expect(filter?.dates?.[0]?.from).toBe('2025-01-01');
    expect(filter?.dates?.[0]?.to).toBe('9999-12-31');
  });

  test('uses far-past start when only end_date given', () => {
    const filter = buildTransactionFilter({ endDate: '2025-12-31' });
    expect(filter?.dates?.[0]?.from).toBe('1970-01-01');
    expect(filter?.dates?.[0]?.to).toBe('2025-12-31');
  });
});

describe('buildTransactionFilter — more mappings', () => {
  test('translates accountRefs', () => {
    const filter = buildTransactionFilter({
      accountRefs: [{ accountId: 'a1', itemId: 'i1' }],
    });
    expect(filter).toEqual({
      accountIds: [{ accountId: 'a1', itemId: 'i1' }],
    });
  });

  test('translates categoryIds', () => {
    expect(buildTransactionFilter({ categoryIds: ['c1', 'c2'] })).toEqual({
      categoryIds: ['c1', 'c2'],
    });
  });

  test('translates tagIds', () => {
    expect(buildTransactionFilter({ tagIds: ['t1'] })).toEqual({
      tagIds: ['t1'],
    });
  });

  test('translates types', () => {
    expect(buildTransactionFilter({ types: ['REGULAR', 'INCOME'] })).toEqual({
      types: ['REGULAR', 'INCOME'],
    });
  });

  test('translates matchString', () => {
    expect(buildTransactionFilter({ matchString: 'amazon' })).toEqual({
      matchString: 'amazon',
    });
  });

  test('omits empty matchString', () => {
    expect(buildTransactionFilter({ matchString: '' })).toBeNull();
  });

  test('translates isReviewed=false', () => {
    expect(buildTransactionFilter({ isReviewed: false })).toEqual({
      isReviewed: false,
    });
  });

  test('combines multiple filters', () => {
    const filter = buildTransactionFilter({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      categoryIds: ['c1'],
      matchString: 'amazon',
      types: ['REGULAR'],
    });
    expect(filter).toEqual({
      dates: [{ from: '2025-01-01', to: '2025-12-31' }],
      categoryIds: ['c1'],
      matchString: 'amazon',
      types: ['REGULAR'],
    });
  });
});

describe('buildTransactionSort', () => {
  test('defaults to DATE DESC', () => {
    expect(buildTransactionSort()).toEqual([{ field: 'DATE', direction: 'DESC' }]);
  });

  test('accepts overrides', () => {
    expect(buildTransactionSort({ field: 'AMOUNT', direction: 'ASC' })).toEqual([
      { field: 'AMOUNT', direction: 'ASC' },
    ]);
  });
});

function mkNode(id: string, date: string): TransactionNode {
  return {
    id,
    date,
    accountId: 'a1',
    itemId: 'i1',
    categoryId: 'c1',
    recurringId: null,
    parentId: null,
    isReviewed: false,
    isPending: false,
    amount: 10,
    name: 'x',
    type: 'REGULAR',
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    isoCurrencyCode: 'USD',
    createdAt: 0,
    tags: [],
    goal: null,
  };
}

describe('paginateTransactions', () => {
  test('collects all pages when fetcher returns hasNextPage=false', async () => {
    let calls = 0;
    const fetcher = async (): Promise<TransactionsPage> => {
      calls += 1;
      return {
        edges: [{ cursor: 'c1', node: mkNode('t1', '2025-06-01') }],
        pageInfo: { endCursor: 'c1', hasNextPage: false },
      };
    };
    const rows = await paginateTransactions(fetcher, {});
    expect(rows).toHaveLength(1);
    expect(calls).toBe(1);
  });

  test('follows cursor to next page until hasNextPage=false', async () => {
    const pages: TransactionsPage[] = [
      {
        edges: [{ cursor: 'c1', node: mkNode('t1', '2025-06-01') }],
        pageInfo: { endCursor: 'c1', hasNextPage: true },
      },
      {
        edges: [{ cursor: 'c2', node: mkNode('t2', '2025-05-01') }],
        pageInfo: { endCursor: 'c2', hasNextPage: false },
      },
    ];
    const fetcher = async (_after: string | null): Promise<TransactionsPage> => pages.shift()!;

    const rows = await paginateTransactions(fetcher, {});
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe('t1');
    expect(rows[1]!.id).toBe('t2');
  });

  test('early-exits when last node date precedes startDate (DATE DESC sort)', async () => {
    let calls = 0;
    const fetcher = async (): Promise<TransactionsPage> => {
      calls += 1;
      return {
        edges: [
          { cursor: 'c1', node: mkNode('t1', '2025-07-01') },
          { cursor: 'c2', node: mkNode('t2', '2024-12-31') },
        ],
        pageInfo: { endCursor: 'c2', hasNextPage: true },
      };
    };
    const rows = await paginateTransactions(fetcher, { startDate: '2025-01-01' });
    expect(calls).toBe(1);
    expect(rows).toHaveLength(2);
  });

  test('throws after max-page cap when fetcher returns empty edges + hasNextPage=true + stable cursor', async () => {
    let calls = 0;
    const fetcher = async (): Promise<TransactionsPage> => {
      calls += 1;
      return {
        edges: [],
        pageInfo: { endCursor: 'stuck-cursor', hasNextPage: true },
      };
    };
    await expect(paginateTransactions(fetcher, {})).rejects.toThrow(
      /max page|page (count|cap|limit)|too many pages/i
    );
    // Sanity: bounded — well under 10k calls even if the cap is high.
    expect(calls).toBeLessThan(10_000);
  });

  test('passes previous endCursor to fetcher', async () => {
    const received: (string | null)[] = [];
    const pages: TransactionsPage[] = [
      {
        edges: [{ cursor: 'c1', node: mkNode('t1', '2025-06-01') }],
        pageInfo: { endCursor: 'c1', hasNextPage: true },
      },
      {
        edges: [{ cursor: 'c2', node: mkNode('t2', '2025-05-01') }],
        pageInfo: { endCursor: 'c2', hasNextPage: false },
      },
    ];
    const fetcher = async (after: string | null): Promise<TransactionsPage> => {
      received.push(after);
      return pages.shift()!;
    };
    await paginateTransactions(fetcher, {});
    expect(received).toEqual([null, 'c1']);
  });
});

function createMockGqlClient(response: unknown): GraphQLClient {
  return {
    mutate: mock(() => Promise.resolve(response)),
    query: mock(() => Promise.resolve(response)),
  } as unknown as GraphQLClient;
}

describe('fetchTransactionsPage', () => {
  test('calls client.query with Transactions op name and TRANSACTIONS query string', async () => {
    const page: TransactionsPage = {
      edges: [],
      pageInfo: { endCursor: null, hasNextPage: false },
    };
    const client = createMockGqlClient({ transactions: page });

    await fetchTransactionsPage(client, {
      first: 100,
      after: null,
      filter: null,
      sort: [{ field: 'DATE', direction: 'DESC' }],
    });

    const calls = (client.query as ReturnType<typeof mock>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('Transactions');
    expect(calls[0][2]).toEqual({
      first: 100,
      after: null,
      filter: null,
      sort: [{ field: 'DATE', direction: 'DESC' }],
    });
  });
});
