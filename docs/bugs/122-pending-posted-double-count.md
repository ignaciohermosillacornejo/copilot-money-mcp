---
id: 122
title: Pending and posted versions of the same charge both counted — category totals doubled
class: stale-cache-semantics
status: fixed
detected: user-report  # external user report (issue #119)
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/122
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/119
date: 2026-03-11
---

## Symptom
`get_categories` reported exactly 2x the correct total for a category, while `get_transactions` filtered to the same category showed one transaction with the correct amount, and the app showed the correct number. The doubling appeared and disappeared as charges moved through the pending→posted lifecycle.

## How it was detected
Same external user report as the dedup bug (issue #119): the reporter noticed a category total exactly double a known charge and traced both versions in the cache.

## Root cause
When a pending charge posts, Copilot's cache temporarily holds **two documents for one real-world charge**: the pending version and the posted version, usually with *different display names* (banks rename on settlement). The (already flawed) content-keyed dedup couldn't match them because the names differ, and category aggregation summed both. The code assumed one cache document = one real transaction, ignoring the lifecycle: the posted document carries `pending_transaction_id` pointing at the pending version it supersedes.

## The fix
PR #122 added `reconcilePendingTransactions()`: when a posted transaction's `pending_transaction_id` matches a pending transaction in the set, the superseded pending version is dropped; pending-only charges are preserved. Applied in both decode paths, with tests for the pair-reconciliation and pending-only cases.

## Detector
Instance tests for the reconciliation helper. No standing gate asserts "no two surviving transactions reference each other via pending_transaction_id" across the decode surface; UI/live-parity comparison remains the practical class detector.

## Lesson
A synced cache stores *states of records over a lifecycle*, not just records — every aggregation over it must decide which lifecycle state wins. Whenever the source schema has a "this supersedes that" pointer (`pending_transaction_id`), an aggregation that ignores it is double-counting by construction.
