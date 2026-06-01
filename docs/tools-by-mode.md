# Tools by Mode

This server exposes different tools depending on which CLI flags you enable. The headline three-mode comparison lives in [the main README](../README.md#tools-by-mode); this document is the per-tool reference.

## 🟢 Default mode (`copilot-money-mcp`) — reads from local cache, no auth

| Tool | Status | Notes |
|---|---|---|
| `get_transactions` | ✅ | Query transactions with filters (date range, category, merchant, amount, account, text search, etc.) |
| `get_accounts` | ✅ | List accounts with balances; filter by type |
| `get_categories` | ✅ | Category hierarchy with spending totals |
| `get_budgets` | ✅ | Budgets vs. spending |
| `get_recurring_transactions` | ✅ | Detected subscriptions + recurring charges |
| `get_holdings` | ✅ | Investment positions with cost basis (cached) |
| `get_balance_history` | ✅ | Daily balance history; supports cross-account + daily/weekly/monthly granularity |
| `get_investment_prices` | ✅ | Historical price data |
| `get_investment_splits` | ⚠️ | Cache-only — returns stock-split events (date + multiplier) for held securities that have split. Empty for securities that never split. Note that prices from `get_investment_prices` are already split-adjusted; use this tool only for narrative/historical analysis. |
| `get_goals` | ⚠️ | Cache-only — Copilot's GraphQL endpoint doesn't expose goals data, so no `--live-reads` counterpart exists |
| `get_goal_history` | ⚠️ | Same — cache-only forever |
| `get_cache_info` | ✅ | Local cache metadata (utility) |
| `get_connection_status` | ✅ | Bank sync health (utility) |
| `refresh_database` | ✅ | Reload from disk (utility) |

## 🌐 `--live-reads` mode — real-time data via Copilot's GraphQL API (requires browser auth 🔒)

When enabled, 6 cache-mode read tools are replaced with GraphQL-backed equivalents, and 7 new live-only tools are added.

| Tool | Replaces? | Status | Notes |
|---|---|---|---|
| `get_transactions_live` | `get_transactions` | ✅ | Windowed cache; paginates per month |
| `get_accounts_live` | `get_accounts` | ✅ | 1h cache |
| `get_categories_live` | `get_categories` | ✅ | 24h cache; reflects rollovers per user setting |
| `get_budgets_live` | `get_budgets` | ✅ | Projection over `categories_live` data |
| `get_recurring_live` | `get_recurring_transactions` | ✅ | ⚠️ Pattern-based detection from transactions is NOT in live mode — use cache mode if you need that |
| `get_holdings_live` | `get_holdings` | ✅ | Includes cost basis via `metrics`; `metrics: null` for CASH and some 401(k) mutual fund positions (Copilot doesn't compute basis for those) |
| `get_tags_live` | _(additive)_ | ✅ | No cache-mode counterpart |
| `get_networth_live` | _(additive)_ | ✅ | Net worth over time |
| `get_upcoming_recurrings_live` | _(additive)_ | ✅ | Next-due unpaid recurrings (distinct from `get_recurring_live`'s historical view) |
| `get_monthly_spend_live` | _(additive)_ | ✅ | Daily-series spending for the current month with prior-period comparison |
| `get_balance_history_live` | _(additive)_ | ✅ | ⚠️ Single-account only (server constraint — requires `item_id` + `account_id`); use cache-mode `get_balance_history` for cross-account or weekly/monthly granularity |
| `get_investment_prices_live` | _(additive)_ | ✅ | ⚠️ Server-side ownership-gated: only works for securities currently in your linked accounts |
| `refresh_cache` | _(utility)_ | ✅ | Invalidate live-mode caches by scope |

## ✍️ `--write` mode — mutations via Copilot's GraphQL API (requires browser auth 🔒, implies `--live-reads`)

Enabling `--write` automatically turns on `--live-reads`, so the tools below are exposed **on top of** the live read surface in the previous section, not on top of cache-mode reads. Write tools resolve transaction account/item IDs against the live GraphQL surface, which avoids the ~30-day local cache cliff that would otherwise make older transactions un-editable.

| Tool | Status | Notes |
|---|---|---|
| `create_transaction` | ✅ | |
| `update_transaction` | ✅ | |
| `delete_transaction` | ✅ | |
| `split_transaction` | ✅ | |
| `add_transaction_to_recurring` | ✅ | Link an existing transaction to a recurring series |
| `review_transactions` | ✅ | Bulk-mark as reviewed/unreviewed |
| `create_category` / `update_category` / `delete_category` | ✅ | |
| `create_tag` / `update_tag` / `delete_tag` | ✅ | |
| `create_recurring` / `update_recurring` / `delete_recurring` | ✅ | |
| `set_recurring_state` | ✅ | Pause / resume |
| `set_budget` | ✅ | Setting amount to 0 effectively deletes |

## ⚠️ Known caveats

| Topic | Status |
|---|---|
| Goals (`get_goals`, `get_goal_history`) | ⚠️ Cache-only. Copilot's GraphQL endpoint doesn't expose goals. There is no live counterpart, and there are no goal write tools (goals are desktop-only in Copilot). |
| Goal write tools (`create_goal` / `update_goal` / `delete_goal`) | ❌ Not implemented. Copilot doesn't expose goal mutations via GraphQL. |
| Stock-split data | ⚠️ Available via `get_investment_splits` for currently-held securities that have split (one row per `(security_id, effective_date)` with adjustment multiplier). Empty for securities that never split. Securities a user no longer holds eventually fall out of the cache. There is no GraphQL endpoint for splits — this is the only way to get them, and only for held securities. |
| Long time-series responses | ⚠️ The MCP single-tool-result token cap means very long histories (e.g., multi-year daily prices or balances) are capped at 500 rows by default. Use `max_rows` / `offset` parameters, or narrow `time_frame` to fetch more. |
| 🔒 Browser authentication | Both `--live-reads` and `--write` require a logged-in browser session against `app.copilot.money` (the server uses the same Firebase refresh-token flow as the web app). Reads in default mode require nothing. |
