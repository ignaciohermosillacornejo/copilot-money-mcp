# Contributing

Contributions welcome! This guide covers development setup, architecture, and how to extend the project.

## Development Setup

### Prerequisites

- **Bun** (latest; required for development and tests)
- **Node.js 18+** (optional; only needed to run the built server)
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
bun run check          # typecheck + lint + format:check + check:version-sync + check:server-json + check:deps-pinned + bun test --bail
bun run fix            # Run lint:fix + format
bun run sync-manifest  # Verify manifest.json matches code
bun run check:skills   # Lint skills/ (NOT part of `check` — run separately for skills work)
```

`check:skills` resolves the tool names skills reference by running
`scripts/dump-tool-names.ts` under bun, so it needs `bun` on PATH and a
completed `bun install` — it is no longer a standalone python3 script. When
either is missing it reports a linter fault and validates nothing, rather than
reporting every skill reference as an unknown tool.

#### Writes-enabled bundle (local-only)

`bun run pack:mcpb:write` produces `copilot-money-mcp-write.mcpb`, a variant
that advertises all 33 base tools (14 read + 19 write) and passes `--write` to the
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
4. `src/tools/tools.ts` implements the 33 base tools (14 read + 19 write); `src/tools/live/` adds 17 GraphQL-backed live read tools in `--live-reads` mode
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
│   ├── tools.ts             # Base tool implementations (cache reads + writes)
│   ├── registry/            # One ToolDefinition per tool: schema + handler + mode flags
│   └── live/                # GraphQL-backed live read tools (--live-reads mode)
├── utils/
│   ├── date.ts              # Date period parsing (this_month, last_30_days, etc.)
│   └── categories.ts        # Category name resolution
├── server.ts                # MCP server (CopilotMoneyServer class)
└── cli.ts                   # CLI entry point with --db-path and --write flags
```

### Key Files

- **`src/tools/tools.ts`** — All 33 base tools (14 read + 19 write) as async methods in `CopilotMoneyTools`. Read tool schemas in `createToolSchemas()`, write tool schemas in `createWriteToolSchemas()` — both are pure projections of the registry below.
- **`src/tools/registry/`** — One `ToolDefinition` per MCP tool: schema, handler, and classification (`readOnly`, `requiresLiveReads`, `swappedOutInLiveMode`) in a single object, built with `defineTool()`. Per-domain modules (`transactions.ts`, `categories.ts`, `tags.ts`, `recurring.ts`, `budgets-goals.ts`, `investments.ts`, `accounts-system.ts`, `live.ts`) collected in `index.ts` as `READ_TOOL_DEFS` / `LIVE_TOOL_DEFS` / `WRITE_TOOL_DEFS`. Since PR #470 (v2.2.1) this is the single source of truth — the tool list, dispatch, both mode gates, `sync-manifest`, and the conformance ledger walk are all derived from it, so there are no parallel lists to keep in sync.
- **`src/core/database.ts`** — `CopilotDatabase` class with 5-minute cache TTL, batch loading via `decodeAllCollectionsIsolated()` (worker thread), and filtered accessors.
- **`src/core/decoder.ts`** — Binary decoder that reads LevelDB and parses Firestore Protocol Buffers. Decodes 30+ collection paths.
- **`src/server.ts`** — MCP server. No routing switch and no `WRITE_TOOLS` list: `handleListTools()` filters `ALL_TOOL_DEFS` on the registry's own flags (dropping `readOnly: false` tools without `--write`), `handleCallTool()` re-checks the same flag before dispatch, and dispatch is `TOOL_REGISTRY.get(name).handler(...)`.
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

3. **Schema** — Write the tool schema (name, description, `inputSchema`, `annotations`) with `readOnlyHint: true`

