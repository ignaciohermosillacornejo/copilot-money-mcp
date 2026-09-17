---
id: 624
title: Cache-mode get_accounts hides nothing — include_hidden filters against an extinct collection while the real flag is decoded and ignored
class: fixture-reality-drift
status: fixed
detected: audit-sweep  # deliberate sibling audit of the #622 class (code depends on a data shape reality no longer has), applied to a different collection
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/630
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
   (**Correction, 2026-09-16 / #666:** calling all three "customizations" was this
   entry's own unverified inference from finding them together on the account document.
   It holds for `nickname` and `user_hidden`, each of which got the consumer this entry
   implied — #624 and #660. It does not hold for `dashboard_active`: measured against a
   real cache and a live `Accounts` round-trip, it tracks account type rather than user
   intent, and most accounts carrying it as `false` are reported by the server as neither
   hidden nor closed. Filtering on it would have hidden every investment account. See
   `src/models/account.ts` for the measurement and `scripts/smoke/cache.ts` check 7 for
   the re-check. A triple that shares a home is not a triple that shares a meaning.)
2. The flag Copilot actually writes, `Account.user_hidden`, exists in the Zod model
   (`src/models/account.ts`) and is populated by the decoder — but appears nowhere in
   `tools.ts` or `database.ts`. Decoded, then dropped.

And the fixture half of the class: `tests/core/decoder-coverage.test.ts` still *builds*
`users/{uid}/accounts` documents, so the decoder for the extinct collection is well
covered while the field Copilot actually writes has no filter coverage at all. Tests and
code share the same wrong model of reality, so everything passes.

## The fix

Shipped in PR #630: filter on `acc.user_hidden === true` from the account document,
with a regression test that seeds a `user_hidden` account and asserts absence by default /
presence with `include_hidden: true` — mutation-checked per the #596 discipline. Then
decide the fate of the `getUserAccounts()` / `UserAccountCustomization` decoding path: if
the collection is genuinely extinct (to be confirmed beyond a single cache — one local
cache cannot prove absence, the sampling-bias trap #622 documented), it is dead code
carrying a decoder, a model, and fixtures, and should be removed rather than left looking
functional.

**Where that landed (#666, 2026-09-16):** not removed. The caveat above is the reason —
a second cache has not been looked at, and a decoder deleted is data that can no longer
be seen. Instead the path is labelled an extinct CANDIDATE at all three sites
(`UserAccountCustomization`, `decodeUserAccounts`, `CopilotDatabase.getUserAccounts`)
with the evidence and its limit written down, and `scripts/smoke/cache.ts` check 8
reports the collection's document count on every run so the evidence accumulates on
whatever machine runs it instead of being re-derived. Delete it when several independent
caches have reported zero.

## Detector

None — and notably, the detectors added for #622 (cross-path decode parity) would **not**
catch this instance: both decode paths agree, correctly, that there is nothing to decode
in the empty collection. This instance needs the other half of the class defense: an
invariant that a filter which is supposed to exclude things actually excludes something on
real data, or a real-cache smoke asserting that collections the code depends on are
non-empty (the proposed `smoke:cache`).

**Since shipped:** `smoke:cache` exists. Check 3 is the depended-on-collection invariant
described above. #666 added two more against the same class from the other direction —
check 7 re-measures that `dashboard_active` is still independent of visibility (the
assumption that keeps it OUT of the filter), and check 8 reports the document count of
the extinct-candidate collection. All three answer questions only real data can answer,
so none of them runs in CI.

## Lesson

A filter that reads from an empty source is a silent no-op that looks fully implemented
and fully tested. When an external system migrates a field to a new home, code watching
the old home fails open — the only defenses are periodic real-data checks that the shapes
you depend on still exist, and treating "collection is empty" as a signal, not a fact.
