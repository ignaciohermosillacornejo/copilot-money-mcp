import { describe, expect, test, mock } from 'bun:test';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import type { CopilotDatabase } from '../../../src/core/database.js';
import type { RecurringNode } from '../../../src/core/graphql/queries/recurrings.js';
import type { CategoryNode } from '../../../src/core/graphql/queries/categories.js';

const FAKE_DB = {} as CopilotDatabase;

function mkRec(partial: Partial<RecurringNode> & { id: string; name: string }): RecurringNode {
  return {
    state: 'ACTIVE',
    frequency: 'MONTHLY',
    nextPaymentAmount: null,
    nextPaymentDate: null,
    categoryId: null,
    emoji: null,
    icon: null,
    rule: null,
    payments: [],
    ...partial,
  };
}

function mkCat(partial: Partial<CategoryNode> & { id: string; name: string }): CategoryNode {
  return {
    templateId: null,
    colorName: null,
    icon: null,
    isExcluded: false,
    isRolloverDisabled: false,
    canBeDeleted: true,
    budget: null,
    ...partial,
  };
}

function mkLiveReturning(rows: RecurringNode[]): {
  live: LiveCopilotDatabase;
  client: { query: ReturnType<typeof mock> };
} {
  const client = {
    query: mock(() => Promise.resolve({ recurrings: rows })),
  } as unknown as GraphQLClient & { query: ReturnType<typeof mock> };
  const live = new LiveCopilotDatabase(client, FAKE_DB);
  return { live, client };
}

// A row carrying `rule` AND `payments` — used by the terse-default tests
// (#597 Tier 1) — the point is that both are populated, not just absent
// zeros/nulls, so a preset that silently stopped excluding one would fail a
// mutation check instead of passing by coincidence.
const fatRecurringRow: RecurringNode = mkRec({
  id: 'r1',
  name: 'Fat Sub',
  state: 'ACTIVE',
  frequency: 'MONTHLY',
  nextPaymentAmount: 200,
  nextPaymentDate: '2024-03-01',
  categoryId: 'cat-utils',
  emoji: '💰',
  rule: { nameContains: 'FAT SUB', minAmount: 190, maxAmount: 210, days: [1] },
  payments: [
    { amount: 200, isPaid: true, date: '2024-02-01' },
    { amount: 200, isPaid: false, date: '2024-03-01' },
  ],
});

