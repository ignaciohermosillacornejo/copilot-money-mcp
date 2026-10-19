/**
 * #843 detector: every `transaction_type` value both modes support selects the
 * SAME rows in cache mode (get_transactions) and live mode
 * (get_transactions_live), over one fixture expressed in each mode's own row
 * shape.
 *
 * The values are read from LIVE_TRANSACTION_TYPES, so a value added to live
 * mode joins this check automatically, and the test fails if live mode ever
 * accepts a value the shared rule table does not define.
 *
 * Both modes are driven through their real tool entry points, not through the
 * shared predicate directly: the bug this guards against was two adapters
 * meaning different things, so the adapters are what must be exercised.
 * Expected ids are written out per value as well, because two modes that agree
 * on a wrong answer would otherwise pass.
 */

import { describe, test, expect, mock } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import {
  LiveTransactionsTools,
  LIVE_TRANSACTION_TYPES,
} from '../../src/tools/live/transactions.js';
import {
  SHARED_TRANSACTION_TYPES,
  TRANSACTION_TYPE_RULES,
  cacheTypeRuleRow,
  liveTypeRuleRow,
} from '../../src/tools/transaction-type-rules.js';
import { isKnownPlaidCategory, lookupKnownCategoryName } from '../../src/utils/categories.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import type { TransactionNode } from '../../src/core/graphql/queries/transactions.js';
import type { CategoryNode } from '../../src/core/graphql/queries/categories.js';
import type { Transaction } from '../../src/models/index.js';

// Opaque, Firestore-shaped category ids — a readable id would let a rule that
// matches on the id instead of the name pass by accident.
const CAT_SHOPPING = 'Kq8vN3tR6mW2pX9sL4dB';
const CAT_HEALTH = 'Zt5mP9wK2nR7vQ3xH8cJ';
const CAT_GROCERIES = 'Rb2xL7qN4tW9mK6pV3sF';
const TAG_TRIP = 'Ty4nW8qK3mR6vL2xP9sD';

const CATEGORIES: Array<{ id: string; name: string }> = [
  { id: CAT_SHOPPING, name: 'Shopping' },
  { id: CAT_HEALTH, name: 'Health & Medical' },
  { id: CAT_GROCERIES, name: 'Groceries' },
];

type Kind = 'REGULAR' | 'INCOME' | 'INTERNAL_TRANSFER';

interface Spec {
  id: string;
  kind: Kind;
  amount: number;
  categoryId: string | null;
  /** Display case, as live and the app return it. The cache stores it upper-cased. */
  name: string;
  tags?: string[];
}

