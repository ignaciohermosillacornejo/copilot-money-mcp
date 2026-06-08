/**
 * Conformance smoke: assert our `RECURRING_FREQUENCIES` constant matches the
 * server's real `RecurringFrequency` GraphQL enum (issue #419).
 *
 * Run: `bun run scripts/smoke/recurring-frequency-conformance.ts`
 *      (or `bun run smoke:recurring-frequency`)
 *
 * NON-MUTATING. Requires an authenticated app.copilot.money browser session.
 *
 * See scripts/smoke/_conformance.ts for how the validation-only probe works
 * without touching real data, and scripts/smoke/conformance-checks.ts for this
 * enum's probe shape and known-bad control.
 */

import { runConformanceStandalone } from './run-standalone.js';
import { RECURRING_FREQUENCY_CHECK } from './conformance-checks.js';

runConformanceStandalone(RECURRING_FREQUENCY_CHECK);
