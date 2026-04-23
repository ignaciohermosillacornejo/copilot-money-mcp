# GraphQL Live Reads — Design

- **Date:** 2026-04-23
- **Status:** Spec, awaiting approval
- **Related:** `docs/graphql-capture/operations/queries/Transactions.md`, `docs/graphql-capture/operations/queries/TransactionSummary.md`, `docs/superpowers/specs/2026-04-14-graphql-write-rewrite-design.md`

## Background

The MCP server's read tools query a local LevelDB cache populated by the Copilot macOS app. For older date ranges the cache is drastically sparse — it hydrates only when the user scrolls in the app. The practical failure was hit during `/amazon-sync` on 2026-04-22: a 2025 reconciliation query returned 0 Amazon matches despite an Amazon CSV export showing 223 shipments that year. `refresh_database` reloads what is already on disk; it does not fetch from Firestore.

The write tools (PR #319 and follow-ups) already authenticate against Copilot's GraphQL API at `app.copilot.money/api/graphql`. The same authenticated path can feed reads — sidestepping LevelDB staleness entirely and matching what the web UI sees.

A Chrome-captured trace of the real `TransactionFilter` / `TransactionSort` input shape (2026-04-23) is the source of truth for the query translation layer. Earlier introspection probes were incomplete because the captured filter uses nested `dates: [{from, to}]` objects and a compound `accountIds: [{accountId, itemId}]` shape that the probes did not enumerate.

This spec is **Phase 1 of a progressive migration off LevelDB onto GraphQL**. It delivers one tool on a new architectural layer and commits to the pattern every subsequent tool migration will follow. The spec documents the full migration roadmap so later phases have a shared reference.

## Goals

1. Solve the sparseness problem for `get_transactions` — when the operator opts in, reads fetch live from GraphQL and return complete results for any date range with data on Copilot's servers.
2. Establish a reusable `LiveCopilotDatabase` abstraction and `src/tools/live/` directory layout that later phases extend with one method + one tool per phase.
3. Preserve the existing cache-backed read path unchanged. Operators without authentication or without the opt-in flag see identical behavior to today.
4. Fail loudly. GraphQL errors never fall back silently to cache; unsupported filters return schema-validation errors the LLM can act on; auth failures surface with clear remediation text.
5. Produce measurement data (per-call latency, pagination counts) during Phase 1 that informs whether Phase 2+ needs a richer caching strategy before migrating more tools.

## Non-goals

- Migrating read tools other than `get_transactions` in this spec. Phases 2..N (`get_accounts_live`, `get_categories_live`, etc.) are each a separate spec that extends the layer this spec establishes.
- A pre-hydrated in-memory cache of GraphQL data. Phase 1 uses per-call pagination with short-lived result memoization (5-minute TTL) inside `LiveCopilotDatabase`. A richer cache is explicitly deferred pending Phase 1 measurements.
- Silent fallback to LevelDB on any failure. The operator opted into live reads; degradation to stale cache defeats the point.
- Mid-session re-authentication when a refresh token expires. Surface `AUTH_FAILED` with remediation text and let the operator restart.
- Touching the 11 read tools whose data has no GraphQL equivalent today (investments, holdings, balance history, goals, goal history, investment performance, investment splits, securities, twr returns, etc.). Retiring LevelDB is the end-state goal, but those tools require a separate architectural decision — out of scope here.
- Tool-schema evolution signaling via `notifications/tools/list_changed`. A CLI flag change requires a server restart; tools are re-listed on connect, so no mid-session signal is needed.

## Migration roadmap

The `_live` suffix on tool names is **transitional**. It exists to keep Phase 1 from mutating the semantics of a tool the current test suite and skills depend on. The endgame retires the suffix.

| Phase | Deliverable | Tool surface when `--live-reads` is on |
|---|---|---|
| 1 (this spec) | `get_transactions_live` + `LiveCopilotDatabase` scaffold | `get_transactions_live` replaces `get_transactions`; all other read tools remain cache-backed unchanged |
| 2..N | One `get_<entity>_live` per spec (accounts, categories, budgets, recurring, tags) | Each migrated tool swaps to its `_live` variant |
| N+1 | Stability checkpoint — measured latency, failure rate, pagination cost with real usage for ≥ 2 weeks | No code change; the measurement gate before flipping default |
| N+2 | Flip default: `--live-reads` becomes implicit; add a `--cache-reads` escape hatch for operators without auth | All migrated tools use GraphQL by default |
| N+3 | Retire LevelDB: delete `src/core/decoder.ts`, `src/core/database.ts`, migration worker-thread machinery, and the `--cache-reads` flag; rename every `get_<entity>_live` back to `get_<entity>`; update every affected skill in one PR | Clean surface, no suffixes, no flag |

Skills that reference tool names (`amazon-sync`, `finance-cleanup`, `finance-pulse`, `finance-trip`, `finance`) rename twice total — once in Phase 1 (for the tools that phase migrates), once at Phase N+3. Each rename is a single find-and-replace PR; the cost is bounded and documented.

## Scope

### In scope this phase

- New CLI flag `--live-reads`, parsed in `src/cli.ts`, propagated through `runServer()` into `CopilotMoneyServer`.
- New `LiveCopilotDatabase` class in `src/core/live-database.ts`, exposing `getTransactions(options)` in Phase 1.
- New GraphQL query wrappers under `src/core/graphql/queries/`:
  - `transactions.ts` — pagination helper, filter translator, sort constructor, early-exit on date boundary.
- New generated query constants: `Transactions` query added to `src/core/graphql/operations.generated.ts`.
- New `LiveTransactionsTools` class in `src/tools/live/transactions.ts`, exposing `getTransactions(args)` that returns the same `{ count, total_count, offset, has_more, transactions, ... }` envelope the cache tool returns.
- Conditional tool registration in `src/server.ts`:
  - `--live-reads` off: register `get_transactions` (cache-backed) as today.
  - `--live-reads` on: preflight auth, register `get_transactions_live` instead.
- Auth preflight at server boot when `--live-reads` is on. Missing/invalid token → log descriptive stderr line, exit non-zero. No dead-tool registration.
- Documentation:
  - `docs/graphql-live-reads.md` — migration roadmap, auth setup, filter-subset reference, operator-facing behavior differences.
  - `docs/graphql-capture/operations/queries/Transactions.md` updated to reflect the real `TransactionFilter` / `TransactionSort` shapes.
- Tests (see Testing section below).

### Out of scope this phase

- `get_accounts_live`, `get_categories_live`, `get_budgets_live`, `get_recurring_transactions_live`, `get_tags_live` — Phase 2+.
- Pre-hydrated entity caches inside `LiveCopilotDatabase` — deferred pending Phase 1 measurements.
- `cache_authoritative_through` structured metadata on the cache-backed tool response.
- Changes to the investment/holdings/goals/balance-history read tools.
- Skill migration to reference `get_transactions_live` — happens in a follow-up PR after Phase 1 lands.
- `transactionsFeed` query surface (alternative to `transactions`). Documented in `docs/graphql-live-reads.md` as an alternate form the web UI uses; Phase 1 uses `transactions` because its return shape is cleaner (`TransactionPagination` vs. the feed wrapper's month-grouping).

### Breaking changes

- When `--live-reads` is on, `get_transactions` no longer appears in the tool list — it is replaced by `get_transactions_live`. This only affects operators who explicitly pass the flag.
- `get_transactions_live`'s input schema is a strict subset of `get_transactions`'s:
  - Removed: `city`, `lat`, `lon`, `radius_km`, `region`, `country`.
  - `transaction_type` enum drops `foreign` and `duplicates`; retained values: `refunds`, `credits`, `hsa_eligible`, `tagged`.
  - `exclude_split_parents: false` is rejected (the default `true` stays).
  - Single-transaction lookup: `transaction_id` requires accompanying `account_id` and `item_id`; call with only `transaction_id` returns a schema-validation error.
- Skills that hardcode `get_transactions` must add mode-awareness or reference `get_transactions_live` when the operator runs with `--live-reads`. Handled in a follow-up PR.

No regressions for operators who do not opt in.

## Architecture

### File layout

```
src/
├── cli.ts                                  # + --live-reads flag parsing
├── server.ts                               # + conditional live-mode registration and preflight
├── core/
│   ├── database.ts                         # unchanged (cache-backed, used by cache tools AND by live tools for account→item lookup until phase 2)
│   ├── live-database.ts                    # NEW — LiveCopilotDatabase class
│   └── graphql/
│       ├── client.ts                       # unchanged
│       ├── operations.generated.ts         # regenerated to include Transactions query
│       └── queries/                        # NEW — per-entity query wrappers
│           └── transactions.ts             # NEW — query(args), filter translator, pagination helper
└── tools/
    ├── tools.ts                            # unchanged (cache tools)
    └── live/                               # NEW — live-mode tool implementations
        └── transactions.ts                 # NEW — LiveTransactionsTools class

tests/
├── core/
│   ├── live-database.test.ts               # NEW
│   └── graphql/
│       └── queries/
│           └── transactions.test.ts        # NEW
└── tools/
    └── live/
        └── transactions.test.ts            # NEW

docs/
├── graphql-live-reads.md                   # NEW — operator-facing reference
├── graphql-capture/operations/queries/
│   └── Transactions.md                     # updated with real TransactionFilter/Sort shapes
└── superpowers/specs/
    └── 2026-04-23-graphql-live-reads-design.md   # this file
```

Live code lives in its own directories (`src/core/live-database.ts`, `src/core/graphql/queries/`, `src/tools/live/`). The Phase N+3 retirement PR then becomes largely a directory rename + deletion of LevelDB-specific files rather than an untangling exercise.

### LiveCopilotDatabase — the stable abstraction

```ts
// src/core/live-database.ts

export class LiveCopilotDatabase {
  constructor(
    private graphql: GraphQLClient,
    private cache: CopilotDatabase, // phase 1 uses cache for account→item and tag-name→tagId lookup
    opts?: { memoTtlMs?: number; verbose?: boolean }
  ) { ... }

  async getTransactions(options: GetTransactionsOptions): Promise<Transaction[]> { ... }

  // phase 2+ methods plug in here:
  // async getAccounts(...): Promise<Account[]>
  // async getCategories(...): Promise<Category[]>
  // ...

  // internal: generic memo keyed on normalized filter+pagination cursor
  private memo: Map<string, { result: unknown; at: number }>;

  // internal: generic retry policy (NETWORK only, one retry, 500ms backoff)
  private async withRetry<T>(op: () => Promise<T>): Promise<T> { ... }

  // internal: optional verbose logging
  private logPageCall(opName: string, pages: number, latencyMs: number, rows: number): void { ... }
}
```

The class owns authentication dependency (via `graphql`), memoization, retry, and instrumentation. Phase 2+ tools add methods but do not re-implement these concerns.

### Live tool class — identical shape to existing tools

```ts
// src/tools/live/transactions.ts

export class LiveTransactionsTools {
  constructor(private live: LiveCopilotDatabase, private cache: CopilotDatabase) {}

  // Same envelope as CopilotMoneyTools.getTransactions — input-schema differences are in the tool schema declaration, not the method signature.
  async getTransactions(options: GetTransactionsLiveOptions): Promise<GetTransactionsResult> { ... }
}

export function createLiveToolSchemas(): ToolSchema[] { ... }  // phase 1: just get_transactions_live
```

Tool classes in `src/tools/live/` stay lean — they validate input, translate to `LiveCopilotDatabase` calls, and enrich results with category names / normalized merchant names. The client-side post-filtering (amount range, `pending`, `transaction_type: refunds|credits|hsa_eligible|tagged`, `exclude_excluded`) runs here.

### Server wiring

```ts
// src/server.ts, simplified

constructor(dbPath?: string, decodeTimeoutMs?: number, writeEnabled = false, liveReadsEnabled = false) {
  this.db = new CopilotDatabase(dbPath, decodeTimeoutMs);
  this.writeEnabled = writeEnabled;
  this.liveReadsEnabled = liveReadsEnabled;

  // Auth client built once, shared between writes and live reads
  let graphqlClient: GraphQLClient | undefined;
  if (writeEnabled || liveReadsEnabled) {
    const auth = new FirebaseAuth(() => extractRefreshToken());
    graphqlClient = new GraphQLClient(auth);
  }

  this.tools = new CopilotMoneyTools(this.db, graphqlClient);
  if (liveReadsEnabled) {
    this.liveDb = new LiveCopilotDatabase(graphqlClient!, this.db);
    this.liveTools = new LiveTransactionsTools(this.liveDb, this.db);
  }

  ...
}

// handleListTools() composes the tool surface:
//   - liveReadsEnabled: replace get_transactions schema with get_transactions_live schema
//   - writeEnabled: add createWriteToolSchemas() as today
handleListTools(): { tools: Tool[] } { ... }

// handleCallTool() routes get_transactions_live to this.liveTools
```

Preflight runs before `handleListTools()` is ever called — during `runServer(dbPath, timeoutMs, writeEnabled, liveReadsEnabled)`:

```ts
if (liveReadsEnabled) {
  try {
    await preflightLiveAuth(graphqlClient);
  } catch (err) {
    console.error(`[live-reads] preflight failed: ${err.message}`);
    console.error('[live-reads] ensure you are logged into app.copilot.money in your default browser, then restart.');
    process.exit(1);
  }
}
```

`preflightLiveAuth` sends a cheap `query Probe { transactions(first: 1) { pageInfo { hasNextPage } } }`. Any non-success classification (`AUTH_FAILED`, `NETWORK`, `SCHEMA_ERROR`) is fatal. The query exercises the whole auth → GraphQL → schema path in one hop.

## Data flow — a single `get_transactions_live` call

1. **MCP dispatch.** `server.ts:handleCallTool('get_transactions_live', args)` routes to `this.liveTools.getTransactions(args)`.
2. **Schema validation.** Input args are validated against the live tool's JSON Schema. Unsupported filters (`city`, `lat`, `lon`, `radius_km`, `region`, `country`, `transaction_type in {foreign, duplicates}`, `exclude_split_parents: false`) produce a schema-validation error with actionable remediation text:
   > `Parameter 'city' is not supported in live mode. Retry without 'city'. Supported filters: start_date, end_date, period, account_id, category, merchant, min_amount, max_amount, limit, offset, exclude_transfers, exclude_deleted, exclude_excluded, pending, transaction_id (+ account_id, item_id), query, transaction_type (refunds|credits|hsa_eligible|tagged), tag.`
3. **Filter translation** (`src/core/graphql/queries/transactions.ts::buildFilter(args)`):

   | Tool arg | GraphQL filter field |
   |---|---|
   | `start_date`, `end_date`, `period` | `filter.dates: [{from, to}]` |
   | `account_id` | `filter.accountIds: [{accountId, itemId}]` — `itemId` resolved from `cache.getAccounts()` (the Account record's `item_id` field) |
   | `category` (as ID) | `filter.categoryIds: [id]` |
   | `tag` (name) | resolve to tag ID via cache, then `filter.tagIds: [id]` |
   | `merchant` or `query` | `filter.matchString: <text>` |
   | `exclude_transfers: true` | `filter.types: [REGULAR, INCOME, RECURRING]` |
   | `exclude_transfers: false` | omit `filter.types` (INTERNAL_TRANSFER included) |

4. **Sort.** Always `[{field: DATE, direction: DESC}]` — enables early-exit pagination when the trailing edge passes `start_date`.
5. **Memo check.** `LiveCopilotDatabase.memo` keyed on `JSON.stringify({filter, sort, pageSize})`. Hit within 5 minutes → return memoized pages. Miss → paginate.
6. **Pagination** (`LiveCopilotDatabase.paginateTransactions()`):
   - First page: `transactions(first: <pageSize>, filter, sort)`.
   - Subsequent pages: `transactions(first: <pageSize>, after: <endCursor>, filter, sort)`.
   - Early exit: when the last row of a page has `date < start_date` (if `start_date` is set), stop.
   - End exit: when `pageInfo.hasNextPage === false`, stop.
   - Retry once on `NETWORK` error per page; no retry on 4xx/schema errors.
7. **Client-side post-filter** (the filters GraphQL can't do server-side):
   - `min_amount` / `max_amount` — absolute-value comparison on `amount`.
   - `pending: true|false` — filter on `isPending`.
   - `exclude_deleted` — treated as a no-op (the GraphQL server does not return deleted transactions).
   - `exclude_excluded` — cross-reference `categoryId` against `cache.getCategories()` where `category.is_excluded === true` and drop matches. The per-transaction `excluded` flag from LevelDB has no GraphQL equivalent; the category-level flag covers the primary use case. Documented in `docs/graphql-live-reads.md`.
   - `exclude_split_parents` — no-op: the GraphQL server already hides split parents (consistent with Copilot's UI). Validated opportunistically during implementation.
   - `transaction_type: refunds|credits` — amount-sign heuristics as in the cache tool.
   - `transaction_type: hsa_eligible` — category-based filter.
   - `transaction_type: tagged` — filter on `tags.length > 0`.
8. **Enrichment.** Each result augmented with `category_name` (from cache's `getCategoryNameMap()`) and `normalized_merchant` (from the existing `normalizeMerchantName` helper). Output shape matches the cache tool exactly.
9. **Memoize + return.** Store in memo map with current timestamp. Return envelope to MCP.
10. **Verbose logging.** When `--verbose`, emit `[graphql-read] op=Transactions pages=<n> latency=<ms> rows=<n>` to stderr. This is the measurement channel for the Phase N+1 checkpoint.

## Error handling and retry

All failures return `CallToolResult` with `isError: true` and actionable `content[].text`. **No JSON-RPC protocol errors.** Per the MCP spec, tool-execution errors belong in tool results so the LLM can self-correct.

| Failure | Retry? | Surface to LLM |
|---|---|---|
| `NETWORK` (timeout, connection reset, 5xx with no body) | Once, 500ms backoff | After retry exhausts: `"Network error reaching Copilot GraphQL API. Retry the call; if it keeps failing, check network connectivity."` |
| `AUTH_FAILED` (401) | No | `"Authentication expired or invalid. The Copilot refresh token from your browser session has been rejected. Open app.copilot.money in your default browser to re-authenticate, then restart the MCP server."` |
| `SCHEMA_ERROR` (400, 500 with GraphQL validation body) | No | `"GraphQL schema error (bug in copilot-money-mcp): <server message>. This usually means Copilot changed its API and this server needs updating."` |
| `USER_ACTION_REQUIRED` (200 with `errors[]` body) | No | `"Server rejected request: <server message>"` |
| Unsupported-filter schema violation | No | `"Parameter '<name>' is not supported in live mode. Retry without '<name>'. Supported filters: <list>."` |
| Missing required companion (`transaction_id` without `account_id`+`item_id`) | No | `"transaction_id lookup in live mode requires account_id and item_id. All three are returned together by a prior get_transactions_live call."` |

The principle: every error message tells the **LLM** what to do this turn, not the **user** what to do between sessions — except auth failures, which genuinely require human action.

## Auth preflight

When `--live-reads` is passed, `runServer()` awaits `preflightLiveAuth()` before constructing the MCP server. The preflight:

1. Calls `extractRefreshToken()` (same as write tools). A missing token raises immediately.
2. Calls `FirebaseAuth.getIdToken()` to exchange the refresh token. Exchange failure (401/400 from Firebase) raises.
3. Sends one GraphQL probe: `query Probe { transactions(first: 1) { pageInfo { hasNextPage } } }`.
4. If the probe returns `NETWORK`, `AUTH_FAILED`, or `SCHEMA_ERROR`, raise.

On any raise: `console.error` with a one-line diagnosis, then `process.exit(1)`. Claude Desktop sees a closed transport; the operator sees the log line in stderr. This is the "refuse to register a dead tool" stance from the research — a cryptic closed-transport error is preferable to an LLM discovering auth failure on the first real call.

Rationale for using `transactions(first: 1)` rather than a lighter ping: it exercises the full path the actual tool will use (auth, endpoint, query validity, permission). A viewer-only query could succeed while the transaction-read path fails due to a distinct permission scope.

## Testing

### Unit tests

- `tests/core/graphql/queries/transactions.test.ts`
  - `buildFilter()` — each supported tool arg translates to expected GraphQL filter shape.
  - `buildFilter()` — rejection cases for unsupported filters.
  - `buildSort()` — default DATE-DESC; optional overrides.
  - `paginateTransactions()` — early-exit when trailing date precedes `start_date`; end-exit when `hasNextPage === false`; page-cursor threading.
- `tests/core/live-database.test.ts`
  - Memo hit/miss within TTL.
  - `withRetry()` retries `NETWORK` once, surfaces other error codes immediately.
  - Verbose logging emits expected stderr line when enabled; silent when disabled.
- `tests/tools/live/transactions.test.ts`
  - Envelope matches the cache-backed tool's output shape byte-for-byte on shared cases.
  - Schema validation: each unsupported filter produces the expected `isError: true` result with the remediation text above.
  - Client-side post-filters (`amount`, `pending`, `exclude_excluded`, `transaction_type` variants) applied correctly on mock paginated data.
  - Enrichment: `category_name` and `normalized_merchant` populated on each row.
  - Error surfacing: each `GraphQLError.code` maps to the correct `isError: true` remediation text.
- Preflight tests in `tests/server.test.ts` (or a new `tests/preflight.test.ts`):
  - Missing refresh token → exits 1 with descriptive stderr.
  - Token-exchange failure → exits 1 with descriptive stderr.
  - Probe `NETWORK` / `AUTH_FAILED` / `SCHEMA_ERROR` → exits 1.
  - Probe success → proceeds to server.

All tests use mocked `GraphQLClient` — no real network calls in the default suite.

### E2E / probing script (opt-in)

`scripts/probe-transactions-live.ts` — writes to `/tmp/` by convention, hits the real endpoint, prints (a) the server's maximum accepted `first:` value (tries 50, 100, 250, 500, 1000), (b) a sample paginated result for a known-recent date range, (c) the verbose-log output. Used during implementation to pick the default page size and record findings in `docs/graphql-live-reads.md`. Not part of CI.

### Acceptance test

Manual validation by running `/amazon-sync` for 2025 with `--write --live-reads`. Success criteria: the pagination-returned transaction list includes Amazon entries matching the CSV shipment count (±within-date-boundary delta), rather than the 0 returned by LevelDB today.

## Implementation notes and open probes

The following details require live probing during implementation. Results land in `docs/graphql-live-reads.md`.

1. **Maximum `first:` page size.** The UI uses 25; the server likely accepts larger values. Probe 50, 100, 250, 500, 1000. Pick the largest stable value, default to a conservative fraction (e.g., half the max). Affects pagination count and thus latency for broad queries.
2. **`TransactionType = RECURRING` semantics.** The read-side filter accepts `[REGULAR, INCOME, RECURRING, INTERNAL_TRANSFER]`; the write-side `TransactionType` enum in `src/core/graphql/transactions.ts` is `REGULAR | INCOME | INTERNAL_TRANSFER`. Confirm `RECURRING` is returned on read (not just accepted on filter) and decide whether the read-side Transaction schema needs an expanded enum. Likely yes; additive.
3. **Split-parent visibility.** Confirm the `transactions` query does not return rows with children. If it does, `exclude_split_parents: true` needs a `parentId`-based client-side filter that pulls children and collects their parent IDs — viable but more expensive. If it doesn't, the default is a no-op as planned.
4. **`Category.isExcluded` read-time.** The live path relies on `cache.getCategories()` for excluded-category lookup. Confirm the cache's `is_excluded` field is populated across all user categories; if sparse, fall back to paging the `Categories` GraphQL query at first-use (cheap — categories are small).
5. **Datetime vs date.** GraphQL returns both `date: "YYYY-MM-DD"` and `datetime: "<ISO>"` (the latter is a `@client` directive in the captured fragment — confirm it's returned server-side or if it's an Apollo local-resolved field we need to strip from our query).
6. **`matchString` semantics.** The Chrome capture showed `matchString` used for the "similar transactions" right-panel feature. Confirm it performs substring/token match on `name` (not exact match). Document the finding; adjust if it's stricter than the current cache-tool `query` semantics.
7. **Preflight query return type.** The `transactions(first: 1) { pageInfo { hasNextPage } }` probe in the preflight is the minimum viable selection set — confirm it doesn't require `edges {}` to be non-empty in the selection.

Each probe is a 2-minute scripted check; failure of any of these narrows the design but does not block Phase 1.

## Roadmap dependencies

- Phase 2 specs should read this one. The `LiveCopilotDatabase` class, the `src/tools/live/` directory, and the preflight pattern are established once and reused; Phase 2 specs describe only what's entity-specific.
- Phase N+1 (measurement checkpoint) depends on the verbose-logging instrumentation this phase ships.
- Phase N+2 (flip default) depends on Phase N+1 producing data consistent with "live reads are fast enough."
- Phase N+3 (retire LevelDB) depends on Phase N+2 + resolving what to do with the 11 no-GraphQL-equivalent read tools (investments, holdings, goals, etc.). That resolution is not part of this roadmap — it's a separate architectural question.

## Appendix — GraphQL operation used

The read query added to `src/core/graphql/operations.generated.ts` targets the `transactions` root field (cleaner return shape than `transactionsFeed`, which the web UI uses for month-grouped rendering). Selection set matches the existing `TransactionFields` fragment from the mutation file, extended with `parentId` and `isoCurrencyCode` (both probed-and-confirmed on 2026-04-23).

```graphql
query Transactions(
  $first: Int
  $after: String
  $filter: TransactionFilter
  $sort: [TransactionSort!]
) {
  transactions(first: $first, after: $after, filter: $filter, sort: $sort) {
    edges {
      cursor
      node {
        __typename
        id
        accountId
        itemId
        categoryId
        recurringId
        parentId
        isReviewed
        isPending
        amount
        date
        name
        type
        userNotes
        tipAmount
        suggestedCategoryIds
        isoCurrencyCode
        createdAt
        tags { id name colorName }
        goal { id name }
      }
    }
    pageInfo { endCursor hasNextPage }
  }
}
```

`TransactionFilter` and `TransactionSort` shapes (from 2026-04-23 Chrome capture):

```graphql
input TransactionFilter {
  dates: [DateRangeInput!]
  accountIds: [AccountRefInput!]
  categoryIds: [ID!]
  recurringIds: [ID!]
  tagIds: [ID!]
  types: [TransactionType!]
  isReviewed: Boolean
  matchString: String
}

input DateRangeInput { from: String!, to: String! }   # "YYYY-MM-DD"
input AccountRefInput { accountId: ID!, itemId: ID! }
input TransactionSort { field: TransactionSortField!, direction: SortDirection! }
enum TransactionSortField { DATE, AMOUNT }
enum SortDirection { ASC, DESC }
enum TransactionType { REGULAR, INCOME, INTERNAL_TRANSFER, RECURRING }
```
