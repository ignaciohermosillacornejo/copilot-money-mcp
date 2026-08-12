---
id: 631
title: Every LevelDB read left its ~120 MB temp copy on disk — 366 stale directories (~33 GB) filled a user's disk
class: deferred-cleanup-never-runs
status: fixed
detected: user-report  # a user's disk filled; they traced the `copilot-leveldb-*` pile back to this module and filed #631 with the mechanism
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/632
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/631
date: 2026-08-12
---

## Symptom

`os.tmpdir()` accumulated one `copilot-leveldb-*` directory per read, forever. Each is a
full copy of the Copilot LevelDB (~120 MB). On the reporting machine, automation that hit
the MCP a handful of times a day for several weeks produced **366 directories, ~33 GB**,
and the disk filled — at which point unrelated work started failing with `ENOSPC` while
the server itself still appeared healthy.

Nothing in the tool's own output was wrong. The failure surfaced somewhere else entirely
(a full disk), which is why it went unnoticed for weeks despite being trivially visible in
`ls "$TMPDIR"`.

## How it was detected

Not by anything this project built. A user ran out of disk space, went looking for what
was eating it, found the pile of `copilot-leveldb-*` directories, and read the source to
work out why they were never deleted. The issue arrived with the mechanism already
diagnosed.

Worth recording plainly: the module had a passing test suite covering exactly this
lifecycle — refcounting, TTL expiry, the cleanup callback — and none of it could see the
bug, because all of it ran in a process that never exited during the test.

## Root cause

`releaseTempDatabase` (`src/core/leveldb-reader.ts`) deferred deletion to a timer:

```ts
if (cached.refCount <= 0) {
  setTimeout(() => scheduledCleanupCallback(srcPath, scheduledTime), TEMP_DB_CACHE_TTL); // 5 min
}
```

The design assumed a long-running host. Neither real host is one: the MCP server is
normally spawned per request and exits when stdin closes, and the actual decode runs in a
worker thread (`dist/decode-worker.js`) that is done milliseconds after it posts its
result. Node drops pending timers on exit, so the 5-minute callback essentially never ran
— and it was the only thing that deleted anything.

Two aggravating details, both fixed in the same PR:

- The TTL timer was not `unref()`'d, so on the main-thread path it kept the *worker*
  alive for the full 5 minutes after its work was done — holding the V8 isolate and
  native LevelDB memory that worker isolation exists to release promptly.
- `copyDatabaseToTemp` creates the directory with `mkdtempSync` and only records it in
  `tempDbCache` after the copy loop succeeds. A real mid-copy failure (EACCES/EIO) left a
  directory that no in-process cleanup path could name. Small, but it is the same class
  reached from a different direction, and the repo's own test suite was stranding one
  directory per run through it.

## Why the tests didn't catch it

`tests/unit/signal-timer-coverage.test.ts` and the reader's unit tests exercised the
cleanup thoroughly — by calling `_runScheduledCleanup` directly, i.e. by doing for the
code the one thing production never did. They asserted "when the callback runs, the
directory is deleted", which was true and always had been. The false assumption was not in
the assertion but in the harness: a same-process test cannot observe that its process
would have exited before the timer fired.

The property that was actually broken — *no temp copy outlives the process that made it* —
is not expressible in a same-process test at all. It needs a child process, which is why
the regression tests spawn one.

## The fix

[PR #632](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/632), in
three parts:

- **Root cause:** a lazily-registered `process.on('exit')` sweep, plus `once` handlers for
  SIGINT/SIGTERM/SIGHUP that sweep and re-raise, so deletion is tied to process exit
  rather than to a timer. The TTL timer stays (it preserves the reuse cache that avoids
  re-copying ~120 MB) but is now `unref()`'d and is no longer load-bearing.
- **Reclaim:** a best-effort orphan sweep on startup removes `copilot-leveldb-*`
  directories untouched for an hour, since the exit sweep does nothing for the users
  already sitting on tens of GB — and it remains the only reclaim path for genuinely
  uninterceptable deaths (SIGKILL, `worker.terminate()` on a decode timeout).
- **Downstream cleanup:** the copy loop now removes its own directory before rethrowing.

## Detector

**None — instance-only regression tests**, and the honest reason is that the class is
defined by a *deployment* property (does this process outlive its own timers?) that no
static check in this repo can evaluate. `tests/core/leveldb-reader-temp-cleanup.test.ts`
asserts the property for this module only: spawn a child, complete a real read, kill it
normally and by signal, assert an isolated `TMPDIR` is empty afterwards.

**Mutation-verified.** Against `main`'s reader, 4 of the 5 tests fail; the fifth is the
`COPILOT_MCP_NO_TEMP_SWEEP` opt-out test, which is vacuous against a build that has no
sweep to disable and was rewritten during review to be non-vacuous against the fixed
build. The copy-loop test was checked the same way: delete the `cleanupTempDatabase(tempDir)`
line and it goes red naming the stranded directory.

The cheapest real gate for the class would be a review question rather than code: *does
anything here schedule cleanup on a timer, and is this process guaranteed to be alive when
it fires?* Both existing `setTimeout` siblings in `src/` were audited against it
(`decoder.ts`'s decode timeout, cleared in `settle()` with no resource attached;
`graphql/client.ts`'s retry backoff) and neither belongs to the class.

## Lesson

A resource whose release is scheduled rather than performed is only as reliable as the
process's remaining lifetime — and a per-request server plus a fire-and-exit worker have
approximately none. Tie cleanup to an event the runtime guarantees (`exit`, a `finally`,
the release call itself), and treat any deferred cleanup as unreliable unless something
else also guarantees it.

The testing lesson is sharper and more general than the bug: **a lifecycle property that
only manifests at process death cannot be tested in-process.** The suite here was not thin;
it was measuring the right thing in a harness where the thing could not go wrong. Spawning
a child costs a few seconds and was the only way to see it.
