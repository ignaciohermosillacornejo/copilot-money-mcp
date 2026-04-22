# GraphQL Introspection Recon

How we discover mutations and their signatures when the server has introspection disabled (as Copilot's production server does).

## Why this matters

The web-session capture (`docs/graphql-capture/flows/01-web-session.md`) shows only operations the web app actually fires. The iOS app and any admin/internal tooling use additional operations the web capture never sees. `splitTransaction` is one such operation: the web app doesn't expose splits, but the mutation exists on the server and is reachable with a normal user token.

Closing this gap without iOS traffic capture requires **error-leak recon**: deliberate invalid queries whose error responses reveal real field and type names.

## Rules of engagement (read-only by construction)

- **Never send a syntactically complete mutation with real IDs.** Validation failures happen before execution; an invalid query mutates nothing.
- **Always use fake IDs** (e.g. `__does_not_exist__`). If the mutation gets past argument validation and hits the data layer, a fake ID fails the ownership/existence check and rolls back before any write.
- **One exception**: `bulkEditTransactions(input: {})` leaked a SQL error with ~48 parameter placeholders, suggesting it *does* hit the data layer with an unvalidated empty input. **Do not probe this mutation with any non-trivial input** without setting up an isolated test account.
- Each probe is a standalone GraphQL request authenticated with the user's own Firebase token (same auth path the MCP already uses). No traffic to third parties; everything goes to `app.copilot.money/api/graphql`.

## Technique 1 — "Did you mean" enumeration

When you query a non-existent field on `Mutation`, Apollo responds with:

```json
{ "errors": [{
  "message": "Cannot query field \"splitTransactions\" on type \"Mutation\". Did you mean \"splitTransaction\", \"editTransaction\", \"bulkEditTransactions\", \"deleteTransaction\", or \"createTransaction\"?"
}]}
```

Each "Did you mean" list contains up to 5 real mutation names that are edit-distance-close to the query. Probe with a deliberately fake name and harvest the suggestions. Candidates that worked for us:

| Probe | Leaked mutations |
|---|---|
| `splitTransactions` | `splitTransaction`, `editTransaction`, `bulkEditTransactions`, `deleteTransaction`, `createTransaction` |
| `editTransactionSplit` | `editTransaction`, `bulkEditTransactions`, `splitTransaction`, `deleteTransaction` |
| `addTransactionChild` | `addTransactionToRecurring` |
| `createChildTransaction` | `createTransaction`, `deleteTransaction`, `editTransaction` |

The actual probe script lived in `/tmp/` during investigation and wasn't committed — see the "How to re-run the recon" section below for a minimal reproducer.

## Technique 2 — required-arg enumeration

If a mutation exists, the error for "no args" lists every required argument by name + type:

```
Field "splitTransaction" argument "itemId" of type "ID!" is required, but it was not provided.
Field "splitTransaction" argument "accountId" of type "ID!" is required, but it was not provided.
Field "splitTransaction" argument "id" of type "ID!" is required, but it was not provided.
Field "splitTransaction" argument "input" of type "[SplitTransactionInput!]!" is required, but it was not provided.
```

Send `mutation Probe { candidateName }` — the response enumerates every required arg. Optional args are invisible this way (see Technique 4).

## Technique 3 — input-type required fields

Provide an empty input and the server enumerates the required input-type fields:

```
mutation Probe {
  splitTransaction(itemId: "x", accountId: "x", id: "x", input: [{}])
    { __typename }
}
```

```
Field "SplitTransactionInput.name" of required type "String!" was not provided.
Field "SplitTransactionInput.date" of required type "Date!" was not provided.
Field "SplitTransactionInput.amount" of required type "Float!" was not provided.
Field "SplitTransactionInput.categoryId" of required type "ID!" was not provided.
```

## Technique 4 — "unknown field" enumeration

If `Did you mean` doesn't fire for a suggestion on the input type, the error just confirms the field doesn't exist:

```
Field "tagIds" is not defined by type "SplitTransactionInput".
```

This means Apollo is configured to not leak optional field names. You can still brute-force candidates by trying common names one at a time — each returns "not defined" if absent, or "OK/typed-error" if present.

## Technique 5 — output-type field discovery

Apollo rejects unknown subfields:

```
Cannot query field "__nonexistent__" on type "SplitTransactionOutput".
```

but does **not** list valid ones. Output fields must be enumerated by probing one candidate at a time. Common shapes we tried for `SplitTransactionOutput`:

| Candidate | Result |
|---|---|
| `transaction` / `transactions` | nonexistent |
| `parentTransaction` | **exists** (object, needs subselection) |
| `splitTransactions` | **exists** (list) |
| `id` / `success` / `errors` / `edges` / `node` / `data` | nonexistent |

`parentTransaction` and `splitTransactions` both require subselection, which means they're object types — safe to assume they're `Transaction` (confirmed via the existing `fragment TransactionFields`).

## Remaining gaps

Fields still unknown even after recon:

1. **Optional input fields** on every discovered input type. Apollo doesn't leak them. Needs either iOS traffic capture or brute-force name guessing.
2. **Arg signatures** for `createAccount` and `deleteAccount` (beyond the required ones) — we know they exist and what they return but haven't fully walked their inputs.
3. **Full `BulkEditTransactionInput` shape** — we refuse to probe with empty input because that path does not short-circuit at validation (see the "Rules of engagement" caveat above). Need iOS traffic to reverse.
4. **Full `CreateTransactionInput` optional fields** — required ones known (`name`, `date`, `amount`, `categoryId`, `type: TransactionType!`); optional unknown.
5. **Queries**. This recon only covered `Mutation`. Copilot's server likely has unpublished queries too (e.g. admin/debug). Run the same sweep against `query Probe { ... }` instead of `mutation`.
6. **Subscriptions**. GraphQL subscriptions for real-time updates may exist. Probe `subscription Probe { ... }` with candidate names.
7. **The `TransactionType` enum**. Known to exist (required on `createTransaction`) but values unknown. Send invalid values and harvest from the "must be one of X, Y, Z" error.

## How to re-run the recon

The probe scripts live in `/tmp/` in the developer's machine during investigation — they're intentionally throwaway since the signatures change infrequently. Minimal reproducer:

```ts
import { FirebaseAuth } from 'src/core/auth/firebase-auth.ts';
import { extractRefreshToken } from 'src/core/auth/browser-token.ts';

const auth = new FirebaseAuth(() => extractRefreshToken());
const idToken = await auth.getIdToken();

const res = await fetch('https://app.copilot.money/api/graphql', {
  method: 'POST',
  headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    operationName: 'Probe',
    query: `mutation Probe { theCandidateName }`,
  }),
});
console.log(await res.text());
```

If the response contains `Cannot query field`, the mutation doesn't exist. Anything else — required-arg message, subfield-selection message, "Did you mean" — means it exists. Harvest the type names from the error and feed them back in to walk the schema.
