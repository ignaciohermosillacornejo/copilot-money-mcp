/**
 * Unit tests for the shared JSON-Schema argument walk (`scripts/schema-args.ts`).
 *
 * Why this file exists at all: the walk previously had two copies, one in
 * `check-tool-counts.ts` and one in `dump-tool-args.ts`, and neither could be
 * tested directly because running either script IS its check. The
 * one-level-read defect was found in the first, fixed there, and survived in
 * the second for seven commits. Extracting the walk into a side-effect-free
 * module removed the duplication that made it a sibling AND made it reachable
 * from a test — those are the same change, which is the argument for having
 * made it.
 *
 * So these assert the walk's contract on synthetic schemas, plus one case
 * against the real registry: `update_recurring.rule.name_contains`, the
 * nested argument that motivated the recursion.
 */
import { describe, expect, test } from 'bun:test';

import { collectSchemaArgNames, schemaArgNames } from '../../scripts/schema-args.js';
import { ALL_TOOL_DEFS } from '../../src/tools/registry/index.js';

describe('schemaArgNames', () => {
  test('collects top-level property names', () => {
    expect([...schemaArgNames({ properties: { a: {}, b: {} } })].sort()).toEqual(['a', 'b']);
  });

  test('descends nested objects', () => {
    const names = schemaArgNames({
      properties: { rule: { properties: { name_contains: {}, min_amount: {} } } },
    });
    expect([...names].sort()).toEqual(['min_amount', 'name_contains', 'rule']);
  });

  test('descends array item schemas', () => {
    const names = schemaArgNames({
      properties: { edits: { items: { properties: { note: {} } } } },
    });
    expect([...names].sort()).toEqual(['edits', 'note']);
  });

  test('tolerates an undefined node and a node with no properties', () => {
    expect([...schemaArgNames(undefined)]).toEqual([]);
    expect([...schemaArgNames({})]).toEqual([]);
  });

  // A revisited node is re-walked rather than skipped, which is why omitting a
  // visited set cannot lose a name. Pinning it because the module's docblock
  // argues exactly this, and because two rounds of review went into the
  // question of whether a visited set was needed.
  test('a shared fragment contributes its names to every parent that embeds it', () => {
    const shared = { properties: { shared_name: {} } };
    const names = schemaArgNames({ properties: { first: shared, second: shared } });
    expect([...names].sort()).toEqual(['first', 'second', 'shared_name']);
  });

  test('collectSchemaArgNames adds into a caller-supplied set', () => {
    const into = new Set<string>(['preexisting']);
    collectSchemaArgNames({ properties: { added: {} } }, into);
    expect([...into].sort()).toEqual(['added', 'preexisting']);
  });
});

describe('against the real registry', () => {
  test('reaches update_recurring.rule.name_contains', () => {
    const updateRecurring = ALL_TOOL_DEFS.find((d) => d.schema.name === 'update_recurring');
    if (updateRecurring === undefined) throw new Error('update_recurring is not in the registry');
    const names = schemaArgNames(updateRecurring.schema.inputSchema);
    // The nested one, and its parent, and a top-level sibling — so a regression
    // to a one-level read fails on the first without the others masking it.
    expect(names.has('name_contains')).toBe(true);
    expect(names.has('rule')).toBe(true);
    expect(names.has('recurring_id')).toBe(true);
  });
});
