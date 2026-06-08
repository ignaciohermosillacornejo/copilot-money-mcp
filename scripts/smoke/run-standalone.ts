/**
 * Standalone runner for a single conformance check.
 *
 * Wires one ConformanceCheck to the harness, acquires an id token, runs the
 * assertion, prints a PASS/FAIL summary, and `process.exit(1)` on any mismatch.
 * Used by the per-enum standalone scripts (e.g. recurring-frequency-conformance.ts).
 */

import { assertEnumConformance, getIdToken, type ConformanceCheck } from './conformance-checks.js';

export function runConformanceStandalone(check: ConformanceCheck): void {
  async function main(): Promise<void> {
    const idToken = await getIdToken();
    const { failures } = await assertEnumConformance({ ...check, idToken });

    if (failures.length > 0) {
      console.error(`\n[smoke] FAIL — our constant does not match the ${check.enumName} enum:`);
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }

    console.error(
      `\n[smoke] PASS — all ${check.ourValues.length} ${check.enumName} values are server-valid ` +
        `and the ${check.knownBad} control was correctly rejected.`
    );
  }

  main().catch((err: unknown) => {
    console.error('[smoke] FAIL:', err);
    process.exit(1);
  });
}
