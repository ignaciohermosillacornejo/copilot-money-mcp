/**
 * Synthesized-field smoke coverage ratchet (#604).
 *
 * Two live-row fields are INVENTED by this repo because Copilot's GraphQL
 * `Transaction` type exposes neither, and both are recorded in the conformance
 * ledger as `*:synthesized`. An approximation like that rots in a direction
 * nothing else watches: if the server starts returning the real field, our
 * synthesized value becomes unnecessary and possibly contradictory, and no
 * test, type or budget would notice.
 *
 * `scripts/smoke/synthesized-fields-conformance.ts` watches for exactly that.
 * This ratchet makes it impossible to add a synthesized surface without a
 * smoke that covers it — the same relationship
 * `tests/scripts/read-smoke-coverage.test.ts` enforces between generated
 * queries and read smokes.
 *
 * Plain unit test: reads declarations, sends nothing.
 */

import { describe, test, expect } from 'bun:test';
import {
  ALL_OUTPUT_FIELD_ABSENCE_CHECKS,
  KNOWN_BAD_OUTPUT_FIELD,
  synthesizedLedgerSurfaces,
} from '../../scripts/smoke/output-field-absence-checks.js';

describe('every synthesized ledger surface has an absence smoke', () => {
  const covered = new Set(ALL_OUTPUT_FIELD_ABSENCE_CHECKS.flatMap((c) => c.ledgerSurfaces));
  const declared = synthesizedLedgerSurfaces();

  test('guards the gate: discovery finds the known synthesized surfaces', () => {
    // Without this, a ledger rename or a filter typo turns the coverage
    // assertion below into a vacuous pass over an empty list.
    expect(declared.length).toBeGreaterThanOrEqual(2);
    expect(declared).toContain('Transaction.excluded:synthesized');
    expect(declared).toContain('Transaction.internalTransfer:synthesized');
    expect(covered.size).toBeGreaterThanOrEqual(2);
  });

  test('no synthesized surface is missing its smoke', () => {
    const missing = declared.filter((s) => !covered.has(s));
    expect(
      missing,
      `Ledger surfaces classed ':synthesized' with no entry in ALL_OUTPUT_FIELD_ABSENCE_CHECKS:\n` +
        `  ${missing.join('\n  ')}\n` +
        "Add the field to an existing check's absentFields (and list the surface in its " +
        'ledgerSurfaces), or add a new check — otherwise nothing notices when Copilot starts ' +
        'returning the real field and the synthesis should be retired.'
    ).toEqual([]);
  });

  test('no smoke claims a surface the ledger does not declare', () => {
    // The reverse direction: a check pointing at a surface that was renamed or
    // removed would silently stop gating anything.
    const stale = [...covered].filter((s) => !declared.includes(s));
    expect(
      stale,
      `Absence checks naming ledger surfaces that no longer exist: ${stale.join(', ')}`
    ).toEqual([]);
  });
});

describe('the absence checks are shaped to be non-vacuous', () => {
  test('each check probes at least one field and names a control that must exist', () => {
    for (const c of ALL_OUTPUT_FIELD_ABSENCE_CHECKS) {
      expect(c.absentFields.length).toBeGreaterThan(0);
      // A rejection-only check would pass on a malformed probe; the
      // present-field control is what makes a PASS mean something.
      expect(c.presentField.length).toBeGreaterThan(0);
      expect(c.absentFields).not.toContain(c.presentField);
      expect(c.knownBadField).toBe(KNOWN_BAD_OUTPUT_FIELD);
    }
  });

  test('the probe selects the field it is named for', () => {
    for (const c of ALL_OUTPUT_FIELD_ABSENCE_CHECKS) {
      expect(c.buildQuery('someProbeField')).toContain('someProbeField');
      expect(c.buildQuery('someProbeField')).toContain('transactions(first: 1)');
    }
  });
});
