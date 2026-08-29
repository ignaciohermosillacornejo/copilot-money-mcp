import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import { CopilotDatabase } from '../../../src/core/database.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import { LiveCategoriesTools } from '../../../src/tools/live/categories.js';
import type {
  CategoryNode,
  CategoryBudgetMonthly,
} from '../../../src/core/graphql/queries/categories.js';

function makeClient(rows: unknown[]): GraphQLClient {
  // Single-shape mock: every query (User, Categories, ...) returns the same
  // `{categories: rows}` payload. The `categories` key is ignored by the User
  // query; the User query's `data.user` field is undefined here, which is fine
  // for tests that pre-warm userCache directly (most tests below). For tests
  // that exercise the user-config path, use makeMultiOpClient.
  return {
    query: mock(() => Promise.resolve({ categories: rows })),
  } as unknown as GraphQLClient;
}

function makeLive(client: GraphQLClient): LiveCopilotDatabase {
  return new LiveCopilotDatabase(client, new CopilotDatabase('/tmp/no-such-db'));
}

// Pre-warms userCache with rollovers OFF so tests that don't exercise the
// user-config path can still read categories without hitting the User query.
// The historical hardcoded `rollovers: false` matches this default.
async function prewarmUserCacheRolloversOff(live: LiveCopilotDatabase): Promise<void> {
  await live.getUserCache().read(() =>
    Promise.resolve([
      {
        id: 'test-user',
        budgetingConfig: {
          isEnabled: true,
          rolloversConfig: { isEnabled: false, startDate: null },
        },
      },
    ])
  );
}

const sampleRow = {
  id: 'cat-1',
  name: 'Coffee',
  templateId: 'Coffee',
  colorName: 'ORANGE2',
  isExcluded: false,
  isRolloverDisabled: false,
  canBeDeleted: true,
  icon: { __typename: 'EmojiUnicode', unicode: '☕' },
  budget: null,
};