const SPECS: Spec[] = [
  {
    id: 'Ab3kW9mQ2nR7tV4xL8sP',
    kind: 'REGULAR',
    amount: 80,
    categoryId: CAT_GROCERIES,
    name: 'Corner Market',
  },
  {
    id: 'Bc4mX2nR8tW5qK9vL3sQ',
    kind: 'REGULAR',
    amount: -40,
    categoryId: CAT_SHOPPING,
    name: 'Outdoor Store',
  },
  // The #843 case: a paycheck is negative, and live mode used to call it a refund.
  {
    id: 'Cd5nY3pS9vX6rL2wM4tR',
    kind: 'INCOME',
    amount: -3000,
    categoryId: null,
    name: 'Acme Payroll',
  },
  // INCOME with a credit keyword: never a credit.
  {
    id: 'De6pZ4qT2wY7sM3xN5vS',
    kind: 'INCOME',
    amount: -25,
    categoryId: null,
    name: 'Cashback Bonus Deposit',
  },
  // Uncategorized statement credit: a credit, not a refund.
  {
    id: 'Ef7qA5rV3xZ8tN4yP6wT',
    kind: 'REGULAR',
    amount: -15,
    categoryId: null,
    name: 'Statement Credit',
  },
  // Categorized reward: both a credit and a refund.
  {
    id: 'Fg8rB6sW4yA9vP5zQ7xV',
    kind: 'REGULAR',
    amount: -10,
    categoryId: CAT_SHOPPING,
    name: 'Rewards Redemption',
  },
  // A transfer is neither, whatever its name says.
  {
    id: 'Gh9sC7tX5zB2wQ6aR8yW',
    kind: 'INTERNAL_TRANSFER',
    amount: -500,
    categoryId: null,
    name: 'Credit Card Transfer',
  },
  // Medical by category name.
  {
    id: 'Hj2tD8vY6aC3xR7bS9zX',
    kind: 'REGULAR',
    amount: 60,
    categoryId: CAT_HEALTH,
    name: 'Family Clinic',
  },
  // Medical by merchant name, in a non-medical category.
  {
    id: 'Jk3vF9wZ7bD4yS8cT2aY',
    kind: 'REGULAR',
    amount: 12,
    categoryId: CAT_SHOPPING,
    name: 'CVS Store 1234',
  },
  // A refund in a medical category: a refund, not HSA spending.
  {
    id: 'Km4wG2xA8cF5zT9dV3bZ',
    kind: 'REGULAR',
    amount: -20,
    categoryId: CAT_HEALTH,
    name: 'Family Clinic',
  },
  // Negative and uncategorized, no keyword: nothing.
  {
    id: 'Ln5xH3yB9dG6aV2fW4cA',
    kind: 'REGULAR',
    amount: -30,
    categoryId: null,
    name: 'Peer Payment',
  },
  // A category id in neither mode's name map, whose raw id happens to contain
  // a medical keyword: no name means no hsa match, in both modes (#854 review —
  // cache mode used to fall back to the id itself).
  {
    id: 'Nq7zK5aD3gJ8cX4hY6eC',
    kind: 'REGULAR',
    amount: 33,
    categoryId: 'Ux9visionK4mT7qR2wL5s',
    name: 'Corner Store',
  },
  {
    id: 'Mp6yJ4zC2fH7bW3gX5dB',
    kind: 'REGULAR',
    amount: 45,
    categoryId: CAT_SHOPPING,
    name: 'Gift Shop',
    tags: [TAG_TRIP],
  },
];

const EXPECTED: Record<(typeof LIVE_TRANSACTION_TYPES)[number], string[]> = {
  refunds: ['Bc4mX2nR8tW5qK9vL3sQ', 'Fg8rB6sW4yA9vP5zQ7xV', 'Km4wG2xA8cF5zT9dV3bZ'],
  credits: ['Ef7qA5rV3xZ8tN4yP6wT', 'Fg8rB6sW4yA9vP5zQ7xV'],
  hsa_eligible: ['Hj2tD8vY6aC3xR7bS9zX', 'Jk3vF9wZ7bD4yS8cT2aY'],
  tagged: ['Mp6yJ4zC2fH7bW3gX5dB'],
};

/** The spec as the decoder emits it (see processTransaction). */
function toCacheRow(s: Spec): Transaction {
  return {
    transaction_id: s.id,
    amount: s.amount,
    date: '2026-03-10',
    name: s.name.toUpperCase(),
    account_id: 'Wn7qL3xK9mT2vR6pB4sD',
    item_id: 'Xp8rM4yL2nV7wS3qC5tF',
    // The decoder writes '' on income and transfer rows.
    ...(s.categoryId !== null
      ? { category_id: s.categoryId }
      : s.kind !== 'REGULAR'
        ? { category_id: '' }
        : {}),
    ...(s.kind === 'INCOME' ? { income: true } : {}),
    ...(s.kind === 'INTERNAL_TRANSFER' ? { internal_transfer: true } : {}),
    ...(s.tags ? { tag_ids: s.tags } : {}),
  };
}

/** The spec as GraphQL returns it. */
function toLiveNode(s: Spec): TransactionNode {
  return {
    id: s.id,
    accountId: 'Wn7qL3xK9mT2vR6pB4sD',
    itemId: 'Xp8rM4yL2nV7wS3qC5tF',
    // GraphQL returns '' for an uncategorized income or transfer row.
    categoryId: s.categoryId ?? (s.kind === 'REGULAR' ? null : ''),
    recurringId: null,
    parentId: null,
    isReviewed: false,
    isPending: false,
    amount: s.amount,
    date: '2026-03-10',
    name: s.name,
    type: s.kind,
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    isoCurrencyCode: 'USD',
    createdAt: 0,
    tags: (s.tags ?? []).map((id) => ({ id, name: 'trip', colorName: 'BLUE1' })),
    goal: null,
  } as TransactionNode;
}

