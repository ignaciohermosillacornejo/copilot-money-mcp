---
id: 280
title: Deleted-budget tombstones surfaced as ghost rows — 58% of get_budgets output was garbage
class: stale-cache-semantics
status: fixed
detected: incidental  # discovered during the #278 stale-field investigation while dumping raw budget docs
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/280
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/278
date: 2026-04-15
---

## Symptom
`get_budgets` returned dozens of `{budget_id: "..."}` rows with no category and no amount — 50 of 86 rows in the real database were these ghosts. The noise buried the legitimate rows, which is likely why the companion bug (#278) was reported as "writes never appear" rather than "writes appear but I can't find them among 50 empty rows".

## How it was detected
Fell out of the #278 root-cause work: dumping raw budget docs from LevelDB showed most of them were empty-field entries, which is how Firestore's local cache represents deleted documents for this collection.

## Root cause
`processBudget` in `src/core/decoder.ts` had no tombstone guard. Its sibling `processCategory` already had one (`if (!name) return null`), but the budget processor happily emitted a row for every empty-field doc. Two decoders over the same cache format handled the same deletion semantics differently — and nothing enforced consistency across the ~30 collection processors.

## The fix
`processBudget` now returns `null` for empty-field docs, mirroring `processCategory`. In `getBudgets`, the tombstone filter runs before the orphan-category filter so counts and totals reflect only real budgets.

## Detector
none — instance-only decoder regression test (`processBudget skips empty-field tombstone docs`). No automated gate checks that every collection processor handles tombstones; the knowledge is captured as a documented pattern (transactions use `user_deleted=true` soft-deletes, most other collections use empty-doc tombstones — check deletion semantics first when a "deleted item still shows").

## Lesson
Deletion semantics are a property of the cache format, not of one collection: when one processor needs a tombstone guard, audit every sibling processor for the same gap in the same PR. This was available for free in 2026-04 — `processCategory` already knew the trick — and instead each collection learns it separately.
