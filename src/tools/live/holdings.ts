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
 *   - `total_return_percent` is computed by `computeTotalReturnPercent`
 *     (see `src/utils/round.ts`) — floored to 2dp matching Copilot's web
 *     UI display convention; omitted when `costBasis === 0`.
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
import { fetchAccounts } from '../../core/graphql/queries/accounts.js';
import { isVisibleAccountNode } from '../../models/account.js';
import { computeTotalReturnPercent, roundAmount } from '../../utils/round.js';
import { clampMaxRows, clampOffset } from '../../utils/pagination.js';
import type { ToolSchema } from '../tools.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10_000;
const MIN_LIMIT = 1;

export interface GetHoldingsLiveArgs {
  /** Filter — exact match on `holding.accountId`. */
  account_id?: string;
  /** Filter — case-insensitive match on `security.symbol`. */
  ticker_symbol?: string;
  /**
   * Include positions on hidden and closed accounts. Default false, matching
   * `get_accounts_live` (#683).
   */
  include_hidden?: boolean;
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
    const pct = computeTotalReturnPercent(h.metrics.totalReturn, h.metrics.costBasis);
    if (pct !== undefined) entry.total_return_percent = pct;
  }

  return entry;
}

export class LiveHoldingsTools {
  constructor(private readonly live: LiveCopilotDatabase) {}

  /**
   * Account ids `get_accounts_live` would hide, read from the same snapshot
   * cache that tool uses — so the two cannot disagree about which accounts
   * exist, and the join costs nothing when the cache is warm.
   *
   * Returns the snapshot's own freshness alongside the ids: the rows this tool
   * returns depend on BOTH snapshots, so reporting only the holdings one would
   * advertise a freshness the result does not have (a caller who unhides an
   * account can get `_cache_hit: false` while a 59-minute-old accounts
   * snapshot still filters its positions out).
   */
  private async readHiddenAccounts(): Promise<{
    hidden: Set<string>;
    rowCount: number;
    fetched_at: number;
    hit: boolean;
  }> {
    const { rows, fetched_at, hit } = await this.live
      .getAccountsCache()
      .read(() => fetchAccounts(this.live.getClient()));

    // Fail rather than fall back to unfiltered. `fetchAccounts` returns
    // `data.accounts` with no runtime guard, so a malformed response yields
    // undefined — and the tempting `?? []` here would mean "no hidden
    // accounts", silently restoring the exact #683 double-count this method
    // exists to prevent. A caller who cannot be told which accounts are
    // hidden should get an error, not a plausible wrong number.
    //
    // Invalidate before throwing, for two reasons.
    //
    // 1. It makes "retry" true advice. SnapshotCache.read stores the entry
    //    BEFORE the caller sees the rows, so without this a malformed response
    //    sits cached with a fresh timestamp and every retry inside the 1h TTL
    //    throws off the same poisoned entry. Flushing it means a transient bad
    //    response self-heals on the next call.
    // 2. It stops this tool taking `get_accounts_live` down with it. The
    //    accounts snapshot is SHARED, and that tool does `cached.map(...)` with
    //    no guard — so a poisoned entry makes it throw a bare TypeError with no
    //    explanation. That failure mode predates this code, but the #683
    //    visibility join newly makes get_holdings_live a WRITER of that cache,
    //    so a holdings call could otherwise break the accounts tool for an
    //    hour. New blast radius deserves its own cleanup.
    // Checks the ROWS, not just the container. An array whose rows lack
    // isUserHidden/isUserClosed passes an Array.isArray guard, and
    // isVisibleAccountNode then computes `!undefined && !undefined` === true
    // for every one — an empty hidden set, and the #683 double-count restored
    // silently. That is the same failure the `?? []` refusal above rejects,
    // one level down, so it takes the same error path.
    const rowsUsable =
      Array.isArray(rows) &&
      (rows.length === 0 ||
        (typeof rows[0]?.isUserHidden === 'boolean' && typeof rows[0]?.isUserClosed === 'boolean'));
    if (!rowsUsable) {
      this.live.getAccountsCache().invalidate();
      throw new Error(
        'get_holdings_live could not read the accounts snapshot, so it cannot tell which ' +
          'accounts are hidden or closed. Returning unfiltered holdings would risk ' +
          'double-counting a merged account (#683). The bad snapshot has been discarded, so ' +
          'a retry will re-fetch — if it keeps failing, the response itself is malformed and ' +
          'include_hidden: true skips the visibility join deliberately.'
      );
    }
    return {
      hidden: new Set(rows.filter((a) => !isVisibleAccountNode(a)).map((a) => a.id)),
      rowCount: rows.length,
      fetched_at,
      hit,
    };
  }

