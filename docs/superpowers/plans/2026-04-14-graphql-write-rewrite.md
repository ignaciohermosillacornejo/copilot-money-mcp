# GraphQL Write-Tool Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the 13 in-scope MCP write tools to hit Copilot Money's official GraphQL API (`https://app.copilot.money/api/graphql`) instead of the now-broken direct Firestore REST path, so write tools function again.

**Architecture:** Per-domain GraphQL modules (`src/core/graphql/{transactions,categories,tags,recurrings,budgets,accounts}.ts`) sit behind a single `GraphQLClient` (transport + auth + error classification). Mutation strings are generated at build time from captured `.md` docs by a small generator that injects `__typename` into every selection set (matching Apollo's `documentTransform`). `tools.ts` write methods are rewritten to call per-domain functions. Goal tools and legacy budget tools are deleted. Firestore write code and its serializers are removed; knowledge is preserved in `docs/reference/firestore-write-schema.md`.

**Tech Stack:** TypeScript strict mode, Bun test runner, `graphql` npm package (new; used only at build time by the generator), Zod (existing), MCP SDK (existing), Firebase JWT via existing `FirebaseAuth` (reused as-is).

**Source spec:** `docs/superpowers/specs/2026-04-14-graphql-write-rewrite-design.md`

---

## File structure

### New files

- `scripts/generate-graphql-operations.ts` — reads 13 capture `.md` files, transforms queries with `__typename` injection, emits `src/core/graphql/operations.generated.ts`.
- `src/core/graphql/operations.generated.ts` — generated; one `export const <NAME> = \`...\`` per in-scope mutation. Committed (determinism guard).
- `src/core/graphql/client.ts` — `GraphQLClient` class; `GraphQLError` + `GraphQLErrorCode` type.
- `src/core/graphql/transactions.ts` — `editTransaction()`.
- `src/core/graphql/categories.ts` — `createCategory()`, `editCategory()`, `deleteCategory()`.
- `src/core/graphql/tags.ts` — `createTag()`, `editTag()`, `deleteTag()`.
- `src/core/graphql/recurrings.ts` — `createRecurring()`, `editRecurring()`, `deleteRecurring()`.
- `src/core/graphql/budgets.ts` — `setBudget()` (dispatches `EditBudget` vs `EditBudgetMonthly`).
- `src/core/graphql/accounts.ts` — `editAccount()` (no MCP tool wired; module exists for future use).
- `src/tools/errors.ts` — `graphQLErrorToMcpError(e)` helper.
- `scripts/smoke-graphql.ts` — opt-in E2E smoke script (manual, not CI).
- `docs/reference/firestore-write-schema.md` — archived knowledge from the deleted Firestore write code.
- `tests/core/graphql/client.test.ts` — unit tests for `GraphQLClient`.
- `tests/core/graphql/transactions.test.ts` — unit tests for transactions module.
- `tests/core/graphql/categories.test.ts` — unit tests for categories module.
- `tests/core/graphql/tags.test.ts` — unit tests for tags module.
- `tests/core/graphql/recurrings.test.ts` — unit tests for recurrings module.
- `tests/core/graphql/budgets.test.ts` — unit tests for budgets module.
- `tests/core/graphql/accounts.test.ts` — unit tests for accounts module.
- `tests/scripts/generate-graphql-operations.test.ts` — tests the generator.

### Modified files

- `src/tools/tools.ts` — replace Firestore write implementations with per-domain calls; drop goal methods + schemas; collapse three budget tools → `set_budget`; update `create_recurring` signature to `{transaction_id, frequency}`.
- `src/tools/index.ts` — already exports from `tools.ts`; no change.
- `src/server.ts` — swap `FirestoreClient` injection for `GraphQLClient`; remove `WRITE_TOOLS` entries for removed tools; add `set_budget` to `WRITE_TOOLS`.
- `manifest.json` — regenerated via `bun run sync-manifest` after tool changes.
- `package.json` — add `graphql` devDependency; add `generate:graphql` script; add `build` prerequisite to run generator.
- `tests/tools/tools.test.ts`, `tests/tools/write-tools.test.ts`, `tests/tools/write-tools-phase3.test.ts`, `tests/tools/review-transactions-batching.test.ts` — update to stub per-domain GraphQL functions instead of `FirestoreClient`; delete goal tests; collapse budget tests.

### Deleted files

- `src/core/firestore-client.ts`
- `src/core/format/` (entire directory)
- `tests/core/firestore-client.test.ts`
- `tests/core/format/` (entire directory)

---

## Prerequisites (run once before Task 1)

### Prereq-A: Update CreateRecurring/DeleteRecurring capture docs

The inferred query stubs in `docs/graphql-capture/operations/mutations/CreateRecurring.md` and `DeleteRecurring.md` must be replaced with verbatim wire-format strings captured in the brainstorming session.

- [ ] **Step 1: Append the capture to raw/captured-log.jsonl**

The brainstorming-session capture is in `copilot-recurring-gqllog-2026-04-15T02-45-19-674Z.jsonl` (obtain from operator). Append its contents to `docs/graphql-capture/raw/captured-log.jsonl`.

```bash
cat copilot-recurring-gqllog-2026-04-15T02-45-19-674Z.jsonl >> docs/graphql-capture/raw/captured-log.jsonl
```

- [ ] **Step 2: Rerun scrub + merge + generate**

```bash
bun scripts/graphql-capture/scrub.ts docs/graphql-capture/raw/captured-log.jsonl docs/graphql-capture/raw/scrubbed.jsonl
bun scripts/graphql-capture/merge-documents.ts
bun scripts/graphql-capture/generate-docs.ts docs/graphql-capture/raw/scrubbed.jsonl docs/graphql-capture/
```

- [ ] **Step 3: Verify verbatim strings landed**

Open `docs/graphql-capture/operations/mutations/CreateRecurring.md` and `DeleteRecurring.md`. The `## Query` fenced block must contain the full mutation strings with fragment definitions (for `CreateRecurring`) / scalar return shape (for `DeleteRecurring`), not inferred stubs.

Expected in `CreateRecurring.md`: `mutation CreateRecurring($input: CreateRecurringInput!) {` followed by `...RecurringFields`, `fragment RecurringFields on Recurring { ... }`, etc. Total ~920 characters.

Expected in `DeleteRecurring.md`: `mutation DeleteRecurring($deleteRecurringId: ID!) { deleteRecurring(id: $deleteRecurringId) }`. Total ~95 characters.

- [ ] **Step 4: Commit the updated capture docs**

```bash
git add docs/graphql-capture/operations/mutations/CreateRecurring.md docs/graphql-capture/operations/mutations/DeleteRecurring.md
git commit -m "docs(graphql-capture): replace inferred stubs with verbatim CreateRecurring/DeleteRecurring strings"
```

### Prereq-B: Audit format/ dir usage

Verify nothing outside the write path imports `src/core/format/` before deleting it.

- [ ] **Step 1: Grep for imports**

```bash
grep -rn "from.*core/format" src/ tests/
```

Expected: all matches are from `src/core/firestore-client.ts` or `src/tools/tools.ts` (Firestore write paths). Any match from read-path code (`database.ts`, `decoder.ts`, etc.) is a surprise — stop and investigate before proceeding.

- [ ] **Step 2: Record findings**

Note the import count and locations in the Task 16 cleanup notes below. If clean, proceed with the plan unmodified. If anything non-write-path uses it, extract the shared bits to a new location before Task 16.

---

## Task 1: Add `graphql` devDependency + generator script scaffold

Install the `graphql` package (used only by the build-time generator) and create the generator script skeleton.

**Files:**
- Modify: `package.json`
- Create: `scripts/generate-graphql-operations.ts`

- [ ] **Step 1: Install `graphql` as devDependency**

```bash
bun add -d graphql
```

Expected: `package.json` shows `"graphql": "^16.x.x"` in `devDependencies`. `bun.lockb` updated.

- [ ] **Step 2: Add `generate:graphql` script to package.json**

Edit `package.json` `scripts` section. Add:

```json
"generate:graphql": "bun run scripts/generate-graphql-operations.ts",
```

Also update `build` to run the generator first:

```json
"build": "bun run generate:graphql && bun build src/cli.ts src/server.ts --outdir dist --target node --format esm --external classic-level && bun build src/core/decode-worker.ts --outdir dist --target node --format esm --external classic-level && chmod +x dist/cli.js",
```

- [ ] **Step 3: Create generator skeleton**

```bash
touch scripts/generate-graphql-operations.ts
```

Content:

```typescript
/**
 * Generate src/core/graphql/operations.generated.ts from the captured
 * mutation docs in docs/graphql-capture/operations/mutations/.
 *
 * Parses each in-scope mutation's query string, injects __typename into
 * every selection set (matching Apollo's documentTransform behavior
 * required by Copilot's GraphQL server), and emits typed string constants.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse, print, visit, Kind } from 'graphql';

const IN_SCOPE_MUTATIONS = [
  'EditTransaction',
  'CreateCategory',
  'EditCategory',
  'DeleteCategory',
  'CreateTag',
  'EditTag',
  'DeleteTag',
  'CreateRecurring',
  'EditRecurring',
  'DeleteRecurring',
  'EditBudget',
  'EditBudgetMonthly',
  'EditAccount',
] as const;

const CAPTURE_DIR = 'docs/graphql-capture/operations/mutations';
const OUTPUT_PATH = 'src/core/graphql/operations.generated.ts';

function extractQueryBlock(markdown: string, mutationName: string): string {
  // Find the ```graphql fenced block under the ## Query heading.
  const match = markdown.match(/##\s*Query\s*\n+```graphql\s*\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error(`${mutationName}: no graphql block under ## Query`);
  }
  return match[1];
}

function addTypenameToSelectionSets(query: string): string {
  const ast = parse(query);
  const transformed = visit(ast, {
    SelectionSet(node) {
      const hasTypename = node.selections.some(
        (sel) => sel.kind === Kind.FIELD && sel.name.value === '__typename'
      );
      if (hasTypename) return undefined; // no change
      return {
        ...node,
        selections: [
          { kind: Kind.FIELD, name: { kind: Kind.NAME, value: '__typename' } },
          ...node.selections,
        ],
      };
    },
  });
  return print(transformed);
}

function constName(mutationName: string): string {
  // EditTransaction -> EDIT_TRANSACTION
  return mutationName.replace(/([A-Z])/g, '_$1').replace(/^_/, '').toUpperCase();
}

function main(): void {
  const lines: string[] = [
    '// AUTO-GENERATED — do not edit.',
    '// Regenerate with: bun run generate:graphql',
    '/* eslint-disable */',
    '',
  ];

  for (const name of IN_SCOPE_MUTATIONS) {
    const path = resolve(CAPTURE_DIR, `${name}.md`);
    const md = readFileSync(path, 'utf8');
    const rawQuery = extractQueryBlock(md, name);
    const transformed = addTypenameToSelectionSets(rawQuery);
    lines.push(`export const ${constName(name)} = ${JSON.stringify(transformed)};`);
    lines.push('');
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, lines.join('\n'));
  console.log(`Wrote ${OUTPUT_PATH} with ${IN_SCOPE_MUTATIONS.length} operations`);
}

main();
```

- [ ] **Step 4: Run generator end-to-end**

```bash
bun run generate:graphql
```

Expected output: `Wrote src/core/graphql/operations.generated.ts with 13 operations`. File exists. Open it and spot-check:
- Header comment present.
- All 13 `export const <NAME> = "..."` lines present.
- Every generated query string contains `__typename` (run `grep -c __typename src/core/graphql/operations.generated.ts` — should be ≥ 13, usually much more).
- The `EditTransaction` string, decoded, contains `...TransactionFields` and `fragment TransactionFields` with `__typename` injected into the `Transaction` selection set.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lockb scripts/generate-graphql-operations.ts src/core/graphql/operations.generated.ts
git commit -m "feat(graphql): add operations generator + graphql devDependency"
```

---

## Task 2: Test the generator

Add unit tests for the generator's transformation logic against a minimal in-memory fixture.

