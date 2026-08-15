---
id: 640
title: Every tool call — including pure-GraphQL live tools — blocked on machines without the native app's local cache
class: overbroad-precondition-gate
status: fixed
detected: user-report # issue #640 — a --write user on a machine that never had the native app installed
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/644
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/640
date: 2026-08-15
---

## Symptom

On a machine where the native Copilot Money macOS app was never installed (no LevelDB
cache on disk), every tool call returned:

```
Database not available. Please ensure Copilot Money is installed and has created
local data, or provide a custom database path.
```

This included `get_accounts_live` and the rest of the `_live` family under
`--write`/`--live-reads` with a fully valid, logged-in browser session — tools whose
handlers never touch the local cache at all. The reporter worked around it by pointing
`--db-path` at a directory containing a dummy `MANIFEST-000001` file.

## How it was detected

User report (issue #640), with the diagnosis already done: the reporter read
`dist/cli.js`, found the unconditional `db.isAvailable()` check in `handleCallTool()`,
confirmed from `TOOL_REGISTRY` that live handlers call `ctx.live.*` and never read
`this.db`, and included a working dummy-file workaround.

## Root cause

`handleCallTool()` (`src/server.ts:210` at the time) applied the `db.isAvailable()`
gate to every dispatch, before consulting the tool's registry classification. The gate
predates live mode — when it was written, every tool did read the cache — and was never
rescoped when `requiresLiveReads` tools arrived. A precondition for one resource
(the local LevelDB cache) sat at a shared chokepoint and silently asserted "all
requests need this."

## Why the tests didn't catch it

Live-mode tests built servers either with mock databases whose `isAvailable()` returns
true, or with paths on dev machines where the real cache exists. The db-unavailable
tests (`server-protocol.test.ts`, `e2e/server.test.ts`) only ever called cache-mode
tools, where the gate is correct. The failing configuration — cache absent *and* live
mode on, i.e. exactly a live-only user's machine — was never constructed, because every
contributor machine has the native app installed.

## The fix

PR #644. Root-cause fix: the gate is now scoped by the same registry classification
that drives listing and dispatch — it fires only for tools whose dispatch actually
reads the cache (`!requiresLiveReads && (readOnly || no live layer)`). Live tools run
entirely on GraphQL; live-mode writes resolve live-first and touch the cache only via
null-guarded `patchCached*` write-through, which no-ops when the cache never loaded.
Downstream cleanup: the gate moved after tool resolution, so an unknown tool name now
reports `Unknown tool` instead of the database message when the cache is absent.

## Detector

Registry-walk tests in `tests/integration/live-reads.test.ts`: on a server built with
a nonexistent db path and live+write mode, every `LIVE_TOOL_DEFS` and
`WRITE_TOOL_DEFS` entry must dispatch past the gate (its response must not be the
db-unavailable message). New tools join the sweep through registry membership, so the
detector covers the class, not the instance. Mutation-verified: reverting the gate to
unconditional sends three tests red.

## Lesson

A precondition checked at a shared chokepoint carries an implicit "every request needs
this" claim that rots as tool classes diversify. When a registry already classifies
what each tool needs, derive every gate from it — a gate that isn't registry-derived
is a parallel list waiting to drift.
