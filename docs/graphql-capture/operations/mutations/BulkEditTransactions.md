# BulkEditTransactions

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** web transactions list → select rows via the left-edge checkboxes → bottom action bar (`Category` / `Type` / `Tag`)
- **Observations:** 2 (2026-07-31 Chrome capture)
- **Adopted:** ✅ 2026-08-01 — `bulkEditTransactions()` in `src/core/graphql/transactions.ts`, consumed by `review_transactions` and `bulk_edit_transactions`.

> **This page is the wire-format reference.** For how the endpoint works, what can
> and cannot be bulk-edited, when to use which tool, and why `filter` is
> dangerous, read [`docs/bulk-edit-transactions.md`](../../../bulk-edit-transactions.md)
> first.

## Query

```graphql
mutation BulkEditTransactions($input: BulkEditTransactionInput!, $filter: TransactionFilter) {
  bulkEditTransactions(filter: $filter, input: $input) {
    updated {
      ...TransactionFields
    }
    failed {
      transaction {
        ...TransactionFields
      }
      error
      errorCode
    }
  }
}

fragment TagFields on Tag {
  colorName
  name
  id
}

fragment GoalFields on Goal {
  name
  icon {
    ... on EmojiUnicode {
      unicode
    }
    ... on Genmoji {
      id
      src
    }
  }
  id
}

fragment TransactionFields on Transaction {
  suggestedCategoryIds
  hasSplitError
  recurringId
  categoryId
  isReviewed
  accountId
  createdAt
  isPending
  tipAmount
  userNotes
  parentId
  itemId
  amount
  date
  name
  type
  id
  tags {
    ...TagFields
  }
  goal {
    ...GoalFields
  }
}
```

> **Fragment note:** this document's `TransactionFields` is NOT the same field set as
> the one in [`EditTransaction.md`](EditTransaction.md). This one adds `hasSplitError`
> and `parentId` and omits the Apollo-local `identifierId @client` / `datetime @client`.
> Each document is self-contained, so the collision is harmless — but don't assume one
> fragment definition covers both operations.

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| input | object | **true** (`BulkEditTransactionInput!`) | `{"categoryId":"<id>"}` |
| filter | object | **false** (`TransactionFilter`, nullable) | `{"matchString":"<text>","ids":[{"accountId":"<id>","itemId":"<id>","id":"<id>"}]}` |

### `BulkEditTransactionInput` — complete, 5 fields

Sparse: the client sends **only** the field being changed, not a full transaction.

Enumerated exhaustively by error-leak probe (2026-08-01), so this list is closed
until Copilot ships a new field:

| Field | Type | Notes |
|---|---|---|
| `categoryId` | ID | Set the category on every matched row. **Not validated server-side** — see below. |
| `addTagIds` | [ID] | **Additive** — existing tags survive. |
| `removeTagIds` | [ID] | **Subtractive** — other tags survive. |
| `type` | TransactionType | `INCOME`/`INTERNAL_TRANSFER` clear the category, same as `editTransaction`. |
| `isReviewed` | Boolean | |

**Rejected** (`"not defined by type BulkEditTransactionInput"`): `name`, `date`,
`amount`, `userNotes`, `notes`, `tagIds`, `setTagIds`, `recurringId`, `goalId`,
`parentId`, `isExcluded`, `isHidden`, `isPending`, `tipAmount`. Near-miss probes
on each real field surfaced no additional siblings.

Two consequences that shape everything downstream:

1. **`name`/`date`/`amount`/`note` are not bulk-editable at all.** The per-row
   `editTransaction` fan-out cannot be retired.
2. **Tags are add/remove, never set.** There is no bulk equivalent of
   `EditTransactionInput.tagIds`, so "replace this row's tag list" has no bulk
   form.

### `TransactionFilter` — this is the targeting mechanism

There is **no `transactionIds` array**. Rows are addressed through `filter`:

| Field | Type | Notes |
|---|---|---|
| `ids` | [`TransactionIdentifierInput!`] | Array of **composite** objects. This is the only key our wrappers ever send. |
| `matchString` | String | The active search-box text. The UI sends it alongside `ids`; the AND/OR relationship is **unverified** and we never send it. |

`TransactionIdentifierInput` is `{ itemId: ID!, accountId: ID!, id: ID! }` — all
three required, no other fields (probe-enumerated 2026-08-01). Same routing
triple `editTransaction` takes per row.

