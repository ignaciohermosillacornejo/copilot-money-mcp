/**
 * Live-mode get_investment_prices_live tool.
 *
 * Wraps the GraphQL `SecurityPrices` (daily) and `SecurityPricesHighFrequency`
 * (intraday) queries behind a single MCP tool that auto-routes based on the
 * caller's `time_frame`. The Copilot web app uses the two queries to back
 * different time-range buttons (1D / 1W → intraday; 1M / 3M / YTD / 1Y / ALL
 * → daily), and we mirror that split server-side so agents don't have to
 * know about it.
 *
 * Routing rules
 * -------------
 *   - `ONE_DAY`, `ONE_WEEK` → SecurityPricesHighFrequency (intraday). The
 *     row shape is `{ id, price, timestamp }` where `timestamp` is an opaque
 *     numeric (treated as epoch ms based on the captured payload).
 *   - All other values (`ONE_MONTH`, `THREE_MONTHS`, `YTD`, `ONE_YEAR`,
 *     `ALL`) → SecurityPrices (daily closes). The row shape is
 *     `{ id, price, date }` where `date` is `YYYY-MM-DD`.
 *   - Omitted `time_frame` defaults to `ONE_MONTH` — the most common
 *     "show me the recent trend" use case and the safer default for a
 *     daily-granularity payload size.
 *
 * The output carries a `granularity` discriminator (`'daily' | 'intraday'`)
 * so callers can branch on the right field (`date` vs `timestamp`). Each row
 * carries EXACTLY ONE of `date` or `timestamp` — never both — matching the
 * server payload's shape.
 *
 * Authorization caveat (documented from empirical testing)
 * --------------------------------------------------------
 * Both queries are ownership-gated server-side: the server returns a
 * GraphQL error with message "No holdings found for this security" for any
 * security the user does not currently hold. The tool detects that error
 * message and re-throws with a clean, security_id-bearing message so agents
 * can react gracefully instead of seeing the raw GraphQL error.
 *
 * Cache strategy
 * --------------
 * Two maps with different TTLs:
 *   - `intradayCache` — 5 minutes. Intraday prices change throughout the
 *     trading day, so a short TTL keeps the cache useful for repeated
 *     within-minute requests without staling.
 *   - `dailyCache` — 1 hour. Daily closes only update once per day at
 *     market close, so a long TTL is safe; cache invalidation at market
 *     close is the user's responsibility (refresh_cache --scope
 *     investment_prices).
 *
 * Cache key for both maps is composed via `makeTupleKey(security_id,
 * time_frame)` — see `src/utils/cache-key.ts` for the null-byte
 * separator + omitted-arg sentinel rationale.
 *
 * The cache lives on this class (not `LiveCopilotDatabase`) because the
 * keying is per-request and tightly coupled to the tool's call shape, the
 * same as balance-history. `refresh_cache --scope investment_prices` clears
 * both maps.
 *
 * Sort
 * ----
 * Server returns rows ascending (verified by the smoke test); we apply a
 * defensive ascending sort by `date` for daily and by `timestamp` for
 * intraday so any future server-side reordering doesn't silently change
 * output order.
 *
 * Truncation
 * ----------
 * `max_rows` caps the response (default 500, clamped to [1, 5000]). When
 * the server returns more than `max_rows`, we slice to the most-recent
 * `max_rows` rows (the tail of the ascending series) and set
 * `truncated: true`. `total_rows` exposes the pre-truncation count so the
 * caller knows what was dropped.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import {
  fetchSecurityPrices,
  type SecurityPricePointNode,
} from '../../core/graphql/queries/security-prices.js';
import {
  fetchSecurityPricesHighFrequency,
  type HighFrequencyPricePointNode,
} from '../../core/graphql/queries/security-prices-high-frequency.js';
import { ALL_TIME_FRAMES, type TimeFrame } from '../../core/graphql/queries/_shared.js';
import { GraphQLError } from '../../core/graphql/client.js';
import { paginate, DEFAULT_MAX_ROWS } from '../../utils/pagination.js';
import { FIVE_MIN_MS, ONE_HOUR_MS } from '../../utils/durations.js';
import { makeTupleKey } from '../../utils/cache-key.js';
import type { ToolSchema } from '../tools.js';

const DEFAULT_TIME_FRAME: TimeFrame = 'ONE_MONTH';

/**
 * Time frames that route to the high-frequency (intraday) query. Anything
 * not in this set routes to the daily SecurityPrices query.
 */
