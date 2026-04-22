# Test-agent prompts for recon verification

Copy these into an Agent call when you want an independent verification that the signatures in [`hidden-mutations.md`](./hidden-mutations.md) still hold against the live endpoint. Each prompt is self-contained (no shared state), so multiple agents can run in parallel.

The agents only probe — they never execute a real mutation. Every call uses a fake ID (`__does_not_exist__`) so validation stops the request before any write.

---

## Agent 1 — splitTransaction signature re-verification

**Role:** verify that the `splitTransaction` mutation still accepts the signature documented in `docs/graphql-capture/hidden-mutations.md`.

**Scope:** read-only probes via the Firebase-authenticated GraphQL client.

**Task:**

1. Use `src/core/auth/firebase-auth.ts` + `src/core/auth/browser-token.ts` to get an ID token. Do not write any new auth code — use what the MCP already uses.
2. POST to `https://app.copilot.money/api/graphql` with these six probes (all with `operationName: "Probe"`):

   a. `mutation Probe { splitTransaction }` — expect four "argument X of type Y is required" errors naming `itemId: ID!`, `accountId: ID!`, `id: ID!`, `input: [SplitTransactionInput!]!`.

   b. `mutation Probe { splitTransaction(itemId: "x", accountId: "x", id: "x", input: [{}]) { __typename } }` — expect four required-field errors on `SplitTransactionInput`: `name: String!`, `date: Date!`, `amount: Float!`, `categoryId: ID!`.

   c. `mutation Probe { splitTransaction(itemId: "x", accountId: "x", id: "x", input: [{name:"x", date:"2026-01-01", amount:1.0, categoryId:"x"}]) { parentTransaction { id } } }` — expect "Transaction not found" (i.e. args valid, server rejected at data-layer).

   d. Same as (c) but with `splitTransactions { id }` instead — also expect "Transaction not found".

   e. Same as (c) but with `__nonexistent__` subfield — expect "Cannot query field '\_\_nonexistent\_\_' on type 'SplitTransactionOutput'".

   f. Try one optional input field that shouldn't exist: `splitTransaction(..., input: [{name:"x", date:"2026-01-01", amount:1.0, categoryId:"x", tagIds:["t"]}]) { __typename }` — expect "Field 'tagIds' is not defined by type 'SplitTransactionInput'".

3. Report PASS/FAIL for each probe, with the actual first-error message from the server.

**Constraints:**
- No `edit*`, `create*`, `delete*` calls. Only `Probe` with fake IDs.
- If an unexpected response appears (e.g. `id: "x"` actually matches a real ID), stop immediately and report the discrepancy.

**Output:** markdown table with probe letter, expected, actual, and verdict.

---

## Agent 2 — mutation enumeration via "Did you mean"

**Role:** confirm the list of mutations in `hidden-mutations.md` is still current, and surface any new ones that have appeared.

**Scope:** read-only.

**Task:**

1. Send these 8 deliberately-misspelled mutation probes (each via `operationName: "Probe"`, body `mutation Probe { <name> }`):
   - `splitTransactions` (plural of real one)
   - `editTransactionSplit`
   - `createTransactionSplit`
   - `addTransactionChild`
   - `createChildTransaction`
   - `bulkEditTransaction` (singular of real bulk one)
   - `partitionTransaction`
   - `divideTransaction`

2. From each "Did you mean X, Y, Z" response, collect the suggested names into a single deduped set.

3. Compare against the known set (from `hidden-mutations.md` + `docs/graphql-capture/schema/operations.md`). Report any name that appears in the suggestions but is NOT in the known set — those are newly-discovered mutations to document.

4. For each new name, send one follow-up probe (`mutation Probe { <newName> }`) and report its return type from the subfield-selection or required-arg error.

**Output:** (a) union of known + newly-discovered names, (b) for each new name, the probe response verbatim.

---

## Agent 3 — TransactionType enum values

**Role:** fill one of the documented gaps — the `TransactionType!` enum values required by `createTransaction`.

**Scope:** read-only.

**Task:**

1. Send:
   ```graphql
   mutation Probe {
     createTransaction(
       itemId: "__does_not_exist__"
       accountId: "__does_not_exist__"
       input: { name: "x", date: "2026-01-01", amount: 1.0, categoryId: "x", type: INVALID_PROBE_VALUE }
     ) { id }
   }
   ```

   (Don't use a name starting with `__` — GraphQL reserves double-underscore for introspection types, and Apollo will reject the name itself before enum validation runs.)

2. Expected: a response whose error message names the real `TransactionType` enum values. Exact phrasing is not guaranteed — could be "Value 'INVALID_PROBE_VALUE' does not exist in 'TransactionType' enum", "Expected type 'TransactionType'", or similar, possibly with a "Did you mean …" suggesting valid values. If the error contains a quoted list of candidates, those are the real enum members.

3. Report every enum value the error surfaces. Do **not** assume the values are `expense`/`income`/`transfer` or any other specific set — only trust what the server actually returns.

4. For each value, send a follow-up probe using that value as `type` and `__does_not_exist__` for all IDs. Expected: "Account not found" or similar data-layer error (confirming the type was accepted). Report which values the server accepts.

**Output:** the full list of `TransactionType` enum values.

---

## Agent 4 — query + subscription recon

**Role:** extend the methodology beyond mutations to `Query` and `Subscription` root types.

**Scope:** read-only.

**Task:**

All probes in this agent run under the user's own Firebase token. Even if an admin/debug query exists, the server will enforce row-level authorization — the probe reveals the *shape* of the API surface, not privileged data. "Admin" names in the candidate list below are there because they're common GraphQL conventions, not because we expect them to return anything the user isn't already authorized to see.

1. Run a 50-candidate brute force against `query Probe { <candidate> }` for names like `adminStats`, `healthCheck`, `debugUser`, `internalQueue`, `transactionCount`, `userActivity`, `auditLog`, etc. Harvest any that return "required argument" or "subfield selection" errors (meaning exists). Ignore ones with "Cannot query field" (don't exist).

2. Do the same for `subscription Probe { <candidate> }`. Candidates: `transactionAdded`, `transactionUpdated`, `accountBalanceChanged`, `itemStatusChanged`, `notificationReceived`, `budgetAlert`, etc.

3. Any hit on subscriptions is especially interesting — subscriptions imply real-time push channels we might use for MCP.

**Output:** alphabetical list of (a) confirmed hidden queries and (b) confirmed subscriptions, each with the return-type name from the error message.

---

## Running agents in parallel

In a Claude Code session, dispatch all four at once via multiple `Agent` tool calls in one message. They don't share state so there's no ordering requirement.

After they finish, fold new findings back into `hidden-mutations.md` and update this file's "last verified" date.

**Last verified:** 2026-04-22 (initial publish)
