---
id: 419
title: create_recurring rejected 5 valid cadences and accepted invalid YEARLY, blaming the server
class: external-api-drift
status: fixed
detected: live-probe  # the June 2026 write-field audit exercised the tool against production
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/420
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/419
date: 2026-06-08
---

## Symptom
It was impossible to create a yearly, bimonthly, quarterly, quadmonthly, or semiannual recurring through the tool at all. `ANNUALLY` (the server's real value) was rejected locally; the natural-but-wrong `YEARLY` passed local validation, hit the server, and surfaced as the misleading blanket message "Copilot's API changed in a way this tool doesn't handle yet. Please report this issue." — blaming the vendor for a client-side bug.

## How it was detected
Confirmed live during the write-field audit: probing `create_recurring` against production showed every mismatch in a table (valid values rejected locally, invalid value rejected by the server). This was not upstream drift — the list had been wrong since it was written.

## Root cause
The frequency allowlist `['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'YEARLY']` was **assumed, never probed**, at the Firestore→GraphQL write migration (`059739b`): `YEARLY` matched the lowercase cache-side model, but the GraphQL `RecurringFrequency` enum uses `ANNUALLY` and has 8 values. Duplication let it hide — the list existed in 4 places (create/update × guard/schema) and `create_recurring`'s copies drifted from `update_recurring`'s probe-derived one (#417). Unit tests used a mock client that echoed any frequency, validating the code against its own assumption. A secondary defect: the error mapper turned the server's rejection into "the API changed," hiding the real server text (fixed separately as the C2 error taxonomy, #449).

## The fix
Single source of truth `RECURRING_FREQUENCIES` (8 server-verified values) in `src/core/graphql/recurrings.ts`; all four sites reference it; unit tests lock `ANNUALLY` accepted and `YEARLY` rejected locally.

## Detector
The strongest class-level detector in the repo's history: a permanent, non-mutating live conformance smoke (`bun run smoke`, harness generalized in #422) probes the real server and asserts each exported enum constant exactly matches the server's enum, with a known-bad control proving the probe can fail. Because the smoke checks the same constant the tools use, any future drift on either side fails it. Extended by the conformance ledger (#450) and scheduled drift runs (C1).

## Lesson
An allowlist for an external enum is a factual claim about someone else's system — it needs an oracle, not a code review. Duplicated copies of such claims drift independently; dedup to one constant and point the oracle at that constant.
