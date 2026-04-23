# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.0] - 2026-04-23

### Added

- **Four new transaction write tools** bringing the write surface to 17 (total: 17 read + 17 write = 34 tools). All mirror the shapes Copilot's own web app uses via GraphQL:
  - **`create_transaction`** ([#320](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/320)) — add a manual transaction to a non-Plaid account. Supports `internal_transfer` flag, amount bounds, and is wired to patch the in-memory cache so a subsequent `get_transactions` returns the new row without `refresh_database`.
  - **`delete_transaction`** ([#321](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/321)) — delete a manual transaction. Marked `destructiveHint: true`.
  - **`add_transaction_to_recurring`** ([#322](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/322)) — link an existing transaction to an existing recurring rule (the counterpart to `create_recurring`, which seeds a fresh rule).
  - **`split_transaction`** ([#323](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/323)) — split one transaction into N children with per-child amount, category, note, and tags. Marked `destructiveHint: true` because the parent transaction's original fields become shared state across the children.
- **Split-transaction awareness in `get_transactions`** ([#315](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/315)) — transactions now surface `split_children` / `split_parent_id` so agents can reason about splits, and the spending aggregators stop double-counting a parent plus its children.
- **Decoder schema-drop instrumentation** — `validateOrWarn` helper ([#309](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/309), [#311](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/311)) and `warnUnreadFields` wired into all 29 collection processors ([#316](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/316)). New or renamed Copilot fields that we were silently dropping now log a one-line warning to stderr instead of disappearing. Combined with [#317](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/317), which closed every real-DB field coverage gap visible via the decode-coverage script.
- **GraphQL reconnaissance catalog** — `docs/graphql/` gained a full sweep of hidden mutations plus a tested-absent catalog documenting which app operations have no web-GraphQL equivalent ([#319](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/319), [#324](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/324)).
- **`/finance-cleanup` structural audit** ([#312](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/312)) — cross-category spending pattern detection and matcher-state persistence so repeated runs don't re-examine the same merchants.
- **Smoke test coverage for transaction writes** ([#327](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/327)) — `scripts/smoke-graphql.ts` gained a transactions-write section exercising the four new tools end-to-end against a real account.

### Fixed

- **`get_holdings` no longer crashes on newly nullable fields** ([#302](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/302), [#310](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/310)) — Copilot's recent schema change made `vested_quantity` / `vested_value` nullable on holdings; the Zod schemas were updated to allow `null` so RSU-bearing accounts stopped failing validation.

### Changed

- CI: `actions/upload-artifact` 4.6.2 → 7.0.1 ([#313](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/313)); dev-dependencies group bump ([#314](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/314)).
- `CLAUDE.md` gained a lockfile troubleshooting note; stale `bun.lockb` references purged ([#328](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/328)).
- README: Glama MCP server score badge added ([#299](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/299)).

## [2.0.1] - 2026-04-16

### Added

- **Optimistic in-memory cache patching after writes.** Every successful GraphQL write now patches the corresponding entity in `CopilotDatabase`'s in-memory cache, so a subsequent read returns the new value without needing `refresh_database` + re-decode from LevelDB. Removes the stale-after-write UX for agents that write-then-read.
- **Local-only `pack:mcpb:write` build script.** Produces a `copilot-money-mcp-write.mcpb` bundle advertising all 30 tools (17 read + 13 write) with `--write` baked into `mcp_config.args`, for self-installing the writes-enabled CLI in Claude Desktop. The committed `manifest.json` (read-only, 17 tools) is never touched.

### Fixed

- **`get_budgets` now reads the current month's value** ([#278](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/278)): Copilot's macOS app stopped writing to the top-level `amount` field ~2 years ago — fresh values live in `amounts[YYYY-MM]`. Our view was reading the legacy field and showing stale numbers. Also drops tombstoned entries (those without a live current-month value).
- **`--write` flag now actually enables write tools** ([#282](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/282)): `cli.ts` parsed `--write` but forwarded a hardcoded `false` to `runServer`, so the flag had no effect. Also drops a stale "temporarily unavailable" banner that contradicted the restored-via-GraphQL writes from 2.0.0.
- **`set_recurring_state` no longer fails on amount-only rules** ([#288](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/288)): `RecurringRule.nameContains` is non-nullable in Copilot's schema but the server returns `null` on recurrings matched by amount-only rules, causing every `setRecurringState` / `editRecurring` response to error. Trimmed the mutation response to only the fields we actually consume.
- **Tool description drift** on four write/read tools corrected after an audit pass.

### Changed

- `GEMINI.md` now symlinks to `CLAUDE.md` so Gemini CLI users pick up the same project instructions.
- CI: unit and E2E tests merged into a single job for accurate coverage reporting; README picks up a live CI status badge and Codecov badge.

## [2.0.0] - 2026-04-15

Write tools are back — rewritten onto Copilot Money's official GraphQL API (`https://app.copilot.money/api/graphql`) after direct Firestore writes were blocked by Copilot's server-side type-check deploy. Opt-in via `--write` (unchanged). 13 write tools (down from 18) across transactions, tags, categories, budgets, and recurrings.

### Breaking Changes

- **Budget write tools consolidated.** `create_budget` / `update_budget` / `delete_budget` → single **`set_budget`**. The Copilot API only exposes `EditBudget(categoryId, {amount})`, so budgets are addressed by category rather than by budget document ID. `amount="0"` clears the budget. Pass `month="YYYY-MM"` for a single-month override (via `EditBudgetMonthly`); omit for the all-months default.
- **`create_recurring` signature changed.** Now takes `{transaction_id, frequency}` — the API requires seeding a recurring from an existing transaction, so the tool derives `accountId` / `itemId` from the local DB. Previous `{name, amount, category_id, ...}` shape is gone.
- **Goal write tools removed.** `create_goal` / `update_goal` / `delete_goal` have no web GraphQL equivalent (the app's goal mutations are mobile-only). Goal read tools (`get_goals`, `get_goal_history`) are unchanged.
- **`update_transaction` field set trimmed.** No longer accepts `excluded`, `name`, `internal_transfer`, or `goal_id` — these are not writable through the public GraphQL mutations. Remaining writable fields: `category_id`, `note`, `tag_ids`.
- **Error message wording changed.** The old "budgeting disabled" message is gone. When budgeting or rollovers are disabled in Copilot → Settings → General, writes succeed on the server and return a `USER_ACTION_REQUIRED` error with an "enable manually in Copilot settings" hint. The value will not appear in the Copilot UI until those toggles are re-enabled — see the `set_budget` tool description for the full caveat.

### Added

- `src/core/graphql/client.ts` — typed `GraphQLClient` and `GraphQLError` with discriminated `code: 'AUTH_FAILED' | 'SCHEMA_ERROR' | 'USER_ACTION_REQUIRED' | 'NETWORK' | 'UNKNOWN'`. Every thrown error logs operation name + code + HTTP status to stderr; response bodies are never logged (PII).
- Six per-domain GraphQL modules (`transactions`, `categories`, `tags`, `recurrings`, `budgets`, `accounts`) — thin pure functions over the client, typed args in and compact `{id, changed}` out.
- `scripts/generate-graphql-operations.ts` — build-time generator that reads captured mutation docs and emits `operations.generated.ts` with `__typename`-transformed query strings matching Apollo's `documentTransform` wire shape.
- `scripts/smoke-graphql.ts` — opt-in, not in CI, runs against the developer's real account with create-edit-delete round-trips for each domain (`--skip-destructive` for read-only steps).

### Removed

- `src/core/firestore-client.ts`, `src/core/format/`, and their tests. The direct-Firestore write backend is gone. Field-mapping knowledge preserved in `docs/reference/firestore-write-schema.md` so future readers can recover it.

### Known issues

- **`set_budget` sync lag**: Writes succeed on the server but may take minutes to appear via `get_budgets` — budget docs appear to sync through Copilot's native app on a slower cadence than transactions/tags/categories/recurrings (which sync in seconds). Tool descriptions for `set_budget` and `get_budgets` document the caveat. Tracked in [#278](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/278).
- Per-month overrides written via `set_budget(month=...)` are not surfaced in `get_budgets` — only the all-months default `amount` is shown.
- **Upstream bugs surfaced during smoke testing** (reported to Copilot; no workaround on our side):
  - `EditTransaction` silently accepts invalid `categoryId` values — the server returns success but the category isn't actually changed.
  - Error messages occasionally leak the user's Firebase UID in the composite document ID when a mutation fails.

## [1.7.1] - 2026-04-15

### Fixed
- **Extension now installs on current Claude Desktop** (#249, upstream [mcpb#229](https://github.com/modelcontextprotocol/mcpb/issues/229)): Claude Desktop 1.2581+ runs Node MCPB extensions inside an Electron UtilityProcess that enforces macOS hardened-runtime library validation, which rejects ad-hoc-signed npm prebuilds (our `classic-level` binding). The process died in `dlopen` before any of our code ran, leaving users with a silent "Server disconnected" status. Routes the launch through `dist/launcher.sh` — an absolute path rather than the literal string `"node"` — so Claude Desktop's router falls through to plain `child_process` spawn where native deps load normally. The launcher tries `command -v node` first, then falls back through `~/.volta/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` (GUI-launched macOS processes don't inherit shell PATH).

### Changed
- **Extension declared macOS-only** (`compatibility.platforms: ["darwin"]`): Copilot Money itself only ships for macOS, so the MCP server now tells Claude Desktop / the MCPB catalog to block install on Windows and Linux rather than letting users install something that would have nothing to read.

## [1.7.0] - 2026-04-14

### Changed
- **Published CLI is now read-only.** Copilot Money has restricted direct Firestore writes from third-party clients (403 `PERMISSION_DENIED`), so the 18 write tools can no longer succeed against the live backend. The `copilot-money-mcp` CLI shipped via npm and the `.mcpb` bundle now advertises only the 17 read tools; passing `--write` prints a notice and still starts read-only. Write tool source (`src/tools/`, `FirestoreClient`, auth) is preserved on `main` for a future GraphQL-based replacement.
- `manifest.json`: only the 17 read tools are listed; `mcp_config.args` no longer includes `--write`.
- `scripts/sync-manifest.ts`: writes only read tools into the manifest.
- Marketing site (`docs/index.html`): stats row, install tabs, feature cards, and privacy banner reworked around the read-only surface; "Organize transactions" demo removed.

## [1.6.1] - 2026-04-13

### Fixed
- **`create_category` writes app-compatible documents** (#232): MCP-created categories were invisible to the Copilot Money app because they were missing required fields (`id`, `emoji`, `color`, `bg_color`, `order`, `is_other`, `auto_budget_lock`, `auto_delete_lock`, `plaid_category_ids`, `partial_name_rules`) and used a `custom_*` ID format the app doesn't recognize. Now uses Firestore auto-generated IDs and writes all app-required fields with sensible defaults.
- **`get_categories` uses user categories instead of Plaid taxonomy** (#238): The tool was built around the Plaid taxonomy (~120 static categories) as the primary system, but the app only uses user-created categories. List view returned 144 categories (mostly Plaid noise), search only found unusable Plaid IDs, and ~10 real user categories were invisible. All views now use user categories from LevelDB exclusively.
- **`update_category` syncs `bg_color` when `color` changes**: Previously, updating a category's color left the background tint stale.
- **Tag filter uses `tag_ids` field** (#224): Tag-based transaction filtering now checks the `tag_ids` array instead of scanning for `#hashtags` in transaction names.

### Added
- **`FirestoreClient.getDocument()`**: New method for reading individual documents from Firestore REST API.
- **Finance skills**: `/finance-pulse` (30-second financial check-in), `/finance-trip` (travel expense tracking), `/finance` (orchestrator).

### Changed
- `createDocument` now supports auto-generated Firestore document IDs (pass `undefined` as `documentId`) and returns the created document ID.
- CI: bumped `actions/github-script` v7→v9, `codecov/codecov-action` v5→v6, `softprops/action-gh-release` v2→v3.

## [1.6.0] - 2026-04-10

### Changed
- **Consolidated 7 transaction setter tools into one `update_transaction` tool.**
  The new tool accepts a partial patch with any combination of: `category_id`,
  `note`, `tag_ids`, `excluded`, `name`, `internal_transfer`, `goal_id`. Multi-field
  updates are atomic (single Firestore call). Omitted fields are preserved — sending
  `{id, tag_ids: [...]}` cannot accidentally erase the note. `goal_id: null` unlinks
  the goal. Net tool count: 41 → 35.

### Removed
- `set_transaction_category`, `set_transaction_note`, `set_transaction_tags`,
  `set_transaction_excluded`, `set_transaction_name`, `set_internal_transfer`,
  `set_transaction_goal`. Use `update_transaction` instead. Not marked as breaking
  because the write tools have never been published.
- Private helper `writeTransactionFields` (zero remaining callers after the setters
  were removed).

## [1.5.0] - 2026-04-05

### Added
- **`get_holdings` tool**: Current investment positions with ticker, name, quantity, price, average cost, and total return per holding
- **`get_investment_prices` tool**: Historical price data (daily + high-frequency) for stocks, ETFs, mutual funds, and crypto
- **`get_investment_splits` tool**: Stock split history with ratios, dates, and multipliers
- Database accessors for securities and holdings history collections
- Full decode coverage for all 35 Firestore collection paths (securities, balance_history, holdings_history, investment_performance, tags, amazon, changes, user profile, app metadata)

### Changed
- Tool count increased from 9 to 12
- Ticker symbol filters are now case-insensitive across all investment tools

### Fixed
- Date range filter now correctly handles daily prices that use month format (`p.month` fallback)
- Division guard prevents `Infinity` when holding quantity is zero

## [1.4.0] - 2026-03-29

### Fixed
- **Decode timeout**: Made decode timeout configurable via `--timeout` CLI flag, with a sensible default of 90 seconds
- Threaded timeout config through the stack instead of using environment variables
- Prevented promise hang when decode worker exits without sending a result

### Changed
- CI: Skip AI code review on Dependabot and forked PRs

## [1.3.0] - 2026-03-15

### Added
- **`get_connection_status` tool**: Check bank sync/connection health status for linked accounts

### Fixed
- Corrected `package.json` main field to `dist/server.js`
- Isolated LevelDB decoding in worker thread to prevent memory leaks
- Used `transaction_id` for dedup and reconcile pending/posted transaction pairs

### Changed
- Excluded dev artifacts and internal docs from `.mcpb` bundle
- Removed legacy Python config files (`.coveragerc`, `pytest.ini`)
- Cleaned up Python-specific entries from `.gitignore`

## [1.2.2] - 2026-01-21

### Fixed
- **Cursor/Electron compatibility**: Fixed native module loading error in Cursor and other Electron-based editors
  - Added dual distribution strategy: bundled build for Claude Desktop (.mcpb), external native modules for npm
  - Resolves "No native build was found for platform=darwin arch=arm64 runtime=electron abi=141" error

### Changed
- Build scripts now use separate targets for npm (`build`) and .mcpb (`build:mcpb`)

## [1.2.1] - 2026-01-20

### Fixed
- Filter out budgets with orphaned category references from `get_budgets` results
- Prevents raw Firestore IDs (like `rXFkilafMIseI6OMZ6ze`) from leaking through as `category_name`
- Added `isKnownPlaidCategory()` helper function to validate category IDs

## [1.2.0] - 2026-01-18

### Added
- **5-minute cache TTL**: Database automatically refreshes after 5 minutes of inactivity
- **`refresh_database` tool**: Force refresh the database cache on demand
- **`get_cache_info` tool**: View cache status and database statistics
- **Name filter for `get_recurring_transactions`**: Filter recurring items by name pattern
- **Detail view for `get_recurring_transactions`**: Get full transaction history for a specific recurring item
- **Date filtering for `get_categories`**: Filter categories by date range to match UI behavior

### Changed
- Improved transaction history resolution with fallback search

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
- **Major Tool Consolidation**: Reduced from 60 tools to 28 using parameter-driven design
  - `get_spending` now uses `group_by` parameter (category, merchant, day_of_week, time_period)
  - `get_budget_analytics` consolidates budget utilization, vs_actual, recommendations, alerts
  - `get_goal_analytics` consolidates goal progress, at_risk, recommendations
  - `get_investment_analytics` consolidates performance, dividends, fees analysis
  - `get_account_analytics` consolidates activity, balance_trends, fees
  - `get_merchant_analytics` consolidates top merchants, frequency, spending analysis
- Test count increased to 624 tests (from 366)
- Assertion count increased to 2110+ (from 1360+)
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
