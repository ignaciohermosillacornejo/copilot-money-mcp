/**
 * Tier-0 read smoke check definitions (issues #439/#460, Epic B #421).
 *
 * One check per GraphQL QUERY operation in
 * `src/core/graphql/operations.generated.ts` (19 operations). Each check
 * fires the operation against the live endpoint through its query wrapper
 * (`src/core/graphql/queries/*.ts`) and asserts the minimal invariants the
 * wrapper's callers depend on — container type, presence/type of the
 * load-bearing fields on the first row. This gates the operation signature
 * (name, args, root field): if the server renames a field or changes an
 * argument type, the run goes red.
 *
 * What this does NOT gate: the full hand-written response interfaces. Those
 * stay `unverified` in the conformance ledger until a runtime schema
 * validator lands (B3, issue #437).
 *
 * READS ONLY — every operation here is a GraphQL query; nothing mutates.
 * `tests/scripts/read-smoke-coverage.test.ts` enforces that this list and
 * the ledger's `Query.*` entries stay in lockstep with the generated
 * operations, so a new query cannot ship without a smoke + ledger entry.
 *
 * Ordering matters: checks that need real ids (Account, BalanceHistory,
 * SecurityPrices*) consume ids discovered by earlier checks via the shared
 * mutable `state`. Ids never leave the process; logs carry counts only
 * (no names, no balances — PII rules per CLAUDE.md).
 */

import type { GraphQLClient } from '../../src/core/graphql/client.js';
import { ACCOUNT } from '../../src/core/graphql/operations.generated.js';
import { fetchAccounts } from '../../src/core/graphql/queries/accounts.js';
import { fetchAggregatedHoldings } from '../../src/core/graphql/queries/aggregated-holdings.js';
import { fetchAccountBalanceHistory } from '../../src/core/graphql/queries/balance-history.js';
import { fetchCategories } from '../../src/core/graphql/queries/categories.js';
import { fetchHoldings } from '../../src/core/graphql/queries/holdings.js';
import { fetchInvestmentAllocation } from '../../src/core/graphql/queries/investment-allocation.js';
import { fetchInvestmentBalance } from '../../src/core/graphql/queries/investment-balance.js';
import { fetchInvestmentLiveBalance } from '../../src/core/graphql/queries/investment-live-balance.js';
import { fetchMonthlySpend } from '../../src/core/graphql/queries/monthly-spend.js';
import { fetchNetworthHistory } from '../../src/core/graphql/queries/networth.js';
import { fetchRecurrings } from '../../src/core/graphql/queries/recurrings.js';
import { fetchSecurityPrices } from '../../src/core/graphql/queries/security-prices.js';
import { fetchSecurityPricesHighFrequency } from '../../src/core/graphql/queries/security-prices-high-frequency.js';
import { fetchTags } from '../../src/core/graphql/queries/tags.js';
import { fetchTopMovers } from '../../src/core/graphql/queries/top-movers.js';
import {
  buildTransactionSort,
  fetchTransactionsPage,
} from '../../src/core/graphql/queries/transactions.js';
import { fetchUpcomingRecurrings } from '../../src/core/graphql/queries/upcoming-recurrings.js';
import { fetchUser } from '../../src/core/graphql/queries/user.js';

/** Ids discovered by earlier checks for later checks to consume. */
export interface ReadSmokeState {
  /** First account returned by Accounts (Account + BalanceHistory need it). */
  account?: { itemId: string; id: string };
  /** A held security id, preferably non-CASH (SecurityPrices* need it). */
  securityId?: string;
}

export interface ReadSmokeContext {
  client: GraphQLClient;
  state: ReadSmokeState;
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

/** Returned for a deliberately skipped check; failures THROW instead. */
export interface ReadSmokeOutcome {
  skipped?: string;
}

export interface ReadSmokeCheck {
  /** GraphQL operation name, e.g. 'Accounts' (matches operations.generated.ts). */
  operation: string;
  /** Root Query field the operation selects, e.g. 'accounts'. */
  rootField: string;
  run: (ctx: ReadSmokeContext) => Promise<ReadSmokeOutcome | undefined>;
}

// --- tiny assertion helpers (throw with a labeled message) -------------------

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label}: expected an array, got ${typeof value}`);
  }
}

function assertNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${label}: expected a non-empty string, got ${JSON.stringify(value)}`);
  }
}

