---
id: 294
title: --write parsed but hardwired to false — the 2.0.0 headline feature was a no-op in the CLI
class: stale-kill-switch
status: fixed
detected: audit-sweep  # surfaced via the unaddressed-suggestions audit trail on the 2.0.0 doc-cleanup PRs (issue #282)
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/294
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/282
date: 2026-04-16
---

## Symptom
2.0.0 shipped announcing "GraphQL write tools restored" — but a user running the published CLI with `--write` got a read-only server. The flag parsed fine, no error, no warning (in non-verbose mode); write tools simply never appeared. Meanwhile the CLI *did* print a stale "writes temporarily unavailable" banner contradicting the 2.0.0 CHANGELOG, PRIVACY, and SECURITY docs.

## How it was detected
Caught by the automated post-merge audit trail (the #282 "unaddressed suggestions" issue on the doc-cleanup PR #281) while stale-writes references were being purged from the docs — the docs cleanup exposed that the code still had the same staleness.

## Root cause
When writes broke (403, see #266), v1.7.0 deliberately neutered the CLI: `src/cli.ts` printed an unavailability notice and called `runServer(dbPath, timeoutMs, false)` with a hardcoded `false` where the write flag belonged. The 2.0.0 rewrite (#275) restored the write machinery and updated docs/manifest — but nobody revisited the CLI's kill-switch. A temporary disablement had no marker tying it to the condition it guarded, so it silently outlived that condition through a major release.

## The fix
`cli.ts` forwards the parsed `writeFlagSeen` to `runServer()`, drops the stale banner, logs "Write tools enabled (--write)" under `--verbose`, and documents `--write` in `--help`. The CLI test asserting the stale banner was inverted to assert its absence.

## Detector
none — instance-only CLI unit test that the flag plumbs through. There is no general gate for "temporary disablement outlived its reason"; the honest mitigation is procedural — a kill-switch should land with a tracking issue for its own removal.

## Lesson
A kill-switch is a loan against the future: tie it to a tracked issue and grep for the disablement when the underlying capability returns. Also — a test that pins the disabled behavior (as the old banner test did) turns the safety net inside out: it *defends* the stale state instead of flagging it.
