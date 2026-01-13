# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-01-12

### Added

#### New Data Quality Tool
- **`get_data_quality_report`** - Comprehensive data quality analysis tool
  - Detects unresolved category IDs that can't be mapped to human-readable names
  - Flags potential currency conversion issues (large amounts with foreign merchant names)
  - Identifies non-unique transaction IDs (multiple transactions sharing same ID)
  - Finds potential duplicate accounts (same name and type)
  - Detects suspicious categorizations (e.g., Uber as Parking, pharmacies as Office Supplies)
  - Provides actionable insights for users to fix data in Copilot Money

#### Enhanced Analysis Capabilities
- **Improved Income Detection**
  - Now excludes transfer categories and credit card payments automatically
  - Filters out internal transfers by merchant name patterns (CREDIT CARD, AUTOPAY, etc.)
  - Excludes likely refunds from common merchants (Amazon, Uber, Target, etc. under $500)
  - Better distinction between true income and credits/refunds
  - More accurate income reporting for financial analysis

- **Enhanced Foreign Transaction Detection**
  - Parses merchant names for foreign city indicators (Santiago, London, Paris, Tokyo, etc.)
  - Detects country codes in merchant names (CL, GB, MX, FR, DE, IT, ES, JP, CA)
  - Checks region field for non-US state codes
  - More comprehensive international transaction identification
  - Catches transactions that were previously missed

- **Better Trip Location Detection**
  - Extracts city names from merchant names when not in transaction fields
  - Infers country codes from merchant data patterns
  - Displays multiple cities visited during a trip
  - Handles missing location data gracefully with intelligent fallbacks
  - Trips now show actual locations instead of "Unknown"

### Changed
- Tool count increased from 22 to 23 tools
- Test count increased from 366 to 400 tests
- Assertion count increased to 1427+ (from 1360+)
- All tests passing with enhanced coverage

### Technical Details
- **Design Philosophy**: Data quality issues are surfaced rather than masked, enabling users to fix root causes in Copilot Money
- **Backwards Compatible**: All changes are additive, no breaking changes
- **Performance**: No impact on query performance
- **Testing**: All new functionality comprehensively tested

## [1.0.0] - 2026-01-11

### Added

#### Core Features
- **MCP Server Implementation**: Full stdio transport support for Claude Desktop
- **5 MCP Tools** with read-only safety annotations:
  - `get_transactions` - Query transactions with filters (date, category, merchant, account, amount)
  - `search_transactions` - Full-text search across transaction descriptions
  - `get_accounts` - List all accounts with balances and total calculation
  - `get_spending_by_category` - Aggregate spending by category with sorting
  - `get_account_balance` - Get detailed information for a specific account

#### Binary Decoder
- LevelDB binary format parser (340 lines)
- Protocol Buffers varint decoding
- String and double value extraction
- Transaction and account decoding from .ldb files
- Robust error handling for malformed data

#### Database Layer
- Abstraction over LevelDB with lazy-loading
- Transaction filtering by:
  - Date periods (this_month, last_30_days, ytd, etc.)
  - Category
  - Merchant (with fuzzy matching)
  - Account
  - Amount (min/max ranges)
- Full-text search functionality
- Account queries with balance aggregation
- Category extraction and listing

#### Date Utilities
- Period parsing support:
  - `this_month`, `last_month`
  - `last_N_days` (e.g., `last_30_days`)
  - `ytd` (year-to-date)
  - `this_year`, `last_year`
  - Custom date ranges
- Month boundary handling
- Timezone-aware date calculations

#### Data Models
- **Transaction Schema** (25+ fields):
  - Core fields: id, date, amount, description
  - Merchant info: name, category, subcategory
  - Account info: account ID, account name
  - Additional: notes, tags, custom fields
  - Display name helpers for consistent formatting
- **Account Schema**:
  - Core fields: id, name, type
  - Balance: current and available
  - Institution and currency info
- **Category Schema**:
  - Hierarchical category support
  - Icon and color metadata

#### Privacy & Security
- **100% Local Processing**: No data transmission
- **Read-Only Access**: Database opened in read-only mode
- **No Telemetry**: Zero data collection or analytics
- **Open Source**: Full transparency via GitHub
- **Privacy Policy** (PRIVACY.md):
  - Comprehensive privacy commitments
  - Referenced in manifest.json
  - Linked from README