4. **Registry** — Wrap the schema and handler in `defineTool({ schema, handler, readOnly: true })` in the matching `src/tools/registry/*.ts` domain module, then export it and add it to `READ_TOOL_DEFS` in `src/tools/registry/index.ts`. That array membership *is* the registration — `src/server.ts` needs no edit. If the tool has a `_live` counterpart that should replace it under `--live-reads`, also set `swappedOutInLiveMode: true`

5. **Manifest** — Run `bun run sync-manifest` to auto-update

6. **Tests** — Add to `tests/tools/tools.test.ts` using mock data via `(db as any)._fieldName = [...]`

## Adding a New Write Tool

Same as read tools, plus:

1. The `defineTool()` call carries `readOnly: false` (and `annotations.readOnlyHint: false` to match) — that single field *is* the `--write` gate, checked by both `handleListTools()` and `handleCallTool()`
2. Add the definition to `WRITE_TOOL_DEFS` (not `READ_TOOL_DEFS`) in `src/tools/registry/index.ts`, which is what `createWriteToolSchemas()` projects
3. Add a per-domain function in `src/core/graphql/` (see `setBudget` in `graphql/budgets.ts` or `editTransaction` in `graphql/transactions.ts` for the pattern)
4. If the mutation isn't in `operations.generated.ts` yet, capture it under `docs/graphql-capture/` and run `bun run generate:graphql`
5. Wrap GraphQL errors at the tool boundary with `graphQLErrorToMcpError(e)` so user-facing messages stay stable
6. Use validation helpers: `validateDocId()`, `validateDate()`, `validateMonth()`, `validateHexColor()`

## Testing

```bash
bun test                                    # Run all tests
bun test --watch                            # Watch mode
bun test tests/tools/tools.test.ts          # Specific file
bun test -t "getBalanceHistory"               # Test name pattern
```

Tests mirror the `src/` structure in `tests/`. The synthetic test DB is generated at runtime by `tests/helpers/test-db.ts` (no checked-in DB fixtures).

### Writing Tests

- Use `(db as any)._fieldName = [...]` to inject mock data in `beforeEach`
- Write tool tests need a mock `GraphQLClient` — use `createMockGraphQLClient` from `tests/helpers/mock-graphql.ts`
- Run `bun run check` before submitting to catch typecheck, lint, format, version-sync, server-json, dependency-pinning, and test failures (run `bun run check:skills` too if you touched `skills/` — it is not part of `check`)

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
- ESLint + Prettier enforced via a pre-push hook (`bun run check`)
- Read tools: `readOnlyHint: true`, and `readOnly: true` on the `ToolDefinition`
- Write tools: `readOnlyHint: false`, and `readOnly: false` on the `ToolDefinition` — that field is the `--write` gate, and the two must agree
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`)

## Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Make changes with tests
4. Run `bun run check` to verify
5. Push and open a Pull Request — fill every section of the PR template,
   including "External assumptions" (see `.github/PULL_REQUEST_TEMPLATE.md`)

The **Required PR Sections** check (`.github/workflows/required-sections.yml`)
enforces this: a PR fails CI unless its body contains a non-empty
`## External assumptions` section (write `None` if there are no new
assumptions), and `fix:`-titled PRs must additionally include every Bug
Response Ritual field below. The matching logic lives in
`scripts/check-pr-sections.sh` and is covered by
`tests/scripts/check-pr-sections.test.ts`.

## Reviewing a Contributor Branch (maintainers)

**Checking out a fork branch and running it is arbitrary code execution as you.**
`bun install` runs dependency lifecycle scripts, `bun test` runs the branch's own
code, and a build config executes during any build. This machine holds the live
Copilot Money cache, a Firebase session for a bank-linked account, a 1Password
service account, a `gh` token and npm publish rights — which is a better prize
than the package itself.

Merging is not the risky step. In better-auth PR #6003 the payload was reverted
before merge and the PR was closed unmerged; the attack still worked, because it
only had to survive on the branch long enough to be built once. CI is not the
exposure either — fork PRs there get no secrets and a read-only token. The
exposure is the maintainer's laptop.

So, for any branch you did not write:

