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
}

export interface GetBalanceHistoryLiveEntry {
  date: string;
  balance: number;
}

export interface GetBalanceHistoryLiveResult {
  count: number;
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
  return `${itemId}:${accountId}:${timeFrame ?? DEFAULT_TIME_FRAME_KEY}`;
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
    const now = Date.now();

    let entry = this.cache.get(key);
    let hit = false;
    if (entry !== undefined && now - entry.fetched_at < this.ttlMs) {
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
    const projected: GetBalanceHistoryLiveEntry[] = sorted.map((r) => ({
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
      '(item_id, account_id) pairs. Available when --live-reads is on.',
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
      },
      required: ['item_id', 'account_id'],
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
