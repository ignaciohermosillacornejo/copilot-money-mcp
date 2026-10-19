---
id: 848
title: get_recurring_live returned category_name null on every row until another tool had loaded categories
class: path-divergence
status: fixed
detected: live-probe  # release parity re-run 2026-10-18, a cold call before any categories read
fixed_in: not yet
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/848
date: 2026-10-18
---

## Symptom

On a fresh session, `get_recurring_live` returned `category_name: null` on every row. After
any tool that loads categories had run, the same call returned real names. The answer depended
on what had run earlier in the session. The rows looked complete, so the bug was silent.

## How it was detected

The 2026-10-18 release parity re-run (item 1 of #848) called the tool cold and compared it
with the web app.

## Root cause

`src/tools/live/recurring.ts` and `src/tools/live/upcoming-recurrings.ts` enriched rows with
`LiveCopilotDatabase.peekCategoryNameMap()`, which returns an empty map when the categories
cache is cold and never fetches. `get_transactions_live` loads categories itself, so the three
tools that join the same names disagreed on a cold cache. The descriptions told callers to
call `get_categories_live` first, which documented the bug instead of fixing it.

## Why the tests didn't catch it

The cold-cache test asserted the buggy behaviour (`category_name` is null when the cache is
cold), so it pinned the defect as intended.

## The fix

`peekCategoryNameMap` became `loadCategoryNameMap`, which loads categories on a cold cache
with the same rollovers-aware fetch as every other consumer. Both recurring tools use it, and
their descriptions no longer ask callers to warm the cache.

## Detector

The cold-cache tests in `tests/tools/live/recurring.test.ts` and
`tests/tools/live/upcoming-recurrings.test.ts` now require a populated `category_name` with
nothing warmed beforehand. Mutation-checked: taking the load back out turns the recurring test
red. Instance-level, but it covers both tools that had the peek. The peek-only helper is
deleted, so the same mistake can't be made by reaching for it again.

## Lesson

A row field that depends on what ran before is a bug even when the description admits it.
