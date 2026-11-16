---
id: 867
title: Cache-mode category_name returned a raw or title-cased category id as the name when the id was in neither name map
class: identity-resolution
status: fixed
detected: code-review  # the #854 review noticed the transaction_type rules and the returned field disagreed on what "no name" meant
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/867
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/867
date: 2026-10-30
---

## Symptom

For a transaction, recurring item or category-list row whose category id was in neither
the user's categories nor the Plaid taxonomy (a deleted category, or one the local cache
had not synced), cache mode returned the id itself as `category_name`: an opaque id
verbatim, or a snake_case id title-cased into something that read like a real name
(`retired_custom_bucket` → `"Retired Custom Bucket"`). Live mode returned no name for the
same row. Silent: the title-cased form in particular looks correct, and a caller grouping
spend by `category_name` got a bucket the app does not have.

Within cache mode the field also contradicted itself: since #854 the `transaction_type`
rules treated the same row as having no name.

## How it was detected

Code review on #854. That PR made the `transaction_type` rules resolve a name only when it
is known, and the reviewer pointed out that the `category_name` field on the same rows still
used the guessing resolver. No test or probe surfaced it; the user-visible divergence was
found by reading the two call sites side by side.

## Root cause

`CopilotMoneyTools.resolveCategoryName()` (`src/tools/tools.ts`) called
`getCategoryName()` (`src/utils/categories.ts`), whose fallback for an unknown id
title-cases a snake_case id and otherwise returns the id unchanged. That is the exact
fallback #69's lesson warned about: a lookup failure turned into plausible display data.
Every caller of `resolveCategoryName()` inherited it — `get_transactions`, all three row
groups of `get_recurring_transactions` (Copilot subscriptions, the detail view, detected
patterns) and `get_categories`' list view. `get_budgets` was shielded only because it
already drops budgets on unknown categories (#91).

## Why the tests didn't catch it

Every existing test of these tools used a category id that resolved — a user category or a
Plaid slug — so the fallback branch only ran in `tests/utils/categories.test.ts`, which
pins `getCategoryName()`'s fallback as intended behaviour. Nothing compared the two modes'
`category_name` for an unresolvable id; the only cross-mode tests of category handling
(#843, #845) covered filters, not the returned field.

## The fix

`resolveCategoryName()` now returns `lookupKnownCategoryName() ?? undefined` — the same
known-names-only rule the `transaction_type` rules use — and its callers emit "no name" the
way each tool already emits it for an uncategorized row: the key is absent on
transaction, recurring and budget rows (matching `get_transactions_live`, which omits it),
and `null` on `get_categories` list rows, whose other absent values are already `null`.
`getCategoryName()` keeps its fallback; nothing that returns a name to a client calls it any
more.

## Detector

`tests/tools/category-name-parity.test.ts` — one fixture with a known id, an opaque unknown
id and a snake_case unknown id, run through every tool that returns a `category_name`
(`get_transactions`, the three `get_recurring_transactions` row groups and
`get_categories` list in cache mode; `get_transactions_live`, `get_recurring_live` and
`get_upcoming_recurrings_live` in live mode). Each must name the known id and give no name
for either unknown id, and cache and live `get_transactions` must agree row-for-row.
Verified against the defect: before the fix, every cache case failed and every live case
passed.

Partial: the table is hand-listed, so a new tool that returns `category_name` joins it only
if its author adds a row.

## Lesson

A name resolver with a "make something up" fallback should not be reachable from a field a
client reads. #69 and #91 were the same failure in other callers; the fallback outlived
both fixes because each removed one caller instead of the fallback's reach.
