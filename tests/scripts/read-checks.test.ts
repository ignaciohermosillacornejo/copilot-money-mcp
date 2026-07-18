/**
 * Tier-0 read smoke check logic (issues #439/#460).
 *
 * Exercises every check in `scripts/smoke/read-checks.ts` against a routed
 * mock GraphQLClient — no auth, no network. The live runner
 * (scripts/smoke/reads.ts) only orchestrates these; the per-operation
 * invariants and id-threading live here, so this is where they're unit
 * tested.
 */

import { describe, expect, test } from 'bun:test';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import {
  READ_SMOKE_CHECKS,
  type ReadSmokeContext,
  type ReadSmokeState,
} from '../../scripts/smoke/read-checks.js';

/** Route `client.query(op, ...)` to a canned `data` object per operation. */
function routedClient(byOp: Record<string, unknown>): GraphQLClient {
  return {
    query: (op: string) => {
      if (!(op in byOp)) return Promise.reject(new Error(`no mock for ${op}`));
      return Promise.resolve(byOp[op]);
    },
  } as unknown as GraphQLClient;
}

/** A full set of valid canned responses — one per operation's `data` shape. */
function validResponses(): Record<string, unknown> {
  const account = {
    id: 'acc-1',
    itemId: 'item-1',
    name: 'Checking',
    balance: 100,
    liveBalance: false,
    type: 'depository',
    subType: null,
    mask: null,
    isUserHidden: false,
    isUserClosed: false,
    isManual: false,
    color: null,
    limit: null,
    institutionId: null,
    hasHistoricalUpdates: false,
    hasLiveBalance: false,
    latestBalanceUpdate: null,
  };
  const security = {
    id: 'sec-1',
    name: 'Acme',
    symbol: 'ACME',
    type: 'EQUITY',
    currentPrice: 10,
    lastUpdate: 1_781_136_000_000,
    marketInfo: { closeTime: null, openTime: null },
  };
  return {
    User: { user: { id: 'user-1' } },
    Accounts: { accounts: [account] },
    Account: { account: { id: 'acc-1' } },
    Transactions: {
      transactions: {
        edges: [
          {
            cursor: 'c1',
            node: {
              id: 'txn-1',
              accountId: 'acc-1',
              itemId: 'item-1',
              amount: 5,
              date: '2026-06-01',
              name: 'Test',
              categoryId: null,
              recurringId: null,
              parentId: null,
              isReviewed: false,
              isPending: false,
              type: 'REGULAR',
              userNotes: null,
              tipAmount: null,
              suggestedCategoryIds: [],
              isoCurrencyCode: null,
              createdAt: 0,
              tags: [],
              goal: null,
            },
          },
        ],
        pageInfo: {
          endCursor: 'c1',
          hasNextPage: false,
          hasPreviousPage: false,
          startCursor: 'c1',
        },
      },
    },
    Categories: { categories: [{ id: 'cat-1', name: 'Food', childCategories: [] }] },
    Tags: { tags: [{ id: 'tag-1', name: 'trip', colorName: 'PURPLE2' }] },
    Recurrings: { recurrings: [{ id: 'rec-1', state: 'ACTIVE' }] },
    UpcomingRecurrings: { unpaidUpcomingRecurrings: [] },
    MonthlySpend: { monthlySpending: [{ id: 'm-1', date: '2026-06-01' }] },
    Networth: { networthHistory: [{ date: '2026-06-01', assets: 1, debt: 0 }] },
    BalanceHistory: { accountBalanceHistory: [{ date: '2026-06-01', balance: 100 }] },
    Holdings: {
      holdings: [{ id: 'h-1', accountId: 'acc-1', itemId: 'item-1', quantity: 1, security }],
    },
    AggregatedHoldings: { aggregatedHoldings: [] },
    InvestmentBalance: { investmentBalance: [] },
    InvestmentLiveBalance: { investmentLiveBalance: { id: 'b-1', date: '2026-06-01', balance: 1 } },
    InvestmentAllocation: { investmentAllocation: [] },
    TopMovers: { topMovers: [] },
    SecurityPrices: { securityPrices: [{ id: 'p-1', price: 10, date: '2026-06-01' }] },
    SecurityPricesHighFrequency: { securityPricesHighFrequency: [] },
  };
}

