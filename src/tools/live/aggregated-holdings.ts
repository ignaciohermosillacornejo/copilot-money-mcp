/**
 * Live-mode get_aggregated_holdings_live tool.
 *
 * Wraps the GraphQL `AggregatedHoldings` query — one row per security with the
 * current market `value` of the position (quantity-weighted) and the `change`
 * (how much that value moved over the selected `time_frame`). Collapses
 * per-account rows into per-security totals — distinct from get_holdings_live
 * (per (account, security) with cost basis). Backed by
 * SnapshotCache<AggregatedHoldingNode> (6h TTL — positions move slowly,
 * matching the holdings cache).
 *
 * `time_frame` (scopes `change`) and the optional `account_id`/`item_id` scope
 * are all server-side. The single-snapshot cache holds the most-recently-
 * requested (time_frame, scope) combination; a different combination
 * invalidates and refetches (same pattern as get_networth_live's time_frame).
 * Assumes serial callers.
 *
 * The captured query's `security` block omits `currentPrice` (the aggregated
 * row carries `value` instead); the wrapper models this via
 * AggregatedSecurityNode — do not reach for currentPrice.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import { fetchAggregatedHoldings } from '../../core/graphql/queries/aggregated-holdings.js';
import { ALL_TIME_FRAMES, type TimeFrame } from '../../core/graphql/queries/_shared.js';
import type { ToolSchema } from '../tools.js';

const DEFAULT_TIME_FRAME: TimeFrame = 'ONE_MONTH';

export interface GetAggregatedHoldingsLiveArgs {
  time_frame?: string;
  account_id?: string;
  item_id?: string;
}

export interface GetAggregatedHoldingsLiveEntry {
  security_id: string;
  ticker_symbol: string;
  name: string;
  type: string;
  /** Current market value of the position (dollars). */
  value: number;
  /** Change in `value` over the selected time_frame (dollars). */
  change: number;
}

export interface GetAggregatedHoldingsLiveResult {
  count: number;
  time_frame: string;
  holdings: GetAggregatedHoldingsLiveEntry[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

export class LiveAggregatedHoldingsTools {
  // Tracks the (time_frame|account|item) key of the currently-cached snapshot
  // (see get_networth_live for the serial-callers rationale). null until first read.
  private lastKey: string | null = null;

  constructor(private readonly live: LiveCopilotDatabase) {}

  async getAggregatedHoldings(
    args: GetAggregatedHoldingsLiveArgs
  ): Promise<GetAggregatedHoldingsLiveResult> {
    const timeFrame = (args.time_frame ?? DEFAULT_TIME_FRAME) as TimeFrame;
    const accountId = args.account_id;
    const itemId = args.item_id;
    const key = `${timeFrame}|${accountId ?? ''}|${itemId ?? ''}`;

    const cache = this.live.getAggregatedHoldingsCache();
    if (this.lastKey !== null && this.lastKey !== key) {
      cache.invalidate();
    }
    this.lastKey = key;

    const startedAt = Date.now();
    const {
      rows: cached,
      fetched_at,
      hit,
    } = await cache.read(() =>
      fetchAggregatedHoldings(this.live.getClient(), { timeFrame, accountId, itemId })
    );

    const holdings: GetAggregatedHoldingsLiveEntry[] = cached.map((h) => ({
      security_id: h.security.id,
      ticker_symbol: h.security.symbol,
      name: h.security.name,
      type: h.security.type,
      value: h.value,
      change: h.change,
    }));

    this.live.logReadCall({
      op: 'AggregatedHoldings',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: holdings.length,
      cache_hit: hit,
    });

    const fetchedAtIso = new Date(fetched_at).toISOString();
    return {
      count: holdings.length,
      time_frame: timeFrame,
      holdings,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
    };
  }
}

export function createLiveAggregatedHoldingsToolSchema(): ToolSchema {
  return {
    name: 'get_aggregated_holdings_live',
    description:
      'Get per-security aggregated holdings (live, GraphQL-backed). One row per security, ' +
      'collapsing all your accounts: `value` (current market value of the position, in dollars) ' +
      'and `change` (how much that value moved over the selected `time_frame`, in dollars). ' +
      'Distinct from get_holdings_live, which is per (account, security) with cost basis. ' +
      'Optional `account_id` / `item_id` scope the aggregation to a single account (server-side). ' +
      'Available when --live-reads is on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        time_frame: {
          type: 'string',
          enum: [...ALL_TIME_FRAMES],
          description:
            "TimeFrame the `change` is measured over. Default 'ONE_MONTH'. Accepts the canonical " +
            'TimeFrame values ("ONE_DAY", "ONE_WEEK", "ONE_MONTH", "THREE_MONTHS", "YTD", ' +
            '"ONE_YEAR", "ALL").',
          default: DEFAULT_TIME_FRAME,
        },
        account_id: {
          type: 'string',
          description: 'Scope the aggregation to this account id (server-side filter).',
        },
        item_id: {
          type: 'string',
          description: 'Scope the aggregation to this Plaid item id (server-side filter).',
        },
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
