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
import { CONFORMANCE_LEDGER } from '../../src/conformance/ledger.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, derived from this file's location — no cwd assumption. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

describe('the ledger describes the spellings that are actually watched', () => {
  // The smoke watched 8 spellings while the ledger and CHANGELOG both said 11,
  // on the strength of a probe transcript that no longer exists. A count in
  // prose drifts from the list it describes the moment either moves, so the
  // two are pinned to each other here.
  const evidenceFor = (surface: string): string => {
    const entry = CONFORMANCE_LEDGER.find((e) => e.surface === surface);
    expect(entry, `no ledger entry for ${surface}`).toBeDefined();
    return entry!.evidence;
  };

  for (const check of ALL_OUTPUT_FIELD_ABSENCE_CHECKS) {
    const combined = check.ledgerSurfaces.map(evidenceFor).join('\n');

    test(`every watched ${check.typeName} spelling is named in the ledger`, () => {
      const unnamed = check.absentFields.filter((f) => !combined.includes(`\`${f}\``));
      expect(
        unnamed,
        `Spellings watched by scripts/smoke/output-field-absence-checks.ts but named in no ` +
          `ledger entry for ${check.ledgerSurfaces.join(', ')}: ${unnamed.join(', ')}. ` +
          `A reader who wants to know what the absence assumption covers reads the ledger.`
      ).toEqual([]);
    });

    test(`the ledger's ${check.typeName} spelling COUNT matches the watched list`, () => {
      // The claim is written as "that is N spellings", so it moves only when
      // someone updating the list also updates the sentence.
      expect(
        combined,
        `The ledger entries for ${check.ledgerSurfaces.join(', ')} must state the number of ` +
          `watched spellings as "is ${check.absentFields.length} spellings" — the absence ` +
          `check currently watches ${check.absentFields.length} ` +
          `(${check.absentFields.join(', ')}). Update the evidence text and this passes.`
      ).toContain(`is ${check.absentFields.length} spellings`);
    });
  }
});

describe('the SOURCE comment above the synthesis describes the watched spellings too', () => {
  // The ledger pin above did not reach this one. `src/tools/live/transactions.ts`
  // carries a SYNTHESIZED FIELDS block directly above the mappers — the copy a
  // maintainer reads first, before touching the derivation — and it went on
  // claiming 11 spellings for a full release cycle after the ledger, the
  // CHANGELOG and the smoke had all been corrected to 8. A pin that covers
  // only `entry.evidence` leaves every prose copy outside it free to drift.
  //
  // Reads the file rather than importing, because the claim lives in a comment
  // and comments are not values.
  const SOURCE = 'src/tools/live/transactions.ts';
  const BLOCK_START = 'SYNTHESIZED FIELDS';

  const block = (): string => {
    const text = readFileSync(join(REPO_ROOT, SOURCE), 'utf8');
    const from = text.indexOf(BLOCK_START);
    expect(from, `${SOURCE} no longer contains a "${BLOCK_START}" doc block`).toBeGreaterThan(-1);
    const to = text.indexOf('*/', from);
    expect(to, `the ${BLOCK_START} block in ${SOURCE} is unterminated`).toBeGreaterThan(from);
    return text.slice(from, to);
  };

  test('guards the gate: the block exists and is substantial', () => {
    // Without this, a renamed or deleted block turns both assertions below
    // into vacuous passes over an empty string.
    expect(block().length).toBeGreaterThan(500);
  });

  const txChecks = ALL_OUTPUT_FIELD_ABSENCE_CHECKS.filter((c) => c.typeName === 'Transaction');

  test('guards the gate: a Transaction check exists to loop over', () => {
    // The loop below filters. If the Transaction check is ever renamed or
    // dropped, a bare `for` would register ZERO tests and this describe would
    // pass green — the same executes-but-tests-nothing shape the block it
    // guards was written to catch.
    expect(txChecks.length).toBeGreaterThan(0);
  });

  for (const check of txChecks) {
    test(`every watched ${check.typeName} spelling is named in the source block`, () => {
      const text = block();
      const unnamed = check.absentFields.filter((f) => !text.includes(`\`${f}\``));
      expect(
        unnamed,
        `Spellings watched by scripts/smoke/output-field-absence-checks.ts but absent from the ` +
          `${BLOCK_START} block in ${SOURCE}: ${unnamed.join(', ')}. That block is what a ` +
          `maintainer reads before changing the synthesis, so it has to name what is actually ` +
          `watched.`
      ).toEqual([]);
    });

    test(`the source block states the same ${check.typeName} COUNT as the watched list`, () => {
      expect(
        block(),
        `The ${BLOCK_START} block in ${SOURCE} must state the watched-spelling count as ` +
          `"the ${check.absentFields.length} spellings" — the absence check currently watches ` +
          `${check.absentFields.length} (${check.absentFields.join(', ')}). An earlier revision ` +
          `said "and 6 further spellings" (11) long after every other site had been corrected.`
      ).toContain(`the ${check.absentFields.length} spellings`);
    });
  }
});
