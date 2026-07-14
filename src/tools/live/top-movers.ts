/**
 * Live-mode get_top_movers_live tool.
 *
 * Wraps the GraphQL `TopMovers` query — the biggest movers across the user's
 * holdings, one row per security with a recent price series and an aggregate
 * `change`. Backed by SnapshotCache<TopMoverNode> on LiveCopilotDatabase (1h
 * TTL — the movers ranking shifts intraday, faster than holdings/allocation).
 *
 * `filter` selects the ranking basis:
 *   - MY_EQUITY_CHANGE (default): dollar impact on the user's position
 *     (price change weighted by held quantity).
 *   - PRICE_CHANGE: raw security price change.
 * The web app fires both on /investments load; a tool caller picks one per
 * call. The single-snapshot cache holds the most-recently-requested filter;
 * a different filter invalidates and refetches (same pattern as
 * get_networth_live's time_frame). Assumes serial callers.
 *
 * `price_points[].timestamp` is passed through as the server returns it. The
 * unit (epoch seconds vs milliseconds) is not yet disambiguated — treat it as
 * an ordered plotting key. #540's Task 4 pins the unit down against a live
 * response and records it in the tool description.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import { fetchTopMovers, type TopMoversFilter } from '../../core/graphql/queries/top-movers.js';
import type { ToolSchema } from '../tools.js';

export const TOP_MOVERS_FILTERS = ['PRICE_CHANGE', 'MY_EQUITY_CHANGE'] as const;
const DEFAULT_FILTER: TopMoversFilter = 'MY_EQUITY_CHANGE';

export interface GetTopMoversLiveArgs {
  filter?: TopMoversFilter;
}

export interface TopMoverPricePoint {
  timestamp: number;
  price: number;
}

export interface GetTopMoversLiveEntry {
  security_id: string;
  ticker_symbol: string;
  name: string;
  type: string;
  change: number;
  price_points: TopMoverPricePoint[];
}

export interface GetTopMoversLiveResult {
  count: number;
  filter: TopMoversFilter;
  movers: GetTopMoversLiveEntry[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

export class LiveTopMoversTools {
  // Tracks the filter of the currently-cached snapshot (see get_networth_live
  // for the serial-callers rationale). null until the first read.
  private lastFilter: TopMoversFilter | null = null;

  constructor(private readonly live: LiveCopilotDatabase) {}

  async getTopMovers(args: GetTopMoversLiveArgs): Promise<GetTopMoversLiveResult> {
    const filter = args.filter ?? DEFAULT_FILTER;
    const cache = this.live.getTopMoversCache();
    if (this.lastFilter !== null && this.lastFilter !== filter) {
      cache.invalidate();
    }
    this.lastFilter = filter;

    const startedAt = Date.now();
    const {
      rows: cached,
      fetched_at,
      hit,
    } = await cache.read(() => fetchTopMovers(this.live.getClient(), { filter }));

    const movers: GetTopMoversLiveEntry[] = cached.map((m) => ({
      security_id: m.security.id,
      ticker_symbol: m.security.symbol,
      name: m.security.name,
      type: m.security.type,
      change: m.change,
      price_points: m.values.map((v) => ({ timestamp: v.timestamp, price: v.price })),
    }));

    this.live.logReadCall({
      op: 'TopMovers',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: movers.length,
      cache_hit: hit,
    });

    const fetchedAtIso = new Date(fetched_at).toISOString();
    return {
      count: movers.length,
      filter,
      movers,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
    };
  }
}

export function createLiveTopMoversToolSchema(): ToolSchema {
  return {
    name: 'get_top_movers_live',
    description:
      'Get the biggest movers across your investment holdings (live, GraphQL-backed). ' +
      'One row per security with an aggregate `change` and a recent price series ' +
      '(`price_points`: `{timestamp, price}`; the `timestamp` unit — epoch seconds vs ' +
      'milliseconds — is not yet verified, so treat it as an ordered plotting key). The ' +
      '`filter` selects the ranking basis: ' +
      '"MY_EQUITY_CHANGE" (default — dollar impact on your position, price change weighted ' +
      'by held quantity) or "PRICE_CHANGE" (raw security price change). The cache holds the ' +
      'most-recently-requested filter; requesting the other triggers a fresh fetch. ' +
      'Available when --live-reads is on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filter: {
          type: 'string',
          enum: [...TOP_MOVERS_FILTERS],
          description:
            'Ranking basis. "MY_EQUITY_CHANGE" (default) ranks by the dollar impact on your ' +
            'position; "PRICE_CHANGE" ranks by raw security price change.',
          default: DEFAULT_FILTER,
        },
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
