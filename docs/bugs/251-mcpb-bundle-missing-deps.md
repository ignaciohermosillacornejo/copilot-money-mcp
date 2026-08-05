---
id: 251
title: Shipped .mcpb bundle omitted a runtime dependency; two releases dead on install
class: packaging-environment-mismatch
status: fixed
detected: user-report  # Claude Desktop installs failed with "Server disconnected" (issue #249 filed the same morning); confirmed by extracting and booting the shipped bundle outside the repo
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/251
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/249
date: 2026-04-14
---

## Symptom
Installing `copilot-money-mcp.mcpb` in Claude Desktop produced a server that died before responding to `initialize` — users saw "Server disconnected" with no diagnostics. Both v1.6.0 and v1.6.1 shipped this way. (v1.6.1's release was additionally missing the `.mcpb` asset entirely, thanks to a separate tag-trigger gap.)

## How it was detected
End users hit it first (issue #249, "Unable to attach to server", screenshot only). Reproduction required simulating the install environment: extracting the bundle to a directory outside the repo so Node could not accidentally resolve modules from the dev `node_modules/`.

## Root cause
Two build-config decisions, each individually reasonable, disagreed: `bun build` marked the native module `classic-level` as `--external` (since a January commit), while `.mcpbignore` excluded `node_modules/` from the bundle. The extracted runtime therefore had an import it could not resolve and exited with `ERR_MODULE_NOT_FOUND` at startup. Every test ran inside the repo, where dev `node_modules/` masked the gap — the tested environment was never the shipped environment.

## The fix
`pack:mcpb` became a staging build: production deps installed via `npm --omit=dev --ignore-scripts` into `.mcpb-staging/`, packed from there. The auto-release workflow now builds and attaches the `.mcpb` inline (the `push: tags:` trigger never fires for `GITHUB_TOKEN`-created tags — a second silent-automation gap fixed in the same PR).

## Detector
Class-level, and it still exists: `tests/integration/mcpb-bundle.test.ts` runs `pack:mcpb`, extracts the bundle to a temp dir outside the repo, spawns `node dist/cli.js`, and asserts the server answers `initialize` and advertises the expected tool count — on every PR. Any future missing-dependency or boot failure of the shipped artifact fails CI.

## Lesson
Test the artifact you ship, in an environment that cannot see your dev tree. A one-time manual install check is not a detector; the extract-and-boot integration test is.
