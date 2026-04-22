# Copilot Money MCP Server

MCP (Model Context Protocol) server that enables AI-powered queries and management of Copilot Money personal finance data. Reads come from the locally cached Firestore database (LevelDB + Protocol Buffers); writes go through Copilot's GraphQL API at `app.copilot.money/api/graphql`. 31 tools (17 read + 14 write). Read-only by default, write tools opt-in via `--write` flag.

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
│   └── tools.ts        # All MCP tool implementations (31 tools)
├── utils/
│   ├── date.ts         # Date period parsing (this_month, last_30_days, etc.)
│   └── categories.ts   # Category name resolution
├── server.ts           # MCP server (CopilotMoneyServer class)
└── cli.ts              # CLI entry point with --db-path and --write options
```

## Key Files

- **`src/tools/tools.ts`** - All 31 MCP tools (17 read + 14 write) are implemented here as async methods in the `CopilotMoneyTools` class. Read schemas in `createToolSchemas()`, write schemas in `createWriteToolSchemas()`.
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
- **Read-Only by Default**: Write tools require `--write` flag
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