1. **Read before you run.** The diff is cheap; execution is not. Reading it
   inside a container is not required — `gh pr diff` never executes anything.
2. **Review the file list first.** Nearly every case in this campaign lands the
   payload in a build or config file — `*.config.*`, `package.json`, a workflow,
   a git hook — because those execute during install or build without anyone
   importing them. A PR about an OAuth provider that touches a postcss config is
   the whole tell, and it is visible before you read a line of code.
3. **Read the commits, not just the combined diff.** The "Files changed" tab
   shows the net result. Content added by one commit and removed by another
   never appears there, but it was on the branch and it ran. `git log -p
   origin/main..<branch>` shows everything.
4. **Run it somewhere disposable** — a container, a VM, or a separate macOS user
   with none of the credentials above. If you must install locally:

   ```bash
   bun install --frozen-lockfile --ignore-scripts
   ```

`bun run check` includes `check:concealment`, which fails on the shapes this
class of attack needs — off-screen payloads, invisible characters, dynamic
execution, install-time scripts. It runs on every PR including forks. Treat it
as a floor, not a clearance: it checks shape, not intent.

## Bug Response Ritual

Every bug-fix PR ratchets the system: fix the **class**, not just the instance.
Copy this template into the PR description and fill every line:

```text
Root cause:       <one line — the mechanism, not the symptom>
Bug class:        <name the class this bug belongs to, not the instance>
Detector added:   <the class-level gate/test that now catches the whole class>
Siblings checked: <other instances of the class audited; list them or "none found">
Ledger updated:   <src/conformance/ledger.ts entries touched, or "n/a — not an external-assumption bug">
```

A regression test for the instance alone does not satisfy "Detector added" — the
detector must cover the class. Canonical example: the #419→#424 arc (one bad enum
value → a conformance harness that gates every enum, plus sibling coverage).

**Then write the post-mortem.** [`docs/bugs/`](docs/bugs/README.md) is the accumulated
record: one entry per user-visible bug, filed under its class, recording how it was
found and whether the class has a detector yet. Copy
[`docs/bugs/TEMPLATE.md`](docs/bugs/TEMPLATE.md).

Check [the class list](docs/bugs/README.md#bug-classes) **before** naming a class in the
ritual above — if your bug already has a class, that tells you the class recurred, which
is a stronger finding than the bug itself. The index also shows which classes still have
no detector, which is usually where the next worthwhile gate is.

## Publishing to the MCP Registry

The server is listed in the official [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.ignaciohermosillacornejo/copilot-money-mcp`. The registry stores metadata only — the actual artifact lives on npm.

Publishing is currently manual. Run it after each npm release that needs to be reflected in the registry (no need to re-publish for every patch — only when `server.json` metadata or the published `version` changes meaningfully).

### Prerequisites
- The target version must already be published to npm with the `mcpName` field present in `package.json` (the registry validates against the published tarball).
- `mcp-publisher` CLI installed locally (`brew install mcp-publisher`).

### Steps
1. Bump `version` in both `package.json` and `server.json` so they match (the package `version` inside `server.json` must equal the npm version that contains `mcpName`).
2. Cut the npm release through the normal release flow (the `npm-publish.yml` workflow runs on GitHub release).
3. Confirm the new version is live: `npm view copilot-money-mcp version`.
4. Authenticate and publish:
   ```bash
   mcp-publisher login github
   mcp-publisher publish
   ```
5. Verify:
   ```bash
   curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.ignaciohermosillacornejo/copilot-money-mcp"
   ```

GitHub auth requires the server name to start with `io.github.<your-username>/`, which is why only `ignaciohermosillacornejo` can publish updates. Future: wire this into a `mcp-registry-publish.yml` workflow triggered after `npm-publish.yml`.

## Reporting Issues

When reporting bugs, include: OS version, Node.js version, Copilot Money version, error messages, and steps to reproduce.

For feature requests, describe the use case and why it would be useful.
