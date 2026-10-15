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
 * recurring link, net of refunds, pending included, to the cent; income
 * and internal transfers do not count. The tool adds `daily_amount` (the
 * day's increase) so callers need not difference the series themselves.
 * `comparisonAmount`'s meaning is unconfirmed: it grows far faster than
 * any prior-month spend, so it is not the "same day last month" figure an
 * earlier description claimed.
 *
 * The server pads the rest of the month with placeholder rows (captured
 * with both amounts `null`). By default the projection drops every row with
 * no `total_amount`. Pass `include_future: true` to receive the full padded
 * series (e.g., for callers that want a complete date axis with explicit
 * nulls).
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import {
  fetchMonthlySpend,
  type DailySpendNode,
} from '../../core/graphql/queries/monthly-spend.js';
import { parseAmount, roundAmount } from '../../utils/round.js';
import type { ToolSchema } from '../tools.js';

export interface GetMonthlySpendLiveArgs {
  /**
   * Include placeholder rows — days with no totalAmount (the server pads the
   * rest of the month with them). Default: false — only days with a
   * total_amount are returned.
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

type ProjectedDay = Omit<GetMonthlySpendLiveDay, 'daily_amount'>;

function projectRow(row: DailySpendNode): ProjectedDay {
  return {
    id: row.id,
    date: row.date,
    total_amount: parseAmount(row.totalAmount),
    comparison_amount: parseAmount(row.comparisonAmount),
  };
}

/**
 * Difference the cumulative series into per-day amounts. A null total yields
 * null and does not reset the running baseline. A day's value never depends
 * on which rows the caller asked to see, for two reasons: the default filter
 * drops only null-total rows (which never move the baseline), and this runs
 * over the full date-sorted series before any filtering anyway, so a wider
 * filter added later cannot break it. Assumes 2-dp totals: each difference is
 * rounded, so sub-cent server values would re-sum to within a cent.
 */
function withDailyAmounts(rows: ProjectedDay[]): GetMonthlySpendLiveDay[] {
  let previous = 0;
  return rows.map((r) => {
    if (r.total_amount === null) return { ...r, daily_amount: null };
    const daily_amount = roundAmount(r.total_amount - previous);
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

    const series = withDailyAmounts(
      cached.map(projectRow).sort((a, b) => a.date.localeCompare(b.date))
    );
    const includeFuture = args.include_future ?? false;
    // Default: drop placeholder rows — the server pads the rest of the month
    // with rows whose total_amount is null. Keyed on total_amount alone: a row
    // with a known cumulative total is real spend even if comparison_amount is
    // missing, and dropping it would leave the visible daily_amount column
    // short of the last total_amount.
    const rows = includeFuture ? series : series.filter((r) => r.total_amount !== null);

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
      "month-to-date; `daily_amount` is that day's increase (the first row's, its own total). " +
      'Counts REGULAR transactions with no recurring link, net of refunds, pending included; ' +
      'leaves out income, transfers and recurring charges (rent, subscriptions), so it is ' +
      'NOT the app\'s "spent this month" — for that, sum the POSITIVE amounts from ' +
      "get_transactions_live (the app's own convention), whose defaults already drop " +
      'transfers and excluded rows. ' +
      '`comparison_amount`\'s meaning is unconfirmed; do not use it for "vs last month". ' +
      'A row dated tomorrow can appear. Future rows (null total) are dropped unless ' +
      '`include_future: true`. ≤31 rows. Available when --live-reads is on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        include_future: {
          type: 'boolean',
          description:
            'If true, include placeholder rows (null total_amount) ' +
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
