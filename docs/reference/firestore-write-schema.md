# Firestore Write Schema (Archived Reference)

This document describes how the MCP server's write tools wrote data to
Copilot Money's Firestore backend. This path stopped working when
Copilot deployed server-side type checking on Firestore documents
(around April 2026), and the MCP server migrated to Copilot's
official GraphQL API. See
`docs/superpowers/specs/2026-04-14-graphql-write-rewrite-design.md`.

This doc exists to preserve document-shape knowledge that was
embedded in the deleted code (`src/core/firestore-client.ts` and
`src/core/format/firestore-rest.ts`, removed in this commit). The Zod
schemas in `src/models/` remain the authoritative source for entity
shapes regardless of backend.

## Firestore project

- **Project ID:** `copilot-production-22904`
- **Base URL:** `https://firestore.googleapis.com/v1`
- **Auth:** Firebase JWT bearer tokens via `FirebaseAuth`
  (`src/core/auth/firebase-auth.ts`). The GraphQL rewrite still uses
  the same auth source — only the downstream transport changed.
- **Value envelope:** Firestore REST wraps every scalar in a typed
  wrapper (`{ stringValue: "x" }`, `{ integerValue: "42" }`,
  `{ doubleValue: 1.5 }`, `{ booleanValue: true }`, `{ nullValue: null }`,
  `{ arrayValue: { values: [...] } }`, `{ mapValue: { fields: {...} } }`).
  The old `toFirestoreFields` helper converted plain TS objects into
  this shape and skipped `undefined` values.

## Write mechanics

- **Partial update:** `PATCH .../{docPath}?updateMask.fieldPaths=a&updateMask.fieldPaths=b`
  — `updateMask.fieldPaths` is a repeated query param. Only listed fields
  are written; others are preserved.
- **Create with client-assigned ID:** `POST .../{collectionPath}?documentId=<id>`
- **Create with server-assigned ID:** `POST .../{collectionPath}` — the
  response `name` field contains the full resource path; the last
  segment is the new document ID.
- **Delete:** `DELETE .../{docPath}`

## Collection paths used by write tools

- `items/{item_id}/accounts/{account_id}/transactions/{transaction_id}`
  (transactions — nested under the Plaid item + account, not the user)
- `users/{user_id}/categories/{category_id}`
- `users/{user_id}/tags/{tag_id}`
- `users/{user_id}/budgets/{budget_id}`
- `users/{user_id}/recurring/{recurring_id}`
- `users/{user_id}/financial_goals/{goal_id}`

`user_id` was resolved preferentially from an existing cached doc's
`user_id` field (categories), falling back to
`FirebaseAuth.getUserId()` via `FirestoreClient.requireUserId()`.

## Per-tool notes

### update_transaction

- **Collection:** `items/{item_id}/accounts/{account_id}/transactions/{transaction_id}`
- **Mechanism:** PATCH with `updateMask.fieldPaths`
- **Writable fields (MCP arg → Firestore name):**
  - `category_id` → `category_id` (string)
  - `note` → `user_note` (string; `""` clears)
  - `tag_ids` → `tag_ids` (array&lt;string&gt;; `[]` clears)
  - `excluded` → `excluded` (bool)
  - `name` → `name` (string)
  - `internal_transfer` → `internal_transfer` (bool)
  - `goal_id` → `goal_id` (string)
- **Gotchas:**
  - MCP `note` is renamed to Firestore `user_note` — only external
    field-name asymmetry among the writable set.
  - `goal_id: null` unlinks — Firestore receives `""` (empty string),
    not `null`. Cache patch uses `undefined` for the same field.
  - The path requires `item_id` AND `account_id` on the cached
    transaction; resolved via `resolveTransaction(id)` before any
    write so "Transaction not found" wins over field-level errors.
  - Atomic: all fields written in one PATCH; cache patched via
    `patchCachedTransaction` with full-cache-clear fallback.

### review_transactions

- **Collection:** `items/{item_id}/accounts/{account_id}/transactions/{transaction_id}`
- **Mechanism:** PATCH with `updateMask.fieldPaths=user_reviewed`
- **Writable field:** `user_reviewed` (bool; default true)
- **Gotchas:** Batched at `REVIEW_BATCH_SIZE` concurrency to avoid
  overwhelming Firestore. One PATCH per transaction (Firestore REST
  had no batch endpoint the client used).

### create_category

- **Collection:** `users/{user_id}/categories`
- **Mechanism:** POST with server-assigned ID, then a follow-up PATCH
  to write `id` = assigned doc ID (the app stores `id` equal to the
  Firestore doc ID).
- **Document fields:** `name`, `emoji`, `color`, `bg_color`, `order`
  (max existing + 1), `excluded`, `is_other: false`, `auto_budget_lock: false`,
  `auto_delete_lock: false`, `plaid_category_ids: []`,
  `partial_name_rules: []`, optional `parent_category_id`.
- **Gotchas:**
  - `bg_color` was derived from `color` via `hexToBgColor(color)` —
    the app rejected categories without a matching `bg_color`.
  - Emoji and color defaulted to `📁` and `#808080` if omitted.
  - Duplicate-name check was case-insensitive against existing
    categories.

### update_category

