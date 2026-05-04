/**
 * Live-mode get_monthly_spend_live tool.
 *
 * Wraps the GraphQL `MonthlySpend` query — which, despite the name,
 * returns a DAILY series of {date, totalAmount, comparisonAmount, id}
 * rows for the current month/period. Backed by the SnapshotCache
 * <DailySpendNode> on LiveCopilotDatabase (1h TTL).
 *
 * `total_amount` is the day's actual spend; `comparison_amount` is the
 * same-day-of-prior-period spend (used by the web app for "vs last
 * month" comparisons).
 *
 * The response includes future-dated placeholder rows where both amount
 * fields are `null` (the server pads the full month). By default the
 * projection drops those rows. Pass `include_future: true` to receive
 * the full padded series (e.g., for callers that want a complete date
 * axis with explicit nulls).
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import {
  fetchMonthlySpend,
  type DailySpendNode,
} from '../../core/graphql/queries/monthly-spend.js';

export interface GetMonthlySpendLiveArgs {
  /**
   * Include future-dated placeholder rows (both totalAmount and
   * comparisonAmount are null). Default: false — only days with at
   * least one amount value are returned.
   */
  include_future?: boolean;
}

export interface GetMonthlySpendLiveDay {
  id: string;
  date: string;
  total_amount: number | null;
  comparison_amount: number | null;
}

export interface GetMonthlySpendLiveResult {
  count: number;
  daily_spending: GetMonthlySpendLiveDay[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

function parseAmount(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function projectRow(row: DailySpendNode): GetMonthlySpendLiveDay {
  return {
    id: row.id,
    date: row.date,
    total_amount: parseAmount(row.totalAmount),
    comparison_amount: parseAmount(row.comparisonAmount),
  };
}

export class LiveMonthlySpendTools {
  constructor(private readonly live: LiveCopilotDatabase) {}

  async getMonthlySpend(args: GetMonthlySpendLiveArgs): Promise<GetMonthlySpendLiveResult> {
    const cache = this.live.getMonthlySpendCache();
    const startedAt = Date.now();
    const {
      rows: cached,
      fetched_at,
      hit,
    } = await cache.read(() => fetchMonthlySpend(this.live.getClient()));

    const projected = cached.map(projectRow);
    const includeFuture = args.include_future ?? false;
    // Default: drop any row where either amount is null (placeholder rows
    // for future dates). The captured response always pairs both nulls
    // together, but treat a single null as a placeholder too — emitting
    // half-populated rows would be more confusing than dropping them.
    const filtered = includeFuture
      ? projected
      : projected.filter((r) => r.total_amount !== null && r.comparison_amount !== null);

    const rows = [...filtered].sort((a, b) => a.date.localeCompare(b.date));

    this.live.logReadCall({
      op: 'MonthlySpend',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: rows.length,
      cache_hit: hit,
    });

    const fetchedAtIso = new Date(fetched_at).toISOString();
    // Both `_cache_oldest_fetched_at` and `_cache_newest_fetched_at` reflect
    // the same single-snapshot fetch time — unlike the windowed transaction
    // cache where they can differ across month windows.
    return {
      count: rows.length,
      daily_spending: rows,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
    };
  }
}

export function createLiveMonthlySpendToolSchema() {
  return {
    name: 'get_monthly_spend_live',
    description:
      "Get the current month's daily spending series (live, GraphQL-backed). " +
      "Each row carries `total_amount` (this period's spend on `date`) and " +
      '`comparison_amount` (same-day-of-prior-period spend, used by the web app ' +
      'for "vs last month" deltas). Future-dated placeholder rows (where both ' +
      'amounts are null) are filtered out by default; pass `include_future: true` ' +
      'to opt in to the full padded series. Available when --live-reads is on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        include_future: {
          type: 'boolean',
          description:
            'If true, include future-dated placeholder rows (both amounts null) ' +
            'in the response. Default: false.',
          default: false,
        },
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
