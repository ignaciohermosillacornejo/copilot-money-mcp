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
  filter: { matchString: "foo" }  →  every row matching     ← VERIFIED live (2026-08-02)
  filter: { isReviewed: false }   →  every unreviewed row   ← same code path; treat as live
  filter: { }                     →  ???                    ← never sent
  filter omitted entirely         →  ???  and it is VALID GraphQL  ⚠
```

**The second line is the important one, and it is now measured, not guessed.**
A bounded live experiment sent `filter: { matchString: … }` with **no `ids` at
all** and `addTagIds` as the (reversible) edit. The server selected and wrote
exactly the rows matching that string; a control row on the same account and the
same day, differing only in name, was untouched.

So the mutation genuinely **does** honour non-`ids` filter fields. It is not an
ids-only endpoint that happens to accept a wider type. `matchString` is the one
field proven by experiment; the rest of `TransactionFilter` reaches the same
resolver through the same argument, so `isReviewed`, `dates`, `categoryIds` and
friends should be treated as live selectors too.

That makes the nullable `filter` a real hazard rather than a theoretical one:
one request with `filter: { isReviewed: false }` is a plausible way to rewrite
every unreviewed transaction on the account.

> **How that was tested safely.** `TransactionFilter` is the *same input type*
> the read queries take, so the exact filter was first sent through the
> `Transactions` **query** and required to return precisely the three throwaway
> ids before any write was allowed. The edit was `addTagIds` with a disposable
> tag — reversible by construction — and whatever came back in `updated[]` was
> untagged by explicit id immediately afterwards. `filter: {}` and an omitted
> filter were **not** tested and should not be: they have no read-verifiable
> match set, so that gate cannot bound them.

Supporting evidence from earlier: a 2026-04 probe with `input: {}` and no filter
made the server execute a real
`select "item_id", "account_id", "transaction_id" from "transactions" where …`
with ~48 placeholders *before* failing validation. The server **builds the row
set before validating the input**, and a filterless call does not short-circuit
to zero rows.

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

## 6. Decision record: why the write path accepts only transaction ids

This section is the reasoning behind the design, kept here so nobody has to
re-derive it (or re-run the experiments) to answer "why can't I just pass a
filter?"

### 6.1 How the endpoint was mapped

`bulkEditTransactions` was flagged **DO-NOT-PROBE** in
[`hidden-mutations.md`](graphql-capture/hidden-mutations.md) after a 2026-04
probe: sending `input: {}` made the server execute a real
`select "item_id", "account_id", "transaction_id" from "transactions" where …`
with ~48 placeholders *before* failing validation. That told us the server
builds its row set **before** validating input — so a malformed call is not
inert.

It was mapped anyway, in three phases, none of which repeated that mistake:

| Phase | Method | What it answered |
|---|---|---|
| 1. Capture (2026-07-31) | Drove Copilot's own **web** multi-select UI and observed the traffic | Real signature, real field selection, real variable shapes. Zero crafted requests. |
| 2. Error-leak introspection (2026-08-01) | Probes built so the GraphQL document **cannot pass validation** — every selection set carried a field that exists on no type, values were inlined as literals, known-real fields were type-mismatched | The complete type surface: the closed 5-field input, `TransactionIdentifierInput`, `BulkEditTransactionsOutput`, `TransactionError`. The resolver never ran. |
| 3. Scoped live probes (2026-08-01) | Disposable rows on a manual account, every call targeted by explicit `filter.ids`, with a control row never listed | Runtime semantics: additive/subtractive tags, INCOME clearing the category, and the three silent failure modes. Control row unchanged ⇒ `ids` targeting is exact. |

The phase-2 technique is the reusable part: **validity, not intent, decides
whether a probe executes.** `input: {}` executed because it was *schema-valid*
(every input field optional, `filter` nullable). A document that cannot pass
validation is safe to send at any time.

### 6.2 The filter experiment (2026-08-02)

Open question after phase 3: does the mutation honour filter fields other than
`ids`, or is it effectively an ids-only endpoint that merely accepts a wider
type? The answer changes how dangerous the nullable `filter` actually is, and
it could not be settled from the schema.

**Setup.** Four disposable transactions on the manual account, same date, same
category. Three named `zzfilterprobe20260802 {alpha,bravo,charlie}`; one control
named `zzcontrolrow20260802 delta` — same account, same day, differing only in
name so it would fall outside a `matchString` filter. Plus one disposable tag.

**Bounding, three independent ways:**

1. **Read-first gate.** `TransactionFilter` is the *same input type* the read
   path takes, so the exact filter went through the `Transactions` **query**
   first. The script hard-refused to issue any write unless that read returned
   precisely the three known probe ids — not more, not fewer, and never the
   control.
2. **Reversible edit.** `addTagIds` with a throwaway tag. Adding a tag destroys
   nothing and the inverse operation exists.
3. **Automatic revert.** Whatever came back in `updated[]` — three rows or three
   thousand — was untagged by explicit id in a `finally` block.

**Result:**

```
READ GATE   Transactions(filter:{matchString:"zzfilterprobe20260802"})
            → 3 rows, exactly the probe ids                        gate PASSED