function assertNumber(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}: expected a finite number, got ${JSON.stringify(value)}`);
  }
}

/**
 * All Tier-0 read smoke checks, in dependency order (id producers before
 * id consumers).
 */
export const READ_SMOKE_CHECKS: readonly ReadSmokeCheck[] = [
  {
    operation: 'User',
    rootField: 'user',
    run: async ({ client }) => {
      const user = await fetchUser(client);
      assertNonEmptyString(user.id, 'user.id');
      return undefined;
    },
  },
  {
    operation: 'Accounts',
    rootField: 'accounts',
    run: async ({ client, state, log }) => {
      const rows = await fetchAccounts(client);
      assertArray(rows, 'accounts');
      const first = rows[0];
      if (!first) throw new Error('accounts: expected at least one account');
      assertNonEmptyString(first.id, 'accounts[0].id');
      assertNonEmptyString(first.itemId, 'accounts[0].itemId');
      assertNonEmptyString(first.name, 'accounts[0].name');
      assertNumber(first.balance, 'accounts[0].balance');
      state.account = { itemId: first.itemId, id: first.id };
      log('accounts', { rows: rows.length });
      return undefined;
    },
  },
  {
    // No hand-written wrapper exists for the singular Account query; the
    // generated document is the external assumption, so probe it directly.
    operation: 'Account',
    rootField: 'account',
    run: async ({ client, state }) => {
      if (!state.account) return { skipped: 'no account id from the Accounts check' };
      const data = await client.query<{ itemId: string; id: string }, { account: { id: string } }>(
        'Account',
        ACCOUNT,
        state.account
      );
      if (data.account.id !== state.account.id) {
        throw new Error('account: returned id does not match the requested id');
      }
      return undefined;
    },
  },
  {
    operation: 'Transactions',
    rootField: 'transactions',
    run: async ({ client, log }) => {
      const page = await fetchTransactionsPage(client, {
        first: 5,
        after: null,
        filter: null,
        sort: buildTransactionSort(),
      });
      assertArray(page.edges, 'transactions.edges');
      const node = page.edges[0]?.node;
      if (!node) throw new Error('transactions: expected at least one edge');
      assertNonEmptyString(node.id, 'transactions.edges[0].node.id');
      assertNumber(node.amount, 'transactions.edges[0].node.amount');
      assertNonEmptyString(node.date, 'transactions.edges[0].node.date');
      if (typeof page.pageInfo.hasNextPage !== 'boolean') {
        throw new Error('transactions.pageInfo.hasNextPage: expected a boolean');
      }
      log('transactions', { edges: page.edges.length });
      return undefined;
    },
  },
  {
    operation: 'Categories',
    rootField: 'categories',
    run: async ({ client, log }) => {
      const rows = await fetchCategories(client, { rollovers: false });
      assertArray(rows, 'categories');
      const first = rows[0];
      if (!first) throw new Error('categories: expected at least one category');
      assertNonEmptyString(first.id, 'categories[0].id');
      assertNonEmptyString(first.name, 'categories[0].name');
      log('categories', { rows: rows.length });
      return undefined;
    },
  },
  {
    operation: 'Tags',
    rootField: 'tags',
    run: async ({ client, log }) => {
      const rows = await fetchTags(client);
      assertArray(rows, 'tags');
      const first = rows[0];
      if (first) {
        assertNonEmptyString(first.id, 'tags[0].id');
        assertNonEmptyString(first.colorName, 'tags[0].colorName');
      }
      log('tags', { rows: rows.length });
      return undefined;
    },
  },
  {
    operation: 'Recurrings',
    rootField: 'recurrings',
    run: async ({ client, log }) => {
      const rows = await fetchRecurrings(client);
      assertArray(rows, 'recurrings');
      const first = rows[0];
      if (first) {
        assertNonEmptyString(first.id, 'recurrings[0].id');
        assertNonEmptyString(first.state, 'recurrings[0].state');
      }
      log('recurrings', { rows: rows.length });
      return undefined;
    },
  },
  {
    operation: 'UpcomingRecurrings',
    rootField: 'unpaidUpcomingRecurrings',
    run: async ({ client, log }) => {
      const rows = await fetchUpcomingRecurrings(client);
      assertArray(rows, 'unpaidUpcomingRecurrings');
      log('upcoming-recurrings', { rows: rows.length });
      return undefined;
    },
  },
  {
    operation: 'MonthlySpend',
    rootField: 'monthlySpending',
    run: async ({ client, log }) => {
      const rows = await fetchMonthlySpend(client);
      assertArray(rows, 'monthlySpending');
      const first = rows[0];
      if (!first) throw new Error('monthlySpending: expected at least one row');
      assertNonEmptyString(first.date, 'monthlySpending[0].date');
      log('monthly-spend', { rows: rows.length });
      return undefined;
    },
  },
  {
    operation: 'Networth',
    rootField: 'networthHistory',
    run: async ({ client, log }) => {
      const rows = await fetchNetworthHistory(client, { timeFrame: 'ALL' });
      assertArray(rows, 'networthHistory');
      const first = rows[0];
      if (!first) throw new Error('networthHistory: expected at least one row');
      assertNonEmptyString(first.date, 'networthHistory[0].date');
      log('networth', { rows: rows.length });
      return undefined;
    },
  },
  {
    operation: 'BalanceHistory',
    rootField: 'accountBalanceHistory',
    run: async ({ client, state, log }) => {
      if (!state.account) return { skipped: 'no account id from the Accounts check' };
      const rows = await fetchAccountBalanceHistory(client, {
        itemId: state.account.itemId,
        accountId: state.account.id,
        timeFrame: 'ONE_MONTH',
      });
      assertArray(rows, 'accountBalanceHistory');
      const first = rows[0];
      if (first) {
        assertNonEmptyString(first.date, 'accountBalanceHistory[0].date');
        assertNumber(first.balance, 'accountBalanceHistory[0].balance');
      }
      log('balance-history', { rows: rows.length });
      return undefined;
    },
  },
  {
    operation: 'Holdings',
    rootField: 'holdings',
    run: async ({ client, state, log }) => {
      const rows = await fetchHoldings(client);
      assertArray(rows, 'holdings');
      const first = rows[0];
      if (first) {
        assertNonEmptyString(first.security.id, 'holdings[0].security.id');
        assertNumber(first.quantity, 'holdings[0].quantity');
        // Prefer a non-CASH security for the SecurityPrices* checks — CASH
        // positions have no market price history.
        const priced = rows.find((row) => row.security.type !== 'CASH') ?? first;
        state.securityId = priced.security.id;
      }
      log('holdings', { rows: rows.length });
      return undefined;
    },
  },
  {
    operation: 'AggregatedHoldings',
    rootField: 'aggregatedHoldings',
    run: async ({ client, log }) => {
      const rows = await fetchAggregatedHoldings(client, { timeFrame: 'ONE_MONTH' });
      assertArray(rows, 'aggregatedHoldings');
      log('aggregated-holdings', { rows: rows.length });
      return undefined;
    },
  },
  {
    operation: 'InvestmentBalance',
    rootField: 'investmentBalance',
    run: async ({ client, log }) => {
      const rows = await fetchInvestmentBalance(client, { timeFrame: 'ONE_MONTH' });
      assertArray(rows, 'investmentBalance');
      log('investment-balance', { rows: rows.length });
      return undefined;
    },
  },
  {
    operation: 'InvestmentLiveBalance',
    rootField: 'investmentLiveBalance',
    run: async ({ client }) => {
      const node = await fetchInvestmentLiveBalance(client);
      // A user with no investment accounts can legitimately get null here;
      // the operation + parse path is still exercised.
      if (node !== null && node !== undefined) {
        assertNonEmptyString(node.date, 'investmentLiveBalance.date');
        assertNumber(node.balance, 'investmentLiveBalance.balance');
      }
      return undefined;
    },
  },
  {
    operation: 'InvestmentAllocation',
    rootField: 'investmentAllocation',
    run: async ({ client, log }) => {
      const rows = await fetchInvestmentAllocation(client);
      assertArray(rows, 'investmentAllocation');
      log('investment-allocation', { rows: rows.length });
      return undefined;
    },
  },
  {
    operation: 'TopMovers',
    rootField: 'topMovers',
    run: async ({ client, log }) => {
      const rows = await fetchTopMovers(client);
      assertArray(rows, 'topMovers');
      log('top-movers', { rows: rows.length });
      return undefined;
    },
  },
  {
    operation: 'SecurityPrices',
    rootField: 'securityPrices',
    run: async ({ client, state, log }) => {
      if (!state.securityId) return { skipped: 'no holdings to source a security id from' };
      const rows = await fetchSecurityPrices(client, {
        id: state.securityId,
        timeFrame: 'ONE_MONTH',
      });
      assertArray(rows, 'securityPrices');
      const first = rows[0];
      if (!first) {
        throw new Error('securityPrices: expected at least one price point over ONE_MONTH');
      }
      assertNumber(first.price, 'securityPrices[0].price');
      log('security-prices', { rows: rows.length });
      return undefined;
    },
  },
  {
    operation: 'SecurityPricesHighFrequency',
    rootField: 'securityPricesHighFrequency',
    run: async ({ client, state, log }) => {
      if (!state.securityId) return { skipped: 'no holdings to source a security id from' };
      const rows = await fetchSecurityPricesHighFrequency(client, {
        id: state.securityId,
        timeFrame: 'ONE_DAY',
      });
      // Can be legitimately sparse outside market hours — assert the
      // container only.
      assertArray(rows, 'securityPricesHighFrequency');
      log('security-prices-high-frequency', { rows: rows.length });
      return undefined;
    },
  },
];
