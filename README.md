# Copilot Money MCP Server

> Query and manage your personal finances with AI using local Copilot Money data

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 18+](https://img.shields.io/badge/node-18+-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/actions/workflows/test.yml)
[![codecov](https://codecov.io/gh/ignaciohermosillacornejo/copilot-money-mcp/branch/main/graph/badge.svg)](https://codecov.io/gh/ignaciohermosillacornejo/copilot-money-mcp)
[![copilot-money-mcp MCP server](https://glama.ai/mcp/servers/ignaciohermosillacornejo/copilot-money-mcp/badges/score.svg)](https://glama.ai/mcp/servers/ignaciohermosillacornejo/copilot-money-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-copilot--money--mcp-blue)](https://registry.modelcontextprotocol.io/?q=copilot-money-mcp)

## Disclaimer

**This is an independent, community-driven project and is not affiliated with, endorsed by, or associated with Copilot Money or its parent company in any way.** This tool was created by an independent developer to enable AI-powered queries of locally cached data. "Copilot Money" is a trademark of its respective owner.

> [!NOTE]
> **Copilot Money has announced an official MCP server (currently in waitlist, read-only).** If a first-party, read-only integration suits your needs, you should strongly consider using it instead of this community project. Learn more and join the waitlist at [agent.copilot.money](https://agent.copilot.money/#mcp).
>
> This project remains useful if you need write tools (categorize transactions, manage budgets, edit recurrings, etc.), fully offline cache-mode reads with zero network requests, or simply want access today without waiting for the official rollout.

## Overview

An [MCP](https://modelcontextprotocol.io/) server that gives AI assistants access to your Copilot Money personal finance data. It reads from the locally cached Firestore database (LevelDB + Protocol Buffers) on your Mac. **Reads are 100% local with zero network requests.**

**14 cache-mode read tools (or 21 in `--live-reads` mode: 8 surviving cache + 13 live), plus up to 17 write tools** — query and modify transactions, accounts, holdings, balances, categories, recurring charges, budgets, goals, and investment performance. See [Tools by Mode](#tools-by-mode) below.

> Contributors: writes go through an API we don't own. How the repo keeps its model of Copilot's GraphQL surface from silently drifting — the conformance ledger, live smokes, and weekly drift check — is documented in [`docs/CONFORMANCE_ARCHITECTURE.md`](docs/CONFORMANCE_ARCHITECTURE.md).

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

| Mode | Flag | What it does | Auth | Network | Tools available |
|---|---|---|---|---|---|
| 🟢 Default | _(none)_ | Reads from your local LevelDB cache | ❌ None | 🔌 Zero (offline) | 14 cache-mode read + utility tools |
| 🌐 Live reads | `--live-reads` | Real-time reads via Copilot's GraphQL API; swaps out 6 cache tools and adds 7 live-only ones | 🔒 Browser session | 🌐 HTTPS per request | 21 read tools (8 cache + 13 live) |
| ✍️ Writes | `--write` | Adds mutation tools (transactions, tags, categories, budgets, recurrings, splits) **and turns on `--live-reads` automatically** — writes need server-fresh transaction metadata, so live reads are coupled to write mode | 🔒 Browser session | 🌐 HTTPS per request | +17 write tools, on top of the 21 live read tools |

Passing `--write` implies `--live-reads`; you can still pass `--live-reads` on its own for read-only live access.

📖 **See [docs/tools-by-mode.md](docs/tools-by-mode.md)** for the full per-tool inventory with status, caveats, and known limitations (goals, stock splits, response-size caps).

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

Uses `get_transactions` (or `get_transactions_live` for fresh data via `--live-reads`) and `get_categories` (or `get_categories_live`), with date ranges, text search, and category filters.

### Account Overview

> "What's my net worth across all accounts?"

> "Show me my checking account balance over the past 6 months, monthly"

> "Which bank connections need attention?"

Uses `get_accounts` (or `get_accounts_live` for fresh balances via `--live-reads`), `get_balance_history` (with optional `get_balance_history_live` per-account live variant), `get_connection_status`, and `get_networth_live` for net-worth-over-time charts.

### Investment Portfolio

> "What are my current holdings and total returns?"

> "Show me the price history for my largest equity holding over the past year"

> "What's my current cost basis on META?"

Uses `get_holdings` (or `get_holdings_live` for live cost basis), `get_investment_prices` (or `get_investment_prices_live` for live per-security price history).

### Budgets & Goals

> "Am I on track with my budgets this month?"

> "How is my emergency fund progressing?"

> "Show me my goal history over the past 6 months"

Uses `get_budgets` (or `get_budgets_live` via `--live-reads`), and `get_goals` / `get_goal_history` (cache-only — Copilot's GraphQL endpoint doesn't expose goal data).

### Subscriptions & Recurring

> "What subscriptions am I paying for?"

> "How much do I spend on recurring charges per month?"

Uses `get_recurring_transactions` (or `get_recurring_live` via `--live-reads`) and `get_upcoming_recurrings_live` for next-due unpaid items.

## Configuration

### Cache TTL

The server caches data in memory for 5 minutes. Configure via environment variable:

```bash
# Set cache TTL to 10 minutes
COPILOT_CACHE_TTL_MINUTES=10 copilot-money-mcp

# Disable caching (always reload from disk)
COPILOT_CACHE_TTL_MINUTES=0 copilot-money-mcp

# Write tools resolve account/item ids for a transaction id via a live
# window fetch when the in-memory index (fed by live reads) misses.
# Default window: 13 months. Raise it to edit older transactions:
COPILOT_WRITE_RESOLVE_WINDOW_MONTHS=30 copilot-money-mcp --write
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

## Authentication & Optional Modes

Both `--live-reads` and `--write` make authenticated calls to Copilot Money's GraphQL API at `app.copilot.money/api/graphql`. They require a **logged-in browser session** against `app.copilot.money` — the server reads the same Firebase refresh token the web app stores in your browser (Chrome, Arc, Safari, or Firefox).

Default mode requires no authentication and makes zero network requests — reads come from the local LevelDB cache.

### `--live-reads`: real-time reads via GraphQL

```bash
copilot-money-mcp --live-reads
```

Replaces 6 cache-mode read tools (`get_transactions`, `get_accounts`, `get_categories`, `get_budgets`, `get_recurring_transactions`, `get_holdings`) with live GraphQL-backed equivalents, and adds 7 net-new ones (`get_tags_live`, `get_networth_live`, `get_upcoming_recurrings_live`, `get_monthly_spend_live`, `get_balance_history_live`, `get_investment_prices_live`, `refresh_cache`).

Use this when:
- You need transactions the macOS app hasn't pre-fetched yet (the auto-fetch window is typically ~30 days; past that, open the app and scroll back to force the cache to populate, or use `--live-reads` to query the server directly).
- You want fresh per-security cost basis or balance-over-time data.
- The macOS app hasn't synced recently.

### `--write`: mutations via GraphQL (implies `--live-reads`)

```bash
copilot-money-mcp --write
```

Adds 17 mutation tools for transactions, tags, categories, recurrings, budgets, and split-transactions. Off by default — the server is read-only unless you opt in.

`--write` automatically enables `--live-reads` as well. Write tools resolve transaction metadata (account/item IDs) against the live GraphQL surface so they can edit any transaction the API exposes, not just the ~30 days the local LevelDB cache happens to hold. Once you've consented to the authenticated network calls writes require, there's no privacy or perf reason to keep reads pinned to the stale cache.

```bash
copilot-money-mcp --write --live-reads   # equivalent to `--write` alone; --live-reads is redundant
```

### Configuring via Claude Desktop / Cursor

Add the flags to the `args` array in your MCP config:

```json
{
  "mcpServers": {
    "copilot-money": {
      "command": "copilot-money-mcp",
      "args": ["--write"]
    }
  }
}
```

Restart Claude Desktop / Cursor after editing.

## Known Limitations

### Local Cache Dependency

This server reads from Copilot Money's **local Firestore cache**, not the cloud. Firestore's offline persistence caches every document the app has ever fetched, so the local database generally contains all transactions, accounts, budgets, goals, and other data you've viewed in the app. The default Firestore cache size is 100 MB (enough for tens of thousands of transactions), and older documents are only evicted via LRU garbage collection if that limit is exceeded.

**To maximize cached data:** Open the Copilot Money app and browse through your data (transaction history, accounts, budgets) to ensure it has been fetched and cached locally.

### Goals are read-only

`get_goals` and `get_goal_history` work (cache-only), but there are no goal write tools — Copilot's GraphQL endpoint doesn't expose goal mutations. Goal creation, editing, and contributions are mobile-only in Copilot itself, and live in a path our project can't reach without iOS / desktop traffic capture.

### Investment splits are limited to currently-held securities

`get_investment_splits` returns split events (date + adjustment multiplier) for securities you currently hold. Securities you no longer hold eventually fall out of the cache. There's no GraphQL endpoint for splits, so this is the only path.

Also: `get_investment_prices` and `get_investment_prices_live` already return split- and dividend-adjusted prices (Copilot applies Plaid's adjustment factors server-side). You generally don't need raw split events to back-correct prices.

### Live investment prices are ownership-gated

`get_investment_prices_live` only works for securities currently in your linked accounts. Asking for a price series on a ticker you don't own returns an explicit "not in your linked accounts" error.

### Long time-series responses are capped

Time-series live tools (`get_balance_history_live`, `get_networth_live`, `get_investment_prices_live`) cap responses at 500 rows by default to fit the MCP single-tool-result token limit. Pass `max_rows` / `offset` to paginate, or narrow `time_frame` for fewer rows.

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
