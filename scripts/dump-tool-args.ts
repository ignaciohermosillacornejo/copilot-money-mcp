#!/usr/bin/env bun
/**
 * Print every dispatchable MCP tool's INPUT ARGUMENT names as a JSON object
 * (`{ "get_transactions": ["account_id", "amount", ...], ... }`), sorted.
 *
 * Sibling of `scripts/dump-tool-names.ts`, and for the same reason: ask the
 * registry instead of text-scraping TypeScript. `scripts/check-skills.py`
 * needs argument names to tell a documented PARAMETER (`exclude_transfers`,
 * `period`) apart from a documented ROW FIELD when it checks a skill's field
 * references against a tool's default `fields` preset — without that split,
 * every skill that documents a parameter in backticks reads as a request for
 * a field the terse default row no longer carries.
 *
 * Kept separate from dump-tool-names.ts rather than folded into it: that
 * script's "JSON array of strings" contract is what its own failure-mode
 * tests are written against, and a tool with no arguments at all must still
 * appear here (as an empty list), which an array of names cannot express.
 *
 * This prints whatever the registry holds, including an empty object.
 * Refusing the degenerate answer is the caller's job — check-skills.py raises
 * on an empty map, and that is the path under test.
 */
import { ALL_TOOL_DEFS } from '../src/tools/registry/index.js';

const args: Record<string, string[]> = {};
for (const def of ALL_TOOL_DEFS) {
  const properties = (def.schema.inputSchema.properties ?? {}) as Record<string, unknown>;
  args[def.name] = Object.keys(properties).sort();
}

console.log(JSON.stringify(args));
