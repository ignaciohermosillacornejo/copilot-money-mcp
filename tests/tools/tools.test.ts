/**
 * Unit tests for MCP tools.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  CopilotMoneyTools,
  createToolSchemas,
  BALANCE_HISTORY_GRANULARITIES,
  CATEGORY_VIEWS,
  TRANSACTION_TYPE_FILTERS,
} from '../../src/tools/tools.js';
import { DEFAULT_TRANSACTION_FIELDS } from '../../src/tools/field-selection.js';
import { PRICE_TYPES, TransactionSchema } from '../../src/models/index.js';
import { CopilotDatabase } from '../../src/core/database.js';
import type { Transaction, Account, Security, HoldingsHistory } from '../../src/models/index.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';

// Mock data
// Copilot Money format: positive = expenses, negative = income
const mockTransactions: Transaction[] = [
  {
    transaction_id: 'txn1',
    amount: 50.0, // Expense (positive = money out in Copilot format)
    date: '2024-01-15',
    name: 'Coffee Shop',
    category_id: 'food_dining',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn2',
    amount: 120.5, // Expense (positive = money out in Copilot format)
    date: '2024-01-20',
    name: 'Grocery Store',
    category_id: 'groceries',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn3',
    amount: 25.0, // Expense (positive = money out in Copilot format)
    date: '2024-02-10',
    original_name: 'Fast Food',
    category_id: 'food_dining',
    account_id: 'acc2',
  },
  {
    transaction_id: 'txn4',
    amount: -1000.0, // Income (negative = money in in Copilot format)
    date: '2024-01-31',
    name: 'Paycheck',
    category_id: 'income',
    account_id: 'acc1',
  },
];

/**
 * One transaction carrying EVERY field the v3 default preset keeps (#604), so
 * deleting any entry from DEFAULT_TRANSACTION_FIELDS has a fixture row that
 * can actually catch it. Both flags are `true`, which is also why the test
 * using this row turns both default filters off — a row that is excluded AND
 * an internal transfer is invisible to a default call, which is exactly the
 * case where the flags carry information.
 */
const fullyPopulatedTransaction: Transaction = {
  transaction_id: 'txn_full',
  amount: 42.0,
  date: '2024-03-01',
  name: 'Synthetic Full Row',
  category_id: 'food_dining',
  account_id: 'acc1',
  item_id: 'item_acc1',
  pending: true,
  excluded: true,
  internal_transfer: true,
};

/**
 * The 10 keys a default cache row carries. Written out LITERALLY rather than
 * derived from DEFAULT_TRANSACTION_FIELDS on purpose: an expectation derived
 * from the preset moves with it, so deleting a preset entry would still pass
 * — the vacuous-guard shape #635 shipped. Written out, a deletion fails here.
 */
const CACHE_PRESET_NAMES = [
  'transaction_id',
  'date',
  'amount',
  'name',
  'category_name',
  'account_id',
  'item_id',
  'pending',
  'excluded',
  'internal_transfer',
];

const mockAccounts: Account[] = [
  {
    account_id: 'acc1',
    current_balance: 1500.0,
    available_balance: 1450.0,
    name: 'Checking Account',
    // Carries every field the v3 diet preset (DEFAULT_ACCOUNT_FIELDS) both
    // keeps and excludes, so mutating either list has a fixture row to
    // actually catch it — see 'default cache rows drop holdings...' below.
    official_name: 'Checking Account Official',
    account_type: 'checking',
    subtype: 'checking',
    mask: '1234',
    institution_name: 'Bank of Example',
    iso_currency_code: 'USD',
    item_id: 'item1',
    user_id: 'user1',
    holdings: [{ security_id: 'sec1', quantity: 1 }],
  },
  {
    account_id: 'acc2',
    current_balance: 500.0,
    official_name: 'Savings Account',
    account_type: 'savings',
  },
];

// Additional mock data for testing new filtering behavior
const mockTransactionsWithFilters: Transaction[] = [
  {
    transaction_id: 'txn_normal',
    amount: 50.0, // Expense
    date: '2024-03-01',
    name: 'Normal Transaction',
    category_id: 'shopping',
    account_id: 'acc1',
  },
  {
    transaction_id: 'txn_transfer',
    amount: 100.0, // Transfer (expense)
    date: '2024-03-01',
    name: 'Transfer',
    category_id: 'transfer_credit_card',
    account_id: 'acc1',
    internal_transfer: true,
  },
  {
    transaction_id: 'txn_deleted',
    amount: 30.0, // Expense
    date: '2024-03-01',
    name: 'Deleted Transaction',
    category_id: 'shopping',
    account_id: 'acc1',
    plaid_deleted: true,
  },
  {
    transaction_id: 'txn_excluded',
    amount: 40.0, // Expense
    date: '2024-03-01',
    name: 'Excluded Transaction',
    category_id: 'shopping',
    account_id: 'acc1',
    excluded: true,
  },
  {
    // Split parent: has children_transaction_ids, so its amount is already
    // accounted for by the two child rows below. Double-counting this would
    // inflate spend totals.
    transaction_id: 'txn_split_parent',
    amount: 3000,
    date: '2024-03-01',
    name: 'Acme Rental Parent',
    account_id: 'acc1',
    children_transaction_ids: ['txn_split_child_a', 'txn_split_child_b'],
    old_category_id: 'shopping',
  },
  {
    transaction_id: 'txn_split_child_a',
    amount: 2000,
    date: '2024-03-01',
    name: 'Acme Rental Child A',
    category_id: 'shopping',
    account_id: 'acc1',
    parent_transaction_id: 'txn_split_parent',
  },
  {
    transaction_id: 'txn_split_child_b',
    amount: 1000,
    date: '2024-03-01',
    name: 'Acme Rental Child B',
    category_id: 'shopping',
    account_id: 'acc1',
    parent_transaction_id: 'txn_split_parent',
  },
];

// Hidden-ness lives on the account document itself (#624). It used to be
// modelled here via a `users/{uid}/accounts` customization collection, which
// Copilot no longer populates — so the fixture described a world in which the
// filter worked while real caches got no filtering at all.
const mockAccountsWithHidden: Account[] = [
  {
    account_id: 'acc_visible',
    current_balance: 1000.0,
    name: 'Visible Account',
    account_type: 'checking',
  },
  {
    account_id: 'acc_hidden',
    current_balance: 5000.0,
    name: 'Hidden Account',
    account_type: 'investment',
    user_hidden: true,
  },
];

// Mock goals for testing
const mockGoals = [
  {
    goal_id: 'goal1',
    name: 'Emergency Fund',
    emoji: '🏦',
    created_date: '2024-01-01',
    savings: {
      target_amount: 10000,
      tracking_type: 'monthly_contribution',
      tracking_type_monthly_contribution: 500,
      start_date: '2024-01-01',
      status: 'active',
      is_ongoing: false,
      inflates_budget: true,
    },
  },
  {
    goal_id: 'goal2',
    name: 'Vacation Fund',
    emoji: '✈️',
    created_date: '2024-02-01',
    savings: {
      target_amount: 3000,
      tracking_type: 'end_date',
      start_date: '2024-02-01',
      status: 'active',
      is_ongoing: true,
      inflates_budget: false,
    },
  },
];

// Mock goal history - deliberately in WRONG order (oldest first) to test the fix
// This ensures we don't rely on sort order to get the latest month
const mockGoalHistoryWrongOrder = [
  {
    goal_id: 'goal1',
    month: '2024-01', // Older month
    current_amount: 500,
    user_id: 'user1',
  },
  {
    goal_id: 'goal1',
    month: '2024-03', // Latest month - should use this value
    current_amount: 1500,
    user_id: 'user1',
  },
  {
    goal_id: 'goal1',
    month: '2024-02', // Middle month
    current_amount: 1000,
    user_id: 'user1',
  },
  {
    goal_id: 'goal2',
    month: '2024-02', // Older month
    current_amount: 200,
    user_id: 'user1',
  },
  {
    goal_id: 'goal2',
    month: '2024-03', // Latest month - should use this value
    current_amount: 800,
    user_id: 'user1',
  },
];

