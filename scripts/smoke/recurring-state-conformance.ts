/**
 * Conformance smoke: assert our `RECURRING_STATE_VALUES` constant matches the
 * server's real `RecurringState` GraphQL enum (issue #421).
 *
 * Run: `bun run scripts/smoke/recurring-state-conformance.ts`
 *
 * NON-MUTATING. Requires an authenticated app.copilot.money browser session.
 *
 * See scripts/smoke/_conformance.ts for how the validation-only probe works
 * without touching real data, and scripts/smoke/conformance-checks.ts for this
 * enum's probe shape and known-bad control.
 */

import { runConformanceStandalone } from './run-standalone.js';
import { RECURRING_STATE_CHECK } from './conformance-checks.js';

runConformanceStandalone(RECURRING_STATE_CHECK);
