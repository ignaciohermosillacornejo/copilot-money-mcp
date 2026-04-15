# GraphQL Write-Tool Rewrite — Design

- **Date:** 2026-04-14
- **Status:** Spec, awaiting approval
- **Related:** `docs/graphql-capture/` (captured operations), `docs/graphql-capture/wire-protocol.md`, `docs/graphql-capture/flows/01-web-session.md`

## Background

Copilot Money's direct Firestore write path (which the MCP server currently uses for all 18 write tools) is broken. Copilot deployed server-side schema type checking on Firestore documents; our direct writes now fail validation. The write backend must be rewritten against Copilot's own GraphQL API — the same endpoint the web app uses — before any write tool will function again.

A prior session (see `docs/graphql-capture/`) captured the wire protocol, authentication shape, and verbatim query strings for 37 GraphQL operations. This spec uses that capture as the source of truth for the rewrite.

## Goals

1. All in-scope write tools function correctly against Copilot's production GraphQL endpoint.
2. Tool-level contracts are clean: no Firestore artifacts leak into tool schemas or responses.
3. The GraphQL layer is testable without hitting the real backend for CI; an opt-in E2E script validates against the real backend on demand.
4. Firestore write code is removed cleanly; reference-level knowledge is preserved in docs.

## Non-goals

- Goal CRUD (`create_goal`, `update_goal`, `delete_goal`). Goal write surfaces are mobile-only on the web app. These tools are removed entirely.
- Budgeting feature toggle (`EditUser` `budgetingConfig.isEnabled`) and rollovers config. **Verified via E2E smoke (2026-04-15):** these toggles are purely client-side UI settings. The GraphQL server accepts `EditBudget` / `EditBudgetMonthly` mutations regardless of whether budgeting or rollover is enabled in Copilot's Settings → General pane. `set_budget` writes succeed silently; the values just aren't rendered in the UI until the toggles are re-enabled. Documented in the `set_budget` tool description so LLM callers can warn their users. No tool exposes the toggle itself.
- Request batching. Apollo uses `BatchHttpLink`; we send single-op (object body) requests exclusively. The server accepts both shapes.
- Local DB cache invalidation after a write. The local LevelDB cache is refreshed by Copilot's own sync; we do not attempt to patch our cached reads.
- Retries on write failures.

## Scope

### Write tools after rewrite (13 total)

| Tool | GraphQL mutation | Change from current |
|---|---|---|
| `update_transaction` | `EditTransaction` | New backend; same shape |
| `review_transactions` | `EditTransaction` (isReviewed) | New backend; sequential single-op calls |
| `create_category` | `CreateCategory` | New backend; same shape |
| `update_category` | `EditCategory` | New backend; same shape |
| `delete_category` | `DeleteCategory` | New backend; same shape |
| `create_tag` | `CreateTag` | New backend; same shape |
| `update_tag` | `EditTag` | New backend; same shape |
| `delete_tag` | `DeleteTag` | New backend; same shape |
| `create_recurring` | `CreateRecurring` | **Breaking:** takes `transaction_id`, derives `accountId`+`itemId` from local DB |
| `update_recurring` | `EditRecurring` | New backend; same shape |
| `delete_recurring` | `DeleteRecurring` | New backend; same shape |
| `set_recurring_state` | `EditRecurring` (state arg) | New backend; same shape |
| `set_budget` | `EditBudget` / `EditBudgetMonthly` | **Breaking:** replaces `create_budget`+`update_budget`+`delete_budget`; `amount=0` clears |

Total: 13 tools, all rewrites of existing tools. Net MCP surface change from today's 18 write tools: −5 (−3 goals, −3 legacy budget tools, +1 `set_budget`).

### Deliberately not added as tools

