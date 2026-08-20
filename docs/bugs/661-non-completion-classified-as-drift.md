---
id: 661
title: The weekly drift check reported "conformance failure" for runs that were killed, and for a logged-out machine
class: alarm-by-fallthrough
status: fixed
detected: dogfooding # the macOS notification fired; reading the report it pointed at showed every gate inside it had passed
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/661
issue: none — found and fixed directly
date: 2026-08-19
---

## Symptom

A macOS notification on Monday 2026-08-17:

> **Copilot MCP drift check FAILED**
> Scheduled smoke found a conformance failure. Report: …-smoke-failure.txt

The report it pointed at contained no conformance failure. Every gate inside it had
passed — 20/20 conformance surfaces, 19/19 read operations, `[smoke] PASS — all 5 enums
and 15 input types match the server`. The run then stopped mid-way through
`smoke:refresh` with:

```
error: script "smoke" was terminated by signal SIGTERM (Polite quit request)
```

The recorded one-line summary was `[smoke] months_window=1 {` — an object dump cut off
mid-sentence, presented where a finding belongs.

Re-running `bun run smoke` on the same commit: exit 0, everything PASS, **17.9 seconds**.

The seven notifications before it — every previous failure this job had ever sent, weekly
from 2026-06-15 to 2026-07-27 — were the same false alarm with a different cause: a
logged-out machine, which the job is explicitly designed to report as `auth-missing`.

**Eight of eight failure notifications this detector has produced were false alarms.
It has never once reported real drift.**

## How it was detected

Dogfooding, and only barely. The notification was indistinguishable from a true positive;
it was caught because someone opened the report it linked and noticed the contents said
PASS. Nothing in the system flagged the contradiction between "found a conformance
failure" and a report whose every line said otherwise.

The seven earlier alarms were *not* detected at the time. They were found retroactively
while investigating this one, by running the runner's own `AUTH_MISSING_PATTERNS` over the
archived reports and getting zero matches on all seven.

This is the failure mode that makes the class expensive: a detector that cries wolf is
usually discovered by someone eventually ignoring it, not by a gate.

## Root cause

Two defects, one cause.

`scripts/scheduled-smoke.ts` classified an outcome from an exit code and a pattern list:

```ts
const exitCode = run.status ?? 1;                       // scheduled-smoke.ts:75
...
export function classifySmokeOutcome(exitCode: number, output: string) {
  if (exitCode === 0) return 'pass';
  return AUTH_MISSING_PATTERNS.some((p) => p.test(output)) ? 'auth-missing' : 'fail';
}
```

`fail` was the fallthrough. Anything the classifier did not recognize became "Copilot's
API drifted", which is the one conclusion the job exists to draw and the most expensive
one to act on.

1. **The killed run.** `spawnSync(..., { timeout: 10 * 60 * 1000 })` returns
   `status: null, signal: 'SIGTERM', errorCode: 'ETIMEDOUT'` when its timeout fires
   (probe-verified under bun). Line 75 coalesced that to `status ?? 1` and discarded
   `signal` and `error` entirely, so a killed run was indistinguishable from a run that
   exited 1 on purpose.

   The kill itself is environmental and benign. The laptop was asleep at the Mon 10:00
   slot (`pmset` shows sleep/dark-wake cycling from 09:57). launchd coalesced the missed
   run onto a dark wake, where the network is throttled — the report carries a
   `[graphql] Categories failed: code=NETWORK` retry that a normal awake run does not.
   The system then kept returning to sleep, freezing parent and child while the
   *wall-clock* timeout kept ticking. A 17.9-second job consumed the full 10-minute
   budget across sleep cycles. The lid opened at 10:41:18; twelve seconds later the
   resumed `spawnSync` noticed the deadline had passed, SIGTERM'd the child, and wrote
   the status file at 10:41:30.883Z.

