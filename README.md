# Copilot Money MCP Server

> Query and manage your personal finances with AI using local Copilot Money data

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 18+](https://img.shields.io/badge/node-18+-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/actions/workflows/test.yml)
[![codecov](https://codecov.io/gh/ignaciohermosillacornejo/copilot-money-mcp/branch/main/graph/badge.svg)](https://codecov.io/gh/ignaciohermosillacornejo/copilot-money-mcp)
[![copilot-money-mcp MCP server](https://glama.ai/mcp/servers/ignaciohermosillacornejo/copilot-money-mcp/badges/score.svg)](https://glama.ai/mcp/servers/ignaciohermosillacornejo/copilot-money-mcp)

## Disclaimer

**This is an independent, community-driven project and is not affiliated with, endorsed by, or associated with Copilot Money or its parent company in any way.** This tool was created by an independent developer to enable AI-powered queries of locally cached data. "Copilot Money" is a trademark of its respective owner.

## Overview

An [MCP](https://modelcontextprotocol.io/) server that gives AI assistants access to your Copilot Money personal finance data. It reads from the locally cached Firestore database (LevelDB + Protocol Buffers) on your Mac. **Reads are 100% local with zero network requests.**

**13 cache-mode read tools + 13 live-mode tools + 17 write tools** — query and modify transactions, accounts, holdings, balances, categories, recurring charges, budgets, goals, and investment performance.

## Privacy First

We never collect, store, or transmit your data to any server operated by this project — we don't have any. See our [Privacy Policy](PRIVACY.md) for details.

- No analytics, telemetry, or tracking of any kind
- Reads are fully local — zero network requests
- Open source — verify the code yourself

> [!IMPORTANT]
> **Heads up about AI providers.** While this server itself runs locally and never sends your data to any server operated by this project, **the AI assistant you connect it to (Claude, ChatGPT, Gemini, etc.) will see your Copilot Money data** as part of answering your questions. That means your financial data will be transmitted to and processed by the provider of whichever model you choose — **Anthropic, OpenAI, Google, or another third party** — subject to that provider's own privacy policy and data retention terms.
>
> **By using this MCP server with a hosted AI model, you are knowingly sharing your financial data with that AI provider.** Only use this tool if you are comfortable with that trade-off. If you are not, consider waiting for an official Copilot Money integration or using a fully local model.

## Tools by Mode

This server exposes different tools depending on which CLI flags you enable.

### 🟢 Default mode (`copilot-money-mcp`) — reads from local cache, no auth

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
| `get_goals` | ⚠️ | Cache-only — Copilot's GraphQL endpoint doesn't expose goals data, so no `--live-reads` counterpart exists |
| `get_goal_history` | ⚠️ | Same — cache-only forever |
| `get_cache_info` | ✅ | Local cache metadata (utility) |
| `get_connection_status` | ✅ | Bank sync health (utility) |
| `refresh_database` | ✅ | Reload from disk (utility) |

### 🌐 `--live-reads` mode — real-time data via Copilot's GraphQL API (requires browser auth 🔒)

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

### ✍️ `--write` mode — mutations via Copilot's GraphQL API (requires browser auth 🔒)

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

### ⚠️ Known caveats

| Topic | Status |
|---|---|
| Goals (`get_goals`, `get_goal_history`) | ⚠️ Cache-only. Copilot's GraphQL endpoint doesn't expose goals. There is no live counterpart, and there are no goal write tools (goals are desktop-only in Copilot). |
| Goal write tools (`create_goal` / `update_goal` / `delete_goal`) | ❌ Not implemented. Copilot doesn't expose goal mutations via GraphQL. |
| Stock-split data | ⚠️ Copilot's local cache contains only empty placeholder records (no split dates / ratios), and there is no GraphQL endpoint for splits. The previous `get_investment_splits` cache-mode tool returned no useful data and was removed. |
| Long time-series responses | ⚠️ The MCP single-tool-result token cap means very long histories (e.g., multi-year daily prices or balances) are capped at 500 rows by default. Use `max_rows` / `offset` parameters, or narrow `time_frame` to fetch more. |
| 🔒 Browser authentication | Both `--live-reads` and `--write` require a logged-in browser session against `app.copilot.money` (the server uses the same Firebase refresh-token flow as the web app). Reads in default mode require nothing. |

---

## Quick Start

### Prerequisites

- **Node.js 18+** (comes bundled with Claude Desktop)
- **Copilot Money** (macOS App Store version)
- **Claude Desktop**, **Cursor**, or any MCP-compatible client

### Installation via Claude Desktop

1. Download the latest `.mcpb` bundle from [Releases](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/releases)
2. Double-click the `.mcpb` file to install in Claude Desktop
3. Restart Claude Desktop
4. Start asking questions about your finances!

### Installation via npm

```bash
npm install -g copilot-money-mcp
```

Then add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "copilot-money": {
      "command": "copilot-money-mcp"
    }
  }
}
```

### Installation for Cursor

1. Install the package globally:
   ```bash
   npm install -g copilot-money-mcp
   ```

2. Open Cursor Settings (`Cmd + ,`) > **Features > MCP Servers**

3. Add the server configuration:
   ```json
   {
     "mcpServers": {
       "copilot-money": {
         "command": "copilot-money-mcp"
       }
     }
   }
   ```

## What You Can Do

### Spending Analysis

> "How much did I spend on dining out last month?"

> "Show me all my Amazon purchases in the last 30 days"

> "What are my top 5 spending categories this year?"

Uses `get_transactions`, `get_categories` with date ranges, text search, and category filters.

### Account Overview

> "What's my net worth across all accounts?"

> "Show me my checking account balance over the past 6 months, monthly"

> "Which bank connections need attention?"

Uses `get_accounts`, `get_balance_history`, `get_connection_status`.

### Investment Portfolio

> "What are my current holdings and total returns?"

> "Show me AAPL price history for the past year"

> "What's my current cost basis on META?"

Uses `get_holdings` (or `get_holdings_live` for live cost basis), `get_investment_prices` (or `get_investment_prices_live` for live per-security price history).

### Budgets & Goals

> "Am I on track with my budgets this month?"

> "How is my emergency fund progressing?"

> "Show me my goal history over the past 6 months"

Uses `get_budgets`, `get_goals`, `get_goal_history`.

### Subscriptions & Recurring

> "What subscriptions am I paying for?"

> "How much do I spend on recurring charges per month?"

Uses `get_recurring_transactions`.

## Configuration

### Cache TTL

The server caches data in memory for 5 minutes. Configure via environment variable:

```bash
# Set cache TTL to 10 minutes
COPILOT_CACHE_TTL_MINUTES=10 copilot-money-mcp

# Disable caching (always reload from disk)
COPILOT_CACHE_TTL_MINUTES=0 copilot-money-mcp
```

You can also refresh manually using the `refresh_database` tool.

### Decode Timeout

For large databases (500MB+), increase the decode timeout (default: 90 seconds):

```bash
# Via environment variable
DECODE_TIMEOUT_MS=600000 copilot-money-mcp

# Via CLI flag
copilot-money-mcp --timeout 600000
```

For databases over 1GB, also increase Node.js memory:

```json
{
  "mcpServers": {
    "copilot-money": {
      "command": "node",
      "args": [
        "--max-old-space-size=4096",
        "/path/to/copilot-money-mcp/dist/cli.js",
        "--timeout", "600000"
      ]
    }
  }
}
```

### Supported Date Periods

The `period` parameter supports these shortcuts:

`this_month` `last_month` `last_7_days` `last_30_days` `last_90_days` `ytd` `this_year` `last_year`

## Known Limitations

### Local Cache Dependency

This server reads from Copilot Money's **local Firestore cache**, not the cloud. Firestore's offline persistence caches every document the app has ever fetched, so the local database generally contains all transactions, accounts, budgets, goals, and other data you've viewed in the app. The default Firestore cache size is 100 MB (enough for tens of thousands of transactions), and older documents are only evicted via LRU garbage collection if that limit is exceeded.

**To maximize cached data:** Open the Copilot Money app and browse through your data (transaction history, accounts, budgets) to ensure it has been fetched and cached locally.

## Troubleshooting

### Database Not Found

If you see "Database not available":
1. Ensure Copilot Money is installed and has synced data
2. Check the database location: `~/Library/Containers/com.copilot.production/Data/Library/Application Support/firestore/__FIRAPP_DEFAULT/copilot-production-22904/main`
3. Verify `.ldb` files exist in the directory
4. Provide a custom path: `copilot-money-mcp --db-path /path/to/database`

### Decode Worker Timed Out

If you see "Decode worker timed out":
1. Increase the timeout: `copilot-money-mcp --timeout 300000` (5 minutes)
2. For 1GB+ databases, also increase Node.js memory: `node --max-old-space-size=4096 dist/cli.js --timeout 300000`

### No Transactions Found

- Open the Copilot Money app and wait for sync
- The database structure may have changed — [open an issue](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture, and how to add new tools.

## License

MIT License - See [LICENSE](LICENSE) for details.

## Acknowledgments

- Built with [MCP SDK](https://modelcontextprotocol.io/) by Anthropic
- Data validation with [Zod](https://zod.dev/)
- Developed with [Bun](https://bun.sh/)
