# Copilot Money MCP Server

MCP (Model Context Protocol) server that enables AI-powered queries and management of Copilot Money personal finance data. Reads come from the locally cached Firestore database (LevelDB + Protocol Buffers); writes go through Copilot's GraphQL API at `app.copilot.money/api/graphql`. 34 tools (17 read + 17 write). Read-only by default, write tools opt-in via `--write` flag.

## Quick Reference

```bash
bun install          # Install dependencies
bun test             # Run tests
bun run build        # Build for production
bun run pack:mcpb    # Create .mcpb bundle for Claude Desktop
bun run check        # Run typecheck + lint + format:check + test
bun run fix          # Run lint:fix + format
```

## Architecture

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
│   └── tools.ts        # All MCP tool implementations (34 tools)
├── utils/
│   ├── date.ts         # Date period parsing (this_month, last_30_days, etc.)
│   └── categories.ts   # Category name resolution
├── server.ts           # MCP server (CopilotMoneyServer class)
└── cli.ts              # CLI entry point with --db-path, --write, --live-reads options
```

## Key Files

- **`src/tools/tools.ts`** - All 34 MCP tools (17 read + 17 write) are implemented here as async methods in the `CopilotMoneyTools` class. Read schemas in `createToolSchemas()`, write schemas in `createWriteToolSchemas()`.
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
- Synthetic test fixtures in `tests/fixtures/synthetic-db/`
- Run specific tests: `bun test tests/tools/tools.test.ts`

### Tool Implementation Pattern
Each MCP tool follows this pattern:
1. Define input schema in `createToolSchemas()` (read) or `createWriteToolSchemas()` (write)
2. Implement async method in `CopilotMoneyTools` class
3. Register in the tool handlers switch statement in `src/server.ts`
4. For write tools: add to `WRITE_TOOLS` set in `src/server.ts`
5. Run `bun run sync-manifest` to update `manifest.json`

## Important Notes

- **Privacy First**: Reads are 100% local with zero network requests. Opt-in writes (`--write`) send authenticated GraphQL requests directly to Copilot Money's own backend at `app.copilot.money/api/graphql` via `src/core/graphql/` — no third-party services, no project-operated servers.
- **Scrub PII before pushing**: real financial figures (account balances, category totals, transaction amounts, account names like "AmEx Platinum" or "Doordash 401(k)") are PII. Never put them in commit messages, PR titles, PR descriptions, or source/test comments. Tests use synthetic numbers (e.g., 100, 200, 5000); narrative uses placeholders ("$X", "the user's data"). Real values belong only in gitignored local scratch (`docs/superpowers/` — already excluded via `.gitignore`; do NOT add new files under that tree to the index — pre-existing tracked files there are design docs that predate the rule and are PII-clean, but anything new stays local). Before every push to a remote branch, scan the diff and the PR body for `\$[0-9]`-style figures, bare 4-digit-or-larger integers in financial context, and bank/account names. If PII slips through to a pushed branch, force-push `--force-with-lease` the redacted version, then check the AI review bot comments with `gh pr view <num> --json comments` — they often quote the body verbatim and need editing too (the repo owner can `PATCH` bot comments via `gh api repos/<owner>/<repo>/issues/comments/<id>`).
- **Read-Only by Default**: Write tools require `--write` flag
- **Live Reads (Opt-in)**: `--live-reads` swaps cache-backed reads (`get_transactions`, `get_accounts`, `get_categories`, `get_budgets`, `get_recurring_transactions`) for GraphQL-backed `_live` variants (`get_recurring_transactions` → `get_recurring_live`; the others follow the `{name}_live` pattern) and adds `get_tags_live`. See `docs/graphql-live-reads.md`. Requires browser session auth.
- **Verify `--live-reads` is on (when needed)**: before any work that depends on live mode (parity audits, smoke tests, anything that must reflect current server state), confirm the running MCP host has `--live-reads` enabled. **Cheap check:** call `mcp__copilot-money__get_accounts` (or any read tool that has a `_live` variant) — if the tool list contains `get_accounts_live` and excludes `get_accounts`, `--live-reads` is on. If you see the cache-mode names, the flag is missing — add `--live-reads` to the `args` array of the `copilot-money` entry in `~/.claude.json` (or `~/Library/Application Support/Claude/claude_desktop_config.json` for Claude Desktop), then ask the user to restart the MCP host (Claude Code: `/mcp` reload, or quit + relaunch). Do NOT proceed with live-mode work assuming the flag is on without verifying.
- **Database Location**: `~/Library/Containers/com.copilot.production/Data/Library/Application Support/firestore/__FIRAPP_DEFAULT/copilot-production-22904/main`

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
