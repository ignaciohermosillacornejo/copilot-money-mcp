# GraphQL Live Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1 of migrating `copilot-money-mcp` read tools off LevelDB onto Copilot's GraphQL API. Ship a new `--live-reads` CLI flag that swaps the cache-backed `get_transactions` for a GraphQL-backed `get_transactions_live`, and establish the `LiveCopilotDatabase` abstraction + `src/tools/live/` directory that later phases extend.

**Architecture:** New `LiveCopilotDatabase` class wraps the existing `GraphQLClient` and owns memoization, retry, and instrumentation. A new `LiveTransactionsTools` class in `src/tools/live/` exposes `get_transactions_live` with a strict-subset input schema. Server wiring picks cache-backed or live-backed tool based on the flag; auth preflight at boot refuses to register dead tools. Errors surface as `isError: true` tool results, never silent fallback.

**Tech Stack:** TypeScript strict, Bun test runner, Zod for schema validation, MCP SDK (`@modelcontextprotocol/sdk`). No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-23-graphql-live-reads-design.md`

---

## File Structure

**New files:**
- `src/core/graphql/queries/transactions.ts` — GraphQL query wrapper: `buildTransactionFilter`, `buildTransactionSort`, `paginateTransactions`, `fetchTransactionsPage`.
- `src/core/live-database.ts` — `LiveCopilotDatabase` class (memo, retry, verbose logging, `getTransactions`) + `preflightLiveAuth` function.
- `src/tools/live/transactions.ts` — `LiveTransactionsTools` class + `createLiveToolSchemas()`.
- `docs/graphql-live-reads.md` — operator-facing reference.
- `tests/core/graphql/queries/transactions.test.ts` — filter/sort/pagination unit tests.
- `tests/core/live-database.test.ts` — class-level unit tests (memo, retry, preflight).
- `tests/tools/live/transactions.test.ts` — tool-level unit tests (validation, translation, enrichment, error surfaces).
- `tests/integration/live-reads.test.ts` — end-to-end test with mock GraphQL transport.

**Modified files:**
- `src/core/graphql/operations.generated.ts` — append `TRANSACTIONS` query string constant.
- `src/cli.ts` — add `--live-reads` flag parsing and propagation.
- `src/server.ts` — accept `liveReadsEnabled` param, conditional LiveTransactionsTools construction, preflight integration, tool-list composition.
- `docs/graphql-capture/operations/queries/Transactions.md` — document real TransactionFilter/TransactionSort shapes.

---

## Task 1: Add Transactions query constant and ReadTransactionType

**Files:**
- Modify: `src/core/graphql/operations.generated.ts` (append constant at end, before existing trailing content)
- Test: `tests/core/graphql/queries/transactions.test.ts` (create new file with smoke test)

**Context:** The existing mutation file in this module is auto-generated but we append the query constant manually because the read-side generator doesn't exist yet. `TRANSACTIONS` is the GraphQL query string targeting the `transactions` root field (not `transactionsFeed` — we picked `transactions` for the cleaner return shape per the spec). The query selects exactly the fields needed for schema parity with the cache-backed tool output, extended with `parentId` and `isoCurrencyCode`.

- [ ] **Step 1: Write the failing smoke test**

Create `tests/core/graphql/queries/transactions.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { TRANSACTIONS } from '../../../../src/core/graphql/operations.generated.js';

