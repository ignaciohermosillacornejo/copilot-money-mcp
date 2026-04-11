# Copilot Money MCP Server

MCP (Model Context Protocol) server that enables AI-powered queries and management of Copilot Money personal finance data by reading locally cached Firestore data (LevelDB + Protocol Buffers). 41 tools (17 read + 24 write). Read-only by default, write tools opt-in via `--write` flag.

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
│   ├── firestore-client.ts  # Firestore REST API client (write operations)
│   ├── auth/                # Firebase authentication for writes
│   └── format/              # Firestore field serialization
├── models/
│   ├── transaction.ts  # Transaction Zod schema
│   ├── account.ts      # Account Zod schema
│   ├── budget.ts       # Budget Zod schema
│   ├── goal.ts         # Goal Zod schema
│   ├── category.ts     # Category mappings (Plaid taxonomy)
│   └── ...             # Other entity schemas (30+ models)
├── tools/
│   └── tools.ts        # All MCP tool implementations (41 tools)
├── utils/
│   ├── date.ts         # Date period parsing (this_month, last_30_days, etc.)
│   └── categories.ts   # Category name resolution
├── server.ts           # MCP server (CopilotMoneyServer class)
└── cli.ts              # CLI entry point with --db-path and --write options
```

## Key Files

- **`src/tools/tools.ts`** - All 41 MCP tools (17 read + 24 write) are implemented here as async methods in the `CopilotMoneyTools` class. Read schemas in `createToolSchemas()`, write schemas in `createWriteToolSchemas()`.
- **`src/core/database.ts`** - `CopilotDatabase` class with methods like `getTransactions()`, `getAccounts()`, `getIncome()`, etc.
- **`src/core/decoder.ts`** - Binary decoder that reads LevelDB files and parses Firestore Protocol Buffers.
- **`manifest.json`** - MCP bundle metadata for .mcpb packaging.

## Conventions

### Code Style
- TypeScript strict mode
- Zod for runtime validation of all data models
- ESLint + Prettier enforced via pre-commit hooks
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

- **Privacy First**: Reads are 100% local with zero network requests. Opt-in writes (`--write`) send authenticated requests directly to Copilot Money's own Firebase/Firestore backend via `src/core/firestore-client.ts` — no third-party services, no project-operated servers.
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
