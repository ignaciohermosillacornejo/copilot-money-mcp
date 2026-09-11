/**
 * Live-mode get_accounts_live tool.
 *
 * Fetches accounts via GraphQL through the SnapshotCache<AccountNode>
 * exposed by LiveCopilotDatabase (1h TTL by default). Output envelope
 * matches the cache-backed get_accounts shape (count, totals, accounts)
 * plus the three live-cache freshness fields.
 *
 * v3 (#597 Tier 2): sync/plumbing fields (`hasHistoricalUpdates`,
 * `hasLiveBalance`, `liveBalance`, `latestBalanceUpdate`, `isManual`) — Plaid
 * sync state, not the account itself — are, per the #597 audit, ~23% of a
 * row. Both are EXCLUDED from the default row via the shared field-selection
 * engine (DEFAULT_ACCOUNT_LIVE_FIELDS in src/tools/field-selection.ts), which
 * also backs the cache-mode get_accounts default via the shared
 * ACCOUNT_FIELDS_PARAM_SCHEMA fragment.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import { fetchAccounts } from '../../core/graphql/queries/accounts.js';
import { roundAmount } from '../../utils/round.js';
import type { ToolSchema } from '../tools.js';
import {
  DEFAULT_ACCOUNT_LIVE_FIELDS,
  ACCOUNT_FIELDS_PARAM_SCHEMA,
  projectRows,
} from '../field-selection.js';

export interface GetAccountsLiveArgs {
  account_type?: string;
  include_hidden?: boolean;
  fields?: string[];
}

// A `type` alias (not an interface) on purpose: type aliases carry an
// implicit index signature, so rows assign to the field-selection engine's
// `Record<string, unknown>` constraint without casts — same reasoning as
// GetRecurringLiveRow in src/tools/live/recurring.ts and CategoryLiveRow in
// src/tools/live/categories.ts. Mirrors AccountNode's fields exactly; kept
// as a separate type (rather than projecting AccountNode itself, an
// interface) for the same reason those two are separate from their node
// types.
export type GetAccountsLiveRow = {
  id: string;
  itemId: string;
  name: string;
  balance: number;
  liveBalance: boolean;
  type: string;
  subType: string | null;
  mask: string | null;
  isUserHidden: boolean;
  isUserClosed: boolean;
  isManual: boolean;
  color: string | null;
  limit: number | null;
  institutionId: string | null;
  hasHistoricalUpdates: boolean;
  hasLiveBalance: boolean;
  latestBalanceUpdate: number | null;
};

/**
 * Every selectable field name on an account row, derived from
 * {@link GetAccountsLiveRow} itself (not a sample row) via a mapped-type
 * record: the `[K in keyof ...]-?: true` shape forces this object literal to
 * carry exactly the type's keys, so a forgotten or renamed field is a
 * compile error instead of a silent runtime desync. Same reasoning as
 * RECURRING_LIVE_FIELD_NAMES in src/tools/live/recurring.ts.
 */
const ACCOUNT_LIVE_FIELD_NAMES: { [K in keyof GetAccountsLiveRow]-?: true } = {
  id: true,
  itemId: true,
  name: true,
  balance: true,
  liveBalance: true,
  type: true,
  subType: true,
  mask: true,
  isUserHidden: true,
  isUserClosed: true,
  isManual: true,
  color: true,
  limit: true,
  institutionId: true,
  hasHistoricalUpdates: true,
  hasLiveBalance: true,
  latestBalanceUpdate: true,
};
export const ACCOUNT_LIVE_KNOWN_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(ACCOUNT_LIVE_FIELD_NAMES)
);

/**
 * Built FROM the known-field set rather than hand-listed — see the identical
 * reasoning on RECURRING_LIVE_VALID_FIELDS_HINT in src/tools/live/recurring.ts.
 */
const ACCOUNT_LIVE_VALID_FIELDS_HINT = `the account node fields (${[...ACCOUNT_LIVE_KNOWN_FIELDS].join(', ')})`;

export interface GetAccountsLiveResult {
  count: number;
  total_balance: number;
  total_assets: number;
  total_liabilities: number;
  accounts: GetAccountsLiveRow[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
  // Requested `fields` names that matched nothing (typos), when any.
  _field_warning?: string;
}

// GraphQL Account.type returns uppercase enum values ('CREDIT', 'DEPOSITORY',
// 'LOAN', 'INVESTMENT', 'OTHER'). The set holds the canonical uppercase form;
// callers normalize via .toUpperCase() at the comparison site.
const LIABILITY_TYPES = new Set(['CREDIT', 'LOAN']);

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