2. **The logged-out runs.** The smoke's own auth-failure wording — `[smoke] FAIL — could
   not acquire an authenticated Copilot session, no probes were sent` — was absent from
   `AUTH_MISSING_PATTERNS`, whose five entries all matched deeper library errors instead.
   So the auth path fell through to `fail` too, weekly, for seven weeks.

Both are the same mistake: the alarming state was the default, so it collected every case
nobody had modelled.

## Why the tests didn't catch it

`tests/scripts/scheduled-smoke.test.ts` had five classification tests. Every one of them
asserted a mapping the author had already thought of — exit 0 → pass, and four auth
signatures → auth-missing. The `fail` case was asserted with a hand-written
`'[smoke] FAIL: bogus_value REJECTED by server'` string, which is not a string the smoke
ever prints.

Nothing tested the *shape* of the classifier: that its default branch is the alarming
one. A test suite built from "does each known input map correctly?" cannot see that,
because the bug lives entirely in the inputs nobody listed. The auth-pattern tests are
the sharpest illustration — all four passed while the one auth message the smoke
actually emits was unmatched, because the fixtures were written from the pattern list
rather than from the smoke's real output.

The runner also had no test that executed `runScheduledSmoke()` end to end; it spawned a
real process, so nothing exercised the report/notify/exit-code flow at all.

## The fix

PR #661.

**Root-cause fix:** `fail` now requires positive evidence. `classifySmokeOutcome` takes
the whole run — `status`, `signal`, `errorCode`, `output` — and returns `fail` only when
the output carries one of the two drift verdicts the smoke prints before exiting
(`DRIFT_VERDICT_MARKERS`). A fourth state, `incomplete`, is the new fallthrough: killed,
timed out, could not spawn, or failed in a way the runner does not model. It notifies
with its own wording and never borrows the drift copy. The reasoning is the one the file
already applied to auth, extended: absence of completion is not presence of drift.

**Downstream:**
- `AUTH_MISSING_PATTERNS` gained the smoke's own auth-failure wording, closing the
  seven-week case. Note it is now belt-and-braces: without it that output classifies as
  `incomplete`, not `fail`, because the class-level fix already removed the drift claim.
- `summarizeSmokeOutput` describes how an incomplete run ended (`killed by SIGTERM after
  the 10m timeout`) instead of quoting the last log line, which for a truncated run is
  debris. Running the fixed runner for real then showed the same defect on the *pass*
  path — a clean run summarized itself as `[smoke] done {`, because the composite smoke
  ends with the refresh scripts and the heuristic took the last prefixed line rather
  than the last verdict. Fixed in the same PR; found only by reading real output, which
  is this corpus's most reliable mechanism and was the point of the exercise.
- `runScheduledSmoke` retries once on `incomplete`. The observed kill fires just after
  the machine wakes, so the retry runs on an awake laptop and passes in ~20s — turning
  the common false alarm into a silent pass rather than into better-worded noise. It is
  injectable (`spawn`/`write`/`notify`), so the full flow is now tested in-process.
- `incomplete` threaded through `SCHEDULED_SMOKE_RESULTS`, the status reader's Zod enum,
  the `get_connection_status` description, and `docs/scheduled-smoke.md`.

The 10-minute timeout is unchanged — a healthy run is 17.9s, so headroom was never the
problem. Wall clock that counts system sleep is not something a timeout can fix; the
retry is the mechanism that handles it.

## Detector

`tests/scripts/scheduled-smoke.test.ts` asserts the class-level invariant:

> `classifySmokeOutcome(run) === 'fail'` implies the output contains a drift-verdict
> marker

evaluated over a corpus of every non-drift failure mode this job has actually produced —
the timeout kill, a bare signal kill, a failed spawn, both auth wordings, an unmodelled
crash, and a network failure — plus a non-vacuity assertion that exactly the three drift
fixtures do classify as `fail`. Adding a new unmodelled failure mode to that corpus
cannot silently become an alarm.

**Mutation-verified**, five mutations, all detected:

| Mutation | Tests red |
|---|---|
| revert to fallthrough-`fail` (drop the drift-verdict requirement) | 11 |
| drop the widened auth pattern (restore the 7-week bug) | 1 |
| drop the retry on non-completion | 2 |
| let an incomplete run reuse the `fail` alarm copy | 1 |
| summarize incomplete runs from the last log line again | 2 |

Plus, in `tests/tools/scheduled-smoke-status.test.ts`, `incomplete` must survive the
reader as its own state — mutation-verified by removing it from the enum (1 red).

The detector is scoped to this classifier. The class is broader: any place that maps a
recognized set to specific outcomes and dumps the remainder into a serious one. No sweep
exists for that, and it is not obvious one is affordable.

## Lesson

When a detector has a most-alarming state, that state must be reached by evidence and
never by `else`. The cheap version of this habit is a single test per classifier —
"the alarming outcome implies the evidence for it" — which costs three lines and would
have caught both defects here on the day they were written.

The corollary is about trust: this job's alarm had a 0/8 precision record before anyone
looked closely. A detector nobody believes is worse than no detector, because it also
consumes the attention a real alarm would need. Worth counting alarm precision for
anything that fires unattended.
