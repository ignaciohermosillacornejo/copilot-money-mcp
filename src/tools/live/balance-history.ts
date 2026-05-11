/**
 * Live-mode get_balance_history_live tool.
 *
 * Wraps the GraphQL `BalanceHistory` query, projecting each row onto the
 * minimal `{ date, balance }` shape the server returns, plus the standard
 * `_cache_*` metadata envelope shared with the other live tools.
 *
 * Schema asymmetry vs cache-mode `get_balance_history`
 * ----------------------------------------------------
 * Unlike the other Phase 3 live tools, this one does NOT supersede its
 * cache-mode counterpart — both coexist in the tool list. Server
 * constraints make the GraphQL query strictly narrower than cache mode:
 *
 *   Capability        | Cache mode              | Live mode
 *   ──────────────────┼─────────────────────────┼──────────────────────────
 *   Account scope     | optional account_id     | itemId + accountId required
 *                     |   (all accounts in one) |   (one account per call)
 *   Date filter       | free-form start/end     | timeFrame enum only
 *   Granularity       | daily/weekly/monthly    | server returns daily
 *   Account enrichment| name/balance/limit      | none
 *
 * Callers needing cross-account history or downsampling stay on
 * `get_balance_history`. Callers wanting fresh server-side numbers without
 * a LevelDB refresh use this tool.
 *
 * Cache strategy
 * --------------
 * Each `(itemId, accountId, timeFrame)` tuple is a distinct snapshot —
 * `SnapshotCache<T>` (single-snapshot per entity) doesn't fit. We use a
 * bespoke per-instance `Map` keyed on the tuple string. The cache lives
 * on this class (not `LiveCopilotDatabase`) because it is local to one
 * tool and tightly coupled to the call shape. `refresh_cache --scope
 * balance_history` clears the map.
 *
 * Memory bound: ~10s of (itemId, accountId) pairs × 7 timeFrame values
 * (incl. omitted) ≈ ≤80 entries per process, each holding at most ~365
 * `{date, balance}` rows. Not a leak. TTL still applies — stale entries
 * are refetched on access, not actively evicted.
 *
 * Sort: the server returns rows already sorted ascending by date. We
 * pass through verbatim. A defensive ascending sort is applied here so
 * any future server-side reordering does not silently change output
 * order (cost is negligible — at most ~365 rows per response).
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import {
  fetchAccountBalanceHistory,
  type BalanceHistoryPointNode,
} from '../../core/graphql/queries/balance-history.js';
import type { TimeFrame } from '../../core/graphql/queries/_shared.js';
import { paginate, DEFAULT_MAX_ROWS } from '../../utils/pagination.js';

const TIME_FRAMES: TimeFrame[] = [
  'ONE_DAY',
  'ONE_WEEK',
  'ONE_MONTH',
  'THREE_MONTHS',
  'YTD',
  'ONE_YEAR',
  'ALL',
];

/** 1 hour. Balance history is daily-granular and rarely updates intraday. */
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Sentinel key segment for "no timeFrame passed" so an explicit `'ALL'`
 * never collides with an omitted argument. The two are semantically
 * different (server default vs explicit ALL) — keep their cache entries
 * separate to honor that distinction.
 */
const DEFAULT_TIME_FRAME_KEY = 'DEFAULT';

export interface GetBalanceHistoryLiveArgs {
  /** Plaid item ID. Required by the server. */
  item_id: string;
  /** Account ID. Required by the server. */
  account_id: string;
  /** Optional timeFrame. Omit to use the server's default range. */
  time_frame?: TimeFrame;
  /**
   * Cap on the number of rows returned. Clamped to [1, 5000]; default 500.
   * Slices the most-recent rows of the ascending-by-date series.
   */
  max_rows?: number;
  /**
   * Number of rows to skip from the most-recent end (counts from the tail).
   * Clamped to >= 0; default 0. `offset=max_rows` returns the
   * next-most-recent batch.
   */
  offset?: number;
}

export interface GetBalanceHistoryLiveEntry {
  date: string;
  balance: number;
}

