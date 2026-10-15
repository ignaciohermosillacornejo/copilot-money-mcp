/**
 * Live-mode get_monthly_spend_live tool.
 *
 * Wraps the GraphQL `MonthlySpend` query — which, despite the name,
 * returns a DAILY series of {date, totalAmount, comparisonAmount, id}
 * rows for the current month/period. Backed by the SnapshotCache
 * <DailySpendNode> on LiveCopilotDatabase (1h TTL).
 *
 * `totalAmount` is CUMULATIVE month-to-date, not a per-day figure, and it
 * is NOT the app's "spent this month": it leaves out every transaction
 * linked to a recurring (rent, subscriptions). Measured 2026-10-15 (#823):
 * each day's increase equals that day's REGULAR transactions with no
 * recurring link, net of refunds, pending included, to the cent (income
 * and internal transfers do not count). The tool
 * adds `daily_amount` (the day's increase) so callers need not difference
 * the series themselves. `comparisonAmount`'s meaning is unconfirmed — it
 * grows far faster than any prior-month spend, so it is not the
 * "same day last month" figure an earlier description claimed.
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
import { parseAmount } from '../../utils/round.js';
import type { ToolSchema } from '../tools.js';

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
  /** The day's increase in `total_amount` (the first row's is its own total). */
  daily_amount: number | null;
  comparison_amount: number | null;
}

export interface GetMonthlySpendLiveResult {
  count: number;
  daily_spending: GetMonthlySpendLiveDay[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

function projectRow(row: DailySpendNode): Omit<GetMonthlySpendLiveDay, 'daily_amount'> {
  return {
    id: row.id,
    date: row.date,
    total_amount: parseAmount(row.totalAmount),
    comparison_amount: parseAmount(row.comparisonAmount),
  };
}

/**
 * Difference the cumulative series into per-day amounts. Runs over the
 * date-sorted rows; a null total (future placeholder) yields null and does
 * not reset the running baseline.
 */
function withDailyAmounts(
  rows: Array<Omit<GetMonthlySpendLiveDay, 'daily_amount'>>
): GetMonthlySpendLiveDay[] {
  let previous = 0;
  return rows.map((r) => {
    if (r.total_amount === null) return { ...r, daily_amount: null };
    const daily_amount = Math.round((r.total_amount - previous) * 100) / 100;
    previous = r.total_amount;
    return { ...r, daily_amount };
  });
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

    const rows = withDailyAmounts([...filtered].sort((a, b) => a.date.localeCompare(b.date)));

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

export function createLiveMonthlySpendToolSchema(): ToolSchema {
  return {
    name: 'get_monthly_spend_live',
    description:
      "Current month's NON-RECURRING spend, day by day (live). `total_amount` is CUMULATIVE " +
      "month-to-date; `daily_amount` is that day's increase. Counts REGULAR transactions " +
      'with no recurring link, net of refunds, pending included; leaves out income, transfers ' +
      'and recurring charges (rent, subscriptions), so it is NOT the app\'s "spent this ' +
      'month" — for that, sum `amount` from get_transactions_live. `comparison_amount`\'s ' +
      'meaning is unconfirmed: not last month\'s spend, do not use it for "vs last month". ' +
      'Dated in UTC; may include a row for tomorrow. Future rows (null amounts) are dropped ' +
      'unless `include_future: true`. ≤31 rows, no pagination.',
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
