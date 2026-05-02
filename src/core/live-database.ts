/**
 * Live-read data layer backed by Copilot's GraphQL API.
 *
 * This class is the planned long-term replacement for CopilotDatabase
 * once every read tool has migrated off LevelDB. Phase 1 implements
 * only getTransactions(); later phases add methods for accounts,
 * categories, budgets, recurring, and tags.
 *
 * The class owns cross-cutting concerns shared by every method:
 *   - short-lived result memoization (default 5 min TTL)
 *   - one retry on NETWORK errors (other GraphQL codes surface)
 *   - optional verbose logging to stderr for latency measurement
 *
 * Phase 2 adds tiered-cache primitives (SnapshotCache per entity type +
 * TransactionWindowCache for month-keyed transaction windows) and
 * 10 write-through patchLive* methods so mutations can update the cache
 * without requiring a full refresh.
 *
 * See docs/superpowers/specs/2026-04-23-graphql-live-reads-design.md.
 * See docs/superpowers/plans/2026-04-25-graphql-live-tiered-cache.md.
 */

import { randomUUID } from 'crypto';
import { GraphQLError, type GraphQLClient } from './graphql/client.js';
import type { CopilotDatabase } from './database.js';
import {
  buildTransactionFilter,
  buildTransactionSort,
  fetchTransactionsPage,
  paginateTransactions,
  type BuildFilterOptions,
  type TransactionNode,
  type TransactionSortInput,
} from './graphql/queries/transactions.js';
import {
  InFlightRegistry,
  SnapshotCache,
  TransactionWindowCache,
  type CachedTransaction,
} from './cache/index.js';
import type { AccountNode } from './graphql/queries/accounts.js';
import type { Category, Tag, Budget, Recurring, Transaction } from '../models/index.js';

interface MemoEntry<T> {
  result: T;
  at: number;
}

export interface LiveDatabaseOptions {
  memoTtlMs?: number;
  verbose?: boolean;
}

const DEFAULT_MEMO_TTL_MS = 5 * 60 * 1000;
const RETRY_BACKOFF_MS = 500;

const ONE_HOUR_MS = 60 * 60 * 1000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;
const DEFAULT_MAX_TX_ROWS = 20_000;

export class LiveCopilotDatabase {
  // existing fields
  private readonly memoTtlMs: number;
  private readonly verbose: boolean;
  private readonly memoStore: Map<string, MemoEntry<unknown>> = new Map();

  // Phase 2: tiered-cache primitives
  private readonly inflight: InFlightRegistry;
  // Typed on AccountNode (GraphQL response shape) rather than the
  // LevelDB Account model. The live cache stores what the live read
  // path produces; tools that consume both shapes can map between
  // them at the call site if needed.
  private readonly accountsCache: SnapshotCache<AccountNode>;
  private readonly categoriesCache: SnapshotCache<Category>;
  private readonly tagsCache: SnapshotCache<Tag>;
  private readonly budgetsCache: SnapshotCache<Budget>;
  private readonly recurringCache: SnapshotCache<Recurring>;
  private readonly transactionsWindowCache: TransactionWindowCache<CachedTransaction>;

  constructor(
    private readonly graphql: GraphQLClient,
    private readonly cache: CopilotDatabase,
    opts: LiveDatabaseOptions = {}
  ) {
    this.memoTtlMs = opts.memoTtlMs ?? DEFAULT_MEMO_TTL_MS;
    this.verbose = opts.verbose ?? false;

    this.inflight = new InFlightRegistry();
    this.accountsCache = new SnapshotCache<AccountNode>(
      { key: 'accounts', ttlMs: ONE_HOUR_MS, keyFn: (a) => a.id },
      this.inflight
    );
    this.categoriesCache = new SnapshotCache<Category>(
      { key: 'categories', ttlMs: ONE_DAY_MS, keyFn: (c) => c.category_id },
      this.inflight
    );
    this.tagsCache = new SnapshotCache<Tag>(
      { key: 'tags', ttlMs: ONE_DAY_MS, keyFn: (t) => t.tag_id },
      this.inflight
    );
    this.budgetsCache = new SnapshotCache<Budget>(
      { key: 'budgets', ttlMs: ONE_HOUR_MS, keyFn: (b) => b.category_id ?? b.budget_id },
      this.inflight
    );
    this.recurringCache = new SnapshotCache<Recurring>(
      { key: 'recurring', ttlMs: SIX_HOURS_MS, keyFn: (r) => r.recurring_id },
      this.inflight
    );
    this.transactionsWindowCache = new TransactionWindowCache<CachedTransaction>(
      {
        liveTtlMs: 0,
        coldTtlMs: ONE_WEEK_MS,
        maxRows: DEFAULT_MAX_TX_ROWS,
      },
      this.inflight
    );
  }

