---
id: 867
title: Cache-mode category_name returned a raw or title-cased category id as the name when the id was in neither name map
class: identity-resolution
status: fixed
detected: code-review  # the #854 review noticed the transaction_type rules and the returned field disagreed on what "no name" meant
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/909
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

Every category name cache mode returns now comes from one rule,
`CopilotMoneyTools.knownCategoryNamer()`: `lookupKnownCategoryName()` over the user name map,
else the Plaid taxonomy, else `null`, the same known-names-only rule the `transaction_type`
rules use. Each response resolves it once and names its rows synchronously. Callers emit
"no name" the way each tool already emits it for an uncategorized row: the key is absent on
transaction, recurring and budget rows (matching `get_transactions_live`, which omits it),
and `null` on `get_categories` rows, whose other absent values are already `null`.
`resolveCategoryName()`, the per-id wrapper that used to call `getCategoryName()`, is gone.

`getCategoryName()` keeps its fallback, but its reach is closed: the last other `src/` caller,
`CopilotDatabase.getCategories()` (no production caller, but public), now uses
`lookupKnownCategoryName()` as well and leaves `name` absent for an unknown id.

Review found a second resolver of the same kind: `getCategoryDisplayName()`
(`src/models/category.ts`, `name ?? category_id`). `get_categories`' list view fed it a
synthesized `{ category_id }` for a parent missing from the user's categories, so the same
row whose `category_name` was now `null` reported the deleted parent's raw id as
`parent_name`. The tree and subcategories views used it on user categories, where a missing
name came back as the id and an empty one as `""`. Every `get_categories` view now goes
through `knownCategoryNamer()`. The user name map already skips a category with a missing or
empty name, as live mode's does (#860). `getCategoryDisplayName()` had no caller left and was
deleted. `get_budgets`' orphan filter, which spelled "is this category known" a second way,
now asks the namer too.

Routing every view through one rule also exposed a stale copy of the name map held by
`CopilotMoneyTools`, which only `refresh_database` dropped. It is gone, and the database's own
map (dropped on a cache reload or a category write) is the only one. Its sibling, the
excluded-category-id set, had the same shape and moved amounts rather than names. It now
lives in the database next to the name map and is dropped with it. The reload path is pinned
by rename and exclude tests in the parity file, and the write path by
`getExcludedCategoryIds` tests in `tests/core/database.test.ts`.

The finance-pulse skill, which used "no `category_name`" to mean uncategorized, now tests
`category_id` instead, so a row in a deleted category still counts as spending.

## Detector

`tests/tools/category-name-parity.test.ts` — one fixture with a known id, an opaque unknown
id and a snake_case unknown id, run through every tool that returns a `category_name`
(`get_transactions`, the three `get_recurring_transactions` row groups and
`get_categories` list in cache mode; `get_transactions_live`, `get_recurring_live` and
`get_upcoming_recurrings_live` in live mode). Each must name the known id and give no name
for either unknown id, and cache and live `get_transactions` must agree row-for-row.
Verified against the defect: before the fix, every cache case failed and every live case
passed.

The table is hand-listed, so a new tool that returns `category_name` joins it only if its
author adds a row. The class-level half is `tests/no-guessing-category-name.test.ts`: an AST
sweep that fails if any `src/` file other than `src/utils/categories.ts` references the
guessing `getCategoryName` (import, renamed import, namespace access, re-export or call). A
new tool cannot reach the fallback without failing it, whether or not it joins the table.
Mutation-checked: re-importing it in `src/core/database.ts` fails the sweep. A new resolver
under a different name is not covered until it is added to the sweep's table.
The parity test also pins `parent_name` for a deleted parent and the tree / subcategories
names for an unnamed user category.

## Lesson

A name resolver with a "make something up" fallback should not be reachable from a field a
client reads. #69 and #91 were the same failure in other callers; the fallback outlived
both fixes because each removed one caller instead of the fallback's reach. This fix
closes the reach and gates it. A predicate written on the old behaviour ("no name" meaning
"no category") has to move with it, so search for consumers of the field's absence, not
only producers of the field.
