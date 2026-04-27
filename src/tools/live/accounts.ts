/**
 * Live-mode get_accounts_live tool.
 *
 * Fetches accounts via GraphQL through the SnapshotCache<AccountNode>
 * exposed by LiveCopilotDatabase (1h TTL by default). Output envelope
 * matches the cache-backed get_accounts shape (count, totals, accounts)
 * plus the three live-cache freshness fields.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import { fetchAccounts, type AccountNode } from '../../core/graphql/queries/accounts.js';
import { roundAmount } from '../../utils/round.js';

export interface GetAccountsLiveArgs {
  account_type?: string;
  include_hidden?: boolean;
}

export interface GetAccountsLiveResult {
  count: number;
  total_balance: number;
  total_assets: number;
  total_liabilities: number;
  accounts: AccountNode[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

const LIABILITY_TYPES = new Set(['credit', 'loan']);

export class LiveAccountsTools {
  constructor(private readonly live: LiveCopilotDatabase) {}

  async getAccounts(args: GetAccountsLiveArgs): Promise<GetAccountsLiveResult> {
    const { account_type, include_hidden = false } = args;

    const cache = this.live.getAccountsCache();
    const startedAt = Date.now();
    const {
      rows: cached,
      fetched_at,
      hit,
    } = await cache.read(() => fetchAccounts(this.live.getClient()));
    this.live.logReadCall({
      op: 'Accounts',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: cached.length,
      ttl_tier: 'warm',
      cache_hit: hit,
    });

    let rows = cached;

    if (!include_hidden) {
      rows = rows.filter((a) => !a.isUserHidden && !a.isUserClosed);
    }
    if (account_type) {
      rows = rows.filter((a) => a.type === account_type);
    }

    let totalAssets = 0;
    let totalLiabilities = 0;
    for (const a of rows) {
      if (LIABILITY_TYPES.has(a.type)) totalLiabilities += a.balance;
      else totalAssets += a.balance;
    }

    const fetchedAtIso = new Date(fetched_at).toISOString();
    return {
      count: rows.length,
      total_balance: roundAmount(totalAssets - totalLiabilities),
      total_assets: roundAmount(totalAssets),
      total_liabilities: roundAmount(totalLiabilities),
      accounts: rows,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
    };
  }
}

export function createLiveAccountsToolSchema() {
  return {
    name: 'get_accounts_live',
    description:
      'Get all linked financial accounts (live, GraphQL-backed). Returns balances and metadata. Replaces get_accounts when --live-reads is on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account_type: {
          type: 'string',
          description: 'Filter by account type (depository, credit, loan, investment, etc.)',
        },
        include_hidden: {
          type: 'boolean',
          description: 'Include hidden/closed accounts. Default: false.',
          default: false,
        },
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
