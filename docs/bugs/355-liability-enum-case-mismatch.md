---
id: 355
title: total_liabilities came back 0 — lowercase literals compared against uppercase server enums
class: fixture-reality-drift
status: fixed
detected: audit-sweep  # 2026-05-03 live-mode parity audit, MCP totals vs the web app's Assets/Debts split
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/355
issue: none — found and fixed directly (audit finding A1)
date: 2026-05-04
---

## Symptom
`get_accounts_live` reported `total_liabilities: 0` and inflated `total_assets`: every credit-card and loan balance was bucketed as an asset. The `account_type` filter had the same blindness.

## How it was detected
First finding of the 2026-05-03 live-mode parity audit — a deliberate side-by-side of MCP output against the Copilot web app. The app's Assets/Debts split disagreed with the tool's totals.

## Root cause
`LIABILITY_TYPES = new Set(['credit', 'loan'])` (lowercase) was compared against the server's uppercase enum values (`'CREDIT'` / `'LOAN'`). The bucket loop never matched, so all liabilities fell into the asset `else` branch. The tests passed because **fixtures used lowercase types too** — the tests and the code shared the same wrong belief about the server's shape, which is the defining property of this class.

## The fix
Normalize via `.toUpperCase()` at the bucket-comparison and filter sites; `LIABILITY_TYPES` now holds the uppercase canonical values. All fixtures were rewritten to uppercase to mirror the real response shape, so reintroducing the lowercase comparison fails tests.

## Detector
Class-level: issue #433 ("type-derived GraphQL mocks — wrong mock shapes must fail tsc", shipped as PR #457) makes mocks derive from the GraphQL response types, so a fixture that diverges from the declared wire shape no longer compiles. Enum-value conformance itself is covered by the live smoke harness (#422). At fix time, only instance regression tests existed.

## Lesson
A fixture invented from the same assumption as the code cannot catch the assumption being wrong. Fixtures must be transcribed from observed server responses (or derived from wire types), never composed from memory.