  async getHoldings(args: GetHoldingsLiveArgs): Promise<GetHoldingsLiveResult> {
    const cache = this.live.getHoldingsCache();
    const startedAt = Date.now();

    // Both snapshots in parallel: on a doubly-cold cache these are two
    // independent round-trips and there is no reason to serialize them.
    const [holdingsRead, accountsRead] = await Promise.all([
      cache.read(() => fetchHoldings(this.live.getClient())),
      args.include_hidden ? Promise.resolve(undefined) : this.readHiddenAccounts(),
    ]);
    const { rows: cached, fetched_at, hit } = holdingsRead;

    const limit = clampMaxRows(args.limit, { hardMax: MAX_LIMIT, defaultValue: DEFAULT_LIMIT });
    const offset = clampOffset(args.offset);
    const tickerLower = args.ticker_symbol?.toLowerCase();

    // Account visibility, the live half of #683. get_accounts_live filters
    // isUserHidden/isUserClosed; this tool loaded holdings and filtered
    // neither, so the two live tools disagreed about which accounts exist —
    // the same split the cache pair had, on the surface `--write` users get,
    // since get_holdings is swappedOutInLiveMode.
    //
    // Joined against the accounts snapshot rather than trusted to the server:
    // a probe against real data could NOT settle whether the Holdings query
    // already excludes hidden accounts, because the only hidden accounts in
    // that dataset hold nothing — their absence is uninformative, not
    // evidence. Filtering here makes the parity hold by construction instead
    // of resting on an unverified assumption about someone else's resolver.
    // If the server does filter too, this is a no-op.
    const hiddenAccountIds = accountsRead?.hidden;

    // Filter on the raw GraphQL rows before projection — cheaper than
    // projecting then filtering, and the filter predicates only need
    // fields already present on HoldingNode.
    const filtered = cached.filter((h) => {
      if (hiddenAccountIds?.has(h.accountId)) return false;
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
    // The visibility join is its own network op when the accounts snapshot is
    // cold. Logged separately so the read log records the round-trips this
    // tool actually issues — otherwise its cost hides inside `Holdings`'
    // latency and the op never appears at all.
    if (accountsRead) {
      this.live.logReadCall({
        op: 'Accounts',
        // Rows FETCHED, not hidden-count: everywhere else in the read log
        // `rows` means that, and a 20-account response with nothing hidden
        // would otherwise log `pages=1 rows=0` and read like an empty fetch.
        //
        // Both logReadCalls report elapsed from the same `startedAt`, so
        // anything summing per-op latency double-counts the parallel window.
        // That is honest — the two ops genuinely overlap — but it is the
        // parallelism, not a measurement error.
        pages: accountsRead.hit ? 0 : 1,
        latencyMs: Date.now() - startedAt,
        rows: accountsRead.rowCount,
        cache_hit: accountsRead.hit,
      });
    }

    // Freshness spans BOTH snapshots when the visibility join ran, because the
    // returned rows depend on both. Reporting only the holdings snapshot would
    // advertise a freshness the result does not have.
    const oldestFetchedAt = accountsRead
      ? Math.min(fetched_at, accountsRead.fetched_at)
      : fetched_at;
    const newestFetchedAt = accountsRead
      ? Math.max(fetched_at, accountsRead.fetched_at)
      : fetched_at;
    const cacheHit = accountsRead ? hit && accountsRead.hit : hit;
    return {
      count: paged.length,
      total_count: totalCount,
      offset,
      has_more: hasMore,
      holdings: paged,
      _cache_oldest_fetched_at: new Date(oldestFetchedAt).toISOString(),
      _cache_newest_fetched_at: new Date(newestFetchedAt).toISOString(),
      _cache_hit: cacheHit,
    };
  }
}

export function createLiveHoldingsToolSchema(): ToolSchema {
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
      'is not available on the live query. Positions on hidden and closed accounts are EXCLUDED by default, matching get_accounts_live — pass include_hidden: true for them. Available when --live-reads is on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account_id: {
          type: 'string',
          description:
            "Filter — exact match on the holding's accountId. Returns empty for a hidden or " +
            'closed account unless include_hidden is also set.',
        },
        ticker_symbol: {
          type: 'string',
          description: "Filter — case-insensitive match on the security's ticker symbol.",
        },
        include_hidden: {
          type: 'boolean',
          description:
            'Include positions on hidden and closed accounts (default: false). Same flag, ' +
            'same default as get_accounts_live — leave it off and the two tools agree on ' +
            'which accounts exist.',
          default: false,
        },
        limit: {
          type: 'integer',
          description: `Max rows to return. Default ${DEFAULT_LIMIT}, clamped to [${MIN_LIMIT}, ${MAX_LIMIT}].`,
          default: DEFAULT_LIMIT,
        },
        offset: {
          type: 'integer',
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
