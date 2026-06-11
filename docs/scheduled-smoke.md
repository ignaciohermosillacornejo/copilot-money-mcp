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
check on next wake. Manual trigger:

```bash
launchctl kickstart -k gui/$(id -u)/com.copilot-money-mcp.scheduled-smoke
```

## Outcomes (three-state by design)

| Result | Meaning | Behavior |
| --- | --- | --- |
| `pass` | All gated surfaces match the server | Silent |
| `fail` | Conformance failure — likely API drift | macOS notification + dated report under `~/.claude/copilot-money/smoke-reports/` |
| `auth-missing` | No Copilot browser session — **drift NOT checked** | Recorded distinctly; absence of auth must never look like absence of drift |

Every run writes `~/.claude/copilot-money/scheduled-smoke.json`
(`last_run`, `result`, `summary`, `report`). The `get_connection_status` MCP
tool surfaces this as `scheduled_smoke`, so a dev session sees staleness or
failures without hunting for logs. `null` there means the job was never
installed or has never run.

Runner: `scripts/scheduled-smoke.ts` (env overrides for testing:
`COPILOT_MCP_REPO`, `COPILOT_MCP_SMOKE_STATUS_PATH`).
