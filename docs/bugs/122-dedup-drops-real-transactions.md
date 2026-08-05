---
id: 122
title: Content-based dedup key silently dropped real transactions
class: identity-resolution
status: fixed
detected: user-report  # external user report (issue #119) with root-cause analysis
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/122
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/119
date: 2026-03-11
---

## Symptom
A category showed N transactions in the Copilot app but `get_transactions` returned N−1. Two genuinely distinct charges that shared merchant name, amount, and date (e.g. two same-day charges from the same merchant) were collapsed into one; the second was silently discarded, understating counts and totals.

## How it was detected
The project's first substantive external bug report: a user integrating the MCP into their own finance assistant noticed the count mismatch against the app, read the shipped bundle's source, and filed issue #119 pinpointing the exact dedup key. This bug had survived ~2 months and the entire test suite.

## Root cause
`decodeTransactions()` deduplicated with the key `${displayName}|${amount}|${date}`. The dedup's *intent* was to collapse the same Firestore document appearing multiple times across LevelDB levels (a storage artifact), but the key used **content** as identity instead of the **document ID** — so any two real-world transactions coinciding on those three fields were treated as one. Content equality is not identity; the cache already had a perfectly good identity key it wasn't using.

## The fix
PR #122 extracted `deduplicateTransactions()` keyed on `transaction_id` (the Firestore document ID), collapsing only true storage-level duplicates, applied in both `decodeTransactions()` and `decodeAllCollections()`, with tests for distinct same-name/amount/date transactions.

## Detector
Instance tests only for the dedup key itself. The honest class-level mechanism that has repeatedly caught identity/count drift since is comparison against ground truth (app UI or live GraphQL parity audits) — no automated cache-mode count-parity gate exists.

## Lesson
Dedup keys are identity claims. If the goal is to collapse storage duplicates, key on the storage identity (document ID), never on a content tuple — content collisions are routine in financial data (subscriptions, split cab fares, double coffee runs).
