---
id: 774
title: A retryable EINTR failed every cache read, and told a synced user their database was not installed
class: retryable-errno-treated-as-fatal
status: fixed
detected: incidental  # smoke:cache crashed under concurrent test load while gathering evidence for #666; the second site was measured during #756
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/793
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/774
date: 2026-10-10
---

## Symptom

Two symptoms, one errno.

1. **A hard crash of every cache-mode read.** `bun run smoke:cache`, with several test
   suites running concurrently on the same machine:

   ```
   [cache-smoke] crashed: EINTR: interrupted system call, copyfile
     '…/main/001800.ldb' -> '/var/folders/…/T/copilot-leveldb-…/001800.ldb'
   ```

   Four reruns passed. The snapshot copy is on the default read path of every cache-mode
   tool, so the same interrupt in the server fails the user's request outright.

2. **A false diagnosis, silently.** Roughly 1 server startup in 1,000, the reader reported
   *"Database not found. Please ensure Copilot Money is installed and has synced data."* to
   a user whose database was installed and synced. Nothing about it looked like an error
   on our side; it read as an instruction to go fix their setup.

## How it was detected

Incidentally, twice. The crash was hit while running `smoke:cache` to gather multi-cache
evidence for [#666](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/666).
The second site was found while diagnosing the flaky test in
[#756](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/756): logging
the error swallowed by `findCopilotDatabase()`'s bare `catch {}` named it as `EINTR`.
Measured over 8,470 `readdirSync` calls against the live Copilot container: 93% under 1ms,
nothing between 100ms and 1s, and 8 calls (~0.1%) that blocked for seconds and then threw
`EINTR`.

## Root cause

`EINTR` means the syscall was interrupted by a signal before it did its work and should be
reissued. Node's and Bun's synchronous `fs` functions throw it rather than retrying, and
every call site handled it with the branch meant for errors that mean "stop":

- `src/core/leveldb-reader.ts` copy loop — the catch skipped `ENOENT` (compaction TOCTOU,
  deliberate and correct) and rethrew everything else, so one interrupted `copyFileSync`
  aborted the whole snapshot. The same loop's `readdirSync`, the fingerprint's
  `statSync`/`readdirSync`, and `mkdtempSync` had no handling at all.
- `src/core/database.ts` `findCopilotDatabase()` — both `readdirSync` calls sat in bare
  `catch {}` blocks that fell through to `return undefined`. That collapsed "could not
  look" and "looked, and it is absent" into one outcome, and only the second justifies
  the install/sync advice.

The second site is also an instance of a pattern this repo keeps meeting — a transient
local condition reported to the user as a misconfiguration (#722, #751, #760/#769 told
logged-in users to log in). The retry fixes the frequency; the distinct error fixes the
diagnosis.

## Why the tests didn't catch it

The condition is a real signal arriving mid-syscall under load. Every test that exercised
these paths ran against a quiet fixture directory, where the interrupt never happens, and
no test injected an errno other than `ENOENT` (skipped) and `EACCES` (the stranded-temp-dir
test from #631). The discovery path was not unit-tested against a synthetic home at all —
the only tests that reached it walked the user's real container, which is #756.

## The fix

- **Root cause:** `src/core/fs-retry.ts` — `retryInterrupted(op)` reissues `op` immediately
  while it throws `EINTR`/`EAGAIN`, up to `MAX_INTERRUPT_ATTEMPTS` (5) attempts, then
  rethrows the original error. Any other errno is thrown from the first attempt, so the
  copy loop's `ENOENT` handling is unchanged.
- Every `copyFileSync`/`readdirSync`/`mkdtempSync`/`statSync` in `src/` goes through it:
  the snapshot path, discovery, `isAvailable`, the browser-token profile scans and the
  meta-store size check. The four scripts that read the real container
  (`snapshot.ts`, `profile-database.ts`, `decode-coverage.ts`,
  `verify-optimistic-consistency.ts`) were converted by hand. The issue also listed five
  `scripts/profile-*`/`*-keys.ts` files; they no longer exist.
- **The diagnosis half:** discovery now returns `{ path, lookupError? }`. A read error that
  is not `ENOENT`/`ENOTDIR` is kept rather than swallowed. `CopilotDatabase.availability()`
  carries it (or a read error on an explicit `dbPath`), and both `requireDbPath()` and the
  server's dispatch gate in `src/server.ts` report it through `missingDatabaseError()`: the
  errno and syscall (never the path), called transient only when the errno is retryable.
  The dispatch gate matters most. It answers every cache-mode call before any read method
  runs, so fixing only `requireDbPath()` would have left the user seeing the install advice.
  Review caught that in the first round.
- **`existsSync` removed from discovery and `availability()`.** It returns `false` on any
  error, so an interrupted existence check reads as absence before the retried read runs.
  The retried `readdirSync` is now the existence check, with `ENOENT` read as absence.

## Detector

`tests/no-unretried-fs-syscalls.test.ts` (mutation-verified): a TypeScript-AST sweep of
every file under `src/` and the four container-reading scripts. It flags any reference to
`copyFileSync`, `readdirSync`, `mkdtempSync` or `statSync` that is not exactly
`retryInterrupted(() => <ns>.op(...))`. It also flags a file whose wrapper is not imported
from `fs-retry`, which catches a local function of the same name. Unwrapping the original
instance (the copy) turns it red and names `src/core/leveldb-reader.ts:<line>`; shadowing
the wrapper in a script turns it red too. Its stated limits are: `existsSync`, which cannot
be retried, though discovery no longer calls it; the async API; sync ops outside the set
(`readFileSync` is plausibly in the class but has not been measured); the rest of
`scripts/`; and bindings it cannot see by name.

Behind it, the behaviour is pinned through fault injection rather than by shape:
`tests/core/leveldb-reader-eintr.test.ts` swaps each of the four `fs` functions for one that
throws `EINTR` N times and asserts the read completes, and that a permanent interrupt fails
after exactly the bound with no temp copy left. `tests/core/database-discovery.test.ts`
does the same for discovery against a synthetic home. It pins that a permanent interrupt is
reported as a lookup error, not absence, that `existsSync` is not consulted, and that the
failure reaches the client through `handleCallTool`, not only through a direct read. Mutation-verified: removing the retry, removing
the bound, unwrapping the copy site, dropping the recorded lookup error, and ignoring it in
`requireDbPath` each turn named tests red.

No `scripts/mutation-guards.ts` row: that registry's bar is a guard whose violation writes
wrong data to a financial account. This one fails a read.

## Lesson

A `catch` that rethrows "everything except X", or swallows everything, is making a claim
about every errno it did not name. The errnos whose contract is "try again" need saying
out loud, once, in a helper — and a gate, because the next `readdirSync` will be written
without thinking about signals.
