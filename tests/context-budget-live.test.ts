/**
 * Context-budget ratchet for live (--live-reads) tools (#597 Task 4b).
 *
 * IMPORTANT — what these numbers mean: every budget below is measured
 * against a HAND-WRITTEN GraphQL stub client (one canned row per operation,
 * built from the captured shapes under docs/graphql-capture/operations/),
 * not against a real Copilot account. That makes this suite a REGRESSION
 * SIGNAL ON ROW WIDTH — it catches a live tool's default row growing (a new
 * field added to a mapper, a `fields` preset losing its exclusion, a nested
 * object no longer stripped) — and nothing else. It is NOT a measurement of
 * real-world response sizes: a live account's actual row can differ in
 * every dimension a stub can't model (string lengths, list lengths, nested
 * object population, category-tree depth, tag counts...). Do not quote
 * these numbers as production figures, and do not treat a passing test here
 * as evidence a real response fits inside a particular token budget.
 * (The repo's `fixture-reality-drift` bug class — docs/bugs/README.md — is
 * exactly the failure of forgetting this distinction.)
 *
 * Unlike RESPONSE_BUDGETS in tests/context-budget.test.ts (a fixed synthetic
 * LevelDB fixture shared by every cache-mode tool), each live tool here gets
 * its own fresh stubbed CopilotMoneyServer via buildLiveServer() and its own
 * canned GraphQL response — there is no shared "live fixture" to keep
 * faithful to a real account, only per-operation stub rows.
 *
 * Scope: exactly the live tools this release (#597) touched with a
 * default-row diet — see COVERED_LIVE_TOOLS below. This is an explicit
 * allowlist, not a filter over LIVE_TOOL_DEFS, so covering the remaining
 * live tools later is purely additive (add the name to the allowlist, add
 * its budget, add its stub responses).
 */

import { describe } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CopilotMoneyServer } from '../src/server.js';
import { ALL_TOOL_DEFS, type ToolDefinition } from '../src/tools/registry/index.js';
import { createMockGraphQLClient, type MockResponsesByOp } from './helpers/mock-graphql.js';
import { registerContextBudgetChecks } from './helpers/context-budget.js';
import type { AccountNode } from '../src/core/graphql/queries/accounts.js';
import type { UserNode } from '../src/core/graphql/queries/user.js';
import type { RecurringNode } from '../src/core/graphql/queries/recurrings.js';
import type { UpcomingRecurringNode } from '../src/core/graphql/queries/upcoming-recurrings.js';
import type { TopMoverNode } from '../src/core/graphql/queries/top-movers.js';
import type { InvestmentBalanceNode } from '../src/core/graphql/queries/investment-balance.js';
import type {
  TransactionNode,
  TransactionsPage,
} from '../src/core/graphql/queries/transactions.js';

/**
 * Live tools this budget table covers. This IS the completeness-guard
 * floor: `registerContextBudgetChecks` fails if a tool listed here has no
 * budget entry, AND fails if a budget entry names a tool not listed here
 * (mutation-tested below, both directions).
 */
export const COVERED_LIVE_TOOLS = [
  'get_top_movers_live',
  'get_investment_balance_live',
  'get_categories_live',
  'get_recurring_live',
  'get_upcoming_recurrings_live',
  'get_accounts_live',
  'get_transactions_live',
] as const;

// ---------------------------------------------------------------------------
// Stub rows — one per GraphQL operation, derived from
// docs/graphql-capture/operations/queries/{Accounts,Categories,Recurrings,
// UpcomingRecurrings,TopMovers,InvestmentBalance,InvestmentLiveBalance,
// Transactions,User}.md. Synthetic values only (amounts, ids, dates).
// ---------------------------------------------------------------------------

const accountRow: AccountNode = {
  id: 'acc-1',
  itemId: 'item-1',
  name: 'Test Checking',
  balance: 500,
  liveBalance: true,
  type: 'DEPOSITORY',
  subType: 'checking',
  mask: '0001',
  isUserHidden: false,
  isUserClosed: false,
  isManual: false,
  color: '#117ACA',
  limit: null,
  institutionId: 'inst-1',
  hasHistoricalUpdates: true,
  hasLiveBalance: true,
  latestBalanceUpdate: 1_750_000_000_000,
};