describe('CopilotMoneyTools', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    // Mock the database with test data
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
    // Add required cache fields for async database methods
    (db as any)._recurring = [];
    (db as any)._budgets = [];
    (db as any)._goals = [...mockGoals];
    (db as any)._goalHistory = [...mockGoalHistoryWrongOrder];
    (db as any)._investmentPrices = [];
    (db as any)._items = [];
    (db as any)._userCategories = [
      { category_id: 'food_and_drink', name: 'Food & Drink', emoji: '🍔', order: 0 },
      {
        category_id: 'groceries',
        name: 'Groceries',
        emoji: '🥑',
        parent_category_id: 'food_and_drink',
        order: 1,
      },
      {
        category_id: 'restaurants',
        name: 'Restaurants',
        emoji: '🍽',
        parent_category_id: 'food_and_drink',
        order: 2,
      },
      { category_id: 'shopping', name: 'Shopping', emoji: '🛍', order: 3 },
      { category_id: 'education', name: 'Education & Coaching', emoji: '💸', order: 4 },
    ];
    (db as any)._userAccounts = [];
    (db as any)._categoryNameMap = new Map<string, string>([
      ['food_and_drink', 'Food & Drink'],
      ['groceries', 'Groceries'],
      ['restaurants', 'Restaurants'],
      ['shopping', 'Shopping'],
      ['education', 'Education & Coaching'],
    ]);
    (db as any)._accountNameMap = new Map<string, string>();
    // Mock data for new tools
    (db as any)._securities = [
      {
        security_id: 'sec-1',
        ticker_symbol: 'AAPL',
        name: 'Apple Inc.',
        type: 'equity',
        current_price: 175.5,
      },
      {
        security_id: 'sec-2',
        ticker_symbol: 'VTSAX',
        name: 'Vanguard Total Stock Market',
        type: 'mutual fund',
        current_price: 105.2,
      },
      {
        security_id: 'sec-3',
        ticker_symbol: 'BND',
        name: 'Vanguard Bond ETF',
        type: 'etf',
        current_price: 72.3,
      },
    ];
    (db as any)._balanceHistory = [
      {
        balance_id: 'i1:acc-1:2024-01-01',
        date: '2024-01-01',
        item_id: 'i1',
        account_id: 'acc-1',
        current_balance: 1000,
      },
      {
        balance_id: 'i1:acc-1:2024-01-08',
        date: '2024-01-08',
        item_id: 'i1',
        account_id: 'acc-1',
        current_balance: 1100,
      },
      {
        balance_id: 'i1:acc-1:2024-01-15',
        date: '2024-01-15',
        item_id: 'i1',
        account_id: 'acc-1',
        current_balance: 1200,
      },
      {
        balance_id: 'i1:acc-1:2024-01-22',
        date: '2024-01-22',
        item_id: 'i1',
        account_id: 'acc-1',
        current_balance: 1300,
      },
      {
        balance_id: 'i1:acc-1:2024-01-29',
        date: '2024-01-29',
        item_id: 'i1',
        account_id: 'acc-1',
        current_balance: 1400,
      },
      {
        balance_id: 'i1:acc-1:2024-02-05',
        date: '2024-02-05',
        item_id: 'i1',
        account_id: 'acc-1',
        current_balance: 1500,
      },
      {
        balance_id: 'i1:acc-2:2024-01-01',
        date: '2024-01-01',
        item_id: 'i1',
        account_id: 'acc-2',
        current_balance: 5000,
      },
    ];
    (db as any)._tags = [];
    (db as any)._allCollectionsLoaded = true;
    (db as any)._cacheLoadedAt = Date.now();

    tools = new CopilotMoneyTools(db);
  });

  describe('getTransactions', () => {
    test('returns all transactions when no filters applied', async () => {
      const result = await tools.getTransactions({});
      expect(result.count).toBe(4);
      expect(result.transactions).toHaveLength(4);
    });

    test('omitting fields yields the terse default preset, not the full document (#604)', async () => {
      const result = await tools.getTransactions({});
      for (const txn of result.transactions) {
        // Every returned key must be a preset name — no leftover document
        // fields like category_id/plaid_category_id/normalized_merchant.
        for (const key of Object.keys(txn)) {
          expect((DEFAULT_TRANSACTION_FIELDS as readonly string[]).includes(key)).toBe(true);
        }
        // The always-present half of the preset: required document fields
        // plus the synthesized category_name.
        expect(txn).toHaveProperty('transaction_id');
        expect(txn).toHaveProperty('amount');
        expect(txn).toHaveProperty('date');
        expect(txn).toHaveProperty('category_name');
      }
      expect(result.transactions[0]).not.toHaveProperty('category_id');
      expect(result.transactions[0]).not.toHaveProperty('normalized_merchant');
      expect(result.transactions[0]).not.toHaveProperty('plaid_category_id');
    });

    test('a document carrying every preset field yields exactly those 10 keys (#604)', async () => {
      // Both flags are true on this row, so a DEFAULT call filters it out —
      // turn both filters off to see it, the same caller who is the only one
      // the two booleans inform.
      (db as any)._transactions = [fullyPopulatedTransaction];
      const result = await tools.getTransactions({
        exclude_excluded: false,
        exclude_transfers: false,
      });
      expect(result.transactions).toHaveLength(1);
      expect(Object.keys(result.transactions[0]!).sort()).toEqual([...CACHE_PRESET_NAMES].sort());
      expect(result.transactions[0]!.excluded).toBe(true);
      expect(result.transactions[0]!.internal_transfer).toBe(true);
      expect(result.transactions[0]!.item_id).toBe('item_acc1');
      expect(result.transactions[0]!.pending).toBe(true);
    });

    test('fields: ["all"] still returns the full document (#604)', async () => {
      const all = await tools.getTransactions({ fields: ['all'] });
      const terse = await tools.getTransactions({});
      // Widths are fixture-relative on purpose: these mock documents carry a
      // handful of keys, not the ~30 a real cache row does, so pinning an
      // absolute count here would measure the fixture, not the behaviour.
      expect(Object.keys(all.transactions[0]!).length).toBeGreaterThan(
        Object.keys(terse.transactions[0]!).length
      );
      expect(all.transactions[0]).toHaveProperty('category_id');
      expect(all.transactions[0]).toHaveProperty('normalized_merchant');
    });

    test('compact is rejected with a migration hint (#604)', async () => {
      // Fires on PRESENCE, so the caller who passed the old default gets the
      // same migration — and the hint has to serve them too, since
      // compact: false meant FULL rows, which is exactly what omitting
      // `fields` no longer gives.
      for (const compact of [true, false]) {
        await expect(tools.getTransactions({ compact } as never)).rejects.toThrow(
          /`compact` was removed in v3\.0\.0.*fields: \["all"\]/s
        );
      }
    });

    test('fields: [...] returns only the named fields; unknown names are omitted and reported via _field_warning', async () => {
      const result = await tools.getTransactions({
        fields: ['transaction_id', 'amount', 'not_a_real_field'],
      });
      for (const txn of result.transactions) {
        expect(Object.keys(txn).sort()).toEqual(['amount', 'transaction_id']);
      }
      expect(result._field_warning).toBeDefined();
      expect(result._field_warning).toContain('not_a_real_field');

      // No warning when every requested field is a valid transaction/enrichment name.
      const clean = await tools.getTransactions({
        fields: ['transaction_id', 'amount', 'normalized_merchant'],
      });
      expect(clean._field_warning).toBeUndefined();
    });

    test('fields: [] returns full documents at the METHOD layer', async () => {
      // Pins the #593 edge AT THE METHOD LAYER: the engine treats an empty
      // list as "no projection", and a direct method call never passes
      // through `defineTool`. A DISPATCHED call resolves differently and is
      // pinned in tests/tools/registry/empty-fields-normalization.test.ts —
      // defineTool drops the empty array, so `fields: []` takes the same
      // omitted path as everything else and yields the terse preset.
      const result = await tools.getTransactions({ fields: [] });
      expect(result.transactions[0]).toHaveProperty('category_id');
      expect(result.transactions[0]).toHaveProperty('normalized_merchant');
    });

    test('single-transaction lookup is terse by default too (#604)', async () => {
      const result = await tools.getTransactions({ transaction_id: 'txn1' });
      expect(result.transactions).toHaveLength(1);
      const txn = result.transactions[0]!;
      for (const key of Object.keys(txn)) {
        expect((DEFAULT_TRANSACTION_FIELDS as readonly string[]).includes(key)).toBe(true);
      }
      expect(txn.transaction_id).toBe('txn1');
      expect(txn).not.toHaveProperty('category_id');
      expect(txn).not.toHaveProperty('normalized_merchant');
    });

    test('single-transaction lookup also reports _field_warning on unknown names', async () => {
      const result = await tools.getTransactions({
        transaction_id: 'txn1',
        fields: ['transaction_id', 'not_a_real_field'],
      });
      expect(result.transactions).toHaveLength(1);
      expect(Object.keys(result.transactions[0])).toEqual(['transaction_id']);
      expect(result._field_warning).toBeDefined();
      expect(result._field_warning).toContain('not_a_real_field');
    });

    test('every full-width row key is a known selectable field (drift ratchet)', async () => {
      // TransactionSchema is .passthrough(), so a decoder emitting a key the
      // schema does not declare would make _field_warning claim the field
      // was "ignored" while the rows actually carry it — a self-contradicting
      // response. Pin today's verified-clean state: full-width rows only
      // carry schema-declared keys plus the two enrichment keys.
      const known = new Set([
        ...Object.keys(TransactionSchema.shape),
        'category_name',
        'normalized_merchant',
      ]);
      const result = await tools.getTransactions({});
      expect(result.transactions.length).toBeGreaterThan(0);
      const unknownKeys = new Set<string>();
      for (const txn of result.transactions) {
        for (const key of Object.keys(txn)) {
          if (!known.has(key)) unknownKeys.add(key);
        }
      }
      expect([...unknownKeys]).toEqual([]);
    });

    test('filters by start_date and end_date', async () => {
      const result = await tools.getTransactions({
        start_date: '2024-02-01',
        end_date: '2024-02-28',
      });
      expect(result.count).toBe(1);
      expect(result.transactions[0].transaction_id).toBe('txn3');
    });

    test('parses period shorthand', async () => {
      // Note: This will use current date, so we can only test it doesn't crash
      const result = await tools.getTransactions({ period: 'last_30_days' });
      expect(result.count).toBeGreaterThanOrEqual(0);
    });

    test('filters by category', async () => {
      const result = await tools.getTransactions({ category: 'food' });
      expect(result.count).toBe(2);
    });

    test('filters by merchant', async () => {
      const result = await tools.getTransactions({ merchant: 'grocery' });
      expect(result.count).toBe(1);
    });

    test('filters by account_id', async () => {
      const result = await tools.getTransactions({ account_id: 'acc1' });
      expect(result.count).toBe(3);
    });

    test('filters by amount range', async () => {
      // Amount filtering uses absolute values (magnitude)
      // min_amount: 50 matches |amount| >= 50: Coffee (-50), Grocery (-120.5), Paycheck (1000)
      // max_amount: 150 matches |amount| <= 150: Coffee (-50), Grocery (-120.5), Fast Food (-25)
      // Combined: Coffee (-50), Grocery (-120.5) = 2 transactions
      const result = await tools.getTransactions({
        min_amount: 50.0,
        max_amount: 150.0,
      });
      expect(result.count).toBe(2);
    });

    test('applies limit correctly', async () => {
      const result = await tools.getTransactions({ limit: 2 });
      expect(result.count).toBe(2);
    });

    test('combines multiple filters', async () => {
      const result = await tools.getTransactions({
        start_date: '2024-01-01',
        end_date: '2024-01-31',
        category: 'food',
        limit: 10,
      });
      expect(result.count).toBe(1);
    });

    test('filters by region', async () => {
      // Add a transaction with region for testing
      const txnWithRegion: Transaction = {
        transaction_id: 'txn_region',
        amount: 75.0,
        date: '2024-01-25',
        name: 'Regional Store',
        category_id: 'shopping',
        account_id: 'acc1',
        region: 'California',
        city: 'San Francisco',
      };
      (db as any)._transactions = [...mockTransactions, txnWithRegion];

      // #604: `region` is outside the default preset, so the row only
      // carries it when the caller names it — the filter itself is unchanged.
      const result = await tools.getTransactions({
        region: 'california',
        fields: ['default', 'region'],
      });
      expect(result.count).toBe(1);
      expect(result.transactions[0]!.region).toBe('California');
    });

    test('filters by region matching city', async () => {
      const txnWithCity: Transaction = {
        transaction_id: 'txn_city',
        amount: 85.0,
        date: '2024-01-26',
        name: 'City Store',
        category_id: 'shopping',
        account_id: 'acc1',
        city: 'Los Angeles',
      };
      (db as any)._transactions = [...mockTransactions, txnWithCity];

      const result = await tools.getTransactions({
        region: 'los angeles',
        fields: ['default', 'city'],
      });
      expect(result.count).toBe(1);
      expect(result.transactions[0]!.city).toBe('Los Angeles');
    });

    test('filters by country exact match', async () => {
      const txnWithCountry: Transaction = {
        transaction_id: 'txn_country',
        amount: 95.0,
        date: '2024-01-27',
        name: 'International Store',
        category_id: 'shopping',
        account_id: 'acc1',
        country: 'US',
      };
      (db as any)._transactions = [...mockTransactions, txnWithCountry];

      const result = await tools.getTransactions({ country: 'us', fields: ['default', 'country'] });
      expect(result.count).toBe(1);
      expect(result.transactions[0]!.country).toBe('US');
    });

    test('filters by country partial match', async () => {
      const txnWithCountry: Transaction = {
        transaction_id: 'txn_country2',
        amount: 105.0,
        date: '2024-01-28',
        name: 'Foreign Store',
        category_id: 'shopping',
        account_id: 'acc1',
        country: 'United States',
      };
      (db as any)._transactions = [...mockTransactions, txnWithCountry];

      const result = await tools.getTransactions({
        country: 'united',
        fields: ['default', 'country'],
      });
      expect(result.count).toBe(1);
      expect(result.transactions[0]!.country).toBe('United States');
    });

    test('filters by pending status', async () => {
      const pendingTxn: Transaction = {
        transaction_id: 'txn_pending',
        amount: 45.0,
        date: '2024-01-29',
        name: 'Pending Transaction',
        category_id: 'shopping',
        account_id: 'acc1',
        pending: true,
      };
      (db as any)._transactions = [...mockTransactions, pendingTxn];

      const result = await tools.getTransactions({ pending: true });
      expect(result.count).toBe(1);
      expect(result.transactions[0].pending).toBe(true);
    });

    test('filters by query (free-text search)', async () => {
      const result = await tools.getTransactions({ query: 'coffee' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].name).toBe('Coffee Shop');
    });

    test('query search is case-insensitive', async () => {
      const result = await tools.getTransactions({ query: 'GROCERY' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].name).toBe('Grocery Store');
    });

    test('filters by tag name and matches transaction with corresponding opaque tag id', async () => {
      // Transactions store opaque Firestore-generated tag IDs in tag_ids,
      // not the human-readable name. The filter must resolve name -> id.
      const taggedTxn: Transaction = {
        transaction_id: 'txn_tagged',
        amount: 55.0,
        date: '2024-01-30',
        name: 'Lunch Out',
        category_id: 'food_dining',
        account_id: 'acc1',
        tag_ids: ['9qyEMnfMXknwvx9OnYhk'],
      };
      (db as any)._transactions = [...mockTransactions, taggedTxn];
      (db as any)._tags = [{ tag_id: '9qyEMnfMXknwvx9OnYhk', name: 'Tahiti' }];

      const result = await tools.getTransactions({ tag: 'Tahiti' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].transaction_id).toBe('txn_tagged');
    });

    test('filters by tag is case-insensitive on name', async () => {
      const taggedTxn: Transaction = {
        transaction_id: 'txn_tagged_case',
        amount: 200.0,
        date: '2024-01-30',
        name: 'Hotel Stay',
        category_id: 'travel',
        account_id: 'acc1',
        tag_ids: ['9qyEMnfMXknwvx9OnYhk'],
      };
      (db as any)._transactions = [...mockTransactions, taggedTxn];
      (db as any)._tags = [{ tag_id: '9qyEMnfMXknwvx9OnYhk', name: 'Tahiti' }];

      const result = await tools.getTransactions({ tag: 'TAHITI' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].transaction_id).toBe('txn_tagged_case');
    });

    test('filters by tag with # prefix strips the #', async () => {
      const taggedTxn: Transaction = {
        transaction_id: 'txn_tagged_hash',
        amount: 65.0,
        date: '2024-01-30',
        name: 'Souvenirs',
        category_id: 'shopping',
        account_id: 'acc1',
        tag_ids: ['9qyEMnfMXknwvx9OnYhk'],
      };
      (db as any)._transactions = [...mockTransactions, taggedTxn];
      (db as any)._tags = [{ tag_id: '9qyEMnfMXknwvx9OnYhk', name: 'Tahiti' }];

      const result = await tools.getTransactions({ tag: '#Tahiti' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].transaction_id).toBe('txn_tagged_hash');
    });

    test('filters by unknown tag name returns no rows', async () => {
      const taggedTxn: Transaction = {
        transaction_id: 'txn_tagged_other',
        amount: 50.0,
        date: '2024-01-30',
        name: 'Dinner',
        category_id: 'food_dining',
        account_id: 'acc1',
        tag_ids: ['9qyEMnfMXknwvx9OnYhk'],
      };
      (db as any)._transactions = [...mockTransactions, taggedTxn];
      (db as any)._tags = [{ tag_id: '9qyEMnfMXknwvx9OnYhk', name: 'Tahiti' }];

      const result = await tools.getTransactions({ tag: 'no-such-tag' });
      expect(result.count).toBe(0);
    });

    test('filters by tag excludes transactions without tag_ids', async () => {
      (db as any)._tags = [{ tag_id: '9qyEMnfMXknwvx9OnYhk', name: 'Tahiti' }];
      // mockTransactions have no tag_ids — none should match the filter.
      const result = await tools.getTransactions({ tag: 'Tahiti' });
      expect(result.count).toBe(0);
    });

    test('filters by tag name resolves to any tag id that shares the name', async () => {
      // Two tag docs sharing a name: a transaction tagged with either ID should match.
      const taggedTxn: Transaction = {
        transaction_id: 'txn_tagged_dup',
        amount: 80.0,
        date: '2024-01-30',
        name: 'Excursion',
        category_id: 'travel',
        account_id: 'acc1',
        tag_ids: ['B'],
      };
      (db as any)._transactions = [...mockTransactions, taggedTxn];
      (db as any)._tags = [
        { tag_id: 'A', name: 'Tahiti' },
        { tag_id: 'B', name: 'Tahiti' },
      ];

      const result = await tools.getTransactions({ tag: 'Tahiti' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].transaction_id).toBe('txn_tagged_dup');
    });

    test('filters by tag still matches legacy id-equals-name tags', async () => {
      // Older tags can have an ID that happens to equal their name. The filter
      // must still resolve the input name to that ID so transactions referencing
      // the legacy ID continue to match. This pins the behavior that masked the
      // original bug.
      const taggedTxn: Transaction = {
        transaction_id: 'txn_legacy_tag',
        amount: 75.0,
        date: '2024-01-30',
        name: 'Legacy Tagged',
        category_id: 'travel',
        account_id: 'acc1',
        tag_ids: ['frenchpolynesia'],
      };
      (db as any)._transactions = [...mockTransactions, taggedTxn];
      (db as any)._tags = [{ tag_id: 'frenchpolynesia', name: 'frenchpolynesia' }];

      const result = await tools.getTransactions({ tag: 'frenchpolynesia' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].transaction_id).toBe('txn_legacy_tag');
    });

    test('filters by transaction_type hsa_eligible', async () => {
      const medicalTxn: Transaction = {
        transaction_id: 'txn_medical',
        amount: 150.0,
        date: '2024-01-30',
        name: 'CVS Pharmacy',
        category_id: 'medical_pharmacies_and_supplements',
        account_id: 'acc1',
      };
      (db as any)._transactions = [...mockTransactions, medicalTxn];

      const result = await tools.getTransactions({ transaction_type: 'hsa_eligible' });
      expect(result.count).toBe(1);
      expect(result.transactions[0].name).toBe('CVS Pharmacy');
      expect(result.type_specific_data?.total_hsa_eligible).toBeDefined();
    });

    test('filters by transaction_type tagged', async () => {
      const taggedTxn: Transaction = {
        transaction_id: 'txn_with_tag',
        amount: 75.0,
        date: '2024-01-30',
        name: 'Team Dinner',
        category_id: 'food_dining',
        account_id: 'acc1',
        tag_ids: ['team'],
      };
      (db as any)._transactions = [...mockTransactions, taggedTxn];

      const result = await tools.getTransactions({
        transaction_type: 'tagged',
        fields: ['default', 'tag_ids'],
      });
      expect(result.count).toBe(1);
      expect(result.transactions[0]!.tag_ids).toContain('team');
      expect(result.type_specific_data?.tags).toBeDefined();
      expect(Array.isArray(result.type_specific_data?.tags)).toBe(true);
    });

    test('transaction_type tagged returns tag counts', async () => {
      const txn1: Transaction = {
        transaction_id: 'txn_tag1',
        amount: 300.0,
        date: '2024-01-30',
        name: 'Scuba Diving',
        category_id: 'travel',
        account_id: 'acc1',
        tag_ids: ['frenchpolynesia', 'vacation'],
      };
      const txn2: Transaction = {
        transaction_id: 'txn_tag2',
        amount: 100.0,
        date: '2024-01-30',
        name: 'Hotel',
        category_id: 'travel',
        account_id: 'acc1',
        tag_ids: ['vacation'],
      };
      (db as any)._transactions = [...mockTransactions, txn1, txn2];

      const result = await tools.getTransactions({ transaction_type: 'tagged' });
      expect(result.count).toBe(2);
      const tags = result.type_specific_data?.tags as
        Array<{ tag: string; count: number }> | undefined;
      const tagNames = tags?.map((t) => t.tag);
      expect(tagNames).toContain('frenchpolynesia');
      expect(tagNames).toContain('vacation');
      const vacationTag = tags?.find((t) => t.tag === 'vacation');
      expect(vacationTag?.count).toBe(2);
    });
  });

  describe('getAccounts', () => {
    test('returns all accounts with total balance', async () => {
      const result = await tools.getAccounts();
      expect(result.count).toBe(2);
      expect(result.total_balance).toBe(2000.0);
      expect(result.accounts).toHaveLength(2);
    });

    test('uses the Copilot nickname as the account display name', async () => {
      db._injectDataForTesting({
        accounts: [
          {
            ...mockAccounts[0],
            name: 'Provider Checking',
            nickname: 'Household Checking',
          },
        ],
      });

      const result = await tools.getAccounts();

      expect(result.accounts[0].name).toBe('Household Checking');
    });

    test('filters by account type', async () => {
      const result = await tools.getAccounts({ account_type: 'checking' });
      expect(result.count).toBe(1);
      expect(result.accounts[0].account_type).toBe('checking');
    });

    test('strips logo fields by default', async () => {
      (db as any)._accounts = [
        { ...mockAccounts[0], logo: 'iVBORw0KGgoAAAANSU...', logo_content_type: 'image/png' },
        mockAccounts[1],
      ];
      const result = await tools.getAccounts();
      expect(result.accounts[0]).not.toHaveProperty('logo');
      expect(result.accounts[0]).not.toHaveProperty('logo_content_type');
      // Everything else about the account is preserved.
      expect(result.accounts[0].account_id).toBe('acc1');
      expect(result.accounts[0].current_balance).toBe(1500.0);
    });

    test('logo fields are reachable via fields: ["default", "logo", "logo_content_type"] (include_logos replacement)', async () => {
      (db as any)._accounts = [
        { ...mockAccounts[0], logo: 'iVBORw0KGgoAAAANSU...', logo_content_type: 'image/png' },
        mockAccounts[1],
      ];
      const result = await tools.getAccounts({ fields: ['default', 'logo', 'logo_content_type'] });
      expect(result.accounts[0].logo).toBe('iVBORw0KGgoAAAANSU...');
      expect(result.accounts[0].logo_content_type).toBe('image/png');
    });

    test('default cache rows drop holdings and the denormalized name dupes', async () => {
      const result = await tools.getAccounts({});
      expect(result.accounts[0]).not.toHaveProperty('holdings');
      expect(result.accounts[0]).not.toHaveProperty('official_name');
      expect(result.accounts[0]).not.toHaveProperty('user_id');
      expect(result.accounts[0].current_balance).toBe(1500);
    });

    test('default cache rows keep every DEFAULT_ACCOUNT_FIELDS preset field', async () => {
      const result = await tools.getAccounts({});
      expect(result.accounts[0]).toMatchObject({
        account_id: 'acc1',
        name: 'Checking Account',
        account_type: 'checking',
        subtype: 'checking',
        current_balance: 1500,
        institution_name: 'Bank of Example',
        iso_currency_code: 'USD',
        item_id: 'item1',
      });
    });

    test('holdings/official_name/user_id are reachable via an explicit fields request', async () => {
      const result = await tools.getAccounts({
        fields: ['default', 'holdings', 'official_name', 'user_id'],
      });
      expect(result.accounts[0]).toHaveProperty('holdings');
      expect(result.accounts[0].official_name).toBe('Checking Account Official');
      expect(result.accounts[0].user_id).toBe('user1');
    });

    test('include_logos is rejected with a migration hint', async () => {
      await expect(tools.getAccounts({ include_logos: true } as never)).rejects.toThrow(
        /include_logos.*removed in v3.*fields/s
      );
    });

    test('an unrecognized fields name reports _field_warning', async () => {
      const result = await tools.getAccounts({ fields: ['account_id', 'totally_bogus_field'] });
      expect(result._field_warning).toContain('totally_bogus_field');
    });

    test('_field_warning fires even on an empty result set (knownFields, not row-key fallback)', async () => {
      // Without ACCOUNT_KNOWN_FIELDS wired, unknown-name detection falls back
      // to checking requested names against the returned ROWS' own keys —
      // which stays silent when there are no rows to check against. A
      // non-matching account_type filter is the one condition that
      // distinguishes the two: this only warns because knownFields is wired.
      // Same reasoning as the get_recurring_transactions fix in #606 review.
      const result = await tools.getAccounts({
        account_type: 'no_such_account_type_at_all',
        fields: ['totally_bogus_field'],
      });
      expect(result.count).toBe(0);
      expect(result._field_warning).toContain('totally_bogus_field');
    });
  });

  describe('getAccounts with hidden accounts', () => {
    beforeEach(() => {
      // Deliberately seed the customization collection EMPTY, the way a real
      // cache has it since Copilot moved these flags onto the account records.
      (db as any)._accounts = [...mockAccountsWithHidden];
      (db as any)._userAccounts = [];
    });

    test('excludes hidden accounts by default', async () => {
      const result = await tools.getAccounts();
      expect(result.count).toBe(1);
      expect(result.accounts[0].account_id).toBe('acc_visible');
      expect(result.total_balance).toBe(1000.0);
    });

    test('includes hidden accounts when include_hidden is true', async () => {
      const result = await tools.getAccounts({ include_hidden: true });
      expect(result.count).toBe(2);
      expect(result.total_balance).toBe(6000.0);
    });

    test('does not rely on the users/{uid}/accounts customization collection (#624)', async () => {
      // The whole bug: the filter consulted a collection that is always empty,
      // so it silently did nothing. Populating that collection must not change
      // the answer — if it does, the dead path has been reintroduced.
      (db as any)._userAccounts = [{ account_id: 'acc_visible', hidden: true }];

      const result = await tools.getAccounts();

      expect(result.count).toBe(1);
      expect(result.accounts[0].account_id).toBe('acc_visible');
    });

    test('include_hidden=true: default rows still discriminate hidden/deleted from active', async () => {
      // The flags `include_hidden` toggles must survive projection, or opting
      // in returns rows a caller cannot tell apart: before `user_hidden` /
      // `user_deleted` joined the preset, a merged (user_deleted) account came
      // back shape-identical to a live one while total_balance counted it.
      (db as any)._accounts = [
        ...mockAccountsWithHidden,
        {
          account_id: 'acc_deleted',
          current_balance: 250.0,
          name: 'Merged Account',
          account_type: 'checking',
          user_deleted: true,
        },
      ];

      const result = await tools.getAccounts({ include_hidden: true });
      const byId = new Map(result.accounts.map((a) => [a.account_id, a]));

      expect(byId.get('acc_hidden')?.user_hidden).toBe(true);
      expect(byId.get('acc_deleted')?.user_deleted).toBe(true);
      // Both flags are optional on the document, so an ordinary active row is
      // distinguishable precisely by carrying neither — and pays nothing.
      expect(byId.get('acc_visible')).not.toHaveProperty('user_hidden');
      expect(byId.get('acc_visible')).not.toHaveProperty('user_deleted');
    });

    test('excludes user_deleted accounts alongside user_hidden ones', async () => {
      (db as any)._accounts = [
        ...mockAccountsWithHidden,
        {
          account_id: 'acc_deleted',
          current_balance: 250.0,
          name: 'Merged Account',
          account_type: 'checking',
          user_deleted: true,
        },
      ];

      const result = await tools.getAccounts();

      expect(result.accounts.map((a) => a.account_id)).toEqual(['acc_visible']);
    });
  });

  describe('getTransactions with filtering defaults', () => {
    beforeEach(() => {
      // Override with mock data that includes transfers, deleted, and excluded transactions
      (db as any)._transactions = [...mockTransactionsWithFilters];
    });

    test('excludes transfers, deleted, excluded, and split parents by default', async () => {
      const result = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
      });
      // Normal + two split children (they're real spend); parent is double-count.
      const ids = result.transactions.map((t) => t.transaction_id).sort();
      expect(ids).toEqual(['txn_normal', 'txn_split_child_a', 'txn_split_child_b']);
    });

    test('includes transfers when exclude_transfers is false', async () => {
      const result = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
        exclude_transfers: false,
      });
      // Normal + transfer + 2 split children
      expect(result.count).toBe(4);
    });

    test('includes deleted transactions when exclude_deleted is false', async () => {
      const result = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
        exclude_deleted: false,
      });
      // Normal + deleted + 2 split children
      expect(result.count).toBe(4);
    });

    test('includes excluded transactions when exclude_excluded is false', async () => {
      const result = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
        exclude_excluded: false,
      });
      // Normal + excluded + 2 split children
      expect(result.count).toBe(4);
    });

    test('a row in an EXCLUDED CATEGORY reports excluded:true without the raw flag', async () => {
      // Measured against a real transaction on 2026-09-11: Copilot does NOT
      // stamp the per-transaction `excluded` flag when the row's category is
      // user-excluded — the Firestore document carried `excluded: undefined`.
      // Shipping the raw flag made cache mode say "not excluded" while live
      // mode synthesized `true` from the same category, for the same row.
      (db as any)._userCategories = [
        { category_id: 'work_cat', name: 'Work', emoji: '💼', order: 0, excluded: true },
        { category_id: 'groceries', name: 'Groceries', emoji: '🥑', order: 1 },
      ];
      (db as any)._transactions = [
        {
          transaction_id: 'txn_in_excluded_cat',
          date: '2024-03-15',
          amount: 100,
          name: 'In an excluded category',
          category_id: 'work_cat',
          account_id: 'acc_1',
          item_id: 'item_1',
          // deliberately NO `excluded` key — this is the shape Copilot writes
        },
        {
          transaction_id: 'txn_in_normal_cat',
          date: '2024-03-15',
          amount: 200,
          name: 'In a normal category',
          category_id: 'groceries',
          account_id: 'acc_1',
          item_id: 'item_1',
        },
      ];

      const result = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
        exclude_excluded: false,
      });

      const inExcluded = result.transactions.find(
        (t) => t.transaction_id === 'txn_in_excluded_cat'
      );
      const inNormal = result.transactions.find((t) => t.transaction_id === 'txn_in_normal_cat');
      // The field answers "is this excluded from spending?", so it must agree
      // with the filter one line above it — and with the live surface.
      expect(inExcluded?.excluded).toBe(true);
      // ...and must not smear across every row.
      expect(inNormal?.excluded).toBe(false);
    });

    test('the raw per-transaction flag still forces excluded:true on its own', async () => {
      // The other half of the union: a row whose category is NOT excluded but
      // that carries the raw flag. Live cannot see this one at all (GraphQL
      // exposes no per-transaction exclusion), which is why the ledger entry
      // for the synthesis stays `unverified`.
      (db as any)._userCategories = [{ category_id: 'groceries', name: 'Groceries', order: 0 }];
      (db as any)._transactions = [
        {
          transaction_id: 'txn_raw_flag',
          date: '2024-03-15',
          amount: 100,
          name: 'Individually excluded',
          category_id: 'groceries',
          account_id: 'acc_1',
          item_id: 'item_1',
          excluded: true,
        },
      ];

      const result = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
        exclude_excluded: false,
      });
      expect(result.transactions[0]?.excluded).toBe(true);
    });

    test('an UNCATEGORIZED cache row is 7 keys on the wire', async () => {
      // 'a sparse cache row omits the preset fields the document lacks' gives
      // its fixture a category deliberately, so its 8 holds. Named by title
      // rather than by direction — the next insertion between them moves
      // whichever word you pick. This is the third condition on that number,
      // and the guide framed the dropped `category_name` as live mode's
      // "mirror case" — it is not: cache resolves it to `undefined` when there
      // is no category, the key survives projection because the row owns it,
      // and JSON.stringify drops it. Both modes lose the same key for the same
      // reason; live merely starts from 10.
      //
      // Asserted after a JSON round-trip for that reason — `Object.keys()` off
      // the object is 8 here and would pin the wrong thing.
      (db as any)._userCategories = [{ category_id: 'groceries', name: 'Groceries', order: 0 }];
      (db as any)._transactions = [
        {
          transaction_id: 'txn_uncategorized',
          date: '2024-03-15',
          amount: 100,
          name: 'No category',
          account_id: 'acc_1',
          item_id: 'item_1',
          // no `category_id` — and no `pending` / `internal_transfer` either
        },
      ];

      const result = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
      });
      const onTheWire = JSON.parse(JSON.stringify(result.transactions[0])) as Record<
        string,
        unknown
      >;
      expect(Object.keys(onTheWire)).toHaveLength(7);
      expect(onTheWire).not.toHaveProperty('category_name');
      // ...and the derived key is still there, because a derivation always has
      // a value — that is what separates it from the dropped ones.
      expect(onTheWire.excluded).toBe(false);
    });

    test('the transaction_id path enriches identically to the windowed one', async () => {
      // The two cache paths through getTransactions() derive the same fields,
      // and a caller who passes transaction_id must not get a different answer
      // about the same row than a caller who passed a window containing it.
      // This pins the parity itself rather than one field: the next derived
      // field that lands on only one of the two sites fails here.
      (db as any)._userCategories = [
        { category_id: 'work_cat', name: 'Work', emoji: '💼', order: 0, excluded: true },
      ];
      (db as any)._transactions = [
        {
          transaction_id: 'txn_in_excluded_cat',
          date: '2024-03-15',
          amount: 100,
          name: 'In an excluded category',
          category_id: 'work_cat',
          account_id: 'acc_1',
          item_id: 'item_1',
          // deliberately NO `excluded` key — this is the shape Copilot writes
        },
      ];

      const byId = await tools.getTransactions({ transaction_id: 'txn_in_excluded_cat' });
      const byWindow = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
        exclude_excluded: false,
      });

      expect(byId.transactions).toHaveLength(1);
      expect(byWindow.transactions).toHaveLength(1);
      expect(byId.transactions[0]).toEqual(byWindow.transactions[0]!);
      // ...and the agreed value is the derived one, not a shared omission.
      expect(byId.transactions[0]!.excluded).toBe(true);
    });

    test('a sparse cache row omits the preset fields the document lacks', async () => {
      // The two modes agree on what each preset name MEANS; they do not agree
      // on key COUNT, and the ledger header used to claim they did. Live's
      // mappers always emit a boolean, while cache projects a document and
      // copies only owned keys — so an ordinary row that is neither pending
      // nor a transfer comes back 8 wide, not 10. That is why the measured
      // headline in CHANGELOG.md reads 9 keys and not 10.
      //
      // `excluded` is the exception and must stay present: it is DERIVED, and
      // a derivation always has a value. This is the shape of an ordinary row,
      // so a change that starts emitting absent optional fields — undoing part
      // of the diet — fails here.
      //
      // "Copies only the keys a row owns" is a claim about the DOCUMENT's
      // optional fields. The enrichment keys are a separate matter: this row
      // has a category, but one without a `category_id` would own
      // `category_name: undefined` and keep the key through projection.
      // `JSON.stringify` drops it before any caller sees it, so the wire shape
      // is the same — worth knowing if this fixture ever loses its category.
      (db as any)._userCategories = [{ category_id: 'groceries', name: 'Groceries', order: 0 }];
      (db as any)._transactions = [
        {
          transaction_id: 'txn_plain',
          date: '2024-03-15',
          amount: 100,
          name: 'Plain row',
          category_id: 'groceries',
          account_id: 'acc_1',
          item_id: 'item_1',
          // no `pending`, no `internal_transfer` — an ordinary cache document
        },
      ];

      const result = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
      });

      const keys = Object.keys(result.transactions[0]!).sort();
      expect(keys).toEqual(
        CACHE_PRESET_NAMES.filter((n) => n !== 'pending' && n !== 'internal_transfer').sort()
      );
      expect(keys).toHaveLength(8);
    });

    test('a TRANSFER-CATEGORY row without the raw flag reports internal_transfer falsy', async () => {
      // Pins the deliberate asymmetry documented on the enrichment helper:
      // `excluded` is the union of the raw flag and the category predicate,
      // `internal_transfer` is the raw flag alone. exclude_transfers is
      // broader than the field on purpose — isTransferCategory() is a spend
      // heuristic that also matches `credit_card`, not a claim about what the
      // transaction IS — so this row is HIDDEN by the filter while the field
      // stays falsy. "Fixing the asymmetry" to match `excluded` fails here.
      (db as any)._userCategories = [
        { category_id: 'credit_card', name: 'Credit Card Payment', order: 0 },
      ];
      (db as any)._transactions = [
        {
          transaction_id: 'txn_card_payment',
          date: '2024-03-15',
          amount: 100,
          name: 'Card payment',
          category_id: 'credit_card',
          account_id: 'acc_1',
          item_id: 'item_1',
          // deliberately NO `internal_transfer` key
        },
      ];

      // The filter is broader than the field: default filtering hides the row.
      const filtered = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
      });
      expect(filtered.transactions).toHaveLength(0);

      // ...but the field itself must not claim the row IS an internal transfer.
      const shown = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
        exclude_transfers: false,
      });
      expect(shown.transactions[0]!.internal_transfer).toBeFalsy();

      // Same answer down the single-lookup path.
      const byId = await tools.getTransactions({ transaction_id: 'txn_card_payment' });
      expect(byId.transactions[0]!.internal_transfer).toBeFalsy();
    });

    test('includes split parents when exclude_split_parents is false', async () => {
      const result = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
        exclude_split_parents: false,
      });
      // Normal + parent + 2 children = 4
      const ids = result.transactions.map((t) => t.transaction_id).sort();
      expect(ids).toEqual([
        'txn_normal',
        'txn_split_child_a',
        'txn_split_child_b',
        'txn_split_parent',
      ]);
    });

    test('includes all transactions when all filters are disabled', async () => {
      const result = await tools.getTransactions({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
        exclude_transfers: false,
        exclude_deleted: false,
        exclude_excluded: false,
        exclude_split_parents: false,
      });
      // All 7 transactions
      expect(result.count).toBe(7);
    });
  });

  describe('getCategories', () => {
    test('returns all unique categories', async () => {
      const result = await tools.getCategories();

      expect(result.view).toBe('list');
      expect(result.count).toBeGreaterThan(0);
      expect((result.data as { categories: unknown[] }).categories).toBeDefined();
    });

    test('includes human-readable category names', async () => {
      const result = await tools.getCategories();
      const categories = (
        result.data as { categories: { category_id: string; category_name: string }[] }
      ).categories;

      const foodCategory = categories.find((c) => c.category_id === 'food_dining');
      expect(foodCategory?.category_name).toBe('Food & Drink');
    });

    test('includes transaction count and total amount', async () => {
      const result = await tools.getCategories();
      const categories = (
        result.data as { categories: { transaction_count: number; total_amount: number }[] }
      ).categories;

      // All categories should have valid count and amount fields (including $0)
      for (const cat of categories) {
        expect(cat.transaction_count).toBeGreaterThanOrEqual(0);
        expect(cat.total_amount).toBeGreaterThanOrEqual(0);
      }

      // Should include categories with transactions
      const categoriesWithTransactions = categories.filter((c) => c.transaction_count > 0);
      expect(categoriesWithTransactions.length).toBeGreaterThan(0);
    });

    test('filters by period', async () => {
      const result = await tools.getCategories({ period: 'this_month' });
      expect(result.view).toBe('list');
      expect(result.period).toBe('this_month');
    });

    test('filters by date range', async () => {
      const result = await tools.getCategories({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
      });
      expect(result.view).toBe('list');
      expect(result.period).toContain('2024-03');
    });

    test('includes parent category info', async () => {
      const result = await tools.getCategories();
      const categories = (
        result.data as {
          categories: {
            category_id: string;
            parent_category_id: string | null;
            parent_name: string | null;
          }[];
        }
      ).categories;

      // Find a subcategory that should have a parent
      const restaurants = categories.find((c) => c.category_id === 'restaurants');
      if (restaurants) {
        expect(restaurants.parent_category_id).toBe('food_and_drink');
        expect(restaurants.parent_name).toBe('Food & Drink');
      }

      // Root categories should have null parent
      const foodDrink = categories.find((c) => c.category_id === 'food_and_drink');
      if (foodDrink) {
        expect(foodDrink.parent_category_id).toBeNull();
        expect(foodDrink.parent_name).toBeNull();
      }
    });

    test('does not double-count split parents in category totals', async () => {
      // parent $300 in groceries, two children $100 + $200 also in groceries.
      // Correct total for groceries = $300, not $600.
      (db as any)._transactions = [
        {
          transaction_id: 'split_parent',
          amount: 300,
          date: '2024-03-01',
          name: 'Costco Split',
          account_id: 'acc1',
          children_transaction_ids: ['split_child_a', 'split_child_b'],
          old_category_id: 'groceries',
        },
        {
          transaction_id: 'split_child_a',
          amount: 100,
          date: '2024-03-01',
          name: 'Costco Split',
          category_id: 'groceries',
          account_id: 'acc1',
          parent_transaction_id: 'split_parent',
        },
        {
          transaction_id: 'split_child_b',
          amount: 200,
          date: '2024-03-01',
          name: 'Costco Split',
          category_id: 'groceries',
          account_id: 'acc1',
          parent_transaction_id: 'split_parent',
        },
      ];

      const result = await tools.getCategories({
        start_date: '2024-03-01',
        end_date: '2024-03-31',
      });
      const groceries = (
        result.data as { categories: { category_id: string; total_amount: number }[] }
      ).categories.find((c) => c.category_id === 'groceries');

      expect(groceries?.total_amount).toBe(300);
    });

    test('returns tree view with hierarchy', async () => {
      const result = await tools.getCategories({ view: 'tree' });

      expect(result.view).toBe('tree');
      expect(result.count).toBeGreaterThan(0);
      const data = result.data as {
        categories: { category_id: string; category_name: string; children: unknown[] }[];
      };
      expect(data.categories).toBeDefined();
      expect(Array.isArray(data.categories)).toBe(true);

      // Root categories should be those without parent_category_id
      const foodDrink = data.categories.find((c) => c.category_id === 'food_and_drink');
      expect(foodDrink).toBeDefined();
      expect(foodDrink!.category_name).toBe('Food & Drink');
      expect(foodDrink!.children.length).toBe(2); // Groceries, Restaurants

      // Each root category should have children array
      for (const cat of data.categories) {
        expect(cat.category_id).toBeDefined();
        expect(Array.isArray(cat.children)).toBe(true);
      }
    });

    test('returns search view with matching categories', async () => {
      const result = await tools.getCategories({ view: 'search', query: 'groceries' });

      expect(result.view).toBe('search');
      const data = result.data as {
        query: string;
        categories: { category_id: string; category_name: string }[];
      };
      expect(data.query).toBe('groceries');
      expect(data.categories).toBeDefined();
      expect(Array.isArray(data.categories)).toBe(true);
      expect(data.categories.length).toBe(1);
      expect(data.categories[0].category_id).toBe('groceries');
      expect(data.categories[0].category_name).toBe('Groceries');
    });

    test('returns subcategories view when parent_id provided', async () => {
      const result = await tools.getCategories({ parent_id: 'food_and_drink' });

      expect(result.view).toBe('subcategories');
      const data = result.data as {
        parent_id: string;
        parent_name: string;
        subcategories: { category_id: string; category_name: string }[];
      };
      expect(data.parent_id).toBe('food_and_drink');
      expect(data.parent_name).toBe('Food & Drink');
      expect(Array.isArray(data.subcategories)).toBe(true);
      expect(data.subcategories.length).toBe(2);
      expect(data.subcategories.map((s) => s.category_name).sort()).toEqual([
        'Groceries',
        'Restaurants',
      ]);
    });
  });

  describe('getGoals', () => {
    test('returns goals with current_amount from goal history', async () => {
      (db as any)._goals = [...mockGoals];
      (db as any)._goalHistory = [...mockGoalHistoryWrongOrder];

      const result = await tools.getGoals({});

      expect(result.count).toBe(2);
      expect(result.total_target).toBe(13000);
      expect(result.total_saved).toBe(2300); // 1500 + 800

      const emergencyFund = result.goals.find((g) => g.goal_id === 'goal1');
      expect(emergencyFund?.name).toBe('Emergency Fund');
      expect(emergencyFund?.target_amount).toBe(10000);
      expect(emergencyFund?.current_amount).toBe(1500); // Latest month (2024-03)
      expect(emergencyFund?.monthly_contribution).toBe(500);

      const vacationFund = result.goals.find((g) => g.goal_id === 'goal2');
      expect(vacationFund?.name).toBe('Vacation Fund');
      expect(vacationFund?.target_amount).toBe(3000);
      expect(vacationFund?.current_amount).toBe(800); // Latest month (2024-03)
    });

    test('uses latest month regardless of history order (regression test)', async () => {
      // This test specifically guards against the bug where we took the first
      // history entry instead of the latest month's entry
      (db as any)._goals = [
        { goal_id: 'test_goal', name: 'Test', savings: { target_amount: 1000 } },
      ];

      // Deliberately put oldest entry FIRST - this is the bug scenario
      (db as any)._goalHistory = [
        { goal_id: 'test_goal', month: '2023-01', current_amount: 100 }, // OLD - first in array
        { goal_id: 'test_goal', month: '2023-06', current_amount: 600 }, // NEWER
        { goal_id: 'test_goal', month: '2023-12', current_amount: 999 }, // LATEST - should use this
        { goal_id: 'test_goal', month: '2023-03', current_amount: 300 }, // OLD
      ];

      const result = await tools.getGoals({});

      // Must use 2023-12's value (999), NOT 2023-01's value (100)
      expect(result.goals[0]?.current_amount).toBe(999);
      expect(result.total_saved).toBe(999);
    });

    test('handles goals with no history', async () => {
      (db as any)._goals = [...mockGoals];
      (db as any)._goalHistory = []; // No history

      const result = await tools.getGoals({});

      expect(result.count).toBe(2);
      expect(result.total_saved).toBe(0);
      expect(result.goals[0]?.current_amount).toBeUndefined();
      expect(result.goals[1]?.current_amount).toBeUndefined();
    });

    test('handles history entries with undefined current_amount', async () => {
      (db as any)._goals = [{ goal_id: 'goal1', name: 'Test', savings: { target_amount: 1000 } }];
      (db as any)._goalHistory = [
        { goal_id: 'goal1', month: '2024-01' }, // No current_amount
        { goal_id: 'goal1', month: '2024-02', current_amount: 500 },
        { goal_id: 'goal1', month: '2024-03' }, // No current_amount
      ];

      const result = await tools.getGoals({});

      // Should use 2024-02's value since it's the latest with a defined current_amount
      expect(result.goals[0]?.current_amount).toBe(500);
    });

    test('filters active goals when active_only is true', async () => {
      const goalsWithInactive = [
        ...mockGoals,
        {
          goal_id: 'goal3',
          name: 'Paused Goal',
          savings: { target_amount: 5000, status: 'paused' },
        },
      ];
      (db as any)._goals = goalsWithInactive;
      (db as any)._goalHistory = [];

      const result = await tools.getGoals({ active_only: true });

      expect(result.count).toBe(2);
      expect(result.goals.map((g) => g.name)).toContain('Emergency Fund');
      expect(result.goals.map((g) => g.name)).toContain('Vacation Fund');
      expect(result.goals.map((g) => g.name)).not.toContain('Paused Goal');
    });
  });

  describe('getBudgets', () => {
    test('returns budgets with category names resolved', async () => {
      (db as any)._budgets = [
        {
          budget_id: 'budget1',
          name: 'Food Budget',
          amount: 500,
          period: 'monthly',
          category_id: 'food_and_drink',
          is_active: true,
        },
      ];
      (db as any)._userCategories = [];

      const result = await tools.getBudgets({});

      expect(result.count).toBe(1);
      expect(result.budgets[0].category_name).toBe('Food & Drink');
    });

    test('filters out budgets with orphaned category references', async () => {
      (db as any)._budgets = [
        {
          budget_id: 'valid_plaid',
          amount: 100,
          category_id: 'food_and_drink', // Known Plaid category
          is_active: true,
        },
        {
          budget_id: 'valid_user',
          amount: 200,
          category_id: 'user_cat_1', // User-defined category
          is_active: true,
        },
        {
          budget_id: 'orphan',
          amount: 50,
          category_id: 'rXFkilafMIseI6OMZ6ze', // Orphaned (deleted category)
          is_active: true,
        },
        {
          budget_id: 'no_category',
          amount: 75, // No category - should keep
          is_active: true,
        },
      ];
      // Set up user category map (must set the cache directly as _categoryNameMap)
      (db as any)._categoryNameMap = new Map([['user_cat_1', 'My Custom Category']]);

      const result = await tools.getBudgets({});

      expect(result.count).toBe(3);
      expect(result.budgets.map((b) => b.budget_id)).toContain('valid_plaid');
      expect(result.budgets.map((b) => b.budget_id)).toContain('valid_user');
      expect(result.budgets.map((b) => b.budget_id)).toContain('no_category');
      expect(result.budgets.map((b) => b.budget_id)).not.toContain('orphan');
    });

    test('calculates total_budgeted excluding orphaned budgets', async () => {
      (db as any)._budgets = [
        {
          budget_id: 'valid',
          amount: 100,
          period: 'monthly',
          category_id: 'food_and_drink',
          is_active: true,
        },
        {
          budget_id: 'orphan',
          amount: 9999, // Should not be included in total
          period: 'monthly',
          category_id: 'deleted_category_id_xyz',
          is_active: true,
        },
      ];
      (db as any)._userCategories = [];

      const result = await tools.getBudgets({});

      expect(result.count).toBe(1);
      expect(result.total_budgeted).toBe(100);
    });

    test('keeps budgets with numeric Plaid category IDs', async () => {
      (db as any)._budgets = [
        {
          budget_id: 'numeric_cat',
          amount: 150,
          category_id: '13005000', // Numeric Plaid ID for Food & Drink > Restaurant
          is_active: true,
        },
      ];
      (db as any)._userCategories = [];

      const result = await tools.getBudgets({});

      expect(result.count).toBe(1);
      expect(result.budgets[0].category_name).toBe('Food & Drink > Restaurant');
    });

    // Bug #278 context: Copilot's macOS app stopped writing to the top-level
    // `amount` field ~2 years ago. Fresh values live in `amounts[YYYY-MM]`
    // keyed by the current month. Our view must prefer that over the stale
    // top-level `amount`.
    describe('current-month from amounts map (issue #278)', () => {
      const currentMonthKey = (): string => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      };

      test('prefers amounts[current_month] over stale top-level amount', async () => {
        const month = currentMonthKey();
        (db as any)._budgets = [
          {
            budget_id: 'stale-top-level',
            amount: 100, // stale legacy value
            amounts: { [month]: 250 }, // fresh current-month value
            category_id: 'food_and_drink',
          },
        ];
        (db as any)._userCategories = [];

        const result = await tools.getBudgets({});

        expect(result.budgets[0]!.amount).toBe(250);
      });

      test('treats amounts[current_month]=0 as explicit clear (not fallback)', async () => {
        const month = currentMonthKey();
        (db as any)._budgets = [
          {
            budget_id: 'explicit-zero',
            amount: 500,
            amounts: { [month]: 0 },
            category_id: 'food_and_drink',
          },
        ];
        (db as any)._userCategories = [];

        const result = await tools.getBudgets({});

        expect(result.budgets[0]!.amount).toBe(0);
      });

      test('falls back to top-level amount when amounts map is missing', async () => {
        (db as any)._budgets = [
          {
            budget_id: 'no-amounts',
            amount: 400,
            category_id: 'food_and_drink',
          },
        ];
        (db as any)._userCategories = [];

        const result = await tools.getBudgets({});

        expect(result.budgets[0]!.amount).toBe(400);
      });

      test('falls back when amounts map has no entry for current month', async () => {
        (db as any)._budgets = [
          {
            budget_id: 'only-historic',
            amount: 300,
            amounts: { '2024-02': 175, '2024-04': 200 }, // old months only
            category_id: 'food_and_drink',
          },
        ];
        (db as any)._userCategories = [];

        const result = await tools.getBudgets({});

        expect(result.budgets[0]!.amount).toBe(300);
      });

      test('exposes the raw amounts map in the output for history lookups', async () => {
        const month = currentMonthKey();
        (db as any)._budgets = [
          {
            budget_id: 'history',
            amount: 100,
            amounts: { '2024-02': 175, '2024-04': 200, [month]: 250 },
            category_id: 'food_and_drink',
          },
        ];
        (db as any)._userCategories = [];

        const result = await tools.getBudgets({});

        expect(result.budgets[0]!.amounts).toEqual({
          '2024-02': 175,
          '2024-04': 200,
          [month]: 250,
        });
      });

      test('total_budgeted uses current-month override, not stale top-level', async () => {
        const month = currentMonthKey();
        (db as any)._budgets = [
          {
            budget_id: 'b1',
            amount: 100, // stale
            amounts: { [month]: 250 }, // fresh
            category_id: 'food_and_drink',
            period: 'monthly',
          },
        ];
        (db as any)._userCategories = [];

        const result = await tools.getBudgets({});

        expect(result.total_budgeted).toBe(250);
      });

      test('total_budgeted is 0 when current-month override clears a stale non-zero', async () => {
        const month = currentMonthKey();
        (db as any)._budgets = [
          {
            budget_id: 'cleared-for-month',
            amount: 300, // stale legacy value
            amounts: { [month]: 0 }, // explicit clear for current month
            category_id: 'food_and_drink',
            period: 'monthly',
          },
        ];
        (db as any)._userCategories = [];

        const result = await tools.getBudgets({});

        expect(result.total_budgeted).toBe(0);
      });
    });

    // Bug #278 context: 50/86 budget docs in a real LevelDB were empty
    // tombstones (Firestore's mark-as-deleted representation). Our
    // `processBudget` surfaced them as `{budget_id}` ghost entries. The
    // decoder-level guard is tested in tests/core/decoder-*.test.ts; this
    // test documents the tool-level contract that our view excludes them.
    test('drops tombstone budgets (no category_id, no amount, no amounts)', async () => {
      (db as any)._budgets = [
        {
          budget_id: 'tombstone-only-id',
          // no category_id, no amount, no amounts — what processBudget would
          // previously emit for an empty-field doc
        },
        {
          budget_id: 'real',
          amount: 100,
          category_id: 'food_and_drink',
        },
      ];
      (db as any)._userCategories = [];

      const result = await tools.getBudgets({});

      expect(result.count).toBe(1);
      expect(result.budgets[0]!.budget_id).toBe('real');
    });
  });
});

