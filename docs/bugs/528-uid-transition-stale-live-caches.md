---
id: 528
title: Live caches kept serving the previous account's data after a mid-session re-auth as a different user
class: stale-cache-semantics
status: fixed
detected: adversarial-review  # adversarial final review of the adjacent PR (#511/#522) asked what happens to the other caches on a uid transition
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/528
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/521
date: 2026-07-08
---

## Symptom

If the session re-authenticated as a *different* Copilot account mid-process (token refresh
failure → cold re-extract picking up another browser login), the in-memory live caches —
transactions window cache and the snapshot caches for categories, tags, accounts,
recurrings, user, holdings, balance history — kept serving the **previous** login's full
data until their TTLs expired. Reads and write-side validations could mix two identities'
financial data in one session.

## How it was detected

Nobody hit it in the wild. The final review of #511 (persistent per-uid routing-id index)
asked the natural follow-up: the meta index now clears on a uid transition — what about
every *other* live cache? The answer was "nothing clears them," and the reviewer noted the
severity is strictly higher than the meta index case, because these caches hold full nodes,
not just routing ids. Filed as #521.

## Root cause

The live caches were keyed by nothing user-specific. Session identity was an implicit
ambient assumption: each cache was written under whatever uid was current at fetch time and
read back under whatever uid was current at read time, with no invalidation tying the two
together. PR #522 had fixed exactly this for one cache (the meta index) without sweeping
the rest.

## The fix

PR #528 flushes **all** live caches at a shared chokepoint on any
non-null → different-non-null uid transition, rather than patching each cache
individually.

## Detector

Partial class-level: the shared chokepoint means a future cache registered through the same
path is flushed by default, and the repo convention since then is that every new live cache
ships uid-transition flush coverage (the later investment-tool PRs #546/#548/#550 each
added a "uid-flush" test). There is no automatic gate that *forces* a brand-new cache to
register with the chokepoint — that part is convention plus review.

## Lesson

Any cache implicitly keyed by "the current user" must be invalidated on identity
transition — and when you find one such cache, the finding is about the *pattern*, so sweep
every cache in the process before closing the issue.
