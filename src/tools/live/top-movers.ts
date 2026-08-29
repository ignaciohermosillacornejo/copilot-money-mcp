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
 * `price_points[].timestamp` is passed through as the server returns it.
 * Live-verified (#540 Task 4, live round-trip against a real session):
 * `timestamp` is epoch milliseconds.
 *
 * v3 (#597 Tier 1): `price_points` (measured at ~94.7% of the response on a
 * synthetic fixture — 20 movers x 50 price points each; see CHANGELOG) is
 * EXCLUDED by default via the shared field-selection engine
 * (DEFAULT_TOP_MOVER_FIELDS in src/tools/field-selection.ts). `change` is
 * already top-level and needs no derivation, so this is a straight
 * `projectRows` application — unlike get_investment_prices there is no "what
 * does this row mean without the series" problem to solve.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import { fetchTopMovers, type TopMoversFilter } from '../../core/graphql/queries/top-movers.js';
import {
  DEFAULT_TOP_MOVER_FIELDS,
  TOP_MOVER_FIELDS_PARAM_SCHEMA,
  projectRows,
} from '../field-selection.js';
import type { ToolSchema } from '../tools.js';

export const TOP_MOVERS_FILTERS = ['PRICE_CHANGE', 'MY_EQUITY_CHANGE'] as const;
const DEFAULT_FILTER: TopMoversFilter = 'MY_EQUITY_CHANGE';

export interface GetTopMoversLiveArgs {
  filter?: TopMoversFilter;
  fields?: string[];
}

export interface TopMoverPricePoint {
  /** Epoch milliseconds (live-verified, #540 Task 4). */
  timestamp: number;
  price: number;
}

// `type` (not `interface`) so it structurally satisfies projectRows' generic
// `T extends Record<string, unknown>` constraint — same reasoning as
// EnrichedTransaction in src/tools/live/transactions.ts.
export type GetTopMoversLiveEntry = {
  security_id: string;
  ticker_symbol: string;
  name: string;
  type: string;
  change: number;
  price_points: TopMoverPricePoint[];
};

/**
 * Every selectable field name on a top-mover row, derived from
 * {@link GetTopMoversLiveEntry} itself (not a sample row) via a mapped-type
 * record: the `[K in keyof ...]-?: true` shape forces this object literal to
 * carry exactly the interface's keys, so a forgotten or renamed field is a
 * compile error instead of a silent runtime desync. Without an explicit
 * knownFields set, projectRows falls back to row-key detection, which cannot
 * warn on a typo'd field name when the result set is empty (CHANGELOG.md
 * promises the same _field_warning behavior as get_transactions).
 */
const TOP_MOVER_FIELD_NAMES: { [K in keyof GetTopMoversLiveEntry]-?: true } = {
  security_id: true,
  ticker_symbol: true,
  name: true,
  type: true,
  change: true,
  price_points: true,
};
const TOP_MOVER_KNOWN_FIELDS: ReadonlySet<string> = new Set(Object.keys(TOP_MOVER_FIELD_NAMES));

/**
 * Built FROM the known-field set rather than hand-listed — see the identical
 * reasoning on CATEGORY_LIVE_VALID_FIELDS_HINT in src/tools/live/categories.ts.
 */
const TOP_MOVER_VALID_FIELDS_HINT = `the top-mover row fields (${[...TOP_MOVER_KNOWN_FIELDS].join(', ')})`;

export interface GetTopMoversLiveResult {
  count: number;
  filter: TopMoversFilter;
  movers: GetTopMoversLiveEntry[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
  // Requested `fields` names that matched nothing (typos), when any.
  _field_warning?: string;
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

    const mapped: GetTopMoversLiveEntry[] = cached.map((m) => ({
      security_id: m.security.id,
      ticker_symbol: m.security.symbol,
      name: m.security.name,
      type: m.security.type,
      change: m.change,
      price_points: m.values.map((v) => ({ timestamp: v.timestamp, price: v.price })),
    }));

    // v3: omitting `fields` yields the terse preset (no `price_points`), not
    // full rows. `change` is already top-level on `mapped` above, so unlike
    // get_investment_prices there is nothing to derive before projecting.
    const { rows: movers, warning } = projectRows(mapped, args.fields ?? ['default'], {
      preset: DEFAULT_TOP_MOVER_FIELDS,
      knownFields: TOP_MOVER_KNOWN_FIELDS,
      validFieldsHint: TOP_MOVER_VALID_FIELDS_HINT,
    });

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
      ...(warning && { _field_warning: warning }),
    };
  }
}

export function createLiveTopMoversToolSchema(): ToolSchema {
  return {
    name: 'get_top_movers_live',
    description:
      'Get the biggest movers across your investment holdings (live, GraphQL-backed). ' +
      'One row per security with an aggregate `change` (the ranked metric in the requested ' +
      "filter's units — dollars for MY_EQUITY_CHANGE, raw security price change for " +
      'PRICE_CHANGE). Default rows are terse (security_id, ticker_symbol, name, type, change) — ' +
      'the intraday `price_points` series (`{timestamp, price}`; `timestamp` is epoch ' +
      'milliseconds) is opt-in via `fields`. The `filter` selects the ranking basis: ' +
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
        fields: TOP_MOVER_FIELDS_PARAM_SCHEMA,
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
