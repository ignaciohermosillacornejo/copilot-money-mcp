import { describe, expect, test, mock } from 'bun:test';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import { CopilotDatabase } from '../../../src/core/database.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import { LiveTagsTools } from '../../../src/tools/live/tags.js';

function makeClient(rows: unknown[]): GraphQLClient {
  return {
    query: mock(() => Promise.resolve({ tags: rows })),
  } as unknown as GraphQLClient;
}

function makeLive(client: GraphQLClient): LiveCopilotDatabase {
  return new LiveCopilotDatabase(client, new CopilotDatabase('/tmp/no-such-db'));
}

const sampleRow = { id: 'tag-1', name: 'travel', colorName: 'BLUE1' };

describe('LiveTagsTools.getTags', () => {
  test('cold call: fetches and returns rows with cache_hit=false', async () => {
    const client = makeClient([sampleRow]);
    const tools = new LiveTagsTools(makeLive(client));

    const result = await tools.getTags({});

    expect(result.count).toBe(1);
    expect(result.tags[0]?.id).toBe('tag-1');
    expect(result._cache_hit).toBe(false);
    expect(typeof result._cache_oldest_fetched_at).toBe('string');
  });

  test('warm call: cache hit, no second fetch', async () => {
    const client = makeClient([sampleRow]);
    const tools = new LiveTagsTools(makeLive(client));

    await tools.getTags({});
    const second = await tools.getTags({});

    expect(second._cache_hit).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test('empty result returns count 0, no throw', async () => {
    const client = makeClient([]);
    const tools = new LiveTagsTools(makeLive(client));

    const result = await tools.getTags({});

    expect(result.count).toBe(0);
    expect(result.tags).toEqual([]);
  });

  test('output sorted by name', async () => {
    const client = makeClient([
      { id: 'b', name: 'work', colorName: null },
      { id: 'a', name: 'travel', colorName: null },
      { id: 'c', name: 'apple', colorName: null },
    ]);
    const tools = new LiveTagsTools(makeLive(client));

    const result = await tools.getTags({});

    expect(result.tags.map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('createLiveTagsToolSchema', () => {
  test('returns a schema with readOnlyHint=true', async () => {
    const { createLiveTagsToolSchema } = await import('../../../src/tools/live/tags.js');
    const schema = createLiveTagsToolSchema();
    expect(schema.name).toBe('get_tags_live');
    expect(schema.annotations?.readOnlyHint).toBe(true);
  });
});
