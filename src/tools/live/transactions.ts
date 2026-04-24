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
import type { ReadTransactionType } from '../../core/graphql/queries/transactions.js';

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

export interface GetTransactionsLiveResult {
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  transactions: EnrichedTransaction[];
}

const UNSUPPORTED_KEYS = ['city', 'lat', 'lon', 'radius_km', 'region', 'country'] as const;

export class LiveTransactionsTools {
  constructor(private readonly live: LiveCopilotDatabase) {}

  getTransactions(opts: GetTransactionsLiveOptions): Promise<GetTransactionsLiveResult> {
    try {
      this.validate(opts);
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(err);
    }
    // Filter translation + fetch + post-filter + enrichment lands in Task 8.
    // Phase-1 placeholder: empty result so validation tests can pass.
    // TODO(Task 8): Use this.live to fetch from GraphQL.
    void this.live;
    return Promise.resolve({
      count: 0,
      total_count: 0,
      offset: 0,
      has_more: false,
      transactions: [],
    });
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
    }
  }
}
