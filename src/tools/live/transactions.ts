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
  ReadTransactionType,
  TransactionNode,
} from '../../core/graphql/queries/transactions.js';
import { fetchCategories } from '../../core/graphql/queries/categories.js';
import { fetchTags } from '../../core/graphql/queries/tags.js';
import type { ToolSchema, TransactionTypeFilter } from '../tools.js';
import {
  DEFAULT_TRANSACTION_FIELDS,
  TRANSACTION_FIELDS_PARAM_SCHEMA,
  projectRows,
} from '../field-selection.js';
import { normalizeMerchantName } from '../../utils/merchant.js';
import { parsePeriod } from '../../utils/date.js';

/**
 * Subset of `TRANSACTION_TYPE_FILTERS` supported in live mode (`foreign` and
 * `duplicates` are cache-only). The `satisfies` clause guarantees at compile
 * time that every entry is a valid cache-mode filter value.
 */
export const LIVE_TRANSACTION_TYPES = [
  'refunds',
  'credits',
  'hsa_eligible',
  'tagged',
] as const satisfies readonly TransactionTypeFilter[];
export type LiveTransactionType = (typeof LIVE_TRANSACTION_TYPES)[number];

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
  fields?: string[];
}

// A `type` alias (not an interface) on purpose: type aliases carry an
// implicit index signature, so rows assign to the field-selection engine's
// `Record<string, unknown>` constraint without casts.
export type EnrichedTransaction = {
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
};

interface PageResult {
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  // NOTE: when `fields` narrows the response, the actual objects carry fewer
  // keys than this type promises — that narrowing is opt-in, and the caller
  // who requested the subset already knows what they asked for (same
  // deliberate widening as cache-mode get_transactions).
  transactions: EnrichedTransaction[];
  // Requested `fields` names that matched nothing (typos, or cache-only
  // names like `excluded` that live rows don't carry), when any.
  _field_warning?: string;
}

export interface GetTransactionsLiveResult extends PageResult {
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
  _dropped_invalid_rows?: number;
}

/**
 * How each enriched (tool-facing, snake_case) field is computed from a raw
 * GraphQL TransactionNode. Single source of truth for the live row shape:
 * `enrich()` builds rows from it and {@link LIVE_TRANSACTION_KNOWN_FIELDS}
 * is `Object.keys()` of it, while the mapped type pins it 1:1 to the
 * `EnrichedTransaction` interface — adding, removing, or renaming a row
 * field here cannot desync projection's known-field set.
 */
const ENRICHED_FIELD_MAPPERS: {
  [K in keyof EnrichedTransaction]-?: (
    n: TransactionNode,
    catMap: Map<string, string>
  ) => EnrichedTransaction[K];
} = {
  transaction_id: (n) => n.id,
  account_id: (n) => n.accountId,
  item_id: (n) => n.itemId,
  category_id: (n) => n.categoryId,
  category_name: (n, catMap) => (n.categoryId ? catMap.get(n.categoryId) : undefined),
  recurring_id: (n) => n.recurringId,
  parent_transaction_id: (n) => n.parentId,
  amount: (n) => n.amount,
  date: (n) => n.date,
  name: (n) => n.name,
  normalized_merchant: (n) => normalizeMerchantName(n.name),
  type: (n) => n.type,
  user_reviewed: (n) => n.isReviewed,
  pending: (n) => n.isPending,
  user_notes: (n) => n.userNotes,
  tip_amount: (n) => n.tipAmount,
  suggested_category_ids: (n) => n.suggestedCategoryIds,
  iso_currency_code: (n) => n.isoCurrencyCode,
  tag_ids: (n) => n.tags.map((t) => t.id),
  created_timestamp: (n) => n.createdAt,
};

/**
 * Every selectable field name on a get_transactions_live row, derived from
 * the enrichment mapper record above (never hand-copied). 8 of the 10
 * {@link DEFAULT_TRANSACTION_FIELDS} preset names are present; `excluded`
 * and `internal_transfer` are cache-document-only (live models transfers
 * via `type === 'INTERNAL_TRANSFER'` and exclusion via Category.isExcluded).
 */
export const LIVE_TRANSACTION_KNOWN_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(ENRICHED_FIELD_MAPPERS)
);

/**
 * Mirror of the cache tool's projectTransactionFields: same engine, same
 * tokens, same `_field_warning`. No `compact` — it is being retired in v3;
 * the `"default"` token covers the need.
 */
function projectLiveTransactionFields(
  rows: EnrichedTransaction[],
  fields: string[] | undefined
): { rows: EnrichedTransaction[]; warning?: string } {
  return projectRows(rows, fields, {
    preset: DEFAULT_TRANSACTION_FIELDS,
    knownFields: LIVE_TRANSACTION_KNOWN_FIELDS,
    validFieldsHint:
      'the get_transactions_live row fields (including the enrichment fields category_name and ' +
      'normalized_merchant); excluded and internal_transfer exist only in cache-mode get_transactions',
  });
}

