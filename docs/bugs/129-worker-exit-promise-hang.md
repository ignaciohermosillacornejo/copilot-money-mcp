---
id: 129
title: Decode-worker promise hangs forever if the worker exits without sending a result
class: unsettled-promise
status: fixed
detected: code-review  # AI code review comment on an adjacent PR (#128)
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/129
issue: none — found and fixed directly
date: 2026-03-12
---

## Symptom
If the isolated decode worker process exited cleanly (code 0) without ever posting its result message, `decodeAllCollectionsIsolated` awaited a promise that would never settle — the MCP server hung indefinitely on startup/refresh with no error, no timeout message, nothing to act on.

## How it was detected
Adversarial review: an AI review comment on PR #128 (a CI fix) flagged the gap in the worker's `exit` handler. No user report and no test failure — hangs are the failure mode tests are worst at surfacing.

## Root cause
The worker's `exit` handler only rejected the promise for *non-zero* exit codes, assuming a clean exit implied the result message had already arrived. A worker that exits 0 without sending a result (e.g. killed pipeline, early return, message loss) left the promise with no resolve and no reject — an async completion path where neither branch fires.

## The fix
The `exit` handler now always calls the shared `settle` rejection; in the happy path it is a no-op because the result message has already settled the promise. One line of control-flow, removing the "clean exit implies result" assumption.

## Detector
None — instance-only. There is no lint or harness rule asserting that every promise wrapping a child-process/worker has a rejection on all exit paths (the decode timeout added in #135 acts as a coarse backstop: even a hang now dies at the timeout).

## Lesson
For every hand-rolled `new Promise` around an external process, enumerate the exit paths and prove each one settles the promise. "Exit code 0" is not "protocol completed" — completion is receiving the message you were promised.
