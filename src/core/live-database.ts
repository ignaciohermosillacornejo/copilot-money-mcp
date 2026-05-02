/**
 * Live-read data layer backed by Copilot's GraphQL API.
 *
 * This class is the planned long-term replacement for CopilotDatabase
 * once every read tool has migrated off LevelDB. Phase 1 implements
 * only getTransactions(); later phases add methods for accounts,
 * categories, budgets, recurring, and tags.
 *
 * The class owns cross-cutting concerns shared by every method:
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
  type TransactionNode,
  type TransactionSortInput,
} from './graphql/queries/transactions.js';
import { getMonthRange, monthsCovered } from '../utils/date.js';
import { pLimit } from '../utils/concurrency.js';
import { InFlightRegistry, SnapshotCache, TransactionWindowCache } from './cache/index.js';
import type { AccountNode } from './graphql/queries/accounts.js';
import type { CategoryNode } from './graphql/queries/categories.js';
import type { Tag, Budget, Recurring, Transaction } from '../models/index.js';

export interface LiveDatabaseOptions {
  verbose?: boolean;
}

const RETRY_BACKOFF_MS = 500;

const ONE_HOUR_MS = 60 * 60 * 1000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;
const DEFAULT_MAX_TX_ROWS = 20_000;

export class LiveCopilotDatabase {
  private readonly verbose: boolean;

  // Phase 2: tiered-cache primitives
  private readonly inflight: InFlightRegistry;
  private readonly fetchLimit: ReturnType<typeof pLimit>;
  // Typed on AccountNode (GraphQL response shape) rather than the
  // LevelDB Account model. The live cache stores what the live read
  // path produces; tools that consume both shapes can map between
  // them at the call site if needed.
  private readonly accountsCache: SnapshotCache<AccountNode>;
  private readonly categoriesCache: SnapshotCache<CategoryNode>;
  private readonly tagsCache: SnapshotCache<Tag>;
  private readonly budgetsCache: SnapshotCache<Budget>;
  private readonly recurringCache: SnapshotCache<Recurring>;
  private readonly transactionsWindowCache: TransactionWindowCache<TransactionNode>;

  constructor(
    private readonly graphql: GraphQLClient,
    private readonly cache: CopilotDatabase,
    opts: LiveDatabaseOptions = {}
  ) {
    this.verbose = opts.verbose ?? false;

    this.inflight = new InFlightRegistry();
    this.fetchLimit = pLimit(4);
    this.accountsCache = new SnapshotCache<AccountNode>(
      { key: 'accounts', ttlMs: ONE_HOUR_MS, keyFn: (a) => a.id },
      this.inflight
    );
    this.categoriesCache = new SnapshotCache<CategoryNode>(
      { key: 'categories', ttlMs: ONE_DAY_MS, keyFn: (c) => c.id },
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
    this.transactionsWindowCache = new TransactionWindowCache<TransactionNode>(
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

  /**
   * Fetch + paginate one month of transactions; ingest into the
   * window cache; return the rows along with the timestamp the
   * fetch was initiated and the page count.
   */
  private async fetchMonth(
    month: string,
    sort: TransactionSortInput[],
    pageSize: number
  ): Promise<{ rows: TransactionNode[]; fetched_at: number; pages: number }> {
    const year = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    const [monthStart, monthEnd] = getMonthRange(year, m);
    const filter = buildTransactionFilter({ startDate: monthStart, endDate: monthEnd });
    const fetched_at = Date.now();
    let pages = 0;
    const rawRows = await paginateTransactions(
      (after) =>
        this.withRetry(async () => {
          pages += 1;
          return fetchTransactionsPage(this.graphql, { first: pageSize, after, filter, sort });
        }),
      { startDate: monthStart }
    );
    // Trim leaked tail-page rows that fall outside this month's window.
    // `paginateTransactions` early-exits AFTER appending a page, so the
    // trailing edge of the last page can dip into the previous month.
    // Without this trim, those rows pollute the wrong cache bucket and
    // get double-counted on subsequent full-range queries.
    const rows = rawRows.filter((r) => r.date >= monthStart && r.date <= monthEnd);
    this.transactionsWindowCache.ingestMonth(month, rows, fetched_at);
    return { rows, fetched_at, pages };
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
    from_to_months?: number;
    fetched_months?: number;
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
      log.from_to_months !== undefined ? `from_to_months=${log.from_to_months}` : null,
      log.fetched_months !== undefined ? `fetched_months=${log.fetched_months}` : null,
      log.staleness_ms !== undefined ? `staleness_ms=${log.staleness_ms ?? 'null'}` : null,
    ].filter(Boolean);
    console.error(parts.join(' '));
  }

  /**
   * Fetch transactions for a date range, backed by the month-keyed
   * window cache. Live-tier months (≤14d age) refetch unconditionally;
   * older months come from cache or trigger a per-month fetch.
   *
   * Concurrent month fetches are capped at 4 in flight (`pLimit(4)`)
   * and coalesced across callers via `InFlightRegistry` keyed on
   * `tx:<YYYY-MM>`.
   *
   * Returns rows sorted (date DESC, createdAt DESC, id DESC) with a
   * freshness envelope reflecting the per-month `fetched_at` distribution.
   */
  async getTransactions(
    range: { from: string; to: string },
    sort?: TransactionSortInput,
    opts?: { pageSize?: number }
  ): Promise<{
    rows: TransactionNode[];
    oldest_fetched_at: number;
    newest_fetched_at: number;
    hit: boolean;
  }> {
    if (!range.from || !range.to) {
      throw new Error(
        `getTransactions requires both from and to (got from='${range.from}', to='${range.to}')`
      );
    }
    if (range.from > range.to) {
      throw new Error(`getTransactions: from (${range.from}) must be <= to (${range.to})`);
    }

    const sortArr = buildTransactionSort(sort);
    const pageSize = opts?.pageSize ?? 100;
    const now = new Date();

    const { cachedRows, toFetch } = this.transactionsWindowCache.plan(range, now);

    const startedAt = Date.now();
    let totalPages = 0;

    const settled = await Promise.allSettled(
      toFetch.map((month) =>
        this.fetchLimit(() =>
          this.inflight.run(`tx:${month}`, async () => {
            const result = await this.fetchMonth(month, sortArr, pageSize);
            totalPages += result.pages;
            return { month, ...result };
          })
        )
      )
    );

    const failures: Array<{ month: string; reason: unknown }> = [];
    const successes: Array<{ month: string; rows: TransactionNode[]; fetched_at: number }> = [];
    for (let i = 0; i < settled.length; i += 1) {
      const s = settled[i]!;
      if (s.status === 'fulfilled') {
        successes.push(s.value);
      } else {
        failures.push({ month: toFetch[i]!, reason: s.reason });
      }
    }
    if (failures.length > 0) {
      const summary = failures
        .map((f) => `${f.month}: ${(f.reason as Error)?.message ?? String(f.reason)}`)
        .join('; ');
      throw new Error(`Failed to fetch months: ${summary}`);
    }

    const freshRows = successes.flatMap((s) => s.rows);
    const merged = [...cachedRows, ...freshRows].filter(
      (r) => r.date >= range.from && r.date <= range.to
    );
    merged.sort(
      (a, b) =>
        b.date.localeCompare(a.date) || b.createdAt - a.createdAt || b.id.localeCompare(a.id)
    );

    // Freshness envelope: walk every month in the requested range and
    // collect its current fetched_at. (After ingest, all months are
    // present; live-tier and just-fetched months reflect "now".)
    const allMonths = monthsCovered(range);
    const fetchedAts: number[] = [];
    for (const m of allMonths) {
      const ts = this.transactionsWindowCache.getFetchedAt(m);
      if (ts !== undefined) fetchedAts.push(ts);
    }
    const oldest = fetchedAts.length ? Math.min(...fetchedAts) : Date.now();
    const newest = fetchedAts.length ? Math.max(...fetchedAts) : Date.now();
    const hit = toFetch.length === 0;

    this.logReadCall({
      op: 'Transactions',
      pages: totalPages,
      latencyMs: Date.now() - startedAt,
      rows: merged.length,
      cache_hit: hit,
      from_to_months: allMonths.length,
      fetched_months: toFetch.length,
    });

    return { rows: merged, oldest_fetched_at: oldest, newest_fetched_at: newest, hit };
  }

  // ── Phase 2: cache accessors ──────────────────────────────────────────────

  getAccountsCache(): SnapshotCache<AccountNode> {
    return this.accountsCache;
  }

  getCategoriesCache(): SnapshotCache<CategoryNode> {
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

  getTransactionsWindowCache(): TransactionWindowCache<TransactionNode> {
    return this.transactionsWindowCache;
  }

  // ── Phase 2: write-through patch methods ─────────────────────────────────

  /**
   * Patch a cached transaction by id. Locates the row across all cached
   * months, merges the provided fields, and upserts the result. No-op if
   * the row is not currently cached.
   */
  patchLiveTransaction(id: string, fields: Partial<Transaction>): void {
    let existing: TransactionNode | undefined;
    for (const month of this.transactionsWindowCache.cachedMonths()) {
      const row = this.transactionsWindowCache.entriesForMonth(month).find((r) => r.id === id);
      if (row) {
        existing = row;
        break;
      }
    }
    if (!existing) return;
    const merged: TransactionNode = { ...existing, ...fields, id };
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

  patchLiveCategoryUpsert(category: CategoryNode): void {
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
