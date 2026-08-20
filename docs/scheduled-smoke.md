# Scheduled drift check (weekly smoke)

Every other conformance gate in this repo is activity-triggered (push,
pre-push, PR review). If Copilot changes their API while no development is
happening, the first detector would be a confused user. The scheduled smoke
closes that gap: a launchd user agent runs the Tier-1 conformance suite
(`bun run smoke` — non-mutating; never the B4 round-trip smokes) once a week
on the owner's machine, where the browser-session auth lives.

## Install / uninstall

```bash
scripts/install-scheduled-smoke.sh    # weekly, Monday 10:00 local
scripts/uninstall-scheduled-smoke.sh
```

launchd coalesces missed runs: a laptop asleep at the scheduled time runs the
check on next wake. That wake is often a *dark* wake, where the network is
throttled and the system returns to sleep within seconds — freezing the run
mid-flight while its 10-minute wall-clock timeout keeps ticking. A run killed
that way is reported as `incomplete` and retried once; by the time the timeout
fires the machine is usually awake, and the ~20s retry simply passes. Manual
trigger:

```bash
launchctl kickstart -k gui/$(id -u)/com.copilot-money-mcp.scheduled-smoke
```

## Outcomes (three-state by design)

| Result | Meaning | Behavior |
| --- | --- | --- |
| `pass` | All gated surfaces match the server | Silent |
| `fail` | The smoke printed a drift verdict — Copilot's API changed | macOS notification + dated report under `~/.claude/copilot-money/smoke-reports/` |
| `auth-missing` | No Copilot browser session — **drift NOT checked** | Recorded distinctly; absence of auth must never look like absence of drift |
| `incomplete` | The run never reached a verdict: killed, timed out, or failed unmodelled — **drift NOT checked** | Retried once first; if the retry also fails to complete, notification + report, worded as a non-completion |

The states are ordered by *evidence*, not by severity. `fail` is reachable
only when the output carries one of the drift-verdict markers the smoke prints
before exiting (`DRIFT_VERDICT_MARKERS` in `scripts/scheduled-smoke.ts`);
everything unrecognized falls to `incomplete`. That direction matters: `fail`
is the state that sends a reader hunting for an API change, so it must never
be the fallthrough bucket. Before this rule existed, every one of the job's
first eight failure notifications was a false alarm — seven logged-out
machines and one that slept through its run. See
[`docs/bugs/661-non-completion-classified-as-drift.md`](bugs/661-non-completion-classified-as-drift.md).

Every run writes `~/.claude/copilot-money/scheduled-smoke.json`
(`last_run`, `result`, `summary`, `report`). The `get_connection_status` MCP
tool surfaces this as `scheduled_smoke`, so a dev session sees staleness or
failures without hunting for logs. `null` there means the job was never
installed or has never run.

Runner: `scripts/scheduled-smoke.ts` (env overrides for testing:
`COPILOT_MCP_REPO`, `COPILOT_MCP_SMOKE_STATUS_PATH`).
