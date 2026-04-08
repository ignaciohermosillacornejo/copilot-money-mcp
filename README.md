# Copilot Money MCP Server

> Query and manage your personal finances with AI using local Copilot Money data

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 18+](https://img.shields.io/badge/node-18+-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-1400+-brightgreen.svg)](https://github.com/ignaciohermosillacornejo/copilot-money-mcp)
[![Tools](https://img.shields.io/badge/tools-41-blue.svg)](https://github.com/ignaciohermosillacornejo/copilot-money-mcp)

## Disclaimer

**This is an independent, community-driven project and is not affiliated with, endorsed by, or associated with Copilot Money or its parent company in any way.** This tool was created by an independent developer to enable AI-powered queries of locally cached data. "Copilot Money" is a trademark of its respective owner.

## Overview

An [MCP](https://modelcontextprotocol.io/) server that gives AI assistants access to your Copilot Money personal finance data. It reads from the locally cached Firestore database (LevelDB + Protocol Buffers) on your Mac — **100% local processing**, no network requests, all data stays on your machine.

**41 tools** across spending, investments, budgets, goals, and more:

- **17 read tools** — query transactions, accounts, holdings, balances, categories, recurring charges, budgets, goals, investment performance, and more
- **24 write tools** (opt-in) — categorize transactions, manage tags, create budgets, update recurring items, and organize your finances

**Read-only by default.** Write tools require explicitly starting the server with `--write` to enable.

## Privacy First

Your financial data never leaves your machine. See our [Privacy Policy](PRIVACY.md) for details.

- No data collection or transmission
- No external API calls (write mode uses local Firestore REST API only)
- No analytics or telemetry
- Read-only by default
- Open source — verify the code yourself

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

> "What's my time-weighted return this quarter?"

Uses `get_holdings`, `get_investment_prices`, `get_securities`, `get_investment_performance`, `get_twr_returns`.

### Budgets & Goals

> "Am I on track with my budgets this month?"

> "How is my emergency fund progressing?"

> "Show me my goal history over the past 6 months"

Uses `get_budgets`, `get_goals`, `get_goal_history`.

### Subscriptions & Recurring

> "What subscriptions am I paying for?"

> "How much do I spend on recurring charges per month?"

Uses `get_recurring_transactions`.

### Organizing Your Finances (Write Mode)

> "Categorize all my Uber transactions as transportation"

> "Tag my vacation spending with #vacation"

> "Create a $500 monthly dining budget"

> "Set up Netflix as a monthly recurring charge"

Uses write tools like `set_transaction_category`, `set_transaction_tags`, `create_budget`, `update_recurring`, and more. Requires `--write` flag.

## Available Tools

### Read Tools (17)

| Tool | Description |
|------|-------------|
| `get_transactions` | Query transactions with filters — date range, category, merchant, amount, account, location, text search, and special types (foreign, refunds, duplicates, HSA-eligible). |
| `get_accounts` | List all accounts with balances, filter by type (checking, savings, credit, investment). Includes net worth calculation. |
| `get_categories` | List categories with transaction counts and spending totals. Supports list, tree, and search views. |
| `get_recurring_transactions` | Identify subscriptions and recurring charges with frequency, cost, and next expected date. |
| `get_budgets` | Get budgets with spending vs. limit comparisons. |
| `get_goals` | Get financial goals with target amounts, progress, and monthly contributions. |
| `get_goal_history` | Monthly progress snapshots for goals with daily data and contribution records. |
| `get_balance_history` | Daily balance snapshots for accounts over time. Supports daily, weekly, or monthly granularity. |
| `get_holdings` | Current investment holdings with ticker, quantity, price, cost basis, and total return. |
| `get_investment_prices` | Historical price data (daily + high-frequency) for stocks, ETFs, mutual funds, and crypto. |
| `get_investment_splits` | Stock split history with ratios, dates, and multipliers. |
| `get_investment_performance` | Per-security investment performance data. |
| `get_twr_returns` | Time-weighted return (TWR) monthly data for investment holdings. |
| `get_securities` | Security master data — ticker, name, type, price, and identifiers (ISIN/CUSIP). |
| `get_connection_status` | Bank sync health for linked institutions, including last sync timestamps and errors. |
| `get_cache_info` | Local cache metadata — date range, transaction count, cache age. |
| `refresh_database` | Reload data from disk. Cache auto-refreshes every 5 minutes. |

### Write Tools (24) — requires `--write` flag

| Category | Tools |
|----------|-------|
| **Transactions** | `set_transaction_category`, `set_transaction_name`, `set_transaction_note`, `set_transaction_tags`, `set_transaction_excluded`, `set_transaction_goal`, `set_internal_transfer`, `review_transactions` |
| **Tags** | `create_tag`, `update_tag`, `delete_tag` |
| **Categories** | `create_category`, `update_category`, `delete_category` |
| **Budgets** | `create_budget`, `update_budget`, `delete_budget` |
| **Goals** | `create_goal`, `update_goal`, `delete_goal` |
| **Recurring** | `create_recurring`, `update_recurring`, `set_recurring_state`, `delete_recurring` |

## Write Mode

By default, the server starts in **read-only mode**. To enable write tools, start the server with the `--write` flag:

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

Write tools modify your Copilot Money data via the local Firestore cache. Changes sync back to Copilot Money when the app is open.

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

### Local Cache Size

This server reads from Copilot Money's **local Firestore cache**, not the cloud. The cache typically contains ~500 recent transactions plus accounts, budgets, goals, and recurring data synced during app usage.

**To maximize cached data:** Open the Copilot Money app regularly and scroll through your transaction history to trigger sync.

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
