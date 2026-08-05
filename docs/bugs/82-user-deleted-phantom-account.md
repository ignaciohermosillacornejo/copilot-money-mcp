---
id: 82
title: Soft-deleted (merged) account still appeared in accounts and net worth
class: stale-cache-semantics
status: fixed
detected: dogfooding  # MCP listed an account the app does not show
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/82
issue: none — found and fixed directly
date: 2026-01-16
---

## Symptom
`get_accounts` and net worth included a phantom retirement account that the Copilot app does not display — a stale duplicate left over from a years-old connection migration (the account had been auto-merged into a newer direct connection). Net worth was inflated by counting the same underlying account twice.

## How it was detected
Dogfooding: an account visible in MCP output but absent from the app. Initial suspicion fell on the `hidden` flag, but the customization collection was empty — the investigation revealed Copilot's actual mechanism.

## Root cause
Copilot marks merged/removed accounts with `user_deleted: true` on the account document rather than deleting the document or setting `hidden: true`. The decoder didn't extract `user_deleted` at all, and `getAccounts()`/`getNetWorth()` had no filter for it, so every soft-deleted account ever cached surfaced as live data. The code assumed "document exists in cache" implies "account exists" — a staleness-semantics assumption.

## The fix
PR #82 added `user_deleted` to the Account schema and decoder, filtered such accounts by default in `getAccounts()` and `getNetWorth()`, and added an `include_hidden` escape hatch. It also tightened default transaction filtering (transfers, deleted, excluded).

## Detector
None at the class level — and the class recurred: soft-deleted *transactions* (`user_deleted: true`) were only filtered much later (#326, 2026), and the soft-delete-vs-tombstone distinction per collection is now tribal knowledge captured in project notes rather than an automated gate. Each collection's deletion semantics still has to be discovered individually.

## Lesson
A local cache of a remote store carries the remote's deletion semantics, which are per-collection and undocumented. When adding any new collection, the first question should be "how does Copilot delete these?" — presence in the cache is not existence.
