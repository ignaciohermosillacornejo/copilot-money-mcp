---
id: 315
title: Split transactions returned parent AND children, doubling spend totals
class: aggregation-double-count
status: fixed
detected: dogfooding  # found while working on cache field coverage; confirmed by UI disagreement on a real split
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/315
issue: none — found and fixed directly
date: 2026-04-21
---

## Symptom
Any transaction split in Copilot appeared in `get_transactions` as N+1 rows: the original "parent" plus its N children. Every consumer that summed amounts (finance-pulse, budgets, spend-by-category) counted the spend twice — a $X payment split into two children showed up as 2×$X in totals, while the Copilot UI showed $X.

## How it was detected
The split-linkage fields (`parent_transaction_id`, `children_transaction_ids`) were noticed in raw LevelDB docs during the full-cache-coverage push — they were present on the wire but absent from decoded output. Following the thread, the author verified on their own DB that a real split showed three rows totalling exactly double what the UI displayed.

## Root cause
Two layered defects. (1) `processTransaction` in `src/core/decoder.ts` used a hand-maintained field allow-list; the two split-linkage fields were silently dropped, so callers could not even identify split rows. (2) With linkage invisible, no read path filtered parents out, and parents carry the full original amount while children carry the split portions — so aggregation summed both. Notably, `validateOrWarn` (the detector built for schema-drop failures) could not see this: allow-list drops happen before validation.

## The fix
Both fields added to `TransactionSchema` and the decoder allow-lists; `get_transactions` gained `exclude_split_parents: boolean = true`, hiding parents by default so totals match the Copilot UI, with an explicit opt-in to see them.

## Detector
`warnUnreadFields` (#316, gaps closed in #317) — fires when a raw doc contains a field no processor reads, which is exactly the gap that hid the linkage fields. The double-count class itself has no generic gate; the default-on parent exclusion plus decoder/tool tests are instance-level.

## Lesson
An allow-list decoder fails silently in a way schema validation cannot see — coverage of what the wire actually contains needs its own detector. And whenever a data model has parent/child rows where the parent aggregates the children, every summing path must decide explicitly which level it counts.
