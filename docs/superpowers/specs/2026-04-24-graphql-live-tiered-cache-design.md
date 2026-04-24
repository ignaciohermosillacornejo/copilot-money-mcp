# GraphQL Live Reads — Tiered Cache Design (Phase 2)

- **Date:** 2026-04-24
- **Status:** Spec, awaiting approval
- **Supersedes (in part):** Phase 1's 5-minute blanket memo in `LiveCopilotDatabase.memoize()` — this spec replaces it with a tiered-by-age, per-entity caching architecture.
- **Related:** `docs/superpowers/specs/2026-04-23-graphql-live-reads-design.md`, `docs/graphql-live-reads.md`, `memory/reference_live_reads_measurements.md`

## Background

Phase 1 (PR #331) shipped `--live-reads` + `get_transactions_live` on a new `LiveCopilotDatabase` abstraction, backed by a 5-minute blanket memo keyed on `JSON.stringify({filter, sort, pageSize})`. That memo solved the headline case — repeated broad queries during a single Amazon-sync run drop from ~33s to ~10ms — but it can't express tiered freshness, and overlapping queries with differing client-side post-filters still share a key only by accident.

Measurement on 2026-04-24 (`memory/reference_live_reads_measurements.md`) fixed the numbers that drive this phase's design:

- Server enforces a hard 25-row page-size cap. No way to reduce pagination at the request layer.
- Per-request latency ~350ms median, network-bound, independent of row count.
- Full-year transaction fetch floors at ~33s (94 pages × ~350ms). Caching is the only lever.
- Memo hits are <10ms — ~3,000× speedup when the key matches.

The user's intuition-level hypothesis for transactions (unverified): Plaid-sync drift is concentrated in the last week; rows 1–3 weeks old drift occasionally; rows >21 days old are effectively frozen. This hypothesis drives the tiered-by-age TTL recommendation in this spec but is explicitly named as an assumption — the Phase N+1 measurement gate is where we validate or tune it.

Phase 2's goal is to put a cache architecture in place that supports per-entity TTLs, tiered-by-age transaction freshness, write-through consistency, and explicit LLM-invokable refresh — so that subsequent `get_<entity>_live` migrations plug into a shared, well-shaped cache rather than each re-inventing one.

## Goals

1. **Tiered freshness for transactions.** Rows ≤7 days old always fetch live; rows 8–21 days old cache for 1h; rows >21 days old cache for 1w. Named assumption, not measured — see Phase N+1.
2. **Per-entity TTL for small entities.** Accounts (1h), Budgets (1h), Recurring (6h), Categories (24h), Tags (24h). Whole-entity snapshot per call.
3. **Write-through consistency.** Every successful MCP write mutation updates the live cache at the same call site where it updates the LevelDB cache. User always sees their own writes without refresh.
4. **Explicit LLM-invokable refresh.** A new `refresh_cache` tool (registered only when `--live-reads` is on) flushes the live cache by scope, without touching LevelDB.
5. **Freshness signaling.** Live-tool response envelopes carry `_cache_fetched_at` and `_cache_hit` so the LLM can judge staleness.
6. **Concurrent-call safety.** Simultaneous misses share a single in-flight promise — no duplicate network fetches.
7. **Preserve Phase 1 operator surface.** Flag name (`--live-reads`), tool name (`get_transactions_live`), error taxonomy, and auth preflight all stay identical. Only the cache layer behind them changes.

## Non-goals

- **Migrating tools other than `get_accounts_live`.** This spec designs the cache for all six in-scope entities, but Phase 2's implementation plan migrates only accounts. Transactions move onto the tiered cache in Phase 3; the remaining entities follow in Phases 4–6 (categories, tags, budgets, recurring, in that order of simplicity).
- **Touching the 11 cache-only read tools** (investments, holdings, securities, goals, goal history, balance history, investment performance, investment prices, investment splits, TWR returns, connection status). No GraphQL equivalent; retirement path handled separately in Phase N+3.
- **Measuring drift ahead of the spec.** Named-assumption tier boundaries ship now. The Phase 1 verbose-log infrastructure is extended to capture staleness-at-refetch events; the N+1 measurement checkpoint uses ≥ 2 weeks of that data to validate or tune the tiers.
- **Pre-hydrating the cache at session start.** Rejected — adds 33s of worst-case boot latency for speculative value; does not help mid-session Plaid drift. Cache warms lazily on first query per entity.
- **Background/periodic polling.** Rejected — battery cost, concurrent-refresh complexity, and no benefit over TTL + write-through + explicit refresh.
- **Cross-process cache sharing.** The MCP server is a single long-lived process; the cache is process-local.
- **Persisting the live cache to disk.** All live cache is in-memory. Restart is the nuclear cache flush.
- **Flipping `--live-reads` on by default.** Phase N+2. Out of scope.

## Relationship to the migration roadmap

Phase 1's roadmap:

| Phase | Deliverable |
|---|---|
| 1 ✅ | `get_transactions_live` + scaffold |
| 2..N | One `get_<entity>_live` per spec |
| N+1 | Measurement checkpoint |
| N+2 | Flip `--live-reads` on by default |
| N+3 | Retire LevelDB, rename `_live` → canonical |

This spec sits **across the phases 2..N band**: it defines the cache architecture every `_live` migration reuses. Phase 2's implementation plan pulls `get_accounts_live` as the first concrete entity to prove the design. Phase 3 migrates `get_transactions_live` onto the tiered cache (replacing the Phase 1 blanket memo). Phases 4–6 add categories, tags, budgets, recurring.

The transactions tiered-cache work deliberately does not ship in Phase 2 because:

1. Accounts prove the flat-snapshot path and write-through plumbing on the simplest possible entity (~10 rows, one GraphQL round-trip, one mutation: `editAccount`).
2. The Phase-1 memo keeps working for transactions during Phase 2 — no regression.
3. Transactions are the most complex cache shape (month-keyed window map, eviction, tiered TTLs). Separating them lets us review the snapshot-cache + write-through pattern independently of the windowing logic.

## Scope

### In scope (this spec + Phase 2 plan)

- New cache primitives on `LiveCopilotDatabase`:
  - `SnapshotCache<T>` — flat `{ rows, fetched_at }` per entity, configurable TTL, write-through patches.
  - `TransactionWindowCache` — `Map<YearMonth, { rows, fetched_at, complete }>`, tiered TTL by month age, month-scoped invalidation, write-through patches.
  - `InFlightRegistry` — `Map<string, Promise<T>>` single-flight guard.
- `patchLive*` catalog: 11 methods on `LiveCopilotDatabase` mirroring the existing `patchCached*` methods on `CopilotDatabase`.
- Freshness envelope: `_cache_fetched_at` (ISO) and `_cache_hit` (boolean) added to every live-tool response.
- New `refresh_cache` MCP tool (registered only when `--live-reads` is on), with `scope?` and `months?` args.
- Concrete Phase 2 implementation: `get_accounts_live` tool using `SnapshotCache` + `patchLiveAccount` write-through from `edit_account`.
- Extend verbose instrumentation to log `staleness_ms` on cache refills (supports N+1 measurement).
- Tests covering the cache primitives, write-through at each call site, and the `get_accounts_live` migration.

### Out of scope (handled in later phases)

- Transactions moving onto `TransactionWindowCache` — Phase 3.
- Categories, tags, budgets, recurring migrations — Phases 4–6.
- Investment / goal / balance history / TWR tools — no GraphQL equivalent; separate architectural question at Phase N+3.
- Flipping `--live-reads` on by default — Phase N+2.
- Skill updates to reference `get_accounts_live` — one follow-up PR per migration phase.

### Breaking changes

None to the existing operator or MCP surface.

- `--live-reads` flag name unchanged.
- `get_transactions_live` input/output schema unchanged. Its backing cache is still the Phase 1 memo until Phase 3.
- New tool: `get_accounts_live` (additive, replaces `get_accounts` in the list when `--live-reads` is on — same replacement pattern as Phase 1).
- New tool: `refresh_cache` (additive, only visible when `--live-reads` is on).
- Freshness envelope fields are **additive** on live-tool responses. Cache-backed tools in `--live-reads`-off mode are unchanged; their envelopes do not gain these fields.

## Architecture

### Cache primitives

Three reusable primitives live in `LiveCopilotDatabase`:

#### 1. `SnapshotCache<T>` — for small entities

```ts
interface SnapshotCacheOptions {
  ttlMs: number;            // e.g. 1h for accounts, 24h for categories
  keyFn?: (row: T) => string; // for upsert/delete patching
}

interface ReadResult<T> {
  rows: T[];
  fetched_at: number;
  hit: boolean; // true iff served from cache without a network call this turn
}

class SnapshotCache<T> {
  private entry: { rows: T[]; fetched_at: number } | null = null;

  async read(loader: () => Promise<T[]>): Promise<ReadResult<T>>;

  upsert(row: T): void;      // patch — no-op if no snapshot loaded yet
  delete(key: string): void; // patch — no-op if no snapshot loaded yet
  invalidate(): void;        // explicit refresh
}
```

One snapshot per entity. `read()` returns the cache if fresh (`fetched_at + ttlMs > now`) with `hit: true`, otherwise calls `loader()` through the `InFlightRegistry`, caches the result, and returns with `hit: false`. `upsert`/`delete` mutate the in-memory array if it exists (no-ops if the snapshot hasn't been loaded; the next `read()` fetches the authoritative set).

#### 2. `TransactionWindowCache` — for transactions

```ts
interface WindowEntry {
  rows: TransactionNode[];
  fetched_at: number;
  complete: boolean;  // true iff the full month has been fetched (not a partial-range intersection)
}

class TransactionWindowCache {
  private windows: Map<YearMonth /* "YYYY-MM" */, WindowEntry> = new Map();
  private lastAccessed: Map<YearMonth, number> = new Map();

  // Resolves a [start_date, end_date] range against the window map.
  // Returns (a) rows already cached, (b) list of months needing fetch.
  plan(range: DateRange, now: Date): { cachedRows: TransactionNode[]; toFetch: YearMonth[] };

  ingestMonth(month: YearMonth, rows: TransactionNode[], fetched_at: number): void;

  // Write-through — date field determines which month bucket it lands in.
  upsert(tx: TransactionNode): void;
  delete(id: string): void;

  invalidate(scope: 'all' | YearMonth[]): void;

  evictLRU(maxTotalRows: number): void;
}
```

**Tier rule per month.** Let `min_age_days = max(0, (today - last_day_of_month).days)` — i.e., the age of the month's most recent day, clamped at zero for the current month.

- `min_age_days ≤ 7` → **`"live"` tier, always refetch** (no cache).
- `7 < min_age_days ≤ 21` → **`"warm"` tier, 1h TTL**.
- `min_age_days > 21` → **`"cold"` tier, 1w TTL**.

The current calendar month is always `"live"` (`min_age = 0`). The previous month transitions live → warm → cold as `today` advances: warm while `today` is within the first 21 days of the month, cold thereafter. Every month older than "previous" is cold. This means the "warm" tier only appears during roughly days 1–20 of any given month, which is fine — its purpose is to buffer the narrow window where Plaid late-posts to the just-closed month.

**Query resolution (`plan`)**:

1. Decompose `[start_date, end_date]` into the set of calendar months it covers.
2. For each month:
   - If tier `"live"` → add to `toFetch`.
   - Else if `windows.has(month) && windows.get(month).fetched_at + tier_ttl > now` → pull from cache.
   - Else → add to `toFetch`.
3. Emit `cachedRows` from resolved months, sliced to `[start_date, end_date]`.
4. Caller fetches `toFetch` months (serially for now; parallel is a future optimization), calls `ingestMonth` per result, then merges with `cachedRows`, applies client-side post-filters, and returns.

`evictLRU` runs after every `ingestMonth`: if total rows across all windows exceed a configured cap (default 20,000), drop the oldest-accessed month until under the cap. Small entities are never evicted (they're bounded).

#### 3. `InFlightRegistry` — concurrent-call safety

```ts
class InFlightRegistry {
  private promises: Map<string, Promise<unknown>> = new Map();

  async run<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const existing = this.promises.get(key);
    if (existing) return existing as Promise<T>;
    const promise = loader().finally(() => this.promises.delete(key));
    this.promises.set(key, promise);
    return promise;
  }
}
```

Shared by both `SnapshotCache` (keyed on entity name) and `TransactionWindowCache` (keyed on `YYYY-MM`). Guarantees any set of simultaneous cache-miss callers share one GraphQL round-trip per key.

### TTL tiers — table

| Entity | Tier rule | Rationale |
|---|---|---|
| **Transactions** | ≤7d-touching month: `"live"` (no cache) <br> 8–21d month: `"warm"` 1h <br> >21d month: `"cold"` 1w | Hypothesis: Plaid drift concentrates in last week; >21d effectively frozen. Named assumption; validated at N+1. |
| **Accounts** | `"warm"` 1h | Balances update daily-ish from Plaid. |
| **Budgets** | `"warm"` 1h | User-edited; cheap refresh. |
| **Recurring** | `"warm"` 6h | User-edited + Copilot auto-detects; middle ground. |
| **Categories** | `"cold"` 24h | Rarely change; write-through covers user-driven edits. |
| **Tags** | `"cold"` 24h | Same. |

All TTL values are configurable via `LiveDatabaseOptions` for testability; defaults above ship.

### Staleness model

What "the cache is correct" means:

1. **TTL-driven invalidation (primary).** A cache entry past `fetched_at + tier_ttl` is refetched on next `read()`.
2. **Write-through patching.** Our own mutations update the in-memory cache inline. The caller always sees their own writes.
3. **Explicit refresh.** `refresh_cache({ scope?, months? })` flushes the named slice of the cache.
4. **Restart.** Process restart flushes everything.

**What about Plaid writing server-side without notifying us?** Depends on the affected tier:

- **≤7d transaction tier:** no cache, never stale.
- **8–21d transaction tier:** up to 1h stale.
- **>21d transaction tier:** up to 1 week stale *under the assumption that drift beyond 21 days is ~0*. If Phase N+1 measurement shows non-trivial drift here, tighten the tier.
- **Accounts / Budgets:** up to 1h stale.
- **Recurring:** up to 6h stale.
- **Categories / Tags:** up to 24h stale — but these are entities users write to via our tools, so write-through covers the common case.

Staleness is documented in `docs/graphql-live-reads.md` so operators know what they're trusting.

### Write-through catalog

11 `patchLive*` methods on `LiveCopilotDatabase`, 1:1 with the existing `patchCached*` methods on `CopilotDatabase`:

| Method | Existing LevelDB analog | Call sites (in `src/tools/tools.ts`) |
|---|---|---|
| `patchLiveTransaction(id, fields)` | `patchCachedTransaction` | 4 |
| `patchLiveTransactionDelete(id)` | `patchCachedTransactionDelete` | 2 |
| `patchLiveBudget(categoryId, amount, month?)` | `patchCachedBudget` | 1 |
| `patchLiveTagUpsert(tag)` | `patchCachedTagUpsert` | 2 |
| `patchLiveTagDelete(id)` | `patchCachedTagDelete` | 1 |
| `patchLiveCategoryUpsert(category)` | `patchCachedCategoryUpsert` | 2 |
| `patchLiveCategoryDelete(id)` | `patchCachedCategoryDelete` | 1 |
| `patchLiveRecurringUpsert(rec)` | `patchCachedRecurringUpsert` | 3 |
| `patchLiveRecurringDelete(id)` | `patchCachedRecurringDelete` | 1 |
| `patchLiveAccount(id, fields)` | **new** — `patchCachedAccount` added in Phase 2 alongside the live analog | 1 (`edit_account`) |

Call-site pattern — two explicit calls at each site where a mutation succeeds:

```ts
// tools.ts: after a successful GraphQL mutation
this.db.patchCachedCategoryUpsert(category);
this.liveDb?.patchLiveCategoryUpsert(category);
```

The `?` is load-bearing: when `--live-reads` is off, `liveDb` is undefined and the live patch is skipped. When on, both caches stay in lock-step. Live patches are best-effort and never throw: if the snapshot isn't loaded yet, the next `read()` picks up authoritative state. No helper wrapper — a helper would hide the cache pair and make the Phase N+3 cleanup (delete `patchCached*`, keep `patchLive*`) mechanically harder.

**Transaction write-through into the month map**: `patchLiveTransaction`/`patchLiveTransactionDelete` locate the target window by `transaction.date` and upsert/delete in place. Patches that change the date field move the row across windows (delete from old month, upsert to new). Both affected windows' `lastAccessed` timestamps update.

### Freshness envelope

Live-tool response envelopes gain two fields:

```jsonc
{
  "count": 25,
  "total_count": 312,
  "transactions": [ ... ],
  "_cache_fetched_at": "2026-04-24T14:32:17.421Z", // ISO
  "_cache_hit": false
}
```

- **`_cache_fetched_at`** — for snapshot caches, the snapshot's `fetched_at`. For transaction queries, the **oldest** `fetched_at` across all months that contributed rows (worst-case staleness).
- **`_cache_hit`** — `true` iff every month/entity contributing to this response came from cache (no network call this turn). `false` if **any** part required a fetch — whether first-time miss, TTL-expired refetch, or live-tier policy fetch. Rationale: the LLM's real question is "did this touch the network?" Granular per-month breakdown adds surface area without meaningfully improving LLM decisions.

Documented in `docs/graphql-live-reads.md` with LLM guidance: "If `_cache_hit: true` and `_cache_fetched_at` is older than an hour and the user is asking about recent activity, consider `refresh_cache({ scope: 'transactions', months: ['YYYY-MM'] })`."

Cache-backed tools (`--live-reads` off) do **not** gain these fields — they're live-cache specific. This keeps Phase N+2's default-flip a pure rename rather than a schema change.

### Refresh API

New MCP tool, registered only when `--live-reads` is on:

```
refresh_cache({
  scope?: "all" | "transactions" | "accounts" | "categories" | "tags" | "budgets" | "recurring",
  months?: string[] // YYYY-MM format, only meaningful when scope is "all" or "transactions"
})
```

- `scope: "all"` (default) with no `months` → flush every entity's live cache.
- `scope: "all"`, `months: ["2026-04"]` → flush those transaction months; other entities untouched.
- `scope: "accounts"` → flush the accounts snapshot.
- `scope: "transactions"`, `months: ["2026-04", "2026-03"]` → flush only those transaction months.
- `scope: "transactions"` with no `months` → flush all cached transaction months.

Returns:

```jsonc
{
  "flushed": { "accounts": true, "transactions_months": ["2026-04"] },
  "remaining_entries": { "categories": "warm", "tags": "warm", ... }
}
```

`refresh_database` (existing tool) is **untouched**. It continues to reload LevelDB from disk. In Phase N+3 it retires with LevelDB; `refresh_cache` likely renames to `refresh` or `refresh_data` at that point (Phase N+3 deals with naming).

Why two verbs during the migration: the two caches have different failure modes (LevelDB reload can time out on decode; live cache flush can't), different costs (LevelDB = seconds of disk I/O; live cache = microseconds), and different triggers. Overloading `refresh_database` with a `scope` arg silently no-ops `scope: "accounts"` for LevelDB (which is all-or-nothing), producing a "looks the same, acts different" trap. The separate-tool surface is the correct shape.

### Concurrent-call safety

`InFlightRegistry` guards every cache loader. Keys:

- `SnapshotCache<T>` — the entity name (e.g. `"accounts"`).
- `TransactionWindowCache` — per-month (e.g. `"2026-04"`). A multi-month fetch issues one registry entry per month.

Simultaneous callers of the same entity/month wait on the same promise. Failures propagate to all waiters; the promise is cleared from the registry on either success or failure so the next caller attempts a fresh fetch.

**This replaces Phase 1's `memoize()` method**, which had the duplicate-fetch issue flagged in the AI review. The Phase 1 memo is not deleted — it stays live during Phase 2 because `get_transactions_live` still uses it. Phase 3 removes `memoize()` in favor of `TransactionWindowCache`.

### Memory footprint and eviction

**Ceiling target: 50MB total live-cache memory.** Math:

- Transactions: ~1KB/row. A power user with 10 years of history = ~25,000 rows = ~25MB.
- Small entities combined: <1MB.
- 4× headroom from 25MB → 100MB theoretical; 50MB ceiling is defensive.

**Eviction policy:**

- **Small entities:** no eviction. Bounded at <1MB total; TTL invalidation is enough.
- **Transaction window map:** when total cached rows exceed `MAX_CACHED_TX_ROWS` (default 20,000), evict oldest-accessed month (by `lastAccessed`) until under the cap. Most users fit entirely in cache; only decade-plus-history power users see eviction.

Eviction runs synchronously at the end of `ingestMonth` — O(months) per ingest, acceptable because months are ~100 even for the heaviest user.

The ceiling is defensive. If real usage shows thrashing, tuning options include: raising the cap, switching to size-based instead of row-based, or moving the window map to a process-external store (out of scope here, named only so we don't have to invent the escape hatch under pressure).

## Data flow walkthroughs

### Walkthrough 1 — `get_accounts_live` (Phase 2's concrete deliverable)

1. **MCP dispatch.** `server.ts` routes `get_accounts_live` to `LiveAccountsTools.getAccounts(args)`.
2. **Cache read.** `this.live.getAccountsCache().read(() => fetchAccounts(this.live.getClient()))`.
3. **Fresh-enough branch** (`fetched_at + 1h > now`): return cached rows immediately. `_cache_hit: true`, `_cache_fetched_at: <cached_at>`.
4. **Stale / miss branch**: `InFlightRegistry` either reuses an in-flight promise or calls `fetchAccounts()` (single GraphQL round-trip). Result cached with fresh `fetched_at`. `_cache_hit: false`, `_cache_fetched_at: <now>`.
5. **Envelope assembly.** Existing account enrichment + the new envelope fields.

Write-through from `edit_account`:

1. `edit_account` invokes the `EditAccount` GraphQL mutation.
2. Success → `this.db.patchCachedAccount(id, patch)` (new — mirrors existing entity patterns) + `this.liveDb?.patchLiveAccount(id, patch)`.
3. Next `get_accounts_live` call returns the patched row immediately (if cache was loaded) or refetches (if not).

### Walkthrough 2 — `get_transactions_live` under the tiered cache (Phase 3 preview, informs the Phase 2 design)

Hypothetical `today = 2026-04-15` so all three tiers appear in one example.

1. Call with `start_date: "2026-02-01"`, `end_date: "2026-04-15"`, `account_id: "acc_123"`.
2. `TransactionWindowCache.plan()` decomposes the range into `["2026-02", "2026-03", "2026-04"]`.
3. Per-month tier resolution:
   - `2026-02` — last day 2026-02-28, `min_age = 46d` → **cold tier, 1w TTL**. Suppose cached `fetched_at: 2026-04-10`. `10 + 7 = 17` → still valid (under 1w). Pull from cache.
   - `2026-03` — last day 2026-03-31, `min_age = 15d` → **warm tier, 1h TTL**. Suppose cached `fetched_at: 2026-04-15T13:00`. If `now` is within 1h → pull from cache; otherwise refetch.
   - `2026-04` — current calendar month, `min_age = 0d` → **live tier, no cache**. Always fetch.
4. Fetch plan: only `2026-04` (assuming March cache is fresh). Paginate using the Phase 1 query layer, scoped via `filter.dates: [{from: "2026-04-01", to: "2026-04-30"}]` + `accountIds` filter.
5. Ingest the fetched month into the window map. Merge with cached `2026-02` + `2026-03` rows.
6. Apply client-side post-filters (amount range, pending, etc.) on the merged set.
7. Slice to the requested `[start_date, end_date]` range.
8. Envelope: `_cache_hit: false` (April required a live-tier fetch) + `_cache_fetched_at: min(april_fetched_at, march_fetched_at, feb_fetched_at)`.

Key property: subsequent broad queries over similar ranges pay only the April refetch cost (~3s) instead of the full-year 33s. The Feb and March months are paid for once until their TTLs expire.

### Walkthrough 3 — write-through for a split transaction

1. `split_transaction(id, splits[])` calls the `SplitTransaction` GraphQL mutation.
2. Returns the parent transaction (updated) and new child transactions.
3. Existing LevelDB patches fire: `patchCachedTransaction(parent.id, {...})` + additional for children.
4. **Live-cache patches fire**:
   - `patchLiveTransaction(parent.id, {...})` — locates the parent's month in the window map, updates in place.
   - For each child, `patchLiveTransaction(child.id, {...})` — upsert into the month corresponding to its date.
5. If the window map doesn't have the parent's month loaded, the patches are no-ops; next query for that month fetches authoritative state.

## Error handling

Cache primitives surface errors from their loaders transparently — no swallowing, no silent fallback.

| Failure mode | Behavior |
|---|---|
| `loader()` throws `GraphQLError(AUTH_FAILED)` | Promise rejects. Cache entry unchanged. Tool surfaces the existing Phase-1 remediation text. |
| `loader()` throws `GraphQLError(NETWORK)` | Retried once by `withRetry` (existing, from Phase 1). On second failure, promise rejects; cache entry unchanged. |
| `loader()` throws any other error | Promise rejects. Cache entry unchanged. `InFlightRegistry` clears the promise. |
| `refresh_cache` called with unknown scope | Returns `isError: true` with remediation listing valid scopes. |
| `patchLive*` called before snapshot loaded | No-op. Intentional. |
| `patchLiveTransaction` with unknown id (not in any cached window) | No-op. Next query to the row's month fetches authoritative state. |

**No silent degradation to stale cache on refresh failure.** If a refetch fails, the caller gets the error; the previous (possibly stale) cache entry stays untouched for a future attempt but is **not** returned to satisfy the current call. Rationale: the operator opted into live reads; returning stale data silently after a network error defeats the point.

## Testing

### Unit tests

- `tests/core/cache/snapshot-cache.test.ts` — `SnapshotCache<T>`:
  - Fresh read hits cache; stale read refetches; miss loads.
  - Upsert/delete mutate in place; no-op when snapshot not loaded.
  - Invalidate clears entry.
  - TTL boundary (exactly `fetched_at + ttlMs`) — treated as stale.

- `tests/core/cache/transaction-window-cache.test.ts` — `TransactionWindowCache`:
  - `plan()` decomposes a range into correct months.
  - Per-month tier resolution: current month → `"live"`; 14d-ago month → `"warm"`; 60d-ago month → `"cold"`.
  - Cached + fresh month pulled, stale month flagged for fetch, miss month flagged for fetch.
  - Month-straddling row mutation (upsert with a date change) moves the row across windows.
  - `evictLRU` drops oldest-accessed month when cap exceeded.
  - `invalidate('all')` clears everything; `invalidate(['2026-04'])` clears only named.

- `tests/core/cache/in-flight-registry.test.ts`:
  - Simultaneous callers share one promise.
  - Failure clears the entry.
  - Post-success, next call starts fresh.

- `tests/core/live-database.test.ts` — extended:
  - `patchLive*` methods (11 of them) each verified against the target cache primitive.
  - Write-through for `patchLiveTransaction` with a date change moves the row.
  - Freshness envelope values produced correctly (hit/miss semantics, worst-case `fetched_at`).

- `tests/tools/live/accounts.test.ts`:
  - First call: cache miss, fetches via mock GraphQL, returns rows with `_cache_hit: false`.
  - Second call within 1h: cache hit, no GraphQL call, `_cache_hit: true`.
  - After `refresh_cache({ scope: "accounts" })`: next call has `_cache_hit: false`.
  - Write-through: `edit_account` updates both caches; subsequent `get_accounts_live` shows the patched row without a refetch.

- `tests/tools/refresh-cache.test.ts`:
  - Each scope clears the right slice.
  - `months` arg targets correct windows.
  - Unknown scope → `isError: true`.

### Integration / E2E

- Manual acceptance: `bun run dev --live-reads --verbose` with the accounts migration. Exercise `get_accounts_live` twice back-to-back, observe second call logs `pages=0 latency=<1ms rows=<n>` (or equivalent cache-hit log line). Then `edit_account` on one account, immediately `get_accounts_live`, verify the edited fields appear.
- No CI integration tests (they'd require a real endpoint or a complex GraphQL fixture server).

### Staleness-measurement instrumentation

Extend the Phase 1 `logReadCall` to emit an additional structured line on cache fills:

```
[graphql-read] op=Transactions ttl_tier=cold cache_hit=false pages=8 latency=2810ms rows=210 month=2026-03 staleness_ms=<null|n>
```

- `ttl_tier` — the TTL class for this entity/month (`live`, `warm`, or `cold`) as resolved at call time.
- `cache_hit` — `false` for any log line emitted on a refill (this instrumentation only fires on network calls).
- `staleness_ms` — delta between the replaced entry's `fetched_at` and now when the refill happens (`null` on a pure first-time miss).

Operators running with `--verbose` for 2+ weeks accumulate data the N+1 checkpoint uses to validate or tune tier boundaries. The `ttl_tier × staleness_ms` distribution is the key dataset: if the cold-tier p95 staleness is significantly lower than 1w and drift is still observed, tighten the TTL.

## Implementation notes and open probes

These resolve during Phase 2 implementation:

1. **TTL tier constants live in `LiveCopilotDatabase` config** (`LiveDatabaseOptions`) with sensible defaults matching the table in §"TTL tiers". No env-var override — tuning is a code change so the default is what ships.
2. **`SnapshotCache<T>` generics** — TypeScript generics keep type safety for each entity. Test with `Account` first; spec trusts the pattern transfers to the other four entities.
3. **`_cache_hit` aggregation** — a mixed response sets `_cache_hit: false` if any contributing month/entity required network. Simple AND across contributors; test it explicitly.
4. **`patchLiveAccount` requires a `patchCachedAccount` counterpart** — account edits don't currently touch the LevelDB cache (the one call site at `edit_account` flushes via `refresh_database`). Phase 2 adds both sides: a new `patchCachedAccount` on `CopilotDatabase` and a `patchLiveAccount` on `LiveCopilotDatabase`, wiring both into `edit_account`. Net win beyond the live-cache goal: `edit_account` no longer needs a full LevelDB reload to show its result.
5. **Month-boundary arithmetic** — uses existing date utilities (`src/utils/date.ts`). Add helpers `monthsCovered(range)` and `monthAge(yearMonth, now)` alongside the existing period parsers.
6. **`refresh_cache` tool schema** — registered via the same `createLiveToolSchemas()` mechanism as `get_transactions_live`; just another entry.
7. **No changes to `operations.generated.ts`** — `Accounts` query is added via the existing `scripts/generate-graphql-operations.ts` queries pipeline.
8. **Backward compatibility with Phase 1's `memoize()`** — during Phase 2, `memoize()` stays in `LiveCopilotDatabase` for use by `getTransactions()`. Phase 3 removes it when transactions move onto `TransactionWindowCache`.

## Roadmap dependencies

- **Phase 3** (transactions migration) reads this spec for the cache architecture. Implementation reuses `TransactionWindowCache` + `patchLiveTransaction*` — no further architectural spec needed, just an implementation plan.
- **Phases 4–6** (categories, tags, budgets, recurring) each reuse `SnapshotCache<T>` + the matching `patchLive*` method. Each gets a small implementation plan, no new spec.
- **Phase N+1** (measurement checkpoint) consumes the `staleness_ms` instrumentation added here. Its output validates or tunes the tier boundaries in the TTL table.
- **Phase N+2** (flip default) assumes Phase N+1 says the tiered cache is fast enough. No architectural dependency beyond that.
- **Phase N+3** (retire LevelDB) deletes `refresh_database`, renames `refresh_cache` → `refresh` (or similar), renames every `get_<entity>_live` → `get_<entity>`, and deletes `patchCached*` (keeping only `patchLive*`). This spec's write-through catalog is the retirement-PR template.

## Appendix A — acceptance questions, answered

The spec is approvable when a human can answer these without guessing.

1. **When is a cache entry stale?** When `fetched_at + tier_ttl ≤ now` (where `tier_ttl` comes from the TTL table — 1h / 6h / 24h / 1w depending on entity; for transactions, resolved per month by age from today). Write-through supersedes TTL for rows we mutate ourselves.
2. **What happens when Plaid-sync writes behind our back?** Nothing until the affected tier's TTL expires. Worst-case staleness is 1h for 8–21d transactions / accounts / budgets; 6h for recurring; 1w for >21d transactions (under the assumption it barely drifts); 24h for categories and tags. Current calendar month transactions never cache. Staleness is bounded, named, and measurable.
3. **How do writes propagate to the cache?** Via 11 `patchLive*` methods invoked from the `src/tools/tools.ts` write call sites, alongside the existing `patchCached*` calls. Both caches are patched in lock-step after every successful GraphQL mutation. Live patches are best-effort (no-op if cache not loaded).
4. **Which entities are cached and at what TTL?** See the TTL table in §"TTL tiers". Six cached entities: transactions (tiered by month age), accounts (1h), budgets (1h), recurring (6h), categories (24h), tags (24h).
5. **What does the LLM see about freshness?** `_cache_fetched_at` (ISO timestamp, worst-case across contributing entries) and `_cache_hit` (boolean — `true` iff nothing in the response required network this turn). Documented in `docs/graphql-live-reads.md` with LLM-facing guidance for interpreting the values.
6. **How does the LLM force a refresh?** `refresh_cache({ scope, months? })`. Registered only in `--live-reads` mode. `refresh_database` is untouched and continues to reload LevelDB.

## Appendix B — rejected alternatives

- **Flat Transaction[] with single `fetched_at`** — can't express tiered-by-age freshness. A slightly different broad-query filter would force a full-year refetch on every call.
- **Keep the Phase 1 per-memo key with tiered TTLs** — memo key is `{filter, sort, pageSize}`. Filter variance between overlapping queries produces accidental cache misses; no path to per-month tier logic.
- **Week-bucketed transaction map** — 4× bookkeeping cost, no meaningful freshness gain; 8–21d and >21d tiers cover the interesting deltas fine at month granularity.
- **Day-bucketed transaction map** — infeasible; pagination is per-request, not per-day; can't fetch only one day cheaply.
- **Single unified `refresh_database` tool with a scope arg** — semantic mismatch. LevelDB reload is all-or-nothing (one decoder pass); a scoped reload silently no-ops for LevelDB. The overload creates a "looks the same, acts different" trap during the migration. Two verbs is correct.
- **Pre-hydrate cache at session start** — adds 33s worst-case boot latency; doesn't solve Plaid drift mid-session. Lazy loading is the right default.
- **Background polling of last-N-days window** — battery cost + concurrent-refresh complexity; TTL + write-through + explicit refresh covers the use cases.
- **Measure drift before spec-writing** — a 15-minute probe window can't validate a 1-week TTL. Named assumptions now, Phase N+1 validates with 2+ weeks of real data.
- **Bundle all five remaining entity migrations into Phase 2** — accounts alone validates the flat-snapshot path and write-through pattern cheaply. Bundling adds review surface without reducing risk.
