---
id: 288
title: setRecurringState threw on rule-less recurrings — server applied the change, client reported failure
class: external-api-drift
status: fixed
detected: live-probe  # scripts/verify-optimistic-consistency.ts hit it while pausing a real recurring
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/291
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/288
date: 2026-04-16
---

## Symptom
`setRecurringState` (and `updateRecurring`, same mutation) threw `Cannot return null for non-nullable field RecurringRule.nameContains` for any recurring whose matching rule lacks a `nameContains` (e.g. amount-only rules). Worst kind of failure: the server *had already applied* the state change, but the client threw while reading the response — so the tool reported "write failed" for a write that succeeded, inviting retries and phantom-failure debugging.

## How it was detected
The brand-new optimistic-consistency probe (`scripts/verify-optimistic-consistency.ts`, PR #289) ran `setRecurringState` end-to-end against a real account and hit the throw on its first encounter with a rule-less recurring. Unit tests never saw it — they don't exercise Copilot's server-side response validation.

## Root cause
Our captured `EditRecurring` operation over-selected: it requested a `rule { nameContains ... }` sub-selection (plus `payments` and `category @client`) that the tool never consumed. Copilot's schema declares `RecurringRule.nameContains` non-nullable, but real data contains nulls — an upstream schema/data mismatch. Because GraphQL fails the whole response when a non-nullable field resolves null, requesting an unused field let a vendor-side inconsistency break our write path after the mutation had already committed.

## The fix
PR #291 trimmed the `EditRecurring` and `CreateRecurring` response selections to only the fields we consume (`RecurringFields` on the top-level `Recurring`); `editRecurring()` echoes the caller's input for `rule` instead of reading it back. Captures under `docs/graphql-capture/` updated and operations regenerated.

## Detector
Class-level for write round-trips: `scripts/verify-optimistic-consistency.ts` — the probe that found it — exercises real mutations end-to-end (it re-ran green post-fix). It is run on demand, not in CI. The narrower enum/shape drift class is now also covered by the `bun run smoke` conformance suite.

## Lesson
Select only what you consume: every extra field in a mutation response is an extra vendor invariant you're betting on, and a lost bet turns a successful write into a reported failure. Live round-trip probes catch what mocked tests structurally cannot.
