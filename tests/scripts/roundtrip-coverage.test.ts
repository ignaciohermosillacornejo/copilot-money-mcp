/**
 * Write-tool round-trip coverage ratchet (issue #438, Epic B #421).
 *
 * Plain unit test — no auth, no network, no mutations. Enforces that the
 * Tier-2 round-trip suite stays a complete inventory of the write surface:
 *
 * (a) every write tool in the registry (`WRITE_TOOL_DEFS`) has exactly one
 *     round-trip check in scripts/smoke/roundtrip-checks.ts — a new write
 *     tool without a round-trip fails this test;
 * (b) no stale checks: every check maps back to a registry write tool;
 * (c) every check's `appliesSurfaces` entry exists in the conformance
 *     ledger as a `kind: 'applies'` entry gated by `smoke:roundtrip`, and
 *     every `:applies` ledger surface is claimed by at least one check
 *     (no paper gates, no untracked verification);
 * (d) safety invariants: the marker convention, the bulkEditTransactions
 *     ban (source scan), and synthetic-only amounts in the checks source.
 *
 * Together with `tests/conformance/ledger.test.ts` (which verifies the
 * `smoke:roundtrip` oracle script exists), this is the B4 analog of
 * `tests/scripts/read-smoke-coverage.test.ts`.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WRITE_TOOL_DEFS } from '../../src/tools/registry/index.js';
import { CONFORMANCE_LEDGER } from '../../src/conformance/ledger.js';
import {
  ROUNDTRIP_CHECKS,
  ROUNDTRIP_DOMAINS,
  MARKER_PREFIX,
  makeMarker,
} from '../../scripts/smoke/roundtrip-checks.js';

const writeToolNames = WRITE_TOOL_DEFS.map((def) => def.name);
const appliesEntries = CONFORMANCE_LEDGER.filter((entry) => entry.kind === 'applies');
const appliesSurfaces = new Set(appliesEntries.map((entry) => entry.surface));
const claimedSurfaces = new Set(ROUNDTRIP_CHECKS.flatMap((check) => [...check.appliesSurfaces]));

const CHECKS_SOURCE = readFileSync(
  join(import.meta.dir, '..', '..', 'scripts', 'smoke', 'roundtrip-checks.ts'),
  'utf8'
);

describe('round-trip coverage ratchet', () => {
  test('sanity: the registry exposes the full write surface', () => {
    // 17 write tools as of E1 (#446); grows as new write tools land.
    expect(writeToolNames.length).toBeGreaterThanOrEqual(17);
    expect(new Set(writeToolNames).size).toBe(writeToolNames.length);
  });

  test('(a) every registry write tool has exactly one round-trip check', () => {
    for (const name of writeToolNames) {
      const checks = ROUNDTRIP_CHECKS.filter((check) => check.tool === name);
      expect(
        checks.length,
        `Write tool '${name}' must have exactly one round-trip check in ` +
          `scripts/smoke/roundtrip-checks.ts (found ${checks.length})`
      ).toBe(1);
    }
  });

  test('(b) no stale checks: every check maps to a registry write tool', () => {
    const names = new Set(writeToolNames);
    const stale = ROUNDTRIP_CHECKS.filter((check) => !names.has(check.tool)).map(
      (check) => check.tool
    );
    expect(stale, `Round-trip checks without a registry write tool: ${stale.join(', ')}`).toEqual(
      []
    );
  });

  test('(c) every check claims at least one applies surface that exists in the ledger', () => {
    for (const check of ROUNDTRIP_CHECKS) {
      expect(
        check.appliesSurfaces.length,
        `Check '${check.tool}' must declare the Mutation.<x>:applies surfaces it verifies`
      ).toBeGreaterThan(0);
      for (const surface of check.appliesSurfaces) {
        expect(
          surface.endsWith(':applies'),
          `Check '${check.tool}' claims '${surface}' — applies surfaces must end in ':applies'`
        ).toBe(true);
        expect(
          appliesSurfaces.has(surface),
          `Check '${check.tool}' claims '${surface}' but the conformance ledger has no such ` +
            "kind:'applies' entry (src/conformance/ledger.ts)"
        ).toBe(true);
      }
    }
  });

  test('(c) every ledger applies surface is claimed by at least one check', () => {
    const unclaimed = [...appliesSurfaces].filter((surface) => !claimedSurfaces.has(surface));
    expect(
      unclaimed,
      `Ledger 'applies' surfaces no round-trip check claims (paper gates): ${unclaimed.join(', ')}`
    ).toEqual([]);
  });

  test("(c) every applies entry is gated by the 'smoke:roundtrip' oracle", () => {
    for (const entry of appliesEntries) {
      expect(entry.oracle, `Entry '${entry.surface}' must name the round-trip oracle`).toBe(
        'smoke:roundtrip'
      );
      expect(entry.class, `Entry '${entry.surface}' must be classed 'gated'`).toBe('gated');
    }
  });

  test('(d) checks declare valid domains and unique tools', () => {
    for (const check of ROUNDTRIP_CHECKS) {
      expect(ROUNDTRIP_DOMAINS).toContain(check.domain);
      expect(check.flow.length).toBeGreaterThan(0);
    }
    const tools = ROUNDTRIP_CHECKS.map((check) => check.tool);
    expect(new Set(tools).size).toBe(tools.length);
  });

  test('(d) marker convention: __smoke__<timestamp>', () => {
    expect(MARKER_PREFIX).toBe('__smoke__');
    expect(makeMarker(1700000000000)).toBe('__smoke__1700000000000');
    expect(makeMarker()).toMatch(/^__smoke__\d+$/);
  });

  test('(d) the round-trip suite never references bulkEditTransactions', () => {
    expect(CHECKS_SOURCE).not.toContain('bulkEditTransactions');
    expect(CHECKS_SOURCE).not.toContain('bulk_edit');
  });

  test('(d) all amounts in the checks source are synthetic (100/200 family)', () => {
    // Catch a realistic figure sneaking into a created object: every numeric
    // amount literal in the checks source must come from the synthetic set.
    const amounts = [...CHECKS_SOURCE.matchAll(/amount:\s*(-?\d+(?:\.\d+)?)/g)].map((m) =>
      Math.abs(parseFloat(m[1]!))
    );
    expect(amounts.length).toBeGreaterThan(0);
    for (const amount of amounts) {
      expect([100, 200]).toContain(amount);
    }
  });
});
