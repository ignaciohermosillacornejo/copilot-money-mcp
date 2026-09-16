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
 * on an empty map AND on a map whose every list is empty, which is the shape a
 * broken collector here would actually produce.
 */
import { ALL_TOOL_DEFS } from '../src/tools/registry/index.js';

/** JSON-Schema node, as much of it as the argument walk needs to see. */
interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

/**
 * Collect argument names by descending `properties` and `items`.
 *
 * One level is not enough, and the docblock above promised more than a
 * one-level read delivered: `update_recurring` nests a `rule` object whose
 * `name_contains` is a real parameter, and `edits`, `splits` and `rows` carry
 * nested blocks too. This map is an EXCLUSION set in check-skills.py — a token
 * it does not contain is tested as a row field — so a missing nested name is a
 * false positive telling the author to add a `fields:` argument for something
 * that is a parameter. Mirrors `collectPropertyNames` in
 * scripts/check-tool-counts.ts, which had the same gap.
 *
 * Known limit, the same one: this walks those TWO keywords, not every route a
 * JSON Schema has to a property name. `oneOf`/`anyOf`/`allOf`,
 * `patternProperties`, `$defs`, a schema-valued `additionalProperties` and the
 * tuple form of `items` would under-collect. None occurs in this registry —
 * every `additionalProperties` here is the boolean `false`.
 */
function collectArgNames(node: SchemaNode | undefined, into: Set<string>): void {
  if (node === undefined) return;
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    into.add(name);
    collectArgNames(child, into);
  }
  collectArgNames(node.items, into);
}

const args: Record<string, string[]> = {};
for (const def of ALL_TOOL_DEFS) {
  const names = new Set<string>();
  collectArgNames(def.schema.inputSchema, names);
  args[def.name] = [...names].sort();
}

console.log(JSON.stringify(args));
