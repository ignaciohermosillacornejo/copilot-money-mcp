import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import { CopilotDatabase } from '../../../src/core/database.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import { LiveHoldingsTools } from '../../../src/tools/live/holdings.js';
import { LiveAccountsTools } from '../../../src/tools/live/accounts.js';

/**
 * `accounts` is served alongside `holdings` because get_holdings_live joins
 * the accounts snapshot to decide which positions are on hidden or closed
 * accounts (#683). A client that answers only `holdings` is not a realistic
 * stand-in for the live database any more.
 */
function makeClient(rows: unknown[], accounts: unknown[] = []): GraphQLClient {
  return {
    query: mock((op: string) =>
      Promise.resolve(op === 'Accounts' ? { accounts } : { holdings: rows })
    ),
  } as unknown as GraphQLClient;
}

/** A minimal AccountNode — only the fields the visibility join reads. */
function acct(id: string, flags: { isUserHidden?: boolean; isUserClosed?: boolean } = {}) {
  return {
    id,
    itemId: 'item-1',
    name: `Account ${id}`,
    balance: 0,
    liveBalance: true,
    type: 'INVESTMENT',
    subType: 'brokerage',
    mask: null,
    institutionId: 'ins_test',
    isUserHidden: flags.isUserHidden ?? false,
    isUserClosed: flags.isUserClosed ?? false,
    isManual: false,
    hasLiveBalance: true,
    hasHistoricalUpdates: true,
    latestBalanceUpdate: 0,
    limit: null,
    color: '#000000',
  };
}

function makeLive(client: GraphQLClient): LiveCopilotDatabase {
  return new LiveCopilotDatabase(client, new CopilotDatabase('/tmp/no-such-db'));
}

const equityHolding = {
  id: 'h-equity',
  accountId: 'acct-1',
  itemId: 'item-1',
  quantity: 10,
  security: {
    id: 'sec-equity',
    name: 'Acme Corp',
    symbol: 'ACME',
    type: 'EQUITY',
    currentPrice: 100,
    lastUpdate: 1_777_852_800_000,
    marketInfo: { closeTime: null, openTime: null },
  },
  metrics: {
    averageCost: 80,
    costBasis: 800,
    totalReturn: 200,
  },
};

const mutualFundHolding = {
  id: 'h-mf',
  accountId: 'acct-1',
  itemId: 'item-1',
  quantity: 5,
  security: {
    id: 'sec-mf',
    name: 'Index Fund',
    symbol: 'IDX',
    type: 'MUTUAL_FUND',
    currentPrice: 200,
    lastUpdate: 1_777_852_800_000,
    marketInfo: { closeTime: null, openTime: null },
  },
  metrics: {
    averageCost: 150,
    costBasis: 750,
    totalReturn: 250,
  },
};

const cashHolding = {
  id: 'h-cash',
  accountId: 'acct-2',
  itemId: 'item-2',
  quantity: 562.5,
  security: {
    id: 'sec-cash',
    name: 'USD Cash',
    symbol: 'USD',
    type: 'CASH',
    currentPrice: 1,
    lastUpdate: 1_777_852_800_000,
    marketInfo: { closeTime: null, openTime: null },
  },
  metrics: null,
};

