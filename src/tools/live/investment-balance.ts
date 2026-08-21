/**
 * Live-mode get_investment_balance_live tool.
 *
 * Combines two GraphQL queries into one investments-only balance surface,
 * mirroring the web app's /investments page: the `InvestmentBalance`
 * timeseries (one row per day across all investment accounts, scoped by
 * `time_frame`) for the chart, and the `InvestmentLiveBalance` single
 * current-moment point for the "live dot". Distinct from get_networth_live
 * (whole net worth) and get_balance_history_live (per-account).
 *
 * Two SnapshotCaches back it: the history cache is `time_frame`-scoped
 * (invalidate-on-change, like get_networth_live); the live-balance cache holds
 * the single current point (no params). Both 1h TTL. The freshness envelope
 * reflects the older/newer of the two fetches, so
 * `_cache_oldest_fetched_at` may differ from `_cache_newest_fetched_at` here
 * (unlike the single-snapshot live tools). Assumes serial callers.
 *
 * v3 (#597 Tier 1): `history` can run to hundreds of daily rows and is the
 * dominant cost of a response, but unlike get_top_movers_live's
 * `price_points`, the series IS this tool's purpose — excluding it entirely
 * would be the "smaller by being useless" failure mode. So `history` is
 * CAPPED (`history_limit`, default 30, 0 = unlimited) rather than excluded,
 * and the response reports `history_total_count` / `history_truncated` so a
 * caller knows what was dropped. `current` (the live dot) is resolved from
 * the separate InvestmentLiveBalance query, never from `history`, so it
 * cannot be lost to truncation regardless of `history_limit`.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import {
  fetchInvestmentBalance,
  type InvestmentBalanceNode,
} from '../../core/graphql/queries/investment-balance.js';
import { fetchInvestmentLiveBalance } from '../../core/graphql/queries/investment-live-balance.js';
import { ALL_TIME_FRAMES, type TimeFrame } from '../../core/graphql/queries/_shared.js';
import { paginate, clampMaxRows } from '../../utils/pagination.js';
import type { ToolSchema } from '../tools.js';

const DEFAULT_TIME_FRAME: TimeFrame = 'YTD';

/**
 * Default cap on `history` points returned (#597 Tier 1). `0` means
 * unlimited — see {@link limitHistory}.
 */
const DEFAULT_HISTORY_LIMIT = 30;

export interface GetInvestmentBalanceLiveArgs {
  time_frame?: TimeFrame;
  history_limit?: number;
}

export interface InvestmentBalancePoint {
  /** ISO YYYY-MM-DD. */
  date: string;
  /** Combined investment-accounts balance (dollars). */
  balance: number;
}

export interface GetInvestmentBalanceLiveResult {
  /** Current-moment combined investment balance (the "live dot"), or null if unavailable. */
  current: InvestmentBalancePoint | null;
  /** Daily timeseries over the requested time_frame, ascending by date, capped by history_limit. */
  history: InvestmentBalancePoint[];
  /** Pre-truncation length of `history`. */
  history_total_count: number;
  /** True iff `history` is shorter than `history_total_count`. */
  history_truncated: boolean;
  time_frame: TimeFrame;
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

function toPoint(n: InvestmentBalanceNode): InvestmentBalancePoint {
  return { date: n.date, balance: n.balance };
}

/**
 * Cap an ascending-by-date series to its newest `limit` points.
 *
 * Thin adapter over the shared `paginate()`/`clampMaxRows()` pair
 * (src/utils/pagination.ts — "Uniform pagination + truncation shape for
 * time-series live tools", already used by balance-history.ts,
 * investment-prices.ts, networth.ts and holdings.ts for the identical
 * tail-of-ascending-series concept). Reusing it here instead of a local
 * clamp/slice avoids a second, independently-maintained truncation
 * algorithm for one concept (the `path-divergence` bug class).
 *
 * Only `0` is handled locally: it means unlimited (the full series,
 * untruncated) — a caller-facing convention from the #597 brief that
 * `clampMaxRows` has no equivalent for (it always clamps to >= `MIN_MAX_ROWS`
 * = 1, never "no limit"). Every other value — including `undefined`, which
 * falls back to {@link DEFAULT_HISTORY_LIMIT} — delegates entirely to
 * `clampMaxRows` (floor/clamp) and `paginate` (tail slice + total/truncated
 * reporting), remapping `paginate`'s `total_rows`/`truncated` to the brief's
 * external `history_total_count`/`history_truncated` names.
 */
function limitHistory(
  history: readonly InvestmentBalancePoint[],
  limit: number | undefined
): { history: InvestmentBalancePoint[]; total_count: number; truncated: boolean } {
  if (limit === 0) {
    return { history: [...history], total_count: history.length, truncated: false };
  }
  const max_rows = clampMaxRows(limit, { defaultValue: DEFAULT_HISTORY_LIMIT });
  const page = paginate(history, { max_rows });
  return { history: page.rows, total_count: page.total_rows, truncated: page.truncated };
}

export class LiveInvestmentBalanceTools {
  // Tracks the time_frame of the currently-cached history snapshot (see
  // get_networth_live for the serial-callers rationale). null until first read.
  private lastTimeFrame: TimeFrame | null = null;