function makeContext(byOp: Record<string, unknown>, state: ReadSmokeState = {}): ReadSmokeContext {
  return { client: routedClient(byOp), state, log: () => {} };
}

const findCheck = (op: string) => READ_SMOKE_CHECKS.find((c) => c.operation === op)!;

describe('READ_SMOKE_CHECKS', () => {
  test('all 19 checks pass against valid canned responses, threading ids', async () => {
    const responses = validResponses();
    const state: ReadSmokeState = {};
    const ctx = makeContext(responses, state);
    for (const check of READ_SMOKE_CHECKS) {
      const outcome = await check.run(ctx);
      expect(outcome?.skipped, `${check.operation} should not skip with full data`).toBeUndefined();
    }
    // Accounts → account id, Holdings → security id threaded into shared state.
    expect(state.account).toEqual({ itemId: 'item-1', id: 'acc-1' });
    expect(state.securityId).toBe('sec-1');
  });

  test('Holdings prefers a non-CASH security for the price checks', async () => {
    const responses = validResponses();
    responses.Holdings = {
      holdings: [
        {
          id: 'h-cash',
          accountId: 'acc-1',
          itemId: 'item-1',
          quantity: 1,
          security: {
            id: 'cash',
            name: 'Cash',
            symbol: '',
            type: 'CASH',
            currentPrice: 1,
            lastUpdate: null,
            marketInfo: { closeTime: null, openTime: null },
          },
        },
        {
          id: 'h-eq',
          accountId: 'acc-1',
          itemId: 'item-1',
          quantity: 2,
          security: {
            id: 'eq',
            name: 'Eq',
            symbol: 'EQ',
            type: 'EQUITY',
            currentPrice: 5,
            lastUpdate: 1_781_136_000_000,
            marketInfo: { closeTime: null, openTime: null },
          },
        },
      ],
    };
    const state: ReadSmokeState = {};
    await findCheck('Holdings').run(makeContext(responses, state));
    expect(state.securityId).toBe('eq');
  });

  test('Account skips when no account id was discovered', async () => {
    const outcome = await findCheck('Account').run(makeContext(validResponses(), {}));
    expect(outcome?.skipped).toBeDefined();
  });

  test('SecurityPrices skips when no security id was discovered', async () => {
    const outcome = await findCheck('SecurityPrices').run(makeContext(validResponses(), {}));
    expect(outcome?.skipped).toBeDefined();
  });

  test('a missing load-bearing field throws (drift is caught)', async () => {
    const responses = validResponses();
    responses.Accounts = { accounts: [{ itemId: 'item-1', name: 'x', balance: 1 }] }; // no id
    await expect(findCheck('Accounts').run(makeContext(responses))).rejects.toThrow(
      /accounts\[0\]\.id/
    );
  });

  test('an empty required collection throws', async () => {
    const responses = validResponses();
    responses.MonthlySpend = { monthlySpending: [] };
    await expect(findCheck('MonthlySpend').run(makeContext(responses))).rejects.toThrow(
      /at least one row/
    );
  });

  test('Account throws when the returned id does not match the request', async () => {
    const responses = validResponses();
    responses.Account = { account: { id: 'someone-else' } };
    await expect(
      findCheck('Account').run(
        makeContext(responses, { account: { itemId: 'item-1', id: 'acc-1' } })
      )
    ).rejects.toThrow(/does not match/);
  });

  test('every check declares a distinct operation matching its rootField presence', () => {
    const ops = READ_SMOKE_CHECKS.map((c) => c.operation);
    expect(new Set(ops).size).toBe(ops.length);
    for (const check of READ_SMOKE_CHECKS) {
      expect(check.rootField.length).toBeGreaterThan(0);
    }
  });
});