describe('LiveCategoriesTools.getCategories', () => {
  test('cold call: fetches and returns rows with cache_hit=false', async () => {
    const client = makeClient([sampleRow]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveCategoriesTools(live);

    const result = await tools.getCategories({});

    expect(result.count).toBe(1);
    expect(result.categories[0]?.id).toBe('cat-1');
    expect(result._cache_hit).toBe(false);
    expect(typeof result._cache_oldest_fetched_at).toBe('string');
  });

  test('warm call: cache hit, no second fetch', async () => {
    const client = makeClient([sampleRow]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveCategoriesTools(live);

    await tools.getCategories({});
    const second = await tools.getCategories({});

    expect(second._cache_hit).toBe(true);
    // userCache pre-warmed (so no User query); only the Categories query fires.
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('excluded_only=true filters to isExcluded categories', async () => {
    const client = makeClient([
      sampleRow,
      { ...sampleRow, id: 'cat-2', name: 'Excluded', isExcluded: true },
    ]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveCategoriesTools(live);

    const result = await tools.getCategories({ excluded_only: true });

    expect(result.count).toBe(1);
    expect(result.categories[0]?.id).toBe('cat-2');
  });

  test('empty result returns count 0, no throw', async () => {
    const client = makeClient([]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveCategoriesTools(live);

    const result = await tools.getCategories({});

    expect(result.count).toBe(0);
    expect(result.categories).toEqual([]);
  });

  // Important 2 (#597 final review): without an explicit knownFields set,
  // projectRows falls back to row-key detection, which cannot flag a typo
  // when there are zero rows to check keys against. get_categories_live now
  // passes CATEGORY_LIVE_KNOWN_FIELDS, so this must warn like get_transactions
  // and get_investment_prices do on the same shape of request.
  test('a typo in fields warns even on an empty result set (knownFields)', async () => {
    const client = makeClient([]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveCategoriesTools(live);

    const result = await tools.getCategories({ fields: ['default', 'not_a_real_field'] });

    expect(result.count).toBe(0);
    expect(result._field_warning).toBeDefined();
    expect(result._field_warning).toContain('not_a_real_field');
  });

  test('output sorted by templateId then name; null templateId sorts last', async () => {
    const client = makeClient([
      { ...sampleRow, id: 'a', name: 'Zebra', templateId: 'Food' },
      { ...sampleRow, id: 'b', name: 'Apple', templateId: 'Food' },
      { ...sampleRow, id: 'c', name: 'Cake', templateId: 'Drink' },
      { ...sampleRow, id: 'd', name: 'Custom', templateId: null },
    ]);
    const live = makeLive(client);
    await prewarmUserCacheRolloversOff(live);
    const tools = new LiveCategoriesTools(live);

    const result = await tools.getCategories({});

    // Drink < Food < null-sentinel; within Food, Apple < Zebra
    expect(result.categories.map((c) => c.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  test('regression C1: default include_history=false strips budget.histories', async () => {
    const fixture: CategoryNode = {
      id: 'cat-1',
      parentId: null,
      name: 'Restaurants',
      templateId: 'Restaurants',
      colorName: 'PURPLE2',
      icon: { __typename: 'EmojiUnicode', unicode: '🍔' },
      isExcluded: false,
      isRolloverDisabled: false,
      canBeDeleted: true,
      budget: {
        current: {
          unassignedRolloverAmount: null,
          childRolloverAmount: null,
          unassignedAmount: null,
          resolvedAmount: 500,
          rolloverAmount: 0,
          childAmount: null,
          goalAmount: 0,
          amount: 500,
          month: '2026-05',
          id: 'budget-current-id',
        },
        histories: [
          {
            unassignedRolloverAmount: null,
            childRolloverAmount: null,
            unassignedAmount: null,
            resolvedAmount: 500,
            rolloverAmount: 0,
            childAmount: null,
            goalAmount: 0,
            amount: 500,
            month: '2026-04',
            id: 'budget-history-1',
          },
          {
            unassignedRolloverAmount: null,
            childRolloverAmount: null,
            unassignedAmount: null,
            resolvedAmount: 500,
            rolloverAmount: 0,
            childAmount: null,
            goalAmount: 0,
            amount: 500,
            month: '2026-03',
            id: 'budget-history-2',
          },
        ],
      },
    };
    const live = makeLive(makeClient([fixture]));
    const tools = new LiveCategoriesTools(live);

    // v3 (#597 Tier 1): `budget` is no longer on the row at all unless
    // `fields` asks for it — request it explicitly here so this test can
    // still exercise the include_history stripping behavior it's named for.
    const result = await tools.getCategories({ fields: ['default', 'budget'] });

    expect(result.count).toBe(1);
    // Default behavior: histories must be stripped to keep response small.
    expect(result.categories[0]?.budget?.histories).toEqual([]);
    // Current month is preserved.
    expect(result.categories[0]?.budget?.current?.amount).toBe(500);
    // budget_amount is derived regardless of the histories strip.
    expect(result.categories[0]?.budget_amount).toBe(500);

    // Cache must NOT be mutated — second read should still see histories
    // (verifies the projection clones rather than mutates).
    const cached = live.getCategoriesCache().peek();
    expect(cached?.[0]?.budget?.histories).toHaveLength(2);
  });

  test('regression C1: include_history=true preserves budget.histories', async () => {
    const fixture: CategoryNode = {
      id: 'cat-1',
      parentId: null,
      name: 'Restaurants',
      templateId: 'Restaurants',
      colorName: 'PURPLE2',
      icon: { __typename: 'EmojiUnicode', unicode: '🍔' },
      isExcluded: false,
      isRolloverDisabled: false,
      canBeDeleted: true,
      budget: {
        current: null,
        histories: [
          {
            unassignedRolloverAmount: null,
            childRolloverAmount: null,
            unassignedAmount: null,
            resolvedAmount: 500,
            rolloverAmount: 0,
            childAmount: null,
            goalAmount: 0,
            amount: 500,
            month: '2026-04',
            id: 'budget-history-1',
          },
        ],
      },
    };
    const live = makeLive(makeClient([fixture]));
    const tools = new LiveCategoriesTools(live);

    // v3 (#597 Tier 1): `budget` is no longer on the row at all unless
    // `fields` asks for it — request it explicitly alongside include_history.
    const result = await tools.getCategories({
      include_history: true,
      fields: ['default', 'budget'],
    });

    expect(result.categories[0]?.budget?.histories).toHaveLength(1);
    expect(result.categories[0]?.budget?.histories[0]?.month).toBe('2026-04');
  });
});

// v3 (#597 Tier 1): the `budget` object ({current, histories}) is ~62% of a
// row and duplicates get_budgets_live. Default rows now carry a derived
// `budget_amount` instead; the full object is opt-in via `fields`.
describe('LiveCategoriesTools.getCategories — v3 budget diet (#597 T1)', () => {
  function budgetMonth(
    overrides: Partial<{ month: string; id: string; amount: number | null }>
  ): CategoryBudgetMonthly {
    return {
      unassignedRolloverAmount: null,
      childRolloverAmount: null,
      unassignedAmount: null,
      resolvedAmount: overrides.amount ?? 400,
      rolloverAmount: 0,
      childAmount: null,
      goalAmount: 0,
      amount: overrides.amount ?? 400,
      month: overrides.month ?? '2026-05',
      id: overrides.id ?? 'budget-current-id',
    };
  }

  const categoryWithBudget: CategoryNode = {
    id: 'cat-budget-1',
    parentId: null,
    name: 'Test Category',
    templateId: 'TestCategory',
    colorName: 'ORANGE2',
    icon: { __typename: 'EmojiUnicode', unicode: '📦' },
    isExcluded: false,
    isRolloverDisabled: false,
    canBeDeleted: true,
    budget: {
      current: budgetMonth({ amount: 400 }),
      histories: [
        budgetMonth({ month: '2026-04', id: 'budget-history-1', amount: 400 }),
        budgetMonth({ month: '2026-03', id: 'budget-history-2', amount: 400 }),
        budgetMonth({ month: '2026-02', id: 'budget-history-3', amount: 400 }),
      ],
    },
  };

  // `budget` is omitted entirely (not set to `null`) — CategoryNode's
  // `budget?:` is genuinely optional (see CategoryRawFieldsSchema in
  // src/core/graphql/queries/categories.ts: `.nullable().optional()`), and
  // the own-key-absent case is the one that actually exercises row-key
  // fallback detection: a `budget: null` row still carries `budget` as an
  // own key, so it would NOT reproduce Important 2's false-positive bug.
  const categoryWithoutBudget: CategoryNode = {
    id: 'cat-no-budget-1',
    parentId: null,
    name: 'No Budget Category',
    templateId: null,
    colorName: 'BLUE2',
    icon: null,
    isExcluded: false,
    isRolloverDisabled: false,
    canBeDeleted: true,
  };

  // NOTE: the task brief's Step 2 test snippets call these with
  // `{ include_budget: true }`, which is not a real GetCategoriesLiveArgs
  // field — the toggle that actually exists is `include_history` (controls
  // whether budget.histories survives when `budget` ends up in the response
  // at all; orthogonal to whether it's in the response, which the new
  // `fields` default below controls). Substituted 1:1 below; the assertions
  // are verbatim from the brief.
  test('default rows carry derived budget_amount, not the budget object', async () => {
    const tools = new LiveCategoriesTools(makeLive(makeClient([categoryWithBudget])));
    const result = await tools.getCategories({ include_history: true });
    expect(result.categories[0]).not.toHaveProperty('budget');
    expect(result.categories[0]?.budget_amount).toBe(400);
  });

  test('budget_amount is null when the category has no budget', async () => {
    const tools = new LiveCategoriesTools(makeLive(makeClient([categoryWithoutBudget])));
    const result = await tools.getCategories({ include_history: true });
    expect(result.categories[0]?.budget_amount).toBeNull();
  });

  test('fields: ["default", "budget"] restores the full object', async () => {
    const tools = new LiveCategoriesTools(makeLive(makeClient([categoryWithBudget])));
    const result = await tools.getCategories({
      include_history: true,
      fields: ['default', 'budget'],
    });
    expect(result.categories[0]?.budget?.histories).toHaveLength(3);
  });

  // Important 2 (#597 final review): `budget` is `budget?:` on CategoryLiveRow
  // — legitimately absent from a row when the category has none. Without
  // `budget` in CATEGORY_LIVE_KNOWN_FIELDS, row-key fallback detection would
  // see zero rows carrying the key and false-warn "budget does not exist"
  // even though the caller's request is exactly correct.
  test('fields: ["default", "budget"] against a row with no budget does not false-warn', async () => {
    const tools = new LiveCategoriesTools(makeLive(makeClient([categoryWithoutBudget])));
    const result = await tools.getCategories({
      fields: ['default', 'budget'],
    });
    expect(result.categories[0]?.budget_amount).toBeNull();
    expect(result._field_warning).toBeUndefined();
  });

  test('default rows omit templateId/icon/isRolloverDisabled/canBeDeleted (verbatim preset)', async () => {
    const tools = new LiveCategoriesTools(makeLive(makeClient([categoryWithBudget])));
    const result = await tools.getCategories({});
    expect(result.categories[0]).toEqual({
      id: 'cat-budget-1',
      parentId: null,
      name: 'Test Category',
      colorName: 'ORANGE2',
      isExcluded: false,
      budget_amount: 400,
    });
  });

  test('the terse default is smaller than the full row (#597 Tier 1)', async () => {
    const terseTools = new LiveCategoriesTools(makeLive(makeClient([categoryWithBudget])));
    const terse = await terseTools.getCategories({ include_history: true });
    const fullTools = new LiveCategoriesTools(makeLive(makeClient([categoryWithBudget])));
    const full = await fullTools.getCategories({ include_history: true, fields: ['all'] });

    const terseSize = JSON.stringify(terse).length;
    const fullSize = JSON.stringify(full).length;
    // Meaningful ratio, not just any smaller: on this fixture terse/full is
    // ~275/726 (~2.6x), so `fullSize / 2` leaves ample margin while still
    // failing a one-character-smaller regression. The verbatim-preset test
    // above is the real shape guard; this one guards the size claim itself.
    expect(terseSize).toBeLessThan(fullSize / 2);
  });
});

describe('LiveCategoriesTools.getCategories — audit C6 regression', () => {
  // Multi-op mock client: discriminates by op name so we can capture the
  // Categories variables while also returning a User payload.
  function makeMultiOpClient(opts: {
    user: {
      id: string;
      budgetingConfig: {
        isEnabled: boolean;
        rolloversConfig: { isEnabled: boolean; startDate: string | null } | null;
      } | null;
    };
    categories?: unknown[];
  }): { client: GraphQLClient; calls: Array<{ op: string; vars: Record<string, unknown> }> } {
    const calls: Array<{ op: string; vars: Record<string, unknown> }> = [];
    const client = {
      query: mock((op: string, _q: string, vars: Record<string, unknown>) => {
        calls.push({ op, vars });
        if (op === 'User') return Promise.resolve({ user: opts.user });
        if (op === 'Categories') return Promise.resolve({ categories: opts.categories ?? [] });
        return Promise.resolve({});
      }),
    } as unknown as GraphQLClient;
    return { client, calls };
  }

  test('rollovers flag mirrors user.budgetingConfig.rolloversConfig.isEnabled (true)', async () => {
    const { client, calls } = makeMultiOpClient({
      user: {
        id: 'u-1',
        budgetingConfig: {
          isEnabled: true,
          rolloversConfig: { isEnabled: true, startDate: '2026-01' },
        },
      },
    });
    const tools = new LiveCategoriesTools(makeLive(client));

    await tools.getCategories({});

    const categoriesCall = calls.find((c) => c.op === 'Categories');
    expect(categoriesCall?.vars.rollovers).toBe(true);
    // Sanity: User query also fired.
    expect(calls.some((c) => c.op === 'User')).toBe(true);
  });

  test('rollovers flag is false when rolloversConfig.isEnabled is false', async () => {
    const { client, calls } = makeMultiOpClient({
      user: {
        id: 'u-2',
        budgetingConfig: {
          isEnabled: true,
          rolloversConfig: { isEnabled: false, startDate: null },
        },
      },
    });
    const tools = new LiveCategoriesTools(makeLive(client));

    await tools.getCategories({});

    const categoriesCall = calls.find((c) => c.op === 'Categories');
    expect(categoriesCall?.vars.rollovers).toBe(false);
  });

  test('rollovers flag is false when budgetingConfig.isEnabled is false (defensive)', async () => {
    const { client, calls } = makeMultiOpClient({
      user: {
        id: 'u-3',
        budgetingConfig: {
          isEnabled: false,
          rolloversConfig: { isEnabled: true, startDate: '2026-01' },
        },
      },
    });
    const tools = new LiveCategoriesTools(makeLive(client));

    await tools.getCategories({});

    const categoriesCall = calls.find((c) => c.op === 'Categories');
    expect(categoriesCall?.vars.rollovers).toBe(false);
  });

  test('rollovers flag is false when budgetingConfig is null', async () => {
    const { client, calls } = makeMultiOpClient({
      user: { id: 'u-4', budgetingConfig: null },
    });
    const tools = new LiveCategoriesTools(makeLive(client));

    await tools.getCategories({});

    const categoriesCall = calls.find((c) => c.op === 'Categories');
    expect(categoriesCall?.vars.rollovers).toBe(false);
  });

  test('userCache shields callers: a second getCategories call does not refetch User', async () => {
    const { client, calls } = makeMultiOpClient({
      user: {
        id: 'u-1',
        budgetingConfig: {
          isEnabled: true,
          rolloversConfig: { isEnabled: true, startDate: '2026-01' },
        },
      },
    });
    const live = makeLive(client);
    const tools = new LiveCategoriesTools(live);

    await tools.getCategories({});
    // Force a second cold Categories fetch by invalidating only categoriesCache.
    live.getCategoriesCache().invalidate();
    await tools.getCategories({});

    const userCalls = calls.filter((c) => c.op === 'User');
    const categoryCalls = calls.filter((c) => c.op === 'Categories');
    expect(userCalls).toHaveLength(1);
    expect(categoryCalls).toHaveLength(2);
  });
});

describe('createLiveCategoriesToolSchema', () => {
  test('returns a schema with readOnlyHint=true', async () => {
    const { createLiveCategoriesToolSchema } =
      await import('../../../src/tools/live/categories.js');
    const schema = createLiveCategoriesToolSchema();
    expect(schema.name).toBe('get_categories_live');
    expect(schema.annotations?.readOnlyHint).toBe(true);
  });

  // v3 (#597 Tier 1): pins the fields param fragment to the shared preset and
  // guards that the description names the excluded `budget` token — a
  // generic `fields` param is otherwise undiscoverable (see the convention
  // note on #597).
  test('fields param schema matches CATEGORY_LIVE_FIELDS_PARAM_SCHEMA and names budget', async () => {
    const { createLiveCategoriesToolSchema } =
      await import('../../../src/tools/live/categories.js');
    const { CATEGORY_LIVE_FIELDS_PARAM_SCHEMA } =
      await import('../../../src/tools/field-selection.js');
    const schema = createLiveCategoriesToolSchema();
    const props = schema.inputSchema.properties as Record<string, unknown>;
    expect(props.fields).toEqual(CATEGORY_LIVE_FIELDS_PARAM_SCHEMA);
    // Distinctive phrases only present in the exclusion sentence itself —
    // 'budget' alone is a substring of 'budget_amount' (default field list)
    // and of the literal `"budget"` token (opt-back-in example), both of
    // which survive deleting the exclusion sentence, so a bare
    // toContain('budget') guards nothing.
    expect(CATEGORY_LIVE_FIELDS_PARAM_SCHEMA.description).toContain('EXCLUDED by default');
    expect(CATEGORY_LIVE_FIELDS_PARAM_SCHEMA.description).toContain('`budget` object');
  });
});