function cacheTools(): CopilotMoneyTools {
  const db = new CopilotDatabase('/fake/path');
  db._injectDataForTesting({
    transactions: SPECS.map(toCacheRow),
    accounts: [],
    recurring: [],
    budgets: [],
    goals: [],
    goalHistory: [],
    investmentPrices: [],
    items: [],
    tags: [{ tag_id: TAG_TRIP, name: 'trip' }],
    userCategories: CATEGORIES.map((c, i) => ({ category_id: c.id, name: c.name, order: i })),
    categoryNameMap: new Map(CATEGORIES.map((c) => [c.id, c.name])),
    accountNameMap: new Map(),
  });
  return new CopilotMoneyTools(db);
}

async function liveTools(): Promise<LiveTransactionsTools> {
  const client = { mutate: mock(), query: mock() } as unknown as GraphQLClient;
  const cache = {
    getAccounts: mock(() => Promise.resolve([])),
    getTags: mock(() => Promise.resolve([])),
  } as unknown as CopilotDatabase;
  const live = new LiveCopilotDatabase(client, cache);
  const nodes = SPECS.map(toLiveNode);
  (live as unknown as { getTransactions: () => Promise<unknown> }).getTransactions = async () => ({
    rows: nodes,
    oldest_fetched_at: 0,
    newest_fetched_at: 0,
    hit: true,
    dropped_invalid_rows: 0,
  });
  const categoryNodes: CategoryNode[] = CATEGORIES.map((c) => ({
    id: c.id,
    parentId: null,
    name: c.name,
    templateId: null,
    colorName: null,
    icon: null,
    isExcluded: false,
    isRolloverDisabled: false,
    canBeDeleted: true,
    budget: null,
  }));
  await live.getCategoriesCache().read(() => Promise.resolve(categoryNodes));
  return new LiveTransactionsTools(live);
}

const RANGE = { start_date: '2026-03-01', end_date: '2026-03-31' } as const;

