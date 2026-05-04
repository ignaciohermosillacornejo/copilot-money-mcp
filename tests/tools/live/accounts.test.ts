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
  type: 'DEPOSITORY',
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
    const live = mkLive([A('a', { type: 'DEPOSITORY' }), A('b', { type: 'CREDIT' })]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({ account_type: 'credit' });
    expect(result.count).toBe(1);
    expect(result.accounts[0]?.id).toBe('b');
  });

  test('totals calculated correctly: assets minus liabilities', async () => {
    const live = mkLive([
      A('a', { type: 'DEPOSITORY', balance: 1000 }),
      A('b', { type: 'CREDIT', balance: 200 }),
      A('c', { type: 'LOAN', balance: 500 }),
    ]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({});
    expect(result.total_assets).toBe(1000);
    expect(result.total_liabilities).toBe(700); // 200 + 500
    expect(result.total_balance).toBe(300); // 1000 - 700
  });

  test('regression A1: real-shape uppercase types are bucketed correctly', async () => {
    // GraphQL returns Account.type as uppercase enum values ('CREDIT', 'DEPOSITORY',
    // 'LOAN'). Pre-fix code held lowercase in LIABILITY_TYPES, so production saw
    // every credit-card balance summed into total_assets and total_liabilities=0.
    // See docs/superpowers/audits/2026-05-03-live-mode-parity-audit.md § Issue A1.
    const live = mkLive([
      A('chk', { type: 'DEPOSITORY', balance: 5000 }),
      A('cc', { type: 'CREDIT', balance: 1500 }),
      A('ln', { type: 'LOAN', balance: 800 }),
    ]);
    const tools = new LiveAccountsTools(live);

    const result = await tools.getAccounts({});
    expect(result.total_assets).toBe(5000);
    expect(result.total_liabilities).toBe(2300);
    expect(result.total_balance).toBe(2700);
  });

  test('regression A1: account_type filter is case-insensitive', async () => {
    // Real server returns uppercase. Tool description documents lowercase examples
    // ("depository, credit, loan, investment, etc."). Both must work.
    const live = mkLive([A('a', { type: 'DEPOSITORY' }), A('b', { type: 'CREDIT' })]);
    const tools = new LiveAccountsTools(live);

    const lower = await tools.getAccounts({ account_type: 'credit' });
    expect(lower.count).toBe(1);
    expect(lower.accounts[0]?.id).toBe('b');

    const upper = await tools.getAccounts({ account_type: 'CREDIT' });
    expect(upper.count).toBe(1);
    expect(upper.accounts[0]?.id).toBe('b');
  });

  test('regression A2: limit:0 mapped to null for charge cards', async () => {
    // Charge cards (e.g., AmEx Platinum) have no preset limit; server returns 0, project null to prevent /0.
    const live = mkLive([
      A('chk', { type: 'DEPOSITORY', balance: 5000, limit: null }),
      A('cc-with-limit', { type: 'CREDIT', balance: 100, limit: 5000 }),
      A('charge', { type: 'CREDIT', balance: 1500, limit: 0 }),
    ]);
    const tools = new LiveAccountsTools(live);
    const result = await tools.getAccounts({});

    const charge = result.accounts.find((a) => a.id === 'charge');
    const ccLimit = result.accounts.find((a) => a.id === 'cc-with-limit');
    const chk = result.accounts.find((a) => a.id === 'chk');

    expect(charge?.limit).toBeNull();
    // Sanity: a real-limit credit card retains its limit.
    expect(ccLimit?.limit).toBe(5000);
    // Sanity: depository accounts (already null in fixture) stay null.
    expect(chk?.limit).toBeNull();
  });

  test('schema definition exposes filter args', () => {
    const schema = createLiveAccountsToolSchema();
    expect(schema.name).toBe('get_accounts_live');
    expect(schema.inputSchema).toBeDefined();
  });
});