- `EditAccount` — the captured mutation supports account rename + hide/unhide. The existing MCP deliberately omits account-write tools (mirroring that decision from the Firestore-backed implementation). We build the `accounts.ts` per-domain function (`editAccount(client, args)`) so the transport and types exist, but do **not** wire it into an MCP tool schema. Future PR can expose it if needed.
- `EditUser` — supports toggling `budgetingConfig.isEnabled`, `rolloversConfig.isEnabled`, `rolloversConfig.startDate`, and `rolloversConfig.categories`. Not exposed as a tool. Rationale: these are account-level preferences the user should set consciously via the UI, not ambient state changed by the LLM. No `user.ts` per-domain file is created.

  **Correction from original spec (verified via 2026-04-15 smoke):** we originally hypothesized the server would reject budget writes when these flags are off, producing `USER_ACTION_REQUIRED` errors. It does not. Both flags are UI-only; the server accepts all writes. The `set_budget` tool description now warns callers that writes may not be visible in the UI when the flags are off, rather than promising an error. The `USER_ACTION_REQUIRED` code is still valuable — it handles genuine server rejections like `"Tag name must be unique"` and `"Category not found"` — just not the budgeting/rollover case we originally predicted.

### Removed tools

- `create_goal`, `update_goal`, `delete_goal` — no web GraphQL equivalent; mobile-only surface.
- `create_budget`, `update_budget`, `delete_budget` — replaced by `set_budget`.

### Breaking changes

- `create_recurring` signature changes. New args: `transaction_id: string`, `frequency: string`. The tool resolves `accountId` and `itemId` from the local DB via `transaction_id`. The API requires seeding a recurring from an existing transaction; there is no freeform-name create path.
- Goal tools disappear from the tool list.
- Three budget tools disappear, replaced by `set_budget`.

Because the Firestore backend is already non-functional, these breakages do not regress working behavior — they are changes to now-dead APIs.

## Architecture

### File layout

```
src/core/graphql/
  client.ts                    # transport, auth, error classification
  operations.generated.ts      # auto-generated: transformed mutation strings
  transactions.ts              # editTransaction()
  categories.ts                # createCategory(), editCategory(), deleteCategory()
  tags.ts                      # createTag(), editTag(), deleteTag()
  recurrings.ts                # createRecurring(), editRecurring(), deleteRecurring()
  budgets.ts                   # setBudget() (dispatches EditBudget vs EditBudgetMonthly)
  accounts.ts                  # editAccount()

scripts/
  generate-graphql-operations.ts   # new: reads capture .md files → operations.generated.ts

src/tools/
  tools.ts                     # rewritten: write methods call per-domain funcs
  errors.ts (new)              # GraphQLError → MCP error mapping helper

docs/reference/
  firestore-write-schema.md (new)  # preserved knowledge from deleted write code
```

### Layering rules

- `client.ts` is the only file that knows HTTP, auth tokens, JSON, or error shapes.
- Per-domain files know only their mutation inputs/outputs. They take a `GraphQLClient` + typed args, return a compact subset of the response. Pure functions; no classes.
- `operations.generated.ts` is read-only from human perspective. Regenerate via `bun run generate:graphql`. The file contains an eslint-disable banner and a "do not edit" comment.
- `tools.ts` imports per-domain functions. It does not import from `operations.generated.ts` or `client.ts`.
- `src/tools/errors.ts` provides a shared `graphQLErrorToMcpError(e)` helper used in every write tool's catch block.

### Deleted files/paths

- `src/core/firestore-client.ts`
- `src/core/format/` (Firestore REST field serializers)
- Any Firestore-specific paths in `src/core/auth/` (`FirebaseAuth` class itself stays; it is the JWT source for GraphQL too)
- Goal-related methods in `tools.ts` + their schemas
- Three legacy budget tools (`create_budget` / `update_budget` / `delete_budget`) + their schemas
- Firestore write branches in all other tools

### Knowledge preservation

Before deleting the Firestore write code, extract `docs/reference/firestore-write-schema.md` documenting, per tool:

- Firestore collection path
- Document ID shape
- Fields the write sets, with types and updateMask semantics
- Any gotchas learned from writing the code

This doc is archived reference material, not live documentation. It exists so the learned shape of Copilot's Firestore documents is not lost with the code.

## Data flow

1. **Tool invocation** — MCP caller invokes a write tool with typed args.
2. **Validation + ID resolution** — `tools.ts` method validates args with Zod. For `create_recurring` (and `update_transaction` if missing `accountId`), resolves derived IDs from the local DB via `CopilotDatabase`.
3. **Per-domain call** — method invokes the per-domain function with fully-resolved variables.
4. **Mutation build** — per-domain function imports its `OPERATION_NAME` string from `operations.generated.ts`, builds the `variables` object, calls `client.mutate(operationName, query, variables)`.
5. **HTTP send** — `GraphQLClient` acquires JWT via `auth.getIdToken()`, POSTs `https://app.copilot.money/api/graphql` with headers `Authorization: Bearer <jwt>` + `Content-Type: application/json`, body `{operationName, query, variables}` (object, not array).
6. **Response handling** — on 2xx + no `errors`, returns `data`. On any failure, throws `GraphQLError` classified by `code`.
7. **Compact response** — per-domain function extracts `{id + changed fields}` and returns.
8. **MCP response** — tool method wraps in `{success: true, ...compactFields}` and returns.

