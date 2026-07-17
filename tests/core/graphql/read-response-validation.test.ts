/**
 * Unit tests for warn-mode READ response-shape validation (issue #537).
 *
 * Contract under test (parallels response-validation.test.ts):
 * - happy path: a response matching the registered schema → zero warnings,
 *   zero drift counts (covered for ALL registered operations);
 * - drift (missing/renamed/retyped field we read): one structured warn on
 *   first occurrence, deduped per (operation, path, code), per-surface counter
 *   counting EVERY occurrence;
 * - never throws, never alters the payload;
 * - new/unknown server fields pass through silently (loose schemas);
 * - unregistered operations skip silently — no warn, no drift.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  QUERY_RESPONSE_SCHEMAS,
  validateQueryResponse,
  getReadResponseDriftStats,
  __resetReadResponseDriftState,
} from '../../../src/core/graphql/read-response-validation.js';

function makeAccount(): Record<string, unknown> {
  return {
    __typename: 'Account',
    id: 'AbC123dEf456GhI789jK',
    itemId: 'MnO456pQr789StU012vW',
    name: 'Synthetic Checking',
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
}

const VALID_RESPONSES: Record<string, unknown> = {
  User: {
    user: {
      __typename: 'User',
      id: 'uSr111BbB222CcC333Dd',
      budgetingConfig: {
        isEnabled: true,
        rolloversConfig: { isEnabled: false, startDate: null },
      },
    },
  },
  Accounts: { accounts: [makeAccount()] },
  Account: { account: makeAccount() },
  Tags: {
    tags: [{ __typename: 'Tag', id: 'tAg111BbB222CcC333Dd', name: 'synthetic', colorName: 'blue' }],
  },
  Recurrings: {
    recurrings: [
      {
        __typename: 'Recurring',
        id: 'rEc555FfF666GgG777Hh',
        name: 'Synthetic Streaming',
        state: 'ACTIVE',
        frequency: 'MONTHLY',
        nextPaymentAmount: 100,
        nextPaymentDate: '2026-08-01',
        categoryId: 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d',
        emoji: null,
        icon: { __typename: 'EmojiUnicode', unicode: '1F4FA' },
        rule: { nameContains: 'synthetic', minAmount: null, maxAmount: null, days: [1] },
        payments: [{ amount: 100, isPaid: false, date: '2026-08-01' }],
      },
    ],
  },
  UpcomingRecurrings: {
    unpaidUpcomingRecurrings: [
      {
        __typename: 'Recurring',
        id: 'rEc555FfF666GgG777Hh',
        name: 'Synthetic Streaming',
        state: 'ACTIVE',
        frequency: 'MONTHLY',
        nextPaymentAmount: 100,
        nextPaymentDate: '2026-08-01',
        categoryId: 'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d',
        emoji: null,
        icon: null,
        rule: null,
        payments: [],
      },
    ],
  },
  MonthlySpend: {
    monthlySpending: [
      { id: 'dAy111BbB222CcC333Dd', date: '2026-07-01', totalAmount: 150, comparisonAmount: 120 },
    ],
  },
  Networth: {
    networthHistory: [{ date: '2026-07-01', assets: 1000, debt: 200 }],
  },
  BalanceHistory: {
    accountBalanceHistory: [{ date: '2026-07-01', balance: 500 }],
  },
  Holdings: {
    holdings: [
      {
        __typename: 'Holding',
        id: 'hLd111BbB222CcC333Dd',
        accountId: 'AbC123dEf456GhI789jK',
        itemId: 'MnO456pQr789StU012vW',
        quantity: 10,
        security: {
          id: 'sEc111BbB222CcC333Dd',
          name: 'Synthetic Equity',
          symbol: 'SYN',
          type: 'EQUITY',
          currentPrice: 100,
          lastUpdate: '2026-07-01',
          marketInfo: { closeTime: null, openTime: null },
        },
        metrics: { averageCost: 90, costBasis: 900, totalReturn: 100 },
      },
    ],
  },
  AggregatedHoldings: {
    aggregatedHoldings: [
      {
        security: {
          id: 'sEc111BbB222CcC333Dd',
          name: 'Synthetic Equity',
          symbol: 'SYN',
          type: 'EQUITY',
          lastUpdate: '2026-07-01',
          marketInfo: { closeTime: null, openTime: null },
        },
        change: 5,
        value: 1000,
      },
    ],
  },
  InvestmentAllocation: {
    investmentAllocation: [
      { id: 'aLc111BbB222CcC333Dd', type: 'EQUITY', amount: 1000, percentage: 60 },
    ],
  },
  TopMovers: {
    topMovers: [
      {
        security: {
          id: 'sEc111BbB222CcC333Dd',
          name: 'Synthetic Equity',
          symbol: 'SYN',
          type: 'EQUITY',
          currentPrice: 100,
          lastUpdate: '2026-07-01',
          marketInfo: { closeTime: null, openTime: null },
        },
        values: [{ id: 'pPt111BbB222CcC333Dd', timestamp: 1_745_539_200_000, price: 100 }],
        change: 5,
      },
    ],
  },
};

describe('validateQueryResponse', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    __resetReadResponseDriftState();
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('every registered operation has a valid fixture that passes silently', () => {
    const operations = Object.keys(QUERY_RESPONSE_SCHEMAS);
    expect(operations.sort()).toEqual(Object.keys(VALID_RESPONSES).sort());
    for (const op of operations) {
      validateQueryResponse(op, VALID_RESPONSES[op]);
    }
    expect(warnSpy).not.toHaveBeenCalled();
    expect(getReadResponseDriftStats()).toEqual({});
  });

  test('unknown extra fields (new server fields) pass through without warning', () => {
    const account = makeAccount();
    account.brandNewServerField = 'whatever';
    validateQueryResponse('Accounts', { accounts: [account], anotherTopLevelExtra: 42 });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(getReadResponseDriftStats()).toEqual({});
  });

  test('a removed/renamed field warns once with a structured message and counts the drift', () => {
    const account = makeAccount();
    delete account.balance; // simulate server rename of a field we read
    validateQueryResponse('Accounts', { accounts: [account] });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('[copilot-money-mcp] read response shape drift:');
    expect(message).toContain('operation=Accounts');
    expect(message).toContain('surface=Query.accounts:response');
    expect(message).toContain('path=accounts.0.balance');
    expect(message).toContain('code=');
    expect(getReadResponseDriftStats()).toEqual({ 'Query.accounts:response': 1 });
  });

  test('a wrong-typed field we read warns (string where number expected)', () => {
    validateQueryResponse('Accounts', {
      accounts: [{ ...makeAccount(), balance: 'not-a-number' }],
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(getReadResponseDriftStats()).toEqual({ 'Query.accounts:response': 1 });
  });

  test('dedupes the warning per (operation, path, code) but counts every drifted response', () => {
    const drifted = () => {
      const account = makeAccount();
      delete account.balance;
      validateQueryResponse('Accounts', { accounts: [account] });
    };
    drifted();
    drifted();
    expect(warnSpy).toHaveBeenCalledTimes(1); // deduped
    expect(getReadResponseDriftStats()).toEqual({ 'Query.accounts:response': 2 }); // counted twice
  });

  test('unregistered operations skip silently — no warn, no drift', () => {
    // Transactions is deliberately absent (its own drop-based check owns it);
    // a totally unknown op must also skip.
    validateQueryResponse('Transactions', { transactions: 'garbage' });
    validateQueryResponse('SomeFutureQuery', { anything: 123 });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(getReadResponseDriftStats()).toEqual({});
  });

  test('never throws and never alters the payload', () => {
    const payload = { accounts: 'not-even-an-array' };
    expect(() => validateQueryResponse('Accounts', payload)).not.toThrow();
    expect(payload).toEqual({ accounts: 'not-even-an-array' });
  });
});
