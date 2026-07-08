/**
 * Live-read data layer backed by Copilot's GraphQL API.
 *
 * This class is the planned long-term replacement for CopilotDatabase
 * once every read tool has migrated off LevelDB. Phase 1 implements
 * only getTransactions(); later phases add methods for accounts,
 * categories, budgets, recurring, and tags.
 *
 * The class owns cross-cutting concerns shared by every method:
 *   - optional verbose logging to stderr for latency measurement
 * (Transport retry/backoff lives in GraphQLClient itself — issue #443.)
 *
 * Phase 2 adds tiered-cache primitives (SnapshotCache per entity type +
 * TransactionWindowCache for month-keyed transaction windows) and
 * 10 write-through patchLive* methods so mutations can update the cache
 * without requiring a full refresh.
 *
 * See docs/superpowers/specs/2026-04-23-graphql-live-reads-design.md.
 * See docs/superpowers/plans/2026-04-25-graphql-live-tiered-cache.md.
 */

import { homedir } from 'os';
import { join } from 'path';
import type { GraphQLClient } from './graphql/client.js';
import type { CopilotDatabase } from './database.js';
import { TransactionMetaStore } from './persistence/transaction-meta-store.js';
import {
  buildTransactionFilter,
  buildTransactionSort,
  fetchTransactionsPage,
  paginateTransactions,
  type TransactionNode,
  type TransactionSortInput,
} from './graphql/queries/transactions.js';
import { warnReadShapeDrift } from './graphql/read-validation.js';
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
import type { HoldingNode } from './graphql/queries/holdings.js';
import { fetchUser, type UserNode } from './graphql/queries/user.js';
import type { Transaction } from '../models/index.js';
import { ONE_HOUR_MS, SIX_HOURS_MS, ONE_DAY_MS, ONE_WEEK_MS } from '../utils/durations.js';

