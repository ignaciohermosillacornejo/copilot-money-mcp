---
id: 638
title: A context-budget assertion counted bytes it did not own, and the field that could blow the budget was the one it could not see
class: unbounded-trusted-payload
status: fixed
detected: incidental  # surfaced while working #631; `bun run check` failed on a dev machine and passed in CI
fixed_in: not yet
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/638
date: 2026-08-12
---

## Symptom

Two behaviours from one cause.

**Developer-visible.** `bun run check` failed on any machine that had a
`~/.claude/copilot-money/scheduled-smoke.json`, and passed everywhere else:

```
(fail) context-budget ratchet (#597) > response-size budgets (cache-mode read tools, synthetic DB)
       > get_connection_status response stays within budget
Expected: <= 1900
Received: 2664
```

Moving that one file aside made the same suite 68/68. Nothing else in the file is
environment-dependent — the DB is synthetic, as intended.

**Silent, and the more expensive of the two.** `get_connection_status` embedded
`scheduled_smoke.report` verbatim, and the schema accepted any string. With the repo's own
writer that field is a path (~80 chars, `null` on pass), so upstream-only machines stayed
well inside 1900 and nothing ever looked wrong. Any other writer to that path could inflate
a budgeted response without tripping a gate, because the budget test could not see the
field at all — see below.

## How it was detected

Incidentally, and by a gate firing for the *wrong* reason. While working #631 the local
`bun run check` went red on the budget assertion. The proximate cause was a stale
oversized status file left on the machine by earlier debugging, not by
`scripts/scheduled-smoke.ts` — so the honest reading is that a machine-specific artifact
made a latent design gap briefly visible. CI never saw it and never could: the file does
not exist there, so the populated branch had never been exercised in the project's history.

Worth recording against this corpus's `ci-gate: 0` tally: this is not a point for CI. The
gate fired locally, on a condition CI is structurally blind to, and the finding was the
gate's *own* non-hermeticity.

## Root cause

One asymmetry and one missing bound, both in `src/utils/scheduled-smoke-status.ts`.

**1. The env override was writer-only.** `scripts/scheduled-smoke.ts:63` read
`COPILOT_MCP_SMOKE_STATUS_PATH`; the reader did not. `getConnectionStatus`
(`src/tools/tools.ts:1345`) calls `readScheduledSmokeStatus()` with no argument, so it
resolved `defaultScheduledSmokeStatusPath()` → `join(homedir(), …)`. The reader took an
optional `path`, but the tool never passed one and no env seam existed on the read side, so
a test had no way to point it at a fixture. That is why nothing did, and why an assertion
about byte counts ended up counting whatever a developer's home directory contained.

**2. `report` was unbounded inside a budgeted response.** `ScheduledSmokeStatusSchema`
declared `report: z.string()`, while the doc comment said "dated report file". The intent
was a path; the type permitted a novel. The contract lived in prose, and prose is not
enforced.

The second defect was undetectable while the first existed — the only test that measures
this response could not construct a populated status. Hermeticity was the load-bearing fix.

## Why the tests didn't catch it

- **The context-budget ratchet (`tests/context-budget.test.ts`) had no seam.** It ran the
  real tool, which read a real home-directory path. In CI that file never exists, so the
  budget was only ever measured against `scheduled_smoke: null` — the cheapest possible
  branch. The ratchet held not because the response was bounded but because every writer it
  had met was polite.
- **`tests/tools/scheduled-smoke-status.test.ts` covered the reader in isolation** and
  asserted `report` round-trips, which it did. It never asked how large `report` may be,
  because nothing in the schema suggested a limit.
- **`tests/scripts/scheduled-smoke-e2e.test.ts` sets `COPILOT_MCP_SMOKE_STATUS_PATH`** and
  passes — reinforcing the impression that the variable was a shared seam, when it was
  honoured on one side only.

## The fix

- **Root cause:** `defaultScheduledSmokeStatusPath()` now honours
  `COPILOT_MCP_SMOKE_STATUS_PATH`, so reader and writer resolve identically from one
  variable. `scripts/scheduled-smoke.ts` drops its own `??` and calls the shared helper, so
  there is a single knob rather than two that happen to agree.
- **Downstream:** `report` is truncated on read at `SCHEDULED_SMOKE_REPORT_MAX_CHARS`
  (256) with an ellipsis marker, and the doc comment now states plainly that the intended
  payload is a path.

Truncating rather than `z.string().max()` is deliberate. A schema max turns an oversized
file into a parse failure, which drops the whole status and degrades
`get_connection_status` on exactly the machines whose state is most worth reporting — a
worse failure mode than the overage it prevents.

## Detector

**Partial, and mutation-verified in both directions.**

- `tests/context-budget.test.ts` now pins `COPILOT_MCP_SMOKE_STATUS_PATH` to a temp path
  for the whole suite, so every budget in the file measures only bytes the test owns.
  Verified by reintroducing the oversized `$HOME` file: upstream goes red at 4537 chars
  against the 1900 budget, patched stays green.
- A new case exercises the populated branch against a *maximal legitimate* status — worst
  case summary, and a `report` deliberately written past the ceiling — so the budget is
  enforced against the true upper bound instead of `null`. Verified by deleting the
  truncation: the case goes red (382 > 256), and green again when restored. It also asserts
  `scheduled_smoke` is non-null first, so a broken seam cannot make it pass vacuously.

Honest limit: this is class-level for *this* surface only. Nothing here enumerates other
budgeted responses that embed externally-written files and checks them all — today
`scheduled_smoke` is the only one, so the general detector would have exactly one member
and would be a regression test wearing a costume. If a second such surface appears, that is
the moment to build the sweep, and this entry is the argument for doing it then.

## Lesson

A budget test has to own every byte it counts; if any input comes from outside the test,
the number is a coincidence. The cheap general habit is that any assertion about *size*
should be paired with a case that constructs the largest legitimate input, because the
default path is almost always the small one — the null branch here passed for the entire
life of the test while the populated branch was never measured once.

The rhyme with [#631](631-temp-copy-deferred-cleanup.md) is worth naming: there, cleanup
was correct for every process that lived long enough to run it. Here, a budget was correct
for every writer polite enough to stay small. Both are the same mistake at different
layers — a guarantee that depends on the good behaviour of something the code does not
control, and which therefore is not a guarantee.
