# Hidden Copilot Money Mutations

Mutations discovered on Copilot's GraphQL endpoint (`https://app.copilot.money/api/graphql`) that the web-session capture never observed. Surfaced by error-leak recon (see [`introspection-recon.md`](./introspection-recon.md)).

Signatures below reflect only what the server confirmed via validation errors. Optional input fields and non-required output fields may exist but are hidden by Apollo's error suppression — "unknowns" are called out per mutation.

## Summary

| Mutation | MCP tool yet? | Risk | Primary use |
|---|---|---|---|
| [`splitTransaction`](#splittransaction) | ❌ | medium (reversal via edit/delete) | Split one transaction into N children |
| [`createTransaction`](#createtransaction) | ❌ | medium | Manual-account transactions |
| [`deleteTransaction`](#deletetransaction) | ❌ | high (destructive) | Remove a transaction |
| [`addTransactionToRecurring`](#addtransactiontorecurring) | ❌ | low | Attach one-off to existing recurring |
| [`bulkEditTransactions`](#bulkedittransactions) | ❌ | **DO NOT PROBE** blindly | Edit many transactions at once |
| [`bulkDeleteTransactions`](#bulkdeletetransactions) | ❌ | **high (destructive)** | Delete many transactions |
| [`createAccount`](#createaccount) | ❌ | medium | Manual account creation |
| [`deleteAccount`](#deleteaccount) | ❌ | high (cascades to all txns) | Remove a manual account |
| [`deleteUser`](#deleteuser) | ❌ | **existential** | Delete the entire user account |

No other hidden mutations surfaced across the ~460-candidate sweep (see `scripts/recon/probe-mutations-wide.ts`).

## Budget mutations — finding

**No hidden budget mutations exist.** Budget CRUD is entirely captured by `editBudget(categoryId, input)` and `editBudgetMonthly(categoryId, input)` — Copilot treats a budget as an *attribute of a category*, not a separate entity. No `createBudget`, `deleteBudget`, `resetBudget`, or `rolloverBudget` exist on the server. "Removing" a budget is done by calling `editBudget` with the appropriate zero/null amount.

## Goal mutations — finding

**No goal mutations exist on the GraphQL endpoint.** Probes for `createGoal`, `editGoal`, `deleteGoal`, `archiveGoal`, `contributeToGoal`, `transferToGoal` all returned "Cannot query field". Goals are read-only via this API — any changes go through a different channel (likely direct Firestore writes from the iOS app).

---

## splitTransaction

Signature:

```graphql
mutation SplitTransaction(
  $itemId:    ID!
  $accountId: ID!
  $id:        ID!                         # parent transaction's ID
  $input:     [SplitTransactionInput!]!   # one entry per child split
) {
  splitTransaction(itemId: $itemId, accountId: $accountId, id: $id, input: $input) {
    parentTransaction  { id }             # original, "hidden" after split
    splitTransactions  { id }             # new child docs
  }
}

input SplitTransactionInput {
  name:       String!   # display name per split (e.g. "Rent", "Hotel")
  date:       Date!     # typically matches parent.date
  amount:     Float!    # children must sum to parent.amount (server enforces)
  categoryId: ID!       # required per split
}
```

**Return shape:** `SplitTransactionOutput!` has exactly two fields: `parentTransaction: Transaction!` and `splitTransactions: [Transaction!]!`.

**Unknowns:** optional fields on `SplitTransactionInput` (tags, notes, isReviewed, etc. all rejected as "not defined" — the server really does only accept the four required fields at split time). Downstream edits require per-child `editTransaction` calls.

**How splits manifest in Firestore (for the cache):** after success, the parent doc gets `children_transaction_ids: [...]` with the new child IDs and `category_id: ""` + `old_category_id: <original>`. Each child doc gets `parent_transaction_id: <parent>`. This is what the Phase 1 decoder work (PR #315) surfaces to MCP consumers.

**Reversal:** no dedicated mutation. Probes for `unsplitTransaction`, `revertSplit`, `undoSplit` all "Cannot query field". To undo a split, callers would delete each child (via `deleteTransaction`) and then edit the parent to restore its category — but Copilot's UI also supports reverting via "edit split → remove all entries".

---

## createTransaction

```graphql
mutation CreateTransaction(
  $itemId:    ID!
  $accountId: ID!
  $input:     CreateTransactionInput!
) {
  createTransaction(itemId: $itemId, accountId: $accountId, input: $input) {
    id
    # Transaction fields per existing TransactionFields fragment
  }
}

input CreateTransactionInput {
  name:       String!
  date:       Date!
  amount:     Float!
  categoryId: ID!
  type:       TransactionType!   # enum — values unknown, needs probe
  # Optional fields unknown
}
```

**Unknowns:**
- `TransactionType` enum values — Copilot UI allows manual transactions to be "expense", "income", or "transfer" so those are likely candidates. Confirm by sending an invalid value and harvesting the "must be one of" list.
- Optional input fields (notes, tags, isReviewed, etc.).

**Intended use:** This is what Copilot uses when the user adds a manual transaction to a manual account. Plaid-connected accounts should not be written to this way — they'd be overwritten on the next sync.

---

## deleteTransaction

```graphql
mutation DeleteTransaction($itemId: ID!, $accountId: ID!, $id: ID!) {
  deleteTransaction(itemId: $itemId, accountId: $accountId, id: $id)   # Boolean!
}
```

Returns `Boolean!`. **Destructive — no soft-delete.** Firestore picks up the removal and Copilot's clients stop rendering it.

**Caveat:** probably idempotent-safe on Plaid transactions (Plaid re-syncs and the transaction comes back on next refresh) but this hasn't been confirmed.

---

## addTransactionToRecurring

```graphql
mutation AddTransactionToRecurring(
  $itemId:    ID!
  $accountId: ID!
  $id:        ID!                          # transaction ID to attach
  $input:     AddTransactionToRecurringInput!
) {
  addTransactionToRecurring(itemId: $itemId, accountId: $accountId, id: $id, input: $input) {
    # AddTransactionToRecurringOutput fields unknown
  }
}

input AddTransactionToRecurringInput {
  recurringId: ID!      # required
  # Optional fields unknown
}
```

**Use case:** manually link a one-off transaction to an existing recurring series that Copilot's auto-detection missed (e.g., a rent transaction that didn't match the existing rent recurring).

---

## bulkEditTransactions

```graphql
mutation BulkEditTransactions($input: BulkEditTransactionInput!) {
  bulkEditTransactions(input: $input) {
    # BulkEditTransactionsOutput fields unknown
  }
}
```

**⚠ Do not probe with empty input.** A probe with `input: {}` caused the server to execute a real SQL query (`select "item_id", "account_id", "transaction_id" from "transactions" where ...`) with ~48 placeholders before failing. The full input shape is unknown and reverse-engineering it via error leak is not safe against a live account.

**Intended use:** batch apply the same change (category, tags, reviewed state) to many transactions in one call. Likely what Copilot's iOS "select many → edit" UI uses.

**How to reverse-engineer safely:** iOS traffic capture, or set up a disposable test account and probe against it.

---

## bulkDeleteTransactions

```graphql
mutation BulkDeleteTransactions(/* args unknown */) {
  bulkDeleteTransactions {
    # BulkDeleteTransactionsOutput fields unknown
  }
}
```

Confirmed to exist (returns `BulkDeleteTransactionsOutput!`) but neither argument shape nor output fields are known. Given the risk profile, we didn't probe further.

---

## createAccount

```graphql
mutation CreateAccount(/* required args unknown */) {
  createAccount {
    # Returns Account!
  }
}
```

Confirmed to exist and return `Account!`. Intended for manual account creation (the "Add account → Manual" flow in Copilot's UI).

---

## deleteAccount

```graphql
mutation DeleteAccount($itemId: ID!, /* other args unknown */) {
  deleteAccount(itemId: $itemId /* ... */)   # returns ID!
}
```

Confirmed to exist, returns `ID!` (presumably the deleted account's ID). Only `itemId` is confirmed required.

**Destructive:** deleting an account likely cascades to its transactions.

---

## deleteUser

```graphql
mutation DeleteUser($confirm: Boolean!) {
  deleteUser(confirm: $confirm)   # Boolean!
}
```

**⚠⚠ Existential — deletes the user's entire Copilot account.** Surfaced by the brute-force sweep; listed here for completeness and as a warning. The `confirm: Boolean!` guard is the only protection — do not expose this via any MCP tool without a multi-step confirmation gate.

---

## What the web-session capture already knows

These are in `docs/graphql-capture/operations/mutations/` — confirmed by real traffic, not recon:

`CreateCategory`, `CreateRecurring`, `CreateTag`, `DeleteCategory`, `DeleteRecurring`, `DeleteTag`, `EditAccount`, `EditBudget`, `EditBudgetMonthly`, `EditCategory`, `EditRecurring`, `EditTag`, `EditTransaction`, `EditUser`.