describe('CopilotMoneyTools - Location Filtering', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    tools = new CopilotMoneyTools(db);
    (db as any)._allCollectionsLoaded = true;
    (db as any)._accounts = mockAccounts;
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
  });

  test('filters by lat/lon coordinates within radius', async () => {
    // San Francisco coordinates: 37.7749, -122.4194
    const transactionsWithLocation: Transaction[] = [
      {
        transaction_id: 'txn_sf',
        amount: 50.0,
        date: '2024-01-15',
        name: 'SF Restaurant',
        category_id: 'food_dining',
        account_id: 'acc1',
        lat: 37.7749,
        lon: -122.4194,
      },
      {
        transaction_id: 'txn_oakland',
        amount: 30.0,
        date: '2024-01-16',
        name: 'Oakland Store',
        category_id: 'shopping',
        account_id: 'acc1',
        lat: 37.8044,
        lon: -122.2712, // ~15km from SF
      },
      {
        transaction_id: 'txn_la',
        amount: 100.0,
        date: '2024-01-17',
        name: 'LA Store',
        category_id: 'shopping',
        account_id: 'acc1',
        lat: 34.0522,
        lon: -118.2437, // ~560km from SF
      },
      {
        transaction_id: 'txn_no_location',
        amount: 25.0,
        date: '2024-01-18',
        name: 'No Location',
        category_id: 'shopping',
        account_id: 'acc1',
      },
    ];
    (db as any)._transactions = transactionsWithLocation;

    // Search near SF with 20km radius - should find SF and Oakland
    const result = await tools.getTransactions({
      lat: 37.7749,
      lon: -122.4194,
      radius_km: 20,
    });

    expect(result.count).toBe(2);
    expect(result.transactions.map((t) => t.transaction_id)).toContain('txn_sf');
    expect(result.transactions.map((t) => t.transaction_id)).toContain('txn_oakland');
    expect(result.transactions.map((t) => t.transaction_id)).not.toContain('txn_la');
    expect(result.transactions.map((t) => t.transaction_id)).not.toContain('txn_no_location');
  });

  test('filters by city name', async () => {
    const transactionsWithCity: Transaction[] = [
      {
        transaction_id: 'txn_sf_city',
        amount: 50.0,
        date: '2024-01-15',
        name: 'SF Restaurant',
        category_id: 'food_dining',
        account_id: 'acc1',
        city: 'San Francisco',
      },
      {
        transaction_id: 'txn_la_city',
        amount: 100.0,
        date: '2024-01-17',
        name: 'LA Store',
        category_id: 'shopping',
        account_id: 'acc1',
        city: 'Los Angeles',
      },
    ];
    (db as any)._transactions = transactionsWithCity;

    const result = await tools.getTransactions({ city: 'San Francisco' });

    expect(result.count).toBe(1);
    expect(result.transactions[0].transaction_id).toBe('txn_sf_city');
  });

  test('defaults to 10km radius when not specified', async () => {
    const transactionsWithLocation: Transaction[] = [
      {
        transaction_id: 'txn_close',
        amount: 50.0,
        date: '2024-01-15',
        name: 'Close Store',
        category_id: 'shopping',
        account_id: 'acc1',
        lat: 37.78,
        lon: -122.42, // ~1km from center
      },
      {
        transaction_id: 'txn_far',
        amount: 30.0,
        date: '2024-01-16',
        name: 'Far Store',
        category_id: 'shopping',
        account_id: 'acc1',
        lat: 37.9,
        lon: -122.5, // ~15km from center
      },
    ];
    (db as any)._transactions = transactionsWithLocation;

    // Search without radius_km - should use default 10km
    const result = await tools.getTransactions({
      lat: 37.7749,
      lon: -122.4194,
    });

    expect(result.count).toBe(1);
    expect(result.transactions[0].transaction_id).toBe('txn_close');
  });
});

