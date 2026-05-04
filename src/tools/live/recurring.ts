/**
 * Live-mode get_recurring_live tool.
 *
 * Fetches user-confirmed recurring/subscription items via GraphQL through
 * the SnapshotCache<RecurringNode> exposed by LiveCopilotDatabase (6h TTL).
 *
 * NOTE: This is a strict subset of the cache-mode get_recurring_transactions
 * tool. The cache-mode tool combines (1) pattern-based detection from
 * transactions and (2) user-confirmed Copilot subscriptions. The GraphQL
 * Recurrings query exposes only (2). Pattern-based detection is not
 * available in --live-reads mode; users who need it should run without
 * --live-reads or use get_transactions_live + their own grouping.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import { fetchRecurrings, type RecurringNode } from '../../core/graphql/queries/recurrings.js';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GetRecurringLiveArgs {
  // No filters yet; reserved for future args (e.g., state filter).
}

export interface GetRecurringLiveRow extends RecurringNode {
  /**
   * Joined from `categoriesCache.peek()` by `categoryId`. `null` if the
   * categories cache is cold (no fetch is triggered to populate it) or
   * if the category for this recurring's `categoryId` was not found
   * (e.g., deleted upstream). Mirrors `get_transactions_live`'s same join.
   */
  category_name: string | null;
}

export interface GetRecurringLiveResult {
  count: number;
  recurring: GetRecurringLiveRow[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

export class LiveRecurringTools {
  constructor(private readonly live: LiveCopilotDatabase) {}

  async getRecurring(_args: GetRecurringLiveArgs): Promise<GetRecurringLiveResult> {
    const cache = this.live.getRecurringCache();
    const startedAt = Date.now();
    const {
      rows: cached,
      fetched_at,
      hit,
    } = await cache.read(() => fetchRecurrings(this.live.getClient()));

    const cachedCategories = this.live.getCategoriesCache().peek();
    const categoryNameById = new Map<string, string>();
    if (cachedCategories) {
      for (const cat of cachedCategories) {
        categoryNameById.set(cat.id, cat.name);
      }
    }

    const rows: GetRecurringLiveRow[] = cached
      .map((r) => ({
        ...r,
        category_name: r.categoryId ? (categoryNameById.get(r.categoryId) ?? null) : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    this.live.logReadCall({
      op: 'Recurrings',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: rows.length,
      cache_hit: hit,
    });

    const fetchedAtIso = new Date(fetched_at).toISOString();
    return {
      count: rows.length,
      recurring: rows,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
    };
  }
}

export function createLiveRecurringToolSchema() {
  return {
    name: 'get_recurring_live',
    description:
      'Get user-confirmed recurring/subscription items (live, GraphQL-backed). ' +
      'Replaces get_recurring_transactions when --live-reads is on. ' +
      "NOTE: pattern-based detection from transactions is NOT included — only Copilot's " +
      'native subscription tracking. Run without --live-reads if you need pattern detection. ' +
      'Each row carries a `category_name` field joined from the categories cache; ' +
      '`null` if the cache is cold or the category was deleted upstream.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