const userRow: UserNode = {
  id: 'user-1',
  budgetingConfig: {
    isEnabled: true,
    rolloversConfig: { isEnabled: false, startDate: null },
  },
};

// Matches the (unexported) CategoryResponseNode shape structurally: the
// Categories operation returns a tree with one level of childCategories;
// LiveCategoriesTools flattens it, so an empty childCategories array here
// is enough to exercise that path without duplicating rows.
const categoryRow = {
  id: 'cat-1',
  name: 'Groceries',
  templateId: 'Groceries',
  colorName: 'PURPLE1',
  icon: { __typename: 'EmojiUnicode' as const, unicode: '🥑' },
  isExcluded: false,
  isRolloverDisabled: false,
  canBeDeleted: true,
  budget: {
    current: {
      unassignedRolloverAmount: null,
      childRolloverAmount: null,
      unassignedAmount: null,
      resolvedAmount: 400,
      rolloverAmount: null,
      childAmount: null,
      goalAmount: null,
      amount: 400,
      month: '2026-08',
      id: 'catbud-1',
    },
    histories: [
      {
        unassignedRolloverAmount: null,
        childRolloverAmount: null,
        unassignedAmount: null,
        resolvedAmount: 380,
        rolloverAmount: null,
        childAmount: null,
        goalAmount: null,
        amount: 380,
        month: '2026-07',
        id: 'catbud-0',
      },
    ],
  },
  childCategories: [],
};

const recurringRow: RecurringNode = {
  id: 'rec-1',
  name: 'Streaming Service',
  state: 'ACTIVE',
  frequency: 'MONTHLY',
  nextPaymentAmount: 15.99,
  nextPaymentDate: '2026-09-01',
  categoryId: 'cat-1',
  emoji: '📺',
  icon: { __typename: 'EmojiUnicode', unicode: '📺' },
  rule: { nameContains: 'STREAMING', minAmount: 15, maxAmount: 16, days: [] },
  payments: [{ amount: 15.99, isPaid: false, date: '2026-09-01' }],
};

const upcomingRecurringRow: UpcomingRecurringNode = {
  id: 'rec-2',
  name: 'Gym Membership',
  state: 'ACTIVE',
  frequency: 'MONTHLY',
  nextPaymentAmount: 30,
  nextPaymentDate: '2026-09-05',
  categoryId: 'cat-1',
  emoji: '🏋️',
  icon: { __typename: 'EmojiUnicode', unicode: '🏋️' },
  rule: { nameContains: 'GYM', minAmount: 30, maxAmount: 30, days: [] },
  payments: [{ amount: 30, isPaid: false, date: '2026-09-05' }],
};

const topMoverRow: TopMoverNode = {
  security: {
    id: 'sec-1',
    name: 'Test Corp',
    symbol: 'TESTX',
    type: 'EQUITY',
    currentPrice: 100,
    lastUpdate: 1_750_000_000_000,
    marketInfo: { closeTime: null, openTime: null },
  },
  values: [
    { id: 'p1', timestamp: 1_750_000_000_000, price: 98 },
    { id: 'p2', timestamp: 1_750_086_400_000, price: 100 },
  ],
  change: 2.5,
};

const investmentBalanceHistory: InvestmentBalanceNode[] = [
  { id: 'bal-1', date: '2026-08-01', balance: 10000 },
  { id: 'bal-2', date: '2026-08-02', balance: 10200 },
];

const investmentLiveBalanceDot: InvestmentBalanceNode = {
  id: 'bal-live',
  date: '2026-08-15',
  balance: 10300,
};

const transactionNode: TransactionNode = {
  id: 'txn-1',
  accountId: 'acc-1',
  itemId: 'item-1',
  categoryId: 'cat-1',
  recurringId: null,
  parentId: null,
  isReviewed: false,
  isPending: false,
  amount: 42.5,
  date: '2026-08-05',
  name: 'Test Merchant',
  type: 'REGULAR',
  userNotes: null,
  tipAmount: null,
  suggestedCategoryIds: [],
  isoCurrencyCode: 'USD',
  createdAt: 1_754_000_000_000,
  tags: [],
  goal: null,
};

const transactionsPage: TransactionsPage = {
  edges: [{ cursor: 'cursor-1', node: transactionNode }],
  pageInfo: { endCursor: null, hasNextPage: false },
};