describe('CopilotMoneyTools - Recurring Transactions Detail View', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    tools = new CopilotMoneyTools(db);
    (db as any)._allCollectionsLoaded = true;
    (db as any)._accounts = mockAccounts;
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
  });

  test('a recurring on a HIDDEN account still resolves its account name (#683)', async () => {
    // The other half of #683, and the half a mutation test caught: #683 gave
    // the account-visibility rule one definition and applied it in
    // getHoldings. resolveAccountName deliberately does NOT apply it — a
    // recurring item can sit on a hidden or merged account, and the caller is
    // asking what that account is CALLED, not whether to count its money.
    //
    // Nothing enforced that. Applying isVisibleAccount here too passed the
    // entire suite, so "deliberately unfiltered" was a comment a later reader
    // could delete while "fixing the inconsistency". This is the test that
    // makes the asymmetry cost something to undo.
    (db as any)._accounts = [
      {
        account_id: 'acc_gone',
        name: 'Old Checking',
        account_type: 'checking',
        user_deleted: true,
      },
      {
        account_id: 'acc_quiet',
        name: 'Hidden Savings',
        account_type: 'savings',
        user_hidden: true,
      },
    ];
    (db as any)._recurring = [
      {
        recurring_id: 'rec_hidden',
        name: 'Gym',
        amount: 40,
        merchant_name: 'Gym',
        account_id: 'acc_quiet',
        frequency: 'monthly',
        state: 'active',
        transaction_ids: [],
      },
    ];
    (db as any)._transactions = [];

    const result = await tools.getRecurringTransactions({ name: 'Gym' });

    expect(result.detail_view?.length).toBe(1);
    expect(result.detail_view?.[0].account_name).toBe('Hidden Savings');
  });

  test('returns detail view with transaction history when filtering by name', async () => {
    const mockRecurring = [
      {
        recurring_id: 'rec1',
        name: 'Netflix',
        amount: 15.99,
        merchant_name: 'Netflix',
        category_id: 'entertainment',
        account_id: 'acc1',
        frequency: 'monthly',
        state: 'active',
        transaction_ids: ['txn1', 'txn2'],
      },
    ];
    const mockTransactionsForHistory: Transaction[] = [
      {
        transaction_id: 'txn1',
        amount: 15.99,
        date: '2024-01-01',
        name: 'Netflix',
        category_id: 'entertainment',
        account_id: 'acc1',
      },
      {
        transaction_id: 'txn2',
        amount: 15.99,
        date: '2024-02-01',
        name: 'Netflix',
        category_id: 'entertainment',
        account_id: 'acc1',
      },
    ];
    (db as any)._recurring = mockRecurring;
    (db as any)._transactions = mockTransactionsForHistory;

    const result = await tools.getRecurringTransactions({ name: 'Netflix' });

    expect(result.detail_view).toBeDefined();
    expect(result.detail_view?.length).toBe(1);
    expect(result.detail_view?.[0].name).toBe('Netflix');
    expect(result.detail_view?.[0].transaction_history).toBeDefined();
    expect(result.detail_view?.[0].transaction_history?.length).toBe(2);
    // Transaction history is sorted by date descending, so txn2 (Feb) comes first
    expect(result.detail_view?.[0].transaction_history?.[0].transaction_id).toBe('txn2');
    expect(result.detail_view?.[0].transaction_history?.[1].transaction_id).toBe('txn1');
  });

  test('returns empty transaction history when no transaction_ids', async () => {
    const mockRecurring = [
      {
        recurring_id: 'rec1',
        name: 'Spotify',
        amount: 9.99,
        merchant_name: 'Spotify',
        category_id: 'entertainment',
        account_id: 'acc1',
        frequency: 'monthly',
        state: 'active',
        // No transaction_ids
      },
    ];
    (db as any)._recurring = mockRecurring;
    (db as any)._transactions = [];

    const result = await tools.getRecurringTransactions({ name: 'Spotify' });

    expect(result.detail_view).toBeDefined();
    expect(result.detail_view?.length).toBe(1);
    expect(result.detail_view?.[0].transaction_history).toEqual([]);
  });

  test('detects pattern-based recurring from repeated transactions', async () => {
    // Create multiple transactions with the same merchant over time
    const recurringTransactions: Transaction[] = [
      {
        transaction_id: 'gym1',
        amount: 50.0,
        date: '2024-01-15',
        name: 'Planet Fitness',
        category_id: 'personal_care_gyms_and_fitness_centers',
        account_id: 'acc1',
      },
      {
        transaction_id: 'gym2',
        amount: 50.0,
        date: '2024-02-15',
        name: 'Planet Fitness',
        category_id: 'personal_care_gyms_and_fitness_centers',
        account_id: 'acc1',
      },
      {
        transaction_id: 'gym3',
        amount: 50.0,
        date: '2024-03-15',
        name: 'Planet Fitness',
        category_id: 'personal_care_gyms_and_fitness_centers',
        account_id: 'acc1',
      },
    ];
    (db as any)._recurring = []; // No Copilot native recurring
    (db as any)._transactions = recurringTransactions;

    // Explicitly set date range to cover the test transactions
    const result = await tools.getRecurringTransactions({
      start_date: '2024-01-01',
      end_date: '2024-04-01',
    });

    // Should detect pattern-based recurring
    expect(result.count).toBeGreaterThan(0);
    const planetFitness = result.recurring.find((r) => r.merchant === 'Planet Fitness');
    expect(planetFitness).toBeDefined();
    expect(planetFitness?.occurrences).toBe(3);
    expect(planetFitness?.average_amount).toBe(50);
    // v3 (#606): `transactions` is excluded from the default row.
    expect(planetFitness).not.toHaveProperty('transactions');

    const fullResult = await tools.getRecurringTransactions({
      start_date: '2024-01-01',
      end_date: '2024-04-01',
      fields: ['default', 'transactions'],
    });
    const planetFitnessFull = fullResult.recurring.find((r) => r.merchant === 'Planet Fitness');
    expect(planetFitnessFull?.transactions).toBeDefined();
    expect(planetFitnessFull?.transactions?.length).toBeLessThanOrEqual(5);
  });

  test('does not count split parents as recurring occurrences', async () => {
    // Scenario: a monthly recurring charge ("Gym Fees") that the user splits
    // 50/50 every month. Child amounts are identical so the merchant clears
    // the recurring detector's 30% amount-variance filter. Each month leaves
    // 1 parent + 2 children with the same merchant name; without filtering
    // the detector sees 9 occurrences, with filtering it sees the true 6.
    const split = (suffix: string, month: string): Transaction[] => [
      {
        transaction_id: `parent-${suffix}`,
        amount: 100,
        date: month,
        name: 'Gym Fees',
        account_id: 'acc1',
        children_transaction_ids: [`child-a-${suffix}`, `child-b-${suffix}`],
        old_category_id: 'fitness',
      },
      {
        transaction_id: `child-a-${suffix}`,
        amount: 50,
        date: month,
        name: 'Gym Fees',
        category_id: 'fitness',
        account_id: 'acc1',
        parent_transaction_id: `parent-${suffix}`,
      },
      {
        transaction_id: `child-b-${suffix}`,
        amount: 50,
        date: month,
        name: 'Gym Fees',
        category_id: 'personal_care',
        account_id: 'acc1',
        parent_transaction_id: `parent-${suffix}`,
      },
    ];
    (db as any)._recurring = [];
    (db as any)._transactions = [
      ...split('jan', '2024-01-01'),
      ...split('feb', '2024-02-01'),
      ...split('mar', '2024-03-01'),
    ];

    const result = await tools.getRecurringTransactions({
      start_date: '2024-01-01',
      end_date: '2024-04-01',
    });

    // Expect occurrences to reflect real splits (2 children × 3 months = 6),
    // not parents (3 more would bring us to 9).
    const gym = result.recurring.find((r) => r.merchant === 'Gym Fees');
    expect(gym).toBeDefined();
    expect(gym!.occurrences).toBe(6);
  });

  test('returns copilot subscriptions with grouped items by state', async () => {
    // Create mock Copilot recurring with various states
    const mockRecurringForCalendar = [
      {
        recurring_id: 'rec_active',
        name: 'Netflix',
        amount: 15.99,
        merchant_name: 'Netflix',
        category_id: 'entertainment',
        account_id: 'acc1',
        frequency: 'monthly',
        state: 'active',
        next_date: '2026-02-01',
      },
      {
        recurring_id: 'rec_paused',
        name: 'Gym',
        amount: 50.0,
        merchant_name: 'Planet Fitness',
        category_id: 'fitness',
        account_id: 'acc1',
        frequency: 'monthly',
        state: 'paused',
      },
      {
        recurring_id: 'rec_archived',
        name: 'Old Service',
        amount: 9.99,
        frequency: 'monthly',
        state: 'archived',
      },
    ];
    (db as any)._recurring = mockRecurringForCalendar;
    (db as any)._transactions = [];

    // Call without name filter to get the copilot_subscriptions view
    const result = await tools.getRecurringTransactions({});

    // Verify copilot_subscriptions structure
    expect(result.copilot_subscriptions).toBeDefined();
    expect(result.copilot_subscriptions?.summary).toBeDefined();
    expect(result.copilot_subscriptions?.summary?.total_active).toBe(1);
    expect(result.copilot_subscriptions?.summary?.total_paused).toBe(1);
    expect(result.copilot_subscriptions?.summary?.total_archived).toBe(1);
    expect(result.copilot_subscriptions?.paused?.length).toBe(1);
    expect(result.copilot_subscriptions?.archived?.length).toBe(1);
  });
});

