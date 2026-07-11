/**
 * Reusable conformance-smoke harness.
 *
 * Generalizes the recurring-frequency conformance smoke (issue #419/#421) into
 * a single helper that asserts one of our enum constants exactly matches the
 * server's real GraphQL enum, with a discriminating known-bad control.
 *
 * NON-MUTATING. Each conformance script provides a `buildQuery` that inlines the
 * candidate enum value into a VALIDATION-ONLY probe — a mutation with a
 * deliberately malformed sibling field (e.g. `state: { z: 1 }` where the server
 * expects a scalar) so the request is rejected during query *validation*, BEFORE
 * any resolver runs. The fake id "x" is therefore never used to mutate anything.
 *
 * The enum literal MUST be inlined into the query string (not passed as a
 * variable) so the server validates it at parse time and, if unknown, emits
 * `Value "<X>" does not exist in "<EnumName>" enum.`
 *
 * Requires an authenticated app.copilot.money browser session — same auth path
 * the production server uses (FirebaseAuth via extractRefreshTokenCandidates).
 */

import { FirebaseAuth } from '../../src/core/auth/firebase-auth.js';
import { extractRefreshTokenCandidates } from '../../src/core/auth/browser-token.js';

const ENDPOINT = 'https://app.copilot.money/api/graphql';

/** Acquire a Firebase id token from the live browser session (once per run). */
export async function getIdToken(): Promise<string> {
  const auth = new FirebaseAuth(() => extractRefreshTokenCandidates());
  return auth.getIdToken();
}

export function smokeLog(msg: string, fields?: Record<string, unknown>): void {
  const prefix = `[smoke] ${msg}`;
  if (fields) {
    console.error(prefix, fields);
  } else {
    console.error(prefix);
  }
}

/**
 * Send a validation-only probe query and return the server's error messages
 * joined into one string (with unescaped quotes), so the caller can scan for a
 * rejection fragment. An empty string means the server reported NO errors.
 *
 * We parse the JSON `errors[].message` rather than scanning the raw body: in the
 * raw response the quotes in `... "<EnumName>" enum` are JSON-escaped (`\"`), so
 * a literal-quote fragment would never match the raw text (a false "valid" for
 * every value).
 *
 * A non-JSON body (e.g. an HTML error page after the session expires mid-run)
 * is NOT a GraphQL validation verdict, so it throws instead of returning text:
 * returning it would never contain any rejection fragment and every probe
 * built on it would silently look like a pass (a false negative for drift).
 */
export async function sendValidationProbe(idToken: string, query: string): Promise<string> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    // Everything is inlined into `query`; no variables to send.
    body: JSON.stringify({ query }),
    // Predictable failure mode if a connection hangs.
    signal: AbortSignal.timeout(10_000),
  });

  // Both 200 (errors array) and 400 (validation failure) carry an `errors`
  // array. Parse it and join the messages so quotes are unescaped.
  const text = await response.text();
  let json: { errors?: Array<{ message: string }> };
  try {
    json = JSON.parse(text) as { errors?: Array<{ message: string }> };
  } catch {
    throw new Error(
      `validation probe got a non-JSON response (HTTP ${response.status}) — ` +
        `likely an expired or unauthenticated session, not a GraphQL validation verdict`
    );
  }
  return (json.errors ?? []).map((e) => e.message).join(' || ');
}

export interface EnumConformanceOptions {
  /** Server enum name, e.g. 'RecurringFrequency' — used in the error fragment. */
  enumName: string;
  /** The constant under test (every member must be server-valid). */
  ourValues: readonly string[];
  /** A value the server MUST reject — the discriminating control. */
  knownBad: string;
  /** Inlines `value` into a validation-only mutation query string. */
  buildQuery: (value: string) => string;
  /** Firebase id token from getIdToken(). */
  idToken: string;
}

export interface EnumConformanceResult {
  label: string;
  failures: string[];
}

/**
 * Assert `ourValues` exactly matches the server's `enumName` enum:
 *   - every member is accepted (no enum-rejection error), and
 *   - `knownBad` is rejected (control), proving the probe discriminates.
 *
 * Returns failures rather than exiting so a runner can aggregate across enums.
 */
export async function assertEnumConformance(
  opts: EnumConformanceOptions
): Promise<EnumConformanceResult> {
  const { enumName, ourValues, knownBad, buildQuery, idToken } = opts;
  const fragment = `does not exist in "${enumName}" enum`;
  const failures: string[] = [];

  // Probes are independent round-trips — fire all values + the control
  // concurrently, then evaluate. (Logging below stays in declared order.)
  const [valueResults, controlBody] = await Promise.all([
    Promise.all(
      ourValues.map(async (value) => ({
        value,
        body: await sendValidationProbe(idToken, buildQuery(value)),
      }))
    ),
    sendValidationProbe(idToken, buildQuery(knownBad)),
  ]);

  // 1. Every value in our constant must be server-valid (no enum error).
  for (const { value, body } of valueResults) {
    if (body.trim() === '') {
      failures.push(
        `${value}: probe produced NO validation errors — a validation-only probe must ` +
          `never reach execution; the query shape is wrong (rules of engagement)`
      );
      smokeLog('value', { enum: enumName, value, error: 'none' });
      continue;
    }
    const rejected = body.includes(fragment) && body.includes(`"${value}"`);
    if (rejected) {
      failures.push(`${value}: REJECTED by server but present in our ${enumName} constant`);
      smokeLog('value', { enum: enumName, value, serverValid: false });
    } else {
      smokeLog('value', { enum: enumName, value, serverValid: true });
    }
  }

  // 2. Control: a known-bad value MUST be rejected, proving the probe works.
  const controlRejected = controlBody.includes(fragment) && controlBody.includes(`"${knownBad}"`);
  if (!controlRejected) {
    failures.push(
      `control ${knownBad}: expected server to reject it, but it was accepted — ` +
        `the probe is not discriminating (smoke is unreliable)`
    );
    smokeLog('control', { enum: enumName, value: knownBad, rejected: false });
  } else {
    smokeLog('control', { enum: enumName, value: knownBad, rejected: true });
  }

  return { label: enumName, failures };
}
