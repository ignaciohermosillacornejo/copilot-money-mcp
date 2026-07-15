# Copilot Money MCP Server

MCP (Model Context Protocol) server that enables AI-powered queries and management of Copilot Money personal finance data. Reads come from the locally cached Firestore database (LevelDB + Protocol Buffers); writes go through Copilot's GraphQL API at `app.copilot.money/api/graphql`. 31 base tools (14 read + 17 write); `--live-reads` swaps 6 cache reads for 17 live tools (25 read tools in live mode). Counting convention: "base" = cache-mode read tools (`createToolSchemas()`) + write tools (`createWriteToolSchemas()`); live-mode `_live` variants are counted separately. Read-only by default, write tools opt-in via `--write` flag.

## Quick Reference

```bash
bun install          # Install dependencies
bun test             # Run tests
bun run build        # Build for production
bun run pack:mcpb    # Create .mcpb bundle for Claude Desktop
bun run check        # typecheck + lint + format:check + check:version-sync + check:server-json + bun test --bail
bun run fix          # Run lint:fix + format
```

> `bun run check` does NOT run `check:skills` (the `skills/` linter). Run
> `bun run check:skills` separately when touching anything under `skills/`.

## Architecture

> **Defending against Copilot API drift:** the conformance ledger, live smokes,
> PR rituals, and weekly drift check are explained as one system in
> [`docs/CONFORMANCE_ARCHITECTURE.md`](docs/CONFORMANCE_ARCHITECTURE.md). Read it
> before touching the GraphQL surface, adding a tool, or fixing a boundary bug.

### Data Flow
1. Copilot Money stores data in local LevelDB/Firestore cache
2. `src/core/decoder.ts` reads `.ldb` files and parses Protocol Buffers
3. `src/core/database.ts` provides cached, filtered access to all collections
4. `src/tools/tools.ts` exposes MCP tools via Model Context Protocol
5. `src/server.ts` handles MCP protocol communication

### Project Structure

```
src/
├── core/
│   ├── database.ts          # CopilotDatabase - cached data access layer
│   ├── decoder.ts           # LevelDB binary decoder for Firestore protobufs
│   ├── graphql/             # GraphQL client + per-domain write modules
│   └── auth/                # Firebase authentication for writes
├── models/
│   ├── transaction.ts  # Transaction Zod schema
│   ├── account.ts      # Account Zod schema
│   ├── budget.ts       # Budget Zod schema
│   ├── goal.ts         # Goal Zod schema
│   ├── category.ts     # Category mappings (Plaid taxonomy)
│   └── ...             # Other entity schemas (30+ models)
├── tools/
│   ├── tools.ts        # Base tool implementations (14 read + 17 write)
│   └── live/           # 17 GraphQL-backed live read tools (--live-reads mode)
├── utils/
│   ├── date.ts         # Date period parsing (this_month, last_30_days, etc.)
│   └── categories.ts   # Category name resolution
├── server.ts           # MCP server (CopilotMoneyServer class)
└── cli.ts              # CLI entry point with --db-path, --write, --live-reads options
```

## Key Files

- **`src/tools/tools.ts`** - All 31 base tools (14 read + 17 write) are implemented here as async methods in the `CopilotMoneyTools` class. Read schemas in `createToolSchemas()`, write schemas in `createWriteToolSchemas()`. The 17 live-mode tools live in `src/tools/live/*.ts`.
- **`src/core/database.ts`** - `CopilotDatabase` class with methods like `getTransactions()`, `getAccounts()`, `getIncome()`, etc.
- **`src/core/decoder.ts`** - Binary decoder that reads LevelDB files and parses Firestore Protocol Buffers.
- **`manifest.json`** - MCP bundle metadata for .mcpb packaging.

## Conventions

### Code Style
- TypeScript strict mode
- Zod for runtime validation of all data models
- ESLint + Prettier enforced via pre-push hook (`bun run check`)
- Read tools marked with `readOnlyHint: true`, write tools with `readOnlyHint: false`
- Write tools gated behind `WRITE_TOOLS` set in server.ts, require `--write` CLI flag

### Testing
- Bun test runner
- Tests in `tests/` mirror `src/` structure
- Synthetic test DB is generated at runtime by `tests/helpers/test-db.ts` (no checked-in DB fixtures)
- Run specific tests: `bun test tests/tools/tools.test.ts`

### Tool Implementation Pattern
Each MCP tool follows this pattern:
1. Define input schema in `createToolSchemas()` (read) or `createWriteToolSchemas()` (write)
2. Implement async method in `CopilotMoneyTools` class
3. Register in the tool handlers switch statement in `src/server.ts`
4. For write tools: add to `WRITE_TOOLS` set in `src/server.ts`
5. Run `bun run sync-manifest` to update `manifest.json`

## Important Notes

