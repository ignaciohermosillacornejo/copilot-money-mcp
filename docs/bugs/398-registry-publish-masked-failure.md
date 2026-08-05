---
id: 398
title: MCP registry publish failed with HTTP 422 but the release workflow ran green
class: silent-failure-masking
status: fixed
detected: audit-sweep  # the workflow was green but the registry listing was missing
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/398
issue: none — found and fixed directly
date: 2026-05-13
---

## Symptom
The v2.2.0 auto-release pipeline reported success: npm publish and the GitHub release worked, CI was green. But the version never appeared in the MCP registry — the `mcp-publisher publish` step had been rejected with HTTP 422 because `server.json#description` (~420 chars) exceeded the registry's 100-character maximum.

## How it was detected
Only by reading the job log after the fact. `continue-on-error: true` on the registry steps converted the 422 into a green workflow, so no failure signal existed anywhere except inside the step's own output.

## Root cause
Two layers. Proximate: an unvalidated external constraint — the registry enforces a description length limit nothing in the repo checked. Enabling: the deliberate `continue-on-error: true` on the registry steps (meant to keep registry flakiness from blocking npm releases) also masked a deterministic, permanent rejection. A guard added for transient failures absorbed a structural one.

## The fix
Description trimmed to 86 chars; a new `scripts/check-server-json.ts` validator asserts the length constraint, wired into `bun run check` (pre-push) and CI, extensible for future registry constraints as they are discovered. A `skip_npm` workflow input allowed re-publishing v2.2.0 to the registry without a version bump.

## Detector
Instance-level and strong for THIS constraint: `check:server-json` fails pre-push and in CI before an invalid description can reach the registry. Class-level: none — the registry steps still carry `continue-on-error: true` today (`.github/workflows/npm-publish.yml:131-144`), so any registry failure other than description length still yields a green workflow.

## Lesson
`continue-on-error` does not distinguish "transient, retry later" from "permanently rejected, will never succeed" — it should be paired with an out-of-band check that the intended end state (the listing exists) was actually reached. Validate external submission constraints locally, before the only enforcement point is a swallowed remote error.
