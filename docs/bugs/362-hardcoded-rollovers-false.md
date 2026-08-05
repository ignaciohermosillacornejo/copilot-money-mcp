---
id: 362
title: Categories query hardcoded rollovers:false, zeroing rollover amounts for rollover users
class: config-blind-default
status: fixed
detected: audit-sweep  # 2026-05-03 live-mode parity audit (finding C6)
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/362
issue: none — found and fixed directly (audit finding C6)
date: 2026-05-04
---

## Symptom
For users who had enabled budget rollover in Copilot (Settings → Budgeting → Enable rollover), `get_categories_live` silently reported rollover amounts as zero. Budget math downstream was wrong relative to what the app shows, with no error anywhere.

## How it was detected
Live-mode parity audit, comparing tool output field-by-field against the web app. The audit's Lessons Learned named this "Pattern 4": a static guessed default where the web app forwards per-user configuration.

## Root cause
`fetchCategories` always passed `rollovers: false` to the GraphQL `Categories` query. The real web client first reads the user's `budgetingConfig` from the GraphQL `User` query and forwards the actual toggle value; our wrapper hardcoded a guess that was correct only for rollover-disabled users.

## The fix
Added a `User` query wrapper (`src/core/graphql/queries/user.ts`) and a `userCache` (24h TTL) on `LiveCopilotDatabase`; `fetchCategories` is parameterized on `{ rollovers }` and `LiveCategoriesTools` derives the flag from the user's actual config (with a defensive `isEnabled === false` fallback). `refresh_cache --scope user` lets consumers pick up a settings change immediately.

## Detector
none — instance-only regression tests. Parity audits are the recurring sweep that catches this class; there is no automated gate asserting "every hardcoded query argument matches what the web client sends."

## Lesson
When wrapping an API the vendor's own client also calls, any constant you pass where the vendor passes derived state is a bug for every user whose state differs from your constant. Enumerate the reference client's request parameters and ask, for each literal: where does the real client get this value?
