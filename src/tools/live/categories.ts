/**
 * Live-mode get_categories_live tool.
 *
 * Fetches categories via GraphQL through the SnapshotCache<CategoryNode>
 * exposed by LiveCopilotDatabase (24h TTL). Always queries with
 * {budget: true} so PR #3 (Budgets) can project from the same cache.
 *
 * Output envelope mirrors the cache-mode get_user_categories shape (count,
 * categories) plus the freshness-envelope fields.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import {
  fetchCategories,
  type CategoryNode,
} from '../../core/graphql/queries/categories.js';

export interface GetCategoriesLiveArgs {
  excluded_only?: boolean;
}

export interface GetCategoriesLiveResult {
  count: number;
  categories: CategoryNode[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

export class LiveCategoriesTools {
  constructor(private readonly live: LiveCopilotDatabase) {}

  async getCategories(args: GetCategoriesLiveArgs): Promise<GetCategoriesLiveResult> {
    const cache = this.live.getCategoriesCache();
    const startedAt = Date.now();
    const { rows: cached, fetched_at, hit } = await cache.read(() =>
      fetchCategories(this.live.getClient())
    );

    let rows = cached;
    if (args.excluded_only === true) {
      rows = rows.filter((c) => c.isExcluded === true);
    }

    rows = [...rows].sort((a, b) => {
      const t = (a.templateId ?? '').localeCompare(b.templateId ?? '');
      return t !== 0 ? t : a.name.localeCompare(b.name);
    });

    this.live.logReadCall({
      op: 'Categories',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: rows.length,
      cache_hit: hit,
    });

    const fetchedAtIso = new Date(fetched_at).toISOString();
    return {
      count: rows.length,
      categories: rows,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
    };
  }
}

export function createLiveCategoriesToolSchema() {
  return {
    name: 'get_categories_live',
    description:
      'Get user categories (live, GraphQL-backed). Includes per-category budget data so get_budgets_live can read from the same cache. Replaces get_user_categories when --live-reads is on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        excluded_only: {
          type: 'boolean',
          description: 'Return only categories marked as excluded. Default: false.',
          default: false,
        },
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