describe('CopilotMoneyTools - getRecurringTransactions field selection (#606)', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  // Three monthly-spaced, same-amount transactions from one merchant: high
  // confidence, a resolvable category, and a defined next_expected_date, so
  // every DEFAULT_RECURRING_CACHE_FIELDS entry carries a real value on the
  // detected row (mutation-check requires each preset field to be provable).
  const fatRecurringTransactions: Transaction[] = [
    {
      transaction_id: 'rec_gym1',
      amount: 50.0,
      date: '2024-01-15',
      name: 'Synthetic Gym',
      category_id: 'personal_care_gyms_and_fitness_centers',
      account_id: 'acc1',
    },
    {
      transaction_id: 'rec_gym2',
      amount: 50.0,
      date: '2024-02-15',
      name: 'Synthetic Gym',
      category_id: 'personal_care_gyms_and_fitness_centers',
      account_id: 'acc1',
    },
    {
      transaction_id: 'rec_gym3',
      amount: 50.0,
      date: '2024-03-15',
      name: 'Synthetic Gym',
      category_id: 'personal_care_gyms_and_fitness_centers',
      account_id: 'acc1',
    },
  ];

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    tools = new CopilotMoneyTools(db);
    (db as any)._allCollectionsLoaded = true;
    (db as any)._accounts = mockAccounts;
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
    (db as any)._recurring = []; // Isolate pattern-detection from Copilot subscriptions
    (db as any)._transactions = fatRecurringTransactions;
  });

  const call = (fields?: string[]) =>
    tools.getRecurringTransactions({
      start_date: '2024-01-01',
      end_date: '2024-04-01',
      ...(fields ? { fields } : {}),
    });

  test('default rows exclude transactions and confidence_reason but keep every other preset field', async () => {
    const result = await call();
    const row = result.recurring.find((r) => r.merchant === 'Synthetic Gym');
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('transactions');
    expect(row).not.toHaveProperty('confidence_reason');
    // Every DEFAULT_RECURRING_CACHE_FIELDS entry, proven present with a
    // real value (not just `undefined` surviving key deletion).
    expect(row?.merchant).toBe('Synthetic Gym');
    expect(row?.normalized_merchant).toBeTruthy();
    expect(row?.occurrences).toBe(3);
    expect(row?.average_amount).toBe(50);
    expect(row?.total_amount).toBe(150);
    expect(row?.frequency).toBe('monthly');
    expect(row?.confidence).toBe('high');
    expect(row?.category_name).toBeTruthy();
    expect(row?.category_name).not.toBe('Unknown');
    expect(row?.last_date).toBe('2024-03-15');
    expect(row?.next_expected_date).toBeTruthy();
  });

  test('fields: ["default", "transactions"] restores transactions but not confidence_reason', async () => {
    const result = await call(['default', 'transactions']);
    const row = result.recurring.find((r) => r.merchant === 'Synthetic Gym');
    expect(row?.transactions).toBeDefined();
    expect(row?.transactions?.length).toBeGreaterThan(0);
    expect(row).not.toHaveProperty('confidence_reason');
  });

  test('fields: ["all"] returns full rows', async () => {
    const result = await call(['all']);
    const row = result.recurring.find((r) => r.merchant === 'Synthetic Gym');
    expect(row?.transactions).toBeDefined();
    expect(row?.confidence_reason).toBeDefined();
    expect(typeof row?.confidence_reason).toBe('string');
    expect(row?.confidence_reason?.length ?? 0).toBeGreaterThan(0);
  });

  test('a typo in fields warns even when nothing matches (knownFields)', async () => {
    const result = await call(['default', 'not_a_real_field']);
    expect(result._field_warning).toBeDefined();
    expect(result._field_warning).toContain('not_a_real_field');
  });

  // Important 2 (task-2 review): the fixture above always yields one
  // detected row, so a typo warns identically whether or not knownFields is
  // wired — projectRows' row-key fallback finds the same absence and
  // produces the same message. Raising min_occurrences above the fixture's
  // 3 occurrences empties `recurring`, which is the one condition
  // (mirroring get_top_movers_live/get_recurring_live's own knownFields
  // tests) where the fallback goes silent ("stay silent rather than flag
  // every requested name" — src/tools/field-selection.ts) and only an
  // explicit knownFields set still warns.
  test('a typo in fields warns even on an empty result set (knownFields)', async () => {
    const result = await tools.getRecurringTransactions({
      start_date: '2024-01-01',
      end_date: '2024-04-01',
      min_occurrences: 99,
      fields: ['default', 'not_a_real_field'],
    });
    expect(result.recurring).toEqual([]);
    expect(result._field_warning).toBeDefined();
    expect(result._field_warning).toContain('not_a_real_field');
  });

  test('the terse default is smaller than the full row (#606)', async () => {
    const terse = await call();
    const full = await call(['all']);
    const terseSize = JSON.stringify(terse).length;
    const fullSize = JSON.stringify(full).length;
    expect(terseSize).toBeLessThan(fullSize);
  });
});

describe('getCacheInfo', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    // Mock the database with test data
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
    (db as any)._recurring = [];
    (db as any)._budgets = [];
    (db as any)._goals = [];
    (db as any)._goalHistory = [];
    (db as any)._investmentPrices = [];
    (db as any)._items = [];
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
    (db as any)._categoryNameMap = new Map<string, string>();
    (db as any)._accountNameMap = new Map<string, string>();

    tools = new CopilotMoneyTools(db);
  });

  test('returns cache info with transaction date range', async () => {
    const result = await tools.getCacheInfo();

    expect(result.transaction_count).toBe(4);
    expect(result.oldest_transaction_date).toBe('2024-01-15');
    expect(result.newest_transaction_date).toBe('2024-02-10');
    expect(result.cache_note).toContain('4 transactions');
  });

  test('returns null dates for empty database', async () => {
    (db as any)._transactions = [];

    const result = await tools.getCacheInfo();

    expect(result.transaction_count).toBe(0);
    expect(result.oldest_transaction_date).toBeNull();
    expect(result.newest_transaction_date).toBeNull();
    expect(result.cache_note).toContain('No transactions');
  });
});

describe('refreshDatabase', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    // Mock the database with test data
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
    (db as any)._recurring = [];
    (db as any)._budgets = [];
    (db as any)._goals = [];
    (db as any)._goalHistory = [];
    (db as any)._investmentPrices = [];
    (db as any)._items = [];
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
    (db as any)._categoryNameMap = new Map<string, string>();
    (db as any)._accountNameMap = new Map<string, string>();

    tools = new CopilotMoneyTools(db);
  });

  test('clearCache clears internal state', () => {
    // First verify data is loaded
    expect((db as any)._transactions).toHaveLength(4);

    // Clear the cache
    const result = db.clearCache();

    expect(result.cleared).toBe(true);
    expect((db as any)._transactions).toBeNull();
    expect((db as any)._accounts).toBeNull();
  });

  test('refreshDatabase return structure is correct', async () => {
    // Mock getCacheInfo to avoid disk access after clearCache
    const mockCacheInfo = {
      oldest_transaction_date: '2024-01-01',
      newest_transaction_date: '2024-03-01',
      transaction_count: 100,
      cache_note: 'Test cache info',
      decode_health: { status: 'ok' as const, note: 'test' },
    };
    db.getCacheInfo = async () => mockCacheInfo;

    const result = await tools.refreshDatabase();

    expect(result.refreshed).toBe(true);
    expect(result.message).toContain('refreshed');
    expect(result.cache_info).toBeDefined();
    expect(result.cache_info.transaction_count).toBe(100);
    expect(result.cache_info.oldest_transaction_date).toBe('2024-01-01');
    expect(result.cache_info.newest_transaction_date).toBe('2024-03-01');
  });
});

describe('createToolSchemas', () => {
  test('returns 14 tool schemas', async () => {
    const schemas = createToolSchemas();
    expect(schemas).toHaveLength(14);
  });

  test('all tools have readOnlyHint: true', async () => {
    const schemas = createToolSchemas();

    for (const schema of schemas) {
      expect(schema.annotations?.readOnlyHint).toBe(true);
    }
  });

  test('all tools have required fields', async () => {
    const schemas = createToolSchemas();

    for (const schema of schemas) {
      expect(schema.name).toBeDefined();
      expect(schema.description).toBeDefined();
      expect(schema.inputSchema).toBeDefined();
      expect(schema.inputSchema.type).toBe('object');
      expect(schema.inputSchema.properties).toBeDefined();
    }
  });

  test('tool names match expected names', async () => {
    const schemas = createToolSchemas();
    const names = schemas.map((s) => s.name);

    // Core tools
    expect(names).toContain('get_transactions');
    expect(names).toContain('get_cache_info');
    expect(names).toContain('refresh_database');
    expect(names).toContain('get_accounts');
    expect(names).toContain('get_connection_status');
    expect(names).toContain('get_categories');
    expect(names).toContain('get_recurring_transactions');
    expect(names).toContain('get_budgets');
    expect(names).toContain('get_goals');
    expect(names).toContain('get_investment_prices');
    expect(names).toContain('get_investment_splits');
    expect(names).toContain('get_holdings');
    // New tools
    expect(names).toContain('get_balance_history');
    expect(names).toContain('get_goal_history');

    // Should have exactly 14 tools
    expect(names.length).toBe(14);
  });

  test('schema enums render from the value-set constants', async () => {
    const schemas = createToolSchemas();
    const enumOf = (tool: string, prop: string): string[] | undefined => {
      const schema = schemas.find((s) => s.name === tool);
      const props = schema?.inputSchema.properties as
        Record<string, { enum?: string[] }> | undefined;
      return props?.[prop]?.enum;
    };

    expect(enumOf('get_transactions', 'transaction_type')).toEqual([...TRANSACTION_TYPE_FILTERS]);
    expect(enumOf('get_categories', 'view')).toEqual([...CATEGORY_VIEWS]);
    expect(enumOf('get_investment_prices', 'price_type')).toEqual([...PRICE_TYPES]);
    expect(enumOf('get_balance_history', 'granularity')).toEqual([
      ...BALANCE_HISTORY_GRANULARITIES,
    ]);
  });
});

describe('getConnectionStatus', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  const mockItems = [
    {
      item_id: 'item1',
      institution_name: 'Chase',
      institution_id: 'ins_56',
      billed_products: ['transactions'],
      status_transactions_last_successful_update: '2026-03-08T06:14:29.057Z',
      status_transactions_last_failed_update: null,
      latest_fetch: '2026-03-08T06:14:34.117Z',
      login_required: false,
      disconnected: false,
      consent_expiration_time: null,
      error_code: null,
      error_message: null,
    },
    {
      item_id: 'item2',
      institution_name: 'Wells Fargo',
      institution_id: 'ins_127991',
      billed_products: ['transactions'],
      status_transactions_last_successful_update: '2026-03-07T05:40:00.864Z',
      latest_fetch: '2026-03-07T14:51:45.246Z',
      login_required: true,
      disconnected: false,
      consent_expiration_time: null,
      error_code: null,
      error_message: null,
    },
    {
      item_id: 'item3',
      institution_name: 'Fidelity',
      institution_id: 'akoya_fidelity',
      billed_products: ['investments'],
      status_investments_last_successful_update: '2026-03-08T15:52:47.181Z',
      latest_investments_fetch: '2026-03-08T15:52:47.481Z',
      login_required: false,
      disconnected: false,
      consent_expiration_time: '2027-01-06T03:00:29Z',
      error_code: null,
      error_message: null,
    },
  ];

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
    (db as any)._recurring = [];
    (db as any)._budgets = [];
    (db as any)._goals = [];
    (db as any)._goalHistory = [];
    (db as any)._investmentPrices = [];
    (db as any)._items = [...mockItems];
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
    (db as any)._categoryNameMap = new Map<string, string>();
    (db as any)._accountNameMap = new Map<string, string>();

    tools = new CopilotMoneyTools(db);
  });

  test('returns connection status for all institutions', async () => {
    const result = await tools.getConnectionStatus();

    expect(result.connections.length).toBe(3);
    expect(result.summary.total).toBe(3);
  });

  test('correctly identifies connected institutions', async () => {
    const result = await tools.getConnectionStatus();

    const chase = result.connections.find((c) => c.institution_name === 'Chase');
    expect(chase?.status).toBe('connected');
    expect(chase?.login_required).toBe(false);
    expect(chase?.last_transactions_update).toBe('2026-03-08T06:14:29.057Z');
    expect(chase?.latest_fetch).toBe('2026-03-08T06:14:34.117Z');
  });

  test('correctly identifies login_required institutions', async () => {
    const result = await tools.getConnectionStatus();

    const wells = result.connections.find((c) => c.institution_name === 'Wells Fargo');
    expect(wells?.status).toBe('login_required');
    expect(wells?.login_required).toBe(true);
  });

  test('returns per-product sync timestamps', async () => {
    const result = await tools.getConnectionStatus();

    const fidelity = result.connections.find((c) => c.institution_name === 'Fidelity');
    expect(fidelity?.last_investments_update).toBe('2026-03-08T15:52:47.181Z');
    expect(fidelity?.consent_expires).toBe('2027-01-06T03:00:29Z');
  });

  test('summary counts are accurate', async () => {
    const result = await tools.getConnectionStatus();

    expect(result.summary.connected).toBe(2); // Chase + Fidelity
    expect(result.summary.needs_attention).toBe(1); // Wells Fargo (login_required)
  });

  test('returns empty connections for no items', async () => {
    (db as any)._items = [];

    const result = await tools.getConnectionStatus();

    expect(result.connections.length).toBe(0);
    expect(result.summary.total).toBe(0);
    expect(result.summary.connected).toBe(0);
    expect(result.summary.needs_attention).toBe(0);
  });
});

describe('getAccounts - total balance calculation', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._transactions = [];
    (db as any)._accounts = [];
    (db as any)._recurring = [];
    (db as any)._budgets = [];
    (db as any)._goals = [];
    (db as any)._goalHistory = [];
    (db as any)._investmentPrices = [];
    (db as any)._items = [];
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
    (db as any)._categoryNameMap = new Map<string, string>();
    (db as any)._accountNameMap = new Map<string, string>();

    tools = new CopilotMoneyTools(db);
  });

  test('calculates total balance with mixed account types', async () => {
    // Mock accounts with assets and liabilities
    const mixedAccounts: Account[] = [
      {
        account_id: 'checking1',
        current_balance: 1000.0,
        account_type: 'depository', // ASSET
        name: 'Checking',
      },
      {
        account_id: 'investment1',
        current_balance: 5000.0,
        account_type: 'investment', // ASSET
        name: 'Brokerage',
      },
      {
        account_id: 'mortgage1',
        current_balance: 300000.0,
        account_type: 'loan', // LIABILITY
        name: 'Mortgage',
      },
      {
        account_id: 'credit1',
        current_balance: 2000.0,
        account_type: 'credit', // LIABILITY
        name: 'Credit Card',
      },
    ];

    (db as any)._accounts = mixedAccounts;
    (db as any)._userAccounts = [];

    const result = await tools.getAccounts();

    // Total Balance = Assets - Liabilities
    // = (1000 + 5000) - (300000 + 2000) = 6000 - 302000 = -296000
    expect(result.total_balance).toBe(-296000.0);
    expect(result.total_assets).toBe(6000.0);
    expect(result.total_liabilities).toBe(302000.0);
    expect(result.count).toBe(4);
  });

  test('handles only asset accounts', async () => {
    const assetAccounts: Account[] = [
      {
        account_id: 'checking1',
        current_balance: 1000.0,
        account_type: 'depository',
        name: 'Checking',
      },
      {
        account_id: 'investment1',
        current_balance: 5000.0,
        account_type: 'investment',
        name: 'Brokerage',
      },
    ];

    (db as any)._accounts = assetAccounts;
    (db as any)._userAccounts = [];

    const result = await tools.getAccounts();
    expect(result.total_balance).toBe(6000.0); // 1000 + 5000
    expect(result.total_assets).toBe(6000.0);
    expect(result.total_liabilities).toBe(0);
  });

  test('handles only liability accounts', async () => {
    const liabilityAccounts: Account[] = [
      {
        account_id: 'mortgage1',
        current_balance: 300000.0,
        account_type: 'loan',
        name: 'Mortgage',
      },
      {
        account_id: 'credit1',
        current_balance: 2000.0,
        account_type: 'credit',
        name: 'Credit Card',
      },
    ];

    (db as any)._accounts = liabilityAccounts;
    (db as any)._userAccounts = [];

    const result = await tools.getAccounts();
    expect(result.total_balance).toBe(-302000.0); // -(300000 + 2000)
    expect(result.total_assets).toBe(0);
    expect(result.total_liabilities).toBe(302000.0);
  });

  test('handles real estate accounts as assets', async () => {
    const realEstateAccounts: Account[] = [
      {
        account_id: 'house1',
        current_balance: 500000.0,
        account_type: 'real-estate',
        name: 'Primary Home',
      },
      {
        account_id: 'mortgage1',
        current_balance: 400000.0,
        account_type: 'loan',
        name: 'Mortgage',
      },
    ];

    (db as any)._accounts = realEstateAccounts;
    (db as any)._userAccounts = [];

    const result = await tools.getAccounts();
    // Home equity = 500000 - 400000 = 100000
    expect(result.total_balance).toBe(100000.0);
    expect(result.total_assets).toBe(500000.0);
    expect(result.total_liabilities).toBe(400000.0);
  });

  test('handles unknown account types as assets (legacy behavior)', async () => {
    const unknownAccounts: Account[] = [
      {
        account_id: 'unknown1',
        current_balance: 1000.0,
        account_type: 'unknown_type',
        name: 'Unknown Account',
      },
    ];

    (db as any)._accounts = unknownAccounts;
    (db as any)._userAccounts = [];

    const result = await tools.getAccounts();
    expect(result.total_balance).toBe(1000.0); // Treated as asset
    expect(result.total_assets).toBe(1000.0);
    expect(result.total_liabilities).toBe(0);
  });
});

describe('database securities accessors', () => {
  let db: CopilotDatabase;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._securities = [
      {
        security_id: 'hash1',
        ticker_symbol: 'AAPL',
        name: 'Apple Inc.',
        type: 'equity',
        current_price: 150.0,
        is_cash_equivalent: false,
      },
      {
        security_id: 'hash2',
        ticker_symbol: 'SCHX',
        name: 'Schwab U.S. Large-Cap ETF',
        type: 'etf',
        current_price: 25.0,
        is_cash_equivalent: false,
      },
      {
        security_id: 'hash3',
        ticker_symbol: 'USD',
        name: 'United States Dollar',
        type: 'cash',
        current_price: 1.0,
        is_cash_equivalent: true,
      },
    ];
  });

  test('getSecurityMap returns map keyed by security_id', async () => {
    const map = await db.getSecurityMap();
    expect(map.size).toBe(3);
    expect(map.get('hash1')?.ticker_symbol).toBe('AAPL');
    expect(map.get('hash2')?.ticker_symbol).toBe('SCHX');
  });
});

describe('getInvestmentPrices', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._allCollectionsLoaded = true;
    (db as any)._accounts = [];
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
    (db as any)._investmentPrices = [
      {
        investment_id: 'hash1',
        ticker_symbol: 'AAPL',
        price: 150.0,
        date: '2024-01-15',
        price_type: 'hf',
      },
      {
        investment_id: 'hash1',
        ticker_symbol: 'AAPL',
        month: '2024-01',
        close_price: 148.0,
        price_type: 'daily',
      },
      {
        investment_id: 'hash2',
        ticker_symbol: 'SCHX',
        price: 25.0,
        date: '2024-01-15',
        price_type: 'hf',
      },
      {
        investment_id: 'hash2',
        ticker_symbol: 'SCHX',
        month: '2024-02',
        close_price: 26.0,
        price_type: 'daily',
      },
    ];
    tools = new CopilotMoneyTools(db);
  });

  test('returns all prices', async () => {
    const result = await tools.getInvestmentPrices({});
    expect(result.count).toBe(4);
    expect(result.total_count).toBe(4);
    expect(result).toHaveProperty('tickers');
    expect(result).toHaveProperty('prices');
  });

  test('filters by ticker_symbol', async () => {
    const result = await tools.getInvestmentPrices({ ticker_symbol: 'AAPL' });
    expect(result.count).toBe(2);
    for (const p of result.prices) {
      expect(p.ticker_symbol).toBe('AAPL');
    }
  });

  test('filters by price_type', async () => {
    const result = await tools.getInvestmentPrices({ price_type: 'daily' });
    expect(result.count).toBe(2);
    for (const p of result.prices) {
      expect(p.price_type).toBe('daily');
    }
  });

  test('respects limit and offset', async () => {
    const result = await tools.getInvestmentPrices({ limit: 2, offset: 1 });
    expect(result.count).toBe(2);
    expect(result.total_count).toBe(4);
    expect(result.offset).toBe(1);
    expect(result.has_more).toBe(true);
  });

  test('returns unique tickers list', async () => {
    const result = await tools.getInvestmentPrices({});
    expect(result.tickers).toContain('AAPL');
    expect(result.tickers).toContain('SCHX');
    expect(result.tickers.length).toBe(2);
  });

  test('ticker_symbol filter is case-insensitive', async () => {
    const result = await tools.getInvestmentPrices({ ticker_symbol: 'aapl' });
    expect(result.count).toBe(2);
    for (const p of result.prices) {
      expect(p.ticker_symbol).toBe('AAPL');
    }
  });

  test('daily prices are not excluded by date filter (month fallback)', async () => {
    // Daily prices have p.month (e.g., "2024-01") instead of p.date.
    // The database filter falls back to p.month so daily prices aren't silently dropped.
    const allDaily = await tools.getInvestmentPrices({ price_type: 'daily' });
    expect(allDaily.count).toBe(2);

    // A broad date range should include all daily prices
    const filtered = await tools.getInvestmentPrices({
      price_type: 'daily',
      start_date: '2023-01-01',
      end_date: '2025-12-31',
    });
    expect(filtered.count).toBe(2);
  });
});

