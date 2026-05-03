import { describe, expect, test, mock } from 'bun:test';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import type { CopilotDatabase } from '../../../src/core/database.js';
import type { RecurringNode } from '../../../src/core/graphql/queries/recurrings.js';

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
});