**Files:**
- Create: `tests/scripts/generate-graphql-operations.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, test, expect } from 'bun:test';
import { parse, print } from 'graphql';

// Import the transform function. It must be exported for testability.
// (This task also requires making addTypenameToSelectionSets and extractQueryBlock
// named exports in scripts/generate-graphql-operations.ts.)
import {
  addTypenameToSelectionSets,
  extractQueryBlock,
} from '../../scripts/generate-graphql-operations.js';

describe('addTypenameToSelectionSets', () => {
  test('injects __typename into a flat selection set', () => {
    const input = `mutation M { editThing(id: "x") { id name } }`;
    const out = addTypenameToSelectionSets(input);
    const ast = parse(out);
    const queryField = (ast.definitions[0] as any).selectionSet.selections[0];
    const selectionNames = queryField.selectionSet.selections.map((s: any) => s.name.value);
    expect(selectionNames).toContain('__typename');
    expect(selectionNames).toContain('id');
    expect(selectionNames).toContain('name');
  });

  test('injects __typename into nested selection sets', () => {
    const input = `mutation M { editThing(id: "x") { id nested { a b } } }`;
    const out = addTypenameToSelectionSets(input);
    // Should contain __typename twice: once for outer, once for nested.
    expect((out.match(/__typename/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test('does not duplicate __typename if already present', () => {
    const input = `mutation M { editThing(id: "x") { __typename id } }`;
    const out = addTypenameToSelectionSets(input);
    expect((out.match(/__typename/g) ?? []).length).toBe(1);
  });

  test('preserves inline fragment selections', () => {
    const input = `mutation M { editThing(id: "x") { icon { ... on EmojiUnicode { unicode } } } }`;
    const out = addTypenameToSelectionSets(input);
    // __typename should land on both outer selection set and inside the inline fragment.
    expect((out.match(/__typename/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('extractQueryBlock', () => {
  test('extracts query from a standard capture markdown', () => {
    const md = [
      '# SomeOp',
      '',
      '## Query',
      '',
      '```graphql',
      'mutation SomeOp($id: ID!) {',
      '  doThing(id: $id)',
      '}',
      '```',
      '',
      '## Variables',
    ].join('\n');
    const out = extractQueryBlock(md, 'SomeOp');
    expect(out).toContain('mutation SomeOp($id: ID!)');
    expect(out).toContain('doThing(id: $id)');
    expect(out).not.toContain('```');
  });

  test('throws when no graphql block under ## Query', () => {
    expect(() => extractQueryBlock('# Foo\n\n## Variables\n', 'Foo')).toThrow(
      /no graphql block/
    );
  });
});
```

- [ ] **Step 2: Export the helpers from the generator**

Edit `scripts/generate-graphql-operations.ts`. Change `function extractQueryBlock(...)` to `export function extractQueryBlock(...)`. Same for `addTypenameToSelectionSets`.

Wrap the `main()` call so it only runs when the file is executed directly (not imported by tests):

```typescript
if (import.meta.main) {
  main();
}
```

- [ ] **Step 3: Run tests**

```bash
bun test tests/scripts/generate-graphql-operations.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/scripts/generate-graphql-operations.test.ts scripts/generate-graphql-operations.ts
git commit -m "test(graphql): unit tests for operations generator"
```

---

## Task 3: Build `GraphQLClient` transport + error model

Single class that encapsulates every HTTP detail: auth header, body shape, error classification.

**Files:**
- Create: `src/core/graphql/client.ts`
- Create: `tests/core/graphql/client.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { GraphQLClient, GraphQLError } from '../../../src/core/graphql/client.js';
import type { FirebaseAuth } from '../../../src/core/auth/firebase-auth.js';

let fetchCalls: { url: string; options: RequestInit }[] = [];
const originalFetch = globalThis.fetch;

