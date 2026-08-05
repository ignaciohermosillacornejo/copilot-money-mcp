---
id: 498
title: Write tools could only edit transactions inside the ~30-day local cache window, despite docs promising otherwise
class: stale-cache-semantics
status: fixed
detected: user-report  # external contributor report with a live repro (get_transactions_live returns the row, update_transaction on the same id throws)
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/498
issue: none — found and fixed directly (follow-up class sweep tracked in #509, #510, #511, #513, #518, #521, #526)
date: 2026-06-19
---

## Symptom

`update_transaction` and `review_transactions` threw `Transaction not found: <id>` for any
transaction older than what the local LevelDB cache happened to hold — even in `--write`
mode, and even when `get_transactions_live` had *just returned that exact row*. On a real
account, dozens of decodable transactions were silently un-editable. The README already
promised "write tools resolve transaction metadata against the live GraphQL surface so they
can edit any transaction the API exposes" — the docs described behavior the code did not
have.

## How it was detected

An external contributor hit it and filed PR #498 with the repro: read an older transaction
via the live read path, then try to edit it → `Transaction not found`. No internal test or
gate caught it, because tests seed the cache with the transactions they then edit.

## Root cause

Both tools resolved a transaction's `accountId`/`itemId` exclusively from
`this.db.getAllTransactions()` — the local LevelDB cache, which Copilot auto-fetches only
~30 days into and LRU-evicts beyond. Any id outside that window was unresolvable, so the
write was refused before the API was ever asked.

This turned out to be a *class*, not an instance. The same local-only resolution existed in
`createRecurring`, `splitTransaction`, and `deleteTransaction`, and the follow-up sweep
found five more members: split-parent content read from LevelDB (#509→PR #514),
category/tag id validation against LevelDB in live mode (#510→PR #517), no cross-session
persistence of routing ids (#511→PR #522), the windowed fetch missing same-month
future-dated rows (#513→PR #516), and guard/telemetry gaps on the feed paths (#518→PR #527,
#526→PR #532). The class was closed with caller-supplied routing-id bypasses (PR #570,
PR #573) on 2026-07-24.

## The fix

PR #498 added a shared `resolveTransactionMeta(ids)` that prefers the local cache and falls
back to a single live GraphQL window fetch (default 13 months). PR #508 then inverted the
architecture — live-first meta index, LevelDB dropped from live-mode resolution — and the
sibling PRs above migrated every other resolver consumer.

## Detector

None class-level — the class was closed *structurally* (live-first resolution everywhere,
plus caller-supplied routing ids as the escape hatch), with per-sibling regression tests.
The effective gate was the deliberate, tracked sibling sweep (#509–#526), not an automated
check.

## Lesson

When a data source has a window, every consumer of that source inherits the window —
finding one windowed consumer means auditing all of them. And a README claim is a spec: the
docs promised live resolution before the code had it, and nothing tested the claim.
