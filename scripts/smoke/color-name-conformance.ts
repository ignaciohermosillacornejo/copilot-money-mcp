/**
 * Conformance smoke: assert our `COLOR_NAMES` constant matches the server's
 * real `ColorName` GraphQL enum (issue #439).
 *
 * Run: `bun run scripts/smoke/color-name-conformance.ts`
 *      (or `bun run smoke:color-name`)
 *
 * NON-MUTATING. Requires an authenticated app.copilot.money browser session.
 *
 * See scripts/smoke/_conformance.ts for how the validation-only probe works
 * without touching real data, and scripts/smoke/conformance-checks.ts for this
 * enum's probe shape and known-bad control.
 */

import { runConformanceStandalone } from './run-standalone.js';
import { COLOR_NAME_CHECK } from './conformance-checks.js';

runConformanceStandalone(COLOR_NAME_CHECK);
