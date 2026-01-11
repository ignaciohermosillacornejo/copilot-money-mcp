# Copilot Money MCP Server - Implementation Plan

## Overview

Build a Python MCP server for Copilot Money personal finance data, enabling AI-powered financial queries and analysis. The server reads locally cached Firestore data (LevelDB + Protocol Buffers) without any network requests.

**Primary Goal:** Personal finance AI assistant that's intuitive for natural language queries.

**Quality Bar:** 100% line coverage, comprehensive error handling, production-ready.

---

## Project Structure

```
copilot-money-mcp/
├── pyproject.toml                     # Project config, dependencies
├── README.md                          # User documentation
├── LICENSE                            # MIT
├── .coveragerc                        # Coverage config (100% required)
├── pytest.ini                         # Pytest config
│
├── src/copilot_money_mcp/
│   ├── __init__.py                   # Version, exports
│   ├── __main__.py                   # Entry: python -m copilot_money_mcp
│   ├── server.py                     # FastMCP server + tool registration
│   │
│   ├── core/
│   │   ├── __init__.py
│   │   ├── decoder.py                # LevelDB/Protobuf extraction
│   │   ├── database.py               # Database abstraction layer
│   │   └── cache.py                  # TTL-based caching
│   │
│   ├── models/
│   │   ├── __init__.py
│   │   ├── transaction.py            # Transaction model
│   │   ├── account.py                # Account model
│   │   ├── recurring.py              # Recurring/subscription model
│   │   ├── budget.py                 # Budget model
│   │   ├── category.py               # Category model
│   │   ├── investment.py             # Holding, InvestmentPrice models
│   │   ├── goal.py                   # Goal, GoalProgress models
│   │   └── analytics.py              # Summary/trend result models
│   │
│   ├── tools/
│   │   ├── __init__.py
│   │   ├── transactions.py           # get_transactions, search_transactions
│   │   ├── accounts.py               # get_accounts, net_worth
│   │   ├── spending.py               # spending_summary, compare_spending
│   │   ├── recurring.py              # get_recurring, subscription_summary
│   │   ├── budgets.py                # budget_status
│   │   ├── trends.py                 # spending_trend, unusual_transactions
│   │   ├── investments.py            # get_holdings, portfolio_summary, investment_performance
│   │   └── goals.py                  # get_goals, goal_progress, debt_payoff_summary
│   │
│   └── utils/
│       ├── __init__.py
│       ├── date_utils.py             # Date parsing, period helpers
│       └── formatting.py             # Output formatting
│
├── tests/
│   ├── __init__.py
│   ├── conftest.py                   # Fixtures, demo DB setup
│   │
│   ├── fixtures/
│   │   └── demo_database/            # Static LevelDB copy (from your demo)
│   │       ├── *.ldb
│   │       └── MANIFEST-*
│   │
│   ├── unit/                         # Isolated function tests
│   │   ├── test_decoder.py
│   │   ├── test_models.py
│   │   ├── test_cache.py
│   │   └── test_date_utils.py
│   │
│   ├── integration/                  # Tests against demo database
│   │   ├── test_database.py
│   │   ├── test_transactions.py
│   │   ├── test_spending.py
│   │   └── test_accounts.py
│   │
│   └── e2e/                          # Full MCP protocol tests
│       ├── test_server.py
│       └── test_error_handling.py
│
└── scripts/
    └── copy_demo_database.py         # One-time script to copy demo DB
```

---

## MCP Tools (Prioritized by Usefulness)

### Tier 1: Core Queries (Daily Use)

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `get_transactions` | Query transactions with filters | `start_date`, `end_date`, `category`, `merchant`, `account`, `min_amount`, `max_amount`, `limit` |
| `search_transactions` | Free-text search | `query`, `limit` |
| `get_accounts` | List accounts with balances | `account_type` (optional) |

### Tier 2: Spending Analysis (High Value)

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `spending_summary` | Breakdown by category/merchant | `period`, `start_date`, `end_date`, `group_by` |
| `compare_spending` | Period-over-period comparison | `period1`, `period2`, `group_by` |

### Tier 3: Financial Health

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `net_worth` | Total assets minus liabilities | none |
| `cash_flow` | Income vs expenses | `period`, `num_months` |

### Tier 4: Subscriptions & Recurring

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `get_recurring` | All subscriptions/bills | `active_only` |
| `subscription_summary` | Monthly/annual subscription costs | none |

### Tier 5: Budgets

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `budget_status` | Spending vs budget | `category` (optional) |

### Tier 6: Trends & Insights

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `spending_trend` | Trends over time | `category`, `merchant`, `num_months`, `granularity` |
| `unusual_transactions` | Anomaly detection | `num_days`, `threshold_multiplier` |
| `get_categories` | List all categories | none |

### Tier 7: Investments

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `get_holdings` | Current investment positions | `account` (optional) |
| `portfolio_summary` | Total portfolio value & allocation | none |
| `investment_performance` | Gains/losses over time | `period`, `account` |
| `get_investment_prices` | Price history for holdings | `symbol`, `period` |

### Tier 8: Goals

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `get_goals` | List savings/debt goals | `goal_type` (savings/debt) |
| `goal_progress` | Progress toward a specific goal | `goal_id` |
| `debt_payoff_summary` | Overview of debt accounts and payoff trajectory | none |

---

## Implementation Phases

