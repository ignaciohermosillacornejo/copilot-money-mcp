---
id: 537
title: Read-query interfaces systematically declared the wrong wire types (string amounts that are numbers, non-null prices that are null)
class: wire-type-drift
status: fixed
detected: detector-first  # warn-mode Zod validation of live read responses surfaced the drift slice by slice; one instance surfaced earlier via a smoke failure
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/551 (infra; corrections landed across PRs 551, 554, 555, 557, 558, 559, plus 535)
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/537
date: 2026-07-18
---

## Symptom

Multiple GraphQL read interfaces lied about wire types:

- Net-worth and monthly-spend amounts: declared `string`, wire returns `number`.
- `CategoryBudgetMonthly`'s eight amount fields: declared `string | null`, wire returns
  `number` — ~9,920 `expected string, received number` warnings the moment the categories
  read was first gated (#553).
- `Security.lastUpdate` and `latestBalanceUpdate`: declared `string`, wire returns `number`.
- `securityPrices[].price`: declared non-null `number`, wire returns `null` for days with
  no price — a live series could emit null/NaN points (#534).

Most of this was *masked*: `parseAmount()` does `Number(value)`, which coerces a number
just as happily as a string, so outputs were usually numerically correct despite the type
lies. The genuinely wrong outputs were the null-price series points and a subtler one:
after `set_budget`, the optimistic cache patch (`patchLiveCategoryBudget`) *stringified*
amounts into the live cache, so a caller could see string-typed amounts from the patched
cache and number-typed amounts from a fresh server read — inconsistent shapes for the same
field within one session.

## How it was detected

Deliberately, by building the class detector and pointing it at every read: #551 added
warn-mode Zod validation infrastructure for read responses plus `smoke:reads`, and each
subsequent gating PR (554/555/557/558/559) surfaced the drift on its slice as a wall of
warnings. The `securityPrices` null had surfaced slightly earlier as a Tier-0 read-smoke
failure while validating unrelated work (#534). This is the reverse of the usual story: the
bugs did not trigger detector-building — detector-building flushed out the bugs.

## Root cause

Read interfaces were written from convention and assumption (Firestore-style string-encoded
amounts) instead of probed wire types, and the codebase's tolerant coercion
(`parseAmount(string | null)` doing `Number(value)`) made both types "work," so nothing
ever disagreed loudly. Bidirectional tolerance — the optimistic patch writing strings, the
reader coercing anything — is exactly what kept the mismatch invisible until runtime shape
validation existed.

## The fix

Types corrected end-to-end (`number` for the amount/timestamp fields, `number | null` for
price), the optimistic patch stopped stringifying, `parseAmount` widened to accept `number`
honestly, string-amount fixtures across ~7 test files converted to numbers, and all 18 read
query shapes registered in `QUERY_RESPONSE_SCHEMAS` with ledger entries flipped to
`gatedQueryResponseShape`.

## Detector

Class-level and real — the strongest detector story in the repo: runtime `read-zod-warn`
validation on all 18 read shapes, drift counters reported after every read smoke (#566),
dedup so one drift warns once instead of per-row (#565), and the weekly scheduled drift
check running the smoke against the live endpoint.

## Lesson

Probe wire types before writing a read schema — a TypeScript interface written from memory
is an unverified assumption with a compiler's confidence. And tolerant coercion converts
type lies into silent debt: the friendlier your parsing, the more you need runtime shape
validation to tell you what the wire actually says.