describe('LiveHoldingsTools.getHoldings', () => {
  test('projects equity/mutual-fund metrics and computes institution_value + return %', async () => {
    const client = makeClient([equityHolding, mutualFundHolding, cashHolding]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({});

    expect(result.count).toBe(3);
    expect(result.total_count).toBe(3);
    expect(result.has_more).toBe(false);
    expect(result.holdings).toHaveLength(3);

    const equity = result.holdings.find((h) => h.security_id === 'sec-equity');
    expect(equity).toBeDefined();
    expect(equity?.ticker_symbol).toBe('ACME');
    expect(equity?.type).toBe('EQUITY');
    expect(equity?.account_id).toBe('acct-1');
    expect(equity?.item_id).toBe('item-1');
    expect(equity?.quantity).toBe(10);
    expect(equity?.institution_price).toBe(100);
    // 10 * 100 = 1000
    expect(equity?.institution_value).toBe(1000);
    expect(equity?.cost_basis).toBe(800);
    expect(equity?.average_cost).toBe(80);
    expect(equity?.total_return).toBe(200);
    // (200 / 800) * 100 = 25
    expect(equity?.total_return_percent).toBe(25);
    expect(equity?.is_cash_equivalent).toBe(false);

    const mf = result.holdings.find((h) => h.security_id === 'sec-mf');
    expect(mf?.institution_value).toBe(1000); // 5 * 200
    expect(mf?.cost_basis).toBe(750);
    // (250 / 750) * 100 = 33.33
    expect(mf?.total_return_percent).toBe(33.33);
  });

  test('CASH holding has is_cash_equivalent=true and omits metric-derived fields', async () => {
    const client = makeClient([cashHolding]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({});

    expect(result.count).toBe(1);
    const cash = result.holdings[0];
    expect(cash?.is_cash_equivalent).toBe(true);
    expect(cash?.institution_value).toBe(562.5);
    expect(cash?.cost_basis).toBeUndefined();
    expect(cash?.average_cost).toBeUndefined();
    expect(cash?.total_return).toBeUndefined();
    expect(cash?.total_return_percent).toBeUndefined();
  });

  test('filters by account_id (exact match)', async () => {
    const client = makeClient([equityHolding, mutualFundHolding, cashHolding]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({ account_id: 'acct-2' });

    expect(result.count).toBe(1);
    expect(result.total_count).toBe(1);
    expect(result.holdings[0]?.security_id).toBe('sec-cash');
  });

  test('filters by ticker_symbol case-insensitively', async () => {
    const client = makeClient([equityHolding, mutualFundHolding, cashHolding]);
    const tools = new LiveHoldingsTools(makeLive(client));

    // Lowercase input must match uppercase server symbol.
    const result = await tools.getHoldings({ ticker_symbol: 'acme' });

    expect(result.count).toBe(1);
    expect(result.holdings[0]?.ticker_symbol).toBe('ACME');
  });

  test('pagination: limit + offset produce correct count / total_count / has_more', async () => {
    const client = makeClient([equityHolding, mutualFundHolding, cashHolding]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({ limit: 2, offset: 0 });

    expect(result.count).toBe(2);
    expect(result.total_count).toBe(3);
    expect(result.offset).toBe(0);
    expect(result.has_more).toBe(true);

    const next = await tools.getHoldings({ limit: 2, offset: 2 });
    expect(next.count).toBe(1);
    expect(next.total_count).toBe(3);
    expect(next.offset).toBe(2);
    expect(next.has_more).toBe(false);
  });

  test('warm call returns same data with _cache_hit=true and no second fetch', async () => {
    const client = makeClient([equityHolding]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const first = await tools.getHoldings({});
    const second = await tools.getHoldings({});

    expect(first._cache_hit).toBe(false);
    expect(second._cache_hit).toBe(true);
    expect(second.holdings[0]?.security_id).toBe('sec-equity');
    // A cold call now costs TWO operations, not one: Holdings plus the
    // Accounts snapshot the visibility join reads (#683). Both are
    // SnapshotCache-backed, which is the point of this test — the warm call
    // adds nothing, so the join is paid once per TTL rather than per call,
    // and `get_accounts_live` usually warms it first anyway.
    //
    // Sorted, like its sibling below: the two reads run in parallel, so which
    // ops were issued is the contract and arrival order is not. It happens to
    // be deterministic today — the Promise.all array evaluates the holdings
    // read first, and SnapshotCache.read reaches its loader before the first
    // await — but that is an incidental of the cache, not something to pin.
    const ops = (client.query as ReturnType<typeof mock>).mock.calls.map(
      (c) => (c as unknown[])[0]
    );
    expect([...ops].sort()).toEqual(['Accounts', 'Holdings']);
  });

  test('excludes positions on hidden and closed accounts by default (#683)', async () => {
    // The live half of #683, and the half that mattered more: get_holdings is
    // swappedOutInLiveMode, so under --live-reads — which --write implies —
    // this is the tool callers actually get. The cache fix could not reach it.
    const client = makeClient(
      [
        { ...equityHolding, id: 'h-visible', accountId: 'acct-visible' },
        { ...equityHolding, id: 'h-hidden', accountId: 'acct-hidden' },
        { ...equityHolding, id: 'h-closed', accountId: 'acct-closed' },
      ],
      [
        acct('acct-visible'),
        acct('acct-hidden', { isUserHidden: true }),
        acct('acct-closed', { isUserClosed: true }),
      ]
    );
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({});

    expect(result.holdings.map((h) => h.account_id)).toEqual(['acct-visible']);
    expect(result.total_count).toBe(1);
  });

  test('include_hidden: true brings them back (#683)', async () => {
    const client = makeClient(
      [
        { ...equityHolding, id: 'h-visible', accountId: 'acct-visible' },
        { ...equityHolding, id: 'h-hidden', accountId: 'acct-hidden' },
      ],
      [acct('acct-visible'), acct('acct-hidden', { isUserHidden: true })]
    );
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({ include_hidden: true });

    expect(result.holdings.map((h) => h.account_id).sort()).toEqual([
      'acct-hidden',
      'acct-visible',
    ]);
  });

  test('the two LIVE tools agree on which accounts exist (#683)', async () => {
    // Mirror of the cache-mode parity test, and the one the cache test could
    // never stand in for: it exercises only cache-mode handlers, so it would
    // stay green while live mode shipped the same bug.
    //
    // Pins the RELATIONSHIP: whatever get_accounts_live hides, get_holdings_live
    // must report no positions for.
    const accounts = [
      acct('acct-visible'),
      acct('acct-hidden', { isUserHidden: true }),
      acct('acct-closed', { isUserClosed: true }),
    ];
    const client = makeClient(
      accounts.map((a, i) => ({ ...equityHolding, id: `h-${i}`, accountId: a.id })),
      accounts
    );
    const live = makeLive(client);

    const visible = new Set(
      (await new LiveAccountsTools(live).getAccounts({})).accounts.map((a) => a.id)
    );
    const held = new Set(
      (await new LiveHoldingsTools(live).getHoldings({})).holdings.map((h) => h.account_id)
    );

    const orphaned = [...held].filter((id) => !visible.has(id));
    expect(
      orphaned,
      `get_holdings_live reported positions on accounts get_accounts_live hides: ` +
        `${orphaned.join(', ')}. A caller summing institution_value would count money the ` +
        `account list says is not there.`
    ).toEqual([]);
    // Guards the gate: both sets non-empty, or the comparison is vacuous.
    expect(visible.size).toBeGreaterThan(0);
    expect(held.size).toBeGreaterThan(0);
  });

  test('an unreadable accounts snapshot fails loudly, not unfiltered (#683)', async () => {
    // The tempting `?? []` in the visibility join would mean "no hidden
    // accounts" and silently restore the double-count. A caller who cannot be
    // told which accounts are hidden gets an error instead of a plausible
    // wrong number.
    const client = {
      query: mock((op: string) =>
        Promise.resolve(op === 'Accounts' ? {} : { holdings: [equityHolding] })
      ),
    } as unknown as GraphQLClient;
    const tools = new LiveHoldingsTools(makeLive(client));

    await expect(tools.getHoldings({})).rejects.toThrow(/cannot tell which accounts are hidden/);

    // ...and include_hidden skips the join entirely, so it still works.
    const escaped = await tools.getHoldings({ include_hidden: true });
    expect(escaped.holdings).toHaveLength(1);
  });

  test('a bad accounts snapshot is DISCARDED, so a retry re-fetches', async () => {
    // SnapshotCache stores the entry before the caller sees the rows, so
    // without an explicit invalidate a malformed response would sit cached for
    // the full 1h TTL and every retry would throw off the same poisoned entry.
    //
    // Two things ride on flushing it: "retry" becomes true advice, and this
    // tool stops poisoning the SHARED accounts snapshot that get_accounts_live
    // reads with no guard of its own — blast radius the #683 join newly
    // created by making this tool a writer of that cache.
    let accountsCalls = 0;
    const client = {
      query: mock((op: string) => {
        if (op === 'Accounts') {
          accountsCalls += 1;
          return Promise.resolve({});
        }
        return Promise.resolve({ holdings: [equityHolding] });
      }),
    } as unknown as GraphQLClient;
    const tools = new LiveHoldingsTools(makeLive(client));

    await expect(tools.getHoldings({})).rejects.toThrow(/a retry will re-fetch/);
    await expect(tools.getHoldings({})).rejects.toThrow(/a retry will re-fetch/);

    // The second attempt DID re-fetch — the entry was discarded rather than
    // cached. This is the assertion that makes the error message's advice
    // true; asserting only that it threw twice would pass either way.
    expect(accountsCalls).toBe(2);
  });

  test('accounts rows MISSING the visibility flags fail too, not silently pass (#683)', async () => {
    // An Array.isArray guard checks the container. Rows that are an array but
    // lack isUserHidden/isUserClosed sail through it, and
    // isVisibleAccountNode then reads `!undefined && !undefined` === true for
    // every row — an empty hidden set, and the double-count back with no
    // error. Same failure as the `?? []` fallback the code refuses, one level
    // down.
    const client = {
      query: mock((op: string) =>
        Promise.resolve(
          op === 'Accounts'
            ? { accounts: [{ id: 'acct-1', name: 'No flags here' }] }
            : { holdings: [equityHolding] }
        )
      ),
    } as unknown as GraphQLClient;
    const tools = new LiveHoldingsTools(makeLive(client));

    await expect(tools.getHoldings({})).rejects.toThrow(/cannot tell which accounts are hidden/);
  });

  test('an EMPTY accounts snapshot returns UNFILTERED holdings — the known residual (#683)', async () => {
    // Pins the documented gap so it stays documented. `{ accounts: [] }` is
    // the one input that reaches the unfiltered path without an error, and
    // treating it as a contradiction was tried and backed out: it conflicts
    // with this filter's own "unknown is not hidden" rule, under which a
    // holding whose account is absent from the snapshot is kept.
    //
    // If someone later decides the hard failure is right after all, this test
    // is what they change — deliberately, rather than discovering the
    // behaviour from a support question.
    const client = makeClient([equityHolding], []);
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({});
    expect(result.holdings).toHaveLength(1);
  });

  test('freshness reflects BOTH snapshots when the visibility join ran (#683)', async () => {
    // The returned rows depend on the accounts snapshot too, so reporting only
    // the holdings snapshot would advertise a freshness the result lacks: a
    // caller who unhides an account could see _cache_hit: false while a stale
    // accounts snapshot still filters its positions out.
    const client = makeClient([equityHolding], [acct('acct-1')]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const cold = await tools.getHoldings({});
    expect(cold._cache_hit).toBe(false);

    const warm = await tools.getHoldings({});
    expect(warm._cache_hit).toBe(true);

    // include_hidden skips the join, so only the holdings snapshot counts —
    // and it is warm here, so this must not be dragged false by an absent
    // second read.
    const skipped = await tools.getHoldings({ include_hidden: true });
    expect(skipped._cache_hit).toBe(true);
  });

  test('cache metadata: ISO strings, oldest === newest on a single-snapshot fetch', async () => {
    // `include_hidden: true` below is load-bearing, not incidental: without it
    // the #683 visibility join stamps a SECOND cache entry with its own
    // Date.now(), and `oldest === newest` becomes a two-timestamp race that
    // passes almost always — which is a CI flake waiting to be triaged rather
    // than a property. Skipping the join makes this genuinely single-snapshot,
    // which is what the title claims.
    const client = makeClient([equityHolding]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({});

    expect(typeof result._cache_oldest_fetched_at).toBe('string');
    expect(typeof result._cache_newest_fetched_at).toBe('string');
    expect(result._cache_oldest_fetched_at).toBe(result._cache_newest_fetched_at);
    // ISO 8601 sanity check.
    expect(result._cache_oldest_fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('total_return_percent floors at the 2-decimal-place position (positive case)', async () => {
    // 100 / 1191 * 100 = 8.3963...
    //   Math.floor → 8.39 (locked in by this test)
    //   Math.round → 8.40 (would fail under the previous round-half-up rule)
    // This mirrors Copilot's web UI rounding convention.
    const flooredPositive = {
      ...equityHolding,
      id: 'h-floor-pos',
      metrics: { averageCost: 119.1, costBasis: 1191, totalReturn: 100 },
    };
    const client = makeClient([flooredPositive]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({});

    expect(result.holdings[0]?.total_return_percent).toBe(8.39);
  });

  test('total_return_percent floors toward negative infinity (negative case)', async () => {
    // -100 / 437 * 100 = -22.8833...
    //   Math.floor → -22.89 (further from zero, locked in by this test)
    //   Math.round → -22.88 (would fail under round-half-up)
    // Confirms floor toward negative infinity, not toward zero.
    const flooredNegative = {
      ...equityHolding,
      id: 'h-floor-neg',
      metrics: { averageCost: 43.7, costBasis: 437, totalReturn: -100 },
    };
    const client = makeClient([flooredNegative]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({});

    expect(result.holdings[0]?.total_return_percent).toBe(-22.89);
  });

  test('degenerate cost_basis=0 does not produce Infinity/NaN total_return_percent', async () => {
    const zeroBasis = {
      ...equityHolding,
      id: 'h-zero',
      metrics: { averageCost: 0, costBasis: 0, totalReturn: 10 },
    };
    const client = makeClient([zeroBasis]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({});

    const entry = result.holdings[0];
    expect(entry?.cost_basis).toBe(0);
    expect(entry?.total_return).toBe(10);
    expect(entry?.total_return_percent).toBeUndefined();
  });

  test('passes correct operation name and empty variables to GraphQLClient.query', async () => {
    const client = makeClient([equityHolding]);
    const tools = new LiveHoldingsTools(makeLive(client));

    await tools.getHoldings({});

    const queryMock = client.query as ReturnType<typeof mock>;
    const callArgs = queryMock.mock.calls[0] as unknown[];
    expect(callArgs[0]).toBe('Holdings');
    expect(typeof callArgs[1]).toBe('string');
    expect(callArgs[2]).toEqual({});

    // The second operation is the #683 visibility join. Asserted by NAME
    // rather than by a bare count, so this test says which calls are expected
    // instead of only how many — a count would pass if the join were replaced
    // by some unrelated second query.
    expect(queryMock.mock.calls.map((c) => (c as unknown[])[0]).sort()).toEqual([
      'Accounts',
      'Holdings',
    ]);
  });

  test('empty result returns count=0 without throwing', async () => {
    const client = makeClient([]);
    const tools = new LiveHoldingsTools(makeLive(client));

    const result = await tools.getHoldings({});

    expect(result.count).toBe(0);
    expect(result.total_count).toBe(0);
    expect(result.holdings).toEqual([]);
    expect(result.has_more).toBe(false);
  });
});

describe('createLiveHoldingsToolSchema', () => {
  test('returns a schema with readOnlyHint=true and the expected tool name', async () => {
    const { createLiveHoldingsToolSchema } = await import('../../../src/tools/live/holdings.js');
    const schema = createLiveHoldingsToolSchema();
    expect(schema.name).toBe('get_holdings_live');
    expect(schema.annotations?.readOnlyHint).toBe(true);
  });

  test('declares optional account_id, ticker_symbol, limit, offset (no required)', async () => {
    const { createLiveHoldingsToolSchema } = await import('../../../src/tools/live/holdings.js');
    const schema = createLiveHoldingsToolSchema();
    const props = schema.inputSchema.properties as Record<string, { type: string }>;
    expect(props.account_id?.type).toBe('string');
    expect(props.ticker_symbol?.type).toBe('string');
    expect(props.limit?.type).toBe('integer');
    expect(props.offset?.type).toBe('integer');
    // All filters are opt-in.
    expect((schema.inputSchema as { required?: string[] }).required ?? []).toEqual([]);
  });
});