export interface GetBalanceHistoryLiveResult {
  /** Number of rows in this page (= balance_history.length). */
  count: number;
  /** Pre-pagination row count of the full series the server returned. */
  total_rows: number;
  /** True iff older rows beyond this page remain (caller can paginate further). */
  truncated: boolean;
  balance_history: GetBalanceHistoryLiveEntry[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

interface CacheEntry {
  rows: BalanceHistoryPointNode[];
  fetched_at: number;
}

function makeKey(itemId: string, accountId: string, timeFrame?: TimeFrame): string {
  // Use \0 (null byte) as the separator — Plaid IDs today are alphanumeric +
  // hyphen, but the colon variant of this function would have aliased
  // (itemId="foo:bar", accountId="baz") with (itemId="foo", accountId="bar:baz").
  // \0 cannot appear in either field so the join is injectively reversible.
  return `${itemId}\0${accountId}\0${timeFrame ?? DEFAULT_TIME_FRAME_KEY}`;
}

export class LiveBalanceHistoryTools {
  /**
   * Per-(itemId, accountId, timeFrame) cache. Bounded by the small product
   * of accounts × timeFrames (see class JSDoc). Cleared by
   * `clearCache()` on refresh_cache.
   */
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(
    private readonly live: LiveCopilotDatabase,
    opts: { ttlMs?: number } = {}
  ) {
    this.ttlMs = opts.ttlMs ?? ONE_HOUR_MS;
  }

  /** Public for refresh_cache. Drops every cached tuple. */
  clearCache(): void {
    this.cache.clear();
  }

  async getBalanceHistory(args: GetBalanceHistoryLiveArgs): Promise<GetBalanceHistoryLiveResult> {
    if (!args.item_id) {
      throw new Error("get_balance_history_live: 'item_id' is required.");
    }
    if (!args.account_id) {
      throw new Error("get_balance_history_live: 'account_id' is required.");
    }

    const startedAt = Date.now();
    const key = makeKey(args.item_id, args.account_id, args.time_frame);

    let entry = this.cache.get(key);
    let hit = false;
    if (entry !== undefined && startedAt - entry.fetched_at < this.ttlMs) {
      hit = true;
    } else {
      const rows = await this.live.withRetry(() =>
        fetchAccountBalanceHistory(this.live.getClient(), {
          itemId: args.item_id,
          accountId: args.account_id,
          timeFrame: args.time_frame,
        })
      );
      entry = { rows, fetched_at: Date.now() };
      this.cache.set(key, entry);
    }

    // Defensive ascending sort — server currently pre-sorts, but a small
    // safety net here makes the contract explicit. `.slice()` first so we
    // never mutate the cached array.
    const sorted = entry.rows.slice().sort((a, b) => a.date.localeCompare(b.date));

    // Apply uniform pagination AFTER sort so the "newest N" semantics hold.
    const page = paginate(sorted, { max_rows: args.max_rows, offset: args.offset });
    const projected: GetBalanceHistoryLiveEntry[] = page.rows.map((r) => ({
      date: r.date,
      balance: r.balance,
    }));

    this.live.logReadCall({
      op: 'BalanceHistory',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: projected.length,
      cache_hit: hit,
    });

    const fetchedAtIso = new Date(entry.fetched_at).toISOString();
    // Single-fetch shape — oldest and newest are identical.
    return {
      count: projected.length,
      total_rows: page.total_rows,
      truncated: page.truncated,
      balance_history: projected,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
    };
  }
}

export function createLiveBalanceHistoryToolSchema() {
  return {
    name: 'get_balance_history_live',
    description:
      'Get daily balance history for a single account (live, GraphQL-backed). ' +
      'Requires both item_id and account_id (server constraint — one account per call). ' +
      'Date range is selected by the time_frame enum; the server returns daily granularity ' +
      'and no name/limit enrichment. For cross-account history or weekly/monthly downsampling, ' +
      'use cache-mode `get_balance_history`. Use `get_accounts_live` to enumerate ' +
      '(item_id, account_id) pairs. ' +
      'Long-range responses are paginated via `max_rows` (default 500, max 5000) and `offset` ' +
      '(counts from the most-recent end); `total_rows` and `truncated` indicate whether ' +
      'older rows remain. Available when --live-reads is on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        item_id: {
          type: 'string',
          description: 'Plaid item ID (from get_accounts_live).',
        },
        account_id: {
          type: 'string',
          description: 'Account ID (from get_accounts_live).',
        },
        time_frame: {
          type: 'string',
          enum: TIME_FRAMES,
          description: "Date range preset. Optional — omit to use the server's default range.",
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
      required: ['item_id', 'account_id'],
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
