/**
 * The migration guide's preset table is checked against the real presets.
 *
 * `docs/MIGRATING-v3.md` tells an upgrading caller exactly which fields each
 * terse tool returns by default. That is the kind of claim this release spent
 * eight review rounds learning not to leave as prose: a field renamed in
 * `src/tools/field-selection.ts` would leave the guide quietly wrong, and the
 * guide is what someone reads precisely when their code has stopped working.
 *
 * WHAT THIS PINS
 *   - every field list in the table is EXACTLY one of the exported presets,
 *     so a hand-typed or renamed field name fails;
 *   - every exported preset appears in the table, so a tool dieted later
 *     cannot ship undocumented;
 *   - every tool named in the table is a real registered tool.
 *
 * WHAT IT DOES NOT PIN, stated rather than implied: the table maps tool ->
 * preset, and nothing here re-derives that mapping, so swapping the rows of
 * two documented tools would pass. Closing that needs a tool -> preset dump
 * that does not exist on the TypeScript side today (`check-skills.py` has one
 * in Python). The realistic drift — a preset's contents changing — is covered.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fieldSelection from '../../src/tools/field-selection.js';
import { READ_TOOL_DEFS, LIVE_TOOL_DEFS } from '../../src/tools/registry/index.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUIDE = 'docs/MIGRATING-v3.md';
const BEGIN = '<!-- BEGIN PRESET TABLE';
const END = '<!-- END PRESET TABLE';

/** Every exported `DEFAULT_*_FIELDS` preset, read off the module itself. */
function exportedPresets(): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const [name, value] of Object.entries(fieldSelection)) {
    if (name.startsWith('DEFAULT_') && name.endsWith('_FIELDS') && Array.isArray(value)) {
      out.set(name, value as readonly string[]);
    }
  }
  return out;
}

/**
 * The guide's table, parsed into tool -> field names, plus any duplicate rows.
 *
 * Reports duplicates rather than asserting on them: this runs at module scope,
 * so an `expect()` here would surface as a file-load error — losing the message
 * and taking the other tests down with it — instead of as one named red test.
 * A missing marker still throws, because there is nothing to test without one.
 */
function documentedRows(): { rows: Map<string, string[]>; duplicates: string[] } {
  const text = readFileSync(join(REPO_ROOT, GUIDE), 'utf-8');
  const from = text.indexOf(BEGIN);
  const to = text.indexOf(END, from);
  if (from === -1) throw new Error(`${GUIDE} is missing its "${BEGIN}" marker`);
  if (to <= from) throw new Error(`${GUIDE} is missing its "${END}" marker`);

  const rows = new Map<string, string[]>();
  const duplicates: string[] = [];
  for (const line of text.slice(from, to).split('\n')) {
    // | `tool_name` | `field`, `field`, ... |
    const m = /^\|\s*`([a-z_]+)`\s*\|(.+)\|\s*$/.exec(line);
    if (!m) continue;
    const fields = [...m[2]!.matchAll(/`([a-zA-Z_][a-zA-Z0-9_]*)`/g)].map((f) => f[1]!);
    const tool = m[1]!;
    // A copy-pasted duplicate would otherwise overwrite silently AND push
    // `rows.size` back toward the non-vacuity floor.
    if (rows.has(tool)) duplicates.push(tool);
    rows.set(tool, fields);
  }
  return { rows, duplicates };
}

const presets = exportedPresets();
const { rows, duplicates } = documentedRows();
const registeredTools = new Set(
  [...READ_TOOL_DEFS, ...LIVE_TOOL_DEFS].map((d) => (d.schema as { name: string }).name)
);

/** Order-insensitive comparison — the guide reads better in preset order. */
const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

describe('the migration guide documents the real presets', () => {
  test('guards the gate: both sides were actually discovered', () => {
    // Without this, an empty parse or an empty module would make every
    // assertion below pass over nothing.
    expect(presets.size).toBeGreaterThanOrEqual(8);
    expect(rows.size).toBeGreaterThanOrEqual(8);
    expect(registeredTools.size).toBeGreaterThan(20);
    expect(
      duplicates,
      `${GUIDE} lists these tools more than once in the preset table: ${duplicates.join(', ')}. ` +
        `A duplicate row overwrites the earlier one silently and depresses the count above.`
    ).toEqual([]);
  });

  test('every documented field list is exactly one of the real presets', () => {
    const wrong: string[] = [];
    for (const [tool, fields] of rows) {
      if (![...presets.values()].some((p) => same(p, fields))) {
        wrong.push(`${tool}: ${fields.join(', ')}`);
      }
    }
    expect(
      wrong,
      `${GUIDE} lists a default row that matches no DEFAULT_*_FIELDS preset in ` +
        `src/tools/field-selection.ts. Either a preset changed and the guide did not, or a ` +
        `field name in the guide is mistyped — and this is the page someone reads when their ` +
        `code has already broken:\n  ${wrong.join('\n  ')}`
    ).toEqual([]);
  });

  test('every real preset is documented', () => {
    const undocumented = [...presets.entries()]
      .filter(([, p]) => ![...rows.values()].some((f) => same(p, f)))
      .map(([name]) => name);
    expect(
      undocumented,
      `Presets exported from src/tools/field-selection.ts that no row of ${GUIDE} describes: ` +
        `${undocumented.join(', ')}. A tool dieted after v3 should not ship undocumented — ` +
        `add a row to the table naming exactly these fields. (Prose elsewhere in the guide ` +
        `will not satisfy this: the check compares field LISTS against table rows.)`
    ).toEqual([]);
  });

  test('every tool named in the guide is a registered read tool', () => {
    const unknown = [...rows.keys()].filter((t) => !registeredTools.has(t));
    expect(
      unknown,
      `${GUIDE} names tools that are not in READ_TOOL_DEFS or LIVE_TOOL_DEFS: ` +
        `${unknown.join(', ')}. A renamed or removed tool leaves the guide pointing at nothing.`
    ).toEqual([]);
  });
});
