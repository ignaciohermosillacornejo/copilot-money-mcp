/**
 * Class-level detector for the #606-review Important 3 finding: a tool
 * whose handler defaults to a terse row (the `projectRows(..., x.fields ??
 * ['default'], ...)` idiom — the shared field-selection engine, see
 * src/tools/field-selection.ts) must (a) expose a `fields` schema property
 * so a caller can opt back in, and (b) name what its default excludes
 * somewhere in the tool description. Deleting either one, for either the
 * cache-mode `get_recurring_transactions` tool or any of the five other
 * current diet tools, left the full suite green until this file existed —
 * the two live recurring tools were covered only by their own per-tool
 * schema tests, and the cache tool had none at all.
 *
 * "Fix the class, not the instance" (per CONTRIBUTING.md's bug-response
 * ritual): rather than hand-listing the tools this applies to — the exact
 * #635/#673/#676 mistake tests/exported-constants.test.ts's header
 * documents ("Every version left a list someone had to remember") — this
 * file DISCOVERS them by reading the source tree for the idiom itself. A
 * future tool adopting the same terse-by-default pattern is covered
 * automatically; a tool that merely accepts an opt-in `fields` param
 * without defaulting to a preset (get_transactions, get_transactions_live —
 * neither uses the `?? ['default']` fallback, so omitting `fields` there
 * returns full rows) is correctly NOT swept in, since there is nothing
 * "excluded by default" for it to disclose.
 *
 * Two-step discovery, deliberately scoped to how this repo's two tool
 * shapes differ:
 *   - `src/tools/tools.ts` hosts many cache-mode tools' handler METHODS,
 *     but their schemas (and `name:`) live in `src/tools/registry/*.ts`
 *     (excluding `live.ts`), wired as `ctx.tools.<method>(`. A method found
 *     with the idiom is resolved to a tool name by scanning those files for
 *     the `defineTool({ schema: { name: '...' }, ..., handler: (ctx) =>
 *     ctx.tools.<method>(...) })` block that references it.
 *   - Each `src/tools/live/*.ts` file is one tool: its own
 *     `createLive*ToolSchema()` factory carries the single `name: '...'`
 *     literal for whatever method that same file defines, so a method found
 *     with the idiom there resolves via that file's own (and only) name
 *     literal — no cross-file registry lookup needed. `getInvestmentPrices`
 *     exists as a method name in BOTH tools.ts (diet, cache) and
 *     live/investment-prices.ts (not a diet tool, no `fields` support at
 *     all) — per-file resolution keeps these from colliding; a name-only
 *     lookup across both namespaces would not.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_REGISTRY } from '../../../src/tools/registry/index.js';

const SRC_TOOLS = join(import.meta.dir, '..', '..', '..', 'src', 'tools');

/** `x.fields ?? ['default']` / `x.fields ?? ["default"]`, whitespace-tolerant. */
const DEFAULT_FALLBACK_IDIOM = /\.fields\s*\?\?\s*\[['"]default['"]\]/g;

/** An `async methodName(` declaration — every handler here is async. */
const ASYNC_METHOD_HEADER = /\basync\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

/**
 * Method names (within one file's text) whose body contains the
 * terse-by-default idiom. Attribution is by nearest PRECEDING `async name(`
 * header — sound because every current call site sits inside exactly one
 * such method and none of these files nest one async method inside another.
 */
function methodsUsingDefaultIdiom(text: string): Set<string> {
  const headers: { index: number; name: string }[] = [];
  for (const m of text.matchAll(ASYNC_METHOD_HEADER)) {
    headers.push({ index: m.index, name: m[1]! });
  }
  const found = new Set<string>();
  for (const m of text.matchAll(DEFAULT_FALLBACK_IDIOM)) {
    let nearest: { index: number; name: string } | null = null;
    for (const h of headers) {
      if (h.index <= m.index) nearest = h;
      else break;
    }
    if (nearest) found.add(nearest.name);
  }
  return found;
}

/**
 * Splits one registry file's text into one chunk per `defineTool({...})`
 * call — every such call in this codebase is an `export const X =
 * defineTool(` at zero indentation, so a lookahead split on that boundary
 * is a safe (and much simpler than brace-balancing) way to isolate blocks.
 */
function splitDefineToolBlocks(text: string): string[] {
  return text
    .split(/\n(?=export const [A-Za-z0-9_]+ = defineTool\()/)
    .filter((block) => block.includes('defineTool('));
}

/** cache method name -> tool name, from every `src/tools/registry/*.ts` file except live.ts/types.ts/index.ts. */
function buildCacheMethodToToolName(): Map<string, string> {
  const registryDir = join(SRC_TOOLS, 'registry');
  const map = new Map<string, string>();
  for (const entry of readdirSync(registryDir)) {
    if (!entry.endsWith('.ts') || ['live.ts', 'types.ts', 'index.ts'].includes(entry)) continue;
    const text = readFileSync(join(registryDir, entry), 'utf-8');
    for (const block of splitDefineToolBlocks(text)) {
      const name = block.match(/name:\s*'([^']+)'/)?.[1];
      const method = block.match(/ctx\.tools\.([A-Za-z0-9_]+)\(/)?.[1];
      if (name && method) map.set(method, name);
    }
  }
  return map;
}

/** Discovers every diet tool name -> a short label naming where it was found (test-title only). */
function discoverDietTools(): Map<string, string> {
  const found = new Map<string, string>();

  const toolsTs = readFileSync(join(SRC_TOOLS, 'tools.ts'), 'utf-8');
  const cacheMethods = methodsUsingDefaultIdiom(toolsTs);
  if (cacheMethods.size > 0) {
    const cacheMethodToToolName = buildCacheMethodToToolName();
    for (const method of cacheMethods) {
      const toolName = cacheMethodToToolName.get(method);
      // A method using the idiom with no registry wiring found is a
      // resolution bug in THIS file, not a "no tool uses it" case — fail
      // loudly rather than silently dropping coverage.
      if (!toolName) {
        throw new Error(
          `diet-fields-disclosure discovery: found the terse-by-default idiom in ` +
            `tools.ts method '${method}' but no registry/*.ts defineTool block wires ` +
            `ctx.tools.${method}(...) to a tool name. Fix the resolver in this test file.`
        );
      }
      found.set(toolName, `src/tools/tools.ts:${method}`);
    }
  }

  const liveDir = join(SRC_TOOLS, 'live');
  for (const entry of readdirSync(liveDir)) {
    if (!entry.endsWith('.ts')) continue;
    const text = readFileSync(join(liveDir, entry), 'utf-8');
    const methods = methodsUsingDefaultIdiom(text);
    if (methods.size === 0) continue;
    const names = [...text.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]!);
    if (names.length !== 1) {
      throw new Error(
        `diet-fields-disclosure discovery: src/tools/live/${entry} uses the terse-by-default ` +
          `idiom but does not carry exactly one schema name literal (found ${names.length}: ` +
          `${names.join(', ')}). Per-file name resolution assumes one tool per live file — ` +
          `update the resolver in this test file if that assumption no longer holds.`
      );
    }
    for (const method of methods) {
      found.set(names[0]!, `src/tools/live/${entry}:${method}`);
    }
  }

  return found;
}

const DIET_TOOLS = discoverDietTools();

/** A backtick-quoted identifier, e.g. the `` `rule` `` in a description. */
const BACKTICK_TOKEN = /`[A-Za-z_][A-Za-z0-9_]*`/;
/** Disclosure language this repo's diet-tool descriptions actually use (see file header). */
const DISCLOSURE_LANGUAGE = /\b(exclud\w*|omit\w*|opt-in)\b/i;

describe('terse-by-default tools disclose their fields param (#606 review, class detector)', () => {
  test('guards the gate: discovery finds at least one terse-by-default tool', () => {
    // As of #606: get_investment_prices, get_top_movers_live,
    // get_categories_live (PR A) plus get_recurring_transactions,
    // get_recurring_live, get_upcoming_recurrings_live (this PR) — 6 total.
    // Not asserted as an exact count on purpose: a future diet PR growing
    // this set should not have to touch this file.
    expect(DIET_TOOLS.size).toBeGreaterThan(0);
  });

  for (const [toolName, source] of DIET_TOOLS) {
    test(`${toolName} (${source}) exposes fields and names what it excludes`, () => {
      const def = TOOL_REGISTRY.get(toolName);
      expect(def).toBeDefined();
      const properties = def!.schema.inputSchema.properties as Record<string, unknown> | undefined;
      expect(properties?.fields).toBeDefined();

      const description = def!.schema.description;
      expect(description).toMatch(BACKTICK_TOKEN);
      expect(description).toMatch(DISCLOSURE_LANGUAGE);
    });
  }
});