function mockFetch(responseBody: unknown, status = 200, throwErr?: Error) {
  fetchCalls = [];
  globalThis.fetch = mock((url: string | URL | Request, options?: RequestInit) => {
    fetchCalls.push({ url: String(url), options: options ?? {} });
    if (throwErr) return Promise.reject(throwErr);
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function createMockAuth(idToken = 'test-jwt'): FirebaseAuth {
  return { getIdToken: mock(() => Promise.resolve(idToken)) } as unknown as FirebaseAuth;
}

describe('GraphQLClient', () => {
  afterEach(() => restoreFetch());

  test('POSTs to the Copilot GraphQL endpoint with correct headers', async () => {
    mockFetch({ data: { ok: true } });
    const client = new GraphQLClient(createMockAuth());
    await client.mutate('TestOp', 'mutation TestOp { ok }', {});
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://app.copilot.money/api/graphql');
    expect(fetchCalls[0].options.method).toBe('POST');
    const headers = fetchCalls[0].options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-jwt');
    expect(headers['Content-Type']).toBe('application/json');
    // No extra headers.
    expect(Object.keys(headers).sort()).toEqual(['Authorization', 'Content-Type']);
  });

  test('sends single-op body as JSON object (not array)', async () => {
    mockFetch({ data: { ok: true } });
    const client = new GraphQLClient(createMockAuth());
    await client.mutate('TestOp', 'mutation TestOp { ok }', { id: 'x' });
    const body = JSON.parse(fetchCalls[0].options.body as string);
    expect(Array.isArray(body)).toBe(false);
    expect(body).toEqual({
      operationName: 'TestOp',
      query: 'mutation TestOp { ok }',
      variables: { id: 'x' },
    });
  });

  test('returns the data field on successful response', async () => {
    mockFetch({ data: { editTransaction: { transaction: { id: 't1' } } } });
    const client = new GraphQLClient(createMockAuth());
    const out = await client.mutate<unknown, { editTransaction: { transaction: { id: string } } }>(
      'TestOp',
      'mutation TestOp { editTransaction { transaction { id } } }',
      {}
    );
    expect(out.editTransaction.transaction.id).toBe('t1');
  });

  test('classifies HTTP 401 as AUTH_FAILED', async () => {
    mockFetch({ errors: [{ message: 'unauthorized' }] }, 401);
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('TestOp', 'mutation TestOp { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(GraphQLError);
      expect((e as GraphQLError).code).toBe('AUTH_FAILED');
      expect((e as GraphQLError).httpStatus).toBe(401);
    }
  });

  test('classifies HTTP 500 as SCHEMA_ERROR', async () => {
    mockFetch('Internal server error', 500);
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('TestOp', 'mutation TestOp { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).code).toBe('SCHEMA_ERROR');
    }
  });

  test('classifies other non-2xx as UNKNOWN', async () => {
    mockFetch({}, 418);
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('TestOp', 'mutation TestOp { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).code).toBe('UNKNOWN');
      expect((e as GraphQLError).httpStatus).toBe(418);
    }
  });

  test('classifies 2xx+errors[] as USER_ACTION_REQUIRED', async () => {
    mockFetch({
      errors: [{ message: 'Budgeting is disabled for this account.' }],
    });
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('TestOp', 'mutation TestOp { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).code).toBe('USER_ACTION_REQUIRED');
      expect((e as GraphQLError).message).toBe('Budgeting is disabled for this account.');
    }
  });

  test('classifies thrown fetch as NETWORK', async () => {
    mockFetch({}, 200, new Error('ECONNRESET'));
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('TestOp', 'mutation TestOp { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).code).toBe('NETWORK');
      expect((e as GraphQLError).message).toContain('ECONNRESET');
    }
  });

  test('carries operationName on thrown error', async () => {
    mockFetch({ errors: [{ message: 'boom' }] });
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('EditTransaction', 'mutation EditTransaction { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).operationName).toBe('EditTransaction');
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/core/graphql/client.test.ts
```

Expected: all tests fail with "Cannot find module '.../client.js'" (file doesn't exist yet).

- [ ] **Step 3: Implement `GraphQLClient`**

Create `src/core/graphql/client.ts`:

```typescript
/**
 * Transport + auth + error classification for Copilot Money's GraphQL API.
 *
 * Single-op requests (object body, not array). Reuses the existing
 * FirebaseAuth class to mint JWTs. All failure modes surface as a
 * typed GraphQLError with a discriminated `code` field.
 */

import type { FirebaseAuth } from '../auth/firebase-auth.js';

const ENDPOINT = 'https://app.copilot.money/api/graphql';

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
  ) {
    super(message);
    this.name = 'GraphQLError';
  }
}

export class GraphQLClient {
  constructor(private auth: FirebaseAuth) {}

  async mutate<TVariables, TResponse>(
    operationName: string,
    query: string,
    variables: TVariables
  ): Promise<TResponse> {
    const idToken = await this.auth.getIdToken();

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ operationName, query, variables }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new GraphQLError('NETWORK', msg, operationName);
    }

    // Classify HTTP-level failures BEFORE parsing body (body may not be JSON).
    if (response.status === 401) {
      const text = await response.text().catch(() => '');
      this.logError(operationName, 'AUTH_FAILED', 401);
      throw new GraphQLError(
        'AUTH_FAILED',
        `401 Unauthorized: ${text || 'no body'}`,
        operationName,
        401
      );
    }
    if (response.status === 500) {
      const text = await response.text().catch(() => '');
      this.logError(operationName, 'SCHEMA_ERROR', 500);
      throw new GraphQLError(
        'SCHEMA_ERROR',
        `500 Server Error: ${text || 'no body'}`,
        operationName,
        500
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.logError(operationName, 'UNKNOWN', response.status);
      throw new GraphQLError(
        'UNKNOWN',
        `${response.status}: ${text || 'no body'}`,
        operationName,
        response.status
      );
    }

    const body = (await response.json()) as {
      data?: TResponse;
      errors?: Array<{ message: string }>;
    };

    if (body.errors && body.errors.length > 0) {
      const firstMessage = body.errors[0]?.message ?? 'GraphQL error (no message)';
      this.logError(operationName, 'USER_ACTION_REQUIRED', response.status);
      throw new GraphQLError(
        'USER_ACTION_REQUIRED',
        firstMessage,
        operationName,
        response.status,
        body.errors
      );
    }

    if (!body.data) {
      throw new GraphQLError(
        'UNKNOWN',
        'Response missing data field',
        operationName,
        response.status
      );
    }

    return body.data;
  }

  private logError(operationName: string, code: GraphQLErrorCode, httpStatus: number): void {
    console.error(
      `[graphql] ${operationName} failed: code=${code} status=${httpStatus}`
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/core/graphql/client.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/graphql/client.ts tests/core/graphql/client.test.ts
git commit -m "feat(graphql): GraphQLClient transport with typed error classification"
```

---

## Task 4: Per-domain function — `transactions.ts`

`editTransaction()` wrapping the `EditTransaction` mutation. Covers both `update_transaction` and `review_transactions` tool use cases.

**Files:**
- Create: `src/core/graphql/transactions.ts`
- Create: `tests/core/graphql/transactions.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, test, expect, mock } from 'bun:test';
import { editTransaction } from '../../../src/core/graphql/transactions.js';
import { EDIT_TRANSACTION } from '../../../src/core/graphql/operations.generated.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';

function createMockClient(response: unknown): GraphQLClient {
  return {
    mutate: mock((_op: string, _q: string, _v: unknown) => Promise.resolve(response)),
  } as unknown as GraphQLClient;
}

describe('editTransaction', () => {
  test('calls mutate with EditTransaction op name, generated query, and expected variables', async () => {
    const client = createMockClient({
      editTransaction: {
        transaction: {
          id: 't1',
          categoryId: 'c1',
          userNotes: null,
          isReviewed: false,
          tags: [],
        },
      },
    });

    await editTransaction(client, {
      id: 't1',
      accountId: 'a1',
      itemId: 'i1',
      input: { categoryId: 'c1' },
    });

    const calls = (client.mutate as ReturnType<typeof mock>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('EditTransaction');
    expect(calls[0][1]).toBe(EDIT_TRANSACTION);
    expect(calls[0][2]).toEqual({
      id: 't1',
      accountId: 'a1',
      itemId: 'i1',
      input: { categoryId: 'c1' },
    });
  });

  test('returns compact { id, changed } from full response', async () => {
    const client = createMockClient({
      editTransaction: {
        transaction: {
          id: 't1',
          categoryId: 'c2',
          userNotes: 'hello',
          isReviewed: true,
          tags: [{ id: 'tag1', name: 'food', colorName: 'RED1' }],
        },
      },
    });

    const out = await editTransaction(client, {
      id: 't1',
      accountId: 'a1',
      itemId: 'i1',
      input: { categoryId: 'c2', userNotes: 'hello', isReviewed: true, tagIds: ['tag1'] },
    });

    expect(out.id).toBe('t1');
    expect(out.changed).toEqual({
      categoryId: 'c2',
      userNotes: 'hello',
      isReviewed: true,
      tagIds: ['tag1'],
    });
  });

  test('omits unchanged fields from compact response', async () => {
    const client = createMockClient({
      editTransaction: {
        transaction: { id: 't1', categoryId: 'c2', userNotes: null, isReviewed: false, tags: [] },
      },
    });

    const out = await editTransaction(client, {
      id: 't1',
      accountId: 'a1',
      itemId: 'i1',
      input: { categoryId: 'c2' },
    });

    expect(Object.keys(out.changed)).toEqual(['categoryId']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/core/graphql/transactions.test.ts
```

Expected: all fail (module doesn't exist).

- [ ] **Step 3: Implement `editTransaction`**

Create `src/core/graphql/transactions.ts`:

```typescript
import type { GraphQLClient } from './client.js';
import { EDIT_TRANSACTION } from './operations.generated.js';

export interface EditTransactionInput {
  categoryId?: string;
  userNotes?: string | null;
  tagIds?: string[];
  isReviewed?: boolean;
}

export interface EditTransactionArgs {
  id: string;
  accountId: string;
  itemId: string;
  input: EditTransactionInput;
}

interface EditTransactionResponse {
  editTransaction: {
    transaction: {
      id: string;
      categoryId?: string;
      userNotes?: string | null;
      isReviewed?: boolean;
      tags?: Array<{ id: string }>;
    };
  };
}

export async function editTransaction(
  client: GraphQLClient,
  args: EditTransactionArgs
): Promise<{ id: string; changed: Record<string, unknown> }> {
  const data = await client.mutate<EditTransactionArgs, EditTransactionResponse>(
    'EditTransaction',
    EDIT_TRANSACTION,
    args
  );
  const tx = data.editTransaction.transaction;
  const changed: Record<string, unknown> = {};
  // Only report back the fields the caller asked to change.
  if ('categoryId' in args.input) changed.categoryId = tx.categoryId;
  if ('userNotes' in args.input) changed.userNotes = tx.userNotes;
  if ('isReviewed' in args.input) changed.isReviewed = tx.isReviewed;
  if ('tagIds' in args.input) changed.tagIds = (tx.tags ?? []).map((t) => t.id);
  return { id: tx.id, changed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/core/graphql/transactions.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/graphql/transactions.ts tests/core/graphql/transactions.test.ts
git commit -m "feat(graphql): transactions domain — editTransaction"
```

---

## Task 5: Per-domain function — `categories.ts`

`createCategory()`, `editCategory()`, `deleteCategory()`.

**Files:**
- Create: `src/core/graphql/categories.ts`
- Create: `tests/core/graphql/categories.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, test, expect, mock } from 'bun:test';
import {
  createCategory,
  editCategory,
  deleteCategory,
} from '../../../src/core/graphql/categories.js';
import {
  CREATE_CATEGORY,
  EDIT_CATEGORY,
  DELETE_CATEGORY,
} from '../../../src/core/graphql/operations.generated.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';

function createMockClient(response: unknown): GraphQLClient {
  return {
    mutate: mock((_op: string, _q: string, _v: unknown) => Promise.resolve(response)),
  } as unknown as GraphQLClient;
}

describe('createCategory', () => {
  test('sends CreateCategory mutation with input, spend, budget variables', async () => {
    const client = createMockClient({
      createCategory: { id: 'cat-1', name: 'Snacks', colorName: 'OLIVE1' },
    });
    await createCategory(client, {
      input: { name: 'Snacks', colorName: 'OLIVE1', emoji: '🍿', isExcluded: false },
    });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('CreateCategory');
    expect(call[1]).toBe(CREATE_CATEGORY);
    expect(call[2]).toEqual({
      spend: false,
      budget: false,
      input: { name: 'Snacks', colorName: 'OLIVE1', emoji: '🍿', isExcluded: false },
    });
  });

  test('returns compact { id, name, colorName }', async () => {
    const client = createMockClient({
      createCategory: { id: 'cat-1', name: 'Snacks', colorName: 'OLIVE1' },
    });
    const out = await createCategory(client, {
      input: { name: 'Snacks', colorName: 'OLIVE1', emoji: '🍿', isExcluded: false },
    });
    expect(out).toEqual({ id: 'cat-1', name: 'Snacks', colorName: 'OLIVE1' });
  });
});

describe('editCategory', () => {
  test('sends EditCategory with id + input + spend/budget:false', async () => {
    const client = createMockClient({
      editCategory: { id: 'cat-1', name: 'Treats', colorName: 'OLIVE1' },
    });
    await editCategory(client, { id: 'cat-1', input: { name: 'Treats' } });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('EditCategory');
    expect(call[1]).toBe(EDIT_CATEGORY);
    expect(call[2]).toEqual({ id: 'cat-1', spend: false, budget: false, input: { name: 'Treats' } });
  });
});

describe('deleteCategory', () => {
  test('sends DeleteCategory with id', async () => {
    const client = createMockClient({ deleteCategory: true });
    await deleteCategory(client, { id: 'cat-1' });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('DeleteCategory');
    expect(call[1]).toBe(DELETE_CATEGORY);
    expect(call[2]).toEqual({ id: 'cat-1' });
  });

  test('returns { id, deleted: true }', async () => {
    const client = createMockClient({ deleteCategory: true });
    const out = await deleteCategory(client, { id: 'cat-1' });
    expect(out).toEqual({ id: 'cat-1', deleted: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/core/graphql/categories.test.ts
```

Expected: all fail (module doesn't exist).

- [ ] **Step 3: Implement categories module**

Create `src/core/graphql/categories.ts`:

```typescript
import type { GraphQLClient } from './client.js';
import {
  CREATE_CATEGORY,
  EDIT_CATEGORY,
  DELETE_CATEGORY,
} from './operations.generated.js';

export interface CreateCategoryInput {
  name: string;
  colorName: string;
  emoji: string;
  isExcluded: boolean;
  parentId?: string;
}

export async function createCategory(
  client: GraphQLClient,
  args: { input: CreateCategoryInput }
): Promise<{ id: string; name: string; colorName: string }> {
  const data = await client.mutate<
    { input: CreateCategoryInput; spend: boolean; budget: boolean },
    { createCategory: { id: string; name: string; colorName: string } }
  >('CreateCategory', CREATE_CATEGORY, { spend: false, budget: false, input: args.input });
  return {
    id: data.createCategory.id,
    name: data.createCategory.name,
    colorName: data.createCategory.colorName,
  };
}

export interface EditCategoryInput {
  name?: string;
  colorName?: string;
  emoji?: string;
  isExcluded?: boolean;
  parentId?: string | null;
}

export async function editCategory(
  client: GraphQLClient,
  args: { id: string; input: EditCategoryInput }
): Promise<{ id: string; changed: Record<string, unknown> }> {
  const data = await client.mutate<
    { id: string; input: EditCategoryInput; spend: boolean; budget: boolean },
    { editCategory: { id: string; name?: string; colorName?: string } }
  >('EditCategory', EDIT_CATEGORY, {
    id: args.id,
    spend: false,
    budget: false,
    input: args.input,
  });
  const changed: Record<string, unknown> = {};
  if ('name' in args.input) changed.name = data.editCategory.name;
  if ('colorName' in args.input) changed.colorName = data.editCategory.colorName;
  if ('emoji' in args.input) changed.emoji = args.input.emoji;
  if ('isExcluded' in args.input) changed.isExcluded = args.input.isExcluded;
  if ('parentId' in args.input) changed.parentId = args.input.parentId;
  return { id: data.editCategory.id, changed };
}

export async function deleteCategory(
  client: GraphQLClient,
  args: { id: string }
): Promise<{ id: string; deleted: true }> {
  await client.mutate<{ id: string }, { deleteCategory: boolean }>(
    'DeleteCategory',
    DELETE_CATEGORY,
    { id: args.id }
  );
  return { id: args.id, deleted: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/core/graphql/categories.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/graphql/categories.ts tests/core/graphql/categories.test.ts
git commit -m "feat(graphql): categories domain — create/edit/delete"
```

---

## Task 6: Per-domain function — `tags.ts`

`createTag()`, `editTag()`, `deleteTag()`.

**Files:**
- Create: `src/core/graphql/tags.ts`
- Create: `tests/core/graphql/tags.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, test, expect, mock } from 'bun:test';
import { createTag, editTag, deleteTag } from '../../../src/core/graphql/tags.js';
import {
  CREATE_TAG,
  EDIT_TAG,
  DELETE_TAG,
} from '../../../src/core/graphql/operations.generated.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';

function createMockClient(response: unknown): GraphQLClient {
  return {
    mutate: mock((_op: string, _q: string, _v: unknown) => Promise.resolve(response)),
  } as unknown as GraphQLClient;
}

describe('createTag', () => {
  test('sends CreateTag with input', async () => {
    const client = createMockClient({
      createTag: { id: 'tag-1', name: 'urgent', colorName: 'PURPLE2' },
    });
    await createTag(client, { input: { name: 'urgent', colorName: 'PURPLE2' } });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('CreateTag');
    expect(call[1]).toBe(CREATE_TAG);
    expect(call[2]).toEqual({ input: { name: 'urgent', colorName: 'PURPLE2' } });
  });

  test('returns compact { id, name, colorName }', async () => {
    const client = createMockClient({
      createTag: { id: 'tag-1', name: 'urgent', colorName: 'PURPLE2' },
    });
    const out = await createTag(client, { input: { name: 'urgent', colorName: 'PURPLE2' } });
    expect(out).toEqual({ id: 'tag-1', name: 'urgent', colorName: 'PURPLE2' });
  });
});

describe('editTag', () => {
  test('sends EditTag with id + input', async () => {
    const client = createMockClient({ editTag: { id: 'tag-1', name: 'urgent-v2', colorName: 'PURPLE2' } });
    await editTag(client, { id: 'tag-1', input: { name: 'urgent-v2' } });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('EditTag');
    expect(call[1]).toBe(EDIT_TAG);
    expect(call[2]).toEqual({ id: 'tag-1', input: { name: 'urgent-v2' } });
  });
});

describe('deleteTag', () => {
  test('sends DeleteTag with id and returns { id, deleted: true }', async () => {
    const client = createMockClient({ deleteTag: true });
    const out = await deleteTag(client, { id: 'tag-1' });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('DeleteTag');
    expect(call[1]).toBe(DELETE_TAG);
    expect(call[2]).toEqual({ id: 'tag-1' });
    expect(out).toEqual({ id: 'tag-1', deleted: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/core/graphql/tags.test.ts
```

Expected: fail.

- [ ] **Step 3: Implement tags module**

Create `src/core/graphql/tags.ts`:

```typescript
import type { GraphQLClient } from './client.js';
import { CREATE_TAG, EDIT_TAG, DELETE_TAG } from './operations.generated.js';

export interface CreateTagInput {
  name: string;
  colorName: string;
}

export async function createTag(
  client: GraphQLClient,
  args: { input: CreateTagInput }
): Promise<{ id: string; name: string; colorName: string }> {
  const data = await client.mutate<
    { input: CreateTagInput },
    { createTag: { id: string; name: string; colorName: string } }
  >('CreateTag', CREATE_TAG, args);
  return {
    id: data.createTag.id,
    name: data.createTag.name,
    colorName: data.createTag.colorName,
  };
}

export interface EditTagInput {
  name?: string;
  colorName?: string;
}

export async function editTag(
  client: GraphQLClient,
  args: { id: string; input: EditTagInput }
): Promise<{ id: string; changed: Record<string, unknown> }> {
  const data = await client.mutate<
    { id: string; input: EditTagInput },
    { editTag: { id: string; name?: string; colorName?: string } }
  >('EditTag', EDIT_TAG, args);
  const changed: Record<string, unknown> = {};
  if ('name' in args.input) changed.name = data.editTag.name;
  if ('colorName' in args.input) changed.colorName = data.editTag.colorName;
  return { id: data.editTag.id, changed };
}

export async function deleteTag(
  client: GraphQLClient,
  args: { id: string }
): Promise<{ id: string; deleted: true }> {
  await client.mutate<{ id: string }, { deleteTag: boolean }>(
    'DeleteTag',
    DELETE_TAG,
    { id: args.id }
  );
  return { id: args.id, deleted: true };
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/core/graphql/tags.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/graphql/tags.ts tests/core/graphql/tags.test.ts
git commit -m "feat(graphql): tags domain — create/edit/delete"
```

---

## Task 7: Per-domain function — `recurrings.ts`

`createRecurring()`, `editRecurring()`, `deleteRecurring()`.

**Files:**
- Create: `src/core/graphql/recurrings.ts`
- Create: `tests/core/graphql/recurrings.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, test, expect, mock } from 'bun:test';
import {
  createRecurring,
  editRecurring,
  deleteRecurring,
} from '../../../src/core/graphql/recurrings.js';
import {
  CREATE_RECURRING,
  EDIT_RECURRING,
  DELETE_RECURRING,
} from '../../../src/core/graphql/operations.generated.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';

function createMockClient(response: unknown): GraphQLClient {
  return {
    mutate: mock((_op: string, _q: string, _v: unknown) => Promise.resolve(response)),
  } as unknown as GraphQLClient;
}

describe('createRecurring', () => {
  test('sends CreateRecurring with input containing frequency + transaction', async () => {
    const client = createMockClient({
      createRecurring: { id: 'r1', name: 'Netflix', state: 'ACTIVE', frequency: 'MONTHLY' },
    });
    await createRecurring(client, {
      input: {
        frequency: 'MONTHLY',
        transaction: { accountId: 'a1', itemId: 'i1', transactionId: 't1' },
      },
    });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('CreateRecurring');
    expect(call[1]).toBe(CREATE_RECURRING);
    expect(call[2]).toEqual({
      input: {
        frequency: 'MONTHLY',
        transaction: { accountId: 'a1', itemId: 'i1', transactionId: 't1' },
      },
    });
  });

  test('returns compact { id, name, state, frequency }', async () => {
    const client = createMockClient({
      createRecurring: { id: 'r1', name: 'Netflix', state: 'ACTIVE', frequency: 'MONTHLY' },
    });
    const out = await createRecurring(client, {
      input: {
        frequency: 'MONTHLY',
        transaction: { accountId: 'a1', itemId: 'i1', transactionId: 't1' },
      },
    });
    expect(out).toEqual({ id: 'r1', name: 'Netflix', state: 'ACTIVE', frequency: 'MONTHLY' });
  });
});

describe('editRecurring', () => {
  test('sends EditRecurring with id + input (state change)', async () => {
    const client = createMockClient({ editRecurring: { id: 'r1', state: 'PAUSED' } });
    await editRecurring(client, { id: 'r1', input: { state: 'PAUSED' } });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('EditRecurring');
    expect(call[1]).toBe(EDIT_RECURRING);
    expect(call[2]).toEqual({ id: 'r1', input: { state: 'PAUSED' } });
  });

  test('returns compact { id, changed } with only requested fields', async () => {
    const client = createMockClient({
      editRecurring: { id: 'r1', state: 'PAUSED', rule: { minAmount: '5', maxAmount: '10' } },
    });
    const out = await editRecurring(client, {
      id: 'r1',
      input: { state: 'PAUSED' },
    });
    expect(out).toEqual({ id: 'r1', changed: { state: 'PAUSED' } });
  });
});

describe('deleteRecurring', () => {
  test('sends DeleteRecurring with deleteRecurringId variable name', async () => {
    const client = createMockClient({ deleteRecurring: true });
    const out = await deleteRecurring(client, { id: 'r1' });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('DeleteRecurring');
    expect(call[1]).toBe(DELETE_RECURRING);
    expect(call[2]).toEqual({ deleteRecurringId: 'r1' });
    expect(out).toEqual({ id: 'r1', deleted: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/core/graphql/recurrings.test.ts
```

- [ ] **Step 3: Implement recurrings module**

Create `src/core/graphql/recurrings.ts`:

```typescript
import type { GraphQLClient } from './client.js';
import {
  CREATE_RECURRING,
  EDIT_RECURRING,
  DELETE_RECURRING,
} from './operations.generated.js';

export interface CreateRecurringInput {
  frequency: string;
  transaction: { accountId: string; itemId: string; transactionId: string };
}

export async function createRecurring(
  client: GraphQLClient,
  args: { input: CreateRecurringInput }
): Promise<{ id: string; name: string; state: string; frequency: string }> {
  const data = await client.mutate<
    { input: CreateRecurringInput },
    { createRecurring: { id: string; name: string; state: string; frequency: string } }
  >('CreateRecurring', CREATE_RECURRING, args);
  return {
    id: data.createRecurring.id,
    name: data.createRecurring.name,
    state: data.createRecurring.state,
    frequency: data.createRecurring.frequency,
  };
}

export interface EditRecurringInput {
  state?: string;
  rule?: { nameContains?: string; minAmount?: string; maxAmount?: string; days?: number[] };
}

export async function editRecurring(
  client: GraphQLClient,
  args: { id: string; input: EditRecurringInput }
): Promise<{ id: string; changed: Record<string, unknown> }> {
  const data = await client.mutate<
    { id: string; input: EditRecurringInput },
    { editRecurring: { id: string; state?: string; rule?: EditRecurringInput['rule'] } }
  >('EditRecurring', EDIT_RECURRING, args);
  const changed: Record<string, unknown> = {};
  if ('state' in args.input) changed.state = data.editRecurring.state;
  if ('rule' in args.input) changed.rule = data.editRecurring.rule;
  return { id: data.editRecurring.id, changed };
}

export async function deleteRecurring(
  client: GraphQLClient,
  args: { id: string }
): Promise<{ id: string; deleted: true }> {
  // Note: variable is named `deleteRecurringId`, not `id` — preserved from the captured wire shape.
  await client.mutate<{ deleteRecurringId: string }, { deleteRecurring: boolean }>(
    'DeleteRecurring',
    DELETE_RECURRING,
    { deleteRecurringId: args.id }
  );
  return { id: args.id, deleted: true };
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/core/graphql/recurrings.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/graphql/recurrings.ts tests/core/graphql/recurrings.test.ts
git commit -m "feat(graphql): recurrings domain — create/edit/delete"
```

---

## Task 8: Per-domain function — `budgets.ts`

`setBudget()` dispatches to `EditBudget` or `EditBudgetMonthly` based on whether `month` is present.

**Files:**
- Create: `src/core/graphql/budgets.ts`
- Create: `tests/core/graphql/budgets.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, test, expect, mock } from 'bun:test';
import { setBudget } from '../../../src/core/graphql/budgets.js';
import {
  EDIT_BUDGET,
  EDIT_BUDGET_MONTHLY,
} from '../../../src/core/graphql/operations.generated.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';

function createMockClient(response: unknown): GraphQLClient {
  return {
    mutate: mock((_op: string, _q: string, _v: unknown) => Promise.resolve(response)),
  } as unknown as GraphQLClient;
}

describe('setBudget', () => {
  test('dispatches EditBudget when month absent', async () => {
    const client = createMockClient({ editCategoryBudget: true });
    await setBudget(client, { categoryId: 'cat-1', amount: '250' });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('EditBudget');
    expect(call[1]).toBe(EDIT_BUDGET);
    expect(call[2]).toEqual({ categoryId: 'cat-1', input: { amount: '250' } });
  });

  test('dispatches EditBudgetMonthly when month present', async () => {
    const client = createMockClient({ editCategoryBudgetMonthly: true });
    await setBudget(client, { categoryId: 'cat-1', amount: '250', month: '2026-04' });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('EditBudgetMonthly');
    expect(call[1]).toBe(EDIT_BUDGET_MONTHLY);
    expect(call[2]).toEqual({
      categoryId: 'cat-1',
      input: [{ amount: '250', month: '2026-04' }],
    });
  });

  test('amount=0 is valid (clears the budget)', async () => {
    const client = createMockClient({ editCategoryBudget: true });
    await setBudget(client, { categoryId: 'cat-1', amount: '0' });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[2]).toEqual({ categoryId: 'cat-1', input: { amount: '0' } });
  });

  test('returns compact { categoryId, amount, month?, cleared }', async () => {
    const client = createMockClient({ editCategoryBudget: true });
    const out = await setBudget(client, { categoryId: 'cat-1', amount: '250' });
    expect(out).toEqual({ categoryId: 'cat-1', amount: '250', cleared: false });

    const client2 = createMockClient({ editCategoryBudget: true });
    const out2 = await setBudget(client2, { categoryId: 'cat-1', amount: '0' });
    expect(out2).toEqual({ categoryId: 'cat-1', amount: '0', cleared: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/core/graphql/budgets.test.ts
```

- [ ] **Step 3: Implement budgets module**

Create `src/core/graphql/budgets.ts`:

```typescript
import type { GraphQLClient } from './client.js';
import { EDIT_BUDGET, EDIT_BUDGET_MONTHLY } from './operations.generated.js';

export interface SetBudgetArgs {
  categoryId: string;
  /** Stringified decimal. "0" clears the budget. */
  amount: string;
  /** YYYY-MM. When present, uses EditBudgetMonthly. */
  month?: string;
}

export async function setBudget(
  client: GraphQLClient,
  args: SetBudgetArgs
): Promise<{ categoryId: string; amount: string; month?: string; cleared: boolean }> {
  const cleared = args.amount === '0';
  if (args.month) {
    await client.mutate<
      { categoryId: string; input: Array<{ amount: string; month: string }> },
      { editCategoryBudgetMonthly: boolean }
    >('EditBudgetMonthly', EDIT_BUDGET_MONTHLY, {
      categoryId: args.categoryId,
      input: [{ amount: args.amount, month: args.month }],
    });
    return { categoryId: args.categoryId, amount: args.amount, month: args.month, cleared };
  }
  await client.mutate<
    { categoryId: string; input: { amount: string } },
    { editCategoryBudget: boolean }
  >('EditBudget', EDIT_BUDGET, {
    categoryId: args.categoryId,
    input: { amount: args.amount },
  });
  return { categoryId: args.categoryId, amount: args.amount, cleared };
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/core/graphql/budgets.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/graphql/budgets.ts tests/core/graphql/budgets.test.ts
git commit -m "feat(graphql): budgets domain — setBudget dispatches EditBudget vs EditBudgetMonthly"
```

---

## Task 9: Per-domain function — `accounts.ts` (no MCP tool wired)

`editAccount()`. Module exists so the transport is ready; no MCP tool is created.

**Files:**
- Create: `src/core/graphql/accounts.ts`
- Create: `tests/core/graphql/accounts.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, test, expect, mock } from 'bun:test';
import { editAccount } from '../../../src/core/graphql/accounts.js';
import { EDIT_ACCOUNT } from '../../../src/core/graphql/operations.generated.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';

function createMockClient(response: unknown): GraphQLClient {
  return {
    mutate: mock((_op: string, _q: string, _v: unknown) => Promise.resolve(response)),
  } as unknown as GraphQLClient;
}

describe('editAccount', () => {
  test('sends EditAccount with id + itemId + input', async () => {
    const client = createMockClient({ editAccount: { id: 'a1', isUserHidden: true } });
    await editAccount(client, { id: 'a1', itemId: 'i1', input: { isUserHidden: true } });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('EditAccount');
    expect(call[1]).toBe(EDIT_ACCOUNT);
    expect(call[2]).toEqual({ id: 'a1', itemId: 'i1', input: { isUserHidden: true } });
  });

  test('returns compact { id, changed }', async () => {
    const client = createMockClient({ editAccount: { id: 'a1', name: 'Checking 2', isUserHidden: false } });
    const out = await editAccount(client, { id: 'a1', itemId: 'i1', input: { name: 'Checking 2' } });
    expect(out).toEqual({ id: 'a1', changed: { name: 'Checking 2' } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/core/graphql/accounts.test.ts
```

- [ ] **Step 3: Implement accounts module**

Create `src/core/graphql/accounts.ts`:

```typescript
import type { GraphQLClient } from './client.js';
import { EDIT_ACCOUNT } from './operations.generated.js';

export interface EditAccountInput {
  name?: string;
  isUserHidden?: boolean;
}

export async function editAccount(
  client: GraphQLClient,
  args: { id: string; itemId: string; input: EditAccountInput }
): Promise<{ id: string; changed: Record<string, unknown> }> {
  const data = await client.mutate<
    { id: string; itemId: string; input: EditAccountInput },
    { editAccount: { id: string; name?: string; isUserHidden?: boolean } }
  >('EditAccount', EDIT_ACCOUNT, args);
  const changed: Record<string, unknown> = {};
  if ('name' in args.input) changed.name = data.editAccount.name;
  if ('isUserHidden' in args.input) changed.isUserHidden = data.editAccount.isUserHidden;
  return { id: data.editAccount.id, changed };
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/core/graphql/accounts.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/graphql/accounts.ts tests/core/graphql/accounts.test.ts
git commit -m "feat(graphql): accounts domain — editAccount (no MCP tool wired)"
```

---

## Task 10: GraphQL error → MCP error helper

Shared translator so every write tool's catch block is one line.

**Files:**
- Create: `src/tools/errors.ts`
- Create: `tests/tools/errors.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, test, expect } from 'bun:test';
import { graphQLErrorToMcpError } from '../../src/tools/errors.js';
import { GraphQLError } from '../../src/core/graphql/client.js';

describe('graphQLErrorToMcpError', () => {
  test('AUTH_FAILED → sign-in prompt', () => {
    const err = new GraphQLError('AUTH_FAILED', '401 bad token', 'EditTransaction', 401);
    expect(graphQLErrorToMcpError(err)).toBe(
      'Authentication with Copilot failed. Sign in to the Copilot web app and try again.'
    );
  });

  test('SCHEMA_ERROR → report-issue message', () => {
    const err = new GraphQLError('SCHEMA_ERROR', '500 bad schema', 'EditBudget', 500);
    expect(graphQLErrorToMcpError(err)).toBe(
      "Copilot's API changed in a way this tool doesn't handle yet. Please report this issue."
    );
  });

  test('USER_ACTION_REQUIRED → surfaces server message verbatim', () => {
    const err = new GraphQLError(
      'USER_ACTION_REQUIRED',
      'Budgeting is disabled. Enable it in Copilot settings.',
      'EditBudget',
      200
    );
    expect(graphQLErrorToMcpError(err)).toBe(
      'Budgeting is disabled. Enable it in Copilot settings.'
    );
  });

  test('NETWORK → network prefix + details', () => {
    const err = new GraphQLError('NETWORK', 'ECONNRESET', 'EditTag');
    expect(graphQLErrorToMcpError(err)).toBe('Network error contacting Copilot: ECONNRESET');
  });

  test('UNKNOWN → generic prefix + details', () => {
    const err = new GraphQLError('UNKNOWN', '418: teapot', 'EditTag', 418);
    expect(graphQLErrorToMcpError(err)).toBe('Copilot API request failed: 418: teapot');
  });
});
```

- [ ] **Step 2: Run tests**

```bash
bun test tests/tools/errors.test.ts
```

Expected: fail (module doesn't exist).

- [ ] **Step 3: Implement the helper**

Create `src/tools/errors.ts`:

```typescript
import { GraphQLError } from '../core/graphql/client.js';

export function graphQLErrorToMcpError(e: GraphQLError): string {
  switch (e.code) {
    case 'AUTH_FAILED':
      return 'Authentication with Copilot failed. Sign in to the Copilot web app and try again.';
    case 'SCHEMA_ERROR':
      return "Copilot's API changed in a way this tool doesn't handle yet. Please report this issue.";
    case 'USER_ACTION_REQUIRED':
      return e.message;
    case 'NETWORK':
      return `Network error contacting Copilot: ${e.message}`;
    case 'UNKNOWN':
    default:
      return `Copilot API request failed: ${e.message}`;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/tools/errors.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/errors.ts tests/tools/errors.test.ts
git commit -m "feat(tools): graphQLErrorToMcpError translation helper"
```

---

## Task 11: Rewrite `tools.ts` — transaction write methods

Replace `updateTransaction` + `reviewTransactions` Firestore writes with calls to `editTransaction`.

**Files:**
- Modify: `src/tools/tools.ts` (around lines 2400-2625: `updateTransaction`, `reviewTransactions`, and the `resolveTransaction` helper they use)

- [ ] **Step 1: Read existing method implementations**

```bash
grep -n "async updateTransaction\|async reviewTransactions\|resolveTransaction\|getFirestoreClient" src/tools/tools.ts
```

Note the line ranges of:
- `updateTransaction` (around line 2406)
- `reviewTransactions` (around line 2560)
- Helpers: `resolveTransaction`, `getFirestoreClient`

- [ ] **Step 2: Update `CopilotMoneyTools` constructor to accept a `GraphQLClient` instead of `FirestoreClient`**

In `src/tools/tools.ts`, find the class constructor. Replace its `firestoreClient` field type and all references. Add `import type { GraphQLClient } from '../core/graphql/client.js';` and `import { graphQLErrorToMcpError } from './errors.js';`. The constructor becomes:

```typescript
constructor(
  private db: CopilotDatabase,
  private graphqlClient?: GraphQLClient
) {}

private getGraphQLClient(): GraphQLClient {
  if (!this.graphqlClient) {
    throw new Error('Write tools require --write flag to be set');
  }
  return this.graphqlClient;
}
```

Remove the old `getFirestoreClient()` method. (Its callers are rewritten in subsequent tasks — they will fail compilation until each is rewritten. Accept that; fix per-task.)

- [ ] **Step 3: Rewrite `updateTransaction`**

Replace the existing method body (keep the signature + argument validation block; strip the Firestore-specific sections):

```typescript
async updateTransaction(args: {
  transaction_id: string;
  category_id?: string;
  note?: string;
  tag_ids?: string[];
  excluded?: boolean;
  name?: string;
  internal_transfer?: boolean;
  goal_id?: string | null;
}): Promise<{
  success: true;
  transaction_id: string;
  updated: string[];
}> {
  const client = this.getGraphQLClient();
  const { transaction_id } = args;

  // Reject unknown fields
  const allowedKeys = new Set([
    'transaction_id',
    'category_id',
    'note',
    'tag_ids',
    'excluded',
    'name',
    'internal_transfer',
    'goal_id',
  ]);
  for (const key of Object.keys(args)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`update_transaction: unknown field "${key}"`);
    }
  }

  // Require at least one mutable field
  const mutableKeys = Object.keys(args).filter(
    (k) => k !== 'transaction_id' && (args as Record<string, unknown>)[k] !== undefined
  );
  if (mutableKeys.length === 0) {
    throw new Error('update_transaction requires at least one field to update');
  }

  // Resolve the transaction to get accountId + itemId (needed by EditTransaction API).
  const txn = await this.db.getTransactionById(transaction_id);
  if (!txn) throw new Error(`Transaction not found: ${transaction_id}`);

  // Per-field validation (preserves current referential-integrity checks).
  if ('category_id' in args && args.category_id !== undefined) {
    const categories = await this.db.getUserCategories();
    if (!categories.find((c) => c.category_id === args.category_id)) {
      throw new Error(`Category not found: ${args.category_id}`);
    }
  }
  if ('tag_ids' in args && args.tag_ids !== undefined && args.tag_ids.length > 0) {
    const tags = await this.db.getTags();
    for (const tagId of args.tag_ids) {
      if (!tags.find((t) => t.tag_id === tagId)) {
        throw new Error(`Tag not found: ${tagId}`);
      }
    }
  }
  // Note: goal_id referential-integrity check retained, though no goal-write path exists here.
  if ('goal_id' in args && args.goal_id !== null && args.goal_id !== undefined) {
    const goals = await this.db.getGoals();
    if (!goals.find((g) => g.goal_id === args.goal_id)) {
      throw new Error(`Goal not found: ${args.goal_id}`);
    }
  }

  // Map MCP fields → EditTransaction input shape
  const input: {
    categoryId?: string;
    userNotes?: string | null;
    tagIds?: string[];
    isReviewed?: boolean;
    // Note: excluded / internal_transfer / name / goal_id are NOT supported by EditTransaction.
    // If present, throw — these are cases we cannot satisfy on GraphQL.
  } = {};
  if ('category_id' in args && args.category_id !== undefined) input.categoryId = args.category_id;
  if ('note' in args && args.note !== undefined) input.userNotes = args.note;
  if ('tag_ids' in args && args.tag_ids !== undefined) input.tagIds = args.tag_ids;

  const unsupported: string[] = [];
  if ('excluded' in args && args.excluded !== undefined) unsupported.push('excluded');
  if ('name' in args && args.name !== undefined) unsupported.push('name');
  if ('internal_transfer' in args && args.internal_transfer !== undefined)
    unsupported.push('internal_transfer');
  if ('goal_id' in args && args.goal_id !== undefined) unsupported.push('goal_id');
  if (unsupported.length > 0) {
    throw new Error(
      `update_transaction: fields not supported via GraphQL: ${unsupported.join(', ')}. ` +
        `Only category_id, note, and tag_ids are writable through this tool.`
    );
  }

  try {
    const { editTransaction } = await import('../core/graphql/transactions.js');
    const result = await editTransaction(client, {
      id: transaction_id,
      accountId: txn.account_id,
      itemId: txn.item_id,
      input,
    });
    return {
      success: true,
      transaction_id: result.id,
      updated: Object.keys(result.changed),
    };
  } catch (e) {
    const { GraphQLError } = await import('../core/graphql/client.js');
    if (e instanceof GraphQLError) {
      throw new Error(graphQLErrorToMcpError(e));
    }
    throw e;
  }
}
```

*Note on the dynamic `import`:* the per-domain modules are loaded lazily to keep `tools.ts` compilable even if a particular graphql file hasn't landed yet. Static imports are equally fine; swap to static once all task modules are in place.

*Important:* this removes the local DB cache patching (`patchCachedTransaction`). The design spec states local cache is refreshed by Copilot's sync, not patched after writes. If `getTransactionById(transaction_id)` does not exist on `CopilotDatabase`, grep for an existing lookup helper (e.g., `getAllTransactions`, `resolveTransaction`) and use the closest-matching one. If no single-transaction lookup exists, you may use `(await db.getAllTransactions()).find(...)` as a fallback.

- [ ] **Step 4: Rewrite `reviewTransactions`**

Replace with sequential `editTransaction` calls:

```typescript
async reviewTransactions(args: { transaction_ids: string[]; reviewed?: boolean }): Promise<{
  success: boolean;
  reviewed_count: number;
  transaction_ids: string[];
}> {
  const client = this.getGraphQLClient();
  const { transaction_ids, reviewed = true } = args;

  if (!Array.isArray(transaction_ids) || transaction_ids.length === 0) {
    throw new Error('transaction_ids must be a non-empty array');
  }

  const allTransactions = await this.db.getAllTransactions();
  const txnMap = new Map(allTransactions.map((t) => [t.transaction_id, t]));

  // Validate ALL ids exist before firing any writes (atomic precondition check).
  const missing = transaction_ids.filter((id) => !txnMap.has(id));
  if (missing.length > 0) {
    throw new Error(`Transactions not found: ${missing.join(', ')}`);
  }

  const { editTransaction } = await import('../core/graphql/transactions.js');
  const { GraphQLError } = await import('../core/graphql/client.js');

  let reviewed_count = 0;
  for (const id of transaction_ids) {
    const txn = txnMap.get(id)!;
    try {
      await editTransaction(client, {
        id,
        accountId: txn.account_id,
        itemId: txn.item_id,
        input: { isReviewed: reviewed },
      });
      reviewed_count++;
    } catch (e) {
      if (e instanceof GraphQLError) {
        throw new Error(
          `review_transactions failed at id=${id} (${reviewed_count}/${transaction_ids.length} succeeded): ${graphQLErrorToMcpError(e)}`
        );
      }
      throw e;
    }
  }

  return { success: true, reviewed_count, transaction_ids };
}
```

- [ ] **Step 5: Delete the Firestore-specific `resolveTransaction` helper**

If `resolveTransaction` is no longer called by any method (search with `grep -n resolveTransaction src/tools/tools.ts`), delete it. If still used by not-yet-migrated write methods, leave it and delete in Task 15.

- [ ] **Step 6: Run full test suite — expect many failures**

```bash
bun test
```

Expected: the tools.ts methods for categories/tags/recurrings/budgets still use `getFirestoreClient()` which is now deleted → compile/runtime failures. Tests in `tests/tools/*` that cover `updateTransaction`/`reviewTransactions` may also fail because they stub `FirestoreClient`.

**For this task: only** verify `tests/core/graphql/` tests still pass (they should) and that `updateTransaction` + `reviewTransactions` methods at least compile. Broader test green-up happens in Task 17.

```bash
bun test tests/core/graphql/
bun run typecheck 2>&1 | head -40
```

Typecheck errors are acceptable during tasks 11–14 as long as they're all from `tools.ts` methods we haven't migrated yet.

- [ ] **Step 7: Commit**

```bash
git add src/tools/tools.ts
git commit --no-verify -m "refactor(tools): migrate update_transaction + review_transactions to GraphQL

WIP — other write methods still reference the removed Firestore client.
Tests will be green again after Tasks 12–14 + Task 17 (test stubs)."
```

`--no-verify` is OK here per CLAUDE.md (TDD red-state commit in a migration). Pre-push hooks must still pass before the PR.

---

## Task 12: Rewrite `tools.ts` — category, tag, and recurring write methods

Replace Firestore writes with per-domain GraphQL calls.

**Files:**
- Modify: `src/tools/tools.ts` (methods: `createCategory`, `updateCategory`, `deleteCategory`, `createTag`, `updateTag`, `deleteTag`, `createRecurring`, `updateRecurring`, `deleteRecurring`, `setRecurringState`)

- [ ] **Step 1: Rewrite `createCategory` / `updateCategory` / `deleteCategory`**

Replace the three existing methods with GraphQL-backed versions:

```typescript
async createCategory(args: {
  name: string;
  color_name: string;
  emoji: string;
  is_excluded?: boolean;
  parent_id?: string;
}): Promise<{ success: true; category_id: string; name: string; color_name: string }> {
  const client = this.getGraphQLClient();
  if (!args.name?.trim()) throw new Error('Category name must not be empty');
  if (!args.color_name?.trim()) throw new Error('color_name is required');
  if (!args.emoji?.trim()) throw new Error('emoji is required');

  try {
    const { createCategory } = await import('../core/graphql/categories.js');
    const result = await createCategory(client, {
      input: {
        name: args.name.trim(),
        colorName: args.color_name,
        emoji: args.emoji,
        isExcluded: args.is_excluded ?? false,
        parentId: args.parent_id,
      },
    });
    return {
      success: true,
      category_id: result.id,
      name: result.name,
      color_name: result.colorName,
    };
  } catch (e) {
    const { GraphQLError } = await import('../core/graphql/client.js');
    if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e));
    throw e;
  }
}

async updateCategory(args: {
  category_id: string;
  name?: string;
  color_name?: string;
  emoji?: string;
  is_excluded?: boolean;
  parent_id?: string | null;
}): Promise<{ success: true; category_id: string; updated: string[] }> {
  const client = this.getGraphQLClient();
  const { category_id, ...rest } = args;
  const input: Record<string, unknown> = {};
  if ('name' in rest && rest.name !== undefined) input.name = rest.name;
  if ('color_name' in rest && rest.color_name !== undefined) input.colorName = rest.color_name;
  if ('emoji' in rest && rest.emoji !== undefined) input.emoji = rest.emoji;
  if ('is_excluded' in rest && rest.is_excluded !== undefined) input.isExcluded = rest.is_excluded;
  if ('parent_id' in rest && rest.parent_id !== undefined) input.parentId = rest.parent_id;
  if (Object.keys(input).length === 0) {
    throw new Error('update_category requires at least one field to update');
  }

  try {
    const { editCategory } = await import('../core/graphql/categories.js');
    const result = await editCategory(client, { id: category_id, input });
    return { success: true, category_id: result.id, updated: Object.keys(result.changed) };
  } catch (e) {
    const { GraphQLError } = await import('../core/graphql/client.js');
    if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e));
    throw e;
  }
}

async deleteCategory(args: { category_id: string }): Promise<{
  success: true;
  category_id: string;
  deleted: true;
}> {
  const client = this.getGraphQLClient();
  try {
    const { deleteCategory } = await import('../core/graphql/categories.js');
    const result = await deleteCategory(client, { id: args.category_id });
    return { success: true, category_id: result.id, deleted: true };
  } catch (e) {
    const { GraphQLError } = await import('../core/graphql/client.js');
    if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e));
    throw e;
  }
}
```

- [ ] **Step 2: Rewrite `createTag` / `updateTag` / `deleteTag`**

```typescript
async createTag(args: {
  name: string;
  color_name?: string;
  hex_color?: string;
}): Promise<{ success: true; tag_id: string; name: string; color_name: string }> {
  const client = this.getGraphQLClient();
  if (!args.name?.trim()) throw new Error('Tag name must not be empty');
  const colorName = args.color_name ?? 'PURPLE2'; // default; matches captured CreateTag example

  try {
    const { createTag } = await import('../core/graphql/tags.js');
    const result = await createTag(client, {
      input: { name: args.name.trim(), colorName },
    });
    return {
      success: true,
      tag_id: result.id,
      name: result.name,
      color_name: result.colorName,
    };
  } catch (e) {
    const { GraphQLError } = await import('../core/graphql/client.js');
    if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e));
    throw e;
  }
}

async updateTag(args: {
  tag_id: string;
  name?: string;
  color_name?: string;
}): Promise<{ success: true; tag_id: string; updated: string[] }> {
  const client = this.getGraphQLClient();
  const input: Record<string, unknown> = {};
  if (args.name !== undefined) input.name = args.name;
  if (args.color_name !== undefined) input.colorName = args.color_name;
  if (Object.keys(input).length === 0) {
    throw new Error('update_tag requires at least one field to update');
  }

  try {
    const { editTag } = await import('../core/graphql/tags.js');
    const result = await editTag(client, { id: args.tag_id, input });
    return { success: true, tag_id: result.id, updated: Object.keys(result.changed) };
  } catch (e) {
    const { GraphQLError } = await import('../core/graphql/client.js');
    if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e));
    throw e;
  }
}

async deleteTag(args: { tag_id: string }): Promise<{
  success: true;
  tag_id: string;
  deleted: true;
}> {
  const client = this.getGraphQLClient();
  try {
    const { deleteTag } = await import('../core/graphql/tags.js');
    const result = await deleteTag(client, { id: args.tag_id });
    return { success: true, tag_id: result.id, deleted: true };
  } catch (e) {
    const { GraphQLError } = await import('../core/graphql/client.js');
    if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e));
    throw e;
  }
}
```

- [ ] **Step 3: Rewrite `createRecurring` with new signature**

The new signature takes `transaction_id` + `frequency` and derives `account_id` + `item_id` from the local DB:

```typescript
async createRecurring(args: {
  transaction_id: string;
  frequency: string;
}): Promise<{ success: true; recurring_id: string; name: string; state: string; frequency: string }> {
  const client = this.getGraphQLClient();
  const VALID_FREQUENCIES = ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'YEARLY'];
  if (!VALID_FREQUENCIES.includes(args.frequency)) {
    throw new Error(
      `frequency must be one of: ${VALID_FREQUENCIES.join(', ')}. Got: ${args.frequency}`
    );
  }

  const all = await this.db.getAllTransactions();
  const txn = all.find((t) => t.transaction_id === args.transaction_id);
  if (!txn) throw new Error(`Transaction not found: ${args.transaction_id}`);

  try {
    const { createRecurring } = await import('../core/graphql/recurrings.js');
    const result = await createRecurring(client, {
      input: {
        frequency: args.frequency,
        transaction: {
          accountId: txn.account_id,
          itemId: txn.item_id,
          transactionId: args.transaction_id,
        },
      },
    });
    return {
      success: true,
      recurring_id: result.id,
      name: result.name,
      state: result.state,
      frequency: result.frequency,
    };
  } catch (e) {
    const { GraphQLError } = await import('../core/graphql/client.js');
    if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e));
    throw e;
  }
}
```

- [ ] **Step 4: Rewrite `updateRecurring` / `deleteRecurring` / `setRecurringState`**

```typescript
async updateRecurring(args: {
  recurring_id: string;
  rule?: {
    name_contains?: string;
    min_amount?: string;
    max_amount?: string;
    days?: number[];
  };
  state?: string;
}): Promise<{ success: true; recurring_id: string; updated: string[] }> {
  const client = this.getGraphQLClient();
  const input: Record<string, unknown> = {};
  if (args.state !== undefined) input.state = args.state;
  if (args.rule !== undefined) {
    const rule: Record<string, unknown> = {};
    if (args.rule.name_contains !== undefined) rule.nameContains = args.rule.name_contains;
    if (args.rule.min_amount !== undefined) rule.minAmount = args.rule.min_amount;
    if (args.rule.max_amount !== undefined) rule.maxAmount = args.rule.max_amount;
    if (args.rule.days !== undefined) rule.days = args.rule.days;
    input.rule = rule;
  }
  if (Object.keys(input).length === 0) {
    throw new Error('update_recurring requires at least one field to update');
  }

  try {
    const { editRecurring } = await import('../core/graphql/recurrings.js');
    const result = await editRecurring(client, { id: args.recurring_id, input });
    return { success: true, recurring_id: result.id, updated: Object.keys(result.changed) };
  } catch (e) {
    const { GraphQLError } = await import('../core/graphql/client.js');
    if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e));
    throw e;
  }
}

async setRecurringState(args: {
  recurring_id: string;
  state: string;
}): Promise<{ success: true; recurring_id: string; state: string }> {
  const client = this.getGraphQLClient();
  const VALID_STATES = ['ACTIVE', 'PAUSED', 'ARCHIVED'];
  if (!VALID_STATES.includes(args.state)) {
    throw new Error(`state must be one of: ${VALID_STATES.join(', ')}. Got: ${args.state}`);
  }

  try {
    const { editRecurring } = await import('../core/graphql/recurrings.js');
    const result = await editRecurring(client, {
      id: args.recurring_id,
      input: { state: args.state },
    });
    return { success: true, recurring_id: result.id, state: args.state };
  } catch (e) {
    const { GraphQLError } = await import('../core/graphql/client.js');
    if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e));
    throw e;
  }
}

async deleteRecurring(args: { recurring_id: string }): Promise<{
  success: true;
  recurring_id: string;
  deleted: true;
}> {
  const client = this.getGraphQLClient();
  try {
    const { deleteRecurring } = await import('../core/graphql/recurrings.js');
    const result = await deleteRecurring(client, { id: args.recurring_id });
    return { success: true, recurring_id: result.id, deleted: true };
  } catch (e) {
    const { GraphQLError } = await import('../core/graphql/client.js');
    if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e));
    throw e;
  }
}
```

- [ ] **Step 5: Run per-domain tests**

```bash
bun test tests/core/graphql/
```

Expected: all pass (no tools.ts dependency).

- [ ] **Step 6: Commit**

```bash
git add src/tools/tools.ts
git commit --no-verify -m "refactor(tools): migrate category/tag/recurring writes to GraphQL"
```

---

## Task 13: Collapse three budget tools into `set_budget`

Replace `createBudget` / `updateBudget` / `deleteBudget` methods with a single `setBudget`.

**Files:**
- Modify: `src/tools/tools.ts`

- [ ] **Step 1: Remove the three old methods**

Search-and-delete: `async createBudget(`, `async updateBudget(`, `async deleteBudget(`. Delete each method body and its surrounding JSDoc.

- [ ] **Step 2: Add the new `setBudget` method**

```typescript
async setBudget(args: {
  category_id: string;
  amount: string;
  month?: string;
}): Promise<{
  success: true;
  category_id: string;
  amount: string;
  month?: string;
  cleared: boolean;
}> {
  const client = this.getGraphQLClient();
  if (!args.category_id?.trim()) throw new Error('category_id is required');
  if (typeof args.amount !== 'string') throw new Error('amount must be a string (e.g. "250.00")');
  if (args.month !== undefined && !/^\d{4}-\d{2}$/.test(args.month)) {
    throw new Error('month must be "YYYY-MM"');
  }

  try {
    const { setBudget } = await import('../core/graphql/budgets.js');
    const result = await setBudget(client, {
      categoryId: args.category_id,
      amount: args.amount,
      month: args.month,
    });
    return {
      success: true,
      category_id: result.categoryId,
      amount: result.amount,
      ...(result.month ? { month: result.month } : {}),
      cleared: result.cleared,
    };
  } catch (e) {
    const { GraphQLError } = await import('../core/graphql/client.js');
    if (e instanceof GraphQLError) throw new Error(graphQLErrorToMcpError(e));
    throw e;
  }
}
```

- [ ] **Step 3: Update tool schemas in `createWriteToolSchemas()`**

Find the three budget schemas (`create_budget`, `update_budget`, `delete_budget`) around lines 5002-5075. Delete them. Add `set_budget`:

```typescript
{
  name: 'set_budget',
  description:
    'Set the monthly budget amount for a category. amount="0" clears the budget. Pass month="YYYY-MM" for a single-month override; omit for the all-months default. If this fails with "budgeting is disabled," the caller must enable budgeting in Copilot → Settings → General.',
  readOnlyHint: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      category_id: { type: 'string' as const, description: 'ID of the category to budget.' },
      amount: {
        type: 'string' as const,
        description: 'Decimal amount as a string (e.g. "250.00"). "0" clears the budget.',
      },
      month: {
        type: 'string' as const,
        description:
          'Optional. YYYY-MM for a single-month override. Omit to set the all-months default.',
      },
    },
    required: ['category_id', 'amount'],
    additionalProperties: false,
  },
},
```

- [ ] **Step 4: Delete goal tool schemas**

Find `create_goal`, `update_goal`, `delete_goal` in `createWriteToolSchemas()` and delete them. Delete their implementations (`async createGoal`, `async updateGoal`, `async deleteGoal`) from the class body.

- [ ] **Step 5: Commit**

```bash
git add src/tools/tools.ts
git commit --no-verify -m "refactor(tools): collapse 3 budget tools into set_budget; remove goal tools"
```

---

## Task 14: Wire `GraphQLClient` into `server.ts`; update WRITE_TOOLS set

Replace Firestore injection with GraphQL client injection. Update the gated write-tool set.

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Swap imports and construction**

In `src/server.ts`, replace:

```typescript
import { FirestoreClient } from './core/firestore-client.js';
```

with:

```typescript
import { GraphQLClient } from './core/graphql/client.js';
```

In the constructor, replace:

```typescript
let firestoreClient: FirestoreClient | undefined;
if (writeEnabled) {
  const auth = new FirebaseAuth(() => extractRefreshToken());
  firestoreClient = new FirestoreClient(auth);
}

this.tools = new CopilotMoneyTools(this.db, firestoreClient);
```

with:

```typescript
let graphqlClient: GraphQLClient | undefined;
if (writeEnabled) {
  const auth = new FirebaseAuth(() => extractRefreshToken());
  graphqlClient = new GraphQLClient(auth);
}

this.tools = new CopilotMoneyTools(this.db, graphqlClient);
```

- [ ] **Step 2: Update the `WRITE_TOOLS` set**

Find the `WRITE_TOOLS` Set in `src/server.ts`. Remove entries: `create_budget`, `update_budget`, `delete_budget`, `create_goal`, `update_goal`, `delete_goal`. Add: `set_budget`. Other entries stay.

Final set (13 tools):
```typescript
const WRITE_TOOLS = new Set<string>([
  'update_transaction',
  'review_transactions',
  'create_tag',
  'update_tag',
  'delete_tag',
  'create_category',
  'update_category',
  'delete_category',
  'set_budget',
  'set_recurring_state',
  'create_recurring',
  'update_recurring',
  'delete_recurring',
]);
```

- [ ] **Step 3: Update the tool handler dispatch switch**

Find the `CallToolRequestSchema` handler. Remove cases for removed tools (`create_budget`, `update_budget`, `delete_budget`, `create_goal`, `update_goal`, `delete_goal`). Add a case for `set_budget`:

```typescript
case 'set_budget':
  return this.wrapResult(await this.tools.setBudget(args as any));
```

(Use the same `wrapResult` pattern already present in the file; grep for an existing write-tool case to copy the exact shape.)

- [ ] **Step 4: Typecheck**

```bash
bun run typecheck
```

Expected: clean (or only errors from things we'll fix in later tasks — note which). If errors remain in `tools.ts`, look for stragglers: references to `firestoreClient`, `getFirestoreClient`, `resolveTransaction` (now unused), `patchCachedTransaction` (Firestore-era cache patcher).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit --no-verify -m "feat(server): inject GraphQLClient; update WRITE_TOOLS set for set_budget and removed tools"
```

---

## Task 15: Remove remaining Firestore-era code from `tools.ts`

Strip imports, helpers, and types that are no longer needed.

**Files:**
- Modify: `src/tools/tools.ts`

- [ ] **Step 1: Delete Firestore-related imports**

Open `src/tools/tools.ts`. Remove imports like:

```typescript
import { FirestoreClient } from '../core/firestore-client.js';
import { toFirestoreFields, ... } from '../core/format/...';
```

Grep for remaining `firestore`/`firestoreClient`/`toFirestoreFields` references and remove.

- [ ] **Step 2: Remove unused helpers**

Delete (search-and-remove if grep shows zero callers):
- `private getFirestoreClient()` — already deleted in Task 11 but verify.
- `private resolveTransaction()` — used by the old `updateTransaction`.
- `this.db.patchCachedTransaction(...)` call sites — already removed in per-tool rewrites, but verify no stragglers.

```bash
grep -n "firestore\|resolveTransaction\|patchCachedTransaction\|toFirestoreFields" src/tools/tools.ts
```

Expected: zero matches after removal.

- [ ] **Step 3: Run typecheck + per-domain tests**

```bash
bun run typecheck
bun test tests/core/graphql/ tests/tools/errors.test.ts
```

Expected: typecheck clean except for test files still stubbing `FirestoreClient`. Per-domain tests + errors test pass.

- [ ] **Step 4: Commit**

```bash
git add src/tools/tools.ts
git commit --no-verify -m "chore(tools): remove Firestore-era imports and helpers from tools.ts"
```

---

## Task 16: Extract Firestore write knowledge into `docs/reference/firestore-write-schema.md`

Before deleting the Firestore client + format dir, preserve the learned schema.

**Files:**
- Create: `docs/reference/firestore-write-schema.md`
- Delete: `src/core/firestore-client.ts`
- Delete: `src/core/format/` (directory)
- Delete: `tests/core/firestore-client.test.ts`
- Delete: `tests/core/format/` (directory)

- [ ] **Step 1: Write the reference doc**

Create `docs/reference/firestore-write-schema.md`. The content should be extracted from the git history of the now-deleted write code. Use:

```bash
git log --all --oneline -- src/core/firestore-client.ts | head -20
git log --all -p -- src/tools/tools.ts | grep -E "collectionPath|updateMask|FirestoreFields" | head -50
```

Structure:

```markdown
# Firestore Write Schema (Archived Reference)

This document describes how the MCP server's write tools wrote data to Copilot
Money's Firestore backend, from the period when direct Firestore writes worked
(pre-April 2026). The write path was removed when Copilot deployed server-side
type checking on Firestore documents, at which point all direct writes began
to fail. The rewrite uses Copilot's GraphQL API instead; see
`docs/superpowers/specs/2026-04-14-graphql-write-rewrite-design.md`.

This doc exists to preserve the document-shape knowledge that was embedded in
the deleted code.

## Collection paths

- `users/{uid}/transactions/{transactionId}` — all transactions
- `users/{uid}/userCategories/{categoryId}`
- `users/{uid}/userTags/{tagId}`
- `users/{uid}/budgets/{budgetId}`
- `users/{uid}/recurringTransactions/{recurringId}`
- `users/{uid}/goals/{goalId}`

## update_transaction — fields + semantics

Wrote to: `users/{uid}/transactions/{transactionId}`

Fields (with Firestore field names):
- `category_id` (string reference)
- `user_note` (string; "" clears)
- `tag_ids` (array<string>; [] clears)
- `excluded` (boolean)
- `name` (string)
- `internal_transfer` (boolean)
- `goal_id` (string; "" unlinks)

(Repeat the same pattern for each removed write tool. Keep this short — one
block per tool with collection, fields, and any gotchas.)

## Gotchas learned

- Firestore `updateMask.fieldPaths` required for partial updates.
- `goal_id = ""` (empty string) unlinks a goal, not `null`.
- `user_note = ""` clears the note (not `null`).
- Cache patching was done via `patchCachedTransaction` after each successful
  write, falling back to a full cache clear if the patch couldn't be applied
  cleanly.
```

Only fill in the tools + fields we actually had — skim recent `git log -p -- src/tools/tools.ts` output for the authoritative field list per method.

- [ ] **Step 2: Delete Firestore code**

```bash
git rm src/core/firestore-client.ts
git rm -r src/core/format/
git rm tests/core/firestore-client.test.ts
git rm -r tests/core/format/ 2>/dev/null || true
```

- [ ] **Step 3: Verify no remaining references**

```bash
grep -rn "firestore-client\|core/format" src/ tests/
```

Expected: zero matches.

- [ ] **Step 4: Typecheck + per-domain tests**

```bash
bun run typecheck
bun test tests/core/graphql/ tests/tools/errors.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add docs/reference/firestore-write-schema.md
git commit -m "docs: preserve firestore write-schema knowledge + delete dead write code"
```

---

## Task 17: Update tool-level tests

Migrate `tests/tools/*.test.ts` to stub per-domain GraphQL modules instead of `FirestoreClient`.

**Files:**
- Modify: `tests/tools/tools.test.ts`
- Modify: `tests/tools/write-tools.test.ts`
- Modify: `tests/tools/write-tools-phase3.test.ts`
- Modify: `tests/tools/review-transactions-batching.test.ts`

- [ ] **Step 1: Read existing structure**

```bash
grep -l "FirestoreClient\|firestoreClient\|updateDocument" tests/tools/
```

Note each file that needs migration.

- [ ] **Step 2: Build a shared test helper for mocking GraphQLClient**

Create `tests/helpers/mock-graphql.ts`:

```typescript
import { mock } from 'bun:test';
import type { GraphQLClient } from '../../src/core/graphql/client.js';

export function createMockGraphQLClient(
  responsesByOp: Record<string, unknown>
): GraphQLClient {
  const calls: Array<{ op: string; query: string; variables: unknown }> = [];
  const client = {
    mutate: mock((op: string, query: string, variables: unknown) => {
      calls.push({ op, query, variables });
      const response = responsesByOp[op];
      if (response === undefined) {
        return Promise.reject(new Error(`No mock response for operation: ${op}`));
      }
      return Promise.resolve(response);
    }),
    _calls: calls,
  } as unknown as GraphQLClient & { _calls: typeof calls };
  return client;
}
```

- [ ] **Step 3: Migrate `tests/tools/tools.test.ts`**

Replace `FirestoreClient` mocks with `createMockGraphQLClient` from the helper. For each write-tool test:
- Change the client constructor mock shape.
- Change assertions from `expect(fetchCalls[0].options.body).toContain(...)` to `expect((client as any)._calls[0].op).toBe('EditTransaction')` (or similar).
- Change response mocks to match GraphQL response shape (`{ editTransaction: { transaction: {...} } }` instead of Firestore document fields).

This is mechanical. For each failing test, open it, identify what write tool it's testing, look up that tool's new per-domain call signature, and update both the stub response and the assertions accordingly.

- [ ] **Step 4: Delete goal-tool tests**

Search for `create_goal`, `update_goal`, `delete_goal`, `createGoal`, `updateGoal`, `deleteGoal` in test files. Delete those test cases entirely.

- [ ] **Step 5: Collapse budget tests into `set_budget`**

Find tests named after `create_budget`, `update_budget`, `delete_budget`. Delete their tests and add new `set_budget` tests covering: amount>0 no-month, amount=0 clears, month="YYYY-MM" uses EditBudgetMonthly.

Example replacement for a budget test:

```typescript
test('set_budget dispatches EditBudget when month absent', async () => {
  const client = createMockGraphQLClient({ EditBudget: { editCategoryBudget: true } });
  const tools = new CopilotMoneyTools(db, client);
  const out = await tools.setBudget({ category_id: 'cat-1', amount: '250' });
  expect(out.success).toBe(true);
  expect(out.cleared).toBe(false);
  expect(((client as any)._calls[0] as any).op).toBe('EditBudget');
});
```

- [ ] **Step 6: Run full test suite**

```bash
bun test
```

Expected: all tests green.

- [ ] **Step 7: Lint + format + typecheck**

```bash
bun run lint
bun run format:check
bun run typecheck
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add tests/
git commit -m "test(tools): migrate tool tests off FirestoreClient onto GraphQL stubs"
```

---

## Task 18: Regenerate manifest.json

`manifest.json` reflects the MCP tool set. Must match the new tool surface (13 write + 17 read).

**Files:**
- Modify: `manifest.json`

- [ ] **Step 1: Run sync-manifest**

```bash
bun run sync-manifest
```

Expected output mentions the new tool count. `manifest.json` is updated.

- [ ] **Step 2: Verify the manifest**

```bash
grep '"name"' manifest.json | wc -l
```

Expected: 30 (17 read + 13 write).

Spot-check: no `create_goal`, `create_budget` entries. `set_budget` present.

- [ ] **Step 3: Commit**

```bash
git add manifest.json
git commit -m "chore: sync manifest with new write-tool surface"
```

---

## Task 19: Smoke test script `scripts/smoke-graphql.ts`

Opt-in E2E runner against the developer's real Copilot account. Not CI.

**Files:**
- Create: `scripts/smoke-graphql.ts`

- [ ] **Step 1: Scaffold the script**

```typescript
/**
 * E2E smoke test for GraphQL writes. Opt-in: run manually against your real
 * Copilot account. Not part of CI.
 *
 * Usage:
 *   bun run scripts/smoke-graphql.ts [--skip-destructive]
 *
 * Creates and deletes GQL-TEST-* entities. If cleanup fails, the script
 * prints explicit manual-cleanup instructions.
 */

import { GraphQLClient } from '../src/core/graphql/client.js';
import { FirebaseAuth } from '../src/core/auth/firebase-auth.js';
import { extractRefreshToken } from '../src/core/auth/browser-token.js';
import { CopilotDatabase } from '../src/core/database.js';

import { createTag, editTag, deleteTag } from '../src/core/graphql/tags.js';
import {
  createCategory,
  editCategory,
  deleteCategory,
} from '../src/core/graphql/categories.js';
import { editTransaction } from '../src/core/graphql/transactions.js';
import {
  createRecurring,
  deleteRecurring,
} from '../src/core/graphql/recurrings.js';
import { setBudget } from '../src/core/graphql/budgets.js';
import { editAccount } from '../src/core/graphql/accounts.js';

const skipDestructive = process.argv.includes('--skip-destructive');

type StepResult = { name: string; ok: boolean; detail?: string };
const results: StepResult[] = [];

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, detail });
    console.error(`✗ ${name}: ${detail}`);
  }
}

async function main(): Promise<void> {
  const auth = new FirebaseAuth(() => extractRefreshToken());
  const client = new GraphQLClient(auth);
  const db = new CopilotDatabase();

  if (!skipDestructive) {
    await step('Tags create/edit/delete', async () => {
      const created = await createTag(client, {
        input: { name: 'GQL-TEST-TAG', colorName: 'PURPLE2' },
      });
      try {
        await editTag(client, { id: created.id, input: { name: 'GQL-TEST-TAG-2' } });
      } finally {
        await deleteTag(client, { id: created.id });
      }
    });

    await step('Categories create/edit/delete', async () => {
      const created = await createCategory(client, {
        input: {
          name: 'GQL-TEST-CAT',
          colorName: 'OLIVE1',
          emoji: '🧪',
          isExcluded: false,
        },
      });
      try {
        await editCategory(client, { id: created.id, input: { colorName: 'RED1' } });
      } finally {
        await deleteCategory(client, { id: created.id });
      }
    });

    await step('Recurrings create/delete', async () => {
      const allTxns = await db.getAllTransactions();
      const candidate = allTxns.find((t) => !t.recurring_id);
      if (!candidate) throw new Error('No transaction without a recurring found');
      const created = await createRecurring(client, {
        input: {
          frequency: 'MONTHLY',
          transaction: {
            accountId: candidate.account_id,
            itemId: candidate.item_id,
            transactionId: candidate.transaction_id,
          },
        },
      });
      await deleteRecurring(client, { id: created.id });
    });
  }

  await step('Transaction userNotes round-trip', async () => {
    const allTxns = await db.getAllTransactions();
    const t = allTxns[0];
    if (!t) throw new Error('No transactions in local DB');
    const original = t.user_note ?? null;
    await editTransaction(client, {
      id: t.transaction_id,
      accountId: t.account_id,
      itemId: t.item_id,
      input: { userNotes: 'GQL-TEST-NOTE' },
    });
    await editTransaction(client, {
      id: t.transaction_id,
      accountId: t.account_id,
      itemId: t.item_id,
      input: { userNotes: original },
    });
  });

  await step('Budget set + clear (all-months)', async () => {
    const categories = await db.getUserCategories();
    const c = categories[0];
    if (!c) throw new Error('No user categories');
    await setBudget(client, { categoryId: c.category_id, amount: '1' });
    await setBudget(client, { categoryId: c.category_id, amount: '0' });
  });

  await step('Budget set + clear (single month)', async () => {
    const categories = await db.getUserCategories();
    const c = categories[0];
    if (!c) throw new Error('No user categories');
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await setBudget(client, { categoryId: c.category_id, amount: '1', month });
    await setBudget(client, { categoryId: c.category_id, amount: '0', month });
  });

  await step('Account rename round-trip', async () => {
    const accts = await db.getAccounts();
    const a = accts[0];
    if (!a) throw new Error('No accounts');
    const originalName = a.name;
    await editAccount(client, {
      id: a.account_id,
      itemId: a.item_id,
      input: { name: 'GQL-TEST-ACCT' },
    });
    await editAccount(client, {
      id: a.account_id,
      itemId: a.item_id,
      input: { name: originalName },
    });
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  if (failed.length > 0) {
    console.error('\nFailed steps:');
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
    console.error(
      '\nIf any step created a GQL-TEST-* entity and failed before cleanup, ' +
        'check your Copilot account and remove the stragglers manually.'
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Smoke script crashed:', e);
  process.exit(1);
});
```

*Note:* field names in the local DB cache (`account_id`, `item_id`, `transaction_id`) may differ slightly. Open `src/models/transaction.ts` and `src/models/account.ts` to confirm property names before committing; adjust the script accordingly.

- [ ] **Step 2: Run the smoke script against your account**

```bash
bun run scripts/smoke-graphql.ts
```

Expected: all 7 steps pass. If the server returns specific error messages for budgets-disabled / rollovers-disabled cases, capture those messages and add a follow-up task to the plan to update `USER_ACTION_REQUIRED` handling.

If the `create_recurring` step fails due to "Transaction already linked to a recurring" (or similar), adjust the candidate-selection logic in the script until a clean transaction is found.

- [ ] **Step 3: Capture + record any surprises**

If the real server's error shape differs from the spec's assumptions, open a follow-up issue. Do not block merging on perfect error messaging — the spec explicitly says "first pass ships raw server messages."

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-graphql.ts
git commit -m "test(e2e): opt-in GraphQL smoke script"
```

---

## Task 20: Final integration green run + docs + PR

Full suite green, manifest synced, docs fresh.

**Files:**
- No new files; verify full suite.

- [ ] **Step 1: Run everything**

```bash
bun run check
```

Expected: typecheck + lint + format:check + all tests pass. No skipped tests.

- [ ] **Step 2: Verify manifest matches tools.ts**

```bash
bun run sync-manifest
git diff manifest.json
```

Expected: no diff (already synced in Task 18).

- [ ] **Step 3: Rebase from origin/main**

```bash
git fetch origin main
git log HEAD..origin/main --oneline
```

If commits exist, rebase:

```bash
git rebase origin/main
```

Resolve any conflicts. Re-run `bun run check`.

- [ ] **Step 4: Push branch**

```bash
git push -u origin worktree-virtual-soaring-rocket
```

- [ ] **Step 5: Open PR**

```bash
gh pr create --title "Rewrite MCP write tools onto Copilot GraphQL API" --body "$(cat <<'EOF'
## Summary

- Replaces the 13 in-scope MCP write tools' direct-Firestore backend with Copilot's official GraphQL API (broken since Copilot's server-side type-check deploy).
- Adds a per-domain GraphQL module layout (`src/core/graphql/{transactions,categories,tags,recurrings,budgets,accounts}.ts`) behind a typed `GraphQLClient` transport with a discriminated `GraphQLError` model.
- Removes goal write tools (mobile-only) and collapses three budget tools into `set_budget`.
- Preserves pre-deletion Firestore write-schema knowledge in `docs/reference/firestore-write-schema.md`.

Design: `docs/superpowers/specs/2026-04-14-graphql-write-rewrite-design.md`
Plan:   `docs/superpowers/plans/2026-04-14-graphql-write-rewrite.md`

## Test plan

- [ ] `bun run check` green
- [ ] `bun run scripts/smoke-graphql.ts` green on personal account (run separately from CI)
- [ ] `manifest.json` matches `createWriteToolSchemas()` (verified via `bun run sync-manifest`)
- [ ] Breaking changes documented: `create_recurring` new signature, `set_budget` consolidation, goal tools removed

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Wait for review + CI**

Per CLAUDE.md: wait for CI and review comments (~2-5 min) and address them before declaring done.

---

## Self-review (done while writing)

Spec coverage: every numbered `# Task` maps to one or more spec sections:
- Prereqs → "Prerequisites (before implementation)" in spec
- Tasks 1-2 → Operations generator + `__typename` transform (Architecture, Components)
- Task 3 → `GraphQLClient` contract + Error model (Components, Error model)
- Tasks 4-9 → Per-domain functions (Architecture, Components)
- Task 10 → Tool-level error wrapping (Error model § Tool-level wrapping)
- Tasks 11-13 → Tool method rewrites + breaking changes (Scope, Breaking changes)
- Task 14 → Server wiring (File layout, Scope)
- Task 15 → Dead-code removal
- Task 16 → Knowledge preservation + Firestore deletion (Knowledge preservation, Deleted files)
- Task 17 → Test migration (Testing § unit tests)
- Task 18 → manifest sync (standard project hygiene)
- Task 19 → E2E smoke script (Testing § E2E)
- Task 20 → CI + PR (Rollout)

No `TBD`, `TODO`, or placeholder markers remain. Code blocks present for every code step. Type names are consistent across tasks: `GraphQLClient`, `GraphQLError`, `GraphQLErrorCode`, per-domain function signatures use the same `{id, changed}` / `{id, deleted: true}` response shapes.
