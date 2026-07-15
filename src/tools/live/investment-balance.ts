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
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import {
  fetchInvestmentBalance,
  type InvestmentBalanceNode,
} from '../../core/graphql/queries/investment-balance.js';
import { fetchInvestmentLiveBalance } from '../../core/graphql/queries/investment-live-balance.js';
import { ALL_TIME_FRAMES, type TimeFrame } from '../../core/graphql/queries/_shared.js';
import type { ToolSchema } from '../tools.js';

const DEFAULT_TIME_FRAME: TimeFrame = 'YTD';

export interface GetInvestmentBalanceLiveArgs {
  time_frame?: TimeFrame;
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
  /** Daily timeseries over the requested time_frame, ascending by date. */
  history: InvestmentBalancePoint[];
  time_frame: TimeFrame;
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

function toPoint(n: InvestmentBalanceNode): InvestmentBalancePoint {
  return { date: n.date, balance: n.balance };
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

    const history = [...historyRes.rows].sort((a, b) => a.date.localeCompare(b.date)).map(toPoint);
    const currentNode = liveRes.rows[0];
    const current = currentNode ? toPoint(currentNode) : null;

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
      'Available when --live-reads is on.',
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
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