`TransactionFilter` is the type the `Transactions` and `TransactionSummary`
queries use, so it also **structurally** accepts `dates`, `accountIds`,
`categoryIds`, `recurringIds`, `tagIds`, `types` and `isReviewed`
([shape](../queries/Transactions.md#transactionfilter-shape-captured-2026-04-23-via-chrome-devtools)).

**That is the danger, not a feature** — but mind the evidence boundary:

| Filter | Effect | Evidence |
|---|---|---|
| `{ ids: [...] }` | exactly the listed rows | **verified** live, with an untargeted control row |
| `{ matchString: "…" }` | every row matching, no `ids` needed | **verified** live 2026-08-02 (read-gated, reversible edit, control row untouched) |
| `{ isReviewed: false }`, `{ dates: … }`, … | presumably selects and writes | same argument + resolver as `matchString`; **treat as live**, not individually observed |
| `{}` / omitted | unknown, unbounded | **never sent — do not** |

The `matchString` row is the load-bearing one: it proves the mutation honours
filter fields **other than `ids`**, so this is not an ids-only endpoint that
merely accepts a wider type. One request with a broad filter really can rewrite
a large slice of the account.

That experiment was bounded by sending the identical filter through the
`Transactions` **query** first (same input type) and refusing to write unless it
returned exactly the three throwaway ids, using `addTagIds` so the edit was
reversible, and untagging by explicit id immediately after. `{}` and an omitted
filter have no read-verifiable match set, so that gate cannot bound them — they
remain untested by design.

## ⚠ Safety: `filter` is nullable

The mutation signature is `$filter: TransactionFilter` — **no `!`**. `input` is required;
the thing that decides *which rows get written* is optional.

That means a call carrying only `input` is syntactically valid, and its blast radius is
unknown and potentially unbounded. This is consistent with the earlier `input: {}` probe
that made the server run a real `select "item_id", "account_id", "transaction_id" from
"transactions"` with ~48 placeholders before failing — the server builds a row set first
and validates after.

**Never send this mutation without an explicit `filter.ids`.** Any wrapper we build must
make a filterless call unrepresentable, not merely discouraged.

## Example request

Sent over Apollo's **batched transport** — the wire body is a JSON *array* of operations
(one element in both captures), and the response is a matching array. A wrapper that
assumes a bare object will not match what the app sends.

```json
[{"operationName":"BulkEditTransactions","query":"mutation BulkEditTransactions($input: BulkEditTransactionInput!, $filter: TransactionFilter) {\n  bulkEditTransactions(filter: $filter, input: $input) {\n    updated {\n      ...TransactionFields\n      __typename\n    }\n    failed {\n      transaction {\n        ...TransactionFields\n        __typename\n      }\n      error\n      errorCode\n      __typename\n    }\n    __typename\n  }\n}","variables":{"input":{"categoryId":"<id>"},"filter":{"matchString":"<text>","ids":[{"accountId":"<id>","itemId":"<id>","id":"<id>"},{"accountId":"<id>","itemId":"<id>","id":"<id>"},{"accountId":"<id>","itemId":"<id>","id":"<id>"}]}}}]
```

Capture 2 differed only in `input`: `{"addTagIds":["<id>"]}`.

## Example response

```json
[
  {
    "data": {
      "bulkEditTransactions": {
        "__typename": "BulkEditTransactionsOutput",
        "updated": [
          {
            "__typename": "Transaction",
            "suggestedCategoryIds": [],
            "hasSplitError": false,
            "recurringId": null,
            "categoryId": "<id>",
            "isReviewed": true,
            "accountId": "<id>",
            "createdAt": "<ts>",
            "isPending": false,
            "tipAmount": "<amount>",
            "userNotes": "<name>",
            "parentId": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "<date>",
            "name": "<name>",
            "type": "REGULAR",
            "id": "<id>",
            "tags": [
              {
                "__typename": "Tag",
                "colorName": "PURPLE1",
                "name": "<name>",
                "id": "<id>"
              }
            ],
            "goal": null
          }
        ],
        "failed": []
      }
    }
  }
]
```

`updated` length matched the selection size in both captures (3, then 2).

## Verified server semantics (live probes, 2026-08-01)

Seven scoped probes against disposable rows on a manual account, each targeted
by explicit `filter.ids`. A control row that was never listed came back
completely unchanged, confirming `ids` targeting is exact.

| Behaviour | Result |
|---|---|
| `filter.ids` alone, no `matchString` | ✅ works; targets exactly the listed rows |
| `addTagIds` | additive — pre-existing tags survive |
| `removeTagIds` | subtractive — other tags survive |
| `type: INCOME` | clears the category server-side |
| Nonexistent **transaction** id | 🚩 **silently skipped** — no error, absent from `failed[]` |
| Nonexistent **tag** id | 🚩 silently dropped, no error |
| Nonexistent **category** id | 🚩🚩 **persisted verbatim as a dangling reference** |

The last three are the ones that shape the wrapper:

- **No referential validation.** A typo'd `categoryId` corrupts every targeted
  row with a dangling reference, and the call reports success. Confirmed on a
  `REGULAR` row, so it is not the INCOME category-clearing path. Callers MUST
  validate category and tag ids before writing — `bulk_edit_transactions` does.
- **Silent skips defeat `failed[]`.** Because an unknown id vanishes from the
  row set rather than erroring, `failed: []` does NOT mean "everything applied".
  `bulkEditTransactions()` therefore diffs `updated[]` against the requested ids
  and returns the gap as `skipped`; both consumers throw on a non-empty
  `skipped`.

**`ErrorCode` remains unknown.** `failed[]` was empty in all seven probes —
including every deliberate error case above — so no `ErrorCode` value has ever
been observed. The response schema types it as a plain string rather than a
`z.enum`, because a value gate we cannot populate would warn on the first
genuine failure. Tracked as an `unverified` ledger entry.

## How this repo uses it

Both consumers go through `bulkEditTransactions()` in
`src/core/graphql/transactions.ts`, which makes the dangerous shapes
unrepresentable: `ids` is a required non-empty tuple, `filter` is not a
parameter at all, and the only key ever sent is `ids`.

- **`review_transactions`** — the whole set in one request instead of a 5-wide
  `editTransaction` fan-out.
- **`bulk_edit_transactions`** — the five supported fields, with client-side
  validation standing in for the referential checks the server skips.

Per-row heterogeneous edits, and any edit touching `name`/`date`/`amount`/
`note`, still go through `update_transaction`.
