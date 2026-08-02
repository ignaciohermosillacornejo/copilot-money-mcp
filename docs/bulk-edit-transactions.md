# Bulk-editing transactions

Copilot exposes a native bulk mutation, `bulkEditTransactions` — the one its own
web UI fires when you tick several rows and use the bottom action bar. This repo
wraps it and exposes it as the `bulk_edit_transactions` write tool;
`review_transactions` is built on the same wrapper.

This page explains **how it works, what it can and cannot change, and why it is
dangerous**. For the exact wire format (verbatim query text, example
request/response, capture provenance) see
[`graphql-capture/operations/mutations/BulkEditTransactions.md`](graphql-capture/operations/mutations/BulkEditTransactions.md).

---

## 1. The shape: one edit, many rows

The mutation takes **two separate arguments**, and the split between them is the
whole design:

```
mutation BulkEditTransactions(
    $input:  BulkEditTransactionInput!    ← WHAT to change   (required)
    $filter: TransactionFilter            ← WHICH rows       (NULLABLE ⚠)
)
```

```
        ┌───────────────────────┐        ┌────────────────────────┐
        │  filter  → WHICH      │        │  input  → WHAT         │
        │  ids: [               │        │  { categoryId: "abc" } │
        │    {id,accountId,     │        │                        │
        │     itemId},          │        │  ONE input object,     │
        │    {…}, {…}           │        │  applied to ALL        │
        │  ]                    │        │  matched rows          │
        └───────────┬───────────┘        └───────────┬────────────┘
                    └───────────────┬────────────────┘
                                    ▼
                        ┌───────────────────────┐
                        │ bulkEditTransactions  │
                        └───────────┬───────────┘
                                    ▼
               ┌────────────────────────────────────┐
               │ txn A ← categoryId: "abc"          │
               │ txn B ← categoryId: "abc"          │  same edit,
               │ txn C ← categoryId: "abc"          │  every row
               └────────────────────────────────────┘
```

**There is no per-row input.** This is the single most important thing to
understand about the endpoint, and the thing most likely to be assumed wrong. You
cannot express "A → Groceries, B → Coffee" in one call. It is *one edit applied
to many rows*, not a batch of independent edits.

If you need different values on different rows, you need one call per distinct
value, or `update_transaction` per row.

---

## 2. What can actually be edited

`BulkEditTransactionInput` has **exactly five fields**. This was enumerated
exhaustively by error-leak probe, so the set is *closed* — not merely "these five
are known to exist":

```
BulkEditTransactionInput {
  categoryId:    ID                  ✅
  addTagIds:     [ID]                ✅  additive
  removeTagIds:  [ID]                ✅  subtractive
  type:          TransactionType     ✅  REGULAR | INCOME | INTERNAL_TRANSFER
  isReviewed:    Boolean             ✅
}
```

Every other candidate probed came back
`"not defined by type BulkEditTransactionInput"`:

```
✗ name    ✗ date       ✗ amount      ✗ userNotes   ✗ notes
✗ tagIds  ✗ setTagIds  ✗ goalId      ✗ parentId    ✗ recurringId
✗ isExcluded  ✗ isHidden  ✗ isPending  ✗ tipAmount
```

### Bulk vs. single-row, side by side

| Field | `bulk_edit_transactions` | `update_transaction` |
|---|---|---|
| category | ✅ | ✅ |
| type | ✅ | ✅ |
| reviewed | ✅ | ✅ |
| tags | ⚠️ **add / remove only** | ✅ replaces the whole list |
| name | ❌ | ✅ |
| date | ❌ | ✅ |
| amount | ❌ | ✅ |
| note | ❌ | ✅ |

Two consequences fall out of this table:

1. **The per-row `editTransaction` fan-out can never be retired.** Renames, date
   corrections, amount fixes and notes have no bulk form at all.
2. **Tags differ in kind, not just in arity.** Bulk *adds to* or *removes from*
   the existing list; `update_transaction` *replaces* it. There is no bulk
   "set the tag list to exactly this."

Also note: `type: INCOME` or `INTERNAL_TRANSFER` **clears the category**
server-side. Pairing either with `categoryId` is self-contradictory, and both
tools reject that combination rather than issuing a half-applying write.

### Which tool to reach for

```
  Do all the target rows get the SAME change?
      │
      ├─ no ──────────────────────────────► update_transaction (per row)
      │
      └─ yes
           │
           Does the change touch name / date / amount / note?
               │
               ├─ yes ─────────────────────► update_transaction (per row)
               │
               └─ no
                    │
                    Is it ONLY marking reviewed/unreviewed?
                        │
                        ├─ yes ────────────► review_transactions
                        │
                        └─ no ─────────────► bulk_edit_transactions
```

---

## 3. Targeting — and why `filter` is dangerous

There is no `transactionIds: [ID]` argument. Rows are addressed inside `filter`,
and each entry is a **composite triple**, not a bare id:

```
filter: {
  ids: [
    { id: "txn_1", accountId: "acc_9", itemId: "item_4" },   ← all three REQUIRED
    { id: "txn_2", accountId: "acc_9", itemId: "item_4" }
  ]
}
```