const UNSUPPORTED_KEYS = ['city', 'lat', 'lon', 'radius_km', 'region', 'country'] as const;

export class LiveTransactionsTools {
  constructor(private readonly live: LiveCopilotDatabase) {}

  private async getCategoryNameMap(): Promise<Map<string, string>> {
    const { rows } = await this.live.getCategoriesCache().read(async () => {
      // Same closure as LiveCategoriesTools — see resolveRolloversFlag()
      // and audit finding C6.
      const rollovers = await this.live.resolveRolloversFlag();
      return fetchCategories(this.live.getClient(), { rollovers });
    });
    const map = new Map<string, string>();
    for (const c of rows) {
      if (c.name) map.set(c.id, c.name);
    }
    return map;
  }

  async getTransactions(opts: GetTransactionsLiveOptions): Promise<GetTransactionsLiveResult> {
    this.validate(opts);

    if (opts.transaction_id) {
      return this.singleTransactionLookup(opts);
    }

    const [start_date, end_date] = opts.period
      ? parsePeriod(opts.period)
      : [opts.start_date, opts.end_date];

    if (!start_date || !end_date) {
      throw new Error(`Date range required: pass period, start_date, or end_date.`);
    }

    const {
      rows: nodes,
      oldest_fetched_at,
      newest_fetched_at,
      hit,
      dropped_invalid_rows,
    } = await this.live.getTransactions({ from: start_date, to: end_date });

    const filtered = await this.postFilter(nodes, opts);
    const page = await this.paginateAndEnrich(filtered, opts);
    return {
      ...page,
      _cache_oldest_fetched_at: new Date(oldest_fetched_at).toISOString(),
      _cache_newest_fetched_at: new Date(newest_fetched_at).toISOString(),
      _cache_hit: hit,
      ...(dropped_invalid_rows > 0 ? { _dropped_invalid_rows: dropped_invalid_rows } : {}),
    };
  }

  /**
   * Apply the opt-in `fields` projection to an enriched page. Runs AFTER
   * enrichment (the live analogue of cache mode's post-enrichment
   * projection) so category_name and normalized_merchant are selectable.
   */
  private static projectPage(page: PageResult, fields: string[] | undefined): PageResult {
    const projected = projectLiveTransactionFields(page.transactions, fields);
    return {
      ...page,
      transactions: projected.rows,
      ...(projected.warning && { _field_warning: projected.warning }),
    };
  }

  private async singleTransactionLookup(
    opts: GetTransactionsLiveOptions
  ): Promise<GetTransactionsLiveResult> {
    const [start_date, end_date] = opts.period
      ? parsePeriod(opts.period)
      : [opts.start_date, opts.end_date];
    if (!start_date || !end_date) {
      throw new Error(
        `transaction_id lookup requires a date range. Pass period, start_date, or end_date.`
      );
    }
    const {
      rows: nodes,
      oldest_fetched_at,
      newest_fetched_at,
      hit,
      dropped_invalid_rows,
    } = await this.live.getTransactions({ from: start_date, to: end_date });
    const fetchedAtIso = new Date(oldest_fetched_at).toISOString();
    const newestIso = new Date(newest_fetched_at).toISOString();
    // GraphQL guarantees the (id, accountId, itemId) triple is unique per transaction,
    // so find() returns at most one match. No tie-breaking needed.
    const match = nodes.find(
      (n) =>
        n.id === opts.transaction_id && n.accountId === opts.account_id && n.itemId === opts.item_id
    );
    if (!match) {
      return {
        count: 0,
        total_count: 0,
        offset: 0,
        has_more: false,
        transactions: [],
        _cache_oldest_fetched_at: fetchedAtIso,
        _cache_newest_fetched_at: newestIso,
        _cache_hit: hit,
        ...(dropped_invalid_rows > 0 ? { _dropped_invalid_rows: dropped_invalid_rows } : {}),
      };
    }
    const enriched = await this.enrich([match]);
    return {
      ...LiveTransactionsTools.projectPage(
        {
          count: 1,
          total_count: 1,
          offset: 0,
          has_more: false,
          transactions: enriched,
        },
        opts.fields
      ),
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: newestIso,
      _cache_hit: hit,
      ...(dropped_invalid_rows > 0 ? { _dropped_invalid_rows: dropped_invalid_rows } : {}),
    };
  }

