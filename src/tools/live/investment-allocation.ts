/**
 * Live-mode get_investment_allocation_live tool.
 *
 * Wraps the GraphQL `InvestmentAllocation` query, returning the user's
 * portfolio mix by asset class — one row per asset class with a dollar
 * `amount` and a `percentage` share of the total invested. Backed by the
 * SnapshotCache<AllocationNode> on LiveCopilotDatabase (6h TTL — the mix
 * moves slowly; matches the holdings cache precedent).
 *
 * Scope filter (account_id / item_id) is applied SERVER-SIDE: AllocationNode
 * carries no account/item field, so client-side filtering is impossible. The
 * single-snapshot cache holds the most-recently-requested scope; a different
 * scope invalidates and refetches (same pattern as get_networth_live's
 * time_frame). Assumes serial callers (the MCP request loop is one-at-a-time).
 *
 * `percentage` is passed through UNSCALED — the captured schema does not
 * disambiguate 0..1 vs 0..100. See the tool description for the live-verified
 * scale (#539).
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import {
  fetchInvestmentAllocation,
  type AllocationFilter,
} from '../../core/graphql/queries/investment-allocation.js';
import type { ToolSchema } from '../tools.js';

export interface GetInvestmentAllocationLiveArgs {
  /** Scope filter — server-side; the account's id. */
  account_id?: string;
  /** Scope filter — server-side; the account's Plaid item id. */
  item_id?: string;
}

export interface GetInvestmentAllocationLiveEntry {
  /** Asset-class label, e.g. "EQUITY", "CASH", "FIXED_INCOME". */
  type: string;
  /** Dollar value of this asset class. */
  amount: number;
  /** Share of total invested, as returned by the server (UNSCALED — see #539). */
  percentage: number;
}

export interface GetInvestmentAllocationLiveResult {
  count: number;
  allocation: GetInvestmentAllocationLiveEntry[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

export class LiveInvestmentAllocationTools {
  // Tracks the scope of the currently-cached snapshot (see get_networth_live
  // for the serial-callers rationale). null until the first read.
  private lastScopeKey: string | null = null;

  constructor(private readonly live: LiveCopilotDatabase) {}

  async getInvestmentAllocation(
    args: GetInvestmentAllocationLiveArgs
  ): Promise<GetInvestmentAllocationLiveResult> {
    const filter: AllocationFilter | undefined =
      args.account_id || args.item_id
        ? { accountId: args.account_id, itemId: args.item_id }
        : undefined;
    const scopeKey = `${args.account_id ?? ''}|${args.item_id ?? ''}`;

    const cache = this.live.getAllocationCache();
    if (this.lastScopeKey !== null && this.lastScopeKey !== scopeKey) {
      cache.invalidate();
    }
    this.lastScopeKey = scopeKey;

    const startedAt = Date.now();
    const {
      rows: cached,
      fetched_at,
      hit,
    } = await cache.read(() => fetchInvestmentAllocation(this.live.getClient(), { filter }));

    const allocation: GetInvestmentAllocationLiveEntry[] = cached.map((a) => ({
      type: a.type,
      amount: a.amount,
      percentage: a.percentage,
    }));

    this.live.logReadCall({
      op: 'InvestmentAllocation',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: allocation.length,
      cache_hit: hit,
    });

    const fetchedAtIso = new Date(fetched_at).toISOString();
    return {
      count: allocation.length,
      allocation,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
    };
  }
}

export function createLiveInvestmentAllocationToolSchema(): ToolSchema {
  return {
    name: 'get_investment_allocation_live',
    description:
      'Get the portfolio asset-class allocation (live, GraphQL-backed). Returns one row per ' +
      'asset class — `type` (e.g. "EQUITY", "CASH", "FIXED_INCOME"), `amount` (dollar value), ' +
      'and `percentage` (share of total invested, as returned by the server). Optional ' +
      '`account_id` / `item_id` scope the allocation to a single account (applied server-side). ' +
      'Available when --live-reads is on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account_id: {
          type: 'string',
          description: 'Scope the allocation to this account id (server-side filter).',
        },
        item_id: {
          type: 'string',
          description: 'Scope the allocation to this Plaid item id (server-side filter).',
        },
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
