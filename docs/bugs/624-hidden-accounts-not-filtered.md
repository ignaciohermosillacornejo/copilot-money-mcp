---
id: 624
title: Cache-mode get_accounts hides nothing — include_hidden filters against an extinct collection while the real flag is decoded and ignored
class: fixture-reality-drift
status: open
detected: audit-sweep  # deliberate sibling audit of the #622 class (code depends on a data shape reality no longer has), applied to a different collection
fixed_in: none yet — issue open
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/624
date: 2026-08-05
---

## Symptom

An account hidden in the Copilot app is returned by a default `get_accounts()` call
(`include_hidden` defaults to `false`). Verified on a real cache: an account carrying
`user_hidden: true` comes back along with everything else. Nothing is filtered except
deleted accounts. Cache mode only — `get_accounts_live` is GraphQL-backed and correct.

## How it was detected

Not by a user and not by a test. It was found by auditing *siblings of #622* — after #622
established the class "code reads a data shape reality no longer has," someone asked which
other collections the code depends on in the same assumed way. This is the class taxonomy
doing its job: the second instance was found by looking for it.

## Root cause

`src/tools/tools.ts:1218-1227` implements hiding in two steps: filter `user_deleted`, then
build `hiddenIds` from `getUserAccounts()` — the `users/{uid}/accounts` customization
collection. Two problems:

1. That collection is **empty** on a real cache — Copilot migrated account customizations
   (`nickname`, `user_hidden`, `dashboard_active`) onto the account documents themselves.
   So `hiddenIds` is always the empty set and the second filter is a permanent no-op.
2. The flag Copilot actually writes, `Account.user_hidden`, exists in the Zod model
   (`src/models/account.ts:74`) and is populated by the decoder — but appears nowhere in
   `tools.ts` or `database.ts`. Decoded, then dropped.

And the fixture half of the class: `tests/core/decoder-coverage.test.ts` still *builds*
`users/{uid}/accounts` documents, so the decoder for the extinct collection is well
covered while the field Copilot actually writes has no filter coverage at all. Tests and
code share the same wrong model of reality, so everything passes.

## The fix

Proposed (issue open): filter on `acc.user_hidden === true` from the account document,
with a regression test that seeds a `user_hidden` account and asserts absence by default /
presence with `include_hidden: true` — mutation-checked per the #596 discipline. Then
decide the fate of the `getUserAccounts()` / `UserAccountCustomization` decoding path: if
the collection is genuinely extinct (to be confirmed beyond a single cache — one local
cache cannot prove absence, the sampling-bias trap #622 documented), it is dead code
carrying a decoder, a model, and fixtures, and should be removed rather than left looking
functional.

## Detector

None — and notably, the detectors added for #622 (cross-path decode parity) would **not**
catch this instance: both decode paths agree, correctly, that there is nothing to decode
in the empty collection. This instance needs the other half of the class defense: an
invariant that a filter which is supposed to exclude things actually excludes something on
real data, or a real-cache smoke asserting that collections the code depends on are
non-empty (the proposed `smoke:cache`).

## Lesson

A filter that reads from an empty source is a silent no-op that looks fully implemented
and fully tested. When an external system migrates a field to a new home, code watching
the old home fails open — the only defenses are periodic real-data checks that the shapes
you depend on still exist, and treating "collection is empty" as a signal, not a fact.