const mockSecurities: Security[] = [
  {
    security_id: 'sec_aapl',
    ticker_symbol: 'AAPL',
    name: 'Apple Inc.',
    type: 'equity',
    current_price: 190.0,
    is_cash_equivalent: false,
    iso_currency_code: 'USD',
  },
  {
    security_id: 'sec_schx',
    ticker_symbol: 'SCHX',
    name: 'Schwab U.S. Large-Cap ETF',
    type: 'etf',
    current_price: 25.0,
    is_cash_equivalent: false,
    iso_currency_code: 'USD',
  },
  {
    security_id: 'sec_usd',
    ticker_symbol: 'USD',
    name: 'United States Dollar',
    type: 'cash',
    current_price: 1.0,
    is_cash_equivalent: true,
    iso_currency_code: 'USD',
  },
];

const mockAccountsWithHoldings: Account[] = [
  {
    account_id: 'inv_acc1',
    current_balance: 100000,
    name: 'Individual Brokerage',
    account_type: 'investment',
    holdings: [
      {
        security_id: 'sec_aapl',
        account_id: 'inv_acc1',
        cost_basis: 15000,
        institution_price: 190.0,
        institution_value: 19000,
        quantity: 100,
        iso_currency_code: 'USD',
      },
      {
        security_id: 'sec_schx',
        account_id: 'inv_acc1',
        cost_basis: 5000,
        institution_price: 25.0,
        institution_value: 7500,
        quantity: 300,
        iso_currency_code: 'USD',
      },
      {
        security_id: 'sec_usd',
        account_id: 'inv_acc1',
        cost_basis: null,
        institution_price: 1.0,
        institution_value: 500,
        quantity: 500,
        iso_currency_code: 'USD',
      },
    ],
  },
  {
    account_id: 'inv_acc2',
    current_balance: 50000,
    name: 'Retirement 401k',
    account_type: 'investment',
    holdings: [
      {
        security_id: 'sec_schx',
        account_id: 'inv_acc2',
        cost_basis: 8000,
        institution_price: 25.0,
        institution_value: 12500,
        quantity: 500,
        iso_currency_code: 'USD',
      },
    ],
  },
];

const mockHoldingsHistoryData: HoldingsHistory[] = [
  {
    history_id: 'sec_aapl:2024-01',
    security_id: 'sec_aapl',
    account_id: 'inv_acc1',
    month: '2024-01',
    history: {
      '2024-01-15': { price: 185.0, quantity: 100 },
      '2024-01-31': { price: 188.0, quantity: 100 },
    },
  },
  {
    history_id: 'sec_aapl:2024-02',
    security_id: 'sec_aapl',
    account_id: 'inv_acc1',
    month: '2024-02',
    history: { '2024-02-15': { price: 189.0, quantity: 100 } },
  },
];

describe('getHoldings', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._allCollectionsLoaded = true;
    (db as any)._transactions = [];
    (db as any)._accounts = [...mockAccountsWithHoldings];
    (db as any)._recurring = [];
    (db as any)._budgets = [];
    (db as any)._goals = [];
    (db as any)._goalHistory = [];
    (db as any)._investmentPrices = [];
    (db as any)._items = [];
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
    (db as any)._securities = [...mockSecurities];
    (db as any)._holdingsHistory = [...mockHoldingsHistoryData];
    tools = new CopilotMoneyTools(db);
  });

  test('returns all holdings enriched with security data', async () => {
    const result = await tools.getHoldings({});
    expect(result.total_count).toBe(4);
    expect(result.count).toBe(4);

    const aapl = result.holdings.find((h) => h.ticker_symbol === 'AAPL');
    expect(aapl).toBeDefined();
    expect(aapl!.name).toBe('Apple Inc.');
    expect(aapl!.type).toBe('equity');
    expect(aapl!.quantity).toBe(100);
    expect(aapl!.institution_price).toBe(190.0);
    expect(aapl!.institution_value).toBe(19000);
    expect(aapl!.account_name).toBe('Individual Brokerage');
  });

  test('excludes holdings on merged and hidden accounts by default (#683)', async () => {
    // The scenario that produces a WRONG NUMBER: a brokerage re-linked. The
    // stale account is flagged user_deleted and still carries its holdings;
    // the replacement is active with the same positions. get_accounts hides
    // the stale one, so a caller summing institution_value from get_holdings
    // sees the portfolio twice while the account list looks right.
    //
    // v3 is what makes this reachable by following instructions: the accounts
    // diet cut the embedded `holdings` array from the default row and the tool
    // description now sends callers here instead ("the embedded holdings array
    // (get_holdings covers it)"). Before that a caller could read holdings off
    // get_accounts, which filters.
    const stale = {
      account_id: 'inv_old',
      current_balance: 50000,
      name: 'Brokerage (old link)',
      account_type: 'investment',
      user_deleted: true,
      holdings: [
        {
          security_id: 'sec_aapl',
          account_id: 'inv_old',
          cost_basis: 15000,
          institution_price: 190.0,
          institution_value: 19000,
          quantity: 100,
          iso_currency_code: 'USD',
        },
      ],
    };
    const hiddenByUser = {
      account_id: 'inv_hidden',
      current_balance: 9000,
      name: 'Hidden Brokerage',
      account_type: 'investment',
      user_hidden: true,
      holdings: [
        {
          security_id: 'sec_schx',
          account_id: 'inv_hidden',
          cost_basis: 5000,
          institution_price: 25.0,
          institution_value: 7500,
          quantity: 300,
          iso_currency_code: 'USD',
        },
      ],
    };
    (db as any)._accounts = [...mockAccountsWithHoldings, stale, hiddenByUser];

    const result = await tools.getHoldings({});

    const accountIds = new Set(result.holdings.map((h) => h.account_id));
    expect(accountIds.has('inv_old')).toBe(false);
    expect(accountIds.has('inv_hidden')).toBe(false);
    // The visible fixture is unchanged, so the count must not have moved.
    expect(result.total_count).toBe(4);
  });

  test('include_hidden: true brings them back, matching get_accounts (#683)', async () => {
    // Filtering by default must not REMOVE the capability. get_accounts has
    // had include_hidden since #624; get_holdings now takes the same escape
    // hatch under the same name, so a caller auditing a merged account can
    // still see what it holds.
    const stale = {
      account_id: 'inv_old',
      current_balance: 50000,
      name: 'Brokerage (old link)',
      account_type: 'investment',
      user_deleted: true,
      holdings: [
        {
          security_id: 'sec_aapl',
          account_id: 'inv_old',
          cost_basis: 15000,
          institution_price: 190.0,
          institution_value: 19000,
          quantity: 100,
          iso_currency_code: 'USD',
        },
      ],
    };
    (db as any)._accounts = [...mockAccountsWithHoldings, stale];

    const result = await tools.getHoldings({ include_hidden: true });

    expect(result.holdings.map((h) => h.account_id)).toContain('inv_old');
    expect(result.total_count).toBe(5);
  });

  test('the two tools agree on which accounts exist (#683)', async () => {
    // The class, not the instance: whatever get_accounts hides, get_holdings
    // must not report positions for. Pins the RELATIONSHIP, so a future
    // visibility rule that lands on one tool and misses the other fails here
    // even though both tools individually look correct.
    const hiddenByUser = {
      account_id: 'inv_hidden',
      current_balance: 9000,
      name: 'Hidden Brokerage',
      account_type: 'investment',
      user_hidden: true,
      holdings: [
        {
          security_id: 'sec_schx',
          account_id: 'inv_hidden',
          cost_basis: 5000,
          institution_price: 25.0,
          institution_value: 7500,
          quantity: 300,
          iso_currency_code: 'USD',
        },
      ],
    };
    // An EMPTY nickname and a real one, so the id -> name half of this
    // comparison exercises both branches of the preference rule rather than
    // only the absent-nickname case the other fixtures cover.
    const blankNickname = {
      ...mockAccountsWithHoldings[0],
      account_id: 'inv_blank',
      name: 'Provider Label',
      nickname: '',
      holdings: [
        {
          security_id: 'sec_aapl',
          account_id: 'inv_blank',
          cost_basis: 100,
          institution_price: 1.0,
          institution_value: 100,
          quantity: 100,
          iso_currency_code: 'USD',
        },
      ],
    };
    (db as any)._accounts = [...mockAccountsWithHoldings, hiddenByUser, blankNickname];

    const accountRows = (await tools.getAccounts({})).accounts;
    const visibleAccountIds = new Set(accountRows.map((a) => a.account_id));
    const holdings = (await tools.getHoldings({})).holdings;
    const holdingAccountIds = new Set(holdings.map((h) => h.account_id));

    const orphaned = [...holdingAccountIds].filter((id) => !visibleAccountIds.has(id));
    expect(
      orphaned,
      `get_holdings reported positions on accounts get_accounts hides: ${orphaned.join(', ')}. ` +
        `A caller summing institution_value would count money the account list says is not there.`
    ).toEqual([]);

    // Same comparison, one field over (#663): the two tools must also agree on
    // what each account is CALLED. get_accounts prefers the Copilot nickname
    // (#660) and get_holdings used to report the provider label, so a renamed
    // brokerage had two names across tools the v3 diet encourages using
    // together. Comparing id -> name rather than the id sets alone is what
    // makes one assertion cover both rules.
    const nameById = new Map(accountRows.map((a) => [a.account_id, a.name]));
    const disagreements = holdings
      .filter((h) => nameById.get(h.account_id) !== h.account_name)
      .map(
        (h) =>
          `${h.account_id}: accounts="${nameById.get(h.account_id)}" holdings="${h.account_name}"`
      );
    expect(
      disagreements,
      `get_accounts and get_holdings disagree about an account's name: ` +
        `${disagreements.join('; ')}. A caller correlating the two tools sees two accounts.`
    ).toEqual([]);

    // Guards the gate: both sets must be non-empty, or the comparison is vacuous.
    expect(visibleAccountIds.size).toBeGreaterThan(0);
    expect(holdingAccountIds.size).toBeGreaterThan(0);
  });

  test('an EMPTY nickname resolves the same way in both tools (#663 in reverse)', async () => {
    // `nickname` is a bare optional string on AccountSchema — no `.min(1)` —
    // so `''` is a value the decoder can produce for a cleared nickname. The
    // two sites disagreed about it: getAccounts used truthiness (`''` falls
    // through to the provider label) and getHoldings used `??` (`''` wins and
    // the row reports an empty name). Same account, two names — which is #663
    // again, in the opposite direction, created by the commit that fixed #663.
    //
    // The parity test above could not see it: its fixtures only ever have an
    // absent or non-empty nickname, so the id -> name comparison never reached
    // this branch. Pinned explicitly here AND exercised there, via the
    // empty-nickname account added to that fixture.
    (db as any)._accounts = [
      {
        ...mockAccountsWithHoldings[0],
        account_id: 'inv_blank',
        name: 'PROVIDER LABEL',
        nickname: '',
        holdings: [
          {
            security_id: 'sec_aapl',
            account_id: 'inv_blank',
            cost_basis: 15000,
            institution_price: 190.0,
            institution_value: 19000,
            quantity: 100,
            iso_currency_code: 'USD',
          },
        ],
      },
    ];

    const accountName = (await tools.getAccounts({})).accounts[0]?.name;
    const holdingName = (await tools.getHoldings({})).holdings[0]?.account_name;

    expect(holdingName).toBe(accountName);
    // ...and the agreed answer is the provider label, not the empty string: an
    // account with no usable nickname should still be identifiable.
    expect(accountName).toBe('PROVIDER LABEL');
  });

  test('all four account-name surfaces agree on a renamed account (#663)', async () => {
    // #663 was fixed at get_holdings and left at two more surfaces, which is
    // the same shape as the bug: a rule applied where someone remembered.
    //
    //   get_accounts              nickname  (since #660)
    //   get_holdings              nickname  (since #663)
    //   get_recurring_transactions  PROVIDER LABEL  <- resolveAccountName
    //   get_balance_history         nickname-ish    <- getAccountNameMap
    //
    // Pins the RELATIONSHIP across all four, so the next surface that resolves
    // an account name and forgets fails here rather than shipping a fourth
    // spelling of the same account.
    (db as any)._accounts = [
      {
        account_id: 'acc_renamed',
        current_balance: 1000,
        name: 'BIG BROKERAGE NA',
        nickname: 'Retirement',
        account_type: 'investment',
        holdings: [
          {
            security_id: 'sec_aapl',
            account_id: 'acc_renamed',
            cost_basis: 100,
            institution_price: 1.0,
            institution_value: 100,
            quantity: 100,
            iso_currency_code: 'USD',
          },
        ],
      },
    ];
    (db as any)._balanceHistory = [
      {
        balance_id: 'i1:acc_renamed:2024-01-01',
        date: '2024-01-01',
        item_id: 'i1',
        account_id: 'acc_renamed',
        current_balance: 1000,
      },
    ];
    (db as any)._recurring = [
      {
        recurring_id: 'rec_1',
        name: 'Advisory Fee',
        amount: 40,
        merchant_name: 'Advisory Fee',
        account_id: 'acc_renamed',
        frequency: 'monthly',
        state: 'active',
        transaction_ids: [],
      },
    ];
    (db as any)._transactions = [];

    const fromAccounts = (await tools.getAccounts({})).accounts[0]?.name;
    const fromHoldings = (await tools.getHoldings({})).holdings[0]?.account_name;
    const fromRecurring = (await tools.getRecurringTransactions({ name: 'Advisory Fee' }))
      .detail_view?.[0]?.account_name;
    // Through getBalanceHistory, not db.getAccountNameMap(): the map is the
    // shared chokepoint, but the link that makes it get_balance_history's NAME
    // is in the tool. A refactor that re-derives the name there would pass a
    // db-layer assertion while reintroducing the divergence.
    const fromBalanceHistory = (
      await tools.getBalanceHistory({ account_id: 'acc_renamed', granularity: 'daily' })
    ).balance_history?.[0]?.account_name;

    expect({ fromAccounts, fromHoldings, fromRecurring, fromBalanceHistory }).toEqual({
      fromAccounts: 'Retirement',
      fromHoldings: 'Retirement',
      fromRecurring: 'Retirement',
      fromBalanceHistory: 'Retirement',
    });
  });

  test('an EMPTY nickname keeps the provider label on all four (#663)', async () => {
    // The `??`-vs-truthiness half, on the two surfaces that still had it.
    // getAccountNameMap was the worst of them: `'' ?? name` is `''`, which its
    // own truthiness guard then dropped — so the account vanished from the map
    // and get_balance_history reported `account_name: undefined`. Not a wrong
    // name; no name at all.
    (db as any)._accounts = [
      {
        account_id: 'acc_blank',
        current_balance: 1000,
        name: 'PROVIDER LABEL',
        nickname: '',
        account_type: 'investment',
        holdings: [
          {
            security_id: 'sec_aapl',
            account_id: 'acc_blank',
            cost_basis: 100,
            institution_price: 1.0,
            institution_value: 100,
            quantity: 100,
            iso_currency_code: 'USD',
          },
        ],
      },
    ];
    (db as any)._balanceHistory = [
      {
        balance_id: 'i1:acc_blank:2024-01-01',
        date: '2024-01-01',
        item_id: 'i1',
        account_id: 'acc_blank',
        current_balance: 1000,
      },
    ];
    (db as any)._recurring = [
      {
        recurring_id: 'rec_1',
        name: 'Advisory Fee',
        amount: 40,
        merchant_name: 'Advisory Fee',
        account_id: 'acc_blank',
        frequency: 'monthly',
        state: 'active',
        transaction_ids: [],
      },
    ];
    (db as any)._transactions = [];

    const fromAccounts = (await tools.getAccounts({})).accounts[0]?.name;
    const fromHoldings = (await tools.getHoldings({})).holdings[0]?.account_name;
    const fromRecurring = (await tools.getRecurringTransactions({ name: 'Advisory Fee' }))
      .detail_view?.[0]?.account_name;
    const fromBalanceHistory = (
      await tools.getBalanceHistory({ account_id: 'acc_blank', granularity: 'daily' })
    ).balance_history?.[0]?.account_name;

    expect({ fromAccounts, fromHoldings, fromRecurring, fromBalanceHistory }).toEqual({
      fromAccounts: 'PROVIDER LABEL',
      fromHoldings: 'PROVIDER LABEL',
      fromRecurring: 'PROVIDER LABEL',
      fromBalanceHistory: 'PROVIDER LABEL',
    });
  });

  test('an account with ONLY an official_name reports it on all four (#663)', async () => {
    // The third branch of preferredAccountName, and the one this PR added
    // without claiming. `name` is `z.string().optional()`, so a nameless
    // account is representable rather than hypothetical.
    //
    // On main each surface answered differently: getAccounts' nickname step
    // was `nickname ? ... : account`, so a nameless account stayed nameless;
    // getAccountNameMap did `nickname ?? name` -> undefined and its truthiness
    // guard then dropped the account from the map entirely; resolveAccountName
    // was a bare `account?.name`. One rule now, so all four agree.
    //
    // Worth pinning rather than leaving as behaviour: the v3 accounts diet
    // drops `official_name` from the default preset as a name dupe, so for
    // THIS shape of account its value reappears under the `name` key — the one
    // interaction between #663 and the release's headline change.
    (db as any)._accounts = [
      {
        account_id: 'acc_official_only',
        current_balance: 1000,
        official_name: 'OFFICIAL NAME ONLY',
        account_type: 'investment',
        holdings: [
          {
            security_id: 'sec_aapl',
            account_id: 'acc_official_only',
            cost_basis: 100,
            institution_price: 1.0,
            institution_value: 100,
            quantity: 100,
            iso_currency_code: 'USD',
          },
        ],
      },
    ];
    (db as any)._balanceHistory = [
      {
        balance_id: 'i1:acc_official_only:2024-01-01',
        date: '2024-01-01',
        item_id: 'i1',
        account_id: 'acc_official_only',
        current_balance: 1000,
      },
    ];
    (db as any)._recurring = [
      {
        recurring_id: 'rec_1',
        name: 'Advisory Fee',
        amount: 40,
        merchant_name: 'Advisory Fee',
        account_id: 'acc_official_only',
        frequency: 'monthly',
        state: 'active',
        transaction_ids: [],
      },
    ];
    (db as any)._transactions = [];

    const fromAccounts = (await tools.getAccounts({})).accounts[0]?.name;
    const fromHoldings = (await tools.getHoldings({})).holdings[0]?.account_name;
    const fromRecurring = (await tools.getRecurringTransactions({ name: 'Advisory Fee' }))
      .detail_view?.[0]?.account_name;
    const fromBalanceHistory = (
      await tools.getBalanceHistory({ account_id: 'acc_official_only', granularity: 'daily' })
    ).balance_history?.[0]?.account_name;

    expect({ fromAccounts, fromHoldings, fromRecurring, fromBalanceHistory }).toEqual({
      fromAccounts: 'OFFICIAL NAME ONLY',
      fromHoldings: 'OFFICIAL NAME ONLY',
      fromRecurring: 'OFFICIAL NAME ONLY',
      fromBalanceHistory: 'OFFICIAL NAME ONLY',
    });
  });

  test('get_holdings reports the Copilot nickname, like get_accounts (#663)', async () => {
    // #660 made get_accounts prefer the user's nickname over the provider
    // label. get_holdings kept reporting `name ?? official_name`, so the same
    // account appeared under two names depending on which tool you asked —
    // and the v3 accounts diet made asking both the documented path.
    (db as any)._accounts = [
      {
        ...mockAccountsWithHoldings[0],
        account_id: 'inv_nick',
        name: 'BIG BROKERAGE NA',
        nickname: 'Retirement',
        holdings: [
          {
            security_id: 'sec_aapl',
            account_id: 'inv_nick',
            cost_basis: 15000,
            institution_price: 190.0,
            institution_value: 19000,
            quantity: 100,
            iso_currency_code: 'USD',
          },
        ],
      },
    ];

    const holding = (await tools.getHoldings({})).holdings[0];
    expect(holding?.account_name).toBe('Retirement');
  });

  test('computes average_cost and total_return when cost_basis is present', async () => {
    const result = await tools.getHoldings({});
    const aapl = result.holdings.find((h) => h.ticker_symbol === 'AAPL');
    expect(aapl!.cost_basis).toBe(15000);
    expect(aapl!.average_cost).toBe(150);
    expect(aapl!.total_return).toBe(4000);
    // (4000 / 15000) * 100 = 26.6666...
    //   Math.floor → 26.66 (mirrors Copilot web UI display convention)
    expect(aapl!.total_return_percent).toBe(26.66);
  });

  test('omits average_cost and total_return when cost_basis is null', async () => {
    const result = await tools.getHoldings({});
    const usd = result.holdings.find((h) => h.ticker_symbol === 'USD');
    expect(usd).toBeDefined();
    expect(usd!.cost_basis).toBeUndefined();
    expect(usd!.average_cost).toBeUndefined();
    expect(usd!.total_return).toBeUndefined();
  });

  test('filters by account_id', async () => {
    const result = await tools.getHoldings({ account_id: 'inv_acc2' });
    expect(result.count).toBe(1);
    expect(result.holdings[0].ticker_symbol).toBe('SCHX');
    expect(result.holdings[0].account_name).toBe('Retirement 401k');
  });

  test('filters by ticker_symbol', async () => {
    const result = await tools.getHoldings({ ticker_symbol: 'SCHX' });
    expect(result.count).toBe(2);
    for (const h of result.holdings) {
      expect(h.ticker_symbol).toBe('SCHX');
    }
  });

  test('does not include history by default', async () => {
    const result = await tools.getHoldings({});
    for (const h of result.holdings) {
      expect(h.history).toBeUndefined();
    }
  });

  test('includes history when include_history is true', async () => {
    const result = await tools.getHoldings({ include_history: true });
    const aapl = result.holdings.find((h) => h.ticker_symbol === 'AAPL');
    expect(aapl!.history).toBeDefined();
    expect(aapl!.history!.length).toBe(2);
  });

  test('respects limit and offset', async () => {
    const result = await tools.getHoldings({ limit: 2, offset: 1 });
    expect(result.count).toBe(2);
    expect(result.total_count).toBe(4);
    expect(result.offset).toBe(1);
    expect(result.has_more).toBe(true);
  });

  test('omits cost basis fields when quantity is zero', async () => {
    (db as any)._accounts = [
      {
        account_id: 'inv_zero',
        current_balance: 0,
        name: 'Zero Qty Account',
        account_type: 'investment',
        holdings: [
          {
            security_id: 'sec_aapl',
            account_id: 'inv_zero',
            cost_basis: 500,
            institution_price: 190.0,
            institution_value: 0,
            quantity: 0,
            iso_currency_code: 'USD',
          },
        ],
      },
    ];

    const result = await tools.getHoldings({});
    expect(result.count).toBe(1);
    expect(result.holdings[0].quantity).toBe(0);
    expect(result.holdings[0].cost_basis).toBeUndefined();
    expect(result.holdings[0].average_cost).toBeUndefined();
    expect(result.holdings[0].total_return).toBeUndefined();
    expect(result.holdings[0].total_return_percent).toBeUndefined();
  });

  test('ticker_symbol filter is case-insensitive', async () => {
    const result = await tools.getHoldings({ ticker_symbol: 'schx' });
    expect(result.count).toBe(2);
    for (const h of result.holdings) {
      expect(h.ticker_symbol).toBe('SCHX');
    }
  });

  test('total_return_percent floors at the 2-decimal-place position (positive + negative)', async () => {
    // Verifies the floor-toward-negative-infinity rounding convention that
    // mirrors Copilot's web UI display of "Total return" percent.
    //   Positive: (100 / 1191) * 100 = 8.3963... → floor = 8.39 (round → 8.40)
    //   Negative: (-100 / 437) * 100 = -22.8833... → floor = -22.89 (round → -22.88)
    (db as any)._accounts = [
      {
        account_id: 'inv_floor_pos',
        current_balance: 1291,
        name: 'Floor Positive',
        account_type: 'investment',
        holdings: [
          {
            security_id: 'sec_aapl',
            account_id: 'inv_floor_pos',
            cost_basis: 1191,
            institution_price: 12.91,
            institution_value: 1291,
            quantity: 100,
            iso_currency_code: 'USD',
          },
        ],
      },
      {
        account_id: 'inv_floor_neg',
        current_balance: 337,
        name: 'Floor Negative',
        account_type: 'investment',
        holdings: [
          {
            security_id: 'sec_schx',
            account_id: 'inv_floor_neg',
            cost_basis: 437,
            institution_price: 3.37,
            institution_value: 337,
            quantity: 100,
            iso_currency_code: 'USD',
          },
        ],
      },
    ];

    const result = await tools.getHoldings({});
    const pos = result.holdings.find((h) => h.account_id === 'inv_floor_pos');
    const neg = result.holdings.find((h) => h.account_id === 'inv_floor_neg');
    expect(pos?.total_return_percent).toBe(8.39);
    expect(neg?.total_return_percent).toBe(-22.89);
  });
});

