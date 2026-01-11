# Copilot Money MCP Server

> MCP server for Copilot Money - AI-powered personal finance queries using local data

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)

## Overview

This MCP (Model Context Protocol) server enables AI-powered queries of your Copilot Money personal finance data by reading locally cached Firestore data (LevelDB + Protocol Buffers). No network requests, all data stays on your machine.

**Key Features:**
- 🔒 **100% Local** - Reads from local cache, no API calls
- 🤖 **AI-Powered** - Natural language queries via Claude
- 📊 **8 Tool Tiers** - From basic transactions to advanced investment analytics
- 🧪 **100% Coverage** - Comprehensive test suite
- ⚡ **Fast** - Extracts 5,500+ transactions in < 2 seconds

## Status

🚧 **Under Active Development** - See [PLAN.md](PLAN.md) for implementation roadmap.

Current Phase: **Pre-Phase - Environment Setup**

## Quick Start

### Prerequisites

- Python 3.10+
- Copilot Money (macOS App Store version)
- Claude Desktop with MCP support

### Installation

```bash
# Clone the repository
git clone https://github.com/ignaciohermosillacornejo/copilot-money-mcp.git
cd copilot-money-mcp

# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -e ".[dev]"

# Copy demo database for testing (contains real data - NOT committed)
python scripts/copy_demo_database.py
```

### Development

```bash
# Run tests
pytest

# Run tests with coverage
pytest --cov=src/copilot_money_mcp --cov-report=html

# Format code
black src/ tests/

# Lint code
ruff check src/ tests/

# Type check
mypy src/
```

## Architecture

See [PLAN.md](PLAN.md) for comprehensive implementation plan and [REVERSE_ENGINEERING_FINDING.md](REVERSE_ENGINEERING_FINDING.md) for technical details on data extraction.

### Project Structure

```
copilot-money-mcp/
├── src/copilot_money_mcp/    # Source code
│   ├── core/                 # Decoder, database, cache
│   ├── models/               # Pydantic models
│   ├── tools/                # MCP tools
│   └── utils/                # Utilities
├── tests/                    # Test suite
│   ├── unit/                 # Unit tests
│   ├── integration/          # Integration tests
│   └── e2e/                  # End-to-end tests
└── scripts/                  # Utility scripts
```

## Tool Tiers

**Tier 1: Core Queries**
- `get_transactions` - Query transactions with filters
- `search_transactions` - Free-text search
- `get_accounts` - List accounts with balances

**Tier 2: Spending Analysis**
- `spending_summary` - Breakdown by category/merchant
- `compare_spending` - Period-over-period comparison

**Tiers 3-8:** Financial health, recurring, budgets, trends, investments, goals

See [PLAN.md](PLAN.md) for complete list.

## Data Privacy & Security

- **Read-Only:** Never modifies Copilot Money data
- **Local Only:** No network requests, all data stays on your machine
- **No Credentials:** No API keys or authentication needed
- **macOS Sandbox:** Respects macOS file permissions

## Contributing

See [PLAN.md](PLAN.md) for implementation roadmap. Contributions welcome!

## License

MIT License - See [LICENSE](LICENSE) for details.

## Acknowledgments

- Reverse engineering findings documented in [REVERSE_ENGINEERING_FINDING.md](REVERSE_ENGINEERING_FINDING.md)
- Built with [MCP SDK](https://modelcontextprotocol.io/)
- Data validation with [Pydantic](https://pydantic.dev/)

## References

- [Implementation Plan](PLAN.md)
- [Reverse Engineering Findings](REVERSE_ENGINEERING_FINDING.md)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)
- [Copilot Money](https://copilot.money/)