- **Privacy First**: Default-mode reads are 100% local with zero network requests. Opt-in writes (`--write`) send authenticated GraphQL requests directly to Copilot Money's own backend at `app.copilot.money/api/graphql` via `src/core/graphql/` — no third-party services, no project-operated servers. `--write` also implies `--live-reads` (see below): once writes are authenticated, there's no privacy reason to keep reads on the stale cache, and write tools need live transaction metadata to resolve account/item IDs outside the local cache window.
- **Scrub PII before pushing**: real financial figures (account balances, category totals, transaction amounts, account names like "AmEx Platinum" or "Doordash 401(k)") are PII. Never put them in commit messages, PR titles, PR descriptions, or source/test comments. Tests use synthetic numbers (e.g., 100, 200, 5000); narrative uses placeholders ("$X", "the user's data"). Real values belong only in gitignored local scratch (`docs/superpowers/` — already excluded via `.gitignore`; do NOT add new files under that tree to the index — pre-existing tracked files there are design docs that predate the rule and are PII-clean, but anything new stays local). Before every push to a remote branch, scan the diff and the PR body for `\$[0-9]`-style figures, bare 4-digit-or-larger integers in financial context, and bank/account names. If PII slips through to a pushed branch, force-push `--force-with-lease` the redacted version, then check the AI review bot comments with `gh pr view <num> --json comments` — they often quote the body verbatim and need editing too (the repo owner can `PATCH` bot comments via `gh api repos/<owner>/<repo>/issues/comments/<id>`).
- **Read-Only by Default**: Write tools require `--write` flag, which also auto-enables `--live-reads`
- **Live Reads (Opt-in, also implied by `--write`)**: `--live-reads` swaps 6 cache-backed reads (`get_transactions`, `get_accounts`, `get_categories`, `get_budgets`, `get_recurring_transactions`, `get_holdings`) for GraphQL-backed `_live` variants (`get_recurring_transactions` → `get_recurring_live`; the others follow the `{name}_live` pattern) and adds 11 net-new tools (`get_tags_live`, `get_networth_live`, `get_upcoming_recurrings_live`, `get_monthly_spend_live`, `get_balance_history_live`, `get_investment_prices_live`, `refresh_cache`, `get_investment_allocation_live`, `get_top_movers_live`, `get_aggregated_holdings_live`, `get_investment_balance_live`) — 17 live tools total. See `docs/graphql-live-reads.md`. Requires browser session auth.
- **Verify `--live-reads` is on (when needed)**: before any work that depends on live mode (parity audits, smoke tests, anything that must reflect current server state), confirm the running MCP host has `--live-reads` enabled. **Cheap check:** call `mcp__copilot-money__get_accounts` (or any read tool that has a `_live` variant) — if the tool list contains `get_accounts_live` and excludes `get_accounts`, `--live-reads` is on. If you see the cache-mode names, the flag is missing — add `--live-reads` to the `args` array of the `copilot-money` entry in `~/.claude.json` (or `~/Library/Application Support/Claude/claude_desktop_config.json` for Claude Desktop), then ask the user to restart the MCP host (Claude Code: `/mcp` reload, or quit + relaunch). Do NOT proceed with live-mode work assuming the flag is on without verifying.
- **Database Location**: `~/Library/Containers/com.copilot.production/Data/Library/Application Support/firestore/__FIRAPP_DEFAULT/copilot-production-22904/main`
- **External assumptions (every PR)**: fill the "External assumptions" section of `.github/PULL_REQUEST_TEMPLATE.md` — each new assumption about Copilot's API/data declares an evidence class (probe transcript / live round-trip / `unverified` + ledger entry in `src/conformance/ledger.ts`). "None" is an explicit answer, not a default.
- **Bug Response Ritual (bug-fix PRs)**: fill the bug-response template in CONTRIBUTING.md — root cause → bug class → class-level detector → siblings checked → ledger updated. Fix the class, not just the instance; an instance-only regression test does not satisfy "Detector added".

## Common Tasks

### Adding a New Tool
1. Add schema in `createToolSchemas()` (read) or `createWriteToolSchemas()` (write) in `src/tools/tools.ts`
2. Implement async method in `CopilotMoneyTools` class
3. Add case to tool handler switch statement in `src/server.ts`
4. For write tools: add to `WRITE_TOOLS` set in `src/server.ts`
5. Run `bun run sync-manifest` to update and verify `manifest.json`
6. Add tests in `tests/tools/tools.test.ts`

### Debugging
```bash
bun run dev:debug    # Run with inspector
```

### Building for Distribution
```bash
bun run pack:mcpb    # Creates .mcpb bundle for Claude Desktop
```

## Troubleshooting

### Lockfile drift (`package-lock.json` + `bun.lock`)

The repo ships **both** lockfiles by design: `package-lock.json` is tracked (required by `scripts/pack-mcpb.ts` and the CI license-check job, which run `npm install --omit=dev` for reproducible production installs), while `bun.lock` is gitignored and regenerated by each `bun install`. Bun migrates from `package-lock.json` on first run, but the migration is non-deterministic across bun versions and stale caches — so different worktrees can end up with different transitive pins.

**Symptom:** lint, typecheck, or build breaks in one worktree but works in others (e.g., `TypeError: Class extends value undefined` from `@typescript-eslint/utils` when a stale resolution doesn't match the installed ESLint major version).

**Fix:** in the affected worktree, `rm bun.lock && bun install`.
