/**
 * Context-budget ratchet (#597 prerequisite).
 *
 * Pins two numbers per tool so context bloat fails a test instead of silently
 * taxing every MCP session:
 *  1. Response size — every cache-mode read tool is executed against a fixed
 *     synthetic LevelDB fixture and its response measured as
 *     `JSON.stringify(result).length`, compact because that is exactly what
 *     `src/server.ts` sends to callers (responses went compact in the #597
 *     Tier-0 diet — the ratchet's first deliberate downward turn; if the
 *     server serialization ever changes again, re-derive the budgets to
 *     stay faithful).
 *  2. Schema size — every registered tool's `JSON.stringify(def.schema).length`
 *     plus an aggregate total (the schemas load into every session).
 *
 * Ratchet policy: budgets only move DOWN, via diet PRs that shrink responses
 * or schemas. Raising a budget requires justifying the increase in the PR
 * that needs it. Budgets are measured value +~10% headroom; recalibrate with
 * `CONTEXT_BUDGET_PRINT=1 bun test tests/context-budget.test.ts`.
 * Part of #597.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ALL_TOOL_DEFS, type ToolContext } from '../src/tools/registry/index.js';
import { CopilotDatabase } from '../src/core/database.js';
import { CopilotMoneyTools } from '../src/tools/tools.js';
import { createCombinedDb, cleanupTestDb } from './helpers/test-db.js';
import { SCHEDULED_SMOKE_REPORT_MAX_CHARS } from '../src/utils/scheduled-smoke-status.js';

const DB_PATH = path.join(__dirname, 'fixtures/context-budget-db');

// ---------------------------------------------------------------------------
// Budgets (chars). Ratchet: only lower these in diet PRs; raising one needs
// an explicit justification in the PR that grows it.
// ---------------------------------------------------------------------------

// Note: get_recurring_transactions groups Copilot subscriptions relative to
// today's date (next_expected_date / this_month buckets), so its size can
// drift a few chars across month boundaries — the ~10% headroom absorbs that.
const RESPONSE_BUDGETS: Record<string, number> = {
  get_transactions: 1_585,
  get_cache_info: 870,
  refresh_database: 245,
  get_accounts: 795,
  // 1_900 -> 2_100 by #659: `decode_health.collections` gained a `repaired`
  // counter (documents kept after a non-finite numeric field was stripped),
  // which adds 13 chars per flagged collection. The populated worst case
  // measures 1_909; this is that plus the usual ~10% headroom.
  get_connection_status: 2_100,
  get_categories: 855,
  get_recurring_transactions: 755,
  get_budgets: 420,
  get_goals: 365,
  // 1_265 -> 400 by #605: rows are terse by default and the nested `prices`
  // series is opt-in. This is the ratchet turning the right way — the #622 fix
  // had raised it to 1_265 by making the fixture model reality (the series IS
  // the payload), and the diet takes it back below where it started.
  // Measured 363 on the synthetic fixture; real calls return up to 100 rows,
  // so the saving scales while the schema cost below does not.
  get_investment_prices: 400,
  // The fixture seeds no holdings, splits, or balance history, so these three
  // budgets pin the empty-response envelope only. If the fixture ever seeds
  // those collections, remeasure and recalibrate these entries.
  get_investment_splits: 75,
  get_holdings: 80,
  get_balance_history: 100,
  get_goal_history: 740,
};

const SCHEMA_BUDGETS: Record<string, number> = {
  // Cache-mode reads
  // Raised from 4_145 (#600-era diet target) — this PR adds real new
  // capability (fields/compact field selection), not bloat; see PR #593.
  get_transactions: 5_100,
  get_cache_info: 640,
  refresh_database: 485,
  get_accounts: 1_315,
  get_connection_status: 850,
  get_categories: 1_405,
  get_recurring_transactions: 1_900,
  get_budgets: 650,
  get_goals: 835,
  // Raised from 1_120 by #605: adds the `fields` param plus a description that
  // NAMES the excluded `prices` token. That naming is deliberate and is why the
  // increase is worth it — a generic selection param is undiscoverable unless
  // the tool says what "default" leaves out (see the convention note on #597).
  // Schema cost is paid every session; response cost only when called. That
  // trade only pays at scale, which is exactly the usage this tool has.
  get_investment_prices: 1_900,
  get_investment_splits: 1_635,
  get_holdings: 1_115,
  get_balance_history: 1_395,
  get_goal_history: 1_040,
  // Live (--live-reads) tools
  // Raised from 3_890 by the live field-selection parity PR (#597): adds the
  // `fields` param (fragment shared verbatim with get_transactions) plus a
  // description sentence naming the 8-vs-10 preset gap — real new capability,
  // not bloat. Measured 4_090 after review amendments (~7% headroom).
  get_transactions_live: 4_370,
  get_accounts_live: 570,
  get_categories_live: 1_555,
  get_tags_live: 530,
  get_budgets_live: 905,
  get_recurring_live: 755,
  get_networth_live: 1_955,
  get_upcoming_recurrings_live: 830,
  get_monthly_spend_live: 1_235,
  get_holdings_live: 1_210,
  get_balance_history_live: 1_800,
  get_investment_prices_live: 1_835,
  get_investment_allocation_live: 810,
  get_top_movers_live: 1_175,
  get_aggregated_holdings_live: 1_285,
  get_investment_balance_live: 1_110,
  refresh_cache: 1_335,
  // Write (--write) tools
  create_transaction: 1_980,
  delete_transaction: 1_205,
  add_transaction_to_recurring: 1_305,
  split_transaction: 2_300,
  update_transaction: 2_815,
  update_transactions: 3_735,
  review_transactions: 1_760,
  bulk_edit_transactions: 2_910,
  create_tag: 900,
  delete_tag: 435,
  create_category: 1_340,
  update_category: 1_300,
  delete_category: 440,
  set_budget: 1_205,
  set_recurring_state: 795,
  delete_recurring: 520,
  update_tag: 845,
  create_recurring: 1_845,
  update_recurring: 2_020,
};

/** Aggregate schema budget across ALL registered tools (measured +~10%). */
const SCHEMA_TOTAL_BUDGET = 71_000;