describe('LiveRecurringTools.getRecurring', () => {
  test('returns sorted-by-name rows on cold call with _cache_hit=false', async () => {
    const { live } = mkLiveReturning([
      mkRec({ id: 'r1', name: 'Spotify' }),
      mkRec({ id: 'r2', name: 'Netflix' }),
    ]);
    const { LiveRecurringTools } = await import('../../../src/tools/live/recurring.js');
    const tools = new LiveRecurringTools(live);

    const result = await tools.getRecurring({});

    expect(result.count).toBe(2);
    expect(result.recurring.map((r) => r.name)).toEqual(['Netflix', 'Spotify']);
    expect(result._cache_hit).toBe(false);
  });

  test('warm call returns _cache_hit=true and does not re-query', async () => {
    const { live, client } = mkLiveReturning([mkRec({ id: 'r1', name: 'Spotify' })]);
    const { LiveRecurringTools } = await import('../../../src/tools/live/recurring.js');
    const tools = new LiveRecurringTools(live);

    await tools.getRecurring({});
    const result = await tools.getRecurring({});

    expect(result._cache_hit).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('returns empty list and count=0 when there are no recurrings', async () => {
    const { live } = mkLiveReturning([]);
    const { LiveRecurringTools } = await import('../../../src/tools/live/recurring.js');
    const tools = new LiveRecurringTools(live);

    const result = await tools.getRecurring({});
    expect(result.count).toBe(0);
    expect(result.recurring).toEqual([]);
    expect(result._cache_hit).toBe(false);
  });

  test('regression R1: category_name populated when categoriesCache is warm', async () => {
    const { live } = mkLiveReturning([
      mkRec({
        id: 'r1',
        name: 'Cellphone Plan',
        nextPaymentAmount: 52.37,
        nextPaymentDate: '2026-05-10',
        categoryId: 'cat-utils',
      }),
    ]);

    // Pre-warm categoriesCache with the matching category.
    await live
      .getCategoriesCache()
      .read(async () => [mkCat({ id: 'cat-utils', name: 'Utilities' })]);

    const { LiveRecurringTools } = await import('../../../src/tools/live/recurring.js');
    const tools = new LiveRecurringTools(live);
    const result = await tools.getRecurring({});

    const item = result.recurring.find((r) => r.id === 'r1');
    expect(item?.category_name).toBe('Utilities');
  });

  test('regression R1: category_name is null when categoriesCache is cold', async () => {
    const { live } = mkLiveReturning([
      mkRec({
        id: 'r1',
        name: 'Mystery Sub',
        nextPaymentAmount: 5,
        nextPaymentDate: '2026-05-10',
        categoryId: 'cat-unknown',
      }),
    ]);
    // Do NOT pre-warm categoriesCache — verify the cold-cache fallback.

    const { LiveRecurringTools } = await import('../../../src/tools/live/recurring.js');
    const tools = new LiveRecurringTools(live);
    const result = await tools.getRecurring({});

    const item = result.recurring.find((r) => r.id === 'r1');
    expect(item?.category_name).toBeNull();
  });

  test('regression R1: category_name is null when categoryId does not match any category', async () => {
    const { live } = mkLiveReturning([
      mkRec({
        id: 'r1',
        name: 'Stale link',
        nextPaymentAmount: 9,
        nextPaymentDate: '2026-05-10',
        categoryId: 'cat-deleted',
      }),
    ]);
    // Warm with a category that does NOT match.
    await live.getCategoriesCache().read(async () => [mkCat({ id: 'cat-other', name: 'Other' })]);

    const { LiveRecurringTools } = await import('../../../src/tools/live/recurring.js');
    const tools = new LiveRecurringTools(live);
    const result = await tools.getRecurring({});

    const item = result.recurring.find((r) => r.id === 'r1');
    expect(item?.category_name).toBeNull();
  });

  test('default rows exclude rule and payments but keep the payment schedule', async () => {
    const { live } = mkLiveReturning([fatRecurringRow]);
    const { LiveRecurringTools } = await import('../../../src/tools/live/recurring.js');
    const tools = new LiveRecurringTools(live);

    const result = await tools.getRecurring({});

    expect(result.recurring[0]).not.toHaveProperty('rule');
    expect(result.recurring[0]).not.toHaveProperty('payments');
    expect(result.recurring[0]).not.toHaveProperty('icon');
    expect(result.recurring[0]!.nextPaymentDate).toBe('2024-03-01');
    expect(result.recurring[0]!.nextPaymentAmount).toBe(200);
    // Every DEFAULT_RECURRING_LIVE_FIELDS entry, proven present with a real
    // value (not just `undefined` surviving key deletion).
    expect(result.recurring[0]!.id).toBe('r1');
    expect(result.recurring[0]!.state).toBe('ACTIVE');
    expect(result.recurring[0]!.frequency).toBe('MONTHLY');
    expect(result.recurring[0]!.categoryId).toBe('cat-utils');
    expect(result.recurring[0]!.emoji).toBe('💰');
  });

  test('fields: ["default", "rule"] restores the matcher config', async () => {
    const { live } = mkLiveReturning([fatRecurringRow]);
    const { LiveRecurringTools } = await import('../../../src/tools/live/recurring.js');
    const tools = new LiveRecurringTools(live);

    const result = await tools.getRecurring({ fields: ['default', 'rule'] });

    expect(result.recurring[0]!.rule).toBeDefined();
    expect(result.recurring[0]).not.toHaveProperty('payments');
  });

  test('fields: ["all"] returns full rows', async () => {
    const { live } = mkLiveReturning([fatRecurringRow]);
    const { LiveRecurringTools } = await import('../../../src/tools/live/recurring.js');
    const tools = new LiveRecurringTools(live);

    const result = await tools.getRecurring({ fields: ['all'] });

    expect(result.recurring[0]!.rule).toBeDefined();
    expect(result.recurring[0]!.payments).toHaveLength(2);
  });

  // Without an explicit knownFields set, projectRows falls back to row-key
  // detection, which cannot flag a typo when there are zero rows to check
  // keys against — get_recurring_live passes RECURRING_LIVE_KNOWN_FIELDS so
  // this must warn like get_top_movers_live/get_transactions.
  test('a typo in fields warns even on an empty result set (knownFields)', async () => {
    const { live } = mkLiveReturning([]);
    const { LiveRecurringTools } = await import('../../../src/tools/live/recurring.js');
    const tools = new LiveRecurringTools(live);

    const result = await tools.getRecurring({ fields: ['default', 'not_a_real_field'] });

    expect(result.count).toBe(0);
    expect(result._field_warning).toBeDefined();
    expect(result._field_warning).toContain('not_a_real_field');
  });

  test('the invalid-field hint names every selectable field (derived, not hand-listed)', async () => {
    const { live } = mkLiveReturning([]);
    const { LiveRecurringTools } = await import('../../../src/tools/live/recurring.js');
    const tools = new LiveRecurringTools(live);

    const result = await tools.getRecurring({ fields: ['nope'] });
    const hint = result._field_warning ?? '';
    for (const name of [
      'id',
      'name',
      'state',
      'frequency',
      'nextPaymentAmount',
      'nextPaymentDate',
      'categoryId',
      'emoji',
      'icon',
      'rule',
      'payments',
      'category_name',
    ]) {
      expect(hint).toContain(name);
    }
  });

  test('the terse default is smaller than the full row (#597 Tier 1)', async () => {
    const { live: liveTerse } = mkLiveReturning([fatRecurringRow]);
    const { LiveRecurringTools } = await import('../../../src/tools/live/recurring.js');
    const terse = await new LiveRecurringTools(liveTerse).getRecurring({});

    const { live: liveFull } = mkLiveReturning([fatRecurringRow]);
    const full = await new LiveRecurringTools(liveFull).getRecurring({ fields: ['all'] });

    const terseSize = JSON.stringify(terse).length;
    const fullSize = JSON.stringify(full).length;
    expect(terseSize).toBeLessThan(fullSize);
  });
});

describe('createLiveRecurringToolSchema', () => {
  test('schema exposes the fields param naming the excluded tokens', async () => {
    const { createLiveRecurringToolSchema } = await import('../../../src/tools/live/recurring.js');
    const schema = createLiveRecurringToolSchema();

    expect(schema.inputSchema.properties?.fields).toBeDefined();
    expect(schema.description).toContain('rule');
    expect(schema.description).toContain('payments');
    expect(schema.annotations.readOnlyHint).toBe(true);
  });
});
