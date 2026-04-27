/**
 * Live-mode implementation of get_transactions_live.
 *
 * Validates input against the strict subset supported over GraphQL,
 * translates tool-facing args into the pure shape
 * LiveCopilotDatabase.getTransactions accepts, applies client-side
 * post-filters GraphQL can't do server-side, and enriches the result
 * with category_name + normalized_merchant — matching the envelope
 * the cache-backed get_transactions tool returns today.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import type {
  AccountRef,
  ReadTransactionType,
  TransactionNode,
} from '../../core/graphql/queries/transactions.js';
import type { ToolSchema } from '../tools.js';
import { normalizeMerchantName } from '../tools.js';
import { parsePeriod } from '../../utils/date.js';

export type LiveTransactionType = 'refunds' | 'credits' | 'hsa_eligible' | 'tagged';

export interface GetTransactionsLiveOptions {
  period?: string;
  start_date?: string;
  end_date?: string;
  category?: string;
  merchant?: string;
  account_id?: string;
  item_id?: string;
  min_amount?: number;
  max_amount?: number;
  limit?: number;
  offset?: number;
  exclude_transfers?: boolean;
  exclude_deleted?: boolean;
  exclude_excluded?: boolean;
  exclude_split_parents?: boolean;
  pending?: boolean;
  transaction_id?: string;
  query?: string;
  transaction_type?: LiveTransactionType;
  tag?: string;
}

export interface EnrichedTransaction {
  transaction_id: string;
  account_id: string;
  item_id: string;
  category_id: string | null;
  category_name?: string;
  recurring_id: string | null;
  parent_transaction_id: string | null;
  amount: number;
  date: string;
  name: string;
  normalized_merchant?: string;
  type: ReadTransactionType;
  user_reviewed: boolean;
  pending: boolean;
  user_notes: string | null;
  tip_amount: number | null;
  suggested_category_ids: string[];
  iso_currency_code: string | null;
  tag_ids: string[];
  created_timestamp: number;
}

interface PageResult {
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  transactions: EnrichedTransaction[];
}

export interface GetTransactionsLiveResult extends PageResult {
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

const UNSUPPORTED_KEYS = ['city', 'lat', 'lon', 'radius_km', 'region', 'country'] as const;

export class LiveTransactionsTools {
  constructor(private readonly live: LiveCopilotDatabase) {}

  async getTransactions(opts: GetTransactionsLiveOptions): Promise<GetTransactionsLiveResult> {
    this.validate(opts);

    if (opts.transaction_id) {
      return this.singleTransactionLookup(opts);
    }

    const [start_date, end_date] = opts.period
      ? parsePeriod(opts.period)
      : [opts.start_date, opts.end_date];

    const accountRefs = opts.account_id
      ? [await this.resolveAccountRef(opts.account_id)]
      : undefined;

    const categoryIds = opts.category ? [opts.category] : undefined;

    const tagIds = opts.tag ? await this.resolveTagIds(opts.tag) : undefined;

    const matchString = opts.query ?? opts.merchant;

    const types: ReadTransactionType[] | undefined =
      opts.exclude_transfers !== false ? ['REGULAR', 'INCOME'] : undefined;

    const {
      rows: nodes,
      fetched_at,
      hit,
    } = await this.live.getTransactions({
      startDate: start_date,
      endDate: end_date,
      accountRefs,
      categoryIds,
      tagIds,
      types,
      matchString,
    });

    const filtered = await this.postFilter(nodes, opts);
    const page = await this.paginateAndEnrich(filtered, opts);
    const fetchedAtIso = new Date(fetched_at).toISOString();
    return {
      ...page,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
    };
  }

  private async singleTransactionLookup(
    opts: GetTransactionsLiveOptions
  ): Promise<GetTransactionsLiveResult> {
    const ref = await this.resolveAccountRef(opts.account_id!);
    // Resolve period → [start, end] exactly like the main path, so a caller
    // passing only `period` still produces a bounded fetch. validate() already
    // guarantees at least one of (start_date, end_date, period) is present.
    const [start_date, end_date] = opts.period
      ? parsePeriod(opts.period)
      : [opts.start_date, opts.end_date];
    const {
      rows: nodes,
      fetched_at,
      hit,
    } = await this.live.getTransactions({
      accountRefs: [ref],
      startDate: start_date,
      endDate: end_date,
    });
    const fetchedAtIso = new Date(fetched_at).toISOString();
    const match = nodes.find((n) => n.id === opts.transaction_id);
    if (!match) {
      return {
        count: 0,
        total_count: 0,
        offset: 0,
        has_more: false,
        transactions: [],
        _cache_oldest_fetched_at: fetchedAtIso,
        _cache_newest_fetched_at: fetchedAtIso,
        _cache_hit: hit,
      };
    }
    const enriched = await this.enrich([match]);
    return {
      count: 1,
      total_count: 1,
      offset: 0,
      has_more: false,
      transactions: enriched,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
    };
  }

  private async resolveAccountRef(accountId: string): Promise<AccountRef> {
    const accounts = await this.live.getCache().getAccounts();
    const match = accounts.find((a) => a.account_id === accountId);
    if (!match || !match.item_id) {
      throw new Error(
        `Account '${accountId}' not found in local cache. Refresh the cache (open the Copilot app) or pass a valid account_id.`
      );
    }
    return { accountId: match.account_id, itemId: match.item_id };
  }

  private async resolveTagIds(tagName: string): Promise<string[]> {
    const stripped = tagName.startsWith('#') ? tagName.slice(1) : tagName;
    const tags = await this.live.getCache().getTags();
    const lowered = stripped.toLowerCase();
    const match = tags.find((t) => t.name?.toLowerCase() === lowered);
    if (!match) {
      throw new Error(
        `Tag '${tagName}' not found. Create the tag first or pass an existing tag name.`
      );
    }
    return [match.tag_id];
  }

  private async postFilter(
    nodes: TransactionNode[],
    opts: GetTransactionsLiveOptions
  ): Promise<TransactionNode[]> {
    let result = nodes;

    if (opts.exclude_transfers !== false) {
      result = result.filter((n) => n.type !== 'INTERNAL_TRANSFER');
    }

    if (opts.exclude_excluded !== false) {
      const cats = await this.live.getCache().getUserCategories();
      const excludedCatIds = new Set(
        cats.filter((c) => c.excluded === true).map((c) => c.category_id)
      );
      result = result.filter((n) => !n.categoryId || !excludedCatIds.has(n.categoryId));
    }

    if (opts.min_amount !== undefined) {
      const min = opts.min_amount;
      result = result.filter((n) => Math.abs(n.amount) >= min);
    }
    if (opts.max_amount !== undefined) {
      const max = opts.max_amount;
      result = result.filter((n) => Math.abs(n.amount) <= max);
    }

    if (opts.pending !== undefined) {
      result = result.filter((n) => n.isPending === opts.pending);
    }

    if (opts.transaction_type === 'tagged') {
      result = result.filter((n) => n.tags.length > 0);
    } else if (opts.transaction_type === 'refunds') {
      result = result.filter((n) => n.amount < 0);
    } else if (opts.transaction_type === 'credits') {
      result = result.filter((n) => n.amount < 0 && n.type === 'INCOME');
    } else if (opts.transaction_type === 'hsa_eligible') {
      const map = await this.live.getCache().getCategoryNameMap();
      result = result.filter((n) => {
        if (!n.categoryId) return false;
        const name = (map.get(n.categoryId) ?? '').toLowerCase();
        return name.includes('health') || name.includes('medical');
      });
    }

    return result;
  }

  private async paginateAndEnrich(
    rows: TransactionNode[],
    opts: GetTransactionsLiveOptions
  ): Promise<PageResult> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const total = rows.length;
    const sliced = rows.slice(offset, offset + limit);
    const enriched = await this.enrich(sliced);
    return {
      count: enriched.length,
      total_count: total,
      offset,
      has_more: offset + limit < total,
      transactions: enriched,
    };
  }

  private async enrich(rows: TransactionNode[]): Promise<EnrichedTransaction[]> {
    const catMap = await this.live.getCache().getCategoryNameMap();
    return rows.map((n) => ({
      transaction_id: n.id,
      account_id: n.accountId,
      item_id: n.itemId,
      category_id: n.categoryId,
      category_name: n.categoryId ? catMap.get(n.categoryId) : undefined,
      recurring_id: n.recurringId,
      parent_transaction_id: n.parentId,
      amount: n.amount,
      date: n.date,
      name: n.name,
      normalized_merchant: normalizeMerchantName(n.name),
      type: n.type,
      user_reviewed: n.isReviewed,
      pending: n.isPending,
      user_notes: n.userNotes,
      tip_amount: n.tipAmount,
      suggested_category_ids: n.suggestedCategoryIds,
      iso_currency_code: n.isoCurrencyCode,
      tag_ids: n.tags.map((t) => t.id),
      created_timestamp: n.createdAt,
    }));
  }

  private validate(opts: GetTransactionsLiveOptions): void {
    const o = opts as Record<string, unknown>;
    const supported =
      'start_date, end_date, period, account_id (+ item_id), category, merchant, query, tag, min_amount, max_amount, limit, offset, pending, exclude_transfers, exclude_deleted, exclude_excluded, transaction_type (refunds|credits|hsa_eligible|tagged), transaction_id (+ account_id + item_id)';

    for (const key of UNSUPPORTED_KEYS) {
      if (o[key] !== undefined) {
        throw new Error(
          `Parameter '${key}' is not supported in live mode. Retry without '${key}'. Supported filters: ${supported}.`
        );
      }
    }

    if (
      opts.transaction_type !== undefined &&
      !['refunds', 'credits', 'hsa_eligible', 'tagged'].includes(opts.transaction_type)
    ) {
      throw new Error(
        `Parameter 'transaction_type=${opts.transaction_type}' is not supported in live mode. Retry with one of: refunds, credits, hsa_eligible, tagged.`
      );
    }

    if (opts.exclude_split_parents === false) {
      throw new Error(
        `Parameter 'exclude_split_parents=false' is not supported in live mode — the GraphQL server omits split parents. Retry without 'exclude_split_parents' or set it to true.`
      );
    }

    if (opts.transaction_id !== undefined) {
      if (!opts.account_id || !opts.item_id) {
        throw new Error(
          `transaction_id lookup in live mode requires account_id and item_id. All three are returned together by a prior get_transactions_live call.`
        );
      }
      if (!opts.start_date && !opts.end_date && !opts.period) {
        throw new Error(
          `transaction_id lookup in live mode also requires a date range (start_date, end_date, or period) to bound the search. Pass the date from the prior get_transactions_live result — the server has no single-transaction-by-id filter, so unbounded lookups paginate the whole account history.`
        );
      }
    }
  }
}

export function createLiveToolSchemas(): ToolSchema[] {
  return [
    {
      name: 'get_transactions_live',
      description:
        "Reads transactions live from Copilot's GraphQL API (requires --live-reads flag and network connectivity). Use this when the user asks about historical date ranges that may not be in the local cache, or when fresh data is required. Unlike get_transactions, the following filters are NOT supported and must not be included: city, lat, lon, radius_km, region, country, transaction_type=foreign, transaction_type=duplicates, and exclude_split_parents=false — any of these returns an error telling you to retry without the parameter. Single-transaction lookup requires transaction_id + account_id + item_id AND a date range (start_date, end_date, or period) — pass the transaction's date from the prior list result; the server has no single-row-by-id filter so unbounded lookups paginate the whole account. If the backend is unreachable, this tool returns an isError result; it does NOT fall back to the local cache.",
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description:
              'Period shorthand: this_month, last_month, last_7_days, last_30_days, last_90_days, ytd, this_year, last_year',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD)',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD)',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
          category: { type: 'string', description: 'Filter by category ID' },
          merchant: {
            type: 'string',
            description: 'Filter by merchant name (server-side matchString, substring match)',
          },
          account_id: { type: 'string', description: 'Filter by account ID' },
          item_id: {
            type: 'string',
            description:
              'Item ID paired with account_id. Required only when using transaction_id to fetch a single transaction.',
          },
          min_amount: {
            type: 'number',
            description: 'Minimum transaction amount (absolute value)',
          },
          max_amount: {
            type: 'number',
            description: 'Maximum transaction amount (absolute value)',
          },
          limit: {
            type: 'integer',
            description: 'Maximum results per page (default 100)',
            default: 100,
          },
          offset: {
            type: 'integer',
            description: 'Offset for pagination (default 0)',
            default: 0,
          },
          exclude_transfers: {
            type: 'boolean',
            description:
              'Exclude internal transfers between accounts (default: true). When true, filter types=[REGULAR, INCOME].',
            default: true,
          },
          exclude_deleted: {
            type: 'boolean',
            description:
              'Exclude deleted transactions (default: true). No-op in live mode — the server already excludes deleted rows.',
            default: true,
          },
          exclude_excluded: {
            type: 'boolean',
            description:
              'Exclude transactions in user-excluded categories (default: true). Cross-referenced against Category.isExcluded from the local cache.',
            default: true,
          },
          exclude_split_parents: {
            type: 'boolean',
            description:
              'Must be true or omitted — the server omits split parents from the transactions query. Passing false returns an error.',
            default: true,
          },
          pending: {
            type: 'boolean',
            description: 'Filter by pending status (true=pending only, false=settled only)',
          },
          transaction_id: {
            type: 'string',
            description:
              'Get one transaction by ID — REQUIRES account_id and item_id alongside (all three come from a previous get_transactions_live result).',
          },
          query: {
            type: 'string',
            description:
              'Free-text merchant search (server-side matchString). Equivalent to passing merchant.',
          },
          transaction_type: {
            type: 'string',
            enum: ['refunds', 'credits', 'hsa_eligible', 'tagged'],
            description:
              'Filter by special type. Note: foreign and duplicates are NOT supported in live mode.',
          },
          tag: {
            type: 'string',
            description: 'Filter by tag name (resolved to tagId via local cache)',
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
  ];
}