### Phase 1: Foundation
- [ ] Create project structure with `pyproject.toml`
- [ ] Copy demo database to `tests/fixtures/demo_database/`
- [ ] Implement `core/decoder.py` (adapt from REVERSE_ENGINEERING_FINDING.md)
- [ ] Create Pydantic models for Transaction, Account, Category
- [ ] Write unit tests for decoder functions (varint, string extraction, double extraction)
- [ ] Implement `core/cache.py` with TTL support
- [ ] Write unit tests for cache

### Phase 2: Database Layer
- [ ] Implement `core/database.py` abstraction with:
  - `CopilotDatabase` class
  - `is_available()` check
  - `get_transactions()` with filtering
  - `get_accounts()`
  - `get_categories()`
  - `get_recurring()`
  - `get_budgets()`
- [ ] Write integration tests against demo database
- [ ] Add custom exceptions (`DatabaseNotFoundError`, `DatabaseLockedError`, `DecodeError`)

### Phase 3: Core MCP Tools
- [ ] Set up FastMCP server in `server.py`
- [ ] Implement Tier 1 tools:
  - `get_transactions`
  - `search_transactions`
  - `get_accounts`
- [ ] Implement Tier 2 tools:
  - `spending_summary`
  - `compare_spending`
- [ ] Write tool-specific integration tests

### Phase 4: Advanced Tools
- [ ] Implement Tier 3 tools: `net_worth`, `cash_flow`
- [ ] Implement Tier 4 tools: `get_recurring`, `subscription_summary`
- [ ] Implement Tier 5 tools: `budget_status`
- [ ] Implement Tier 6 tools: `spending_trend`, `unusual_transactions`, `get_categories`
- [ ] Add date utilities for "this_month", "last_month", etc.

### Phase 4.5: Investments & Goals
- [ ] Add decoder support for `holdings_history`, `investment_prices` collections
- [ ] Create Investment and Goal Pydantic models
- [ ] Implement Tier 7 tools: `get_holdings`, `portfolio_summary`, `investment_performance`, `get_investment_prices`
- [ ] Implement Tier 8 tools: `get_goals`, `goal_progress`, `debt_payoff_summary`
- [ ] Write integration tests for investment and goal tools

### Phase 5: Polish & Coverage
- [ ] End-to-end MCP protocol tests
- [ ] Error handling tests (missing DB, corrupted data, locked DB)
- [ ] Fill coverage gaps to reach 100%
- [ ] Add helpful error messages for common issues
- [ ] Write README with usage examples
- [ ] Test Claude Desktop integration

---

## Technical Decisions

### Dependencies
```toml
dependencies = [
    "mcp>=1.2.0",           # FastMCP SDK
    "pydantic>=2.0",        # Data validation
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-cov>=4.0",
    "pytest-asyncio>=0.23",
    "pytest-mock>=3.0",
]
```

### Data Flow
```
Claude → MCP Protocol → FastMCP Server → Tools → Database Layer → Decoder → LevelDB Files
```

### Caching Strategy
- 60-second TTL on decoded data
- Manual refresh available via `refresh=True` parameter
- Cache invalidation on database modification detection

### Error Handling
- Return structured error objects (not exceptions) for MCP responses
- Include helpful messages and retry hints
- Log errors for debugging

---

## Testing Strategy

### Demo Database Setup
1. Copy your Copilot Money demo database once to `tests/fixtures/demo_database/`
2. This becomes a static test fixture committed to the repo
3. All integration tests run against this copy

### Coverage Requirements
- **100% line coverage** enforced via pytest-cov
- All branches tested (both True/False paths)
- All exception handlers tested
- Parametrized tests for edge cases

### Test Distribution
- 70% unit tests (isolated, mocked)
- 25% integration tests (with demo database)
- 5% end-to-end tests (full MCP protocol)

---

## Critical Files

Files that are central to the implementation:

1. **`src/copilot_money_mcp/core/decoder.py`** - Foundation for all data access
2. **`src/copilot_money_mcp/server.py`** - FastMCP server and tool registration
3. **`src/copilot_money_mcp/core/database.py`** - Interface between tools and decoder
4. **`src/copilot_money_mcp/models/transaction.py`** - Most-used data model
5. **`tests/conftest.py`** - Pytest fixtures and demo database setup

---

## Verification Plan

After implementation, verify by:

1. **Unit Tests**: `pytest tests/unit/ -v`
2. **Integration Tests**: `pytest tests/integration/ -v`
3. **E2E Tests**: `pytest tests/e2e/ -v`
4. **Coverage Check**: `pytest --cov=src/copilot_money_mcp --cov-fail-under=100`
5. **Manual Test with Claude Desktop**:
   - Configure MCP server in Claude Desktop
   - Ask: "What did I spend on groceries this month?"
   - Ask: "Show my account balances"
   - Ask: "Compare my spending this month vs last month"
   - Ask: "What subscriptions am I paying for?"
   - Ask: "What's my investment portfolio allocation?"
   - Ask: "How are my investments performing this year?"
   - Ask: "What's my progress on savings goals?"

---

## Session Tracking

Use this checklist across sessions:

```
[ ] Phase 1: Foundation
[ ] Phase 2: Database Layer
[ ] Phase 3: Core MCP Tools
[ ] Phase 4: Advanced Tools
[ ] Phase 4.5: Investments & Goals
[ ] Phase 5: Polish & Coverage
```

Current Phase: **Not Started**