describe('transaction_type totals and internal fields (#854 review)', () => {
  /** A cache db over `transactions`, with the fixture's categories. */
  function cacheToolsOver(transactions: Transaction[]): CopilotMoneyTools {
    const db = new CopilotDatabase('/fake/path');
    db._injectDataForTesting({
      transactions,
      accounts: [],
      recurring: [],
      budgets: [],
      goals: [],
      goalHistory: [],
      investmentPrices: [],
      items: [],
      tags: [],
      userCategories: CATEGORIES.map((c, i) => ({ category_id: c.id, name: c.name, order: i })),
      categoryNameMap: new Map(CATEGORIES.map((c) => [c.id, c.name])),
      accountNameMap: new Map(),
    });
    return new CopilotMoneyTools(db);
  }

  const row = (
    id: string,
    amount: number,
    extra: Partial<Transaction> = {},
    name = 'OUTDOOR STORE'
  ): Transaction => ({
    transaction_id: id,
    amount,
    date: '2026-03-10',
    name,
    category_id: CAT_SHOPPING,
    ...extra,
  });

  const REFUND_ROWS: Transaction[] = [
    row('Ra1kW9mQ2nR7tV4xL8sP', -40),
    // Individually excluded: dropped by exclude_excluded, so not in the total.
    row('Rb2mX2nR8tW5qK9vL3sQ', -25, { excluded: true }),
    // A split parent and its child: only the child matches and is counted.
    row('Rc3nY3pS9vX6rL2wM4tR', -30, { children_transaction_ids: ['Rd4pZ4qT2wY7sM3xN5vS'] }),
    row('Rd4pZ4qT2wY7sM3xN5vS', -30, { parent_transaction_id: 'Rc3nY3pS9vX6rL2wM4tR' }),
  ];

  test('cache totals cover all matching rows after the exclusion filters', async () => {
    const result = await cacheToolsOver(REFUND_ROWS).getTransactions({
      ...RANGE,
      transaction_type: 'refunds',
      fields: ['all'],
    });
    expect(result.transactions.map((t) => t.transaction_id).sort()).toEqual([
      'Ra1kW9mQ2nR7tV4xL8sP',
      'Rd4pZ4qT2wY7sM3xN5vS',
    ]);
    // The pre-#854-review ordering summed all four rows: 125.
    expect(result.type_specific_data?.total_refunded).toBe(70);
  });

  // #854 review, finding F: the totals are over ALL matching rows, not the
  // returned page — they pair with total_count. limit: 1 makes the two differ.
  test('cache totals cover all matching rows, not just the returned page (limit: 1)', async () => {
    const result = await cacheToolsOver(REFUND_ROWS).getTransactions({
      ...RANGE,
      transaction_type: 'refunds',
      limit: 1,
      fields: ['all'],
    });
    expect(result.count).toBe(1);
    expect(result.total_count).toBe(2);
    expect([40, 30]).toContain(Math.abs(result.transactions[0]!.amount ?? 0));
    expect(result.type_specific_data?.total_refunded).toBe(70);
  });

  // #854 review, finding A: `duplicates` is group-wise, so running it after the
  // row filters is a semantic choice. Pairs are found among the rows the
  // caller would see; an excluded twin or a split parent forms no pair.
  describe('duplicates groups the post-filter rows', () => {
    const DUP_ROWS: Transaction[] = [
      // A real pair: both copies visible.
      row('Da1kW9mQ2nR7tV4xL8sP', 12, {}, 'COFFEE BAR'),
      row('Db2mX2nR8tW5qK9vL3sQ', 12, {}, 'COFFEE BAR'),
      // A pair whose second copy is individually excluded.
      row('Dc3nY3pS9vX6rL2wM4tR', 30, {}, 'BOOK SHOP'),
      row('Dd4pZ4qT2wY7sM3xN5vS', 30, { excluded: true }, 'BOOK SHOP'),
      // A one-child split parent: identical to its own child by name/amount/date.
      row(
        'De5qA5rV3xZ8tN4yP6wT',
        50,
        { children_transaction_ids: ['Df6rB6sW4yA9vP5zQ7xV'] },
        'HARDWARE'
      ),
      row(
        'Df6rB6sW4yA9vP5zQ7xV',
        50,
        { parent_transaction_id: 'De5qA5rV3xZ8tN4yP6wT' },
        'HARDWARE'
      ),
    ];

    test('by default only the fully visible pair is a duplicate group', async () => {
      const result = await cacheToolsOver(DUP_ROWS).getTransactions({
        ...RANGE,
        transaction_type: 'duplicates',
      });
      expect(result.transactions.map((t) => t.transaction_id).sort()).toEqual([
        'Da1kW9mQ2nR7tV4xL8sP',
        'Db2mX2nR8tW5qK9vL3sQ',
      ]);
      expect(result.type_specific_data?.duplicate_groups).toBe(1);
    });

    test('exclude_excluded: false brings back the pair with an excluded copy', async () => {
      const result = await cacheToolsOver(DUP_ROWS).getTransactions({
        ...RANGE,
        transaction_type: 'duplicates',
        exclude_excluded: false,
      });
      expect(result.type_specific_data?.duplicate_groups).toBe(2);
      expect(result.transactions.map((t) => t.transaction_id)).toContain('Dd4pZ4qT2wY7sM3xN5vS');
      // The split parent is still not reported as its own child's duplicate.
      expect(result.transactions.map((t) => t.transaction_id)).not.toContain(
        'De5qA5rV3xZ8tN4yP6wT'
      );
    });
  });

  test('the internal `income` flag is never returned, and is not a selectable field', async () => {
    const all = await cacheTools().getTransactions({ ...RANGE, fields: ['all'], limit: 500 });
    expect(all.transactions.some((t) => 'income' in t)).toBe(false);
    const asked = await cacheTools().getTransactions({ ...RANGE, fields: ['income'] });
    expect(asked._field_warning).toContain('income');
  });
});

