---
id: 72
title: Brokerage account silently missing because its document exceeded the decoder's scan window
class: heuristic-decode-bleed
status: fixed
detected: dogfooding  # an account visible in the app was absent from MCP output
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/72
issue: none — found and fixed directly
date: 2026-01-14
---

## Symptom
`get_accounts` and net-worth output omitted an entire brokerage account (with a substantial balance) that was plainly visible in the Copilot app. No error, no warning — the account simply did not exist as far as the MCP server was concerned.

## Root cause
Three compounding assumptions in the window-scanning decoder (`src/core/decoder.ts` at the time):
1. It keyed account detection on a `current_balance` field pattern; some brokerage accounts store `original_current_balance` instead, so the anchor pattern never matched.
2. The scan window was 2,500 bytes, but some account documents span 6,000+ bytes (they embed base64 institution images), so even when anchored, related fields fell outside the window.
3. Field search only looked on one side of the balance field, but real documents have varying field orderings.

Any record that didn't fit the assumed size/shape was silently dropped — the failure mode of heuristic windows is data loss, not an exception.

## How it was detected
Dogfooding: the maintainer compared MCP account output against the Copilot app and noticed the account was missing entirely.

## The fix
PR #72 patched the instance: added the `original_current_balance` / `original_type` / `original_subtype` fallbacks, widened the window to 6,500 bytes, searched both sides of the anchor, and deduplicated by account ID. The real fix landed the same day in PR #73, which replaced window scanning with structural LevelDB/protobuf parsing that "handles documents of any size correctly."

## Detector
Architectural: structural parsing (PR #73/#74) removed the window-size failure mode for the whole class. The real-database integration test added in #74 (counts of decoded transactions/accounts vs the live cache) is the closest ongoing gate. Nothing at the time could detect a silently missing record.

## Lesson
When a heuristic parser fails, it fails *silently by omission* — the most dangerous mode for financial data. Completeness checks against a ground-truth count (the app, or a raw record census) are the only way to see what a lossy parser never emits.