    let rows: GetAccountsLiveRow[] = cached.map((a) => ({ ...a }));

    if (!include_hidden) {
      rows = rows.filter((a) => !a.isUserHidden && !a.isUserClosed);
    }
    if (account_type) {
      const normalized = account_type.toUpperCase();
      rows = rows.filter((a) => a.type.toUpperCase() === normalized);
    }

    // Log after filtering so `rows` reflects what's actually returned to
    // the caller, not the raw cached count. ttl_tier is omitted because
    // the live/cold labels are tied to TransactionWindowCache's
    // age-based classification — they don't map cleanly to a snapshot
    // cache with a fixed 1h TTL.
    this.live.logReadCall({
      op: 'Accounts',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: rows.length,
      cache_hit: hit,
    });

    let totalAssets = 0;
    let totalLiabilities = 0;
    for (const a of rows) {
      const typeUpper = a.type.toUpperCase();
      if (LIABILITY_TYPES.has(typeUpper)) totalLiabilities += a.balance;
      else totalAssets += a.balance;
    }

    // A2: server returns limit:0 for charge cards (no preset limit); project
    // null to prevent /0 in utilization. `limit` is not in the default preset,
    // so this is only visible to a caller who asks for it
    // (fields: ["default", "limit"]) — who then sees null, never the raw wire
    // 0. Its position relative to projectRows below is NOT load-bearing: this
    // rewrites the same key it reads, so a kept `limit` is normalized either
    // way and a projected-away one is absent either way. (Contrast the
    // cache-mode nickname resolution in tools.ts, which writes a DIFFERENT key
    // — `nickname` into `name` — and therefore must run before projection or
    // the projected row silently reverts to the provider label.)
    const normalizedAccounts = rows.map((a) => (a.limit === 0 ? { ...a, limit: null } : a));

    // v3: omitting `fields` yields the terse preset (no sync/plumbing
    // fields — hasHistoricalUpdates, hasLiveBalance, liveBalance,
    // latestBalanceUpdate, isManual) — request them explicitly with
    // fields: ["default", "hasHistoricalUpdates", ...], or take everything
    // with "all"/"*".
    const { rows: projectedAccounts, warning } = projectRows(
      normalizedAccounts,
      args.fields ?? ['default'],
      {
        preset: DEFAULT_ACCOUNT_LIVE_FIELDS,
        knownFields: ACCOUNT_LIVE_KNOWN_FIELDS,
        validFieldsHint: ACCOUNT_LIVE_VALID_FIELDS_HINT,
      }
    );

    const fetchedAtIso = new Date(fetched_at).toISOString();
    return {
      count: rows.length,
      total_balance: roundAmount(totalAssets - totalLiabilities),
      total_assets: roundAmount(totalAssets),
      total_liabilities: roundAmount(totalLiabilities),
      accounts: projectedAccounts,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
      ...(warning && { _field_warning: warning }),
    };
  }
}

export function createLiveAccountsToolSchema(): ToolSchema {
  return {
    name: 'get_accounts_live',
    description:
      'Get all linked financial accounts (live, GraphQL-backed). Returns balances and metadata. ' +
      'Replaces get_accounts when --live-reads is on. Default rows are terse: id, name, type, ' +
      'subType, balance, institutionId, itemId, isUserHidden, isUserClosed (the last two are the ' +
      'flags include_hidden controls). That EXCLUDES sync/plumbing fields — ' +
      '`hasHistoricalUpdates`, `hasLiveBalance`, `liveBalance`, `latestBalanceUpdate`, `isManual` ' +
      '— which describe Plaid sync state rather than the account, plus `mask` and `color` ' +
      '(display detail) and `limit` (credit-line detail; charge-card 0 is normalized to null ' +
      'either way, before or after opting in). Request any of them with ' +
      'fields: ["default", "hasHistoricalUpdates"], or "all" / "*" for full rows.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account_type: {
          type: 'string',
          description:
            'Filter by account type (case-insensitive — depository, credit, loan, investment, etc.).',
        },
        include_hidden: {
          type: 'boolean',
          description: 'Include hidden/closed accounts. Default: false.',
          default: false,
        },
        fields: ACCOUNT_FIELDS_PARAM_SCHEMA,
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
