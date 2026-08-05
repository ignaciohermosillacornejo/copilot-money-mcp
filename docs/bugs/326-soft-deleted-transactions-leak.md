---
id: 326
title: Deleted transactions kept appearing in reads — Copilot soft-deletes, decoder never filtered
class: stale-cache-semantics
status: fixed
detected: live-probe  # smoke-testing the new write tools (create→delete→re-read) against a real account
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/344
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/326
date: 2026-05-03
---

## Symptom
A transaction deleted via `delete_transaction` (server-confirmed, synced by the desktop app) still appeared in `get_transactions` output indefinitely — until an eventual LevelDB compaction of uncertain cadence. On a real cache the leak measured 43 of ~1200 rows (3.6%), all deleted test-transaction stragglers.

## How it was detected
Discovered 2026-04-22 while smoke-testing the four new write tools (#320–#323) against a real Copilot account: a create→delete→fresh-decode round trip found the deleted row still present with all fields intact.

## Root cause
The issue's initial hypothesis (decoder ignores Firestore `NoDocument` tombstones) was wrong — the decoder handles tombstones correctly. The real mechanism: Copilot uses **two deletion strategies by entity type**. Transactions are soft-deleted via a `user_deleted: true` field on an otherwise-intact document (zero tombstones existed for transactions in a cache holding 205 tombstones for other collections). The decoder captured `user_deleted` but no read path filtered on it.

## The fix
Filter `user_deleted === true` transactions in the read path, mirroring the pre-existing accounts filter (`tools.ts:991` at the time), with a `exclude_deleted=false`-style guard behavior locked by test. A decoder-level unit test reproduces the leak (RED) and confirms the fix (GREEN).

## Detector
Instance-level: the smoke-graphql transactions-write section asserts deleted transactions disappear after `refresh_database` (#346/#348). No cross-collection gate asserts each collection's deletion semantics (tombstone vs soft-delete) is handled; the dual-strategy fact is recorded in project memory instead.

## Lesson
"Deletion" is an external semantic that must be probed per entity type, not assumed uniform. Verifying the tombstone path worked proved nothing about transactions, because transactions never use it.
