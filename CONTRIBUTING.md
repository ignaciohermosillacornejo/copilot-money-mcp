# Contributing

Contributions welcome! This guide covers development setup, architecture, and how to extend the project.

## Development Setup

### Prerequisites

- **Bun** (latest) or **Node.js 18+**
- **Copilot Money** installed on macOS (for integration testing)

### Getting Started

```bash
# Clone the repository
git clone https://github.com/ignaciohermosillacornejo/copilot-money-mcp.git
cd copilot-money-mcp

# Install dependencies
bun install

# Run tests
bun test

# Build for production
bun run build
```

### Build Commands

```bash
bun install            # Install dependencies
bun test               # Run tests
bun run build          # Build for production
bun run pack:mcpb      # Create read-only .mcpb bundle for Claude Desktop
bun run pack:mcpb:write # Create writes-enabled .mcpb bundle (local self-install only)
bun run check          # Run typecheck + lint + format:check + test
bun run fix            # Run lint:fix + format
bun run sync-manifest  # Verify manifest.json matches code
```

#### Writes-enabled bundle (local-only)

`bun run pack:mcpb:write` produces `copilot-money-mcp-write.mcpb`, a variant
that advertises all 30 tools (17 read + 13 write) and passes `--write` to the
CLI so write tools are unlocked. It is intended for **self-install only** and
is **not published to Claude Desktop**; the release workflow continues to ship
only the read-only bundle. The committed `manifest.json` is never modified —
the writes-enabled metadata is generated into a gitignored
`manifest.write.json` and swapped in at pack time.

## Architecture

### Data Flow

1. Copilot Money stores data in a local LevelDB/Firestore cache on macOS
2. `src/core/decoder.ts` reads `.ldb` files and parses Firestore Protocol Buffers
3. `src/core/database.ts` provides cached, filtered access to all collections
4. `src/tools/tools.ts` implements 30 MCP tools (17 read + 13 write)
5. `src/server.ts` handles MCP protocol communication and tool routing
6. Write tools use `src/core/graphql/` to call Copilot's GraphQL API at `app.copilot.money/api/graphql`

### Project Structure

```
src/
├── core/
│   ├── database.ts          # CopilotDatabase — cached data access layer
│   ├── decoder.ts           # LevelDB binary decoder for Firestore protobufs
│   ├── leveldb-reader.ts    # Low-level LevelDB iteration
│   ├── protobuf-parser.ts   # Protocol Buffer wire format parser
│   ├── graphql/             # GraphQL client + per-domain write modules
│   └── auth/                # Firebase authentication for writes
├── models/                  # Zod schemas for all Firestore collections
│   ├── transaction.ts       # Transaction schema
│   ├── account.ts           # Account schema
│   ├── budget.ts            # Budget schema
│   ├── goal.ts              # Goal + GoalHistory schemas
│   ├── recurring.ts         # Recurring transaction schema
│   ├── security.ts          # Security master data schema
│   ├── investment-*.ts      # Investment price, performance, splits
│   ├── balance-history.ts   # Balance history schema
│   └── ...                  # Other entity schemas (tag, category, etc.)
├── tools/
│   └── tools.ts             # All MCP tool implementations
├── utils/
│   ├── date.ts              # Date period parsing (this_month, last_30_days, etc.)
│   └── categories.ts        # Category name resolution
├── server.ts                # MCP server (CopilotMoneyServer class)
└── cli.ts                   # CLI entry point with --db-path and --write flags
```

### Key Files

- **`src/tools/tools.ts`** — All 30 tools as async methods in `CopilotMoneyTools`. Read tool schemas in `createToolSchemas()`, write tool schemas in `createWriteToolSchemas()`.
- **`src/core/database.ts`** — `CopilotDatabase` class with 5-minute cache TTL, batch loading via `decodeAllCollectionsIsolated()` (worker thread), and filtered accessors.
- **`src/core/decoder.ts`** — Binary decoder that reads LevelDB and parses Firestore Protocol Buffers. Decodes 30+ collection paths.
- **`src/server.ts`** — MCP server with tool routing switch. `WRITE_TOOLS` set gates write operations behind the `--write` flag.
- **`manifest.json`** — MCP bundle metadata. Keep in sync with `bun run sync-manifest`.

