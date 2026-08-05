---
id: 89
title: Goal history parsed against an invented schema; goal progress wrong
class: external-api-drift
status: fixed
detected: dogfooding  # goal saved-amounts disagreed with the app
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/89
issue: none — found and fixed directly
date: 2026-01-18
---

## Symptom
Goal progress was wrong: `get_goals` had no `current_amount` at all, and goal history parsing produced incorrect saved-amount values that did not match what the Copilot app showed for the same goals.

## How it was detected
Dogfooding: comparing per-goal saved amounts against the Copilot UI. The fix's test plan explicitly validates both goals' amounts "match UI".

## Root cause
Three stacked assumptions about data the project had never actually inspected:
1. Goal history parsing assumed a field layout that doesn't exist — Copilot actually stores a `balance` field inside `daily_data` entries in the goal history subcollection.
2. Goal IDs were extracted from subcollection paths incorrectly (collection matching in `decodeAllCollections` didn't handle full paths), so history rows couldn't be joined to goals.
3. On top of #89's fix, selection of the "current" amount took an arbitrary array entry rather than the latest month — order in the decoded array is not chronological (regression-tested separately in PR #90).

## The fix
PR #89 returned full collection paths from the decoder, parsed `balance` from `daily_data` (Copilot's real format), joined goals with goal history to expose `current_amount`, and started a Firestore-collections knowledge-base doc. PR #90 added regression tests forcing latest-month selection regardless of array order.

## Detector
None — instance-only regression tests (#90). The systemic answer to "we assumed a shape Copilot doesn't have" arrived much later as the conformance ledger + probe-before-schema discipline; nothing in this era verified assumed shapes against reality before shipping.

## Lesson
Decode a real document *first*, then write the schema — the reverse order (invent schema, decode into it) produces plausible-looking wrong numbers. Ordering assumptions about decoded arrays are also external assumptions; sort explicitly.
