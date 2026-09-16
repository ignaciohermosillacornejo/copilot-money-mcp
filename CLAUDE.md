# Copilot Money MCP Server

MCP (Model Context Protocol) server that enables AI-powered queries and management of Copilot Money personal finance data. Reads come from the locally cached Firestore database (LevelDB + Protocol Buffers); writes go through Copilot's GraphQL API at `app.copilot.money/api/graphql`. 33 base tools (14 read + 19 write); `--live-reads` swaps 6 cache reads for 17 live tools (25 read tools in live mode). Counting convention: "base" = cache-mode read tools (`createToolSchemas()`) + write tools (`createWriteToolSchemas()`); live-mode `_live` variants are counted separately. Read-only by default, write tools opt-in via `--write` flag.

## Quick Reference

```bash
bun install          # Install dependencies
bun test             # Run tests
bun run build        # Build for production
bun run pack:mcpb    # Create .mcpb bundle for Claude Desktop
bun run check        # typecheck + lint + format:check + check:version-sync + check:server-json + check:deps-pinned + check:tool-counts + check:privacy-endpoints + check:concealment + check:workflows + check:tracked-files + bun test --bail
bun run fix          # Run lint:fix + format
```

> `bun run check` does NOT run `check:skills` (the `skills/` linter). Run
> `bun run check:skills` separately when touching anything under `skills/`.
> It shells out to `scripts/dump-tool-names.ts` and `scripts/dump-tool-args.ts`
> under bun to get the real tool list and each tool's argument names, so it
> needs `bun` on PATH and a completed `bun install`. It also cross-checks the
> field names skills reference against each terse-by-default tool's
> `DEFAULT_*_FIELDS` preset (#704), so a skill that reads a field the v3 diet
> dropped fails the lint instead of failing silently at use time.

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
│   ├── tools.ts        # Base tool implementations (14 read + 19 write)
│   ├── registry/       # One ToolDefinition per tool: schema + handler + readOnly/live flags
│   └── live/           # 17 GraphQL-backed live read tools (--live-reads mode)
├── utils/
│   ├── date.ts         # Date period parsing (this_month, last_30_days, etc.)
│   └── categories.ts   # Category name resolution
├── server.ts           # MCP server (CopilotMoneyServer class)
└── cli.ts              # CLI entry point with --db-path, --write, --live-reads options
```

## Key Files

- **`src/tools/tools.ts`** - All 33 base tools (14 read + 19 write) are implemented here as async methods in the `CopilotMoneyTools` class. Read schemas in `createToolSchemas()`, write schemas in `createWriteToolSchemas()` — both are pure projections of the registry. The 17 live-mode tools live in `src/tools/live/*.ts`.
- **`src/tools/registry/`** - One `ToolDefinition` per MCP tool (schema + handler + `readOnly` / `requiresLiveReads` / `swappedOutInLiveMode`), grouped into per-domain modules and collected in `index.ts` as `READ_TOOL_DEFS` / `LIVE_TOOL_DEFS` / `WRITE_TOOL_DEFS`. Since PR #470 (v2.2.1) this is the single source of truth for the tool list, dispatch, and both mode gates.
- **`src/core/database.ts`** - `CopilotDatabase` class with methods like `getTransactions()`, `getAccounts()`, `getIncome()`, etc.
- **`src/core/decoder.ts`** - Binary decoder that reads LevelDB files and parses Firestore Protocol Buffers.
- **`manifest.json`** - MCP bundle metadata for .mcpb packaging.

## Conventions

### Code Style
- TypeScript strict mode
- Zod for runtime validation of all data models
- ESLint + Prettier enforced via pre-push hook (`bun run check`)
- Read tools marked with `readOnlyHint: true`, write tools with `readOnlyHint: false`
- Write gating is a **per-tool `readOnly: boolean` on each `ToolDefinition`** in `src/tools/registry/*.ts`, not a name list. `src/server.ts` reads that field directly: `handleListTools()` drops `!def.readOnly` tools unless `--write`, and `handleCallTool()` refuses to dispatch them. Keep `readOnly` and `annotations.readOnlyHint` in agreement. The sibling flags `requiresLiveReads` and `swappedOutInLiveMode` gate the `--live-reads` surface the same way.

### Testing
- Bun test runner
- Tests in `tests/` mirror `src/` structure
- Synthetic test DB is generated at runtime by `tests/helpers/test-db.ts` (no checked-in DB fixtures)
- Run specific tests: `bun test tests/tools/tools.test.ts`
- `bunfig.toml` preloads `tests/setup/temp-db-teardown.ts`, a run-wide `afterAll` that sweeps the LevelDB temp copies the suite made — `bun test` never fires `process.on('exit')`, so the reader's own exit sweep does not cover a test run (#642). A test file that reads a fixture database needs no cleanup hook of its own; `--bail` aborts before the hook fires, so a failing `check` run still falls back to the orphan sweep
- Never `expect()` outside a `test()`/hook body, including from a helper called in a `describe` body: bun evaluates those during collection, so the failure arrives as an unnamed load error and the tests after it are never registered. Throw when there is nothing left to test, otherwise collect and assert inside a named test (#714, gated by `tests/no-collection-time-assertions.test.ts`)

### Tool Implementation Pattern
Every MCP tool is exactly one `ToolDefinition` in the registry (`src/tools/registry/`) —
schema, handler, and classification in a single object. `src/server.ts` derives its tool
list, dispatch, write gating, and live-reads gating from that registry, and
`createToolSchemas()` / `createWriteToolSchemas()` (and through them `sync-manifest` and
the conformance ledger walk) are projections of it, so there are no parallel lists to keep
in sync. The pattern:
1. Implement the async method on `CopilotMoneyTools` in `src/tools/tools.ts` (or on the relevant class under `src/tools/live/` for a live tool)
2. Add a `defineTool({ schema, handler, readOnly, ... })` in the matching domain module under `src/tools/registry/` (`transactions.ts`, `categories.ts`, `tags.ts`, `recurring.ts`, `budgets-goals.ts`, `investments.ts`, `accounts-system.ts`, `live.ts`)
3. Export it and add it to `READ_TOOL_DEFS`, `LIVE_TOOL_DEFS`, or `WRITE_TOOL_DEFS` in `src/tools/registry/index.ts` — that array membership *is* the registration; there is no switch statement in `src/server.ts`
4. Set the classification flags: `readOnly: false` for a write tool (gated by `--write`), `requiresLiveReads: true` for a live tool, `swappedOutInLiveMode: true` on a cache read that a `_live` variant replaces
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
1. Implement the async method in the `CopilotMoneyTools` class in `src/tools/tools.ts`
2. Write the tool schema (name, description, `inputSchema`, `annotations`) — for cache-mode tools it lives next to the definition; live tools keep theirs in a `createLive*ToolSchema()` factory under `src/tools/live/`
3. Wrap both in `defineTool({ schema, handler, readOnly })` in the matching `src/tools/registry/*.ts` domain module, then add the export to `READ_TOOL_DEFS`, `LIVE_TOOL_DEFS`, or `WRITE_TOOL_DEFS` in `src/tools/registry/index.ts`. Nothing in `src/server.ts` needs editing — listing and dispatch are derived from those arrays
4. For write tools set `readOnly: false` (this is the `--write` gate) and `annotations.readOnlyHint: false` to match; for live tools set `requiresLiveReads: true`, plus `swappedOutInLiveMode: true` on the cache tool it replaces
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
