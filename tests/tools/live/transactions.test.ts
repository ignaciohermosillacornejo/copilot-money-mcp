import { describe, test, expect, mock } from 'bun:test';
import { LiveTransactionsTools } from '../../../src/tools/live/transactions.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import type { CopilotDatabase } from '../../../src/core/database.js';

function mkLive(): LiveCopilotDatabase {
  const client = { mutate: mock(), query: mock() } as unknown as GraphQLClient;
  const cache = {
    getAccounts: mock(() => Promise.resolve([])),
    getTags: mock(() => Promise.resolve([])),
    getUserCategories: mock(() => Promise.resolve([])),
    getCategoryNameMap: mock(() => Promise.resolve(new Map<string, string>())),
  } as unknown as CopilotDatabase;
  return new LiveCopilotDatabase(client, cache);
}

describe('LiveTransactionsTools — input validation', () => {
  test('rejects city filter', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ city: 'Brooklyn' } as never)).rejects.toThrow(
      /city.*not supported/i
    );
  });

  test('rejects lat/lon filter', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ lat: 40.7, lon: -74 } as never)).rejects.toThrow(
      /lat.*not supported|lon.*not supported/i
    );
  });

  test('rejects region/country/radius_km filters', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ region: 'NY' } as never)).rejects.toThrow(
      /region.*not supported/i
    );
    await expect(tools.getTransactions({ country: 'US' } as never)).rejects.toThrow(
      /country.*not supported/i
    );
    await expect(tools.getTransactions({ radius_km: 10 } as never)).rejects.toThrow(
      /radius_km.*not supported/i
    );
  });

  test('rejects transaction_type=foreign and =duplicates', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ transaction_type: 'foreign' } as never)).rejects.toThrow(
      /foreign.*not supported/i
    );
    await expect(
      tools.getTransactions({ transaction_type: 'duplicates' } as never)
    ).rejects.toThrow(/duplicates.*not supported/i);
  });

  test('rejects exclude_split_parents=false', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ exclude_split_parents: false } as never)).rejects.toThrow(
      /exclude_split_parents.*not supported/i
    );
  });

  test('rejects transaction_id lookup without account_id+item_id', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ transaction_id: 't1' } as never)).rejects.toThrow(
      /account_id.*item_id/i
    );
  });
});

import type {
  TransactionNode,
  AccountRef,
} from '../../../src/core/graphql/queries/transactions.js';
import type { Account } from '../../../src/models/index.js';

function mkNode(partial: Partial<TransactionNode>): TransactionNode {
  return {
    id: 't-default',
    accountId: 'a1',
    itemId: 'i1',
    categoryId: 'c1',
    recurringId: null,
    parentId: null,
    isReviewed: false,
    isPending: false,
    amount: 10,
    date: '2025-06-01',
    name: 'Amazon',
    type: 'REGULAR',
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    isoCurrencyCode: 'USD',
    createdAt: 0,
    tags: [],
    goal: null,
    ...partial,
  };
}

function mkLiveReturning(nodes: TransactionNode[]): LiveCopilotDatabase {
  const live = mkLive();
  (
    live as unknown as { getTransactions: (opts: unknown) => Promise<TransactionNode[]> }
  ).getTransactions = async () => nodes;
  return live;
}

describe('LiveTransactionsTools — happy path', () => {
  test('returns envelope with enriched fields', async () => {
    const live = mkLiveReturning([mkNode({ id: 't1', name: 'AMAZON.COM*XYZ' })]);
    (live.getCache().getCategoryNameMap as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(new Map([['c1', 'Shopping']]))
    );
    const tools = new LiveTransactionsTools(live);

    const result = await tools.getTransactions({ query: 'amazon' });

    expect(result.count).toBe(1);
    expect(result.transactions[0]).toMatchObject({
      transaction_id: 't1',
      category_name: 'Shopping',
      normalized_merchant: 'AMAZON',
    });
  });

  test('applies limit and offset client-side', async () => {
    const nodes = [1, 2, 3, 4, 5].map((i) => mkNode({ id: `t${i}` }));
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);

    const result = await tools.getTransactions({ limit: 2, offset: 1 });

    expect(result.count).toBe(2);
    expect(result.total_count).toBe(5);
    expect(result.offset).toBe(1);
    expect(result.has_more).toBe(true);
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t2', 't3']);
  });
});

describe('LiveTransactionsTools — post-filters', () => {
  test('filters by min_amount and max_amount (absolute value)', async () => {
    const nodes = [
      mkNode({ id: 't1', amount: -5 }),
      mkNode({ id: 't2', amount: 50 }),
      mkNode({ id: 't3', amount: 150 }),
    ];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({ min_amount: 10, max_amount: 100 });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t2']);
  });

  test('filters by pending flag', async () => {
    const nodes = [mkNode({ id: 't1', isPending: true }), mkNode({ id: 't2', isPending: false })];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const resultP = await tools.getTransactions({ pending: true });
    expect(resultP.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
    const resultS = await tools.getTransactions({ pending: false });
    expect(resultS.transactions.map((t) => t.transaction_id)).toEqual(['t2']);
  });

  test('transaction_type=tagged filters to rows with tags[] non-empty', async () => {
    const nodes = [
      mkNode({
        id: 't1',
        tags: [{ id: 'tg1', name: 'vacation', colorName: 'BLUE1' }],
      }),
      mkNode({ id: 't2', tags: [] }),
    ];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({ transaction_type: 'tagged' });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
  });

  test('transaction_type=refunds filters to negative amounts', async () => {
    const nodes = [mkNode({ id: 't1', amount: -25 }), mkNode({ id: 't2', amount: 15 })];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({ transaction_type: 'refunds' });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
  });

  test('exclude_transfers=true filters out INTERNAL_TRANSFER', async () => {
    const nodes = [
      mkNode({ id: 't1', type: 'REGULAR' }),
      mkNode({ id: 't2', type: 'INTERNAL_TRANSFER' }),
    ];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({ exclude_transfers: true });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
  });
});

describe('LiveTransactionsTools — account resolution', () => {
  test('resolves account_id to AccountRef via cache', async () => {
    const live = mkLiveReturning([]);
    const accounts: Account[] = [
      { account_id: 'a1', item_id: 'i-1' } as Account,
      { account_id: 'a2', item_id: 'i-2' } as Account,
    ];
    (live.getCache().getAccounts as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(accounts)
    );
    const spy = mock((_opts: unknown) => Promise.resolve([] as TransactionNode[]));
    (live as unknown as { getTransactions: typeof spy }).getTransactions = spy;

    const tools = new LiveTransactionsTools(live);
    await tools.getTransactions({ account_id: 'a2' });

    const args = spy.mock.calls[0]![0] as { accountRefs?: AccountRef[] };
    expect(args.accountRefs).toEqual([{ accountId: 'a2', itemId: 'i-2' }]);
  });

  test('surfaces error when account_id is not in cache', async () => {
    const live = mkLiveReturning([]);
    (live.getCache().getAccounts as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([])
    );
    const tools = new LiveTransactionsTools(live);
    await expect(tools.getTransactions({ account_id: 'nope' })).rejects.toThrow(
      /account.*not found/i
    );
  });
});