  constructor(private readonly live: LiveCopilotDatabase) {}

  async getInvestmentBalance(
    args: GetInvestmentBalanceLiveArgs
  ): Promise<GetInvestmentBalanceLiveResult> {
    const timeFrame = args.time_frame ?? DEFAULT_TIME_FRAME;

    const historyCache = this.live.getInvestmentBalanceCache();
    if (this.lastTimeFrame !== null && this.lastTimeFrame !== timeFrame) {
      historyCache.invalidate();
    }
    this.lastTimeFrame = timeFrame;
    const liveCache = this.live.getInvestmentLiveBalanceCache();

    const startedAt = Date.now();
    const [historyRes, liveRes] = await Promise.all([
      historyCache.read(() => fetchInvestmentBalance(this.live.getClient(), { timeFrame })),
      // The live-balance query returns a single node; wrap it as a one-row
      // array so the SnapshotCache primitive (which stores T[]) applies uniformly.
      liveCache.read(() => fetchInvestmentLiveBalance(this.live.getClient()).then((n) => [n])),
    ]);

    const fullHistory = [...historyRes.rows]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(toPoint);
    // `current` is resolved from the separate InvestmentLiveBalance query,
    // never from `history` — so capping `history` below can never lose the
    // live dot, no matter what `history_limit` is.
    const currentNode = liveRes.rows[0];
    const current = currentNode ? toPoint(currentNode) : null;

    const {
      history,
      total_count: historyTotalCount,
      truncated: historyTruncated,
    } = limitHistory(fullHistory, args.history_limit);

    const hit = historyRes.hit && liveRes.hit;
    this.live.logReadCall({
      op: 'InvestmentBalance',
      pages: (historyRes.hit ? 0 : 1) + (liveRes.hit ? 0 : 1),
      latencyMs: Date.now() - startedAt,
      rows: history.length,
      cache_hit: hit,
    });

    const oldest = Math.min(historyRes.fetched_at, liveRes.fetched_at);
    const newest = Math.max(historyRes.fetched_at, liveRes.fetched_at);
    return {
      current,
      history,
      history_total_count: historyTotalCount,
      history_truncated: historyTruncated,
      time_frame: timeFrame,
      _cache_oldest_fetched_at: new Date(oldest).toISOString(),
      _cache_newest_fetched_at: new Date(newest).toISOString(),
      _cache_hit: hit,
    };
  }
}

export function createLiveInvestmentBalanceToolSchema(): ToolSchema {
  return {
    name: 'get_investment_balance_live',
    description:
      'Get your investments-only combined balance (live, GraphQL-backed): `current` (the ' +
      'current-moment combined investment-accounts balance — the "live dot") and `history` ' +
      '(a daily timeseries over the selected `time_frame`, ascending by date; each point is ' +
      '`{date, balance}` in dollars). Investments-only — distinct from get_networth_live ' +
      '(whole net worth) and get_balance_history_live (per-account). The history cache holds ' +
      'the most-recently-requested time_frame; requesting a different value refetches it. ' +
      '`history` is capped to the most recent `history_limit` points (default 30) — see that ' +
      'param to fetch more of the series. Available when --live-reads is on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        time_frame: {
          type: 'string',
          enum: [...ALL_TIME_FRAMES],
          description:
            "TimeFrame for the `history` timeseries. Default 'YTD'. Accepts the canonical " +
            'TimeFrame values ("ONE_DAY", "ONE_WEEK", "ONE_MONTH", "THREE_MONTHS", "YTD", ' +
            '"ONE_YEAR", "ALL").',
          default: DEFAULT_TIME_FRAME,
        },
        history_limit: {
          type: 'integer',
          description:
            'How many of the most recent history points to return. Default 30; the full series ' +
            'can run to hundreds of daily rows — measured at ~98% of the response on a 365-day ' +
            'series. Pass 0 for the full series. history_total_count and history_truncated ' +
            'always report what was dropped.',
          default: DEFAULT_HISTORY_LIMIT,
        },
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
