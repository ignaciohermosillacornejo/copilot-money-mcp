/**
 * The JSON-Schema argument walk, in one place.
 *
 * Two scripts need a tool's argument names — `check-tool-counts.ts`, to tell a
 * mistyped tool name from a backticked parameter in a doc table, and
 * `dump-tool-args.ts`, to feed `check-skills.py` the same distinction for skill
 * prose. Both had their own copy, both read `inputSchema.properties` one level
 * deep, and fixing one did not fix the other: the nested-argument defect was
 * found in the first, fixed there, and survived seven commits of review in the
 * second. The duplication is what made it a sibling, so it is the duplication
 * that gets removed.
 *
 * Side-effect free on purpose — both consumers run as scripts and cannot
 * import each other, but they can both import this. Same shape as
 * `scripts/manifest-utils.ts`.
 *
 * ## What it walks, and what it does not
 *
 * `properties` and `items`, recursively. One level is not enough:
 * `update_recurring` nests a `rule` object whose `name_contains` is a real
 * parameter — the conformance ledger names it as
 * `update_recurring.rule.name_contains` — and `edits`, `splits` and `rows`
 * carry nested blocks too.
 *
 * It does NOT walk every route a JSON Schema has to a property name:
 * `oneOf`/`anyOf`/`allOf`, `patternProperties`, `$defs`, a schema-valued
 * `additionalProperties`, and the tuple (array) form of `items` would all
 * under-collect. None occurs in this registry today — every
 * `additionalProperties` here is the boolean `false`. Stated rather than
 * implied, because "derived from the registry" reads as total coverage and
 * this PR opened by fixing a docblock that was one character wider than its
 * regex.
 *
 * ## No visited set
 *
 * These schemas form a DAG, not a tree — by-reference sharing is exactly what
 * makes them one, and is why a visited set was twice on the table. What rules
 * out a cycle is not the shape but how they are built: `const` object literals
 * initialised in module order, so a fragment can only embed one already
 * defined. The sharing is real — every `*_FIELDS_PARAM_SCHEMA` in
 * `src/tools/field-selection.ts` with more than one use site, three today, is
 * embedded by identity rather than copied.
 *
 * Omitting a visited set is correct under ANY schema shape, not because of
 * that sharing: a re-walk collects the same names into the same set, so a
 * revisit can never lose a name. What the fragments' shape buys is the cost
 * bound — each is a LEAF, `{ type: 'array', items: { type: 'string' },
 * description }`, so a repeat re-walks the fragment and its single `items`
 * child and neither contributes a name.
 *
 * A visited set would therefore be a cost optimisation, never a correctness
 * fix — and one whose deletion stays byte-identical, since dedupe not changing
 * the output is its definition. If you add one anyway: it is sound only while
 * every call sharing it also shares one destination set, because a skipped
 * subtree's names survive only in the set the earlier visit wrote to.
 *
 * ## The residual, for the exclusion-set consumer
 *
 * `check-skills.py` uses these names as an EXCLUSION set, unioned per tool
 * named on a line: a backticked token that is an argument is skipped,
 * everything else is tested as a row field. So widening the set NARROWS that
 * check, and the global name count understates it — per tool,
 * `update_transactions` goes from two names to thirteen through
 * `edits[].items.properties`, gaining `note`, `type`, `reviewed`,
 * `category_id` and `tag_ids`, none of which are in the default transaction
 * row.
 *
 * The trade is the one the top-level exclusion already made — a parameter of a
 * tool named on the line is a legitimate backtick — but the two directions are
 * not symmetric, and this is the repo whose recurring bug class is the second
 * one: the false positive closed here is LOUD and fixable by the author, while
 * the false negative opened is SILENT. A line naming a terse read tool
 * alongside a bulk write tool and backticking `note` was reported before and
 * is not now. No skill line has that shape today.
 */

/** JSON-Schema node, as much of it as this walk needs to see. */
export interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

/** Collect property names from `node` into `into`, descending `properties` and `items`. */
export function collectSchemaArgNames(node: SchemaNode | undefined, into: Set<string>): void {
  if (node === undefined) return;
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    into.add(name);
    collectSchemaArgNames(child, into);
  }
  collectSchemaArgNames(node.items, into);
}

/** Every property name reachable from `node`, as a fresh set. */
export function schemaArgNames(node: SchemaNode | undefined): Set<string> {
  const names = new Set<string>();
  collectSchemaArgNames(node, names);
  return names;
}
