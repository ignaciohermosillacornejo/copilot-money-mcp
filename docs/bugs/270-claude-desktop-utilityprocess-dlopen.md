---
id: 270
title: Claude Desktop launched the server in an Electron UtilityProcess that rejects the native module
class: packaging-environment-mismatch
status: fixed
detected: user-report  # issue #249 "Unable to attach to server" persisted after the missing-deps fix; root-caused by reverse-engineering Claude Desktop's app.asar
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/270
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/249
date: 2026-04-15
---

## Symptom
Even with production deps correctly bundled (post-#251), `.mcpb` installs on Claude Desktop 1.2581.x macOS still failed with "Server disconnected" — and zero diagnostic output, because the process died before any startup logging could flush.

## How it was detected
The user report (#249) stayed broken after the first fix, forcing deeper investigation. Root-causing required reverse-engineering Claude Desktop's `app.asar` to discover its process-routing rule, since the failure happened inside `dlopen` before our code ran. Upstream bug filed as modelcontextprotocol/mcpb#229 (affects `better-sqlite3`, `sharp`, `node-pty`, etc.).

## Root cause
Claude Desktop runs Node MCPB extensions whose `mcp_config.command === "node"` inside an Electron `UtilityProcess`, which on macOS enforces hardened-runtime library validation. `classic-level`'s prebuilt `.node` binary is ad-hoc signed (no matching Team ID), so `dlopen` rejects it during module load — before `main()` — making the failure both total and unloggable. The assumption "our server runs under a normal Node process" didn't hold in the target host.

## The fix
Route around the router: `mcp_config.command` now points at `scripts/launcher.sh`, a POSIX shim, instead of the literal `"node"` — any non-`"node"` command falls through to a plain `child_process` spawn where native modules load normally. The shim also handles GUI-launched macOS processes not inheriting shell `PATH` (falls back through Homebrew/system node locations). `platform_overrides.win32` keeps bare `node` (no library validation there).

## Detector
`tests/unit/mcp-spawn-config.test.ts` — a manifest guard that fails if anyone reverts `command` to `"node"` or drops the win32 override. That pins this instance; there is no general detector for "works in dev, dies in the host's runtime sandbox" — the extract-and-boot bundle test (#251) runs under plain Node and cannot reproduce UtilityProcess semantics.

## Lesson
The host application is part of the runtime environment: an artifact can be internally correct and still be killed by the launcher's sandbox policy. When a startup failure produces no logs at all, suspect the failure happens before your process exists, and go read the host's launch path.
