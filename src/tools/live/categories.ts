/**
 * Live-mode get_categories_live tool.
 *
 * Fetches categories via GraphQL through the SnapshotCache<CategoryNode>
 * exposed by LiveCopilotDatabase (24h TTL). Always queries with
 * {budget: true} so PR #3 (Budgets) can project from the same cache.
 *
 * Output envelope mirrors the cache-mode get_categories shape (count,
 * categories) plus the freshness-envelope fields.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import { fetchCategories, type CategoryNode } from '../../core/graphql/queries/categories.js';

export interface GetCategoriesLiveArgs {
  excluded_only?: boolean;
  /**
   * Whether to include the per-category `budget.histories[]` array in the
   * response. Default: `false` — histories are stripped to keep the response
   * within the LLM tool-result token budget. The cache still stores the full
   * history; this only affects the serialized output. Set to `true` for
   * historical analysis or budget-trend charting.
   */
  include_history?: boolean;
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
    const {
      rows: cached,
      fetched_at,
      hit,
    } = await cache.read(() => fetchCategories(this.live.getClient()));

    let rows = cached;
    if (args.excluded_only === true) {
      rows = rows.filter((c) => c.isExcluded === true);
    }

    // Sort by templateId then name. Categories with null templateId
    // (user-created, no system template) are pushed to the end via the
    // `￿` sentinel — system-template categories (Food, Rent, etc.) are
    // the primary grouping axis, with user-created categories as the long
    // tail. Empty arrays sort identically; this is intentional.
    rows = [...rows].sort((a, b) => {
      const t = (a.templateId ?? '￿').localeCompare(b.templateId ?? '￿');
      return t !== 0 ? t : a.name.localeCompare(b.name);
    });

    // Log after filter+sort so `rows` reflects what's returned to the caller,
    // not the raw cached count. Mirrors the LiveAccountsTools convention.
    this.live.logReadCall({
      op: 'Categories',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: rows.length,
      cache_hit: hit,
    });

    const includeHistory = args.include_history === true;
    // Default-strip budget.histories to keep response under the LLM token
    // budget (~25 KB). The cache still holds the full history — this is a
    // read-side projection only. Critical: shallow clone each row's budget
    // so we never mutate the cached references.
    const projected = includeHistory
      ? rows
      : rows.map((c) => (c.budget ? { ...c, budget: { ...c.budget, histories: [] } } : c));

    const fetchedAtIso = new Date(fetched_at).toISOString();
    return {
      count: projected.length,
      categories: projected,
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
      'Get user categories (live, GraphQL-backed). Includes per-category budget data so get_budgets_live can read from the same cache. ' +
      'Each row carries a `parentId` field: `null` for top-level categories (parents AND standalones), or the parent category id for children. ' +
      'To detect a parent specifically: build a Set of parent ids from the rows where `parentId !== null`. ' +
      'By default, `budget.histories[]` is stripped to keep the response small — pass `include_history: true` to receive the full multi-year history. ' +
      'Replaces get_categories when --live-reads is on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        excluded_only: {
          type: 'boolean',
          description: 'Return only categories marked as excluded. Default: false.',
          default: false,
        },
        include_history: {
          type: 'boolean',
          description:
            'Include per-category budget.histories array (multi-year monthly data). ' +
            'Default: false — stripped to keep response under the LLM tool-result ' +
            'token budget. Set to true for trend analysis or budget-history queries.',
          default: false,
        },
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
