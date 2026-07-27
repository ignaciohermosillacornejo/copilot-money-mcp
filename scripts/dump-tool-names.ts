#!/usr/bin/env bun
/**
 * Print every dispatchable MCP tool name as a JSON array, sorted.
 *
 * Exists so `scripts/check-skills.py` can resolve skill tool references against
 * the registry itself instead of text-scraping TypeScript. Scraping is what
 * broke: the linter matched `name: '...'` literals in a hardcoded path, the
 * schemas moved to `src/tools/registry/`, and the parse silently collapsed to a
 * single incidental literal — so every skill reference became a false
 * "unknown MCP tool".
 *
 * Importing `ALL_TOOL_DEFS` gives this the same immunity `sync-manifest.ts`
 * has: a move that breaks the import fails typecheck loudly rather than
 * degrading into a wrong-but-plausible answer. `ALL_TOOL_DEFS` is the same
 * source the server's dispatch is built from, so it covers read, write, and
 * live tools alike — `manifest.json` covers only the 14 cache-mode reads and
 * would miss every write tool the skills lean on.
 */
import { ALL_TOOL_DEFS } from '../src/tools/registry/index.js';

const names = ALL_TOOL_DEFS.map((def) => def.name).sort();

if (names.length === 0) {
  // Unreachable in practice; a registry that imports cleanly but enumerates
  // nothing is exactly the degenerate answer the caller must not trust.
  console.error('dump-tool-names: ALL_TOOL_DEFS is empty');
  process.exit(1);
}

console.log(JSON.stringify(names));
