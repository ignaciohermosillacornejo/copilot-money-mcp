/**
 * Input-field conformance harness (issue #436, Epic B #421).
 *
 * Sibling of `_conformance.ts` (enum values): asserts that every input-type
 * FIELD NAME our GraphQL wrappers declare still exists on the server's real
 * input type, with a discriminating unknown-field control (Technique 4,
 * docs/graphql-capture/introspection-recon.md).
 *
 * NON-MUTATING. Each probe inlines `<field>: { z: 1 }` — a value that no
 * scalar, enum, list, or input-object field can accept — so the request is
 * rejected during query *validation*, BEFORE any resolver runs. Check
 * definitions additionally include a second malformed sibling field where the
 * input type has one (defense in depth), and every id arg is the fake "x".
 *
 * Per probed field the server can answer one of three ways:
 *   - a value/type error (e.g. `String cannot represent a non string value`)
 *     → the field EXISTS: conformance holds;
 *   - `Field "<field>" is not defined by type "<InputType>"` → the field is
 *     GONE from the server type: drift, FAIL;
 *   - no errors at all → the probe reached execution, which a validation-only
 *     probe must never do: FAIL loudly (harness misconfiguration).
 *
 * The control probe sends a field name that must not exist on any input type
 * and asserts the server DOES emit the "is not defined" error — proving the
 * probe discriminates.
 *
 * Requires an authenticated app.copilot.money browser session (same auth path
 * as the enum harness); unit tests inject `probeFn` instead.
 */

import { sendValidationProbe, smokeLog } from './_conformance.js';

/** The exact Apollo unknown-input-field error prefix for `field`. We match
 * without the trailing type name because the server's internal input-type
 * names are not guaranteed to equal our local interface names.
 *
 * Substring matching is safe ONLY because the fragment keeps BOTH double
 * quotes around the field name: `Field "name" is not defined` cannot match
 * inside the error for a longer field (`Field "colorName" is not defined`)
 * since `"` must immediately precede the name. Do not weaken this to an
 * unquoted or suffix-only match. */
function notDefinedFragment(field: string): string {
  return `Field "${field}" is not defined`;
}

export interface FieldConformanceOptions {
  /** Label for logs/summary — our local input-type name (e.g.
   * 'CreateTransactionInput', or 'EditRecurringInput.rule' for nested). */
  inputTypeName: string;
  /** Declared field names under test (every one must exist on the server). */
  fields: readonly string[];
  /** A field name the server MUST reject — the discriminating control. */
  knownBadField: string;
  /** Inlines one field assignment into a validation-only mutation query. */
  buildQuery: (fieldName: string) => string;
  /** Firebase id token from getIdToken(). Unused when `probeFn` is injected. */
  idToken: string;
  /** Test seam: replaces the live HTTP probe. Defaults to sendValidationProbe. */
  probeFn?: (idToken: string, query: string) => Promise<string>;
}

export interface FieldConformanceResult {
  label: string;
  failures: string[];
}

/**
 * Assert every field in `fields` exists on the server's input type:
 *   - no probe answers `Field "<field>" is not defined` (drift check),
 *   - no probe passes validation silently (rules-of-engagement check), and
 *   - `knownBadField` IS rejected as undefined (control), proving the probe
 *     discriminates.
 *
 * Returns failures rather than exiting so the runner can aggregate.
 */
export async function assertFieldConformance(
  opts: FieldConformanceOptions
): Promise<FieldConformanceResult> {
  const { inputTypeName, fields, knownBadField, buildQuery, idToken } = opts;
  const probeFn = opts.probeFn ?? sendValidationProbe;
  const failures: string[] = [];

  // Probes are independent round-trips — fire all fields + the control
  // concurrently, then evaluate. (Logging below stays in declared order.)
  const [fieldResults, controlBody] = await Promise.all([
    Promise.all(
      fields.map(async (field) => ({ field, body: await probeFn(idToken, buildQuery(field)) }))
    ),
    probeFn(idToken, buildQuery(knownBadField)),
  ]);

  // 1. Every declared field must exist server-side (no unknown-field error)
  //    AND every probe must be rejected at validation (some error present).
  for (const { field, body } of fieldResults) {
    if (body.trim() === '') {
      failures.push(
        `${field}: probe produced NO validation errors — a validation-only probe must ` +
          `never reach execution; the query shape is wrong (rules of engagement)`
      );
      smokeLog('field', { type: inputTypeName, field, error: 'none' });
      continue;
    }
    const notDefined = body.includes(notDefinedFragment(field));
    if (notDefined) {
      failures.push(
        `${field}: server says it is not defined, but our ${inputTypeName} declares it`
      );
    }
    smokeLog('field', { type: inputTypeName, field, serverDefined: !notDefined });
  }

  // 2. Control: the known-bad field MUST come back "is not defined", proving
  //    the probe discriminates.
  const controlRejected = controlBody.includes(notDefinedFragment(knownBadField));
  if (!controlRejected) {
    failures.push(
      `control ${knownBadField}: expected 'is not defined' rejection, but the server ` +
        `did not flag it — the probe is not discriminating (smoke is unreliable)`
    );
    smokeLog('control', { type: inputTypeName, field: knownBadField, rejected: false });
  } else {
    smokeLog('control', { type: inputTypeName, field: knownBadField, rejected: true });
  }

  return { label: inputTypeName, failures };
}
