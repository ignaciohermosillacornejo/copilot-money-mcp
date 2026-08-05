---
id: 478
title: Logged-out users got a raw PROJECT_NUMBER_MISMATCH error because the token extractor picked up other sites' Firebase tokens
class: ambiguous-candidate-selection
status: fixed
detected: incidental  # recurring confusing auth failure during live-session work, misread as API drift until root-caused
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/478
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/454
date: 2026-06-13
---

## Symptom

With no Copilot session in any browser, every write / live-read command failed with a raw
Firebase 400: `PROJECT_NUMBER_MISMATCH`. That reads like API or key drift — something broken
in the server's integration — when the real state was simply "the user is logged out of
app.copilot.money." Sessions were repeatedly derailed diagnosing a non-existent drift.

## How it was detected

Repeated hits during live-session work. The error kept being misattributed to schema/API
drift until it was root-caused to the extractor itself; issue #454 pinned the finding
("extractor surfaces foreign-project tokens instead of 'no Copilot session'").

## Root cause

When no Copilot session exists, `src/core/auth/browser-token.ts` falls back to the
browser-wide `Local Storage/leveldb` directory — which holds **every** site's storage. Any
Firebase-backed site leaves `AMf-` refresh tokens there. The old code committed to the
single longest `AMf-` match and handed it to a single securetoken exchange. With no Copilot
session, that single token belongs to a *foreign* Firebase project, and the exchange
correctly rejects it — but the rejection surfaced raw, with no path to "try the next
candidate."

Two compounding mistakes: (1) premature commitment to one candidate from a contaminated
pool before the only authority that can validate project membership (the exchange) runs;
(2) misattributing a benign downstream rejection ("this token is foreign") as a terminal
system error.

## The fix

`extractRefreshTokenCandidates()` returns the full de-duplicated candidate list.
`FirebaseAuth.getIdToken()` tries each candidate's exchange, discarding
`PROJECT_NUMBER_MISMATCH` results and continuing; the first clean exchange wins. Empty or
all-foreign candidate lists produce the actionable "No Copilot Money session found… log
into https://app.copilot.money" message. Genuine non-mismatch failures for a Copilot-project
token still surface raw.

## Detector

Instance-level ratchet only: unit tests pin "foreign-only candidates → 'no session', raw
Firebase code never leaks" (`tests/.../firebase-auth.test.ts`). No class-level gate — the
conformance ledger is scoped to Copilot's GraphQL surface and has no category for
client-side assumptions like "a token found in browser storage belongs to Copilot's
project." Note the fix itself later caused a sibling bug: six `scripts/` call sites were
never migrated to the new extractor contract (see the #530 entry).

## Lesson

Never commit to one candidate from a noisy multi-source pool before the validating
authority has run — collect all candidates and let validation choose. And classify
downstream rejections before surfacing them: a benign "not yours" is not an error, it's a
signal to try the next candidate.
