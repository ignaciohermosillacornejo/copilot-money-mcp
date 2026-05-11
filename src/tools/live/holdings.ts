/**
 * Live-mode get_holdings_live tool.
 *
 * Wraps the GraphQL `Holdings` query, projecting each row onto the same
 * field shape as cache-mode `get_holdings` so agents trained on one work
 * with the other. Backed by the SnapshotCache<HoldingNode> on
 * LiveCopilotDatabase (6h TTL — positions move slowly, intraday price
 * drift inside `currentPrice` does not need second-by-second freshness).
 *
 * Projection rules:
 *   - `institution_value` is derived as `quantity * security.currentPrice`
 *     (rounded to 2dp via `roundAmount`).
 *   - `cost_basis`, `average_cost`, `total_return`, `total_return_percent`
 *     come from `holding.metrics`. When `metrics` is `null` (most commonly
 *     CASH sleeves inside investment accounts), all four are omitted from
 *     the output rather than emitted as `null` — `is_cash_equivalent` on
 *     the same row tells the caller why.
 *   - `total_return_percent = (totalReturn / costBasis) * 100`. Guards
 *     against `costBasis === 0` (would produce Infinity/NaN) by omitting
 *     the field in that case.
 *   - `is_cash_equivalent` is derived from `security.type === 'CASH'`,
 *     NOT from the absence of metrics. Non-cash positions may also lack
 *     metrics (rare, but possible for newly-imported securities).
 *   - `iso_currency_code` is in cache-mode output but NOT in the GraphQL
 *     Security shape, so it is intentionally omitted here.
 *
 * No `include_history` parameter — monthly snapshots are not available on
 * the GraphQL `Holdings` query. Callers needing history should use the
 * cache-mode `get_holdings` tool with `include_history: true`.
 *
 * Server order is preserved (no client-side sort).
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import { fetchHoldings, type HoldingNode } from '../../core/graphql/queries/holdings.js';
import { roundAmount } from '../../utils/round.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10_000;
const MIN_LIMIT = 1;

export interface GetHoldingsLiveArgs {
  /** Filter — exact match on `holding.accountId`. */
  account_id?: string;
  /** Filter — case-insensitive match on `security.symbol`. */
  ticker_symbol?: string;
  /** Default 100; clamped to [1, 10000]. */
  limit?: number;
  /** Default 0; clamped to >= 0. */
  offset?: number;
}

export interface GetHoldingsLiveEntry {
  security_id: string;
  ticker_symbol: string;
  name: string;
  type: string;
  account_id: string;
  item_id: string;
  quantity: number;
  institution_price: number;
  institution_value: number;
  cost_basis?: number;
  average_cost?: number;
  total_return?: number;
  total_return_percent?: number;
  is_cash_equivalent: boolean;
}

export interface GetHoldingsLiveResult {
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  holdings: GetHoldingsLiveEntry[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  return Math.max(0, Math.floor(offset));
}

function projectHolding(h: HoldingNode): GetHoldingsLiveEntry {
  const institutionValue = roundAmount(h.quantity * h.security.currentPrice);
  const entry: GetHoldingsLiveEntry = {
    security_id: h.security.id,
    ticker_symbol: h.security.symbol,
    name: h.security.name,
    type: h.security.type,
    account_id: h.accountId,
    item_id: h.itemId,
    quantity: h.quantity,
    institution_price: h.security.currentPrice,
    institution_value: institutionValue,
    is_cash_equivalent: h.security.type === 'CASH',
  };

  if (h.metrics) {
    entry.cost_basis = roundAmount(h.metrics.costBasis);
    entry.average_cost = roundAmount(h.metrics.averageCost);
    entry.total_return = roundAmount(h.metrics.totalReturn);
    // Divide-by-zero guard: costBasis === 0 would yield Infinity (positive
    // return) or NaN (zero/zero) — neither is meaningful as a percentage.
    // Omit the field instead so callers can detect "unavailable" cleanly.
    //
    // Denominator is `Math.abs(costBasis)` so a negative basis (short
    // positions, margin accounts) preserves the sign of `totalReturn`:
    // a short that goes against you (totalReturn < 0 with costBasis < 0)
    // should report a negative percentage, not flip to positive via
    // negative ÷ negative cancellation.
    if (h.metrics.costBasis !== 0) {
      entry.total_return_percent = roundAmount(
        (h.metrics.totalReturn / Math.abs(h.metrics.costBasis)) * 100
      );
    }
  }

  return entry;
}

export class LiveHoldingsTools {
  constructor(private readonly live: LiveCopilotDatabase) {}

  async getHoldings(args: GetHoldingsLiveArgs): Promise<GetHoldingsLiveResult> {
    const cache = this.live.getHoldingsCache();
    const startedAt = Date.now();
    const {
      rows: cached,
      fetched_at,
      hit,
    } = await cache.read(() => fetchHoldings(this.live.getClient()));

    const limit = clampLimit(args.limit);
    const offset = clampOffset(args.offset);
    const tickerLower = args.ticker_symbol?.toLowerCase();

    // Filter on the raw GraphQL rows before projection — cheaper than
    // projecting then filtering, and the filter predicates only need
    // fields already present on HoldingNode.
    const filtered = cached.filter((h) => {
      if (args.account_id && h.accountId !== args.account_id) return false;
      if (tickerLower && h.security.symbol.toLowerCase() !== tickerLower) return false;
      return true;
    });

    const totalCount = filtered.length;
    const hasMore = offset + limit < totalCount;
    const paged = filtered.slice(offset, offset + limit).map(projectHolding);

    this.live.logReadCall({
      op: 'Holdings',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: paged.length,
      cache_hit: hit,
    });

    const fetchedAtIso = new Date(fetched_at).toISOString();
    // Both `_cache_oldest_fetched_at` and `_cache_newest_fetched_at` reflect
    // the same single-snapshot fetch time — unlike the windowed transaction
    // cache where they can differ across month windows.
    return {
      count: paged.length,
      total_count: totalCount,
      offset,
      has_more: hasMore,
      holdings: paged,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
    };
  }
}

export function createLiveHoldingsToolSchema() {
  return {
    name: 'get_holdings_live',
    description:
      'Get investment positions with cost-basis metrics (live, GraphQL-backed). ' +
      'One row per (account, security). For CASH sleeves and other positions ' +
      'where the server returns no cost-basis metrics, the four derived fields ' +
      '(cost_basis, average_cost, total_return, total_return_percent) are ' +
      'omitted from the row; check `is_cash_equivalent` (derived from ' +
      "`security.type === 'CASH'`) to distinguish. For monthly snapshots, " +
      'use cache-mode `get_holdings` with `include_history: true` — history ' +
      'is not available on the live query. Available when --live-reads is on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account_id: {
          type: 'string',
          description: "Filter — exact match on the holding's accountId.",
        },
        ticker_symbol: {
          type: 'string',
          description: "Filter — case-insensitive match on the security's ticker symbol.",
        },
        limit: {
          type: 'number',
          description: `Max rows to return. Default ${DEFAULT_LIMIT}, clamped to [${MIN_LIMIT}, ${MAX_LIMIT}].`,
          default: DEFAULT_LIMIT,
        },
        offset: {
          type: 'number',
          description: 'Pagination offset (>= 0). Default 0.',
          default: 0,
        },
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