const INTRADAY_TIME_FRAMES = new Set<TimeFrame>(['ONE_DAY', 'ONE_WEEK']);

export type PriceGranularity = 'daily' | 'intraday';

export interface GetInvestmentPricesLiveArgs {
  security_id: string;
  time_frame?: TimeFrame;
  /**
   * Cap on the number of rows returned. Clamped to [1, 5000]; default 500.
   * Slices the most-recent rows of the ascending series.
   */
  max_rows?: number;
  /**
   * Number of rows to skip from the most-recent end. Clamped to >= 0;
   * default 0. Set to `max_rows` to fetch the next-most-recent batch.
   */
  offset?: number;
}

export interface GetInvestmentPricesLiveEntry {
  price: number;
  /** Present only when granularity === 'daily'. */
  date?: string;
  /** Present only when granularity === 'intraday'. */
  timestamp?: number;
}

export interface GetInvestmentPricesLiveResult {
  granularity: PriceGranularity;
  count: number;
  total_rows: number;
  truncated: boolean;
  prices: GetInvestmentPricesLiveEntry[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

interface DailyCacheEntry {
  rows: SecurityPricePointNode[];
  fetched_at: number;
}

interface IntradayCacheEntry {
  rows: HighFrequencyPricePointNode[];
  fetched_at: number;
}

function isIntraday(timeFrame: TimeFrame): boolean {
  return INTRADAY_TIME_FRAMES.has(timeFrame);
}

/**
 * Translate the ownership-gated server error into a clean, security_id-
 * bearing message. The GraphQL client classifies the server's error as
 * `USER_ACTION_REQUIRED` (any errors[] in the response body falls into that
 * bucket); we look at the message text since the server doesn't carry a
 * structured error code.
 */
function translateNotFound(err: unknown, securityId: string): never {
  if (
    err instanceof GraphQLError &&
    err.code === 'USER_ACTION_REQUIRED' &&
    /no holdings found/i.test(err.message)
  ) {
    throw new Error(
      `Price history for security ${securityId} is not available — the security is not currently in your linked accounts.`
    );
  }
  throw err;
}

export class LiveInvestmentPricesTools {
  /**
   * Intraday-only cache (1D / 1W). 5-minute TTL.
   */
  private readonly intradayCache = new Map<string, IntradayCacheEntry>();
  /**
   * Daily-only cache (1M / 3M / YTD / 1Y / ALL). 1-hour TTL.
   */
  private readonly dailyCache = new Map<string, DailyCacheEntry>();
  private readonly intradayTtlMs: number;
  private readonly dailyTtlMs: number;

  constructor(
    private readonly live: LiveCopilotDatabase,
    opts: { intradayTtlMs?: number; dailyTtlMs?: number } = {}
  ) {
    this.intradayTtlMs = opts.intradayTtlMs ?? FIVE_MIN_MS;
    this.dailyTtlMs = opts.dailyTtlMs ?? ONE_HOUR_MS;
  }

  /** Public for refresh_cache. Drops every cached entry across both maps. */
  clearCache(): void {
    this.intradayCache.clear();
    this.dailyCache.clear();
  }

  private async fetchIntraday(
    securityId: string,
    timeFrame: TimeFrame
  ): Promise<HighFrequencyPricePointNode[]> {
    try {
      return await fetchSecurityPricesHighFrequency(this.live.getClient(), {
        id: securityId,
        timeFrame,
      });
    } catch (err) {
      translateNotFound(err, securityId);
    }
  }

  private async fetchDaily(
    securityId: string,
    timeFrame: TimeFrame
  ): Promise<SecurityPricePointNode[]> {
    try {
      return await fetchSecurityPrices(this.live.getClient(), {
        id: securityId,
        timeFrame,
      });
    } catch (err) {
      translateNotFound(err, securityId);
    }
  }

  async getInvestmentPrices(
    args: GetInvestmentPricesLiveArgs
  ): Promise<GetInvestmentPricesLiveResult> {
    if (!args.security_id) {
      throw new Error("get_investment_prices_live: 'security_id' is required.");
    }

    const timeFrame: TimeFrame = args.time_frame ?? DEFAULT_TIME_FRAME;
    const intraday = isIntraday(timeFrame);
    const key = makeTupleKey(args.security_id, args.time_frame);
    const startedAt = Date.now();

    let granularity: PriceGranularity;
    let projected: GetInvestmentPricesLiveEntry[];
    let totalRows: number;
    let truncated: boolean;
    let fetchedAt: number;
    let hit = false;

    if (intraday) {
      granularity = 'intraday';
      let entry = this.intradayCache.get(key);
      if (entry !== undefined && startedAt - entry.fetched_at < this.intradayTtlMs) {
        hit = true;
      } else {
        // Translate the ownership-gated error AFTER the fetch resolves —
        // transport-level retry lives inside GraphQLClient (issue #443), so
        // the typed GraphQLError reaches translateNotFound untouched.
        const rows = await this.fetchIntraday(args.security_id, timeFrame);
        entry = { rows, fetched_at: Date.now() };
        this.intradayCache.set(key, entry);
      }
      const sorted = entry.rows.slice().sort((a, b) => a.timestamp - b.timestamp);
      const page = paginate(sorted, { max_rows: args.max_rows, offset: args.offset });
      totalRows = page.total_rows;
      truncated = page.truncated;
      projected = page.rows.map((r) => ({ price: r.price, timestamp: r.timestamp }));
      fetchedAt = entry.fetched_at;
    } else {
      granularity = 'daily';
      let entry = this.dailyCache.get(key);
      if (entry !== undefined && startedAt - entry.fetched_at < this.dailyTtlMs) {
        hit = true;
      } else {
        const rows = await this.fetchDaily(args.security_id, timeFrame);
        entry = { rows, fetched_at: Date.now() };
        this.dailyCache.set(key, entry);
      }
      const sorted = entry.rows.slice().sort((a, b) => a.date.localeCompare(b.date));
      const page = paginate(sorted, { max_rows: args.max_rows, offset: args.offset });
      totalRows = page.total_rows;
      truncated = page.truncated;
      projected = page.rows.map((r) => ({ price: r.price, date: r.date }));
      fetchedAt = entry.fetched_at;
    }

    this.live.logReadCall({
      op: intraday ? 'SecurityPricesHighFrequency' : 'SecurityPrices',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: projected.length,
      cache_hit: hit,
    });

    const fetchedAtIso = new Date(fetchedAt).toISOString();
    // Single-fetch shape — each cache key maps to exactly one fetched-at
    // timestamp, so `_cache_oldest_fetched_at` and `_cache_newest_fetched_at`
    // are always identical here. The dual field mirrors the envelope shared
    // with other live tools (notably the windowed transactions cache, where
    // the two can differ across month windows). Keep both for cross-tool
    // consistency.
    return {
      granularity,
      count: projected.length,
      total_rows: totalRows,
      truncated,
      prices: projected,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
    };
  }
}

export function createLiveInvestmentPricesToolSchema(): ToolSchema {
  return {
    name: 'get_investment_prices_live',
    description:
      'Get price history for a single security (live, GraphQL-backed). One MCP tool routes ' +
      'to two underlying queries based on time_frame: ONE_DAY and ONE_WEEK return intraday ' +
      'timestamps (5-minute cache TTL); ONE_MONTH / THREE_MONTHS / YTD / ONE_YEAR / ALL return ' +
      'daily closes (1-hour cache TTL). The output `granularity` field tells callers which ' +
      'row field to use (`date` for daily, `timestamp` for intraday). ' +
      'IMPORTANT — server-side ownership gate: this query is restricted to securities you ' +
      'currently hold. For any security_id not in your linked-account positions, the tool ' +
      'returns a clean error ("not currently in your linked accounts"). Use `get_holdings_live` ' +
      'to enumerate valid security_ids. Long-range responses are paginated via `max_rows` ' +
      '(default 500, max 5000) and `offset` (counts from the most-recent row); the response ' +
      'reports `total_rows` and `truncated` so callers can detect when older data was elided. ' +
      'Available when --live-reads is on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        security_id: {
          type: 'string',
          description: 'The security id (from get_holdings_live).',
        },
        time_frame: {
          type: 'string',
          enum: ALL_TIME_FRAMES,
          description:
            'Date range. Default: ONE_MONTH. ONE_DAY and ONE_WEEK return intraday timestamps; ' +
            'larger ranges return daily closes.',
        },
        max_rows: {
          type: 'integer',
          description:
            'Cap response to the most recent N rows (default 500, max 5000). Helps avoid the ' +
            'MCP single-tool-result token limit on long-range queries. If hit, response ' +
            'includes `truncated: true`.',
          default: DEFAULT_MAX_ROWS,
        },
        offset: {
          type: 'integer',
          description:
            'Number of rows to skip from the most-recent end. Default 0. Set to `max_rows` to ' +
            'fetch the next-most-recent batch (counts backwards through history).',
          default: 0,
        },
      },
      required: ['security_id'],
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