#### Testing
- **142 tests** across 7 test files
- **351 assertions** covering:
  - Core decoder (varint parsing, string/double extraction)
  - Database layer (all filters, search, accounts)
  - Date utilities (period parsing, edge cases)
  - MCP tools (all 5 tools with various inputs)
  - Server integration (MCP protocol)
  - End-to-end workflows
- **~183ms execution time** (73% faster than Python)
- **>90% code coverage**

#### Documentation
- **README.md** (415 lines):
  - Installation instructions (npm, .mcpb, manual)
  - 3 working examples with realistic data
  - Tool documentation with parameters
  - Privacy section with PRIVACY.md link
  - Troubleshooting guide
- **PRIVACY.md**: Comprehensive privacy policy
- **CONTRIBUTING.md**: Contribution guidelines
- **CHANGELOG.md**: Version history (this file)
- **manifest.json v0.3**: MCP bundle metadata with privacy_policies array
- **SESSION_RECAP.md**: Complete handoff documentation
- **docs/MCPB_COMPLIANCE.md**: .mcpb submission guide

#### Build & Distribution
- TypeScript 5.3+ with strict mode
- ESM modules for Node.js 18+
- Bun bundler for fast builds
- .mcpb bundle support for one-click installation
- 0.78 MB bundled executable
- Platform support: macOS (darwin)

#### Developer Experience
- **TypeScript** with strict mode and full type safety
- **Zod** schemas for runtime validation
- **ESLint** + **Prettier** for code quality
- **Bun** test runner for fast testing
- Hot reload in development mode
- Comprehensive error messages
- Debug mode with verbose logging

### Changed
- **Language**: Migrated from Python to TypeScript/Node.js
- **Validation**: Pydantic → Zod schemas
- **Testing**: pytest → Bun test runner
- **Binary Parsing**: Python bytes → Node.js Buffer APIs
- **Performance**: Lazy-loading pattern for faster startup
- **Display Names**: Helper functions instead of direct properties

### Technical Details

#### Dependencies
- **Production**:
  - `@modelcontextprotocol/sdk` ^1.2.0
  - `classic-level` ^1.4.1
  - `protobufjs` ^7.2.6
  - `zod` ^3.23.8
- **Development**:
  - `@anthropic-ai/mcpb` latest
  - `typescript` ^5.3.3
  - `eslint` + `prettier`
  - `@types/node` ^20.11.16

#### Code Statistics
- **Source code**: 1,562 lines
  - Models: 194 lines
  - Core: 562 lines
  - Utils: 100 lines
  - Tools: 431 lines
  - Server: 275 lines
- **Tests**: 1,727 lines
- **Documentation**: ~2,400 lines
- **Total**: ~5,700 lines

#### Performance
- Transaction decoding: <2s (target)
- Query performance: <5s per query
- Memory usage: <100MB
- Bundle size: 0.78 MB
- Test execution: ~183ms

### Fixed
- Binary decoder edge cases with malformed data
- Date mocking in tests (Date.now() vs new Date())
- Month boundary calculations for period parsing
- Display name formatting for transactions
- Error handling for missing database files

### Security
- All tools marked with `readOnlyHint: true` for safety
- Database opened in read-only mode
- No network requests or external API calls
- Input validation with Zod schemas
- Defensive error handling throughout

### .mcpb Compliance
All requirements met for MCP directory submission:
- ✅ All tools have `readOnlyHint: true` annotations
- ✅ PRIVACY.md with comprehensive privacy policy
- ✅ manifest.json v0.3 with privacy_policies array
- ✅ README with 3 working examples
- ✅ 142 tests passing
- ✅ TypeScript 0 errors, ESLint 0 warnings

## [0.1.0] - 2025-12-XX (Python Version)

### Added
- Initial Python implementation
- Basic MCP server functionality
- Transaction and account querying
- LevelDB binary decoder
- 108 Python tests

### Notes
- This version is preserved in git history
- Replaced by 1.0.0 Node.js/TypeScript rewrite

---

## Release Types

We follow semantic versioning:
- **Major (1.0.0)**: Breaking changes
- **Minor (0.1.0)**: New features, backward compatible
- **Patch (0.0.1)**: Bug fixes, backward compatible

## Links

- [GitHub Repository](https://github.com/ignaciohermosillacornejo/copilot-money-mcp)
- [Issue Tracker](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues)
- [MCP Documentation](https://modelcontextprotocol.io/)
