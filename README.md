# Copilot Money MCP Server

> AI-powered personal finance queries using local Copilot Money data

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 18+](https://img.shields.io/badge/node-18+-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)

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

### Manual Installation for Development

```bash
# Clone the repository
git clone https://github.com/ignaciohermosillacornejo/copilot-money-mcp.git
cd copilot-money-mcp

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test
```

## First-Time Setup

After installing the MCP server, Claude Desktop will request **one-time approval for each tool** when you first use them. This is a standard security feature for all MCP servers.

**What to expect:**
- You'll see 5 approval prompts (one for each tool: transactions, search, accounts, spending, balance)
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
  "tool": "get_spending_by_category",
  "arguments": {
    "period": "last_month"
  }
}
```

**Response:**
```json
{
  "period": {
    "start_date": "2025-12-01",
    "end_date": "2025-12-31"
  },
  "total_spending": 1847.32,
  "category_count": 8,
  "categories": [
    {
      "category": "food_dining",
      "total_spending": 487.50,
      "transaction_count": 23
    },
    {
      "category": "groceries",
      "total_spending": 612.80,
      "transaction_count": 12
    }
  ]
}
```

**Claude's Answer:**
> "Last month you spent $487.50 on dining out across 23 transactions. Your largest spending category was groceries at $612.80. Overall, you spent $1,847.32 across 8 categories."

---

### Example 2: Finding Specific Transactions

**User Query:**
> "Show me all my Amazon purchases in the last 30 days"

**MCP Tool Call:**
```json
{
  "tool": "search_transactions",
  "arguments": {
    "query": "amazon"
  }
}
```

**Response:**
```json
{
  "count": 7,
  "transactions": [
    {
      "transaction_id": "txn_abc123",
      "amount": 47.99,
      "date": "2026-01-05",
      "name": "Amazon.com",
      "category_id": "shopping_online"
    },
    {
      "transaction_id": "txn_def456",
      "amount": 23.50,
      "date": "2025-12-28",
      "name": "Amazon Prime",
      "category_id": "subscriptions"
    }
  ]
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

**Response:**
```json
{
  "count": 3,
  "total_balance": 12547.83,
  "accounts": [
    {
      "account_id": "acc_checking",
      "name": "Chase Checking",
      "account_type": "checking",
      "current_balance": 3247.50,
      "mask": "1234"
    },
    {
      "account_id": "acc_savings",
      "name": "Ally Savings",
      "account_type": "savings",
      "current_balance": 8500.33
    },
    {
      "account_id": "acc_credit",
      "name": "Chase Freedom",
      "account_type": "credit",
      "current_balance": 800.00
    }
  ]
}
```

**Claude's Answer:**
> "Your total balance across all accounts is $12,547.83. This includes:
> - Chase Checking: $3,247.50
> - Ally Savings: $8,500.33
> - Chase Freedom Credit: $800.00 (current balance)"

## Available Tools

The MCP server provides 5 read-only tools:

### 1. `get_transactions`
Query transactions with flexible filters.

**Parameters:**
- `period` - Date range shorthand (this_month, last_30_days, ytd, etc.)
- `start_date` - Start date (YYYY-MM-DD)
- `end_date` - End date (YYYY-MM-DD)
- `category` - Filter by category (case-insensitive)
- `merchant` - Filter by merchant name (case-insensitive)
- `account_id` - Filter by account ID
- `min_amount` / `max_amount` - Amount range
- `limit` - Max results (default: 100)

### 2. `search_transactions`
Free-text search by merchant name.

**Parameters:**
- `query` - Search query (required)
- `limit` - Max results (default: 50)

### 3. `get_accounts`
List all accounts with balances.

**Parameters:**
- `account_type` - Filter by type (checking, savings, credit, investment)

### 4. `get_spending_by_category`
Aggregate spending by category.

**Parameters:**
- `period` - Date range shorthand
- `start_date` / `end_date` - Date range
- `min_amount` - Minimum expense amount

### 5. `get_account_balance`
Get specific account details.

**Parameters:**
- `account_id` - Account ID (required)

## Development

### Build Commands

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build for production
npm run build

# Build .mcpb bundle
npm run pack:mcpb

# Type checking
npm run typecheck

# Linting
npm run lint
npm run lint:fix

# Formatting
npm run format
npm run format:check
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
- **Testing:** Bun test runner (50 tests, 100% passing)
- **MCP SDK:** @modelcontextprotocol/sdk v1.2

## Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

**Test Coverage:**
- ✅ 50 tests passing
- ✅ 113 assertions
- ✅ Core decoder tests
- ✅ Database abstraction tests
- ✅ Tool implementation tests
- ✅ Schema validation tests

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
- Reverse engineering findings documented in [REVERSE_ENGINEERING_FINDING.md](REVERSE_ENGINEERING_FINDING.md)
- Data validation with [Zod](https://zod.dev/)
- Developed with [Bun](https://bun.sh/) for fast TypeScript development

## References

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Copilot Money](https://copilot.money/)
- [Privacy Policy](PRIVACY.md)
- [Reverse Engineering Findings](REVERSE_ENGINEERING_FINDING.md)

---

**⭐ Star this repo if you find it useful!**