export interface LiveDatabaseOptions {
  verbose?: boolean;
  /** Injectable persistence store for the routing-id index (#511). Defaults
   *  to a uid-scoped JSONL store in ~/.claude/copilot-money/. Pass an
   *  explicit instance in tests to avoid touching the real home directory. */
  metaStore?: TransactionMetaStore;
}

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
  // holdingsCache stores investment positions (one row per (account, security)).
  // 6h TTL: positions change slowly (no daily buy/sell for most users); intraday
  // price drift inside `security.currentPrice` and `metrics.totalReturn` does
  // not need second-by-second freshness for agent queries — matches the
  // `recurringCache` TTL precedent for similarly slow-moving entities. Callers
  // who need a fresh snapshot can use refresh_cache with scope='holdings'.
  private readonly holdingsCache: SnapshotCache<HoldingNode>;
  private readonly transactionsWindowCache: TransactionWindowCache<TransactionNode>;
  /**
   * Append-only id → (accountId, itemId) index fed by every live
   * transaction fetch. The mapping is immutable server-side (a transaction
   * never moves accounts; Plaid pending→posted replaces the id itself), so
   * entries are never invalidated, evicted, or TTL'd. Write tools use this
   * to resolve mutation routing ids without a network fetch (~100
   * bytes/entry; a full history is a few MB).
   */
  private readonly txnMetaIndex = new Map<string, { accountId: string; itemId: string }>();
  /** Persistent backing store for txnMetaIndex (#511). Defaults to a
   *  uid-scoped JSONL file under ~/.claude/copilot-money/. Inert when
   *  COPILOT_DISABLE_PERSISTENT_INDEX=1 or uid is unavailable. */
  private readonly metaStore: TransactionMetaStore;

  /** Session-total Transactions nodes dropped by read-shape validation (#512). */
  private droppedInvalidRows = 0;

  getDroppedInvalidRows(): number {
    return this.droppedInvalidRows;
  }

  constructor(
    private readonly graphql: GraphQLClient,
    private readonly cache: CopilotDatabase,
    opts: LiveDatabaseOptions = {}
  ) {
    this.verbose = opts.verbose ?? false;
    this.metaStore =
      opts.metaStore ??
      new TransactionMetaStore({
        baseDir: join(homedir(), '.claude', 'copilot-money'),
        uidProvider: () => {
          try {
            return this.graphql.getUserId();
          } catch {
            return null;
          }
        },
      });

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
    this.holdingsCache = new SnapshotCache<HoldingNode>(
      { key: 'holdings', ttlMs: SIX_HOURS_MS, keyFn: (h) => h.id },
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

  /**
   * Fetch + paginate one month of transactions; ingest into the
   * window cache; return the rows along with the timestamp the
   * fetch was initiated and the page count.
   */
  private async fetchMonth(
    month: string,
    sort: TransactionSortInput[],
    pageSize: number
  ): Promise<{
    rows: TransactionNode[];
    fetched_at: number;
    pages: number;
    droppedInvalid: number;
  }> {
    const year = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    const [monthStart, monthEnd] = getMonthRange(year, m);
    const filter = buildTransactionFilter({ startDate: monthStart, endDate: monthEnd });
    const fetched_at = Date.now();
    let pages = 0;
    let droppedInvalid = 0;
    const rawRows = await paginateTransactions(
      async (after) => {
        pages += 1;
        return fetchTransactionsPage(
          this.graphql,
          { first: pageSize, after, filter, sort },
          (info) => {
            droppedInvalid += 1;
            this.droppedInvalidRows += 1;
            warnReadShapeDrift('Transactions', info);
          }
        );
      },
      { startDate: monthStart }
    );
    // Feed the append-only id→(accountId,itemId) index from the raw page
    // rows — pre-trim, because leaked tail rows are real transactions too
    // and their routing ids are just as valid. Guard against drifted
    // responses with null/empty routing ids (see review finding).
    for (const r of rawRows) {
      if (r.accountId && r.itemId) {
        this.feedMeta(r.id, { accountId: r.accountId, itemId: r.itemId });
      }
    }
    this.metaStore.flush();
    // Trim leaked tail-page rows that fall outside this month's window.
    // `paginateTransactions` early-exits AFTER appending a page, so the
    // trailing edge of the last page can dip into the previous month.
    // Without this trim, those rows pollute the wrong cache bucket and
    // get double-counted on subsequent full-range queries.
    const rows = rawRows.filter((r) => r.date >= monthStart && r.date <= monthEnd);
    this.transactionsWindowCache.ingestMonth(month, rows, fetched_at);
    return { rows, fetched_at, pages, droppedInvalid };
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
    dropped_invalid_rows?: number;
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
      log.dropped_invalid_rows !== undefined
        ? `dropped_invalid_rows=${log.dropped_invalid_rows}`
        : null,
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
    /** Invalid nodes dropped by read-shape validation during THIS call's
     *  fetches. Under in-flight coalescing, concurrent callers sharing a
     *  month fetch may each report that month's drops; the session total
     *  (getDroppedInvalidRows) counts each drop exactly once. */
    dropped_invalid_rows: number;
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
    const successes: Array<{
      month: string;
      rows: TransactionNode[];
      fetched_at: number;
      droppedInvalid: number;
    }> = [];
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

    let totalDropped = 0;
    for (const s of successes) {
      totalDropped += s.droppedInvalid;
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
      ...(totalDropped > 0 ? { dropped_invalid_rows: totalDropped } : {}),
    });

    return {
      rows: merged,
      oldest_fetched_at: oldest,
      newest_fetched_at: newest,
      hit,
      dropped_invalid_rows: totalDropped,
    };
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

  getHoldingsCache(): SnapshotCache<HoldingNode> {
    return this.holdingsCache;
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

  /**
   * Cold-safe category-id → name lookup map. Returns an empty Map when
   * the categories cache is cold (no fetch is triggered). Used by tools
   * that want to enrich rows with category names but don't need to force
   * a category fetch for that enrichment.
   */
  peekCategoryNameMap(): Map<string, string> {
    const rows = this.categoriesCache.peek();
    if (rows === undefined) return new Map();
    const map = new Map<string, string>();
    for (const cat of rows) {
      if (cat.id) map.set(cat.id, cat.name);
    }
    return map;
  }

  getTransactionsWindowCache(): TransactionWindowCache<TransactionNode> {
    return this.transactionsWindowCache;
  }

  /** Single funnel for meta-index writes: in-memory map + persistence
   *  buffer (#511). Entries with empty routing ids are dropped HERE, not
   *  just at call sites (#518) — response validation is warn-only, so a
   *  drifted read or mutation response must never poison the index even
   *  if a future call site forgets its own guard. */
  private feedMeta(id: string, meta: { accountId: string; itemId: string }): void {
    if (!meta.accountId || !meta.itemId) return;
    this.txnMetaIndex.set(id, meta);
    this.metaStore.buffer(id, meta);
  }

  /** Feed the meta index for a transaction learned outside a month fetch
   *  (e.g. the create_transaction response). */
  indexTransactionMeta(id: string, meta: { accountId: string; itemId: string }): void {
    this.feedMeta(id, meta);
    this.metaStore.flush();
  }

  /** Resolve routing ids for the given transaction ids from the in-memory
   *  index. Returns only the ids present; callers treat absence as
   *  "not seen by any live fetch this session". */
  lookupTransactionMeta(ids: string[]): Map<string, { accountId: string; itemId: string }> {
    // Identity guard (#511): on a non-null → different-non-null uid transition
    // (re-auth as another account), drop the previous login's in-memory routing
    // entries before hydrating the new login's history — the memory tier must
    // honor the same isolation the per-uid files do.
    const prevUid = this.metaStore.loadedUid();
    const curUid = this.metaStore.currentUid();
    if (prevUid !== null && curUid !== null && prevUid !== curUid) {
      this.txnMetaIndex.clear();
      // Replay entries buffered under the NEW uid (fed after the switch but
      // not yet — or not successfully — flushed) so the clear can't drop
      // fresh data the disk doesn't hold.
      for (const [id, m] of this.metaStore.pendingFor(curUid)) {
        this.txnMetaIndex.set(id, m);
      }
    }
    // Opportunistic hydration from disk (#511): in-memory entries win (they
    // are newest); loadOnce is idempotent/cheap after the first real load.
    for (const [id, m] of this.metaStore.loadOnce()) {
      if (!this.txnMetaIndex.has(id)) this.txnMetaIndex.set(id, m);
    }
    const out = new Map<string, { accountId: string; itemId: string }>();
    for (const id of ids) {
      const m = this.txnMetaIndex.get(id);
      if (m) out.set(id, m);
    }
    return out;
  }

  /**
   * Full-row lookup across cached window months. Read-only; returns only
   * the ids found. For write tools that need transaction CONTENT
   * (amount/name/date) rather than routing ids — e.g. split_transaction's
   * sum check and defaults. Content fields are as fresh as the window
   * cache (live tier always refetched; cold tier 1-week TTL) — strictly
   * fresher-or-equal vs the local LevelDB cache, and the server remains
   * the final enforcer of content-derived checks.
   */
  lookupTransactionNodes(ids: string[]): Map<string, TransactionNode> {
    const remaining = new Set(ids);
    const out = new Map<string, TransactionNode>();
    for (const month of this.transactionsWindowCache.cachedMonths()) {
      if (remaining.size === 0) break;
      for (const row of this.transactionsWindowCache.entriesForMonth(month)) {
        if (remaining.has(row.id)) {
          out.set(row.id, row);
          remaining.delete(row.id);
        }
      }
    }
    return out;
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
    // Keep the meta index consistent with the invariant "any row this class
    // has seen is indexed" (redundant for ingested rows, cheap insurance).
    // Merging `fields` cannot change the routing ids: it is
    // Partial<Transaction> (snake_case account_id/item_id, not the node's
    // camelCase keys), and the ids are server-immutable regardless.
    // Guard against drifted responses with null/empty routing ids (review finding).
    if (merged.accountId && merged.itemId) {
      this.feedMeta(id, { accountId: merged.accountId, itemId: merged.itemId });
      this.metaStore.flush();
    }
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