`TransactionFilter` is the **same input type the read queries use**
(`Transactions`, `TransactionSummary`), so it also structurally accepts `dates`,
`accountIds`, `categoryIds`, `recurringIds`, `tagIds`, `types`, `isReviewed` and
`matchString`. Combined with `$filter` being **nullable** while `$input` is
required, that gives:

```
  filter: { ids: [a, b, c] }      →  exactly those 3 rows   ← VERIFIED live
  filter: { isReviewed: false }   →  every unreviewed row?  ← INFERRED from the type
  filter: { }                     →  ???                    ← unknown
  filter omitted entirely         →  ???  and it is VALID GraphQL  ⚠
```

**Read that boundary carefully.** Only the first line is verified. We have never
sent a non-`ids` filter on this mutation, deliberately — the failure mode of that
experiment is "the account got rewritten," and there is no safe way to run it
against live data.

The circumstantial evidence is strong, though. A 2026-04 probe with `input: {}`
and no filter made the server execute a real
`select "item_id", "account_id", "transaction_id" from "transactions" where …`
with ~48 placeholders *before* failing validation. That tells us the server
**builds the row set before validating the input**, and that a filterless call
does not short-circuit to zero rows.

### How the wrapper defends against this

`bulkEditTransactions()` in `src/core/graphql/transactions.ts` does not accept a
`filter` parameter at all. It takes a required non-empty tuple:

```ts
ids: [TransactionIdentifierInput, ...TransactionIdentifierInput[]]
```

`ids` is the only filter key it can ever emit, and there is a runtime guard
behind the type guard because the module is reachable from plain JS. The
dangerous shapes are **unrepresentable, not discouraged** — and two unit tests
plus a source-scan ratchet in the round-trip suite keep it that way.

---

## 4. The output, and the trap in it

```
BulkEditTransactionsOutput {
  updated: [Transaction]      ← full rows the server confirms it wrote
  failed:  [TransactionError { transaction, error, errorCode: ErrorCode! }]
}
```

The trap: an id the server cannot find is **silently dropped from the row set**.
It does not raise, and it does not appear in `failed[]`.

```
   You request:  A, B, C
                 │
                 ▼
   ┌─────────────────────────────────────────────┐
   │ A → written        → appears in updated[]   │
   │ B → doesn't exist  → VANISHES.              │
   │                      not an error.          │
   │                      NOT in failed[]. ⚠     │
   │ C → written        → appears in updated[]   │
   └─────────────────────────────────────────────┘
                 │
                 ▼
   Server says:  updated: [A, C]     failed: []
                                     ^^^^^^^^^^
                          looks like total success!
```

So **`failed: []` does not mean "everything applied."** The wrapper therefore
computes a third bucket the server does not give you:

```
  skipped = requested_ids − (updated ∪ failed)
```

and both consumers throw when it is non-empty, naming the rows that did not land.

Two sibling behaviours, same family — the server does **no referential
validation**:

| Bad input | What the server does |
|---|---|
| Unknown **transaction** id | silently skipped (above) |
| Unknown **tag** id | silently dropped from `addTagIds`, no error |
| Unknown **category** id | 🚩 **persisted verbatim** as a dangling reference |

That last one is the worst: a typo'd `category_id` corrupts every targeted row
and the call reports success. It was confirmed on a `REGULAR` row, so it is not
the INCOME category-clearing path. This is why `bulk_edit_transactions` validates
category and tag ids client-side before writing — that check is the only thing
standing between a typo and bad data.

**`ErrorCode`'s enum values are unknown.** `failed[]` came back empty across all
seven probes, including every deliberate error case, so no value has ever been
observed. It is ledgered `unverified`, and the response schema types it as a
plain string rather than a `z.enum` — a value gate we cannot populate would warn
on the first genuine failure, which is exactly when the payload matters.

---

## 5. End to end

```
  bulk_edit_transactions(transaction_ids=[A,B,C], category_id="groc")
      │
      ├─ validate: category exists? tags exist? type legal?     ← server won't
      ├─ cap: ≤500 targets                                      ← before resolution
      ├─ resolve A,B,C → {id, accountId, itemId} triples
      │
      ▼  ONE request
  bulkEditTransactions(filter:{ids:[…3 triples…]}, input:{categoryId:"groc"})
      │
      ▼
  { updated:[A,C], failed:[] }
      │
      ├─ skipped = {B}  → THROW, naming B
      └─ patch cache for A and C only
```

For contrast, `review_transactions` previously issued one `editTransaction` per
id at 5 in flight — reviewing 200 transactions was 200 round trips. It is now
one.

---

## See also

- [`graphql-capture/operations/mutations/BulkEditTransactions.md`](graphql-capture/operations/mutations/BulkEditTransactions.md)
  — wire format, capture provenance, verbatim query
- [`graphql-capture/hidden-mutations.md`](graphql-capture/hidden-mutations.md)
  — the wider hidden-mutation inventory and what is still unreversed
- [`CONFORMANCE_ARCHITECTURE.md`](CONFORMANCE_ARCHITECTURE.md) — how the ledger,
  smokes and ratchets keep these assumptions from silently drifting
- `src/conformance/ledger.ts` — the `Mutation.bulkEditTransactions:*` and
  `BulkEditTransactionInput:*` entries, including the `unverified` `ErrorCode`