describe('TRANSACTIONS query constant', () => {
  test('is non-empty and targets transactions root field', () => {
    expect(TRANSACTIONS).toContain('query Transactions');
    expect(TRANSACTIONS).toContain('transactions(');
    expect(TRANSACTIONS).toContain('$filter: TransactionFilter');
    expect(TRANSACTIONS).toContain('$sort: [TransactionSort!]');
    expect(TRANSACTIONS).toContain('edges');
    expect(TRANSACTIONS).toContain('pageInfo');
    expect(TRANSACTIONS).toContain('endCursor');
    expect(TRANSACTIONS).toContain('hasNextPage');
    // Required selection-set fields
    expect(TRANSACTIONS).toContain('parentId');
    expect(TRANSACTIONS).toContain('isoCurrencyCode');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/graphql/queries/transactions.test.ts`
Expected: FAIL with `TRANSACTIONS is undefined` or import error (constant doesn't exist yet).

- [ ] **Step 3: Add the query constant**

Open `src/core/graphql/operations.generated.ts`. At the bottom of the file (after all existing `export const` lines, preserving the `/* eslint-disable */` comment at the top), append:

```typescript

export const TRANSACTIONS = `query Transactions($first: Int, $after: String, $filter: TransactionFilter, $sort: [TransactionSort!]) {
  transactions(first: $first, after: $after, filter: $filter, sort: $sort) {
    __typename
    edges {
      __typename
      cursor
      node {
        __typename
        id
        accountId
        itemId
        categoryId
        recurringId
        parentId
        isReviewed
        isPending
        amount
        date
        name
        type
        userNotes
        tipAmount
        suggestedCategoryIds
        isoCurrencyCode
        createdAt
        tags { __typename id name colorName }
        goal { __typename id name }
      }
    }
    pageInfo {
      __typename
      endCursor
      hasNextPage
    }
  }
}`;
```

Note the `__typename` additions on every selection set — these are required for Apollo's document-transform equivalent per `docs/graphql-capture/wire-protocol.md`. Our existing mutations follow the same pattern (see `CREATE_TRANSACTION`).

- [ ] **Step 4: Run tests — smoke test passes**

Run: `bun test tests/core/graphql/queries/transactions.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Run full typecheck and test suite**

Run: `bun run check`
Expected: PASS. If format check fails, run `bun run fix` then re-run.

- [ ] **Step 6: Commit**

```bash
git add src/core/graphql/operations.generated.ts tests/core/graphql/queries/transactions.test.ts
git commit -m "feat(graphql): add Transactions query constant for live reads

Adds TRANSACTIONS query string targeting the transactions root field
with the full selection set needed for live-read parity with the
cache-backed get_transactions tool.

Refs: docs/superpowers/specs/2026-04-23-graphql-live-reads-design.md"
```

---

## Task 2: buildTransactionFilter

**Files:**
- Create: `src/core/graphql/queries/transactions.ts`
- Test: `tests/core/graphql/queries/transactions.test.ts` (extend)

**Context:** `buildTransactionFilter` translates a subset of `get_transactions` tool args into the `TransactionFilter` input shape captured from Copilot's web UI on 2026-04-23. The filter shape accepts: `dates: [{from, to}]`, `accountIds: [{accountId, itemId}]`, `categoryIds: [string]`, `recurringIds: [string]`, `tagIds: [string]`, `types: [TransactionType]`, `isReviewed: Boolean`, `matchString: String`. This function stays pure — it takes everything it needs as arguments (including a pre-resolved `accountItemIdMap` since the account→item lookup happens in the tool layer, not here).

- [ ] **Step 1: Define types and write the first failing test**

Append to `tests/core/graphql/queries/transactions.test.ts`:

```typescript
import {
  buildTransactionFilter,
  type BuildFilterOptions,
  type TransactionFilterInput,
} from '../../../../src/core/graphql/queries/transactions.js';

describe('buildTransactionFilter', () => {
  test('returns null when no options are provided', () => {
    expect(buildTransactionFilter({})).toBeNull();
  });

  test('translates start_date and end_date into dates array', () => {
    const filter = buildTransactionFilter({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
    });
    expect(filter).toEqual({
      dates: [{ from: '2025-01-01', to: '2025-12-31' }],
    });
  });

  test('uses far-future end when only start_date given', () => {
    const filter = buildTransactionFilter({ startDate: '2025-01-01' });
    expect(filter?.dates?.[0]?.from).toBe('2025-01-01');
    expect(filter?.dates?.[0]?.to).toBe('9999-12-31');
  });

  test('uses far-past start when only end_date given', () => {
    const filter = buildTransactionFilter({ endDate: '2025-12-31' });
    expect(filter?.dates?.[0]?.from).toBe('1970-01-01');
    expect(filter?.dates?.[0]?.to).toBe('2025-12-31');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/graphql/queries/transactions.test.ts`
Expected: FAIL with module import error (file doesn't exist yet).

- [ ] **Step 3: Create the module with minimal types and the function**

Create `src/core/graphql/queries/transactions.ts`:

```typescript
/**
 * GraphQL query wrapper for the Transactions read path.
 *
 * Pure functions that translate a subset of the get_transactions tool
 * arg shape into the TransactionFilter + TransactionSort input shapes
 * captured from Copilot's web UI on 2026-04-23.
 */

export type ReadTransactionType = 'REGULAR' | 'INCOME' | 'INTERNAL_TRANSFER' | 'RECURRING';

export interface DateRange {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

export interface AccountRef {
  accountId: string;
  itemId: string;
}

export interface TransactionFilterInput {
  dates?: DateRange[];
  accountIds?: AccountRef[];
  categoryIds?: string[];
  recurringIds?: string[];
  tagIds?: string[];
  types?: ReadTransactionType[];
  isReviewed?: boolean;
  matchString?: string;
}

export interface BuildFilterOptions {
  startDate?: string;
  endDate?: string;
  accountRefs?: AccountRef[];
  categoryIds?: string[];
  recurringIds?: string[];
  tagIds?: string[];
  types?: ReadTransactionType[];
  isReviewed?: boolean;
  matchString?: string;
}

const FAR_PAST = '1970-01-01';
const FAR_FUTURE = '9999-12-31';

export function buildTransactionFilter(
  opts: BuildFilterOptions
): TransactionFilterInput | null {
  const filter: TransactionFilterInput = {};
  let hasAny = false;

  if (opts.startDate || opts.endDate) {
    filter.dates = [
      { from: opts.startDate ?? FAR_PAST, to: opts.endDate ?? FAR_FUTURE },
    ];
    hasAny = true;
  }
  if (opts.accountRefs?.length) {
    filter.accountIds = opts.accountRefs;
    hasAny = true;
  }
  if (opts.categoryIds?.length) {
    filter.categoryIds = opts.categoryIds;
    hasAny = true;
  }
  if (opts.recurringIds?.length) {
    filter.recurringIds = opts.recurringIds;
    hasAny = true;
  }
  if (opts.tagIds?.length) {
    filter.tagIds = opts.tagIds;
    hasAny = true;
  }
  if (opts.types?.length) {
    filter.types = opts.types;
    hasAny = true;
  }
  if (opts.isReviewed !== undefined) {
    filter.isReviewed = opts.isReviewed;
    hasAny = true;
  }
  if (opts.matchString !== undefined && opts.matchString !== '') {
    filter.matchString = opts.matchString;
    hasAny = true;
  }

  return hasAny ? filter : null;
}
```

- [ ] **Step 4: Run first four tests — they pass**

Run: `bun test tests/core/graphql/queries/transactions.test.ts`
Expected: 5 tests PASS (1 smoke + 4 filter).

- [ ] **Step 5: Write additional tests for the remaining filter mappings**

Append to `tests/core/graphql/queries/transactions.test.ts`:

```typescript
describe('buildTransactionFilter — more mappings', () => {
  test('translates accountRefs', () => {
    const filter = buildTransactionFilter({
      accountRefs: [{ accountId: 'a1', itemId: 'i1' }],
    });
    expect(filter).toEqual({
      accountIds: [{ accountId: 'a1', itemId: 'i1' }],
    });
  });

  test('translates categoryIds', () => {
    expect(buildTransactionFilter({ categoryIds: ['c1', 'c2'] })).toEqual({
      categoryIds: ['c1', 'c2'],
    });
  });

  test('translates tagIds', () => {
    expect(buildTransactionFilter({ tagIds: ['t1'] })).toEqual({
      tagIds: ['t1'],
    });
  });

  test('translates types', () => {
    expect(buildTransactionFilter({ types: ['REGULAR', 'INCOME'] })).toEqual({
      types: ['REGULAR', 'INCOME'],
    });
  });

  test('translates matchString', () => {
    expect(buildTransactionFilter({ matchString: 'amazon' })).toEqual({
      matchString: 'amazon',
    });
  });

  test('omits empty matchString', () => {
    expect(buildTransactionFilter({ matchString: '' })).toBeNull();
  });

  test('translates isReviewed=false', () => {
    expect(buildTransactionFilter({ isReviewed: false })).toEqual({
      isReviewed: false,
    });
  });

  test('combines multiple filters', () => {
    const filter = buildTransactionFilter({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      categoryIds: ['c1'],
      matchString: 'amazon',
      types: ['REGULAR'],
    });
    expect(filter).toEqual({
      dates: [{ from: '2025-01-01', to: '2025-12-31' }],
      categoryIds: ['c1'],
      matchString: 'amazon',
      types: ['REGULAR'],
    });
  });
});
```

- [ ] **Step 6: Run full test — all pass**

Run: `bun test tests/core/graphql/queries/transactions.test.ts`
Expected: 13 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/graphql/queries/transactions.ts tests/core/graphql/queries/transactions.test.ts
git commit -m "feat(graphql): add buildTransactionFilter for live reads

Pure translator from a subset of get_transactions tool args into the
TransactionFilter GraphQL input shape, following the field shapes
captured from Copilot's web UI on 2026-04-23."
```

---

## Task 3: buildTransactionSort and paginateTransactions

**Files:**
- Modify: `src/core/graphql/queries/transactions.ts`
- Test: `tests/core/graphql/queries/transactions.test.ts` (extend)

**Context:** The sort helper is a trivial constructor returning `[{field: DATE, direction: DESC}]` by default. The paginator is where the interesting logic lives: call GraphQL, collect edges, decide whether to request the next page. Early-exit when the trailing edge's date precedes `startDate`. End-exit on `hasNextPage === false`. The paginator takes an async `fetcher` callback that makes the actual network call — this keeps the pagination logic testable without mocking the whole GraphQL client at this level.

- [ ] **Step 1: Write tests for buildTransactionSort**

Append to `tests/core/graphql/queries/transactions.test.ts`:

```typescript
import {
  buildTransactionSort,
  type TransactionSortInput,
} from '../../../../src/core/graphql/queries/transactions.js';

describe('buildTransactionSort', () => {
  test('defaults to DATE DESC', () => {
    expect(buildTransactionSort()).toEqual([{ field: 'DATE', direction: 'DESC' }]);
  });

  test('accepts overrides', () => {
    expect(buildTransactionSort({ field: 'AMOUNT', direction: 'ASC' })).toEqual([
      { field: 'AMOUNT', direction: 'ASC' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/graphql/queries/transactions.test.ts`
Expected: FAIL with import error (function doesn't exist).

- [ ] **Step 3: Add buildTransactionSort to the module**

Append to `src/core/graphql/queries/transactions.ts`:

```typescript

export type TransactionSortField = 'DATE' | 'AMOUNT';
export type SortDirection = 'ASC' | 'DESC';

export interface TransactionSortInput {
  field: TransactionSortField;
  direction: SortDirection;
}

export function buildTransactionSort(
  overrides?: Partial<TransactionSortInput>
): TransactionSortInput[] {
  return [
    {
      field: overrides?.field ?? 'DATE',
      direction: overrides?.direction ?? 'DESC',
    },
  ];
}
```

- [ ] **Step 4: Run sort tests — pass**

Run: `bun test tests/core/graphql/queries/transactions.test.ts`
Expected: 15 tests PASS.

- [ ] **Step 5: Write tests for paginateTransactions**

Append to `tests/core/graphql/queries/transactions.test.ts`:

```typescript
import {
  paginateTransactions,
  type TransactionNode,
  type TransactionsPage,
} from '../../../../src/core/graphql/queries/transactions.js';

function mkNode(id: string, date: string): TransactionNode {
  return {
    id,
    date,
    accountId: 'a1',
    itemId: 'i1',
    categoryId: 'c1',
    recurringId: null,
    parentId: null,
    isReviewed: false,
    isPending: false,
    amount: 10,
    name: 'x',
    type: 'REGULAR',
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    isoCurrencyCode: 'USD',
    createdAt: 0,
    tags: [],
    goal: null,
  };
}

describe('paginateTransactions', () => {
  test('collects all pages when fetcher returns hasNextPage=false', async () => {
    let calls = 0;
    const fetcher = async (): Promise<TransactionsPage> => {
      calls += 1;
      return {
        edges: [{ cursor: 'c1', node: mkNode('t1', '2025-06-01') }],
        pageInfo: { endCursor: 'c1', hasNextPage: false },
      };
    };
    const rows = await paginateTransactions(fetcher, {});
    expect(rows).toHaveLength(1);
    expect(calls).toBe(1);
  });

  test('follows cursor to next page until hasNextPage=false', async () => {
    const pages: TransactionsPage[] = [
      {
        edges: [{ cursor: 'c1', node: mkNode('t1', '2025-06-01') }],
        pageInfo: { endCursor: 'c1', hasNextPage: true },
      },
      {
        edges: [{ cursor: 'c2', node: mkNode('t2', '2025-05-01') }],
        pageInfo: { endCursor: 'c2', hasNextPage: false },
      },
    ];
    const fetcher = async (_after: string | null): Promise<TransactionsPage> =>
      pages.shift()!;

    const rows = await paginateTransactions(fetcher, {});
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe('t1');
    expect(rows[1]!.id).toBe('t2');
  });

  test('early-exits when last node date precedes startDate (DATE DESC sort)', async () => {
    let calls = 0;
    const fetcher = async (): Promise<TransactionsPage> => {
      calls += 1;
      return {
        edges: [
          { cursor: 'c1', node: mkNode('t1', '2025-07-01') },
          { cursor: 'c2', node: mkNode('t2', '2024-12-31') }, // before startDate
        ],
        pageInfo: { endCursor: 'c2', hasNextPage: true },
      };
    };
    const rows = await paginateTransactions(fetcher, { startDate: '2025-01-01' });
    expect(calls).toBe(1); // did not fetch page 2 despite hasNextPage
    expect(rows).toHaveLength(2);
  });

  test('passes previous endCursor to fetcher', async () => {
    const received: (string | null)[] = [];
    const pages: TransactionsPage[] = [
      {
        edges: [{ cursor: 'c1', node: mkNode('t1', '2025-06-01') }],
        pageInfo: { endCursor: 'c1', hasNextPage: true },
      },
      {
        edges: [{ cursor: 'c2', node: mkNode('t2', '2025-05-01') }],
        pageInfo: { endCursor: 'c2', hasNextPage: false },
      },
    ];
    const fetcher = async (after: string | null): Promise<TransactionsPage> => {
      received.push(after);
      return pages.shift()!;
    };
    await paginateTransactions(fetcher, {});
    expect(received).toEqual([null, 'c1']);
  });
});
```

- [ ] **Step 6: Run tests — they fail**

Run: `bun test tests/core/graphql/queries/transactions.test.ts`
Expected: FAIL (paginateTransactions not exported).

- [ ] **Step 7: Implement paginateTransactions and required types**

Append to `src/core/graphql/queries/transactions.ts`:

```typescript

export interface TransactionTag {
  id: string;
  name: string;
  colorName: string;
}

export interface TransactionGoalRef {
  id: string;
  name: string;
}

export interface TransactionNode {
  id: string;
  accountId: string;
  itemId: string;
  categoryId: string | null;
  recurringId: string | null;
  parentId: string | null;
  isReviewed: boolean;
  isPending: boolean;
  amount: number;
  date: string;
  name: string;
  type: ReadTransactionType;
  userNotes: string | null;
  tipAmount: number | null;
  suggestedCategoryIds: string[];
  isoCurrencyCode: string | null;
  createdAt: number;
  tags: TransactionTag[];
  goal: TransactionGoalRef | null;
}

export interface TransactionEdge {
  cursor: string;
  node: TransactionNode;
}

export interface TransactionsPage {
  edges: TransactionEdge[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
}

export interface PaginateOptions {
  startDate?: string; // YYYY-MM-DD — enables early-exit on DATE DESC sort
}

export type TransactionsFetcher = (after: string | null) => Promise<TransactionsPage>;

/**
 * Paginate a Transactions query until no more pages are needed.
 *
 * Pure pagination driver — the fetcher callback owns the actual
 * network call. Early-exits when the trailing edge of a page precedes
 * opts.startDate (requires DATE DESC sort to be meaningful). Otherwise
 * follows pageInfo.endCursor until pageInfo.hasNextPage === false.
 */
export async function paginateTransactions(
  fetcher: TransactionsFetcher,
  opts: PaginateOptions
): Promise<TransactionNode[]> {
  const collected: TransactionNode[] = [];
  let cursor: string | null = null;

  while (true) {
    const page = await fetcher(cursor);
    for (const edge of page.edges) {
      collected.push(edge.node);
    }

    if (!page.pageInfo.hasNextPage) break;

    if (opts.startDate && page.edges.length > 0) {
      const tail = page.edges[page.edges.length - 1]!.node.date;
      if (tail < opts.startDate) break;
    }

    cursor = page.pageInfo.endCursor;
    if (cursor === null) break; // defensive: hasNextPage=true but no cursor
  }

  return collected;
}
```

- [ ] **Step 8: Run tests — all pass**

Run: `bun test tests/core/graphql/queries/transactions.test.ts`
Expected: 19 tests PASS.

- [ ] **Step 9: Add fetchTransactionsPage helper that wires the real GraphQL client**

Append to `src/core/graphql/queries/transactions.ts`:

```typescript

import type { GraphQLClient } from '../client.js';
import { TRANSACTIONS } from '../operations.generated.js';

export interface FetchTransactionsArgs {
  first: number;
  after: string | null;
  filter: TransactionFilterInput | null;
  sort: TransactionSortInput[];
}

interface TransactionsResponse {
  transactions: TransactionsPage;
}

/**
 * Single GraphQL round-trip fetching one page of transactions.
 *
 * Delegates transport and auth to the GraphQLClient. Returns the raw
 * page for paginateTransactions to drive.
 */
export async function fetchTransactionsPage(
  client: GraphQLClient,
  args: FetchTransactionsArgs
): Promise<TransactionsPage> {
  const data = await client.query<FetchTransactionsArgs, TransactionsResponse>(
    'Transactions',
    TRANSACTIONS,
    args
  );
  return data.transactions;
}
```

**Note:** The `GraphQLClient` currently exposes a `mutate()` method but not `query()`. The query path will use the same transport. Task 3 will add `query()` by renaming or aliasing `mutate()` — see the next step.

- [ ] **Step 10: Add `query()` method to GraphQLClient as an alias for mutate**

Open `src/core/graphql/client.ts`. After the `mutate()` method (ends around line 132), add:

```typescript

  /**
   * Send a GraphQL query. Same transport, auth, and error classification
   * as mutate(). Semantic alias kept separate so call sites and logs
   * distinguish reads from writes.
   */
  async query<TVariables, TResponse>(
    operationName: string,
    query: string,
    variables: TVariables
  ): Promise<TResponse> {
    return this.mutate<TVariables, TResponse>(operationName, query, variables);
  }
```

- [ ] **Step 11: Add a test for fetchTransactionsPage**

Append to `tests/core/graphql/queries/transactions.test.ts`:

```typescript
import { mock } from 'bun:test';
import { fetchTransactionsPage } from '../../../../src/core/graphql/queries/transactions.js';
import { TRANSACTIONS } from '../../../../src/core/graphql/operations.generated.js';
import type { GraphQLClient } from '../../../../src/core/graphql/client.js';

function createMockClient(response: unknown): GraphQLClient {
  return {
    mutate: mock(() => Promise.resolve(response)),
    query: mock(() => Promise.resolve(response)),
  } as unknown as GraphQLClient;
}

describe('fetchTransactionsPage', () => {
  test('calls client.query with Transactions op name and TRANSACTIONS query string', async () => {
    const page: TransactionsPage = {
      edges: [],
      pageInfo: { endCursor: null, hasNextPage: false },
    };
    const client = createMockClient({ transactions: page });

    await fetchTransactionsPage(client, {
      first: 100,
      after: null,
      filter: null,
      sort: [{ field: 'DATE', direction: 'DESC' }],
    });

    const calls = (client.query as ReturnType<typeof mock>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('Transactions');
    expect(calls[0][1]).toBe(TRANSACTIONS);
    expect(calls[0][2]).toEqual({
      first: 100,
      after: null,
      filter: null,
      sort: [{ field: 'DATE', direction: 'DESC' }],
    });
  });
});
```

- [ ] **Step 12: Run tests — all pass**

Run: `bun test tests/core/graphql/queries/transactions.test.ts`
Expected: 20 tests PASS.

- [ ] **Step 13: Typecheck + lint**

Run: `bun run check`
Expected: PASS. If format check fails, run `bun run fix` then re-run.

- [ ] **Step 14: Commit**

```bash
git add src/core/graphql/queries/transactions.ts src/core/graphql/client.ts tests/core/graphql/queries/transactions.test.ts
git commit -m "feat(graphql): add sort, pagination, and fetchTransactionsPage

- buildTransactionSort: default DATE DESC, overrideable
- paginateTransactions: pure pagination driver with early-exit on
  date boundary, cursor threading, and no-more-pages end-exit
- fetchTransactionsPage: wraps GraphQLClient.query(), used by live
  tool to make single round-trips
- GraphQLClient.query: semantic alias over mutate() for read paths"
```

---

## Task 4: LiveCopilotDatabase skeleton (memo, retry, verbose logging)

**Files:**
- Create: `src/core/live-database.ts`
- Test: `tests/core/live-database.test.ts`

**Context:** The class owns cross-cutting concerns — memoization, one-shot retry on NETWORK errors, verbose logging — shared by every entity method future phases add. This task builds only the scaffold; `getTransactions` lands in Task 5. Tests cover the generic pieces in isolation.

- [ ] **Step 1: Write skeleton tests**

Create `tests/core/live-database.test.ts`:

```typescript
import { describe, test, expect, mock } from 'bun:test';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { GraphQLError } from '../../src/core/graphql/client.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import type { CopilotDatabase } from '../../src/core/database.js';

function mkClient(): GraphQLClient {
  return { mutate: mock(), query: mock() } as unknown as GraphQLClient;
}
function mkCache(): CopilotDatabase {
  return { getAccounts: mock() } as unknown as CopilotDatabase;
}

describe('LiveCopilotDatabase — withRetry', () => {
  test('succeeds on first try without retry', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    let calls = 0;
    const result = await live.withRetry(async () => {
      calls += 1;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  test('retries once on NETWORK error and succeeds', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    let calls = 0;
    const result = await live.withRetry(async () => {
      calls += 1;
      if (calls === 1) throw new GraphQLError('NETWORK', 'boom', 'Op');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  test('does not retry on AUTH_FAILED', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    let calls = 0;
    await expect(
      live.withRetry(async () => {
        calls += 1;
        throw new GraphQLError('AUTH_FAILED', '401', 'Op');
      })
    ).rejects.toThrow('401');
    expect(calls).toBe(1);
  });

  test('surfaces error after second NETWORK failure', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    let calls = 0;
    await expect(
      live.withRetry(async () => {
        calls += 1;
        throw new GraphQLError('NETWORK', 'still broken', 'Op');
      })
    ).rejects.toThrow('still broken');
    expect(calls).toBe(2);
  });
});

describe('LiveCopilotDatabase — memo', () => {
  test('returns cached value within TTL', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache(), { memoTtlMs: 60_000 });
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { value: calls };
    };
    const a = await live.memoize('key-1', loader);
    const b = await live.memoize('key-1', loader);
    expect(a).toEqual({ value: 1 });
    expect(b).toEqual({ value: 1 });
    expect(calls).toBe(1);
  });

  test('re-loads after TTL expires', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache(), { memoTtlMs: 1 });
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return calls;
    };
    await live.memoize('k', loader);
    await new Promise((r) => setTimeout(r, 5));
    await live.memoize('k', loader);
    expect(calls).toBe(2);
  });

  test('distinguishes different keys', async () => {
    const live = new LiveCopilotDatabase(mkClient(), mkCache());
    await live.memoize('a', async () => 1);
    const b = await live.memoize('b', async () => 2);
    expect(b).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests — they fail**

Run: `bun test tests/core/live-database.test.ts`
Expected: FAIL (module doesn't exist).

- [ ] **Step 3: Implement the skeleton**

Create `src/core/live-database.ts`:

```typescript
/**
 * Live-read data layer backed by Copilot's GraphQL API.
 *
 * This class is the planned long-term replacement for CopilotDatabase
 * once every read tool has migrated off LevelDB. Phase 1 implements
 * only getTransactions(); later phases add methods for accounts,
 * categories, budgets, recurring, and tags.
 *
 * The class owns cross-cutting concerns shared by every method:
 *   - short-lived result memoization (default 5 min TTL)
 *   - one retry on NETWORK errors (other GraphQL codes surface)
 *   - optional verbose logging to stderr for latency measurement
 *
 * See docs/superpowers/specs/2026-04-23-graphql-live-reads-design.md.
 */

import { GraphQLError, type GraphQLClient } from './graphql/client.js';
import type { CopilotDatabase } from './database.js';

interface MemoEntry<T> {
  result: T;
  at: number;
}

export interface LiveDatabaseOptions {
  memoTtlMs?: number;
  verbose?: boolean;
}

const DEFAULT_MEMO_TTL_MS = 5 * 60 * 1000;
const RETRY_BACKOFF_MS = 500;

export class LiveCopilotDatabase {
  private readonly memoTtlMs: number;
  private readonly verbose: boolean;
  private readonly memoStore: Map<string, MemoEntry<unknown>> = new Map();

  constructor(
    private readonly graphql: GraphQLClient,
    private readonly cache: CopilotDatabase,
    opts: LiveDatabaseOptions = {}
  ) {
    this.memoTtlMs = opts.memoTtlMs ?? DEFAULT_MEMO_TTL_MS;
    this.verbose = opts.verbose ?? false;
  }

  /**
   * Expose the underlying GraphQL client for functions that take it
   * as an argument (e.g. fetchTransactionsPage).
   */
  getClient(): GraphQLClient {
    return this.graphql;
  }

  /**
   * Expose the cache so tool implementations can use it for
   * account→item and tag-name→tag-id lookups until Phase 2 migrates
   * those reads onto the live layer too.
   */
  getCache(): CopilotDatabase {
    return this.cache;
  }

  async withRetry<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (err instanceof GraphQLError && err.code === 'NETWORK') {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
        return await op();
      }
      throw err;
    }
  }

  async memoize<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const existing = this.memoStore.get(key);
    if (existing && Date.now() - existing.at < this.memoTtlMs) {
      return existing.result as T;
    }
    const result = await loader();
    this.memoStore.set(key, { result, at: Date.now() });
    return result;
  }

  logReadCall(
    opName: string,
    pages: number,
    latencyMs: number,
    rows: number
  ): void {
    if (!this.verbose) return;
    console.error(
      `[graphql-read] op=${opName} pages=${pages} latency=${latencyMs}ms rows=${rows}`
    );
  }
}
```

- [ ] **Step 4: Run tests — all pass**

Run: `bun test tests/core/live-database.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/live-database.ts tests/core/live-database.test.ts
git commit -m "feat(live): LiveCopilotDatabase skeleton with memo and retry

Scaffolds the long-term replacement for CopilotDatabase — owns
memoization (5min TTL default), one-shot retry on NETWORK errors,
and optional verbose-logging hook for measurement. Phase 1 will add
getTransactions() on top of this scaffold."
```

---

## Task 5: LiveCopilotDatabase.getTransactions

**Files:**
- Modify: `src/core/live-database.ts`
- Test: `tests/core/live-database.test.ts` (extend)

**Context:** This is the one public read method Phase 1 ships. It composes the pieces from Tasks 2–4: builds the filter + sort from a normalized arg shape, runs the paginator with retry + memo wrappers, and instruments the call with verbose-mode logging. The method stays "dumb" about tool-facing filter semantics (no amount filtering, no pending filter, no enrichment — that lives in the tool layer). Its only job is: turn a normalized filter + sort into paginated, server-fetched transaction nodes.

- [ ] **Step 1: Write tests for getTransactions**

Append to `tests/core/live-database.test.ts`:

```typescript
import type { TransactionsPage } from '../../src/core/graphql/queries/transactions.js';

function mkClientReturning(pages: TransactionsPage[]): GraphQLClient {
  let i = 0;
  return {
    mutate: mock(),
    query: mock(() => Promise.resolve({ transactions: pages[i++] })),
  } as unknown as GraphQLClient;
}

describe('LiveCopilotDatabase.getTransactions', () => {
  test('paginates through one page and returns rows', async () => {
    const client = mkClientReturning([
      {
        edges: [
          {
            cursor: 'c1',
            node: {
              id: 't1',
              accountId: 'a1',
              itemId: 'i1',
              categoryId: 'c',
              recurringId: null,
              parentId: null,
              isReviewed: false,
              isPending: false,
              amount: 10,
              date: '2025-06-01',
              name: 'Amazon',
              type: 'REGULAR',
              userNotes: null,
              tipAmount: null,
              suggestedCategoryIds: [],
              isoCurrencyCode: 'USD',
              createdAt: 0,
              tags: [],
              goal: null,
            },
          },
        ],
        pageInfo: { endCursor: 'c1', hasNextPage: false },
      },
    ]);
    const live = new LiveCopilotDatabase(client, mkCache());
    const rows = await live.getTransactions({});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('t1');
  });

  test('memoizes identical calls within TTL', async () => {
    const page: TransactionsPage = {
      edges: [],
      pageInfo: { endCursor: null, hasNextPage: false },
    };
    const client = mkClientReturning([page]);
    const live = new LiveCopilotDatabase(client, mkCache());

    await live.getTransactions({ startDate: '2025-01-01' });
    await live.getTransactions({ startDate: '2025-01-01' });

    const qCalls = (client.query as ReturnType<typeof mock>).mock.calls;
    expect(qCalls).toHaveLength(1);
  });

  test('retries once on NETWORK error per page', async () => {
    let calls = 0;
    const page: TransactionsPage = {
      edges: [],
      pageInfo: { endCursor: null, hasNextPage: false },
    };
    const client = {
      mutate: mock(),
      query: mock(() => {
        calls += 1;
        if (calls === 1) throw new GraphQLError('NETWORK', 'blip', 'Transactions');
        return Promise.resolve({ transactions: page });
      }),
    } as unknown as GraphQLClient;
    const live = new LiveCopilotDatabase(client, mkCache());

    const rows = await live.getTransactions({});
    expect(rows).toHaveLength(0);
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests — they fail**

Run: `bun test tests/core/live-database.test.ts`
Expected: FAIL (`getTransactions` not defined).

- [ ] **Step 3: Import deps and implement getTransactions**

At the top of `src/core/live-database.ts`, add imports:

```typescript
import {
  buildTransactionFilter,
  buildTransactionSort,
  fetchTransactionsPage,
  paginateTransactions,
  type BuildFilterOptions,
  type TransactionNode,
  type TransactionSortInput,
} from './graphql/queries/transactions.js';
```

Then append inside the `LiveCopilotDatabase` class, before the closing brace:

```typescript

  /**
   * Fetch transactions from Copilot's GraphQL API, paginating with
   * DATE DESC sort and early-exiting when the trailing row precedes
   * the requested start date.
   *
   * Pure data access — client-side post-filtering (amount range,
   * pending, excluded-category join, special transaction_type
   * variants) lives in the tool layer, not here.
   */
  async getTransactions(
    opts: BuildFilterOptions & { sort?: TransactionSortInput; pageSize?: number }
  ): Promise<TransactionNode[]> {
    const filter = buildTransactionFilter(opts);
    const sort = buildTransactionSort(opts.sort);
    const first = opts.pageSize ?? 100;

    const memoKey = JSON.stringify({ filter, sort, first });
    return this.memoize(memoKey, async () => {
      let pages = 0;
      const startedAt = Date.now();
      const rows = await paginateTransactions(
        (after) =>
          this.withRetry(async () => {
            pages += 1;
            return fetchTransactionsPage(this.graphql, { first, after, filter, sort });
          }),
        { startDate: opts.startDate }
      );
      this.logReadCall('Transactions', pages, Date.now() - startedAt, rows.length);
      return rows;
    });
  }
```

- [ ] **Step 4: Run tests — all pass**

Run: `bun test tests/core/live-database.test.ts`
Expected: 10 tests PASS (7 skeleton + 3 getTransactions).

- [ ] **Step 5: Full check**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/live-database.ts tests/core/live-database.test.ts
git commit -m "feat(live): LiveCopilotDatabase.getTransactions

Adds the one public read method Phase 1 ships. Composes
buildTransactionFilter, buildTransactionSort, and paginateTransactions
with memoization, retry-on-NETWORK, and verbose logging. Stays
ignorant of tool-facing filter semantics — client-side post-filtering
and enrichment live in the tool layer."
```

---

## Task 6: Auth preflight function

**Files:**
- Modify: `src/core/live-database.ts`
- Test: `tests/core/live-database.test.ts` (extend)

**Context:** Before the MCP server starts, a `--live-reads` boot preflights auth by sending a real GraphQL query. Missing refresh tokens, failed Firebase exchange, or non-success probe responses are fatal. The preflight function lives alongside `LiveCopilotDatabase` so all live-mode infrastructure is in one file.

- [ ] **Step 1: Write preflight tests**

Append to `tests/core/live-database.test.ts`:

```typescript
import { preflightLiveAuth } from '../../src/core/live-database.js';

describe('preflightLiveAuth', () => {
  test('resolves when probe returns a page', async () => {
    const client = {
      mutate: mock(),
      query: mock(() =>
        Promise.resolve({
          transactions: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } },
        })
      ),
    } as unknown as GraphQLClient;
    await expect(preflightLiveAuth(client)).resolves.toBeUndefined();
  });

  test('rejects with NETWORK code preserved', async () => {
    const client = {
      mutate: mock(),
      query: mock(() =>
        Promise.reject(new GraphQLError('NETWORK', 'down', 'Transactions'))
      ),
    } as unknown as GraphQLClient;
    await expect(preflightLiveAuth(client)).rejects.toMatchObject({ code: 'NETWORK' });
  });

  test('rejects with AUTH_FAILED when token rejected', async () => {
    const client = {
      mutate: mock(),
      query: mock(() =>
        Promise.reject(new GraphQLError('AUTH_FAILED', '401', 'Transactions'))
      ),
    } as unknown as GraphQLClient;
    await expect(preflightLiveAuth(client)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });
});
```

- [ ] **Step 2: Run tests — they fail**

Run: `bun test tests/core/live-database.test.ts`
Expected: FAIL (`preflightLiveAuth` not exported).

- [ ] **Step 3: Implement preflightLiveAuth**

Append to `src/core/live-database.ts` (below the class definition):

```typescript

/**
 * Validate that the live-reads auth path works end-to-end before
 * registering any live tools. Sends one cheap GraphQL query that
 * exercises token extraction → Firebase exchange → endpoint →
 * schema validity → permission. Any failure is fatal; callers
 * should log and exit non-zero, not register a dead tool.
 */
export async function preflightLiveAuth(client: GraphQLClient): Promise<void> {
  await fetchTransactionsPage(client, {
    first: 1,
    after: null,
    filter: null,
    sort: buildTransactionSort(),
  });
}
```

- [ ] **Step 4: Run tests — pass**

Run: `bun test tests/core/live-database.test.ts`
Expected: 13 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/live-database.ts tests/core/live-database.test.ts
git commit -m "feat(live): auth preflight for --live-reads

preflightLiveAuth sends one authenticated GraphQL ping on server boot.
Exercises token extraction, Firebase exchange, endpoint, schema
validity, and read permission in one hop. Server-bootstrap task will
wire this to process.exit(1) on failure."
```

---

## Task 7: LiveTransactionsTools — input validation and filter translation

**Files:**
- Create: `src/tools/live/transactions.ts`
- Test: `tests/tools/live/transactions.test.ts`

**Context:** The tool class validates input (rejecting unsupported filters with actionable messages), resolves the tool-facing args into the pure shape `LiveCopilotDatabase.getTransactions` accepts, and delegates. This task builds validation + translation; the post-filter + enrichment path is Task 8.

- [ ] **Step 1: Write input-validation tests**

Create `tests/tools/live/transactions.test.ts`:

```typescript
import { describe, test, expect, mock } from 'bun:test';
import { LiveTransactionsTools } from '../../../src/tools/live/transactions.js';
import { LiveCopilotDatabase } from '../../../src/core/live-database.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';
import type { CopilotDatabase } from '../../../src/core/database.js';

function mkLive(): LiveCopilotDatabase {
  const client = { mutate: mock(), query: mock() } as unknown as GraphQLClient;
  const cache = {
    getAccounts: mock(() => Promise.resolve([])),
    getTags: mock(() => Promise.resolve([])),
    getUserCategories: mock(() => Promise.resolve([])),
    getCategoryNameMap: mock(() => Promise.resolve(new Map<string, string>())),
  } as unknown as CopilotDatabase;
  return new LiveCopilotDatabase(client, cache);
}

describe('LiveTransactionsTools — input validation', () => {
  test('rejects city filter', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ city: 'Brooklyn' } as never)).rejects.toThrow(
      /city.*not supported/i
    );
  });

  test('rejects lat/lon filter', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(
      tools.getTransactions({ lat: 40.7, lon: -74 } as never)
    ).rejects.toThrow(/lat.*not supported|lon.*not supported/i);
  });

  test('rejects region/country/radius_km filters', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(tools.getTransactions({ region: 'NY' } as never)).rejects.toThrow(
      /region.*not supported/i
    );
    await expect(tools.getTransactions({ country: 'US' } as never)).rejects.toThrow(
      /country.*not supported/i
    );
    await expect(
      tools.getTransactions({ radius_km: 10 } as never)
    ).rejects.toThrow(/radius_km.*not supported/i);
  });

  test('rejects transaction_type=foreign and =duplicates', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(
      tools.getTransactions({ transaction_type: 'foreign' } as never)
    ).rejects.toThrow(/foreign.*not supported/i);
    await expect(
      tools.getTransactions({ transaction_type: 'duplicates' } as never)
    ).rejects.toThrow(/duplicates.*not supported/i);
  });

  test('rejects exclude_split_parents=false', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(
      tools.getTransactions({ exclude_split_parents: false } as never)
    ).rejects.toThrow(/exclude_split_parents.*not supported/i);
  });

  test('rejects transaction_id lookup without account_id+item_id', async () => {
    const tools = new LiveTransactionsTools(mkLive());
    await expect(
      tools.getTransactions({ transaction_id: 't1' } as never)
    ).rejects.toThrow(/account_id.*item_id/i);
  });
});
```

- [ ] **Step 2: Run tests — they fail**

Run: `bun test tests/tools/live/transactions.test.ts`
Expected: FAIL (`LiveTransactionsTools` not defined).

- [ ] **Step 3: Create the module with types and validation**

Create `src/tools/live/transactions.ts`:

```typescript
/**
 * Live-mode implementation of get_transactions_live.
 *
 * Validates input against the strict subset supported over GraphQL,
 * translates tool-facing args into the pure shape
 * LiveCopilotDatabase.getTransactions accepts, applies client-side
 * post-filters GraphQL can't do server-side, and enriches the result
 * with category_name + normalized_merchant — matching the envelope
 * the cache-backed get_transactions tool returns today.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import type {
  ReadTransactionType,
  AccountRef,
  TransactionNode,
} from '../../core/graphql/queries/transactions.js';
import { parsePeriod } from '../../utils/date.js';

export type LiveTransactionType =
  | 'refunds'
  | 'credits'
  | 'hsa_eligible'
  | 'tagged';

export interface GetTransactionsLiveOptions {
  period?: string;
  start_date?: string;
  end_date?: string;
  category?: string;
  merchant?: string;
  account_id?: string;
  item_id?: string;
  min_amount?: number;
  max_amount?: number;
  limit?: number;
  offset?: number;
  exclude_transfers?: boolean;
  exclude_deleted?: boolean;
  exclude_excluded?: boolean;
  exclude_split_parents?: boolean;
  pending?: boolean;
  transaction_id?: string;
  query?: string;
  transaction_type?: LiveTransactionType;
  tag?: string;
}

export interface EnrichedTransaction {
  transaction_id: string;
  account_id: string;
  item_id: string;
  category_id: string | null;
  category_name?: string;
  recurring_id: string | null;
  parent_transaction_id: string | null;
  amount: number;
  date: string;
  name: string;
  normalized_merchant?: string;
  type: ReadTransactionType;
  user_reviewed: boolean;
  pending: boolean;
  user_notes: string | null;
  tip_amount: number | null;
  suggested_category_ids: string[];
  iso_currency_code: string | null;
  tag_ids: string[];
  created_timestamp: number;
}

export interface GetTransactionsLiveResult {
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  transactions: EnrichedTransaction[];
}

const UNSUPPORTED_KEYS = [
  'city',
  'lat',
  'lon',
  'radius_km',
  'region',
  'country',
] as const;

export class LiveTransactionsTools {
  constructor(private readonly live: LiveCopilotDatabase) {}

  async getTransactions(
    opts: GetTransactionsLiveOptions
  ): Promise<GetTransactionsLiveResult> {
    this.validate(opts);
    // Filter translation + fetch + post-filter + enrichment lands in Task 8.
    // Phase-1 placeholder: empty result so validation tests can pass.
    return { count: 0, total_count: 0, offset: 0, has_more: false, transactions: [] };
  }

  private validate(opts: GetTransactionsLiveOptions): void {
    const o = opts as Record<string, unknown>;
    const supported =
      'start_date, end_date, period, account_id (+ item_id), category, merchant, query, tag, min_amount, max_amount, limit, offset, pending, exclude_transfers, exclude_deleted, exclude_excluded, transaction_type (refunds|credits|hsa_eligible|tagged), transaction_id (+ account_id + item_id)';

    for (const key of UNSUPPORTED_KEYS) {
      if (o[key] !== undefined) {
        throw new Error(
          `Parameter '${key}' is not supported in live mode. Retry without '${key}'. Supported filters: ${supported}.`
        );
      }
    }

    if (
      opts.transaction_type !== undefined &&
      !['refunds', 'credits', 'hsa_eligible', 'tagged'].includes(opts.transaction_type)
    ) {
      throw new Error(
        `Parameter 'transaction_type=${opts.transaction_type}' is not supported in live mode. Retry with one of: refunds, credits, hsa_eligible, tagged.`
      );
    }

    if (opts.exclude_split_parents === false) {
      throw new Error(
        `Parameter 'exclude_split_parents=false' is not supported in live mode — the GraphQL server omits split parents. Retry without 'exclude_split_parents' or set it to true.`
      );
    }

    if (opts.transaction_id !== undefined) {
      if (!opts.account_id || !opts.item_id) {
        throw new Error(
          `transaction_id lookup in live mode requires account_id and item_id. All three are returned together by a prior get_transactions_live call.`
        );
      }
    }
  }
}
```

Notice the `parsePeriod` import — that's used in Task 8 but we add it here to avoid two import edits.

- [ ] **Step 4: Run validation tests — all pass**

Run: `bun test tests/tools/live/transactions.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run check`
Expected: PASS (may have "unused import" warning for `parsePeriod`, `TransactionNode`, `AccountRef` — that's fine, Task 8 uses them; alternatively add `// eslint-disable-next-line @typescript-eslint/no-unused-vars` above the import lines just for this commit, or skip them until Task 8).

If the lint fails, remove the unused imports for now and re-add in Task 8:

```typescript
import type { ReadTransactionType } from '../../core/graphql/queries/transactions.js';
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/live/transactions.ts tests/tools/live/transactions.test.ts
git commit -m "feat(live): LiveTransactionsTools input validation

Creates the tool class with strict-subset input validation. Every
unsupported filter returns an actionable error message phrased as a
retry the LLM can do this turn, not a restart instruction for the
user. Filter translation + post-filter + enrichment land in Task 8."
```

---

## Task 8: LiveTransactionsTools — filter translation, post-filter, enrichment

**Files:**
- Modify: `src/tools/live/transactions.ts`
- Test: `tests/tools/live/transactions.test.ts` (extend)

**Context:** This task fills in the body of `getTransactions`. It: (a) resolves `account_id` to an `AccountRef` via the cache, (b) resolves `tag` name to tag id via cache, (c) resolves `category` (if name) to a category id, (d) translates into the `BuildFilterOptions` shape and calls `live.getTransactions`, (e) applies client-side post-filters the GraphQL server can't handle, (f) enriches each result with `category_name` and `normalized_merchant`, (g) applies pagination in the envelope (offset/limit).

- [ ] **Step 1: Write a happy-path test for a simple date+merchant query**

Append to `tests/tools/live/transactions.test.ts`:

```typescript
import type { TransactionNode } from '../../../src/core/graphql/queries/transactions.js';

function mkNode(partial: Partial<TransactionNode>): TransactionNode {
  return {
    id: 't-default',
    accountId: 'a1',
    itemId: 'i1',
    categoryId: 'c1',
    recurringId: null,
    parentId: null,
    isReviewed: false,
    isPending: false,
    amount: 10,
    date: '2025-06-01',
    name: 'Amazon',
    type: 'REGULAR',
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    isoCurrencyCode: 'USD',
    createdAt: 0,
    tags: [],
    goal: null,
    ...partial,
  };
}

function mkLiveReturning(nodes: TransactionNode[]): LiveCopilotDatabase {
  const live = mkLive();
  (live as unknown as { getTransactions: (opts: unknown) => Promise<TransactionNode[]> }).getTransactions =
    async () => nodes;
  return live;
}

describe('LiveTransactionsTools — happy path', () => {
  test('returns envelope with enriched fields', async () => {
    const live = mkLiveReturning([mkNode({ id: 't1', name: 'AMAZON.COM*XYZ' })]);
    (live.getCache().getCategoryNameMap as ReturnType<typeof mock>).mockImplementation(
      () => Promise.resolve(new Map([['c1', 'Shopping']]))
    );
    const tools = new LiveTransactionsTools(live);

    const result = await tools.getTransactions({ query: 'amazon' });

    expect(result.count).toBe(1);
    expect(result.transactions[0]).toMatchObject({
      transaction_id: 't1',
      category_name: 'Shopping',
      normalized_merchant: 'AMAZON',
    });
  });

  test('applies limit and offset client-side', async () => {
    const nodes = [1, 2, 3, 4, 5].map((i) => mkNode({ id: `t${i}` }));
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);

    const result = await tools.getTransactions({ limit: 2, offset: 1 });

    expect(result.count).toBe(2);
    expect(result.total_count).toBe(5);
    expect(result.offset).toBe(1);
    expect(result.has_more).toBe(true);
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t2', 't3']);
  });
});
```

- [ ] **Step 2: Write tests for client-side post-filters**

Append:

```typescript
describe('LiveTransactionsTools — post-filters', () => {
  test('filters by min_amount and max_amount (absolute value)', async () => {
    const nodes = [
      mkNode({ id: 't1', amount: -5 }),
      mkNode({ id: 't2', amount: 50 }),
      mkNode({ id: 't3', amount: 150 }),
    ];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({ min_amount: 10, max_amount: 100 });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t2']);
  });

  test('filters by pending flag', async () => {
    const nodes = [
      mkNode({ id: 't1', isPending: true }),
      mkNode({ id: 't2', isPending: false }),
    ];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const resultP = await tools.getTransactions({ pending: true });
    expect(resultP.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
    const resultS = await tools.getTransactions({ pending: false });
    expect(resultS.transactions.map((t) => t.transaction_id)).toEqual(['t2']);
  });

  test('transaction_type=tagged filters to rows with tags[] non-empty', async () => {
    const nodes = [
      mkNode({
        id: 't1',
        tags: [{ id: 'tg1', name: 'vacation', colorName: 'BLUE1' }],
      }),
      mkNode({ id: 't2', tags: [] }),
    ];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({ transaction_type: 'tagged' });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
  });

  test('transaction_type=refunds filters to negative amounts (income convention)', async () => {
    const nodes = [
      mkNode({ id: 't1', amount: -25 }),
      mkNode({ id: 't2', amount: 15 }),
    ];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({ transaction_type: 'refunds' });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
  });

  test('exclude_transfers=true filters out INTERNAL_TRANSFER', async () => {
    const nodes = [
      mkNode({ id: 't1', type: 'REGULAR' }),
      mkNode({ id: 't2', type: 'INTERNAL_TRANSFER' }),
    ];
    const live = mkLiveReturning(nodes);
    const tools = new LiveTransactionsTools(live);
    const result = await tools.getTransactions({ exclude_transfers: true });
    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['t1']);
  });
});
```

- [ ] **Step 3: Write tests for account_id resolution**

Append:

```typescript
import type { Account } from '../../../src/models/index.js';

describe('LiveTransactionsTools — account resolution', () => {
  test('resolves account_id to AccountRef via cache', async () => {
    const live = mkLiveReturning([]);
    const accounts: Account[] = [
      { account_id: 'a1', item_id: 'i-1' } as Account,
      { account_id: 'a2', item_id: 'i-2' } as Account,
    ];
    (live.getCache().getAccounts as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(accounts)
    );
    const spy = mock(() => Promise.resolve([]));
    (live as unknown as { getTransactions: typeof spy }).getTransactions = spy;

    const tools = new LiveTransactionsTools(live);
    await tools.getTransactions({ account_id: 'a2' });

    const args = spy.mock.calls[0]![0] as { accountRefs?: AccountRef[] };
    expect(args.accountRefs).toEqual([{ accountId: 'a2', itemId: 'i-2' }]);
  });

  test('surfaces error when account_id is not in cache', async () => {
    const live = mkLiveReturning([]);
    (live.getCache().getAccounts as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([])
    );
    const tools = new LiveTransactionsTools(live);
    await expect(tools.getTransactions({ account_id: 'nope' })).rejects.toThrow(
      /account.*not found/i
    );
  });
});

import type { AccountRef } from '../../../src/core/graphql/queries/transactions.js';
```

- [ ] **Step 4: Run tests — they fail at the new cases**

Run: `bun test tests/tools/live/transactions.test.ts`
Expected: FAIL — happy path / post-filters / account resolution all fail because `getTransactions` is still the placeholder.

- [ ] **Step 5: Implement the full getTransactions method**

In `src/tools/live/transactions.ts`, replace the placeholder `getTransactions` method body with the real implementation:

```typescript
  async getTransactions(
    opts: GetTransactionsLiveOptions
  ): Promise<GetTransactionsLiveResult> {
    this.validate(opts);

    // Single-transaction lookup path: skip pagination entirely by
    // filtering for (accountIds + dates around the txn's creation). The
    // most practical shape is "caller passed all three IDs, fetch a
    // narrow window and find by ID", since the server has no
    // TransactionFilter.id field. Implementation approach: call the
    // regular pagination with accountRefs restricted to one account,
    // then filter by transaction_id in post-process.
    if (opts.transaction_id) {
      return this.singleTransactionLookup(opts);
    }

    const [start_date, end_date] = opts.period
      ? parsePeriod(opts.period)
      : [opts.start_date, opts.end_date];

    const accountRefs = opts.account_id
      ? [await this.resolveAccountRef(opts.account_id)]
      : undefined;

    const categoryIds = opts.category ? [opts.category] : undefined;

    const tagIds = opts.tag ? await this.resolveTagIds(opts.tag) : undefined;

    const matchString = opts.query ?? opts.merchant;

    const types: ReadTransactionType[] | undefined =
      opts.exclude_transfers !== false
        ? ['REGULAR', 'INCOME', 'RECURRING']
        : undefined;

    const nodes = await this.live.getTransactions({
      startDate: start_date,
      endDate: end_date,
      accountRefs,
      categoryIds,
      tagIds,
      types,
      matchString,
    });

    const filtered = await this.postFilter(nodes, opts);
    return this.paginateAndEnrich(filtered, opts);
  }

  private async singleTransactionLookup(
    opts: GetTransactionsLiveOptions
  ): Promise<GetTransactionsLiveResult> {
    const ref = await this.resolveAccountRef(opts.account_id!);
    const nodes = await this.live.getTransactions({
      accountRefs: [ref],
      // No date narrow — caller didn't provide one and we don't want to
      // mis-bound. Rely on early-exit if they pass period/start_date.
      startDate: opts.start_date,
      endDate: opts.end_date,
    });
    const match = nodes.find((n) => n.id === opts.transaction_id);
    if (!match) {
      return { count: 0, total_count: 0, offset: 0, has_more: false, transactions: [] };
    }
    const enriched = await this.enrich([match]);
    return {
      count: 1,
      total_count: 1,
      offset: 0,
      has_more: false,
      transactions: enriched,
    };
  }

  private async resolveAccountRef(accountId: string): Promise<AccountRef> {
    const accounts = await this.live.getCache().getAccounts();
    const match = accounts.find((a) => a.account_id === accountId);
    if (!match || !match.item_id) {
      throw new Error(
        `Account '${accountId}' not found in local cache. Refresh the cache (open the Copilot app) or pass a valid account_id.`
      );
    }
    return { accountId: match.account_id, itemId: match.item_id };
  }

  private async resolveTagIds(tagName: string): Promise<string[]> {
    const stripped = tagName.startsWith('#') ? tagName.slice(1) : tagName;
    const tags = await this.live.getCache().getTags();
    const lowered = stripped.toLowerCase();
    const match = tags.find((t) => t.name?.toLowerCase() === lowered);
    if (!match) {
      throw new Error(
        `Tag '${tagName}' not found. Create the tag first or pass an existing tag name.`
      );
    }
    return [match.tag_id];
  }

  private async postFilter(
    nodes: TransactionNode[],
    opts: GetTransactionsLiveOptions
  ): Promise<TransactionNode[]> {
    let result = nodes;

    // exclude_deleted is a no-op: GraphQL server doesn't return deleted rows.
    // exclude_split_parents=true is a no-op: server already omits parents.

    if (opts.exclude_excluded !== false) {
      const cats = await this.live.getCache().getUserCategories();
      const excludedCatIds = new Set(
        cats.filter((c) => c.excluded === true).map((c) => c.category_id)
      );
      result = result.filter(
        (n) => !n.categoryId || !excludedCatIds.has(n.categoryId)
      );
    }

    if (opts.min_amount !== undefined) {
      const min = opts.min_amount;
      result = result.filter((n) => Math.abs(n.amount) >= min);
    }
    if (opts.max_amount !== undefined) {
      const max = opts.max_amount;
      result = result.filter((n) => Math.abs(n.amount) <= max);
    }

    if (opts.pending !== undefined) {
      result = result.filter((n) => n.isPending === opts.pending);
    }

    if (opts.transaction_type === 'tagged') {
      result = result.filter((n) => n.tags.length > 0);
    } else if (opts.transaction_type === 'refunds') {
      // Copilot convention: negative = credit/refund
      result = result.filter((n) => n.amount < 0);
    } else if (opts.transaction_type === 'credits') {
      result = result.filter((n) => n.amount < 0 && n.type === 'INCOME');
    } else if (opts.transaction_type === 'hsa_eligible') {
      // Heuristic: category name contains 'health' or 'medical'
      const map = await this.live.getCache().getCategoryNameMap();
      result = result.filter((n) => {
        if (!n.categoryId) return false;
        const name = (map.get(n.categoryId) ?? '').toLowerCase();
        return name.includes('health') || name.includes('medical');
      });
    }

    return result;
  }

  private async paginateAndEnrich(
    rows: TransactionNode[],
    opts: GetTransactionsLiveOptions
  ): Promise<GetTransactionsLiveResult> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const total = rows.length;
    const sliced = rows.slice(offset, offset + limit);
    const enriched = await this.enrich(sliced);
    return {
      count: enriched.length,
      total_count: total,
      offset,
      has_more: offset + limit < total,
      transactions: enriched,
    };
  }

  private async enrich(rows: TransactionNode[]): Promise<EnrichedTransaction[]> {
    const catMap = await this.live.getCache().getCategoryNameMap();
    return rows.map((n) => ({
      transaction_id: n.id,
      account_id: n.accountId,
      item_id: n.itemId,
      category_id: n.categoryId,
      category_name: n.categoryId ? catMap.get(n.categoryId) : undefined,
      recurring_id: n.recurringId,
      parent_transaction_id: n.parentId,
      amount: n.amount,
      date: n.date,
      name: n.name,
      normalized_merchant: normalizeMerchantName(n.name),
      type: n.type,
      user_reviewed: n.isReviewed,
      pending: n.isPending,
      user_notes: n.userNotes,
      tip_amount: n.tipAmount,
      suggested_category_ids: n.suggestedCategoryIds,
      iso_currency_code: n.isoCurrencyCode,
      tag_ids: n.tags.map((t) => t.id),
      created_timestamp: n.createdAt,
    }));
  }
}

// Import at top of file if not already there:
import { normalizeMerchantName } from '../tools.js';
```

Move the `normalizeMerchantName` import up with the others at the top of the file (not inline as shown). Ensure all necessary types are imported at the top:

```typescript
import type { LiveCopilotDatabase } from '../../core/live-database.js';
import type {
  AccountRef,
  ReadTransactionType,
  TransactionNode,
} from '../../core/graphql/queries/transactions.js';
import { normalizeMerchantName } from '../tools.js';
import { parsePeriod } from '../../utils/date.js';
```

- [ ] **Step 6: Run tests — all pass**

Run: `bun test tests/tools/live/transactions.test.ts`
Expected: 14 tests PASS (6 validation + 2 happy path + 4 post-filter + 2 account resolution).

- [ ] **Step 7: Typecheck + lint**

Run: `bun run check`
Expected: PASS. Fix any formatting issues with `bun run fix`.

- [ ] **Step 8: Commit**

```bash
git add src/tools/live/transactions.ts tests/tools/live/transactions.test.ts
git commit -m "feat(live): LiveTransactionsTools translation + enrichment

- resolveAccountRef: account_id → {accountId, itemId} via cache
- resolveTagIds: tag name → tag id via cache
- postFilter: client-side filters GraphQL can't do server-side
  (amount range, pending, exclude_excluded via Category.isExcluded,
  transaction_type variants)
- paginateAndEnrich: offset/limit slicing, category_name lookup,
  normalized_merchant via the existing helper
- singleTransactionLookup: transaction_id+account_id+item_id path"
```

---

## Task 9: Tool schema for get_transactions_live

**Files:**
- Modify: `src/tools/live/transactions.ts`
- Test: `tests/tools/live/transactions.test.ts` (extend)

**Context:** The MCP tool schema declares the JSON-Schema surface the LLM sees. It mirrors the cache-backed `get_transactions` schema but removes unsupported filters and narrows the `transaction_type` enum. The description is 4–6 sentences per Anthropic's tool-description guidance.

- [ ] **Step 1: Write tests for the schema**

Append to `tests/tools/live/transactions.test.ts`:

```typescript
import { createLiveToolSchemas } from '../../../src/tools/live/transactions.js';

describe('createLiveToolSchemas', () => {
  test('registers exactly one tool named get_transactions_live', () => {
    const schemas = createLiveToolSchemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0]!.name).toBe('get_transactions_live');
  });

  test('description enumerates unsupported filters and 3-ID rule', () => {
    const { description } = createLiveToolSchemas()[0]!;
    expect(description).toMatch(/city|lat|lon|region|country/);
    expect(description).toMatch(/foreign|duplicates/);
    expect(description).toMatch(/account_id.*item_id/);
  });

  test('input schema omits unsupported filters', () => {
    const { inputSchema } = createLiveToolSchemas()[0]!;
    const props = (inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.city).toBeUndefined();
    expect(props.lat).toBeUndefined();
    expect(props.lon).toBeUndefined();
    expect(props.radius_km).toBeUndefined();
    expect(props.region).toBeUndefined();
    expect(props.country).toBeUndefined();
  });

  test('transaction_type enum excludes foreign and duplicates', () => {
    const { inputSchema } = createLiveToolSchemas()[0]!;
    const ttype = (inputSchema as { properties: { transaction_type?: { enum?: string[] } } })
      .properties.transaction_type;
    expect(ttype?.enum).toEqual(['refunds', 'credits', 'hsa_eligible', 'tagged']);
  });

  test('readOnlyHint is true', () => {
    const { annotations } = createLiveToolSchemas()[0]!;
    expect(annotations?.readOnlyHint).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — they fail**

Run: `bun test tests/tools/live/transactions.test.ts`
Expected: FAIL (`createLiveToolSchemas` not exported).

- [ ] **Step 3: Implement createLiveToolSchemas**

Find the `ToolSchema` type — look in `src/tools/tools.ts` for the existing `createToolSchemas` return type. Import that type into `src/tools/live/transactions.ts` via:

```typescript
import type { ToolSchema } from '../tools.js';
```

If `ToolSchema` isn't exported, export it first (add `export` in front of its declaration in `src/tools/tools.ts`).

Then append to `src/tools/live/transactions.ts`:

```typescript

export function createLiveToolSchemas(): ToolSchema[] {
  return [
    {
      name: 'get_transactions_live',
      description:
        'Reads transactions live from Copilot\'s GraphQL API (requires --live-reads flag and network connectivity). Use this when the user asks about historical date ranges that may not be in the local cache, or when fresh data is required. Unlike get_transactions, the following filters are NOT supported and must not be included: city, lat, lon, radius_km, region, country, transaction_type=foreign, transaction_type=duplicates, and exclude_split_parents=false — any of these returns an error telling you to retry without the parameter. Single-transaction lookup requires all three of transaction_id, account_id, item_id. If the backend is unreachable, this tool returns an isError result; it does NOT fall back to the local cache.',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description:
              'Period shorthand: this_month, last_month, last_7_days, last_30_days, last_90_days, ytd, this_year, last_year',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD)',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD)',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
          category: { type: 'string', description: 'Filter by category ID' },
          merchant: {
            type: 'string',
            description:
              'Filter by merchant name (server-side matchString, substring match)',
          },
          account_id: { type: 'string', description: 'Filter by account ID' },
          item_id: {
            type: 'string',
            description:
              'Item ID paired with account_id. Required only when using transaction_id to fetch a single transaction.',
          },
          min_amount: { type: 'number', description: 'Minimum transaction amount (absolute value)' },
          max_amount: { type: 'number', description: 'Maximum transaction amount (absolute value)' },
          limit: { type: 'integer', description: 'Maximum results per page (default 100)', default: 100 },
          offset: { type: 'integer', description: 'Offset for pagination (default 0)', default: 0 },
          exclude_transfers: {
            type: 'boolean',
            description:
              'Exclude internal transfers between accounts (default: true). When true, filter types=[REGULAR, INCOME, RECURRING].',
            default: true,
          },
          exclude_deleted: {
            type: 'boolean',
            description:
              'Exclude deleted transactions (default: true). No-op in live mode — the server already excludes deleted rows.',
            default: true,
          },
          exclude_excluded: {
            type: 'boolean',
            description:
              "Exclude transactions in user-excluded categories (default: true). Cross-referenced against Category.isExcluded from the local cache.",
            default: true,
          },
          exclude_split_parents: {
            type: 'boolean',
            description:
              'Must be true or omitted — the server omits split parents from the transactions query. Passing false returns an error.',
            default: true,
          },
          pending: {
            type: 'boolean',
            description: 'Filter by pending status (true=pending only, false=settled only)',
          },
          transaction_id: {
            type: 'string',
            description:
              'Get one transaction by ID — REQUIRES account_id and item_id alongside (all three come from a previous get_transactions_live result).',
          },
          query: {
            type: 'string',
            description:
              'Free-text merchant search (server-side matchString). Equivalent to passing merchant.',
          },
          transaction_type: {
            type: 'string',
            enum: ['refunds', 'credits', 'hsa_eligible', 'tagged'],
            description:
              'Filter by special type. Note: foreign and duplicates are NOT supported in live mode.',
          },
          tag: { type: 'string', description: 'Filter by tag name (resolved to tagId via local cache)' },
        },
      },
      annotations: { readOnlyHint: true },
    },
  ];
}
```

If `ToolSchema` didn't exist / wasn't easily importable, inline the type locally (copy from `src/tools/tools.ts`).

- [ ] **Step 4: Run tests — all pass**

Run: `bun test tests/tools/live/transactions.test.ts`
Expected: 19 tests PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/live/transactions.ts tests/tools/live/transactions.test.ts
git commit -m "feat(live): tool schema for get_transactions_live

Declares the MCP tool schema with the strict-subset input shape.
Description enumerates unsupported filters and the 3-ID rule per
Anthropic's tool-description guidance (4-6 sentences, explicit
limitations listed)."
```

---

## Task 10: CLI flag

**Files:**
- Modify: `src/cli.ts`
- Test: no dedicated test; indirect coverage through the integration test in Task 12.

**Context:** Add `--live-reads` to the arg parser, propagate through `runServer()`. Update help text.

- [ ] **Step 1: Modify parseArgs to recognize --live-reads**

Open `src/cli.ts`. In the `parseArgs()` function, add `liveReadsEnabled` to the return type, a local variable, and the flag-handling branch:

Change the return type:

```typescript
function parseArgs(): {
  dbPath?: string;
  verbose: boolean;
  timeoutMs?: number;
  writeFlagSeen: boolean;
  liveReadsEnabled: boolean;
} {
```

Add the variable:

```typescript
  let liveReadsEnabled = false;
```

Add the case branch inside the for loop, right after the `--write` branch:

```typescript
    } else if (arg === '--live-reads') {
      liveReadsEnabled = true;
```

Update the return statement:

```typescript
  return { dbPath, verbose, timeoutMs, writeFlagSeen, liveReadsEnabled };
```

- [ ] **Step 2: Update help text**

In the `--help` / `-h` branch, add a `--live-reads` line to the options block:

```
  --live-reads        Enable GraphQL-backed get_transactions_live (replaces cache-backed get_transactions). Requires authenticated browser session at app.copilot.money.
```

Place it directly below the `--write` line.

- [ ] **Step 3: Propagate liveReadsEnabled to runServer**

In `main()`:

```typescript
  const { dbPath, verbose, timeoutMs, writeFlagSeen, liveReadsEnabled } = parseArgs();
```

Add a verbose log:

```typescript
      if (liveReadsEnabled) {
        console.log('Live reads enabled (--live-reads)');
      }
```

(Place it right after the `writeFlagSeen` verbose log.)

Update the `runServer` call:

```typescript
    await runServer(dbPath, timeoutMs, writeFlagSeen, liveReadsEnabled);
```

The fourth argument will be added to `runServer` in Task 11.

- [ ] **Step 4: Typecheck — will show error because runServer signature not yet updated**

Run: `bun run typecheck`
Expected: FAIL with "Expected 3 arguments, but got 4" on the `runServer` call. This is OK — Task 11 fixes it.

- [ ] **Step 5: Commit the CLI changes (TDD-red intermediate state)**

```bash
git add src/cli.ts
git commit --no-verify -m "feat(cli): add --live-reads flag (WIP)

Parses --live-reads and propagates to runServer. Intermediate red
state — typecheck will fail until Task 11 extends runServer signature.
Safe to commit locally because the pre-push hook runs full check."
```

The `--no-verify` is explicitly allowed for TDD red-state local commits per the user's CLAUDE.md memory; the pre-push hook will gate the full check before the PR.

---

## Task 11: Server wiring (conditional registration, preflight, dispatch)

**Files:**
- Modify: `src/server.ts`
- Test: `tests/integration/live-reads.test.ts` (create, minimal)

**Context:** This is the central wiring. `CopilotMoneyServer` takes a new `liveReadsEnabled` flag. When set, it: (a) builds the shared `GraphQLClient` if not already built for `--write`, (b) runs `preflightLiveAuth` and exits non-zero on failure, (c) constructs `LiveCopilotDatabase` + `LiveTransactionsTools`, (d) composes the tool list to swap `get_transactions` for `get_transactions_live`, (e) routes the `get_transactions_live` call. Errors thrown from the live tool become `isError: true` results.

- [ ] **Step 1: Open src/server.ts and modify the constructor signature**

Change the class constructor from:

```typescript
  constructor(dbPath?: string, decodeTimeoutMs?: number, writeEnabled = false) {
```

to:

```typescript
  constructor(
    dbPath?: string,
    decodeTimeoutMs?: number,
    writeEnabled = false,
    liveReadsEnabled = false
  ) {
```

Add fields:

```typescript
  private liveReadsEnabled: boolean;
  private liveTools?: LiveTransactionsTools;
```

Inside the constructor, after `this.writeEnabled = writeEnabled;`:

```typescript
    this.liveReadsEnabled = liveReadsEnabled;
```

After the `if (writeEnabled) { ... }` block that builds `graphqlClient`, replace it with:

```typescript
    let graphqlClient: GraphQLClient | undefined;
    if (writeEnabled || liveReadsEnabled) {
      const auth = new FirebaseAuth(() => extractRefreshToken());
      graphqlClient = new GraphQLClient(auth);
    }
```

After `this.tools = new CopilotMoneyTools(this.db, graphqlClient);`, add:

```typescript
    if (liveReadsEnabled && graphqlClient) {
      const liveDb = new LiveCopilotDatabase(graphqlClient, this.db);
      this.liveTools = new LiveTransactionsTools(liveDb);
    }
```

Add these imports to the top of `src/server.ts`:

```typescript
import { LiveCopilotDatabase, preflightLiveAuth } from './core/live-database.js';
import {
  LiveTransactionsTools,
  createLiveToolSchemas,
} from './tools/live/transactions.js';
```

- [ ] **Step 2: Update handleListTools to swap the transactions schema**

Find `handleListTools()`. Replace its body with:

```typescript
  handleListTools(): { tools: Tool[] } {
    const readSchemas = createToolSchemas();
    const filteredReads = this.liveReadsEnabled
      ? readSchemas.filter((s) => s.name !== 'get_transactions')
      : readSchemas;
    const liveSchemas = this.liveReadsEnabled ? createLiveToolSchemas() : [];
    const allSchemas = [
      ...filteredReads,
      ...liveSchemas,
      ...(this.writeEnabled ? createWriteToolSchemas() : []),
    ];

    const tools: Tool[] = allSchemas.map((schema) => ({
      name: schema.name,
      description: schema.description,
      inputSchema: schema.inputSchema,
      annotations: schema.annotations,
    }));
    return { tools };
  }
```

- [ ] **Step 3: Add dispatch for get_transactions_live**

In `handleCallTool`, find the `switch (name)` block. Add a new case (after `case 'get_transactions':`):

```typescript
        case 'get_transactions_live':
          if (!this.liveTools) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'get_transactions_live is only available when the server runs with --live-reads.',
                },
              ],
              isError: true,
            };
          }
          result = await this.liveTools.getTransactions(
            (typedArgs as Parameters<typeof this.liveTools.getTransactions>[0]) || {}
          );
          break;
```

Validation errors thrown from `LiveTransactionsTools.getTransactions` will be caught by the existing `catch (error)` block and surfaced as `isError: true` text — which is exactly what we want.

- [ ] **Step 4: Extend runServer signature and add preflight**

At the bottom of `src/server.ts`, modify `runServer`:

```typescript
export async function runServer(
  dbPath?: string,
  decodeTimeoutMs?: number,
  writeEnabled = false,
  liveReadsEnabled = false
): Promise<void> {
  if (liveReadsEnabled) {
    try {
      const auth = new FirebaseAuth(() => extractRefreshToken());
      const client = new GraphQLClient(auth);
      await preflightLiveAuth(client);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[live-reads] preflight failed: ${msg}`);
      console.error(
        '[live-reads] ensure you are logged into app.copilot.money in your default browser, then restart.'
      );
      process.exit(1);
    }
  }

  const server = new CopilotMoneyServer(dbPath, decodeTimeoutMs, writeEnabled, liveReadsEnabled);
  await server.run();
}
```

Note that the preflight creates its own throwaway `FirebaseAuth`/`GraphQLClient` before the server constructor creates the permanent one. That's intentional — we need to run the probe *before* any `handleListTools` call could succeed, and the FirebaseAuth token is cached internally so the re-creation is cheap (browser token extracted once into memory, re-used by the permanent client for subsequent real calls... actually each FirebaseAuth instance caches independently, so this means two token exchanges at boot).

To avoid the double exchange, restructure so the auth client is built once and passed into the server:

```typescript
export async function runServer(
  dbPath?: string,
  decodeTimeoutMs?: number,
  writeEnabled = false,
  liveReadsEnabled = false
): Promise<void> {
  let graphqlClient: GraphQLClient | undefined;
  if (writeEnabled || liveReadsEnabled) {
    const auth = new FirebaseAuth(() => extractRefreshToken());
    graphqlClient = new GraphQLClient(auth);
  }

  if (liveReadsEnabled && graphqlClient) {
    try {
      await preflightLiveAuth(graphqlClient);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[live-reads] preflight failed: ${msg}`);
      console.error(
        '[live-reads] ensure you are logged into app.copilot.money in your default browser, then restart.'
      );
      process.exit(1);
    }
  }

  const server = new CopilotMoneyServer(
    dbPath,
    decodeTimeoutMs,
    writeEnabled,
    liveReadsEnabled,
    graphqlClient
  );
  await server.run();
}
```

And update the constructor signature to accept an optional injected client:

```typescript
  constructor(
    dbPath?: string,
    decodeTimeoutMs?: number,
    writeEnabled = false,
    liveReadsEnabled = false,
    injectedGraphqlClient?: GraphQLClient
  ) {
    this.db = new CopilotDatabase(dbPath, decodeTimeoutMs);
    this.writeEnabled = writeEnabled;
    this.liveReadsEnabled = liveReadsEnabled;

    let graphqlClient = injectedGraphqlClient;
    if ((writeEnabled || liveReadsEnabled) && !graphqlClient) {
      const auth = new FirebaseAuth(() => extractRefreshToken());
      graphqlClient = new GraphQLClient(auth);
    }
    // ... rest unchanged
```

- [ ] **Step 5: Run full typecheck + tests**

Run: `bun run check`
Expected: PASS. If there are type errors about `this.liveTools` possibly being undefined in the dispatch, the undefined guard added in Step 3 covers it — confirm with the compiler.

- [ ] **Step 6: Write a minimal integration test**

Create `tests/integration/live-reads.test.ts`:

```typescript
import { describe, test, expect, mock } from 'bun:test';
import { CopilotMoneyServer } from '../../src/server.js';
import { GraphQLClient } from '../../src/core/graphql/client.js';
import type { CopilotDatabase } from '../../src/core/database.js';

describe('CopilotMoneyServer with --live-reads', () => {
  test('swaps get_transactions for get_transactions_live in handleListTools', () => {
    const mockClient = {
      mutate: mock(),
      query: mock(() =>
        Promise.resolve({
          transactions: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } },
        })
      ),
    } as unknown as GraphQLClient;

    const server = new CopilotMoneyServer(undefined, undefined, false, true, mockClient);
    const { tools } = server.handleListTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('get_transactions_live');
    expect(names).not.toContain('get_transactions');
  });

  test('registers get_transactions (not _live) when --live-reads is off', () => {
    const server = new CopilotMoneyServer();
    const { tools } = server.handleListTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('get_transactions');
    expect(names).not.toContain('get_transactions_live');
  });

  test('handleCallTool returns isError when live tool not registered', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('get_transactions_live', {});
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 7: Run integration tests**

Run: `bun test tests/integration/live-reads.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 8: Full check**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/server.ts tests/integration/live-reads.test.ts
git commit -m "feat(server): wire --live-reads flag end-to-end

- CopilotMoneyServer accepts liveReadsEnabled; builds
  LiveCopilotDatabase + LiveTransactionsTools when set
- handleListTools swaps get_transactions → get_transactions_live
- handleCallTool routes get_transactions_live to the live path
- runServer runs preflightLiveAuth before constructing the server;
  exits 1 with descriptive stderr on failure (refuses to register a
  dead tool)
- GraphQLClient built once and injected to avoid double token
  exchange between preflight and runtime"
```

---

## Task 12: Update docs/graphql-capture/operations/queries/Transactions.md

**Files:**
- Modify: `docs/graphql-capture/operations/queries/Transactions.md`

**Context:** The existing capture doc used an older observed variable shape (`{isReviewed:false}`). The 2026-04-23 Chrome capture revealed the real `TransactionFilter` and `TransactionSort` shapes. Document them so the next phase doesn't have to re-probe.

- [ ] **Step 1: Append the real input-type shapes to the doc**

Open `docs/graphql-capture/operations/queries/Transactions.md`. At the end of the file, append:

```markdown

## TransactionFilter shape (captured 2026-04-23 via Chrome DevTools)

Captured from live web-UI network traffic. Supersedes earlier
"captured variables" section.

| Field | Type | Notes |
|-------|------|-------|
| `dates` | `[DateRangeInput!]` | Array of `{ from, to }` where both are `YYYY-MM-DD`. Multiple ranges permitted. |
| `accountIds` | `[AccountRefInput!]` | Array of `{ accountId, itemId }` — compound IDs. Not a flat string array. |
| `categoryIds` | `[ID!]` | Flat array of opaque string IDs. |
| `recurringIds` | `[ID!]` | Flat array of opaque string IDs. |
| `tagIds` | `[ID!]` | Flat array of opaque string IDs. |
| `types` | `[TransactionType!]` | Enum: `REGULAR | INCOME | INTERNAL_TRANSFER | RECURRING`. Note: `RECURRING` is not in the write-side `TransactionType` enum. |
| `isReviewed` | `Boolean` | `true` = reviewed, `false` = not reviewed. |
| `matchString` | `String` | Full-text match against merchant name. Used internally by the "similar transactions" panel; not exposed in UI filters. |

## TransactionSort shape

```graphql
input TransactionSort {
  field: TransactionSortField!   # DATE | AMOUNT
  direction: SortDirection!      # ASC | DESC
}
```

Passed as `sort: [TransactionSort!]`. The web UI default is
`[{field: DATE, direction: DESC}]`.

## Related operation — transactionsFeed

The web UI uses `transactionsFeed(...)` (aliased as `feed:`) with an
extra `$month: Boolean = false` variable that groups results by month
in the response. `transactions` returns the plainer
`TransactionPagination` shape and is the query the MCP live-reads
path uses. Both accept the same `TransactionFilter`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/graphql-capture/operations/queries/Transactions.md
git commit -m "docs(graphql): real TransactionFilter + TransactionSort shapes

Documents the shapes captured from live Chrome DevTools traffic on
2026-04-23. Supersedes the earlier snippet that only showed
{isReviewed: false}. Also notes transactionsFeed as the alternate
UI query we deliberately didn't use."
```

---

## Task 13: Create operator-facing docs/graphql-live-reads.md

**Files:**
- Create: `docs/graphql-live-reads.md`

- [ ] **Step 1: Write the operator doc**

Create `docs/graphql-live-reads.md`:

```markdown
# GraphQL Live Reads

The `--live-reads` CLI flag swaps the cache-backed `get_transactions` MCP tool for a GraphQL-backed `get_transactions_live` that reads directly from Copilot's web API. Use it when the local LevelDB cache is missing data for the window you need — most commonly for historical reconciliation like `/amazon-sync` on older years.

This is Phase 1 of a progressive migration off LevelDB. See `docs/superpowers/specs/2026-04-23-graphql-live-reads-design.md` for the full roadmap.

## Starting with live reads

```bash
copilot-money-mcp --live-reads
# or alongside writes
copilot-money-mcp --write --live-reads
```

Prerequisites:
- You must be logged into `app.copilot.money` in Chrome, Arc, Safari, or Firefox. The MCP extracts a Firebase refresh token from browser storage.
- Network connectivity to `app.copilot.money`.

If auth fails at boot, the server logs a diagnostic line to stderr and exits non-zero. Claude Desktop will show the transport as closed; check the MCP server logs for the explanation.

## What changes when `--live-reads` is on

| Aspect | `--live-reads` off (default) | `--live-reads` on |
|---|---|---|
| Tool name | `get_transactions` | `get_transactions_live` |
| Data source | Local LevelDB cache | Copilot GraphQL API |
| Freshness | Hydrated by the Copilot macOS app as the user scrolls | Live — always matches what the web UI sees |
| Location filters (`city`, `lat`, `lon`, `region`, `country`, `radius_km`) | Supported | **Not supported** (GraphQL has no location fields) |
| `transaction_type: foreign | duplicates` | Supported | **Not supported** |
| `exclude_split_parents: false` | Supported | **Not supported** (server omits parents) |
| `transaction_id` single lookup | Requires only the ID | Requires `transaction_id` + `account_id` + `item_id` |
| Auth required | No | Yes |

Every unsupported filter produces an error message telling the LLM to retry without that parameter — it doesn't silently drop.

## Filter reference for `get_transactions_live`

### Server-side filters (fast)

These translate into Copilot's `TransactionFilter` and run on the server:

- `start_date`, `end_date`, `period` → `filter.dates: [{from, to}]`
- `account_id` → `filter.accountIds: [{accountId, itemId}]` (itemId resolved from local account cache)
- `category` (as ID) → `filter.categoryIds: [id]`
- `tag` (by name) → resolved via local tag cache → `filter.tagIds: [id]`
- `merchant` or `query` → `filter.matchString` (substring match against name)
- `exclude_transfers: true` → `filter.types: [REGULAR, INCOME, RECURRING]`

### Client-side post-filters (applied after pagination)

These run on pages of results as they return, because GraphQL doesn't support them server-side:

- `min_amount` / `max_amount` — absolute-value comparison
- `pending` — filter on the `isPending` flag
- `exclude_excluded` — cross-reference against `Category.isExcluded` from the local cache
- `transaction_type: refunds | credits | hsa_eligible | tagged`
- `limit`, `offset` — applied to the full result set after filtering

### `exclude_deleted` / `exclude_split_parents: true`

Both are no-ops in live mode. The GraphQL server doesn't return deleted or split-parent rows in the Transactions query, so there's nothing to filter out on the client.

## Errors and what they mean

All errors surface as `isError: true` tool results.

- `"Parameter 'city' is not supported in live mode. Retry without 'city'. Supported filters: ..."` — LLM should drop the filter and retry.
- `"transaction_id lookup in live mode requires account_id and item_id."` — call get_transactions_live with all three; they're returned together by any prior list call.
- `"Network error reaching Copilot GraphQL API."` — transient; the tool already retried once. Try again or check connectivity.
- `"Authentication expired or invalid."` — re-open `app.copilot.money` in your browser to refresh the token, then restart the MCP server.
- `"GraphQL schema error (bug in copilot-money-mcp): ..."` — Copilot changed its API. File an issue.
- `"Server rejected request: <message>"` — the server returned a validation error like "Tag name must be unique" or "Account not found".

## Migration roadmap

`_live` suffix is transitional. When every cache-backed read tool has a GraphQL-backed equivalent and measurement shows live reads are fast enough, a future release will flip `--live-reads` on by default and rename `get_<entity>_live` → `get_<entity>`, retiring the flag.

Current phase: **1** — only `get_transactions_live`. Phases 2..N will add `_live` variants for accounts, categories, budgets, recurring transactions, and tags.

## Performance note

GraphQL reads paginate server-side (page size 100 by default). Narrow queries (e.g. one month of one account) typically run in <1s. Broad queries (full year, no account filter) paginate multiple pages — the server has limits on single-response size. When `--verbose` is set, the server logs per-call latency and pagination counts to stderr as `[graphql-read] op=Transactions pages=N latency=Xms rows=Y`. This data informs whether future phases need a richer caching strategy.
```

- [ ] **Step 2: Commit**

```bash
git add docs/graphql-live-reads.md
git commit -m "docs: operator-facing reference for --live-reads

Explains what --live-reads does, how to start the server, the
differences between get_transactions and get_transactions_live,
every supported/unsupported filter, error messages and their
meanings, and the migration roadmap."
```

---

## Task 14: Update CLAUDE.md with --live-reads hint

**Files:**
- Modify: `CLAUDE.md`

**Context:** Short hint so future Claude Code sessions on this repo know the flag exists.

- [ ] **Step 1: Add a short note**

Open `CLAUDE.md`. Find the "CLI entry point with --db-path and --write options" description of `src/cli.ts` in the project structure section. Update it to:

```
├── cli.ts              # CLI entry point with --db-path, --write, --live-reads options
```

Find the "Read-only by Default" section. Append after it:

```
- **Live Reads (Opt-in)**: `--live-reads` swaps cache-backed `get_transactions` for GraphQL-backed `get_transactions_live`. See `docs/graphql-live-reads.md`. Requires browser session auth.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): note --live-reads in project overview"
```

---

## Task 15: Final verification and acceptance

**Files:** no changes; runs full test suite and manual acceptance.

- [ ] **Step 1: Run the full check**

Run: `bun run check`
Expected: PASS on typecheck, lint, format, and all tests.

- [ ] **Step 2: Verify the test count increased as expected**

Run: `bun test 2>&1 | tail -20`
Expected: Output includes the new test files (`transactions.test.ts` in queries, `live-database.test.ts`, `live/transactions.test.ts`, `integration/live-reads.test.ts`). All new tests PASS. Total test count is strictly greater than the pre-task count.

- [ ] **Step 3: Build the bundle and confirm no packaging breakage**

Run: `bun run build`
Expected: Clean build, no errors.

Run: `bun run sync-manifest`
Expected: `manifest.json` unchanged — the live tool only appears when the flag is on, and the manifest reflects the static (no-flag) surface.

- [ ] **Step 4: Manual acceptance — amazon-sync for 2025**

This is a human-in-the-loop verification; the implementation agent should stop here and report.

Manual command for the maintainer:

```bash
bun run dev --write --live-reads --verbose
```

Then in Claude Desktop or another MCP client, invoke `get_transactions_live` with `query: "amazon"`, `start_date: "2025-01-01"`, `end_date: "2025-12-31"`. Expected: count > 0, transactions span the whole year, pagination log lines appear on stderr.

If count = 0, debug by running the probe script (`scripts/probe-transactions-live.ts` from the spec — not in this plan but easy to cut). If count > 0 but far below the Amazon CSV's shipment count (~223 in the 2026-04-22 test case), check whether `matchString` is doing substring match and whether merchant names in the user's data use "Amazon", "Amazon.com", "AMZN MKTP" etc.

- [ ] **Step 5: Push the branch and open a PR**

Only after the maintainer confirms Step 4 succeeds:

```bash
git push -u origin feat/graphql-live-reads-spec
gh pr create --title "feat: GraphQL live reads (phase 1) — get_transactions_live" --body "$(cat <<'EOF'
## Summary

- Ships `--live-reads` CLI flag that swaps cache-backed `get_transactions` for a GraphQL-backed `get_transactions_live` tool
- Introduces `LiveCopilotDatabase` — the architectural layer later phases will extend to migrate every read tool off LevelDB
- Adds auth preflight at boot (exits non-zero if auth fails rather than registering a dead tool)
- All errors surface as `isError: true` tool results with actionable retry text; no silent fallback to cache
- Fully documented operator-facing surface in `docs/graphql-live-reads.md`

## Test plan
- [ ] `bun run check` passes (typecheck, lint, format, all tests)
- [ ] Unit tests cover buildFilter, buildSort, paginateTransactions, fetchTransactionsPage
- [ ] Unit tests cover LiveCopilotDatabase (memo, retry, getTransactions, preflight)
- [ ] Unit tests cover LiveTransactionsTools (validation, translation, post-filter, enrichment, schema)
- [ ] Integration test verifies CopilotMoneyServer swaps tools based on flag
- [ ] Manual acceptance: run with --write --live-reads, call get_transactions_live for 2025 Amazon transactions, confirm count matches Amazon CSV shipments (fixing the 2026-04-22 /amazon-sync 0-match bug)

See `docs/superpowers/specs/2026-04-23-graphql-live-reads-design.md` for the full design spec and the multi-phase roadmap this is step one of.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

Spec coverage check — every spec section has a corresponding task:

- Background / Goals / Non-goals → Task 12 (capture docs) + Task 13 (operator docs) + Task 14 (CLAUDE.md)
- Migration roadmap → Task 13
- Architecture: file layout → every task creates its files
- Architecture: LiveCopilotDatabase class → Tasks 4, 5
- Architecture: Live tool class → Tasks 7, 8
- Architecture: Server wiring → Task 11
- Data flow (10 numbered steps in spec) → Tasks 2 (filter), 3 (sort/paginate), 5 (getTransactions entry), 7/8 (validation, translation, post-filter, enrichment), 11 (dispatch)
- Error handling + retry → Task 4 (withRetry), Task 7 (validation errors), Task 11 (isError catch)
- Auth preflight → Task 6 (function), Task 11 (integration)
- Testing → every task includes tests; Task 11 adds integration test; Task 15 is final verification
- Scope boundaries / out-of-scope → documented in spec; no task needed
- Breaking changes → documented in Task 13 (operator doc)
- Open probes → Task 15 Step 4 (manual acceptance path)

Placeholder scan — none of the "no placeholders" patterns appear in the plan above. Every code step shows actual code.

Type consistency check — `GetTransactionsLiveOptions`, `EnrichedTransaction`, `GetTransactionsLiveResult`, `TransactionFilterInput`, `TransactionSortInput`, `AccountRef`, `DateRange`, `ReadTransactionType`, `TransactionNode`, `TransactionsPage` are used consistently across tasks; `LiveCopilotDatabase.getTransactions` accepts `BuildFilterOptions & { sort?, pageSize? }` in Task 5 and is called with that shape in Task 8. `LiveTransactionsTools.getTransactions` signature is the same in Tasks 7 and 8.