// ---------------------------------------------------------------------------
// Synthetic fixture. Deterministic content, opaque Firestore-shaped IDs
// (distinct from display names — see fixture-shape.test.ts), synthetic
// amounts only.
// ---------------------------------------------------------------------------

const CAT_GROCERIES = 'cat_9fKq2LmXbT7RwZ0pVsN1';
const CAT_TRANSPORT = 'cat_4tYh8NcJdM3QxA6uEoW2';
const CAT_COFFEE = 'cat_7bGd5PzKfL1SvC9jHrU3';
const ACC_CHECKING = 'acc_2mVx7QpLcK9TzR4wNb8Y';
const ACC_BROKERAGE = 'acc_6dRz1KvMpN4WxT7yQc3U';
const ITEM_BANK = 'item_5cJn3WfHbD8XqS1kMt6Z';
const ITEM_BROKER = 'item_8gLp4XdJcF2VzB9sWk5A';
const GOAL_FUND = 'goal_1sVc8BnMdQ5XzK3wRj9T';
const DELETED_TRANSACTION_ID = 'txn_4nYc8LbQwR2VzK7mJd5P';

async function seedFixture(): Promise<void> {
  await createCombinedDb(DB_PATH, {
    transactions: [
      {
        transaction_id: 'txn_3hWq6MzNkP9RvX2cTb7D',
        account_id: ACC_CHECKING,
        amount: 82.45,
        date: '2024-03-02',
        name: 'Synthetic Grocer',
        original_name: 'SYNTH GROCER #0001',
        category_id: CAT_GROCERIES,
        city: 'Testville',
        region: 'WA',
        country: 'US',
        note: 'weekly shop',
        tags: ['tag_5jNp8QwKcM2XzV4bRf6H'],
      },
      {
        transaction_id: 'txn_7kDm1PxJfS4WqY9vLc3N',
        account_id: ACC_CHECKING,
        amount: 3.75,
        date: '2024-03-05',
        name: 'Synthetic Coffee Bar',
        category_id: CAT_COFFEE,
        pending: true,
      },
      {
        transaction_id: 'txn_2wRb9TzLmV6KqX1cJd8F',
        account_id: ACC_CHECKING,
        amount: 45.0,
        date: '2024-02-20',
        name: 'Synthetic Transit',
        category_id: CAT_TRANSPORT,
      },
      {
        transaction_id: 'txn_8pFc4XvNjR1WzQ7mKt5B',
        account_id: ACC_CHECKING,
        amount: -2500.0,
        date: '2024-02-29',
        name: 'Synthetic Payroll',
      },
      {
        transaction_id: 'txn_6qJz3MwPdT8XvL2nRb9C',
        account_id: ACC_BROKERAGE,
        amount: 15.99,
        date: '2024-01-15',
        name: 'Synthetic Streaming',
        category_id: CAT_TRANSPORT,
        is_transfer: false,
      },
      {
        transaction_id: DELETED_TRANSACTION_ID,
        account_id: ACC_CHECKING,
        amount: 27.5,
        date: '2024-03-06',
        name: 'Synthetic Deleted Merchant',
        category_id: CAT_GROCERIES,
        user_deleted: true,
      },
    ],
    accounts: [
      {
        account_id: ACC_CHECKING,
        name: 'Synthetic Checking',
        official_name: 'Synthetic Checking Account',
        mask: '0001',
        account_type: 'depository',
        subtype: 'checking',
        institution_name: 'Synthetic Bank',
        institution_id: 'ins_000001',
        current_balance: 1500,
        available_balance: 1450,
        iso_currency_code: 'USD',
        item_id: ITEM_BANK,
      },
      {
        account_id: ACC_BROKERAGE,
        name: 'Synthetic Brokerage',
        account_type: 'investment',
        subtype: 'brokerage',
        institution_name: 'Synthetic Broker',
        institution_id: 'ins_000002',
        current_balance: 5000,
        iso_currency_code: 'USD',
        item_id: ITEM_BROKER,
      },
    ],
    recurring: [
      {
        recurring_id: 'rec_4nHt7QzKfW2XvC9mPd6J',
        name: 'Synthetic Streaming',
        amount: 15.99,
        frequency: 'monthly',
        latest_date: '2024-03-15',
        account_id: ACC_BROKERAGE,
        category_id: CAT_TRANSPORT,
        is_active: true,
        merchant_name: 'Synthetic Streaming',
      },
      {
        recurring_id: 'rec_9sLw2MvJbN5KqT8xFc1R',
        name: 'Synthetic Gym',
        amount: 30,
        frequency: 'monthly',
        latest_date: '2024-03-01',
        account_id: ACC_CHECKING,
        category_id: CAT_TRANSPORT,
        is_active: false,
      },
    ],
    budgets: [
      {
        budget_id: 'bgt_1xVc5BnKdQ8WzJ3mRt7P',
        category_id: CAT_GROCERIES,
        amount: 400,
        month: '2024-03',
        is_active: true,
        name: 'Synthetic Groceries Budget',
        spent: 82.45,
      },
      {
        budget_id: 'bgt_6mQj9TwLfX2VzN4bKc8D',
        category_id: CAT_TRANSPORT,
        amount: 120,
        month: '2024-03',
        is_active: true,
        spent: 45,
      },
    ],
    goals: [
      {
        goal_id: GOAL_FUND,
        name: 'Synthetic Emergency Fund',
        emoji: '🎯',
        created_date: '2024-01-01',
        savings: {
          type: 'savings',
          status: 'active',
          target_amount: 10000,
          tracking_type: 'monthly_contribution',
          tracking_type_monthly_contribution: 250,
          start_date: '2024-01-01',
        },
      },
    ],
    goalHistory: [
      {
        goal_id: GOAL_FUND,
        month: '2024-01',
        current_amount: 250,
        target_amount: 10000,
        total_contribution: 250,
        daily_data: {
          '2024-01-10': { balance: 100 },
          '2024-01-20': { balance: 175 },
          '2024-01-31': { balance: 250 },
        },
      },
      {
        goal_id: GOAL_FUND,
        month: '2024-02',
        current_amount: 500,
        target_amount: 10000,
        total_contribution: 250,
        daily_data: {
          '2024-02-15': { balance: 375 },
          '2024-02-29': { balance: 500 },
        },
      },
    ],
    // Real price documents (#622) carry their numbers in a nested `prices` map
    // keyed by epoch-millis — roughly one entry per trading day for a `daily`
    // month document. Modelling that here is what makes this budget meaningful:
    // the nested series is the dominant term, and #605 exists to cut it.
    investmentPrices: [
      {
        security_id: 'sec_3vBn8KwJcM1XzQ5tLf7H',
        price_type: 'hf',
        period: '2024-03-01',
        currency: 'USD',
        prices: Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [
            String(1709251200000 + i * 300_000),
            100 + i * 0.25,
          ])
        ),
      },
      {
        security_id: 'sec_3vBn8KwJcM1XzQ5tLf7H',
        price_type: 'daily',
        period: '2024-02',
        currency: 'USD',
        prices: Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [
            String(1706745600000 + i * 86_400_000),
            95 + i * 0.5,
          ])
        ),
      },
    ],
    items: [
      {
        item_id: ITEM_BANK,
        institution_name: 'Synthetic Bank',
        institution_id: 'ins_000001',
        connection_status: 'healthy',
        needs_update: false,
        last_successful_update: '2024-03-05T00:00:00Z',
      },
      {
        item_id: ITEM_BROKER,
        institution_name: 'Synthetic Broker',
        institution_id: 'ins_000002',
        connection_status: 'error',
        needs_update: true,
        error_code: 'ITEM_LOGIN_REQUIRED',
        error_message: 'Synthetic reconnect required',
        last_successful_update: '2024-02-01T00:00:00Z',
      },
    ],
    categories: [
      { category_id: CAT_GROCERIES, name: 'Synthetic Groceries', icon: '🛒', color: '#00AA55' },
      { category_id: CAT_TRANSPORT, name: 'Synthetic Transport', icon: '🚌', color: '#3355FF' },
      {
        category_id: CAT_COFFEE,
        name: 'Synthetic Coffee',
        parent_id: CAT_GROCERIES,
        icon: '☕',
        color: '#AA5500',
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Cache-mode read tools: the tools a default (read-only, no-flags) session exposes. */
const eligibleReadDefs = ALL_TOOL_DEFS.filter(
  (def) => def.schema.annotations?.readOnlyHint === true && !def.requiresLiveReads
);

/** Extra args for tools that cannot run with `{}`. */
const EXTRA_ARGS: Record<string, Record<string, unknown>> = {
  get_balance_history: { granularity: 'monthly' },
};

let ctx: ToolContext;

/**
 * Scheduled-smoke status seam (#638).
 *
 * `get_connection_status` embeds the scheduled drift-check status, which is
 * read from a well-known path under `$HOME`. Before this seam existed the
 * budget below measured whatever the developer's machine happened to contain:
 * loose in CI, where the file never exists, and able to fail spuriously in dev.
 * A test that asserts a byte count has to own every byte it is counting.
 */
let smokeStatusDir: string | null = null;
let previousSmokeStatusPath: string | undefined;

function writeSmokeStatus(contents: unknown): string {
  smokeStatusDir ??= mkdtempSync(path.join(tmpdir(), 'ctx-budget-smoke-'));
  const file = path.join(smokeStatusDir, 'scheduled-smoke.json');
  writeFileSync(file, JSON.stringify(contents));
  return file;
}

beforeAll(async () => {
  previousSmokeStatusPath = process.env.COPILOT_MCP_SMOKE_STATUS_PATH;
  // Point the reader at a path that does not exist, so the generic budget loop
  // below measures the `scheduled_smoke: null` envelope deterministically.
  smokeStatusDir = mkdtempSync(path.join(tmpdir(), 'ctx-budget-smoke-'));
  process.env.COPILOT_MCP_SMOKE_STATUS_PATH = path.join(smokeStatusDir, 'absent.json');

  cleanupTestDb(DB_PATH);
  await seedFixture();
  const db = new CopilotDatabase(DB_PATH);
  ctx = { tools: new CopilotMoneyTools(db), live: undefined };
});

afterAll(() => {
  cleanupTestDb(DB_PATH);
  if (previousSmokeStatusPath === undefined) delete process.env.COPILOT_MCP_SMOKE_STATUS_PATH;
  else process.env.COPILOT_MCP_SMOKE_STATUS_PATH = previousSmokeStatusPath;
  if (smokeStatusDir) rmSync(smokeStatusDir, { recursive: true, force: true });
  smokeStatusDir = null;
});

/** Serialize exactly like `src/server.ts` does for tool responses. */
function serializedSize(result: unknown): number {
  return JSON.stringify(result).length;
}

describe('soft-deleted transaction reads (#609)', () => {
  test('exclude deleted rows from list and transaction_id lookup', async () => {
    const listed = await ctx.tools.getTransactions({ limit: 100 });
    expect(listed.transactions.map((transaction) => transaction.transaction_id)).not.toContain(
      DELETED_TRANSACTION_ID
    );

    const lookedUp = await ctx.tools.getTransactions({ transaction_id: DELETED_TRANSACTION_ID });
    expect(lookedUp.count).toBe(0);
    expect(lookedUp.transactions).toEqual([]);
  });
});

async function runTool(name: string): Promise<unknown> {
  const def = ALL_TOOL_DEFS.find((d) => d.name === name);
  if (!def) throw new Error(`Tool not registered: ${name}`);
  let args = EXTRA_ARGS[name] ?? {};
  if (name === 'get_goal_history') {
    // Needs a goal_id; resolve one through the public tool surface. Throw
    // (not expect) so a fixture/shape problem surfaces as a clear error in
    // whichever test triggered the lookup.
    const goals = (await runTool('get_goals')) as { goals: Array<{ goal_id: string }> };
    const goalId = goals.goals[0]?.goal_id;
    if (!goalId) {
      throw new Error('fixture should seed at least one goal, but get_goals returned none');
    }
    args = { goal_id: goalId };
  }
  return def.handler(ctx, args);
}

describe('context-budget ratchet (#597)', () => {
  describe('response-size budgets (cache-mode read tools, synthetic DB)', () => {
    test('budget table covers exactly the eligible read tools (completeness guard)', () => {
      const names = eligibleReadDefs.map((def) => def.name).sort();
      // Guard against a vacuously-empty filter: the table itself is the floor.
      expect(names.length).toBeGreaterThan(0);
      // Bidirectional: a new read tool without a budget fails, and so does a
      // stale budget entry for a removed/renamed tool.
      expect(Object.keys(RESPONSE_BUDGETS).sort()).toEqual(names);
    });

    for (const def of eligibleReadDefs) {
      test(`${def.name} response stays within budget`, async () => {
        const result = await runTool(def.name);
        const size = serializedSize(result);
        if (process.env.CONTEXT_BUDGET_PRINT) {
          console.log(`[response] ${def.name}: ${size} chars`);
        }
        expect(size).toBeGreaterThan(0);
        // `?? 0` is belt-and-braces: the completeness guard already fails on a
        // missing entry; the zero fallback just guarantees this per-tool test
        // can never pass vacuously against an absent budget.
        expect(size).toBeLessThanOrEqual(RESPONSE_BUDGETS[def.name] ?? 0);
      });
    }

    /**
     * The loop above only ever measures `scheduled_smoke: null`, because CI has
     * no status file — so before #638 the populated branch of
     * `get_connection_status` had never been inside a budget at all. This pins
     * it against a maximal *legitimate* status: worst-case summary, and a
     * `report` at the truncation ceiling, which is the largest value the reader
     * can now emit no matter what wrote the file.
     */
    test('get_connection_status stays within budget with a maximal populated smoke status', async () => {
      const file = writeSmokeStatus({
        last_run: '2026-12-31T23:59:59.999Z',
        result: 'fail',
        // Worst-case one-line summary the writer can produce.
        summary: `${'surface failed: '.repeat(8)}see report`,
        // Deliberately over the ceiling: asserts the budget holds against the
        // truncated value, not against a conveniently short path.
        report: `/Users/${'x'.repeat(64)}/.claude/copilot-money/smoke-reports/${'9'.repeat(SCHEDULED_SMOKE_REPORT_MAX_CHARS)}-smoke-failure.txt`,
      });
      const previous = process.env.COPILOT_MCP_SMOKE_STATUS_PATH;
      process.env.COPILOT_MCP_SMOKE_STATUS_PATH = file;
      try {
        const result = (await runTool('get_connection_status')) as {
          scheduled_smoke: { report: string } | null;
        };
        // Guard against a vacuous pass: if the seam broke and this read null,
        // the size assertion below would trivially hold.
        expect(result.scheduled_smoke).not.toBeNull();
        expect(result.scheduled_smoke?.report.length).toBeLessThanOrEqual(
          SCHEDULED_SMOKE_REPORT_MAX_CHARS
        );
        const size = serializedSize(result);
        if (process.env.CONTEXT_BUDGET_PRINT) {
          console.log(`[response] get_connection_status (populated): ${size} chars`);
        }
        expect(size).toBeLessThanOrEqual(RESPONSE_BUDGETS.get_connection_status ?? 0);
      } finally {
        if (previous === undefined) delete process.env.COPILOT_MCP_SMOKE_STATUS_PATH;
        else process.env.COPILOT_MCP_SMOKE_STATUS_PATH = previous;
      }
    });
  });

  describe('schema-size budgets (all registered tools)', () => {
    test('budget table covers exactly the registered tools (completeness guard)', () => {
      const names = ALL_TOOL_DEFS.map((def) => def.name).sort();
      expect(names.length).toBeGreaterThan(0);
      expect(Object.keys(SCHEMA_BUDGETS).sort()).toEqual(names);
    });

    for (const def of ALL_TOOL_DEFS) {
      test(`${def.name} schema stays within budget`, () => {
        const size = JSON.stringify(def.schema).length;
        if (process.env.CONTEXT_BUDGET_PRINT) {
          console.log(`[schema] ${def.name}: ${size} chars`);
        }
        expect(size).toBeGreaterThan(0);
        // `?? 0`: see the response-budget test — fails (not passes) on a
        // missing entry, on top of the completeness guard.
        expect(size).toBeLessThanOrEqual(SCHEMA_BUDGETS[def.name] ?? 0);
      });
    }

    test('aggregate schema size stays within total budget', () => {
      const total = ALL_TOOL_DEFS.reduce((sum, def) => sum + JSON.stringify(def.schema).length, 0);
      if (process.env.CONTEXT_BUDGET_PRINT) {
        console.log(`[schema] TOTAL: ${total} chars`);
      }
      expect(total).toBeLessThanOrEqual(SCHEMA_TOTAL_BUDGET);
    });
  });
});
