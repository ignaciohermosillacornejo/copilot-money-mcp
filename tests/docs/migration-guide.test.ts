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

/** The guide's table, parsed into tool -> field names. */
function documentedRows(): Map<string, string[]> {
  const text = readFileSync(join(REPO_ROOT, GUIDE), 'utf-8');
  const from = text.indexOf(BEGIN);
  const to = text.indexOf(END, from);
  expect(from, `${GUIDE} is missing its "${BEGIN}" marker`).toBeGreaterThan(-1);
  expect(to, `${GUIDE} is missing its "${END}" marker`).toBeGreaterThan(from);

  const rows = new Map<string, string[]>();
  for (const line of text.slice(from, to).split('\n')) {
    // | `tool_name` | `field`, `field`, ... |
    const m = /^\|\s*`([a-z_]+)`\s*\|(.+)\|\s*$/.exec(line);
    if (!m) continue;
    const fields = [...m[2]!.matchAll(/`([a-zA-Z_][a-zA-Z0-9_]*)`/g)].map((f) => f[1]!);
    rows.set(m[1]!, fields);
  }
  return rows;
}

const presets = exportedPresets();
const rows = documentedRows();
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
        `add a row, or if the preset is not a tool default, say so in the guide.`
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
