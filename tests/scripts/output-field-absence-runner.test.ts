/**
 * Runner behaviour for the output-field ABSENCE smoke (#604).
 *
 * The check's own value depends on its two controls: a field that must exist
 * and a name that cannot. An earlier revision ran them AFTER the field loop,
 * so the one run where the matcher was broken (it compared JSON-escaped quotes
 * against unescaped response text) printed eight "NOW EXPOSED — retire the
 * approximation" alarms and only then the single line saying none of them
 * meant anything.
 *
 * These tests pin the ordering and the bail-out. No network: the runner takes
 * a `sendProbe` seam and every probe here is a canned string.
 */

import { describe, test, expect } from 'bun:test';
import { assertOutputFieldAbsence } from '../../scripts/smoke/_output-field-absence.js';
import { TRANSACTION_ABSENCE_CHECK } from '../../scripts/smoke/output-field-absence-checks.js';

/** The server's real wording for a field that does not exist on a type. */
function rejection(typeName: string, fieldName: string): string {
  return `{"errors":[{"message":"Cannot query field \\"${fieldName}\\" on type \\"${typeName}\\"."}]}`
    .split('\\"')
    .join('"');
}

/** Wraps a probe fn so the test can count and inspect what was sent. */
function recording(fn: (query: string) => string) {
  const queries: string[] = [];
  return {
    queries,
    sendProbe: async (_token: string, query: string) => {
      queries.push(query);
      return fn(query);
    },
  };
}

/** Which probed field name a built query selects. */
function fieldIn(query: string, names: readonly string[]): string | undefined {
  return names.find((n) => new RegExp(`\\b${n}\\b`).test(query));
}

const check = TRANSACTION_ABSENCE_CHECK;
const ALL_NAMES = [...check.absentFields, check.presentField, check.knownBadField];

describe('assertOutputFieldAbsence', () => {
  test('healthy run: controls pass, every assumed-absent field still absent', async () => {
    const { sendProbe, queries } = recording((q) => {
      const field = fieldIn(q, ALL_NAMES);
      // Everything is rejected except the field that must exist.
      return field === check.presentField
        ? '{"data":{"transactions":{"edges":[]}}}'
        : rejection(check.typeName, field!);
    });

    const r = await assertOutputFieldAbsence({ check, idToken: 'tok', sendProbe });

    expect(r.failures).toEqual([]);
    expect(r.presentFieldAccepted).toBe(true);
    expect(r.knownBadRejected).toBe(true);
    expect(r.stillAbsent).toEqual([...check.absentFields]);
    expect(r.nowPresent).toEqual([]);
    // Two controls plus one probe per assumed-absent field.
    expect(queries).toHaveLength(check.absentFields.length + 2);
  });

  test('a real drift is reported: one field the server now exposes', async () => {
    const exposed = check.absentFields[0]!;
    const { sendProbe } = recording((q) => {
      const field = fieldIn(q, ALL_NAMES);
      return field === check.presentField || field === exposed
        ? '{"data":{"transactions":{"edges":[]}}}'
        : rejection(check.typeName, field!);
    });

    const r = await assertOutputFieldAbsence({ check, idToken: 'tok', sendProbe });

    expect(r.nowPresent).toEqual([exposed]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain(`${check.typeName}.${exposed} is NOW EXPOSED`);
  });

  test('a broken matcher reports the control, NOT one alarm per field', async () => {
    // The exact shape of the shipped bug: nothing matches as a rejection, so
    // every field looks "present" — including the impossible control.
    const { sendProbe, queries } = recording(() => '{"data":null}');

    const r = await assertOutputFieldAbsence({ check, idToken: 'tok', sendProbe });

    // Exactly one failure, and it is the control — not eight retraction-worthy
    // "retire the approximation" alarms the operator reads first.
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain(check.knownBadField);
    expect(r.failures.join('\n')).not.toContain('NOW EXPOSED');
    expect(r.knownBadRejected).toBe(false);
    // The field loop did not run at all: two control probes and nothing else.
    expect(queries).toHaveLength(2);
    expect(r.stillAbsent).toEqual([]);
    expect(r.nowPresent).toEqual([]);
  });

  test('a rejected present-field control also skips absence probing', async () => {
    // The other half: the probe SHAPE is wrong, so even the field that must
    // exist comes back rejected. Absence results would be meaningless.
    const { sendProbe, queries } = recording((q) =>
      rejection(check.typeName, fieldIn(q, ALL_NAMES)!)
    );

    const r = await assertOutputFieldAbsence({ check, idToken: 'tok', sendProbe });

    expect(r.presentFieldAccepted).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('SKIPPED');
    expect(queries).toHaveLength(2);
    expect(r.stillAbsent).toEqual([]);
  });
});
