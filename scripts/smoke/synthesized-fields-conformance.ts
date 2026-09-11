/**
 * Conformance smoke: assert the GraphQL `Transaction` type still does NOT
 * expose the two fields `get_transactions_live` synthesizes (#604).
 *
 * Run: `bun run scripts/smoke/synthesized-fields-conformance.ts`
 *      (or `bun run smoke:synthesized-fields` / `bun run smoke`)
 *
 * NON-MUTATING — read-only probes, rejected during validation. Requires an
 * authenticated app.copilot.money browser session.
 *
 * Unlike the other conformance checks, a FAILURE here is usually good news:
 * it means Copilot started returning a field we were approximating, and the
 * approximation should be retired. See scripts/smoke/output-field-absence-checks.ts.
 */

import { getIdToken } from './_conformance.js';
import { assertOutputFieldAbsence } from './_output-field-absence.js';
import { ALL_OUTPUT_FIELD_ABSENCE_CHECKS } from './output-field-absence-checks.js';

async function main(): Promise<void> {
  const idToken = await getIdToken();
  let failed = false;

  for (const check of ALL_OUTPUT_FIELD_ABSENCE_CHECKS) {
    const r = await assertOutputFieldAbsence({ check, idToken });
    if (r.failures.length > 0) {
      failed = true;
      console.error(`\n[smoke] FAIL — ${r.typeName} absence assumptions drifted:`);
      for (const f of r.failures) console.error(`  - ${f}`);
    } else {
      console.error(
        `\n[smoke] PASS — ${r.stillAbsent.length} assumed-absent ${r.typeName} fields are still ` +
          `absent, ${check.presentField} is still selectable, and the ${check.knownBadField} ` +
          `control was rejected.`
      );
    }
  }
  process.exit(failed ? 1 : 0);
}

void main();
