---
id: 302
title: Null vested_* fields in holdings made Zod throw, silently dropping whole accounts
class: wire-type-drift
status: fixed
detected: dogfooding  # investment accounts missing from get_accounts output
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/302 (sibling schema in https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/310)
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/306 (filed for the sibling)
date: 2026-04-18
---

## Symptom
Entire investment accounts (plain brokerage, IRA, Roth, cash-management — anything that is not a stock-plan account) vanished from `get_accounts` output. No error, no warning: the accounts simply were not in the list.

## How it was detected
Found on the author's real cache: accounts known to exist did not appear in tool output. Tracing the drop led to a Zod parse failure that was being swallowed. The mechanism of first notice was not formally recorded — there was no issue for the primary bug; it was found and fixed directly.

## Root cause
`AccountHoldingSchema` (`src/models/account.ts`) declared `vested_quantity` and `vested_value` as `z.number().optional()`, which rejects `null`. Copilot writes literal `null` for these fields on every non-stock-plan investment account. Zod threw on parse, and `processAccount`'s `catch` silently returned `null` — dropping the whole account document, not just the bad field. The identical declaration existed in the sibling `PlaidAccountSchema` (`src/models/plaid-account.ts:19-20`), latent because no plaid-path holdings had nulls yet; it was fixed five days later via #306/#310.

## The fix
Both fields switched to `.nullable().optional()`, matching the existing `cost_basis` pattern in the same schemas. Regression tests cover null / numeric / omitted shapes in both files.

## Detector
`validateOrWarn` (#311, filed as #309 in direct response to this bug) — schema-parse drops now log a warn instead of silently returning null, so the next schema/reality mismatch is loud. The later read-side zod-warn program (#537 era) extended the same posture to GraphQL responses. The sibling fix (#310) is an early instance of the "siblings checked" ritual later codified in the Bug Response Ritual.

## Lesson
A validation failure that discards the whole document is worse than no validation. Two aggravators compounded a one-field type mismatch: catch-and-return-null masking, and a copy-pasted sibling schema carrying the same wrong declaration.