MUTATION    bulkEditTransactions(filter:{matchString:"zzfilterprobe20260802"},
                                 input:{addTagIds:[<probe tag>]})   ← NO ids
            → updated: 3   failed: 0     (alpha, bravo, charlie tagged)

CONTROL     zzcontrolrow20260802 delta → tags: none                UNTOUCHED
REVERT      removeTagIds by explicit id → 3 reverted               CLEAN
```

**Conclusion: the mutation genuinely honours non-`ids` filter fields.** It is
not an ids-only endpoint. `matchString` is the field proven by experiment; the
rest of `TransactionFilter` reaches the same argument and resolver, so
`isReviewed`, `dates`, `categoryIds` and friends must be treated as live
selectors too. One request with `filter: { isReviewed: false }` is a plausible
way to rewrite every unreviewed transaction on the account.

**Not tested, by design:** `filter: {}` and an omitted filter. They have no
read-verifiable match set, so gate (1) cannot bound them. Do not test them.

### 6.3 Why the write path is ids-only

Three independent reasons, any one of which is sufficient.

**1. The audit invariant is uncomputable for a filter write.** Every bulk write
is checked by

```
skipped = requested_ids − (updated ∪ failed)     → throw if non-empty
```

which exists because the server silently drops ids it cannot find
(§4). A filter write has **no `requested_ids`**, so `updated: [A, C]` is
unauditable — you cannot distinguish "correct" from "half-applied" from "far too
many". The check does not weaken; it ceases to exist. And the fix is circular:
any safe design must resolve the filter to concrete ids *before* writing, at
which point the call is `filter: { ids }` and the filter-based write has
evaporated.

**2. Blast radius is asymmetric and irreversible.** With ids, a mistake edits the
wrong handful of rows. With a filter, a mistake edits every row the expression
matched — and §6.2 proves the server will do exactly that. There is no undo:
reverting requires knowing the previous values, which we only have for rows
somebody read first.

**3. A confirmation prompt cannot be relied on.** MCP does offer
[elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation)
(spec rev 2025-06-18, rearchitected 2026-07-28), and our SDK implements it —
`server.elicitInput()` throws `"Client does not support form elicitation."`
rather than proceeding, so a gate *can* fail closed. It still does not work here:

- **Client support is optional**, and Claude Desktop did not support it as of
  the last check — yet we ship a `.mcpb` bundle specifically for Desktop. The
  prompt would be invisible on a primary distribution target.
- **"Accept" is unverifiable attestation.** The server learns that the client
  returned accept, never that a human read anything — and the client is the same
  software stack containing the model that built the wrong filter.
- **It would degrade what the human already sees.** Host permission prompts
  currently show the explicit id list before a bulk write. A filter argument
  replaces that with an unbounded expression.

### 6.4 What callers do instead

Resolve the filter client-side, then write by id:

```
get_transactions_live(merchant: "…", period: "…")   →  read the matching rows
bulk_edit_transactions(rows: [...])                 →  write those exact rows
```

The id list appearing in the transcript is a **feature**: the model, the human
reading along, and the host's permission prompt all see precisely what is about
to change. The `MAX_BULK_EDIT_TARGETS` cap (500) bounds it.

Stated as policy: **the mutation's non-`ids` filter support is a hazard we route
around, not a feature we expose.** The wrapper takes a required non-empty `ids`
tuple, has no `filter` parameter at all, and two source-scan ratchets plus unit
tests keep it that way.

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