  /**
   * Expose the underlying GraphQL client for functions that take it
   * as an argument (e.g. fetchTransactionsPage).
   */
  getClient(): GraphQLClient {
    return this.graphql;
  }

  /**
   * Expose the cache so tool implementations can use it for
   * account→item and tag-name→tag-id lookups until Phase 2 migrates
   * those reads onto the live layer too.
   */
  getCache(): CopilotDatabase {
    return this.cache;
  }

  async withRetry<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (err instanceof GraphQLError && err.code === 'NETWORK') {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
        return await op();
      }
      throw err;
    }
  }

  async memoize<T>(
    key: string,
    loader: () => Promise<T>
  ): Promise<{ result: T; fetched_at: number; hit: boolean }> {
    const existing = this.memoStore.get(key);
    if (existing && Date.now() - existing.at < this.memoTtlMs) {
      return { result: existing.result as T, fetched_at: existing.at, hit: true };
    }
    const result = await loader();
    const at = Date.now();
    this.memoStore.set(key, { result, at });
    return { result, fetched_at: at, hit: false };
  }

  logReadCall(log: {
    op: string;
    pages: number;
    latencyMs: number;
    rows: number;
    ttl_tier?: 'live' | 'cold';
    cache_hit?: boolean;
    staleness_ms?: number | null;
    month?: string;
  }): void {
    if (!this.verbose) return;
    const parts = [
      `[graphql-read]`,
      `op=${log.op}`,
      log.ttl_tier !== undefined ? `ttl_tier=${log.ttl_tier}` : null,
      log.cache_hit !== undefined ? `cache_hit=${log.cache_hit}` : null,
      `pages=${log.pages}`,
      `latency=${log.latencyMs}ms`,
      `rows=${log.rows}`,
      log.month ? `month=${log.month}` : null,
      log.staleness_ms !== undefined ? `staleness_ms=${log.staleness_ms ?? 'null'}` : null,
    ].filter(Boolean);
    console.error(parts.join(' '));
  }

  /**
   * Fetch transactions from Copilot's GraphQL API, paginating with
   * DATE DESC sort and early-exiting when the trailing row precedes
   * the requested start date.
   *
   * Pure data access — client-side post-filtering (amount range,
   * pending, excluded-category join, special transaction_type
   * variants) lives in the tool layer, not here.
   */
  async getTransactions(
    opts: BuildFilterOptions & { sort?: TransactionSortInput; pageSize?: number }
  ): Promise<{ rows: TransactionNode[]; fetched_at: number; hit: boolean }> {
    const filter = buildTransactionFilter(opts);
    const sort = buildTransactionSort(opts.sort);
    const first = opts.pageSize ?? 100;

    const memoKey = JSON.stringify({ filter, sort, first });
    const memoResult = await this.memoize(memoKey, async () => {
      let pages = 0;
      const startedAt = Date.now();
      const rows = await paginateTransactions(
        (after) =>
          this.withRetry(async () => {
            pages += 1;
            return fetchTransactionsPage(this.graphql, { first, after, filter, sort });
          }),
        { startDate: opts.startDate }
      );
      this.logReadCall({
        op: 'Transactions',
        pages,
        latencyMs: Date.now() - startedAt,
        rows: rows.length,
        cache_hit: false, // pure miss path; cache hits short-circuit before this loader runs
      });
      return rows;
    });
    return {
      rows: memoResult.result,
      fetched_at: memoResult.fetched_at,
      hit: memoResult.hit,
    };
  }

  // ── Phase 2: cache accessors ──────────────────────────────────────────────

  getAccountsCache(): SnapshotCache<AccountNode> {
    return this.accountsCache;
  }

  getCategoriesCache(): SnapshotCache<Category> {
    return this.categoriesCache;
  }

  getTagsCache(): SnapshotCache<Tag> {
    return this.tagsCache;
  }

  getBudgetsCache(): SnapshotCache<Budget> {
    return this.budgetsCache;
  }

  getRecurringCache(): SnapshotCache<Recurring> {
    return this.recurringCache;
  }

  getTransactionsWindowCache(): TransactionWindowCache<CachedTransaction> {
    return this.transactionsWindowCache;
  }

  // ── Phase 2: write-through patch methods ─────────────────────────────────

  /**
   * Patch a cached transaction by id. Locates the row across all cached
   * months, merges the provided fields, and upserts the result. No-op if
   * the row is not currently cached.
   */
  patchLiveTransaction(id: string, fields: Partial<Transaction>): void {
    let existing: CachedTransaction | undefined;
    for (const month of this.transactionsWindowCache.cachedMonths()) {
      const row = this.transactionsWindowCache.entriesForMonth(month).find((r) => r.id === id);
      if (row) {
        existing = row;
        break;
      }
    }
    if (!existing) return;
    const merged = { ...existing, ...fields, id } as CachedTransaction;
    this.transactionsWindowCache.upsert(merged);
  }

  /** Remove a cached transaction by id. No-op if not found. */
  patchLiveTransactionDelete(id: string): void {
    this.transactionsWindowCache.delete(id);
  }

  /**
   * Upsert a synthetic Budget into the budgets snapshot cache.
   * Keyed by category_id. The next real cache refill will overwrite.
   *
   * @param month - YYYY-MM key for the amounts map; defaults to current month.
   */
  patchLiveBudget(categoryId: string, amount: number, month?: string): void {
    const monthKey =
      month ??
      (() => {
        // UTC matches monthAge() / monthsCovered() in date.ts. Using
        // local time would be off by ~12h at month boundaries in
        // negative UTC offsets (e.g., late Jan 31 in UTC-8 is already
        // Feb 1 UTC), producing a budget bucket that doesn't match
        // the cache's tier-classification basis.
        const d = new Date();
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      })();
    // Use a UUID for budget_id (matches patchCachedBudget on CopilotDatabase
    // — both paths surface the same shape so paired writes at Task 6 sites
    // don't produce divergent results across the LevelDB and live caches).
    const synthetic: Budget = {
      budget_id: randomUUID(),
      category_id: categoryId,
      amounts: { [monthKey]: amount },
    };
    this.budgetsCache.upsert(synthetic);
  }

  patchLiveTagUpsert(tag: Tag): void {
    this.tagsCache.upsert(tag);
  }

  patchLiveTagDelete(id: string): void {
    this.tagsCache.delete(id);
  }

  patchLiveCategoryUpsert(category: Category): void {
    this.categoriesCache.upsert(category);
  }

  patchLiveCategoryDelete(id: string): void {
    this.categoriesCache.delete(id);
  }

  patchLiveRecurringUpsert(recurring: Recurring): void {
    this.recurringCache.upsert(recurring);
  }

  patchLiveRecurringDelete(id: string): void {
    this.recurringCache.delete(id);
  }
}

/**
 * Validate that the live-reads auth path works end-to-end before
 * registering any live tools. Sends one cheap GraphQL query that
 * exercises token extraction → Firebase exchange → endpoint →
 * schema validity → permission. Any failure is fatal; callers
 * should log and exit non-zero, not register a dead tool.
 */
export async function preflightLiveAuth(client: GraphQLClient): Promise<void> {
  await fetchTransactionsPage(client, {
    first: 1,
    after: null,
    filter: null,
    sort: buildTransactionSort(),
  });
}
