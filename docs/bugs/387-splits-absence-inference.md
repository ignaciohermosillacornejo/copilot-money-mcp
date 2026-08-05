---
id: 387
title: get_investment_splits removed on the belief the cache was always empty — it wasn't
class: absence-inference
status: fixed
detected: incidental  # empirical re-inspection of the cache weeks after the removal
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/387
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/147
date: 2026-05-12
---

## Symptom
Two distinct wrong states, back to back. First, the v1.5.0-era tool advertised speculative fields (`split_ratio`, `from_factor`, `to_factor`, `announcement_date`, ...) the cache never populated — output shaped by imagination, not data. Then PR #378 removed the tool entirely on the conclusion that `investment_splits` docs were always empty placeholders — so a real capability disappeared.

## How it was detected
Empirical re-inspection of the local cache on 2026-05-11 (documented in an issue #147 comment) found `investment_splits/{security_id}` docs DO carry real, date-keyed adjustment multipliers — for securities that have actually had splits. The original sample was taken during a window when none of the user's then-held securities had a split in its history, so every doc looked like a placeholder.

## Root cause
Inference of structural absence from an unrepresentative snapshot: "every doc I can see is empty" was read as "this collection is always empty" when it actually meant "no held security has split." The project has hit this shape before (the earlier "cost basis is not in the cache" conclusion was also wrong). The speculative v1.5.0 schema was the mirror-image failure: presence invented without observation.

## The fix
Tool restored with an honest schema containing only fields the cache demonstrably populates: `security_id` plus a sparse `adjustments: Record<YYYY-MM-DD, number>`, joined with the securities collection into per-event rows with a human-readable ratio description. The decoder skips empty placeholder docs, and the tool description warns that price tools already return split-adjusted values.

## Detector
Process-level, not CI: the `leveldb-introspect` skill now instructs "use BEFORE concluding the cache doesn't have X — most such conclusions turned out to be filter/decoder bugs, not actually-missing data." No automated gate can prove a negative about an external store.

## Lesson
"Absent in my snapshot" and "absent in the schema" are different claims; only the first is observable from one user's cache. Before removing a capability because its data source looks empty, ask what real-world event would have to occur for the data to appear — and whether the sampled account has ever had one.