describe('transaction_type parity across modes (#843)', () => {
  test('live mode accepts exactly the values the shared rule table defines', () => {
    expect([...LIVE_TRANSACTION_TYPES].sort()).toEqual([...SHARED_TRANSACTION_TYPES].sort());
  });

  for (const type of LIVE_TRANSACTION_TYPES) {
    test(`${type}: cache and live select the same ids, and the right ones`, async () => {
      // Transfers are kept in so the rule itself has to reject them.
      const args = { ...RANGE, transaction_type: type, exclude_transfers: false, limit: 500 };
      const cache = await cacheTools().getTransactions(args);
      const live = await (await liveTools()).getTransactions(args);

      const cacheIds = cache.transactions.map((t) => t.transaction_id).sort();
      const liveIds = live.transactions.map((t) => t.transaction_id).sort();

      expect(liveIds).toEqual(cacheIds);
      expect(cacheIds).toEqual([...EXPECTED[type]].sort());
    });
  }

  test('a negative INCOME row is never a refund or a credit, in either mode', async () => {
    const paycheck = 'Cd5nY3pS9vX6rL2wM4tR';
    for (const type of ['refunds', 'credits'] as const) {
      const args = { ...RANGE, transaction_type: type, exclude_transfers: false, limit: 500 };
      const cache = await cacheTools().getTransactions(args);
      const live = await (await liveTools()).getTransactions(args);
      expect(cache.transactions.map((t) => t.transaction_id)).not.toContain(paycheck);
      expect(live.transactions.map((t) => t.transaction_id)).not.toContain(paycheck);
    }
  });
});

// #854 review, findings C/G: no side table of "rules that read a name". Each
// adapter resolves category_name lazily, so a rule pays for names only if it
// reads one, and the cache-only Plaid tier is the only resolver difference.
describe('category names are resolved lazily (#854 review)', () => {
  test('a rule that never reads category_name never calls the resolver', () => {
    let calls = 0;
    const resolveName = () => {
      calls++;
      return 'Shopping';
    };
    const txn = toCacheRow(SPECS[1]!);
    expect(TRANSACTION_TYPE_RULES.refunds(cacheTypeRuleRow(txn, resolveName))).toBe(true);
    expect(TRANSACTION_TYPE_RULES.tagged(liveTypeRuleRow(toLiveNode(SPECS[1]!), resolveName))).toBe(
      false
    );
    expect(calls).toBe(0);
  });

  test('hsa_eligible reads the name once per row, in both adapters', () => {
    let calls = 0;
    const resolveName = () => {
      calls++;
      return 'Health & Medical';
    };
    const spec = { ...SPECS[0]!, name: 'Corner Store' };
    const cacheRow = cacheTypeRuleRow(toCacheRow(spec), resolveName);
    expect(TRANSACTION_TYPE_RULES.hsa_eligible(cacheRow)).toBe(true);
    expect(cacheRow.category_name).toBe('Health & Medical');
    const liveRow = liveTypeRuleRow(toLiveNode(spec), resolveName);
    expect(TRANSACTION_TYPE_RULES.hsa_eligible(liveRow)).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('lookupKnownCategoryName (#854 review)', () => {
  test('user name, then Plaid name, else null; never an Object.prototype key', () => {
    const user = new Map([[CAT_HEALTH, 'Health & Medical']]);
    expect(lookupKnownCategoryName(CAT_HEALTH, user)).toBe('Health & Medical');
    expect(lookupKnownCategoryName('Ux9visionK4mT7qR2wL5s', user)).toBeNull();
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(lookupKnownCategoryName(key)).toBeNull();
      // The sibling that used the `in` operator, which walks the prototype chain.
      expect(isKnownPlaidCategory(key)).toBe(false);
    }
    expect(isKnownPlaidCategory('food_and_drink')).toBe(true);
  });
});
