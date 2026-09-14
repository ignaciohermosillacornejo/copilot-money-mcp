/**
 * Runner for output-field ABSENCE checks (PR C, #604).
 *
 * Sibling of `_conformance.ts` (enum values) and `_field-conformance.ts`
 * (input-type fields). Those ask whether what we SEND is still accepted; this
 * asks whether what we assume MISSING is still missing, because two live-row
 * fields are synthesized on the strength of that absence.
 *
 * Read-only. Every probe is a `transactions(first: 1)` query whose selection is
 * rejected during validation when the field is absent.
 */

import { sendValidationProbe, smokeLog } from './_conformance.js';
import type { OutputFieldAbsenceCheck } from './output-field-absence-checks.js';

export interface OutputFieldAbsenceResult {
  typeName: string;
  /** Absent fields that are STILL absent — the assumption holding. */
  stillAbsent: string[];
  /** Absent fields the server now EXPOSES — retire the synthesis. */
  nowPresent: string[];
  /** True when the control field that must exist was accepted. */
  presentFieldAccepted: boolean;
  /** True when the bogus control was rejected (probe discriminates). */
  knownBadRejected: boolean;
  failures: string[];
}

/**
 * The server's wording when a selected field does not exist on a type.
 *
 * Plain quotes, not JSON-escaped ones: `sendValidationProbe` parses the
 * response and joins the messages precisely so quotes arrive unescaped. An
 * earlier revision matched `\\"` and therefore matched nothing, which reported
 * every probed field as "now exposed by the server" — caught only because the
 * `zzNotARealOutputField` control also came back "present", which is
 * impossible. That control is why this check can be trusted at all.
 */
function rejectsField(body: string, typeName: string, fieldName: string): boolean {
  return body.includes(`Cannot query field "${fieldName}" on type "${typeName}"`);
}

export async function assertOutputFieldAbsence(opts: {
  check: OutputFieldAbsenceCheck;
  idToken: string;
  /** Seam for tests; defaults to the real network probe. */
  sendProbe?: (idToken: string, query: string) => Promise<string>;
}): Promise<OutputFieldAbsenceResult> {
  const { check, idToken, sendProbe = sendValidationProbe } = opts;
  const { typeName, absentFields, presentField, knownBadField, buildQuery } = check;

  const stillAbsent: string[] = [];
  const nowPresent: string[] = [];
  const failures: string[] = [];

  // THE CONTROLS RUN FIRST, and the field loop below does not run at all if
  // either fails. The ordering is the finding, not a style preference: when
  // the matcher was broken (it compared JSON-escaped quotes against unescaped
  // text), every field came back "not rejected", so a controls-last runner
  // printed N copies of "NOW EXPOSED — retire the approximation" and only then
  // the one line explaining that none of them meant anything. The operator
  // reads the alarms first and the retraction last. A run whose controls fail
  // has no findings to report, so it reports none.

  // Guards the gate, half 1: a field that MUST exist has to be accepted, or a
  // malformed probe would "prove" every absence at once while proving nothing.
  const presentBody = await sendProbe(idToken, buildQuery(presentField));
  const presentFieldAccepted = !rejectsField(presentBody, typeName, presentField);
  if (!presentFieldAccepted) {
    failures.push(
      `${typeName}.${presentField} was REJECTED. Either the probe shape is wrong, or the field ` +
        `this check names as always-present has been removed — see presentField on the ` +
        `${typeName} check for why that one was chosen. Absence probing was SKIPPED — this run ` +
        `proves nothing either way. Investigate before trusting it.`
    );
  }

  // Guards the gate, half 2: a name that cannot exist must be rejected.
  const badBody = await sendProbe(idToken, buildQuery(knownBadField));
  const knownBadRejected = rejectsField(badBody, typeName, knownBadField);
  if (!knownBadRejected) {
    failures.push(
      `control ${typeName}.${knownBadField} was ACCEPTED — the probe cannot discriminate, so ` +
        `neither can this check. Absence probing was SKIPPED.`
    );
  }

  if (!presentFieldAccepted || !knownBadRejected) {
    return { typeName, stillAbsent, nowPresent, presentFieldAccepted, knownBadRejected, failures };
  }

  for (const field of absentFields) {
    const body = await sendProbe(idToken, buildQuery(field));
    if (rejectsField(body, typeName, field)) {
      stillAbsent.push(field);
      smokeLog('absent', { type: typeName, field, present: false });
    } else {
      nowPresent.push(field);
      smokeLog('absent', { type: typeName, field, present: true });
      failures.push(
        `${typeName}.${field} is NOW EXPOSED by the server. The live synthesis of this value ` +
          `(see ${check.ledgerSurfaces.join(', ')}) exists only because the field was missing — ` +
          `retire the approximation in favour of the real field, and update the ledger entry.`
      );
    }
  }

  return { typeName, stillAbsent, nowPresent, presentFieldAccepted, knownBadRejected, failures };
}
