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
import type { TagNode } from './graphql/queries/tags.js';
import type { RecurringNode } from './graphql/queries/recurrings.js';
import type { NetworthHistoryNode } from './graphql/queries/networth.js';
import type { UpcomingRecurringNode } from './graphql/queries/upcoming-recurrings.js';
import type { DailySpendNode } from './graphql/queries/monthly-spend.js';
import { fetchUser, type UserNode } from './graphql/queries/user.js';
import type { Transaction } from '../models/index.js';

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
  // GraphQL-typed caches (accountsCache, categoriesCache, tagsCache) are typed
  // on the GraphQL response shape (AccountNode, CategoryNode, TagNode), NOT the
  // LevelDB models (Account, Category, Tag). The live cache stores what the
  // live read path produces; tools that consume both shapes can map between
  // them at the call site if needed. Future GraphQL-backed caches added below
  // should follow the same convention.
  private readonly accountsCache: SnapshotCache<AccountNode>;
  private readonly categoriesCache: SnapshotCache<CategoryNode>;
  private readonly tagsCache: SnapshotCache<TagNode>;
  private readonly recurringCache: SnapshotCache<RecurringNode>;
  // upcomingRecurringsCache holds the "about-to-bill" view (next-due
  // unpaid items). Distinct from recurringCache (configured/historical
  // view). Short 1h TTL because items move out of this view as bills get
  // paid throughout the day.
  private readonly upcomingRecurringsCache: SnapshotCache<UpcomingRecurringNode>;
  // userCache always holds at most one row — the current user — but we use the
  // SnapshotCache primitive uniformly with the rest of the entities so the
  // refresh-cache and TTL machinery works without a special case. `keyFn` keys
  // on the user id.
  private readonly userCache: SnapshotCache<UserNode>;
  // networthCache holds the most-recently-requested timeFrame's history.
  // Requests for a different timeFrame trigger a fresh fetch (the cache is
  // not partitioned by timeFrame to keep the SnapshotCache primitive simple);
  // the 1h TTL still applies to the most-recently-requested timeFrame.
  private readonly networthCache: SnapshotCache<NetworthHistoryNode>;
  private readonly monthlySpendCache: SnapshotCache<DailySpendNode>;
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
    this.tagsCache = new SnapshotCache<TagNode>(
      { key: 'tags', ttlMs: ONE_DAY_MS, keyFn: (t) => t.id },
      this.inflight
    );
    this.recurringCache = new SnapshotCache<RecurringNode>(
      { key: 'recurring', ttlMs: SIX_HOURS_MS, keyFn: (r) => r.id },
      this.inflight
    );
    this.upcomingRecurringsCache = new SnapshotCache<UpcomingRecurringNode>(
      { key: 'upcoming_recurrings', ttlMs: ONE_HOUR_MS, keyFn: (r) => r.id },
      this.inflight
    );
    this.userCache = new SnapshotCache<UserNode>(
      { key: 'user', ttlMs: ONE_DAY_MS, keyFn: (u) => u.id },
      this.inflight
    );
    // keyFn assumes the upstream Networth query returns at most one row per
    // date (true today — daily snapshots). If a future schema change ever
    // returns multiple rows per date (e.g., intraday), upsert() would
    // silently overwrite the first match. No write-through patches exist
    // for networth today, so this is latent — but worth pinning the
    // assumption here for future maintainers.
    this.networthCache = new SnapshotCache<NetworthHistoryNode>(
      { key: 'networth', ttlMs: ONE_HOUR_MS, keyFn: (n) => n.date },
      this.inflight
    );
    this.monthlySpendCache = new SnapshotCache<DailySpendNode>(
      { key: 'monthly_spend', ttlMs: ONE_HOUR_MS, keyFn: (d) => d.id },
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

  getTagsCache(): SnapshotCache<TagNode> {
    return this.tagsCache;
  }

  getRecurringCache(): SnapshotCache<RecurringNode> {
    return this.recurringCache;
  }

  getUpcomingRecurringsCache(): SnapshotCache<UpcomingRecurringNode> {
    return this.upcomingRecurringsCache;
  }

  getUserCache(): SnapshotCache<UserNode> {
    return this.userCache;
  }

  getNetworthCache(): SnapshotCache<NetworthHistoryNode> {
    return this.networthCache;
  }

  getMonthlySpendCache(): SnapshotCache<DailySpendNode> {
    return this.monthlySpendCache;
  }

  /**
   * Resolve the user's effective rollovers flag for the Categories query.
   *
   * Reads the user record (cached for 24h via userCache) and projects
   * `budgetingConfig.rolloversConfig.isEnabled` down to a boolean. Mirrors
   * the web app's per-user behavior — the web reads the same field and
   * forwards it to the same Categories query (audit finding C6).
   *
   * Defensive fallback: if `budgetingConfig.isEnabled === false` (budgeting
   * fully off) or any layer of the config tree is null, returns `false` —
   * passing `rollovers: true` when budgeting is off would warm the cache
   * with rollover effects the user can't see anywhere in the product.
   *
   * Used by every consumer of categoriesCache (LiveCategoriesTools,
   * LiveBudgetsTools, LiveTransactionsTools.getCategoryNameMap) so the
   * cached payload is consistent regardless of which tool warms the cache
   * first.
   */
  async resolveRolloversFlag(): Promise<boolean> {
    const { rows } = await this.userCache.read(() =>
      fetchUser(this.graphql).then((user) => [user])
    );
    const user = rows[0];
    return (
      user?.budgetingConfig?.isEnabled === true &&
      user.budgetingConfig.rolloversConfig?.isEnabled === true
    );
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

  patchLiveTagUpsert(tag: TagNode): void {
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

  /**
   * Update the cached category's budget slot. Peeks the cached category, mutates
   * either `budget.current` (when month matches current month or is omitted) or
   * `budget.histories[month]` (replace existing or insert new), then upserts.
   * No-op if the category is not currently cached — the next get_budgets_live or
   * get_categories_live call will refetch with the fresh value from the EditBudget
   * mutation that already succeeded.
   */
  patchLiveCategoryBudget(categoryId: string, amount: number, month?: string): void {
    const cached = this.categoriesCache.peek()?.find((c) => c.id === categoryId);
    if (!cached) return;

    // Compute current UTC month once (shared by both monthKey defaulting and
    // current-synthesis logic). UTC matches monthAge() / monthsCovered() in
    // date.ts. Local time would be off by ~12h at month boundaries in negative
    // UTC offsets.
    const todayMonth = (() => {
      const d = new Date();
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    })();
    const monthKey = month ?? todayMonth;
    const amountStr = String(amount);

    const existingBudget = cached.budget ?? { current: null, histories: [] };

    // Decide where the patch lands:
    // - If a `current` entry exists for the patched month → update its amount
    // - Else if the patched month IS the current month → synthesize a fresh `current`
    //   (do NOT also write histories — that would create a semantically inconsistent
    //   state where both current and a same-month history entry exist)
    // - Else → upsert in `histories[]` (replace existing entry by month, or push new)
    let newCurrent = existingBudget.current;
    let newHistories = existingBudget.histories;

    if (existingBudget.current?.month === monthKey) {
      newCurrent = { ...existingBudget.current, amount: amountStr };
    } else if (monthKey === todayMonth) {
      // Patch targets current month but no `current` existed — synthesize one.
      newCurrent = {
        unassignedRolloverAmount: null,
        childRolloverAmount: null,
        unassignedAmount: null,
        resolvedAmount: amountStr,
        rolloverAmount: null,
        childAmount: null,
        goalAmount: amountStr,
        amount: amountStr,
        month: monthKey,
        id: `${categoryId}-${monthKey}-current-synthetic`,
      };
    } else {
      // Patch targets a non-current month → write to histories.
      const idx = newHistories.findIndex((h) => h.month === monthKey);
      if (idx >= 0) {
        newHistories = [...newHistories];
        newHistories[idx] = { ...newHistories[idx]!, amount: amountStr };
      } else {
        // Insert minimal new history entry. Other monthly fields default to null.
        newHistories = [
          ...newHistories,
          {
            unassignedRolloverAmount: null,
            childRolloverAmount: null,
            unassignedAmount: null,
            resolvedAmount: amountStr,
            rolloverAmount: null,
            childAmount: null,
            goalAmount: amountStr,
            amount: amountStr,
            month: monthKey,
            id: `${categoryId}-${monthKey}-synthetic`,
          },
        ];
      }
    }

    const merged: CategoryNode = {
      ...cached,
      budget: { current: newCurrent, histories: newHistories },
    };
    this.categoriesCache.upsert(merged);
  }

  patchLiveRecurringUpsert(recurring: RecurringNode): void {
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