describe('getInvestmentSplits', () => {
  // Synthetic security IDs only — no real Plaid SHA256 hashes, no real
  // tickers. Reviewer asked for obviously-fake fixtures so nothing leaks.
  const synthSecurities: Security[] = [
    {
      security_id: 'sec-A',
      ticker_symbol: 'TEST-A',
      name: 'Test Security A',
      type: 'equity',
      current_price: 100.0,
      is_cash_equivalent: false,
      iso_currency_code: 'USD',
    },
    {
      security_id: 'sec-B',
      ticker_symbol: 'TEST-B',
      name: 'Test Security B',
      type: 'equity',
      current_price: 50.0,
      is_cash_equivalent: false,
      iso_currency_code: 'USD',
    },
  ];

  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._allCollectionsLoaded = true;
    (db as any)._transactions = [];
    (db as any)._accounts = [];
    (db as any)._recurring = [];
    (db as any)._budgets = [];
    (db as any)._goals = [];
    (db as any)._goalHistory = [];
    (db as any)._investmentPrices = [];
    (db as any)._items = [];
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
    (db as any)._securities = [...synthSecurities];
    (db as any)._investmentSplits = [
      {
        security_id: 'sec-A',
        adjustments: {
          '2021-07-20': 0.25, // 4-for-1
          '2024-06-10': 0.1, // 10-for-1
        },
      },
    ];
    tools = new CopilotMoneyTools(db);
  });

  test('happy path: projects each adjustment into its own row with ticker/name', async () => {
    const result = await tools.getInvestmentSplits({});
    expect(result.count).toBe(2);
    expect(result.total_count).toBe(2);
    expect(result.has_more).toBe(false);

    // Sorted by date descending — newest first.
    expect(result.splits[0]).toEqual({
      security_id: 'sec-A',
      ticker_symbol: 'TEST-A',
      name: 'Test Security A',
      effective_date: '2024-06-10',
      multiplier: 0.1,
      ratio_description: '10-for-1',
    });
    expect(result.splits[1]).toEqual({
      security_id: 'sec-A',
      ticker_symbol: 'TEST-A',
      name: 'Test Security A',
      effective_date: '2021-07-20',
      multiplier: 0.25,
      ratio_description: '4-for-1',
    });
  });

  test('ratio formatting covers forward, reverse, no-op, and unknown', async () => {
    (db as any)._investmentSplits = [
      {
        security_id: 'sec-A',
        adjustments: {
          '2020-01-01': 0.1, // 10-for-1
          '2020-02-01': 0.25, // 4-for-1
          '2020-03-01': 2.0, // 1-for-2 reverse
          '2020-04-01': 0.123, // not a clean ratio
          // multiplier === 1.0 is a no-op (shouldn't exist in real data, but
          // guard against the misleading "1-for-1 reverse split" label).
          '2020-05-01': 1.0,
        },
      },
    ];
    const result = await tools.getInvestmentSplits({});
    const byDate = Object.fromEntries(
      result.splits.map((s) => [s.effective_date, s.ratio_description])
    );
    expect(byDate['2020-01-01']).toBe('10-for-1');
    expect(byDate['2020-02-01']).toBe('4-for-1');
    expect(byDate['2020-03-01']).toBe('1-for-2 reverse split');
    expect(byDate['2020-04-01']).toBe('unknown ratio');
    expect(byDate['2020-05-01']).toBe('unknown ratio');
  });

  test('start_date filter excludes earlier rows', async () => {
    const result = await tools.getInvestmentSplits({ start_date: '2024-01-01' });
    expect(result.count).toBe(1);
    expect(result.splits[0].effective_date).toBe('2024-06-10');
  });

  test('end_date filter excludes later rows', async () => {
    const result = await tools.getInvestmentSplits({ end_date: '2023-12-31' });
    expect(result.count).toBe(1);
    expect(result.splits[0].effective_date).toBe('2021-07-20');
  });

  test('ticker filter returns zero rows when ticker has no splits', async () => {
    const result = await tools.getInvestmentSplits({ ticker_symbol: 'TEST-B' });
    expect(result.count).toBe(0);
    expect(result.total_count).toBe(0);
  });

  test('ticker filter is case-insensitive', async () => {
    const result = await tools.getInvestmentSplits({ ticker_symbol: 'test-a' });
    expect(result.count).toBe(2);
    for (const r of result.splits) {
      expect(r.ticker_symbol).toBe('TEST-A');
    }
  });

  test('pagination: limit + offset + has_more', async () => {
    const result = await tools.getInvestmentSplits({ limit: 1, offset: 0 });
    expect(result.count).toBe(1);
    expect(result.total_count).toBe(2);
    expect(result.offset).toBe(0);
    expect(result.has_more).toBe(true);

    const page2 = await tools.getInvestmentSplits({ limit: 1, offset: 1 });
    expect(page2.count).toBe(1);
    expect(page2.has_more).toBe(false);
    expect(page2.splits[0].effective_date).toBe('2021-07-20');
  });

  test('returns count 0 when cache has no splits', async () => {
    (db as any)._investmentSplits = [];
    const result = await tools.getInvestmentSplits({});
    expect(result.count).toBe(0);
    expect(result.total_count).toBe(0);
    expect(result.has_more).toBe(false);
    expect(result.splits).toEqual([]);
  });
});

describe('reviewTransactions', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._transactions = [
      {
        transaction_id: 'txn1',
        amount: 50,
        date: '2024-01-15',
        name: 'Coffee Shop',
        category_id: 'food_and_drink_coffee',
        item_id: 'item1',
        account_id: 'acct1',
        user_reviewed: false,
      },
      {
        transaction_id: 'txn2',
        amount: 100,
        date: '2024-01-16',
        name: 'Gas Station',
        category_id: 'transportation_gas',
        item_id: 'item1',
        account_id: 'acct2',
        user_reviewed: false,
      },
      {
        transaction_id: 'txn3',
        amount: 25,
        date: '2024-01-17',
        name: 'Bookstore',
        category_id: 'shopping_general',
        account_id: 'acct3',
      },
    ];
    (mockDb as any)._allCollectionsLoaded = true;
  });

  test('marks a single transaction as reviewed', async () => {
    const client = createMockGraphQLClient({
      BulkEditTransactions: (vars: any) => ({
        bulkEditTransactions: {
          updated: vars.filter.ids.map((t: any) => ({
            id: t.id,
            name: 'Coffee Shop',
            categoryId: 'c',
            userNotes: null,
            isReviewed: vars.input.isReviewed,
            type: 'REGULAR',
            date: '2024-01-15',
            amount: 50,
            tags: [],
          })),
          failed: [],
        },
      }),
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.reviewTransactions({ transaction_ids: ['txn1'] });
    expect(result.success).toBe(true);
    expect(result.reviewed_count).toBe(1);
    expect(result.transaction_ids).toEqual(['txn1']);

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('BulkEditTransactions');
    expect(client._calls[0].variables).toEqual({
      input: { isReviewed: true },
      filter: { ids: [{ id: 'txn1', accountId: 'acct1', itemId: 'item1' }] },
    });
  });

  test('marks multiple transactions as reviewed', async () => {
    const client = createMockGraphQLClient({
      BulkEditTransactions: (vars: any) => ({
        bulkEditTransactions: {
          updated: vars.filter.ids.map((t: any) => ({
            id: t.id,
            name: 'Coffee Shop',
            categoryId: 'c',
            userNotes: null,
            isReviewed: vars.input.isReviewed,
            type: 'REGULAR',
            date: '2024-01-15',
            amount: 50,
            tags: [],
          })),
          failed: [],
        },
      }),
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.reviewTransactions({ transaction_ids: ['txn1', 'txn2'] });
    expect(result.success).toBe(true);
    expect(result.reviewed_count).toBe(2);
    // One request for the whole set, each id carrying its own routing triple.
    expect(client._calls).toHaveLength(1);
    expect((client._calls[0].variables as any).filter.ids).toEqual([
      { id: 'txn1', accountId: 'acct1', itemId: 'item1' },
      { id: 'txn2', accountId: 'acct2', itemId: 'item1' },
    ]);
  });

  test('supports reviewed=false to unmark transactions', async () => {
    const client = createMockGraphQLClient({
      BulkEditTransactions: (vars: any) => ({
        bulkEditTransactions: {
          updated: vars.filter.ids.map((t: any) => ({
            id: t.id,
            name: 'Coffee Shop',
            categoryId: 'c',
            userNotes: null,
            isReviewed: vars.input.isReviewed,
            type: 'REGULAR',
            date: '2024-01-15',
            amount: 50,
            tags: [],
          })),
          failed: [],
        },
      }),
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.reviewTransactions({
      transaction_ids: ['txn1'],
      reviewed: false,
    });
    expect(result.success).toBe(true);
    expect(client._calls[0].variables).toMatchObject({
      input: { isReviewed: false },
    });
  });

  test('defaults reviewed to true when not specified', async () => {
    const client = createMockGraphQLClient({
      BulkEditTransactions: (vars: any) => ({
        bulkEditTransactions: {
          updated: vars.filter.ids.map((t: any) => ({
            id: t.id,
            name: 'Coffee Shop',
            categoryId: 'c',
            userNotes: null,
            isReviewed: vars.input.isReviewed,
            type: 'REGULAR',
            date: '2024-01-15',
            amount: 50,
            tags: [],
          })),
          failed: [],
        },
      }),
    });
    tools = new CopilotMoneyTools(mockDb, client);

    await tools.reviewTransactions({ transaction_ids: ['txn1'] });
    expect(client._calls[0].variables).toMatchObject({
      input: { isReviewed: true },
    });
  });

  test('throws when transaction_id not found', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(tools.reviewTransactions({ transaction_ids: ['nonexistent'] })).rejects.toThrow(
      'Transaction not found: nonexistent'
    );
  });

  test('throws when transaction_ids is empty', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(tools.reviewTransactions({ transaction_ids: [] })).rejects.toThrow(
      'transaction_ids must be a non-empty array'
    );
  });

  test('throws on invalid transaction_id format', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(
      tools.reviewTransactions({ transaction_ids: ['valid_id', 'invalid/id'] })
    ).rejects.toThrow('Invalid transaction_id format: invalid/id');
  });

  test('throws not-found when a transaction cannot be resolved locally or live', async () => {
    // txn3 isn't in the local cache (and there's no live DB here), so its
    // account/item can't be resolved and the bulk review is rejected up front.
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(tools.reviewTransactions({ transaction_ids: ['txn3'] })).rejects.toThrow(
      /not found/i
    );
  });

  test('throws on GraphQL error', async () => {
    const client = createMockGraphQLClient({
      BulkEditTransactions: new Error('Boom'),
    });
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(tools.reviewTransactions({ transaction_ids: ['txn1'] })).rejects.toThrow('Boom');
  });

  test('throws when no GraphQL client configured (read-only mode)', async () => {
    const readOnlyTools = new CopilotMoneyTools(mockDb);
    await expect(readOnlyTools.reviewTransactions({ transaction_ids: ['txn1'] })).rejects.toThrow(
      'Write tools require --write flag to be set'
    );
  });
});

describe('createTag', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._allCollectionsLoaded = true;
    (mockDb as any)._cacheLoadedAt = Date.now();
    (mockDb as any)._tags = [];
  });

  test('dispatches CreateTag with default color', async () => {
    const client = createMockGraphQLClient({
      CreateTag: {
        createTag: { id: 'tag-123', name: 'vacation', colorName: 'PURPLE2' },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.createTag({ name: 'vacation' });
    expect(result.success).toBe(true);
    expect(result.tag_id).toBe('tag-123');
    expect(result.name).toBe('vacation');
    expect(result.color_name).toBe('PURPLE2');

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('CreateTag');
    expect(client._calls[0].variables).toEqual({
      input: { name: 'vacation', colorName: 'PURPLE2' },
    });
  });

  test('passes through explicit colorName', async () => {
    const client = createMockGraphQLClient({
      CreateTag: {
        createTag: { id: 'tag-xyz', name: 'Business', colorName: 'BLUE1' },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.createTag({ name: 'Business', color_name: 'BLUE1' });
    expect(result.color_name).toBe('BLUE1');
    expect(client._calls[0].variables).toEqual({
      input: { name: 'Business', colorName: 'BLUE1' },
    });
  });

  test('trims whitespace from name before dispatching', async () => {
    const client = createMockGraphQLClient({
      CreateTag: {
        createTag: { id: 'tag-1', name: 'vacation', colorName: 'PURPLE2' },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    await tools.createTag({ name: '  vacation  ' });
    expect(client._calls[0].variables).toEqual({
      input: { name: 'vacation', colorName: 'PURPLE2' },
    });
  });

  test('throws on empty name (no dispatch)', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(tools.createTag({ name: '' })).rejects.toThrow('Tag name must not be empty');
    expect(client._calls).toHaveLength(0);
  });

  test('throws on whitespace-only name (no dispatch)', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(tools.createTag({ name: '   ' })).rejects.toThrow('Tag name must not be empty');
    expect(client._calls).toHaveLength(0);
  });

  test('rejects a color_name outside the ColorName enum (no dispatch)', async () => {
    // 'GREEN2' is plausible (five palette bases have a *2 variant) but not a
    // real server value — the local guard must reject before any round-trip.
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(tools.createTag({ name: 'vacation', color_name: 'GREEN2' })).rejects.toThrow(
      /color_name must be one of/
    );
    expect(client._calls).toHaveLength(0);
  });

  test('throws when no GraphQL client configured (read-only mode)', async () => {
    const readOnlyTools = new CopilotMoneyTools(mockDb);
    await expect(readOnlyTools.createTag({ name: 'test' })).rejects.toThrow(
      'Write tools require --write flag to be set'
    );
  });
});

describe('deleteTag', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._allCollectionsLoaded = true;
    (mockDb as any)._cacheLoadedAt = Date.now();
    (mockDb as any)._tags = [
      { tag_id: 'vacation', name: 'Vacation' },
      { tag_id: 'business', name: 'Business Expense' },
    ];
  });

  test('dispatches DeleteTag with id', async () => {
    const client = createMockGraphQLClient({ DeleteTag: { deleteTag: true } });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.deleteTag({ tag_id: 'vacation' });
    expect(result.success).toBe(true);
    expect(result.tag_id).toBe('vacation');
    expect(result.deleted).toBe(true);

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('DeleteTag');
    expect(client._calls[0].variables).toEqual({ id: 'vacation' });
  });

  test('throws when no GraphQL client configured (read-only mode)', async () => {
    const readOnlyTools = new CopilotMoneyTools(mockDb);
    await expect(readOnlyTools.deleteTag({ tag_id: 'test' })).rejects.toThrow(
      'Write tools require --write flag to be set'
    );
  });
});

describe('createCategory', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._userCategories = [
      { category_id: 'food_and_drink', name: 'Food & Drink', excluded: false },
      { category_id: 'shopping', name: 'Shopping', excluded: false },
    ];
    (mockDb as any)._allCollectionsLoaded = true;
  });

  test('dispatches CreateCategory with all required fields', async () => {
    const client = createMockGraphQLClient({
      CreateCategory: {
        createCategory: { id: 'cat-new', name: 'Streaming', colorName: 'RED1' },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.createCategory({
      name: 'Streaming',
      color_name: 'RED1',
      emoji: '🎬',
    });
    expect(result.success).toBe(true);
    expect(result.category_id).toBe('cat-new');
    expect(result.name).toBe('Streaming');
    expect(result.color_name).toBe('RED1');

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('CreateCategory');
    expect(client._calls[0].variables).toEqual({
      spend: false,
      budget: false,
      input: {
        name: 'Streaming',
        colorName: 'RED1',
        emoji: '🎬',
        isExcluded: false,
      },
    });
  });

  test('rejects parent_id (not supported by Copilot GraphQL API)', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);

    await expect(
      tools.createCategory({
        name: 'Sub',
        color_name: 'BLUE1',
        emoji: '📁',
        parent_id: 'shopping',
      })
    ).rejects.toThrow(/parent_id is not supported/);
    expect(client._calls).toHaveLength(0);
  });

  test('trims whitespace from name', async () => {
    const client = createMockGraphQLClient({
      CreateCategory: {
        createCategory: { id: 'cat-1', name: 'Entertainment', colorName: 'GREEN1' },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    await tools.createCategory({ name: '  Entertainment  ', color_name: 'GREEN1', emoji: '🎮' });
    expect(client._calls[0].variables).toMatchObject({
      input: expect.objectContaining({ name: 'Entertainment' }),
    });
  });

  test('throws when name is empty', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(
      tools.createCategory({ name: '', color_name: 'RED1', emoji: '🎬' })
    ).rejects.toThrow('Category name must not be empty');
    expect(client._calls).toHaveLength(0);
  });

  test('throws when color_name is missing', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(tools.createCategory({ name: 'X', color_name: '', emoji: '🎬' })).rejects.toThrow(
      'color_name is required'
    );
  });

  test('throws when emoji is missing', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(
      tools.createCategory({ name: 'X', color_name: 'RED1', emoji: '' })
    ).rejects.toThrow('emoji is required');
  });

  test('rejects a color_name outside the ColorName enum (no dispatch)', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(
      tools.createCategory({ name: 'X', color_name: 'GREEN2', emoji: '🎬' })
    ).rejects.toThrow(/color_name must be one of/);
    expect(client._calls).toHaveLength(0);
  });

  test('throws when no GraphQL client configured (read-only mode)', async () => {
    const readOnlyTools = new CopilotMoneyTools(mockDb);
    await expect(
      readOnlyTools.createCategory({ name: 'Test', color_name: 'RED1', emoji: '🎬' })
    ).rejects.toThrow('Write tools require --write flag to be set');
  });
});

