---
id: 278
title: get_budgets read the legacy top-level amount field the app abandoned years ago
class: external-api-drift
status: fixed
detected: live-probe  # 2.0.0 write-smoke testing showed set_budget "succeeding" but never appearing in get_budgets; misdiagnosed as sync lag, then root-caused by instrumenting the real cache
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/280
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/278
date: 2026-04-15
---

## Symptom
`set_budget` returned success (HTTP 200, mutation acknowledged) but the new amount never showed up in `get_budgets` — not after 60s of polling, not ever. Worse, the amounts `get_budgets` *did* return were years-stale values that silently disagreed with what the app displayed.

## How it was detected
Surfaced during 2.0.0 release smoke testing of the GraphQL write rewrite. It was initially filed as a sync-cadence investigation (#278) with three hypotheses, all wrong in the same direction: everyone assumed the data hadn't *arrived*. Instrumenting the real LevelDB — editing a budget in the web UI, watching the Firestore WAL land within minutes, and dumping the raw doc — proved the fresh value was in the cache all along, in a field we never read.

## Root cause
Copilot's clients stopped writing the top-level `amount` field on budget docs roughly two years earlier; current values live in a per-month map, `amounts["YYYY-MM"]`. Our `getBudgets` read only the fossil `amount` field, so it reported whatever the budget happened to be when the app last wrote that field years ago. The external data model had drifted; nothing we had could notice, because the stale field still parsed cleanly and looked plausible.

## The fix
`getBudgets` (`src/tools/tools.ts`) now prefers `amounts[current_month]` (treating an explicit `0` as a clear, not a fallback), falls back to top-level `amount` only when the map is absent, exposes the full `amounts` map for history, and computes `total_budgeted` from effective current-month values. The bogus "sync lag" caveat was removed from `set_budget`'s description.

## Detector
none — instance-only regression tests (6 unit tests on field preference/fallback). The class — "a cached field still parses but the vendor moved the source of truth" — has no automated gate; the conformance-ledger discipline and trust-the-UI ground rule are the mitigations.

## Lesson
A value that parses is not a value that's current. When a write seems to never land, check whether the *read* is looking where the vendor's app actually writes before theorizing about sync timing — and validate any long-lived cache field against the UI occasionally, because stale-by-abandonment fields fail plausibly, not loudly.