Every write is a single-op request. Bulk tools (e.g., `review_transactions` with many IDs) issue sequential calls. No parallelism.

## Component contracts

### `GraphQLClient`

```typescript
export class GraphQLClient {
  constructor(private auth: FirebaseAuth) {}

  async mutate<TVariables, TResponse>(
    operationName: string,
    query: string,
    variables: TVariables
  ): Promise<TResponse>;
  // Throws GraphQLError on any failure.
}
```

### Per-domain function (example: `transactions.ts`)

```typescript
export async function editTransaction(
  client: GraphQLClient,
  args: {
    id: string;
    accountId: string;
    itemId: string;
    input: {
      categoryId?: string;
      userNotes?: string | null;
      tagIds?: string[];
      isReviewed?: boolean;
    };
  }
): Promise<{ id: string; changed: Record<string, unknown> }>;
```

### Operations generator

```
Input:  docs/graphql-capture/operations/mutations/<name>.md  (13 in-scope files)
Output: src/core/graphql/operations.generated.ts

In-scope mutations: EditTransaction, CreateCategory, EditCategory, DeleteCategory,
CreateTag, EditTag, DeleteTag, CreateRecurring, EditRecurring, DeleteRecurring,
EditBudget, EditBudgetMonthly, EditAccount.

For each file in the in-scope list (hardcoded constant, not dir glob):
  1. Parse the ```graphql fenced block.
  2. graphql.parse() → AST.
  3. Visit all SelectionSet nodes; inject __typename field if absent.
  4. graphql.print() → transformed string.
  5. Emit: export const <NAME> = `...`;
```

Adds `graphql` npm dependency (build-time only, not runtime).

## Error model

```typescript
export type GraphQLErrorCode =
  | 'AUTH_FAILED'
  | 'SCHEMA_ERROR'
  | 'USER_ACTION_REQUIRED'
  | 'NETWORK'
  | 'UNKNOWN';

