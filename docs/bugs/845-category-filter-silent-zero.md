---
id: 845
title: The transactions category filter silently returned zero rows for a parent category id or a category name
class: identity-resolution
status: fixed
detected: live-probe  # release parity rows CAT-04/05/06 passed a parent id and a name in both modes
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/858
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/845
date: 2026-10-18
---

## Symptom

`get_transactions_live {category: <parent category id>}` returned 0 rows, though the parent's
subcategories had spending in the window. `{category: "Restaurants"}` (a name) also returned
0 rows. Cache mode gave the same answers. Nothing marked either result as a non-match, and 0
rows reads exactly like "you spent nothing there", so the bug was silent.

## How it was detected

The 2026-10-18 release parity run (CAT-04/05/06) called the filter the way an agent does,
with a parent id and with a name, and compared the result with the web app's category view.

## Root cause

Both modes matched the value against each row's own `category_id` and nothing else:

- `src/tools/live/transactions.ts` `postFilter` step 3: `n.categoryId === cid`.
- `src/core/database.ts` `getTransactions`: a case-insensitive *substring* of the id. That was
  inherited from the January 2026 rewrite, when category ids were Plaid taxonomy strings such
  as `food_and_drink_restaurants`. On opaque Firestore ids, a substring match only ever hits
  by accident.

Neither mode expanded a parent to its children, although transactions carry only the leaf
category. Neither mode checked that the value named a category at all.

## Why the tests didn't catch it

The tests filtered by a leaf id that the fixture's rows carried directly, or (in cache mode)
by a substring of a Plaid-style fixture id. No fixture had a parent with children, and no test
passed a value that matched nothing and expected anything other than an empty list.

## The fix

One resolver for both modes, `resolveCategoryFilter` in `src/tools/category-filter.ts`:

- The value is matched exactly as a category id.
- A parent id expands to all its descendants, as the app rolls a parent up.
- A value that is no known id is an error. The error says the filter takes an id, names the
  tool that lists them, and suggests the id when the value is a category name.

An id carried only by a transaction in the queried date range is still accepted. Both modes
judge that against the same corpus, the window's rows; the first version checked the whole
cache in cache mode, so an out-of-window orphan id was a silent zero there and an error live
(caught in review). The corpus also follows the call's own `exclude_deleted` /
`exclude_split_parents` flags: a Plaid-deleted row or a split parent, which live never
receives, counts only when the caller asked for such rows; otherwise an id carried only by one
was accepted and then returned nothing. A lookup by `transaction_id` validates `category` too,
against the whole cache that path searches. `database.ts` now takes a resolved id set and does
no matching of its own.

## Detector

`tests/tools/category-filter-parity.test.ts` drives both tools over one fixture: a parent with
two children, a top-level category, an orphan id, and opaque ids. It requires the same ids
from both modes, children included for a parent. It also requires a name, a substring, a case
variant or a typo to be rejected in both modes, with the mode's own hint. Further cases pin
the corpus: an orphan id outside its rows' window, and an id carried only by a Plaid-deleted
row or only by a split parent, are rejected in both modes; with `exclude_deleted: false` /
`exclude_split_parents: false` those rows are returned instead; a `transaction_id` lookup
rejects an unknown `category` in both modes and accepts an orphan id its own row carries. The
test is per filter, not a sweep: other filters that take an id (`account_id`) still return
zero rows for an unknown value.

The rest of #845, arguments a tool does not take at all, is closed at dispatch:
`validateToolArgs` (`src/tools/input-validation.ts`) checks every call against the tool's
`inputSchema` before any handler runs, and `tests/unit/dispatch-arg-validation.test.ts`
walks the whole registry with an undeclared argument, a wrong type for every typed argument
and an out-of-enum value for every enum. That detector is mutation-verified through the
`tool arguments are validated at dispatch` row in `scripts/mutation-guards.ts`, and a tool
added later is covered by being registered.

Siblings: `transaction_type: "hsa_eligible"` matched Plaid-taxonomy slugs as substrings of the
opaque category id in cache mode, the same defect, and used a different word list in live
mode; #854 replaces both with one shared rule over the category NAME (#843).

## Lesson

A filter that can match nothing should say so whenever an empty result is ambiguous. "No
rows" and "your value names nothing" have to look different to the caller.
