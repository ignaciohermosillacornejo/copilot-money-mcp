# Copilot Money MCP Server

MCP (Model Context Protocol) server that enables AI-powered queries of Copilot Money personal finance data by reading locally cached Firestore data (LevelDB + Protocol Buffers).

## Quick Reference

```bash
bun install          # Install dependencies
bun test             # Run tests (772 tests)
bun run build        # Build for production
bun run pack:mcpb    # Create .mcpb bundle for Claude Desktop
bun run check        # Run typecheck + lint + format:check + test
bun run fix          # Run lint:fix + format
```

## Architecture

### Data Flow
1. Copilot Money stores data in local LevelDB/Firestore cache
2. `src/core/decoder.ts` reads `.ldb` files and parses Protocol Buffers
3. `src/core/database.ts` provides filtered access to transactions/accounts
4. `src/tools/tools.ts` exposes MCP tools via Model Context Protocol
5. `src/server.ts` handles MCP protocol communication

### Project Structure

```
src/
├── core/
│   ├── database.ts     # CopilotDatabase - main data access layer
│   └── decoder.ts      # LevelDB binary decoder for Firestore protobufs
├── models/
│   ├── transaction.ts  # Transaction Zod schema
│   ├── account.ts      # Account Zod schema
│   ├── budget.ts       # Budget Zod schema
│   ├── goal.ts         # Goal Zod schema
│   ├── category.ts     # Category mappings (Plaid taxonomy)
│   └── ...             # Other entity schemas
├── tools/
│   └── tools.ts        # All MCP tool implementations (~3000 lines)
├── utils/
│   ├── date.ts         # Date period parsing (this_month, last_30_days, etc.)
│   └── categories.ts   # Category name resolution
├── server.ts           # MCP server (CopilotMoneyServer class)
└── cli.ts              # CLI entry point with --db-path option
```

## Key Files

- **`src/tools/tools.ts`** - All 8 MCP tools are implemented here as async methods in the `CopilotMoneyTools` class.
- **`src/core/database.ts`** - `CopilotDatabase` class with methods like `getTransactions()`, `getAccounts()`, `getIncome()`, etc.
- **`src/core/decoder.ts`** - Binary decoder that reads LevelDB files and parses Firestore Protocol Buffers.
- **`manifest.json`** - MCP bundle metadata for .mcpb packaging.

## Conventions

### Code Style
- TypeScript strict mode
- Zod for runtime validation of all data models
- ESLint + Prettier enforced via pre-commit hooks
- All tools marked with `readOnlyHint: true` (never modifies user data)

### Testing
- Bun test runner
- Tests in `tests/` mirror `src/` structure
- Synthetic test fixtures in `tests/fixtures/synthetic-db/`
- Run specific tests: `bun test tests/tools/tools.test.ts`

### Tool Implementation Pattern
Each MCP tool follows this pattern:
1. Define input schema with Zod in `createToolSchemas()`
2. Implement async method in `CopilotMoneyTools` class (e.g., `getTransactions()`)
3. Register in the tool handlers switch statement in `src/server.ts`
4. Add to `manifest.json` tools array

## Important Notes

- **Privacy First**: 100% local processing, zero network requests
- **Read-Only**: Never modifies Copilot Money database
- **Database Location**: `~/Library/Containers/com.copilot.production/Data/Library/Application Support/firestore/__FIRAPP_DEFAULT/copilot-production-22904/main`

## Common Tasks

### Adding a New Tool
1. Add Zod schema in `createToolSchemas()` in `src/tools/tools.ts`
2. Implement async method in `CopilotMoneyTools` class (e.g., `getNewTool()`)
3. Add case to tool handler switch statement in `src/server.ts`
4. Add tool to `manifest.json`
5. Run `bun run sync-manifest` to verify manifest matches code
6. Add tests in `tests/tools/tools.test.ts`

### Debugging
```bash
bun run dev:debug    # Run with inspector
```

### Building for Distribution
```bash
bun run pack:mcpb    # Creates .mcpb bundle for Claude Desktop
```