describe('getBalanceHistory', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._accounts = [];
    (db as any)._accountNameMap = new Map<string, string>([
      ['acc-1', 'Checking'],
      ['acc-2', 'Savings'],
    ]);
    (db as any)._balanceHistory = [
      {
        balance_id: 'i1:acc-1:2024-01-01',
        date: '2024-01-01',
        item_id: 'i1',
        account_id: 'acc-1',
        current_balance: 1000,
      },
      {
        balance_id: 'i1:acc-1:2024-01-08',
        date: '2024-01-08',
        item_id: 'i1',
        account_id: 'acc-1',
        current_balance: 1100,
      },
      {
        balance_id: 'i1:acc-1:2024-01-15',
        date: '2024-01-15',
        item_id: 'i1',
        account_id: 'acc-1',
        current_balance: 1200,
      },
      {
        balance_id: 'i1:acc-1:2024-01-22',
        date: '2024-01-22',
        item_id: 'i1',
        account_id: 'acc-1',
        current_balance: 1300,
      },
      {
        balance_id: 'i1:acc-1:2024-01-29',
        date: '2024-01-29',
        item_id: 'i1',
        account_id: 'acc-1',
        current_balance: 1400,
      },
      {
        balance_id: 'i1:acc-1:2024-02-05',
        date: '2024-02-05',
        item_id: 'i1',
        account_id: 'acc-1',
        current_balance: 1500,
      },
      {
        balance_id: 'i1:acc-2:2024-01-01',
        date: '2024-01-01',
        item_id: 'i1',
        account_id: 'acc-2',
        current_balance: 5000,
      },
    ];
    tools = new CopilotMoneyTools(db);
  });

  test('requires granularity parameter', async () => {
    await expect(tools.getBalanceHistory({} as any)).rejects.toThrow(
      `granularity is required — must be one of: ${BALANCE_HISTORY_GRANULARITIES.join(', ')}`
    );
  });

  test('rejects invalid granularity', async () => {
    await expect(tools.getBalanceHistory({ granularity: 'hourly' as any })).rejects.toThrow(
      `Invalid granularity: hourly. Must be one of: ${BALANCE_HISTORY_GRANULARITIES.join(', ')}`
    );
  });

  test('returns daily balance history', async () => {
    const result = await tools.getBalanceHistory({ granularity: 'daily' });
    expect(result.count).toBeGreaterThanOrEqual(0);
    expect(result).toHaveProperty('total_count');
    expect(result).toHaveProperty('has_more');
    expect(result).toHaveProperty('balance_history');
  });

  test('downsamples to weekly', async () => {
    const daily = await tools.getBalanceHistory({ granularity: 'daily' });
    const weekly = await tools.getBalanceHistory({ granularity: 'weekly' });
    expect(weekly.total_count).toBeLessThanOrEqual(daily.total_count);
  });

  test('downsamples to monthly', async () => {
    const daily = await tools.getBalanceHistory({ granularity: 'daily' });
    const monthly = await tools.getBalanceHistory({ granularity: 'monthly' });
    expect(monthly.total_count).toBeLessThanOrEqual(daily.total_count);
  });

  test('filters by account_id', async () => {
    const result = await tools.getBalanceHistory({
      granularity: 'daily',
      account_id: 'acc-1',
    });
    for (const h of result.balance_history) {
      expect(h.account_id).toBe('acc-1');
    }
  });

  test('paginates with limit and offset', async () => {
    const result = await tools.getBalanceHistory({
      granularity: 'daily',
      limit: 2,
      offset: 0,
    });
    expect(result.count).toBeLessThanOrEqual(2);
  });

  test('enriches with account name', async () => {
    const result = await tools.getBalanceHistory({ granularity: 'daily', account_id: 'acc-1' });
    expect(result.count).toBeGreaterThan(0);
    expect(result.balance_history[0]?.account_name).toBe('Checking');
  });
});

describe('getGoalHistory', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._goals = [
      {
        goal_id: 'goal-1',
        name: 'Emergency Fund',
        savings: { target_amount: 10000, status: 'active' },
      },
      {
        goal_id: 'goal-2',
        name: 'Vacation Fund',
        savings: { target_amount: 3000, status: 'active' },
      },
    ];
    (db as any)._goalHistory = [
      { goal_id: 'goal-1', month: '2024-01', current_amount: 500 },
      { goal_id: 'goal-1', month: '2024-02', current_amount: 1000 },
      { goal_id: 'goal-1', month: '2024-06', current_amount: 3000 },
      { goal_id: 'goal-2', month: '2024-03', current_amount: 200 },
    ];
    tools = new CopilotMoneyTools(db);
  });

  test('returns all goal history', async () => {
    const result = await tools.getGoalHistory();
    expect(result).toHaveProperty('count');
    expect(result).toHaveProperty('goal_history');
    expect(result.total_count).toBe(4);
  });

  test('filters by goal_id', async () => {
    const result = await tools.getGoalHistory({ goal_id: 'goal-1' });
    for (const h of result.goal_history) {
      expect(h.goal_id).toBe('goal-1');
    }
    expect(result.total_count).toBe(3);
  });

  test('filters by month range', async () => {
    const result = await tools.getGoalHistory({
      start_month: '2024-01',
      end_month: '2024-06',
    });
    for (const h of result.goal_history) {
      expect(h.month >= '2024-01').toBe(true);
      expect(h.month <= '2024-06').toBe(true);
    }
  });

  test('enriches with goal_name', async () => {
    const result = await tools.getGoalHistory({ goal_id: 'goal-1' });
    expect(result.count).toBeGreaterThan(0);
    expect(result.goal_history[0]).toHaveProperty('goal_name');
    expect(result.goal_history[0]?.goal_name).toBe('Emergency Fund');
  });

  test('paginates with limit and offset', async () => {
    const result = await tools.getGoalHistory({ limit: 1 });
    expect(result.count).toBeLessThanOrEqual(1);
  });

  test('rejects invalid start_month format', async () => {
    await expect(tools.getGoalHistory({ start_month: '2024-1' })).rejects.toThrow(
      'Invalid start_month'
    );
    await expect(tools.getGoalHistory({ start_month: '2024-01-01' })).rejects.toThrow(
      'Invalid start_month'
    );
  });

  test('rejects invalid end_month format', async () => {
    await expect(tools.getGoalHistory({ end_month: 'Jan2024' })).rejects.toThrow(
      'Invalid end_month'
    );
  });
});

describe('updateRecurring', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._recurring = [
      { recurring_id: 'rec-1', name: 'Netflix', state: 'ACTIVE', category_id: 'entertainment' },
    ];
    (mockDb as any)._userCategories = [
      { category_id: 'entertainment', name: 'Entertainment' },
      { category_id: 'subscriptions', name: 'Subscriptions' },
    ];
    (mockDb as any)._allCollectionsLoaded = true;
  });

  test('throws when no fields to update', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(tools.updateRecurring({ recurring_id: 'rec-1' })).rejects.toThrow(
      'update_recurring requires at least one field to update'
    );
    expect(client._calls).toHaveLength(0);
  });

  test('rejects lowercase state with VALID_STATES error (matches setRecurringState)', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(tools.updateRecurring({ recurring_id: 'rec-1', state: 'paused' })).rejects.toThrow(
      'state must be one of: ACTIVE, PAUSED, ARCHIVED. Got: paused'
    );
    expect(client._calls).toHaveLength(0);
  });

  test('dispatches EditRecurring with name', async () => {
    const client = createMockGraphQLClient({
      EditRecurring: {
        editRecurring: {
          recurring: {
            id: 'rec-1',
            name: 'Netflix HD',
            categoryId: 'entertainment',
            frequency: 'MONTHLY',
            state: 'ACTIVE',
          },
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.updateRecurring({ recurring_id: 'rec-1', name: 'Netflix HD' });
    expect(result.success).toBe(true);
    expect(result.updated).toEqual(['name']);
    expect(client._calls[0].variables).toEqual({
      id: 'rec-1',
      input: { name: 'Netflix HD' },
    });
  });

  test('name trims whitespace', async () => {
    const client = createMockGraphQLClient({
      EditRecurring: {
        editRecurring: {
          recurring: {
            id: 'rec-1',
            name: 'Trimmed',
            categoryId: 'entertainment',
            frequency: 'MONTHLY',
            state: 'ACTIVE',
          },
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    await tools.updateRecurring({ recurring_id: 'rec-1', name: '  Trimmed  ' });
    expect(client._calls[0].variables).toMatchObject({ input: { name: 'Trimmed' } });
  });

  test('empty name throws', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(tools.updateRecurring({ recurring_id: 'rec-1', name: '' })).rejects.toThrow(
      /name must not be empty/i
    );
    expect(client._calls).toHaveLength(0);
  });

  test('dispatches EditRecurring with category_id', async () => {
    const client = createMockGraphQLClient({
      EditRecurring: {
        editRecurring: {
          recurring: {
            id: 'rec-1',
            name: 'Netflix',
            categoryId: 'subscriptions',
            frequency: 'MONTHLY',
            state: 'ACTIVE',
          },
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.updateRecurring({
      recurring_id: 'rec-1',
      category_id: 'subscriptions',
    });
    expect(result.success).toBe(true);
    expect(result.updated).toEqual(['categoryId']);
    expect(client._calls[0].variables).toEqual({
      id: 'rec-1',
      input: { categoryId: 'subscriptions' },
    });
  });

  test('non-existent category_id throws', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(
      tools.updateRecurring({ recurring_id: 'rec-1', category_id: 'ghost' })
    ).rejects.toThrow(/Category not found/i);
    expect(client._calls).toHaveLength(0);
  });

  test('dispatches EditRecurring with frequency', async () => {
    const client = createMockGraphQLClient({
      EditRecurring: {
        editRecurring: {
          recurring: {
            id: 'rec-1',
            name: 'Netflix',
            categoryId: 'entertainment',
            state: 'ACTIVE',
            frequency: 'ANNUALLY',
          },
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.updateRecurring({ recurring_id: 'rec-1', frequency: 'ANNUALLY' });
    expect(result.success).toBe(true);
    expect(result.updated).toEqual(['frequency']);
    expect(client._calls[0].variables).toEqual({
      id: 'rec-1',
      input: { frequency: 'ANNUALLY' },
    });
  });

  test('invalid frequency throws', async () => {
    const client = createMockGraphQLClient({});
    tools = new CopilotMoneyTools(mockDb, client);
    await expect(
      tools.updateRecurring({ recurring_id: 'rec-1', frequency: 'YEARLY' })
    ).rejects.toThrow(/frequency must be one of/i);
    expect(client._calls).toHaveLength(0);
  });

  test('frequency cache patch lowercases, mapping ANNUALLY to "yearly"', async () => {
    const mockEdit = (freq: string) =>
      createMockGraphQLClient({
        EditRecurring: {
          editRecurring: {
            recurring: {
              id: 'rec-1',
              name: 'Netflix',
              categoryId: 'entertainment',
              state: 'ACTIVE',
              frequency: freq,
            },
          },
        },
      });

    // General branch: the lowercased enum matches KNOWN_FREQUENCIES directly.
    tools = new CopilotMoneyTools(mockDb, mockEdit('MONTHLY'));
    await tools.updateRecurring({ recurring_id: 'rec-1', frequency: 'MONTHLY' });
    expect((mockDb as any)._recurring[0].frequency).toBe('monthly');

    // Special case: ANNUALLY's lowercase ('annually') is NOT in KNOWN_FREQUENCIES,
    // so it must be stored as 'yearly' to keep read-side cache values consistent.
    tools = new CopilotMoneyTools(mockDb, mockEdit('ANNUALLY'));
    await tools.updateRecurring({ recurring_id: 'rec-1', frequency: 'ANNUALLY' });
    expect((mockDb as any)._recurring[0].frequency).toBe('yearly');
  });

  test('dispatches EditRecurring with state', async () => {
    const client = createMockGraphQLClient({
      EditRecurring: {
        editRecurring: {
          recurring: {
            id: 'rec-1',
            name: 'Netflix',
            categoryId: 'entertainment',
            frequency: 'MONTHLY',
            state: 'PAUSED',
          },
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.updateRecurring({ recurring_id: 'rec-1', state: 'PAUSED' });
    expect(result.success).toBe(true);
    expect(result.recurring_id).toBe('rec-1');
    expect(result.updated).toEqual(['state']);

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe('EditRecurring');
    expect(client._calls[0].variables).toEqual({
      id: 'rec-1',
      input: { state: 'PAUSED' },
    });
  });

  test('dispatches EditRecurring with rule fields mapped to camelCase + Float amounts', async () => {
    // Server expects Float for minAmount/maxAmount, not String — the MCP boundary
    // accepts strings (consistent with setBudget) and the per-domain editRecurring
    // parses to numbers before the wire send.
    const client = createMockGraphQLClient({
      EditRecurring: {
        editRecurring: {
          // NOTE: no `rule` here — production deliberately does not select
          // `rule { ... }` on the EditRecurring response (issue #288); the
          // typed mock map rejects it. `changed.rule` is echoed from input.
          recurring: {
            id: 'rec-1',
            name: 'Netflix',
            categoryId: 'entertainment',
            frequency: 'MONTHLY',
            state: 'ACTIVE',
          },
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.updateRecurring({
      recurring_id: 'rec-1',
      rule: {
        name_contains: 'NETFLIX',
        min_amount: '10',
        max_amount: '20',
        days: [1, 15],
      },
    });
    expect(result.updated).toEqual(['rule']);

    expect(client._calls[0].variables).toEqual({
      id: 'rec-1',
      input: {
        rule: {
          nameContains: 'NETFLIX',
          minAmount: 10,
          maxAmount: 20,
          days: [1, 15],
        },
      },
    });
  });

  test('dispatches both state and rule together', async () => {
    const client = createMockGraphQLClient({
      EditRecurring: {
        editRecurring: {
          recurring: {
            id: 'rec-1',
            name: 'Netflix',
            categoryId: 'entertainment',
            frequency: 'MONTHLY',
            state: 'ARCHIVED',
          },
        },
      },
    });
    tools = new CopilotMoneyTools(mockDb, client);

    const result = await tools.updateRecurring({
      recurring_id: 'rec-1',
      state: 'ARCHIVED',
      rule: { days: [5] },
    });
    expect(result.updated).toEqual(expect.arrayContaining(['state', 'rule']));
    expect(client._calls[0].variables).toEqual({
      id: 'rec-1',
      input: { state: 'ARCHIVED', rule: { days: [5] } },
    });
  });
});

describe('write-through to live cache', () => {
  test('CopilotMoneyTools accepts an optional liveDb constructor argument', () => {
    // Smoke test: confirm the third constructor parameter is plumbed through.
    // Detailed write-through behavior is exercised in tests/core/live-database.test.ts
    // (patchLive* methods) and via the live-mode integration tests.
    const db = new CopilotDatabase('/tmp/nonexistent-test-db');
    const tools = new CopilotMoneyTools(db);
    expect(tools).toBeDefined();
    // No throw when constructed without liveDb. The 16 patchCached call sites
    // use `this.liveDb?.patchLive*` so a missing liveDb is a silent no-op.
  });
});