export class GraphQLError extends Error {
  constructor(
    public readonly code: GraphQLErrorCode,
    message: string,
    public readonly operationName?: string,
    public readonly httpStatus?: number,
    public readonly serverErrors?: unknown
  ) { super(message); }
}
```

### Classification

| Condition | Code |
|---|---|
| `fetch` throws (timeout, DNS, offline) | `NETWORK` |
| HTTP 401 | `AUTH_FAILED` |
| HTTP 500 | `SCHEMA_ERROR` |
| Other non-2xx | `UNKNOWN` |
| HTTP 2xx with non-empty `errors[]` | `USER_ACTION_REQUIRED` |
| HTTP 2xx with `data` | success (no error thrown) |

`USER_ACTION_REQUIRED` carries the first server error's `message` verbatim. E2E smoke (2026-04-15) surfaced these real examples across the 13 mutations: `"Tag not found"`, `"Tag name must be unique"`, `"Category not found"`, `"Category name already exists"`, `"Recurring not found"`, `"Budget category not found"`, `"Failed to delete tag"`, `"Transaction not found"`, `"Cannot read properties of null (reading 'is_other')"` (the last is a server-side null deref the client can't recover from; surfaces as USER_ACTION_REQUIRED but is really a server bug). **Not confirmed:** budgeting-disabled or rollovers-disabled — those flags are UI-only and don't produce server errors. Raw server messages ship as-is; no message-rewrite table added.

### Tool-level wrapping

Every write tool method wraps its per-domain call in try/catch. On `GraphQLError`:

| Code | MCP message |
|---|---|
| `AUTH_FAILED` | "Authentication with Copilot failed. Sign in to the Copilot web app and try again." |
| `SCHEMA_ERROR` | "Copilot's API changed in a way this tool doesn't handle yet. Please report this issue." |
| `USER_ACTION_REQUIRED` | server message surfaced verbatim |
| `NETWORK` | "Network error contacting Copilot: `<details>`" |
| `UNKNOWN` | "Copilot API request failed: `<details>`" |

Shared helper `graphQLErrorToMcpError(e)` in `src/tools/errors.ts`.

### Logging

Every thrown `GraphQLError` logs to stderr: `operationName`, `code`, `httpStatus`. Response bodies are not logged by default (may contain PII). Verbose mode is future work.

## Testing strategy

### Unit tests (CI, required to pass before merge)

- **`GraphQLClient.mutate()`** — `tests/core/graphql/client.test.ts`. Stub `fetch`. Assert URL, method, headers (only `Authorization` + `Content-Type`), body shape (object not array), auth integration, error classification for each code, response extraction.
- **Per-domain functions** — one test file each under `tests/core/graphql/`. Stub `GraphQLClient`. Assert operation name, variables shape against captured `.md` example bodies, compact response shaping. `budgets.setBudget` dispatches `EditBudget` when `month` absent, `EditBudgetMonthly` when present.
- **Operations generator** — `tests/scripts/generate-graphql-operations.test.ts`. Run over minimal fixture; snapshot output; assert `__typename` in every selection set.
- **Tool methods** — update existing `tests/tools/tools.test.ts`. Stub per-domain functions. Assert arg validation, ID resolution (`create_recurring`, `update_transaction`), error wrapper translation. Goal tests deleted; three budget tests collapsed to `set_budget`.

### E2E script (opt-in, manual, developer's personal account)

`scripts/smoke-graphql.ts`. Runs full stack against real backend. Not in CI.

Round-trip steps (each uses `GQL-TEST-*` entity names for cleanup clarity):

1. **Tags** — create `GQL-TEST-TAG` → rename to `GQL-TEST-TAG-2` → delete.
2. **Categories** — create `GQL-TEST-CAT` → edit color → delete.
3. **Transactions** — pick most recent; set `userNotes` to `GQL-TEST-NOTE`; restore original.
4. **Recurrings** — find a transaction with no recurring; `CreateRecurring(GQL-TEST-RECURRING)` → `DeleteRecurring`.
5. **Budgets** — pick a no-budget category; `setBudget(amount=1)` → `setBudget(amount=0)`. Repeat with `month='YYYY-MM'` to exercise `EditBudgetMonthly`.
6. **Accounts** — pick account; rename to `GQL-TEST-ACCT`; restore original.
7. **User** — read current `budgetingConfig.isEnabled`; write same value (no-op endpoint confirmation).

Each step try/finally attempts cleanup on failure and prints manual-cleanup instructions if cleanup itself fails. `--skip-destructive` skips steps that create-then-delete entities.

CLI: `bun run scripts/smoke-graphql.ts [--skip-destructive]`. Auth via the same `FirebaseAuth` path as the server.

## Prerequisites (before implementation)

1. Update `docs/graphql-capture/operations/mutations/CreateRecurring.md` and `DeleteRecurring.md` with the verbatim query strings captured in the brainstorming session (replacing the inferred stubs). The `.jsonl` capture file is available; append to `raw/captured-log.jsonl` and rerun `bun scripts/graphql-capture/{scrub,merge-documents,generate-docs}.ts`.
2. Verify no non-write callers depend on `src/core/firestore-client.ts` or `src/core/format/` (should be none; scope check before deletion).

## Rollout

**Single PR.** One branch, one PR: adds GraphQL client + per-domain files + generator, rewrites tool methods, extracts Firestore reference doc, deletes Firestore backend + goal tools + three legacy budget tools. Firestore is already non-functional, so a multi-PR staged rollout would leave dead code in `main` with no benefit.

PR size is larger than preferred, but the write-tool surface is bounded (12 tools), the per-domain files are small, and the deletions are mechanical. One reviewer can hold the full diff.

## Open questions (deferred to implementation)

- Exact error-response shape from Copilot's GraphQL server for business-rule failures. Discover during E2E; update `USER_ACTION_REQUIRED` message mapping if needed.
- Exact `frequency` enum values for `CreateRecurring`. Confirmed: `MONTHLY`. Others (`WEEKLY`, `YEARLY`, etc.) inferred. E2E will reveal which values the server accepts.
- Whether any non-write callers of `src/core/format/` exist. Audit before deletion.
