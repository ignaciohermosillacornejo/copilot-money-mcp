import { describe, expect, test, mock } from 'bun:test';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import type { CopilotDatabase } from '../../../src/core/database.js';
import type { UpcomingRecurringNode } from '../../../src/core/graphql/queries/upcoming-recurrings.js';
import type { CategoryNode } from '../../../src/core/graphql/queries/categories.js';

const FAKE_DB = {} as CopilotDatabase;

function mkUpcoming(
  partial: Partial<UpcomingRecurringNode> & { id: string; name: string }
): UpcomingRecurringNode {
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

function mkLiveReturning(rows: UpcomingRecurringNode[]): {
  live: LiveCopilotDatabase;
  client: { query: ReturnType<typeof mock> };
} {
  const client = {
    query: mock(() => Promise.resolve({ unpaidUpcomingRecurrings: rows })),
  } as unknown as GraphQLClient & { query: ReturnType<typeof mock> };
  const live = new LiveCopilotDatabase(client, FAKE_DB);
  return { live, client };
}

describe('LiveUpcomingRecurringsTools.getUpcomingRecurrings', () => {
  test('cold call returns rows sorted by nextPaymentDate ascending with _cache_hit=false', async () => {
    const { live } = mkLiveReturning([
      mkUpcoming({ id: 'r1', name: 'Item Late', nextPaymentDate: '2026-05-20' }),
      mkUpcoming({ id: 'r2', name: 'Item Early', nextPaymentDate: '2026-05-05' }),
      mkUpcoming({ id: 'r3', name: 'Item Mid', nextPaymentDate: '2026-05-10' }),
    ]);
    const { LiveUpcomingRecurringsTools } =
      await import('../../../src/tools/live/upcoming-recurrings.js');
    const tools = new LiveUpcomingRecurringsTools(live);

    const result = await tools.getUpcomingRecurrings({});

    expect(result.count).toBe(3);
    expect(result.upcoming.map((r) => r.id)).toEqual(['r2', 'r3', 'r1']);
    expect(result._cache_hit).toBe(false);
  });

  test('warm call returns _cache_hit=true and does not re-query', async () => {
    const { live, client } = mkLiveReturning([
      mkUpcoming({ id: 'r1', name: 'Item', nextPaymentDate: '2026-05-10' }),
    ]);
    const { LiveUpcomingRecurringsTools } =
      await import('../../../src/tools/live/upcoming-recurrings.js');
    const tools = new LiveUpcomingRecurringsTools(live);

    await tools.getUpcomingRecurrings({});
    const result = await tools.getUpcomingRecurrings({});

    expect(result._cache_hit).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('returns empty list and count=0 when nothing is upcoming', async () => {
    const { live } = mkLiveReturning([]);
    const { LiveUpcomingRecurringsTools } =
      await import('../../../src/tools/live/upcoming-recurrings.js');
    const tools = new LiveUpcomingRecurringsTools(live);

    const result = await tools.getUpcomingRecurrings({});
    expect(result.count).toBe(0);
    expect(result.upcoming).toEqual([]);
    expect(result._cache_hit).toBe(false);
  });

  test('rows with null nextPaymentDate sort to the end', async () => {
    const { live } = mkLiveReturning([
      mkUpcoming({ id: 'r1', name: 'Has date', nextPaymentDate: '2026-05-10' }),
      mkUpcoming({ id: 'r2', name: 'No date', nextPaymentDate: null }),
      mkUpcoming({ id: 'r3', name: 'Earliest', nextPaymentDate: '2026-05-01' }),
    ]);
    const { LiveUpcomingRecurringsTools } =
      await import('../../../src/tools/live/upcoming-recurrings.js');
    const tools = new LiveUpcomingRecurringsTools(live);

    const result = await tools.getUpcomingRecurrings({});
    expect(result.upcoming.map((r) => r.id)).toEqual(['r3', 'r1', 'r2']);
  });

  test('category_name populated when categoriesCache is warm', async () => {
    const { live } = mkLiveReturning([
      mkUpcoming({
        id: 'r1',
        name: 'Cellphone Plan',
        nextPaymentAmount: 50,
        nextPaymentDate: '2026-05-10',
        categoryId: 'cat-utils',
      }),
    ]);

    await live
      .getCategoriesCache()
      .read(async () => [mkCat({ id: 'cat-utils', name: 'Utilities' })]);

    const { LiveUpcomingRecurringsTools } =
      await import('../../../src/tools/live/upcoming-recurrings.js');
    const tools = new LiveUpcomingRecurringsTools(live);
    const result = await tools.getUpcomingRecurrings({});

    const item = result.upcoming.find((r) => r.id === 'r1');
    expect(item?.category_name).toBe('Utilities');
  });

  test('category_name is null when categoriesCache is cold', async () => {
    const { live } = mkLiveReturning([
      mkUpcoming({
        id: 'r1',
        name: 'Mystery Sub',
        nextPaymentAmount: 5,
        nextPaymentDate: '2026-05-10',
        categoryId: 'cat-unknown',
      }),
    ]);
    // Do NOT pre-warm categoriesCache.

    const { LiveUpcomingRecurringsTools } =
      await import('../../../src/tools/live/upcoming-recurrings.js');
    const tools = new LiveUpcomingRecurringsTools(live);
    const result = await tools.getUpcomingRecurrings({});

    const item = result.upcoming.find((r) => r.id === 'r1');
    expect(item?.category_name).toBeNull();
  });

  test('category_name is null when the row has no categoryId (null categoryId)', async () => {
    const { live } = mkLiveReturning([
      mkUpcoming({ id: 'r1', name: 'Uncategorized', categoryId: null }),
    ]);
    // Warm categoriesCache so this isn't conflated with the cold-cache case.
    await live.getCategoriesCache().read(async () => [mkCat({ id: 'cat-x', name: 'X' })]);

    const { LiveUpcomingRecurringsTools } =
      await import('../../../src/tools/live/upcoming-recurrings.js');
    const tools = new LiveUpcomingRecurringsTools(live);
    const result = await tools.getUpcomingRecurrings({});

    const item = result.upcoming.find((r) => r.id === 'r1');
    expect(item?.category_name).toBeNull();
  });

  test('category_name is null when categoryId does not match any category', async () => {
    const { live } = mkLiveReturning([
      mkUpcoming({
        id: 'r1',
        name: 'Stale link',
        nextPaymentAmount: 9,
        nextPaymentDate: '2026-05-10',
        categoryId: 'cat-deleted',
      }),
    ]);
    await live.getCategoriesCache().read(async () => [mkCat({ id: 'cat-other', name: 'Other' })]);

    const { LiveUpcomingRecurringsTools } =
      await import('../../../src/tools/live/upcoming-recurrings.js');
    const tools = new LiveUpcomingRecurringsTools(live);
    const result = await tools.getUpcomingRecurrings({});

    const item = result.upcoming.find((r) => r.id === 'r1');
    expect(item?.category_name).toBeNull();
  });

  test('result includes ISO _cache_oldest_fetched_at and _cache_newest_fetched_at', async () => {
    const { live } = mkLiveReturning([
      mkUpcoming({ id: 'r1', name: 'Item', nextPaymentDate: '2026-05-10' }),
    ]);
    const { LiveUpcomingRecurringsTools } =
      await import('../../../src/tools/live/upcoming-recurrings.js');
    const tools = new LiveUpcomingRecurringsTools(live);

    const result = await tools.getUpcomingRecurrings({});
    expect(result._cache_oldest_fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result._cache_newest_fetched_at).toBe(result._cache_oldest_fetched_at);
  });
});

describe('createLiveUpcomingRecurringsToolSchema', () => {
  test('schema name is get_upcoming_recurrings_live', async () => {
    const { createLiveUpcomingRecurringsToolSchema } =
      await import('../../../src/tools/live/upcoming-recurrings.js');
    const schema = createLiveUpcomingRecurringsToolSchema();
    expect(schema.name).toBe('get_upcoming_recurrings_live');
  });

  test('schema is read-only', async () => {
    const { createLiveUpcomingRecurringsToolSchema } =
      await import('../../../src/tools/live/upcoming-recurrings.js');
    const schema = createLiveUpcomingRecurringsToolSchema();
    expect(schema.annotations.readOnlyHint).toBe(true);
  });

  test('description distinguishes about-to-bill vs configured/historical view', async () => {
    const { createLiveUpcomingRecurringsToolSchema } =
      await import('../../../src/tools/live/upcoming-recurrings.js');
    const schema = createLiveUpcomingRecurringsToolSchema();
    expect(schema.description).toMatch(/get_recurring_live/);
    expect(schema.description.toLowerCase()).toMatch(/about.to.bill|upcoming|next.due/);
  });
});
