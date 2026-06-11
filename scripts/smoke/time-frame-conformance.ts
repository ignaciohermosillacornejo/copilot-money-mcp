/**
 * Conformance smoke: assert our `ALL_TIME_FRAMES` constant matches the
 * server's real `TimeFrame` GraphQL enum (issue #439).
 *
 * Run: `bun run scripts/smoke/time-frame-conformance.ts`
 *      (or `bun run smoke:time-frame`)
 *
 * NON-MUTATING. Requires an authenticated app.copilot.money browser session.
 *
 * See scripts/smoke/_conformance.ts for how the validation-only probe works
 * without touching real data, and scripts/smoke/conformance-checks.ts for this
 * enum's probe shape and known-bad control.
 */

import { runConformanceStandalone } from './run-standalone.js';
import { TIME_FRAME_CHECK } from './conformance-checks.js';

runConformanceStandalone(TIME_FRAME_CHECK);
