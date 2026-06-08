/**
 * Conformance smoke: assert our `RECURRING_FREQUENCIES` constant matches the
 * server's real `RecurringFrequency` GraphQL enum (issue #419).
 *
 * Run: `bun run scripts/smoke/recurring-frequency-conformance.ts`
 *      (or `bun run smoke:recurring-frequency`)
 *
 * NON-MUTATING. Requires an authenticated app.copilot.money browser session.
 *
 * How it works without touching real data:
 *   For each candidate frequency we send a VALIDATION-ONLY probe — an
 *   `editRecurring` mutation whose `input.state` is a malformed object
 *   (`{z:1}` where the server expects a scalar). That malformation makes the
 *   server reject the request during query *validation*, BEFORE any resolver
 *   runs — so even with the fake id "x" nothing is ever mutated. The frequency
 *   enum literal is inlined into the query string (not passed as a variable),
 *   so the server validates the enum value at parse time and, if the value is
 *   unknown, emits `Value "<X>" does not exist in "RecurringFrequency" enum.`.
 *
 *   - For each value in RECURRING_FREQUENCIES: assert the response does NOT
 *     contain that enum error → the value is server-valid.
 *   - As a CONTROL, probe a KNOWN-BAD value (YEARLY) and assert the server
 *     DOES emit the enum error → proving the probe actually discriminates.
 *
 * Prints a PASS/FAIL summary and exits non-zero on any mismatch.
 */

import { FirebaseAuth } from '../../src/core/auth/firebase-auth.js';
import { extractRefreshToken } from '../../src/core/auth/browser-token.js';
import { RECURRING_FREQUENCIES } from '../../src/core/graphql/recurrings.js';

const ENDPOINT = 'https://app.copilot.money/api/graphql';
const KNOWN_BAD = 'YEARLY';
const ENUM_ERROR_FRAGMENT = 'does not exist in "RecurringFrequency" enum';

/**
 * Send a validation-only editRecurring probe with the given frequency enum
 * value inlined into the query. Returns the raw response text so the caller
 * can inspect it for the enum-rejection fragment.
 */
async function probeFrequency(idToken: string, frequency: string): Promise<string> {
  // Inline the enum literal so it is validated at parse time. The malformed
  // `state: {z: 1}` guarantees validation fails before execution → no mutation.
  const query = `mutation FrequencyProbe {
  editRecurring(id: "x", input: { frequency: ${frequency}, state: { z: 1 } }) {
    recurring {
      id
    }
  }
}`;

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ operationName: 'FrequencyProbe', query, variables: {} }),
  });

  // Both 200 (errors array) and 400 (validation failure) carry the message
  // body we care about; read as text and scan regardless of status.
  return response.text();
}

function log(msg: string, fields?: Record<string, unknown>): void {
  const prefix = `[smoke] ${msg}`;
  if (fields) {
    console.error(prefix, fields);
  } else {
    console.error(prefix);
  }
}

async function main(): Promise<void> {
  // Same auth path the production server and other smokes use (FirebaseAuth via
  // extractRefreshToken from a live app.copilot.money browser session).
  const auth = new FirebaseAuth(() => extractRefreshToken());
  const idToken = await auth.getIdToken();

  const failures: string[] = [];

  // 1. Every value in our constant must be server-valid (no enum error).
  for (const freq of RECURRING_FREQUENCIES) {
    const body = await probeFrequency(idToken, freq);
    const rejected = body.includes(ENUM_ERROR_FRAGMENT) && body.includes(`"${freq}"`);
    if (rejected) {
      failures.push(`${freq}: REJECTED by server but present in RECURRING_FREQUENCIES`);
      log('value', { freq, serverValid: false });
    } else {
      log('value', { freq, serverValid: true });
    }
  }

  // 2. Control: a known-bad value MUST be rejected, proving the probe works.
  const controlBody = await probeFrequency(idToken, KNOWN_BAD);
  const controlRejected =
    controlBody.includes(ENUM_ERROR_FRAGMENT) && controlBody.includes(`"${KNOWN_BAD}"`);
  if (!controlRejected) {
    failures.push(
      `control ${KNOWN_BAD}: expected server to reject it, but it was accepted — ` +
        `the probe is not discriminating (smoke is unreliable)`
    );
    log('control', { freq: KNOWN_BAD, rejected: false });
  } else {
    log('control', { freq: KNOWN_BAD, rejected: true });
  }

  // Summary.
  if (failures.length > 0) {
    console.error('\n[smoke] FAIL — RECURRING_FREQUENCIES does not match the server enum:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.error(
    `\n[smoke] PASS — all ${RECURRING_FREQUENCIES.length} values are server-valid ` +
      `and the ${KNOWN_BAD} control was correctly rejected.`
  );
}

main().catch((err: unknown) => {
  console.error('[smoke] FAIL:', err);
  process.exit(1);
});