  private async resolveTagIds(tagName: string): Promise<string[]> {
    const stripped = tagName.startsWith('#') ? tagName.slice(1) : tagName;
    const { rows: tags } = await this.live
      .getTagsCache()
      .read(() => fetchTags(this.live.getClient()));
    const lowered = stripped.toLowerCase();
    const match = tags.find((t) => t.name.toLowerCase() === lowered);
    if (!match) {
      throw new Error(
        `Tag '${tagName}' not found. Create the tag first or pass an existing tag name.`
      );
    }
    return [match.id];
  }

  private async postFilter(
    nodes: TransactionNode[],
    opts: GetTransactionsLiveOptions
  ): Promise<TransactionNode[]> {
    let result = nodes;

    // 1. types (exclude_transfers default true)
    if (opts.exclude_transfers !== false) {
      result = result.filter((n) => n.type !== 'INTERNAL_TRANSFER');
    }

    // 2. accountId
    if (opts.account_id !== undefined) {
      const id = opts.account_id;
      result = result.filter((n) => n.accountId === id);
    }

    // 3. categoryId
    if (opts.category !== undefined) {
      const cid = opts.category;
      result = result.filter((n) => n.categoryId === cid);
    }

    // 4. amount range
    if (opts.min_amount !== undefined) {
      const min = opts.min_amount;
      result = result.filter((n) => Math.abs(n.amount) >= min);
    }
    if (opts.max_amount !== undefined) {
      const max = opts.max_amount;
      result = result.filter((n) => Math.abs(n.amount) <= max);
    }

    // 5. pending
    if (opts.pending !== undefined) {
      result = result.filter((n) => n.isPending === opts.pending);
    }

    // 6. matchString (query precedence over merchant via ??; the !== '' guard
    // below also skips filtering when the value is an empty string).
    const needleRaw = opts.query ?? opts.merchant;
    if (needleRaw !== undefined && needleRaw !== '') {
      const needle = needleRaw.toLowerCase();
      result = result.filter((n) => n.name.toLowerCase().includes(needle));
    }

    // 7. tag (resolved name → id, then membership in n.tags[])
    if (opts.tag !== undefined) {
      const resolvedTagIds = new Set(await this.resolveTagIds(opts.tag));
      result = result.filter((n) => n.tags.some((t) => resolvedTagIds.has(t.id)));
    }

    // 8. exclude_excluded — reads categoriesCache directly rather than going
    // through getCategoryNameMap() because we need the `isExcluded` boolean,
    // not a name lookup. The cache hit shared with getCategoryNameMap() (when
    // both are called in the same request) keeps the cost minimal.
    if (opts.exclude_excluded !== false) {
      const { rows: cats } = await this.live.getCategoriesCache().read(async () => {
        // Same closure as LiveCategoriesTools — see resolveRolloversFlag()
        // and audit finding C6.
        const rollovers = await this.live.resolveRolloversFlag();
        return fetchCategories(this.live.getClient(), { rollovers });
      });
      const excludedCatIds = new Set(cats.filter((c) => c.isExcluded === true).map((c) => c.id));
      result = result.filter((n) => !n.categoryId || !excludedCatIds.has(n.categoryId));
    }

    // 9. transaction_type variants
    if (opts.transaction_type === 'tagged') {
      result = result.filter((n) => n.tags.length > 0);
    } else if (opts.transaction_type === 'refunds') {
      result = result.filter((n) => n.amount < 0);
    } else if (opts.transaction_type === 'credits') {
      result = result.filter((n) => n.amount < 0 && n.type === 'INCOME');
    } else if (opts.transaction_type === 'hsa_eligible') {
      const map = await this.getCategoryNameMap();
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
    return LiveTransactionsTools.projectPage(
      {
        count: enriched.length,
        total_count: total,
        offset,
        has_more: offset + limit < total,
        transactions: enriched,
      },
      opts.fields
    );
  }

  private async enrich(rows: TransactionNode[]): Promise<EnrichedTransaction[]> {
    const catMap = await this.getCategoryNameMap();
    return rows.map((n) => {
      const row: Record<string, unknown> = {};
      // Object.entries widens per-key types, so the cast below leans on the
      // mapped-type constraint at ENRICHED_FIELD_MAPPERS' declaration, which
      // already proved the record covers every EnrichedTransaction key.
      for (const [key, map] of Object.entries(ENRICHED_FIELD_MAPPERS)) {
        row[key] = map(n, catMap);
      }
      return row as EnrichedTransaction;
    });
  }

  private validate(opts: GetTransactionsLiveOptions): void {
    const o = opts as Record<string, unknown>;
    const supported = `start_date, end_date, period, account_id (+ item_id), category, merchant, query, tag, min_amount, max_amount, limit, offset, pending, exclude_transfers, exclude_deleted, exclude_excluded, transaction_type (${LIVE_TRANSACTION_TYPES.join(', ')}), transaction_id (+ account_id + item_id), fields`;

    for (const key of UNSUPPORTED_KEYS) {
      if (o[key] !== undefined) {
        throw new Error(
          `Parameter '${key}' is not supported in live mode. Retry without '${key}'. Supported filters: ${supported}.`
        );
      }
    }

    if (
      opts.transaction_type !== undefined &&
      !(LIVE_TRANSACTION_TYPES as readonly string[]).includes(opts.transaction_type)
    ) {
      throw new Error(
        `Parameter 'transaction_type=${opts.transaction_type}' is not supported in live mode. Retry with one of: ${LIVE_TRANSACTION_TYPES.join(', ')}.`
      );
    }

    if (opts.exclude_split_parents === false) {
      throw new Error(
        `Parameter 'exclude_split_parents=false' is not supported in live mode — the GraphQL server omits split parents. Retry without 'exclude_split_parents' or set it to true.`
      );
    }

    if (opts.exclude_deleted === false) {
      throw new Error(
        `Parameter 'exclude_deleted=false' is not supported in live mode — the GraphQL server omits deleted transactions. Retry without 'exclude_deleted' or set it to true.`
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

    if (
      (opts.query !== undefined || opts.merchant !== undefined) &&
      !opts.start_date &&
      !opts.end_date &&
      !opts.period
    ) {
      throw new Error(
        `Query/merchant searches in live mode require a date range. Pass period (e.g. period: 'this_year') or start_date + end_date.`
      );
    }
  }
}

/**
 * Single-schema factory matching the other live modules' pattern
 * (`createLiveAccountsToolSchema`, etc.).
 */
export function createLiveTransactionsToolSchema(): ToolSchema {
  return {
    name: 'get_transactions_live',
    description:
      "Read and filter transactions live from Copilot's GraphQL API — the right tool for any " +
      'spending lookup by category, merchant, date, or amount; sum the returned `amount` values ' +
      'to total spending. Filters: `category` (a category ID from get_categories_live), ' +
      '`merchant`/`query`, date range (`period` or `start_date`/`end_date`), ' +
      '`min_amount`/`max_amount`, `account_id`, `tag`, `pending`. Requires --live-reads and ' +
      'network connectivity. NOT supported (each returns an error telling you to retry without ' +
      'it): city, lat, lon, radius_km, region, country, transaction_type foreign/duplicates, ' +
      'exclude_split_parents=false, exclude_deleted=false. Single-transaction lookup requires ' +
      'transaction_id + account_id + item_id AND a date range — the server has no ' +
      "single-row-by-id filter, so pass the transaction's date from the prior list result; " +
      'unbounded lookups would paginate the whole account. Rows are ~20 fields wide; pass ' +
      'fields: [...] to trim each row to just the named fields — note excluded and ' +
      'internal_transfer exist only in cache mode, so the "default" baseline yields 8 fields ' +
      'here. If the backend is unreachable this returns an isError result; it does NOT fall ' +
      'back to the local cache.',
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
          description: 'Item ID paired with account_id; required only for transaction_id lookups.',
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
            'Exclude internal transfers between accounts (default: true; filters types to REGULAR/INCOME).',
          default: true,
        },
        exclude_deleted: {
          type: 'boolean',
          description:
            'Must be true or omitted — the server already excludes deleted transactions; false errors.',
          default: true,
        },
        exclude_excluded: {
          type: 'boolean',
          description:
            'Exclude transactions in user-excluded categories (default: true; checked against Category.isExcluded from the local cache).',
          default: true,
        },
        exclude_split_parents: {
          type: 'boolean',
          description:
            'Must be true or omitted — the server already omits split parents; false errors.',
          default: true,
        },
        pending: {
          type: 'boolean',
          description: 'Filter by pending status (true=pending only, false=settled only)',
        },
        transaction_id: {
          type: 'string',
          description:
            'Get one transaction by ID — REQUIRES account_id, item_id, and a date range alongside (all from a previous result).',
        },
        query: {
          type: 'string',
          description:
            'Free-text merchant search (server-side matchString); equivalent to merchant.',
        },
        transaction_type: {
          type: 'string',
          enum: [...LIVE_TRANSACTION_TYPES],
          description: 'Filter by special type (foreign/duplicates are cache-only).',
        },
        tag: {
          type: 'string',
          description: 'Filter by tag name (resolved to tagId via local cache)',
        },
        // Shared verbatim with cache-mode get_transactions — parity pinned by
        // tests. Note: the baseline names `excluded` and `internal_transfer`
        // are cache-document-only and absent from live rows.
        fields: TRANSACTION_FIELDS_PARAM_SCHEMA,
      },
    },
    annotations: { readOnlyHint: true },
  };
}

export function createLiveToolSchemas(): ToolSchema[] {
  return [createLiveTransactionsToolSchema()];
}
