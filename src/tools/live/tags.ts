/**
 * Live-mode get_tags_live tool.
 *
 * Fetches tags via GraphQL through the SnapshotCache<TagNode> exposed by
 * LiveCopilotDatabase (24h TTL). Output envelope mirrors the cache-mode
 * get_tags shape (count, tags) plus the freshness-envelope fields.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import { fetchTags, type TagNode } from '../../core/graphql/queries/tags.js';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GetTagsLiveArgs {
  // No filters yet; reserved for future args (e.g., color_filter).
}

export interface GetTagsLiveResult {
  count: number;
  tags: TagNode[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

export class LiveTagsTools {
  constructor(private readonly live: LiveCopilotDatabase) {}

  async getTags(_args: GetTagsLiveArgs): Promise<GetTagsLiveResult> {
    const cache = this.live.getTagsCache();
    const startedAt = Date.now();
    const {
      rows: cached,
      fetched_at,
      hit,
    } = await cache.read(() => fetchTags(this.live.getClient()));

    const rows = [...cached].sort((a, b) => a.name.localeCompare(b.name));

    // Log after sort so `rows` reflects what's returned to the caller.
    // Mirrors the LiveCategoriesTools convention.
    this.live.logReadCall({
      op: 'Tags',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: rows.length,
      cache_hit: hit,
    });

    const fetchedAtIso = new Date(fetched_at).toISOString();
    return {
      count: rows.length,
      tags: rows,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
    };
  }
}

export function createLiveTagsToolSchema() {
  return {
    name: 'get_tags_live',
    description: 'Get user tags (live, GraphQL-backed). Replaces get_tags when --live-reads is on.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
