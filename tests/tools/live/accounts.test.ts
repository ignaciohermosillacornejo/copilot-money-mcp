import { describe, expect, test, mock } from 'bun:test';
import {
  LiveAccountsTools,
  createLiveAccountsToolSchema,
} from '../../../src/tools/live/accounts.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import type { CopilotDatabase } from '../../../src/core/database.js';
import type { AccountNode } from '../../../src/core/graphql/queries/accounts.js';

const A = (id: string, opts: Partial<AccountNode> = {}): AccountNode => ({
  id,
  itemId: 'item1',
  name: `Account ${id}`,
  balance: 100,
  liveBalance: true,
  type: 'depository',
  subType: 'checking',
  mask: '0001',
  isUserHidden: false,
  isUserClosed: false,
  isManual: false,
  color: null,
  limit: null,
  institutionId: 'inst1',
  hasHistoricalUpdates: true,
  hasLiveBalance: true,
  latestBalanceUpdate: '2026-04-25T00:00:00Z',
  ...opts,
});

const mkClientReturning = (rows: AccountNode[]): GraphQLClient =>
  ({
    query: mock(async () => ({ accounts: rows })),
  }) as unknown as GraphQLClient;

const mkLive = (rows: AccountNode[]): LiveCopilotDatabase =>
  new LiveCopilotDatabase(mkClientReturning(rows), {} as CopilotDatabase);

describe('LiveAccountsTools.getAccounts', () => {
  test('first call: cache miss, returns rows with _cache_hit: false', async () => {
    const live = mkLive([A('a'), A('b')]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({});

    expect(result._cache_hit).toBe(false);
    expect(result.count).toBe(2);
    expect(typeof result._cache_oldest_fetched_at).toBe('string');
    expect(result._cache_oldest_fetched_at).toBe(result._cache_newest_fetched_at);
  });

  test('second call: cache hit, no GraphQL call, _cache_hit: true', async () => {
    const client = mkClientReturning([A('a')]);
    const live = new LiveCopilotDatabase(client, {} as CopilotDatabase);
    const tools = new LiveAccountsTools(live);

    await tools.getAccounts({});
    const second = await tools.getAccounts({});

    expect(second._cache_hit).toBe(true);
    expect((client.query as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  test('include_hidden=false (default) filters hidden and closed accounts', async () => {
    const live = mkLive([A('a'), A('b', { isUserHidden: true }), A('c', { isUserClosed: true })]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({ include_hidden: false });
    expect(result.count).toBe(1);
    expect(result.accounts[0]?.id).toBe('a');
  });

  test('include_hidden=true returns all', async () => {
    const live = mkLive([A('a'), A('b', { isUserHidden: true })]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({ include_hidden: true });
    expect(result.count).toBe(2);
  });

  test('account_type filter applied', async () => {
    const live = mkLive([A('a', { type: 'depository' }), A('b', { type: 'credit' })]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({ account_type: 'credit' });
    expect(result.count).toBe(1);
    expect(result.accounts[0]?.id).toBe('b');
  });

  test('totals calculated correctly: assets minus liabilities', async () => {
    const live = mkLive([
      A('a', { type: 'depository', balance: 1000 }),
      A('b', { type: 'credit', balance: 200 }),
      A('c', { type: 'loan', balance: 500 }),
    ]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({});
    expect(result.total_assets).toBe(1000);
    expect(result.total_liabilities).toBe(700); // 200 + 500
    expect(result.total_balance).toBe(300); // 1000 - 700
  });

  test('schema definition exposes filter args', () => {
    const schema = createLiveAccountsToolSchema();
    expect(schema.name).toBe('get_accounts_live');
    expect(schema.inputSchema).toBeDefined();
  });
});