/**
 * One response map covering every operation any of the 7 covered tools
 * might issue. A fresh client built from this per call (see
 * buildLiveServer()) means each tool only exercises the ops it actually
 * needs — unused entries are harmless.
 */
const STUB_RESPONSES: MockResponsesByOp = {
  Accounts: { accounts: [accountRow] },
  User: { user: userRow },
  Categories: { categories: [categoryRow] },
  Recurrings: { recurrings: [recurringRow] },
  UpcomingRecurrings: { unpaidUpcomingRecurrings: [upcomingRecurringRow] },
  TopMovers: { topMovers: [topMoverRow] },
  InvestmentBalance: { investmentBalance: investmentBalanceHistory },
  InvestmentLiveBalance: { investmentLiveBalance: investmentLiveBalanceDot },
  Transactions: { transactions: transactionsPage },
};

/**
 * Fresh stubbed server per call — no live-mode caches carry over between
 * tools, so each budget measures a cold call (the realistic worst case for
 * row width; a warm call returns the identical row shape anyway).
 */
function buildLiveServer(): CopilotMoneyServer {
  const client = createMockGraphQLClient(STUB_RESPONSES);
  return new CopilotMoneyServer(
    '/nonexistent/context-budget-live-fixture',
    undefined,
    false,
    true,
    client
  );
}

/** Extra args for tools that cannot run with `{}`. */
const LIVE_ARGS: Record<string, Record<string, unknown>> = {
  get_transactions_live: { start_date: '2026-08-01', end_date: '2026-08-31' },
};

/** Extract the first content block's text, asserting it IS a text block. */
function firstText(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') {
    throw new Error(`Expected first content block to be text, got: ${first?.type ?? 'none'}`);
  }
  return first.text;
}

async function runLiveTool(name: string): Promise<unknown> {
  const server = buildLiveServer();
  const args = LIVE_ARGS[name] ?? {};
  const result = await server.handleCallTool(name, args);
  if (result.isError) {
    throw new Error(`handleCallTool('${name}') returned an error: ${firstText(result)}`);
  }
  const text = firstText(result);
  const parsed = JSON.parse(text) as unknown;
  // Measuring serializedSize(parsed) = JSON.stringify(parsed).length is only
  // faithful to `text.length` while src/server.ts serializes compact. If that
  // ever changes (pretty-printing, or any other pure-formatting transform),
  // this suite would otherwise keep reporting the old (smaller) size while
  // callers receive the new (larger) one — the exact "server transformation
  // invisible to the harness" blindness Task 4b exists to close, reopened for
  // whitespace. Assert the round trip in code so drift fails loudly.
  if (JSON.stringify(parsed).length !== text.length) {
    throw new Error(
      `handleCallTool('${name}') response is no longer compact round-trip faithful ` +
        '(JSON.stringify(JSON.parse(text)).length !== text.length). This usually means ' +
        'src/server.ts changed how it serializes tool results (e.g. added pretty-printing). ' +
        'Re-derive this measurement to read text.length directly instead of relying on the ' +
        'round trip, and re-baseline every budget in this file against the new byte counts.'
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Budgets (chars). Ratchet: only lower these in diet PRs; raising one needs
// an explicit justification in the PR that grows it. Measured value +~10%
// headroom, same convention as tests/context-budget.test.ts.
// ---------------------------------------------------------------------------
const LIVE_BUDGETS: Record<string, number> = {
  get_top_movers_live: 300,
  get_investment_balance_live: 365,
  get_categories_live: 290,
  get_recurring_live: 560,
  get_upcoming_recurrings_live: 545,
  get_accounts_live: 615,
  get_transactions_live: 715,
};

const coveredDefs: ToolDefinition[] = COVERED_LIVE_TOOLS.map((name) => {
  const def = ALL_TOOL_DEFS.find((d) => d.name === name);
  if (!def) {
    throw new Error(
      `COVERED_LIVE_TOOLS names '${name}', which is not a registered tool — check for a rename.`
    );
  }
  return def;
});

describe('context-budget ratchet — live tools (#597 Task 4b)', () => {
  registerContextBudgetChecks({
    defs: coveredDefs,
    budgets: LIVE_BUDGETS,
    getResult: (def) => runLiveTool(def.name),
    subject: 'covered live tools',
    kind: 'response',
  });
});
