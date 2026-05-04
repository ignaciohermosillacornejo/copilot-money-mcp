/**
 * Live-mode get_networth_live tool.
 *
 * Fetches net-worth-over-time history via GraphQL through the
 * SnapshotCache<NetworthHistoryNode> exposed by LiveCopilotDatabase
 * (1h TTL). Output envelope mirrors the other live read tools (count,
 * networth_history) plus the freshness-envelope fields.
 *
 * The `total` field from the upstream NetworthHistory type is a client-side
 * (`@client`) projection stripped by the operations generator and is not
 * present on the wire. Consumers that want net worth at each point should
 * compute `assets - debt` per row.
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

const DEFAULT_TIME_FRAME = 'ALL';

export interface GetNetworthLiveArgs {
  time_frame?: string;
}

export interface GetNetworthLiveResult {
  count: number;
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

    const rows = [...cached].sort((a, b) => a.date.localeCompare(b.date));

    // Log after sort so `rows` reflects what's returned to the caller.
    this.live.logReadCall({
      op: 'Networth',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: rows.length,
      cache_hit: hit,
    });

    const fetchedAtIso = new Date(fetched_at).toISOString();
    // Both `_cache_oldest_fetched_at` and `_cache_newest_fetched_at` reflect
    // the same single-snapshot fetch time — unlike the windowed transaction
    // cache where they can differ across month windows.
    return {
      count: rows.length,
      networth_history: rows,
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
      '--live-reads is on. Optional `time_frame` arg (default "ALL"; other server-supported ' +
      'values include "YEAR", "MONTH"). The cache holds the most-recently-requested ' +
      'time_frame; requesting a different value triggers a fresh fetch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        time_frame: {
          type: 'string',
          enum: ['ALL', 'YEAR', 'MONTH'],
          description:
            'TimeFrame enum passed through to the Networth query. Default "ALL". ' +
            'Other values are passed through unchanged; the server is the source of truth ' +
            'on which TimeFrame values it accepts.',
          default: DEFAULT_TIME_FRAME,
        },
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
