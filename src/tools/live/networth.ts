/**
 * Live-mode get_networth_live tool.
 *
 * Fetches net-worth-over-time history via GraphQL through the
 * SnapshotCache<NetworthHistoryNode> exposed by LiveCopilotDatabase
 * (1h TTL). Output envelope mirrors the other live read tools (count,
 * networth_history) plus the freshness-envelope fields, plus the uniform
 * pagination shape (total_rows, truncated; max_rows/offset args).
 *
 * The `total` field from the upstream NetworthHistory type is a client-side
 * (`@client`) projection stripped by the operations generator and is not
 * present on the wire. Consumers that want net worth at each point should
 * compute `assets - debt` per row.
 *
 * Default time_frame is `YTD` (tightened from `ALL` on 2026-05) so the
 * default call stays well below the MCP single-tool-result token cap.
 * Callers wanting the full history pass `time_frame: 'ALL'` explicitly.
 *
 * timeFrame caching: a single SnapshotCache holds the most-recently-requested
 * timeFrame's rows. Requests for a different timeFrame invalidate the cache
 * and trigger a fresh fetch (we track the last requested timeFrame to detect
 * the change). The 1h TTL still applies to the most-recently-requested
 * timeFrame.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import {
  fetchNetworthHistory,
  type NetworthHistoryNode,
} from '../../core/graphql/queries/networth.js';
import { paginate, DEFAULT_MAX_ROWS } from '../../utils/pagination.js';

const DEFAULT_TIME_FRAME = 'YTD';

export interface GetNetworthLiveArgs {
  time_frame?: string;
  /**
   * Cap on the number of rows returned. Clamped to [1, 5000]; default 500.
   * Slices the most-recent rows of the ascending-by-date series.
   */
  max_rows?: number;
  /**
   * Number of rows to skip from the most-recent end (counts from the tail).
   * Clamped to >= 0; default 0.
   */
  offset?: number;
}

export interface GetNetworthLiveResult {
  /** Number of rows in this page (= networth_history.length). */
  count: number;
  /** Pre-pagination row count of the full series the server returned. */
  total_rows: number;
  /** True iff older rows beyond this page remain. */
  truncated: boolean;
  networth_history: NetworthHistoryNode[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

export class LiveNetworthTools {
  // Tracks the timeFrame of the currently-cached snapshot. Assumes serial
  // callers — MCP tool calls are processed one-at-a-time by the server's
  // request loop, so concurrent getNetworth calls with different time_frame
  // values can't race on the assignment below. If that assumption ever
  // changes (e.g., a worker pool is added), move this into SnapshotCache
  // metadata so it's guarded by the same lock as the cache itself.
  private lastTimeFrame: string | null = null;

  constructor(private readonly live: LiveCopilotDatabase) {}

  async getNetworth(args: GetNetworthLiveArgs): Promise<GetNetworthLiveResult> {
    const timeFrame = args.time_frame ?? DEFAULT_TIME_FRAME;
    const cache = this.live.getNetworthCache();

    // If the requested timeFrame differs from the last one cached, invalidate
    // so the next read fetches fresh rows for the new timeFrame instead of
    // returning stale rows from the previous timeFrame. (See lastTimeFrame
    // comment above for the serial-callers assumption.)
    if (this.lastTimeFrame !== null && this.lastTimeFrame !== timeFrame) {
      cache.invalidate();
    }
    this.lastTimeFrame = timeFrame;

    const startedAt = Date.now();
    const {
      rows: cached,
      fetched_at,
      hit,
    } = await cache.read(() => fetchNetworthHistory(this.live.getClient(), { timeFrame }));

    const sorted = [...cached].sort((a, b) => a.date.localeCompare(b.date));

    // Apply uniform pagination AFTER sort so the "newest N" semantics hold.
    const page = paginate(sorted, { max_rows: args.max_rows, offset: args.offset });

    // Log after pagination so `rows` reflects what's returned to the caller.
    this.live.logReadCall({
      op: 'Networth',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: page.rows.length,
      cache_hit: hit,
    });

    const fetchedAtIso = new Date(fetched_at).toISOString();
    // Both `_cache_oldest_fetched_at` and `_cache_newest_fetched_at` reflect
    // the same single-snapshot fetch time — unlike the windowed transaction
    // cache where they can differ across month windows.
    return {
      count: page.rows.length,
      total_rows: page.total_rows,
      truncated: page.truncated,
      networth_history: page.rows,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
    };
  }
}

export function createLiveNetworthToolSchema() {
  return {
    name: 'get_networth_live',
    description:
      'Get net-worth-over-time history (live, GraphQL-backed). Returns daily snapshots ' +
      'sorted oldest→newest by date; for each row, `assets - debt` gives the net worth ' +
      'at that point in time. Both `assets` and `debt` are nullable strings — early dates ' +
      "in the user's history may have `assets: null` until backfilled. Available when " +
      '--live-reads is on. Optional `time_frame` arg (default "YTD"; other server-supported ' +
      'values include "ALL", "YEAR", "MONTH"). The cache holds the most-recently-requested ' +
      'time_frame; requesting a different value triggers a fresh fetch. ' +
      'Long-range responses are paginated via `max_rows` (default 500, max 5000) and ' +
      '`offset`; `total_rows` and `truncated` indicate whether older rows remain.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        time_frame: {
          type: 'string',
          enum: ['ALL', 'YEAR', 'MONTH', 'YTD'],
          description:
            "TimeFrame enum passed through to the Networth query. Default 'YTD' " +
            "(tightened from 'ALL' on 2026-05). Note: this enum is smaller than the canonical " +
            'TimeFrame used by other live time-series tools (no ONE_DAY/ONE_WEEK/ONE_MONTH/' +
            'THREE_MONTHS/ONE_YEAR). The Networth GraphQL endpoint accepts only these four values.',
          default: DEFAULT_TIME_FRAME,
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
            'fetch the next-most-recent batch.',
          default: 0,
        },
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
