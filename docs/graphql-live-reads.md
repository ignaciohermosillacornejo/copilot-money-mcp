# GraphQL Live Reads

The `--live-reads` CLI flag swaps the cache-backed `get_transactions` MCP tool for a GraphQL-backed `get_transactions_live` that reads directly from Copilot's web API. Use it when the local LevelDB cache is missing data for the window you need — most commonly for historical reconciliation like `/amazon-sync` on older years.

This is Phase 1 of a progressive migration off LevelDB. See `docs/superpowers/specs/2026-04-23-graphql-live-reads-design.md` for the full roadmap.

## Starting with live reads

```bash
copilot-money-mcp --live-reads
# or alongside writes
copilot-money-mcp --write --live-reads
```

Prerequisites:
- You must be logged into `app.copilot.money` in Chrome, Arc, Safari, or Firefox. The MCP extracts a Firebase refresh token from browser storage.
- Network connectivity to `app.copilot.money`.

If auth fails at boot, the server logs a diagnostic line to stderr and exits non-zero. Claude Desktop will show the transport as closed; check the MCP server logs for the explanation.

## What changes when `--live-reads` is on

| Aspect | `--live-reads` off (default) | `--live-reads` on |
|---|---|---|
| Tool name | `get_transactions` | `get_transactions_live` |
| Data source | Local LevelDB cache | Copilot GraphQL API |
| Freshness | Hydrated by the Copilot macOS app as the user scrolls | Live — always matches what the web UI sees |
| Location filters (`city`, `lat`, `lon`, `region`, `country`, `radius_km`) | Supported | **Not supported** (GraphQL has no location fields) |
| `transaction_type: foreign \| duplicates` | Supported | **Not supported** |
| `exclude_split_parents: false` | Supported | **Not supported** (server omits parents) |
| `transaction_id` single lookup | Requires only the ID | Requires `transaction_id` + `account_id` + `item_id` |
| Auth required | No | Yes |

Every unsupported filter produces an error message telling the LLM to retry without that parameter — it doesn't silently drop.

## Filter reference for `get_transactions_live`

### Server-side filters (fast)

These translate into Copilot's `TransactionFilter` and run on the server:

- `start_date`, `end_date`, `period` → `filter.dates: [{from, to}]`
- `account_id` → `filter.accountIds: [{accountId, itemId}]` (itemId resolved from local account cache)
- `category` (as ID) → `filter.categoryIds: [id]`
- `tag` (by name) → resolved via local tag cache → `filter.tagIds: [id]`
- `merchant` or `query` → `filter.matchString` (substring match against name)
- `exclude_transfers: true` → `filter.types: [REGULAR, INCOME]` (the enum is only `REGULAR | INCOME | INTERNAL_TRANSFER` — the UI's "Recurring" filter is `recurringIds`, not a type)

### Client-side post-filters (applied after pagination)

These run on pages of results as they return, because GraphQL doesn't support them server-side:

- `min_amount` / `max_amount` — absolute-value comparison
- `pending` — filter on the `isPending` flag
- `exclude_excluded` — cross-reference against `Category.isExcluded` from the local cache
- `transaction_type: refunds | credits | hsa_eligible | tagged`
- `limit`, `offset` — applied to the full result set after filtering

### `exclude_deleted` / `exclude_split_parents: true`

Both are no-ops in live mode. The GraphQL server doesn't return deleted or split-parent rows in the Transactions query, so there's nothing to filter out on the client.

## Errors and what they mean

All errors surface as `isError: true` tool results.

- `"Parameter 'city' is not supported in live mode. Retry without 'city'. Supported filters: ..."` — LLM should drop the filter and retry.
- `"transaction_id lookup in live mode requires account_id and item_id."` — call get_transactions_live with all three; they're returned together by any prior list call.
- `"Network error reaching Copilot GraphQL API."` — transient; the tool already retried once. Try again or check connectivity.
- `"Authentication expired or invalid."` — re-open `app.copilot.money` in your browser to refresh the token, then restart the MCP server.
- `"GraphQL schema error (bug in copilot-money-mcp): ..."` — Copilot changed its API. File an issue.
- `"Server rejected request: <message>"` — the server returned a validation error like "Tag name must be unique" or "Account not found".

## Migration roadmap

`_live` suffix is transitional. When every cache-backed read tool has a GraphQL-backed equivalent and measurement shows live reads are fast enough, a future release will flip `--live-reads` on by default and rename `get_<entity>_live` → `get_<entity>`, retiring the flag.

Current phase: **1** — only `get_transactions_live`. Phases 2..N will add `_live` variants for accounts, categories, budgets, recurring transactions, and tags.

## Performance note

GraphQL reads paginate server-side (page size 100 by default). Narrow queries (e.g. one month of one account) typically run in <1s. Broad queries (full year, no account filter) paginate multiple pages — the server has limits on single-response size. When `--verbose` is set, the server logs per-call latency and pagination counts to stderr as `[graphql-read] op=Transactions pages=N latency=Xms rows=Y`. This data informs whether future phases need a richer caching strategy.