- **Collection:** `users/{user_id}/categories/{category_id}`
- **Mechanism:** PATCH with dynamic `updateMask`
- **Writable fields:** `name`, `emoji`, `color` (pushes both `color`
  and `bg_color` into the mask), `excluded`, `parent_category_id`
  (`null` unlinks → Firestore `""`).
- **Gotchas:**
  - Setting `color` always co-updates `bg_color` in the mask —
    asymmetry the GraphQL port also honors.
  - `parent_category_id === category_id` rejected (no self-parent).

### delete_category

- **Collection:** `users/{user_id}/categories/{category_id}`
- **Mechanism:** DELETE
- **Gotchas:** User ID resolved from existing categories' `user_id`
  field first (cheaper than auth round-trip).

### create_tag

- **Collection:** `users/{user_id}/tags/{tag_id}`
- **Mechanism:** POST with client-assigned `documentId`
- **Document fields:** `name`, optional `color_name`, optional `hex_color`
- **Gotchas:**
  - `tag_id` is deterministic: lowercased name with whitespace → `_`
    and non-`[a-z0-9_-]` stripped. If the result is empty, the call
    fails. Clients cannot pick tag IDs.

### update_tag

- **Collection:** `users/{user_id}/tags/{tag_id}`
- **Mechanism:** PATCH with dynamic `updateMask`
- **Writable fields:** `name`, `color_name`, `hex_color`
- **Gotchas:** No special behaviors.

### delete_tag

- **Collection:** `users/{user_id}/tags/{tag_id}`
- **Mechanism:** DELETE

### create_budget

- **Collection:** `users/{user_id}/budgets/{budget_id}`
- **Mechanism:** POST with client-assigned `documentId`
- **Document fields:** `budget_id`, `category_id`, `amount`, `period`,
  `is_active: true`, optional `name`
- **Gotchas:**
  - `budget_id` generated as `budget_<16-hex>` from `crypto.randomUUID()`.
  - Duplicate-by-`category_id` check prevents two budgets on the same
    category.

### update_budget

- **Collection:** `users/{user_id}/budgets/{budget_id}`
- **Mechanism:** PATCH with dynamic `updateMask`
- **Writable fields:** `amount`, `period`, `name`, `is_active`

### delete_budget

- **Collection:** `users/{user_id}/budgets/{budget_id}`
- **Mechanism:** DELETE

### create_recurring

- **Collection:** `users/{user_id}/recurring/{recurring_id}`
- **Mechanism:** POST with client-assigned `documentId`
  (= `crypto.randomUUID()`)
- **Document fields:** `recurring_id`, `name`, `amount`, `frequency`,
  `is_active: true`, `state: "active"`, `latest_date` (defaults to
  today), optional `category_id`, `account_id`, `merchant_name`,
  `start_date`.
- **Gotchas:**
  - `latest_date` was seeded to `start_date` or today at creation —
    otherwise the app's recurring-detection logic would skip the item.

### update_recurring

- **Collection:** `users/{user_id}/recurring/{recurring_id}`
- **Mechanism:** PATCH with dynamic `updateMask`
- **Writable fields:** `name`, `amount`, `frequency`, `category_id`,
  `account_id`, `merchant_name`, `emoji`, `match_string`,
  `transaction_ids`, `excluded_transaction_ids`,
  `included_transaction_ids`, `days_filter`

### set_recurring_state

- **Collection:** `users/{user_id}/recurring/{recurring_id}`
- **Mechanism:** PATCH with `updateMask.fieldPaths=state&updateMask.fieldPaths=is_active`
- **Writable fields:** `state` (`active` | `paused` | `archived`),
  `is_active` (`state === 'active'`)
- **Gotchas:** Both fields always written together — `is_active` is a
  derived boolean mirror of `state === 'active'`, and the app reads
  both.

### delete_recurring

- **Collection:** `users/{user_id}/recurring/{recurring_id}`
- **Mechanism:** DELETE

### create_goal

- **Collection:** `users/{user_id}/financial_goals/{goal_id}`
  (note: `financial_goals`, not `goals`)
- **Mechanism:** POST with client-assigned `documentId` (= `crypto.randomUUID()`)
- **Document fields:**
  - `goal_id`, `name`, optional `emoji`
  - `savings` (nested map): `type: "savings"`, `status: "active"`,
    `target_amount`, `tracking_type` (`monthly_contribution` if
    `monthly_contribution` arg given, else `manual`),
    `tracking_type_monthly_contribution` (= `monthly_contribution` or `0`),
    `start_date` (defaults to today), `is_ongoing: false`.
- **Gotchas:** All savings-related fields live inside a nested
  `savings` map — they were never stored as top-level goal fields.

### update_goal

- **Collection:** `users/{user_id}/financial_goals/{goal_id}`
- **Mechanism:** PATCH with dynamic `updateMask`
- **Writable top-level fields:** `name`, `emoji`
- **Writable savings sub-fields (merged as single `savings` mask entry):**
  - `target_amount` → `savings.target_amount`
  - `monthly_contribution` → `savings.tracking_type_monthly_contribution`
  - `status` → `savings.status` (`active` | `paused`)
- **Gotchas:**
  - All savings-field updates use a single `savings` mask entry with a
    partial nested map as the value — Firestore's REST PATCH merges
    the sub-map into the existing document. Adding granular masks
    like `savings.target_amount` was never used.

### delete_goal

- **Collection:** `users/{user_id}/financial_goals/{goal_id}`
- **Mechanism:** DELETE
