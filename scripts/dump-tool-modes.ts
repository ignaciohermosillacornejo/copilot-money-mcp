#!/usr/bin/env bun
/**
 * Print, for every dispatchable MCP tool, the server mode(s) that list it, as
 * a JSON object (`{ "get_transactions": ["cache"], "get_goals": ["cache",
 * "live"], "update_transaction": ["live"], ... }`), sorted by tool name.
 *
 * Sibling of `scripts/dump-tool-names.ts` and `dump-tool-args.ts`, for
 * `scripts/check-skills.py`'s mode check (#847): a skill that declares it runs
 * in live mode must not tell its agent to call a tool, or pass an argument,
 * that only exists in cache mode — and the reverse. Linting against the full
 * tool list (what check 2 does) cannot see that, because every tool exists in
 * SOME mode.
 *
 * The two modes are the two surfaces a user actually gets:
 *   - "cache": no flags. Read tools only, minus the live tools.
 *   - "live":  `--write` (which implies `--live-reads`). Write tools, live
 *              tools, and every cache read that has no `_live` replacement.
 * `--live-reads` without `--write` is the live surface minus the write tools;
 * a skill that writes needs `--write` anyway, so it is not a third mode here.
 *
 * The filter is the one `CopilotMoneyServer.handleListTools()` applies, over
 * the same `ALL_TOOL_DEFS`. tests/scripts/check-skills.test.ts pins the two
 * against each other by building real servers in both modes, so a change to
 * the server's gating that this file does not follow fails a test instead of
 * silently linting skills against the wrong surface.
 */
import { ALL_TOOL_DEFS } from '../src/tools/registry/index.js';

type Mode = 'cache' | 'live';

/** Mirrors handleListTools(): write = --write, live = --live-reads. */
function listed(def: (typeof ALL_TOOL_DEFS)[number], write: boolean, liveReads: boolean): boolean {
  if (!def.readOnly && !write) return false;
  if (def.requiresLiveReads && !liveReads) return false;
  if (def.swappedOutInLiveMode && liveReads) return false;
  return true;
}

const modes: Record<string, Mode[]> = {};
for (const def of [...ALL_TOOL_DEFS].sort((a, b) => a.name.localeCompare(b.name))) {
  const available: Mode[] = [];
  if (listed(def, false, false)) available.push('cache');
  if (listed(def, true, true)) available.push('live');
  modes[def.name] = available;
}

console.log(JSON.stringify(modes));