## Adding a New Read Tool

1. **Database method** (if needed) — Add a cached accessor in `src/core/database.ts`:
   - Add cache field (`private _myData: MyType[] | null = null`)
   - Add to `clearCache()` (`this._myData = null`)
   - Add to `loadAllCollections()` cache population
   - Add private loader following the `loadGoalHistory()` pattern
   - Add public accessor with filter options

2. **Tool method** — Add an async method to `CopilotMoneyTools` in `src/tools/tools.ts`:
   - Validate params (`validateDate`, `validateMonth`, `validateLimit`, etc.)
   - Call `this.db.getX()` with filters
   - Paginate with `slice()` + standard metadata
   - Return `{ count, total_count, offset, has_more, data }`

3. **Schema** — Add to `createToolSchemas()` with `readOnlyHint: true`

4. **Server** — Add a `case` to the switch in `src/server.ts`

5. **Manifest** — Run `bun run sync-manifest` to auto-update

6. **Tests** — Add to `tests/tools/tools.test.ts` using mock data via `(db as any)._fieldName = [...]`

## Adding a New Write Tool

Same as read tools, plus:

1. Schema goes in `createWriteToolSchemas()` (not `createToolSchemas()`)
2. Add tool name to the `WRITE_TOOLS` set in `src/server.ts`
3. Add a per-domain function in `src/core/graphql/` (see `setBudget` in `graphql/budgets.ts` or `editTransaction` in `graphql/transactions.ts` for the pattern)
4. If the mutation isn't in `operations.generated.ts` yet, capture it under `docs/graphql-capture/` and run `bun run generate:graphql`
5. Wrap GraphQL errors at the tool boundary with `graphQLErrorToMcpError(e)` so user-facing messages stay stable
6. Use validation helpers: `validateDocId()`, `validateDate()`, `validateMonth()`, `validateHexColor()`

## Testing

```bash
bun test                                    # Run all tests
bun test --watch                            # Watch mode
bun test tests/tools/tools.test.ts          # Specific file
bun test --filter "getBalanceHistory"        # Pattern match
```

Tests mirror the `src/` structure in `tests/`. Synthetic fixtures in `tests/fixtures/synthetic-db/`.

### Writing Tests

- Use `(db as any)._fieldName = [...]` to inject mock data in `beforeEach`
- Write tool tests need a mock `GraphQLClient` — use `createMockGraphQLClient` from `tests/helpers/mock-graphql.ts`
- Run `bun run check` before submitting to catch typecheck, lint, and format issues

### License check

Production-tree licenses are gated in CI against the allowlist
`MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0`. To run the same
check locally before pushing:

```bash
mkdir -p .license-check
cp package.json .license-check/
(cd .license-check && npm install --omit=dev --ignore-scripts --no-audit --no-fund)
npx --yes license-checker@25.0.1 \
  --start .license-check \
  --production \
  --onlyAllow 'MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0' \
  --excludePackages "copilot-money-mcp@$(node -p "require('./package.json').version")" \
  --summary
rm -rf .license-check
```

Expect exit 0. If a disallowed license surfaces, either swap the
offending dep, pin to an earlier version, or — if the SPDX
declaration is clearly wrong — add an explicit `--excludePackages`
entry with a comment.

## Code Style

- TypeScript strict mode
- Zod for runtime validation of all data models
- ESLint + Prettier enforced via pre-commit hooks
- Read tools: `readOnlyHint: true`
- Write tools: `readOnlyHint: false`, gated by `WRITE_TOOLS` set
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`)

## Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Make changes with tests
4. Run `bun run check` to verify
5. Push and open a Pull Request

## Reporting Issues

When reporting bugs, include: OS version, Node.js version, Copilot Money version, error messages, and steps to reproduce.

For feature requests, describe the use case and why it would be useful.
