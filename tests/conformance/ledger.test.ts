/**
 * Conformance ledger enforcement (issue #435, Epic B #421).
 *
 * Plain unit test — runs in cloud CI with no auth and no network. Enforces
 * that the ledger in `src/conformance/ledger.ts` stays a complete, honest
 * inventory of the write surface's external assumptions:
 *
 * (a) every param (and enum value set) reachable from
 *     `createWriteToolSchemas()` has a ledger entry — a new write-tool param
 *     without an entry fails the build;
 * (b) every named `smoke:` oracle maps to an existing `scripts/smoke/` script;
 * (c) `class: 'gated'` requires a non-null oracle;
 * plus hygiene: unique surfaces, no stale toolParams, non-empty evidence,
 * and enum value sets that match the tool schemas exactly.
 */

import { describe, test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createWriteToolSchemas } from '../../src/tools/tools.js';
import {
  CONFORMANCE_LEDGER,
  classDistribution,
  formatClassDistribution,
} from '../../src/conformance/ledger.js';

const SMOKE_DIR = join(import.meta.dir, '..', '..', 'scripts', 'smoke');

// ---------------------------------------------------------------------------
// Walk the write-tool JSON schemas, collecting every reachable parameter path
// (`<tool>.<param>`, arrays as `<param>[]`) and every enum value set.
// ---------------------------------------------------------------------------

interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  enum?: string[];
}

interface EnumParam {
  path: string;
  values: string[];
}

function collectParams(): { paths: string[]; enums: EnumParam[] } {
  const paths: string[] = [];
  const enums: EnumParam[] = [];

  function walk(prefix: string, schema: JsonSchemaNode): void {
    if (schema.enum) enums.push({ path: prefix, values: schema.enum });
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        const path = `${prefix}.${key}`;
        paths.push(path);
        walk(path, sub);
      }
    }
    if (schema.items) walk(`${prefix}[]`, schema.items);
  }

  for (const tool of createWriteToolSchemas()) {
    walk(tool.name, tool.inputSchema as JsonSchemaNode);
  }
  return { paths, enums };
}

const { paths: reachableParams, enums: reachableEnums } = collectParams();
const ledgerParams = new Set(CONFORMANCE_LEDGER.flatMap((entry) => entry.toolParams ?? []));

describe('conformance ledger', () => {
  test('sanity: the write-tool schema walk finds a non-trivial surface', () => {
    // Guards against the walker silently breaking (e.g. a schema layout
    // change) and vacuously passing the coverage checks below.
    expect(reachableParams.length).toBeGreaterThan(50);
    expect(reachableEnums.length).toBeGreaterThanOrEqual(5);
    expect(createWriteToolSchemas().length).toBeGreaterThanOrEqual(17);
  });

  test('(a) every param reachable from createWriteToolSchemas() has a ledger entry', () => {
    const missing = reachableParams.filter((path) => !ledgerParams.has(path));
    expect(
      missing,
      `Write-tool params without a conformance ledger entry: ${missing.join(', ')}. ` +
        'Add an entry in src/conformance/ledger.ts whose toolParams includes each path ' +
        "(classed 'unverified' until a live probe or smoke gate exists)."
    ).toEqual([]);
  });

  test('(a) every enum value set in the write-tool schemas matches a ledger enum entry', () => {
    for (const { path, values } of reachableEnums) {
      const entry = CONFORMANCE_LEDGER.find(
        (candidate) => candidate.kind === 'enum' && (candidate.toolParams ?? []).includes(path)
      );
      expect(
        entry,
        `Enum param '${path}' has no kind:'enum' ledger entry listing it in toolParams`
      ).toBeDefined();
      expect(
        [...(entry?.values ?? [])].sort(),
        `Ledger entry '${entry?.surface}' values drifted from the '${path}' schema enum`
      ).toEqual([...values].sort());
    }
  });

  test('(b) every named smoke oracle maps to an existing scripts/smoke/ script', () => {
    for (const entry of CONFORMANCE_LEDGER) {
      if (entry.oracle === null || !entry.oracle.startsWith('smoke:')) continue;
      const script = join(SMOKE_DIR, `${entry.oracle.slice('smoke:'.length)}.ts`);
      expect(
        existsSync(script),
        `Oracle '${entry.oracle}' on surface '${entry.surface}' does not map to ${script}`
      ).toBe(true);
    }
  });

  test("(c) class 'gated' requires a non-null oracle", () => {
    const offenders = CONFORMANCE_LEDGER.filter(
      (entry) => entry.class === 'gated' && entry.oracle === null
    ).map((entry) => entry.surface);
    expect(
      offenders,
      `'gated' means a recurring oracle re-verifies the assumption — these entries claim ` +
        `gated with no oracle: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  test('surfaces are unique', () => {
    const seen = new Set<string>();
    const dupes = CONFORMANCE_LEDGER.map((entry) => entry.surface).filter((surface) => {
      if (seen.has(surface)) return true;
      seen.add(surface);
      return false;
    });
    expect(dupes).toEqual([]);
  });

  test('no stale toolParams: every listed path still exists in the write-tool schemas', () => {
    const reachable = new Set(reachableParams);
    const stale = [...ledgerParams].filter((path) => !reachable.has(path));
    expect(
      stale,
      `Ledger toolParams that no longer exist in createWriteToolSchemas(): ${stale.join(', ')}`
    ).toEqual([]);
  });

  test('every entry carries a non-empty evidence trail', () => {
    const blank = CONFORMANCE_LEDGER.filter((entry) => entry.evidence.trim() === '').map(
      (entry) => entry.surface
    );
    expect(blank).toEqual([]);
  });

  test('class distribution counts every entry exactly once', () => {
    const dist = classDistribution();
    const total = dist.gated + dist['verified-once'] + dist.unverified;
    expect(total).toBe(CONFORMANCE_LEDGER.length);
  });

  test('formatClassDistribution renders one line per class plus a header', () => {
    const rendered = formatClassDistribution();
    expect(rendered).toContain(`(${CONFORMANCE_LEDGER.length} surfaces)`);
    expect(rendered).toContain('gated');
    expect(rendered).toContain('verified-once');
    expect(rendered).toContain('unverified');
    expect(rendered.split('\n')).toHaveLength(4);
  });
});
