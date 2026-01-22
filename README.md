# Copilot Money MCP Server

> AI-powered personal finance queries using local Copilot Money data

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 18+](https://img.shields.io/badge/node-18+-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/Tests-Passing-brightgreen.svg)](https://github.com/ignaciohermosillacornejo/copilot-money-mcp)

## Disclaimer

**This is an independent, community-driven project and is not affiliated with, endorsed by, or associated with Copilot Money or its parent company in any way.** This tool was created by an independent developer to enable AI-powered queries of locally cached data. "Copilot Money" is a trademark of its respective owner.

## Overview

This MCP (Model Context Protocol) server enables AI-powered queries of your Copilot Money personal finance data by reading locally cached Firestore data (LevelDB + Protocol Buffers). **100% local processing** - no network requests, all data stays on your machine.

**Key Features:**
- 🔒 **100% Local & Private** - Reads from local cache, zero network requests
- 🤖 **AI-Powered** - Natural language queries via Claude Desktop
- ⚡ **Fast** - Processes thousands of transactions in under 2 seconds
- 🛡️ **Read-Only** - Never modifies your Copilot Money data
- 📦 **Easy Install** - One-click .mcpb bundle for Claude Desktop

## Privacy First

Your financial data never leaves your machine. See our [Privacy Policy](PRIVACY.md) for details.

- ✅ No data collection or transmission
- ✅ No external API calls
- ✅ No analytics or telemetry
- ✅ Read-only access to local database
- ✅ Open source - verify the code yourself

## Quick Start

### Prerequisites

- **Node.js 18+** (comes bundled with Claude Desktop)
- **Copilot Money** (macOS App Store version)
- **Claude Desktop** with MCP support

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

2. Open Cursor Settings (`Cmd + ,`)

3. Search for "MCP" or go to **Features > MCP Servers**

4. Add the server configuration:
   ```json
   {
     "mcpServers": {
       "copilot-money": {
         "command": "copilot-money-mcp"
       }
     }
   }
   ```

5. Restart Cursor

### Manual Installation for Development

```bash
# Clone the repository
git clone https://github.com/ignaciohermosillacornejo/copilot-money-mcp.git
cd copilot-money-mcp

# Install dependencies
bun install

# Build the project
bun run build

# Run tests
bun test
```

## First-Time Setup

After installing the MCP server, Claude Desktop will request **one-time approval for each tool** when you first use them. This is a standard security feature for all MCP servers.

**What to expect:**
- You'll see approval prompts as you use different tools
- Each prompt shows the tool name and what it does
- After approving once, the tools work seamlessly without further prompts

**Why this happens:**
- Claude Desktop requires explicit user consent before an MCP tool can access your data
- Even though all our tools are read-only (with `readOnlyHint: true`), Claude Desktop shows these prompts as a security best practice
- This is normal behavior and not specific to this MCP server

**After first use:** Once you've approved all tools, they'll work instantly without any prompts in future conversations!

## Working Examples

### Example 1: Monthly Spending Analysis

**User Query:**
> "How much did I spend on dining out last month?"

**MCP Tool Call:**
```json
{
  "tool": "get_transactions",
  "arguments": {
    "category": "food_and_drink",
    "period": "last_month"
  }
}
```

**Claude's Answer:**
> "Last month you spent $487.50 on dining out across 23 transactions. Your largest expense was $67.50 at The Italian Place on January 15th."

---

### Example 2: Finding Specific Transactions

**User Query:**
> "Show me all my Amazon purchases in the last 30 days"

**MCP Tool Call:**
```json
{
  "tool": "get_transactions",
  "arguments": {
    "merchant": "amazon",
    "period": "last_30_days"
  }
}
```

**Claude's Answer:**
> "You made 7 Amazon purchases in the last 30 days, totaling $234.87. The largest was $47.99 on January 5th. You also had a Prime subscription charge of $23.50."

---

### Example 3: Account Overview

**User Query:**
> "What's my current account balance across all accounts?"

**MCP Tool Call:**
```json
{
  "tool": "get_accounts",
  "arguments": {}
}
```

**Claude's Answer:**
> "Your total balance across all accounts is $12,547.83. This includes:
> - Chase Checking: $3,247.50
> - Ally Savings: $8,500.33
> - Chase Freedom Credit: $800.00 (current balance)"

## Available Tools

The MCP server provides **8 read-only tools** for querying your financial data:

| Tool | Description |
|------|-------------|
| `get_transactions` | Query transactions with filters (date, category, merchant, amount, account, location). Supports period shortcuts, text search, and special types (foreign, refunds, duplicates). |
| `get_accounts` | List all accounts with balances, optionally filter by type (checking, savings, credit, investment). |
| `get_categories` | List all transaction categories with human-readable names, transaction counts, and spending totals. Filter by date range. |
| `get_recurring_transactions` | Identify subscriptions and recurring charges with frequency, monthly cost, and next expected date. Filter by name for detailed view. |
| `get_budgets` | Get budgets from Copilot's native budget tracking with spending vs. limit comparisons. |
| `get_goals` | Get financial goals with progress tracking, monthly history, and savings status. |
| `get_cache_info` | Get information about the local data cache, including date range and transaction count. |
| `refresh_database` | Refresh the in-memory cache to pick up newly synced data from Copilot Money. Cache auto-refreshes every 5 minutes. |

See tool schemas in Claude Desktop or use the MCP Inspector for complete parameter documentation.

## Development

### Build Commands

```bash
# Install dependencies
bun install

# Run tests
bun test

# Build for production
bun run build

# Build .mcpb bundle
bun run pack:mcpb

# Type checking
bun run typecheck

# Linting
bun run lint
bun run lint:fix

# Formatting
bun run format
bun run format:check

# Run all checks (typecheck + lint + format + test)
bun run check
```

### Project Structure

```
copilot-money-mcp/
├── src/
│   ├── core/              # Database abstraction & binary decoder
│   ├── models/            # Zod schemas (Transaction, Account, Category)
│   ├── tools/             # MCP tool implementations
│   ├── utils/             # Date utilities
│   ├── server.ts          # MCP server
│   └── cli.ts             # CLI entry point
├── tests/
│   ├── core/              # Core module tests
│   └── tools/             # Tool tests
├── dist/                  # Compiled output
├── PRIVACY.md             # Privacy policy
└── manifest.json          # .mcpb metadata
```

### Architecture

**Data Flow:**
1. Copilot Money stores data in local LevelDB/Firestore cache
2. Binary decoder reads `.ldb` files and parses Protocol Buffers
3. Database layer provides filtered access to transactions/accounts
4. MCP tools expose functionality via Model Context Protocol
5. Claude Desktop sends queries → MCP server responds

**Technical Stack:**
- **Runtime:** Node.js 18+ (ESM modules)
- **Language:** TypeScript 5.3+
- **Validation:** Zod schemas
- **Database:** LevelDB (classic-level) + Protocol Buffers
- **Testing:** Bun test runner (772 tests, 100% passing)
- **MCP SDK:** @modelcontextprotocol/sdk v1.2

## Testing

```bash
# Run all tests
bun test

# Watch mode
bun test --watch

# Run specific test file
bun test tests/tools/tools.test.ts
```

**Test Coverage:**
- ✅ 772 tests passing
- ✅ 1920+ assertions
- ✅ Core decoder tests
- ✅ Database abstraction tests
- ✅ Tool implementation tests
- ✅ Schema validation tests
- ✅ Integration tests

## Data Privacy & Security

**Read our full [Privacy Policy](PRIVACY.md)**

Key commitments:
- **No Data Transmission:** Zero network requests, all processing local
- **Read-Only Access:** Never modifies your Copilot Money database
- **No Telemetry:** No analytics, crash reports, or tracking
- **Open Source:** Verify privacy claims by reviewing the code
- **macOS Sandbox:** Respects macOS file system permissions

## Supported Date Periods

The `period` parameter supports these shortcuts:
- `this_month` - Current month (Jan 1 - today if in January)
- `last_month` - Previous calendar month
- `last_7_days` - Rolling 7-day window
- `last_30_days` - Rolling 30-day window
- `last_90_days` - Rolling 90-day window
- `ytd` - Year-to-date (Jan 1 - today)
- `this_year` - Current calendar year
- `last_year` - Previous calendar year

## Configuration

### Cache TTL

The MCP server caches data in memory for 5 minutes by default. You can configure this via environment variable:

```bash
# Set cache TTL to 10 minutes
COPILOT_CACHE_TTL_MINUTES=10 copilot-money-mcp

# Disable caching (always reload from disk)
COPILOT_CACHE_TTL_MINUTES=0 copilot-money-mcp
```

You can also manually refresh the cache using the `refresh_database` tool.

## Known Limitations

### Local Cache Size

This MCP server reads from Copilot Money's **local Firestore cache**, not directly from the cloud. The cache typically contains:
- **~500 recent transactions** (not your full history)
- Accounts, budgets, goals, and recurring transactions
- Data synced during recent app usage

**Why this limitation exists:** Copilot Money uses Firebase/Firestore with App Check security, which prevents direct cloud database access. The local cache is an offline copy maintained by the app for performance.

**To maximize cached data:**
1. Open the Copilot Money app regularly
2. Scroll through your transaction history to trigger sync
3. The cache updates when you interact with the app

**What you get:** While you may have thousands of transactions in Copilot Money, only recently accessed/synced data is available locally. This is sufficient for most queries (recent spending, current budgets, recurring charges) but won't include your complete historical data.

## Troubleshooting

### Database Not Found

If you see "Database not available":
1. Ensure Copilot Money is installed and has synced data
2. Check database location: `~/Library/Containers/com.copilot.production/Data/Library/Application Support/firestore/__FIRAPP_DEFAULT/copilot-production-22904/main`
3. Verify `.ldb` files exist in the directory
4. Provide custom path: `copilot-money-mcp --db-path /path/to/database`

### No Transactions Found

- Copilot Money may not have synced yet - open the app and wait for sync
- The database structure may have changed - open an issue with details

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - See [LICENSE](LICENSE) for details.

## Acknowledgments

- Built with [MCP SDK](https://modelcontextprotocol.io/) by Anthropic
- Reverse engineering findings documented in [REVERSE_ENGINEERING_FINDING.md](docs/REVERSE_ENGINEERING_FINDING.md)
- Data validation with [Zod](https://zod.dev/)
- Developed with [Bun](https://bun.sh/) for fast TypeScript development

## References

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Copilot Money](https://copilot.money/)
- [Privacy Policy](PRIVACY.md)
- [Reverse Engineering Findings](docs/REVERSE_ENGINEERING_FINDING.md)

---

**⭐ Star this repo if you find it useful!**
