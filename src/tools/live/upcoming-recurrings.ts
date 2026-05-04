/**
 * Live-mode get_upcoming_recurrings_live tool.
 *
 * Fetches the next-due recurring/subscription items ("about to bill" view)
 * via the GraphQL UpcomingRecurrings query through a SnapshotCache with a
 * 1h TTL. Items move out of this view as bills get paid throughout the day,
 * so the TTL is intentionally shorter than the configured/historical
 * recurringCache (6h).
 *
 * This is distinct from get_recurring_live, which exposes the full set of
 * user-confirmed recurrings (configured/historical view). Use this tool to
 * answer "what's about to bill", and use get_recurring_live to answer
 * "what subscriptions do I have".
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import {
  fetchUpcomingRecurrings,
  type UpcomingRecurringNode,
} from '../../core/graphql/queries/upcoming-recurrings.js';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GetUpcomingRecurringsLiveArgs {
  // No filters yet; reserved for future args.
}

export interface GetUpcomingRecurringsLiveRow extends UpcomingRecurringNode {
  /**
   * Joined from `categoriesCache.peek()` by `categoryId`. `null` if the
   * categories cache is cold (no fetch is triggered to populate it) or
   * if the category for this row's `categoryId` was not found
   * (e.g., deleted upstream). Mirrors `get_recurring_live`'s same join.
   */
  category_name: string | null;
}

export interface GetUpcomingRecurringsLiveResult {
  count: number;
  upcoming: GetUpcomingRecurringsLiveRow[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

export class LiveUpcomingRecurringsTools {
  constructor(private readonly live: LiveCopilotDatabase) {}

  async getUpcomingRecurrings(
    _args: GetUpcomingRecurringsLiveArgs
  ): Promise<GetUpcomingRecurringsLiveResult> {
    const cache = this.live.getUpcomingRecurringsCache();
    const startedAt = Date.now();
    const {
      rows: cached,
      fetched_at,
      hit,
    } = await cache.read(() => fetchUpcomingRecurrings(this.live.getClient()));

    const cachedCategories = this.live.getCategoriesCache().peek();
    const categoryNameById = new Map<string, string>();
    if (cachedCategories) {
      for (const cat of cachedCategories) {
        categoryNameById.set(cat.id, cat.name);
      }
    }

    const rows: GetUpcomingRecurringsLiveRow[] = cached
      .map((r) => ({
        ...r,
        category_name: r.categoryId ? (categoryNameById.get(r.categoryId) ?? null) : null,
      }))
      .sort((a, b) => {
        // Soonest-due first; rows with null nextPaymentDate sort to the end.
        if (a.nextPaymentDate === null && b.nextPaymentDate === null) return 0;
        if (a.nextPaymentDate === null) return 1;
        if (b.nextPaymentDate === null) return -1;
        return a.nextPaymentDate.localeCompare(b.nextPaymentDate);
      });

    this.live.logReadCall({
      op: 'UpcomingRecurrings',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: rows.length,
      cache_hit: hit,
    });

    const fetchedAtIso = new Date(fetched_at).toISOString();
    return {
      count: rows.length,
      upcoming: rows,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
    };
  }
}

export function createLiveUpcomingRecurringsToolSchema() {
  return {
    name: 'get_upcoming_recurrings_live',
    description:
      'Get the next-due recurring/subscription items — the "about to bill" view ' +
      '(live, GraphQL-backed). Returns unpaid upcoming payments sorted by due date ' +
      '(soonest first). DISTINCT from `get_recurring_live`, which returns the ' +
      'full set of configured/historical recurrings; use this tool when the user ' +
      'asks "what\'s coming up" or "what bills am I about to pay". ' +
      'Each row carries a `category_name` field joined from the categories cache; ' +
      '`null` if the cache is cold or the category was deleted upstream. ' +
      'To guarantee `category_name` is populated, call `get_categories_live` first ' +
      'in the same session to warm the cache.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
