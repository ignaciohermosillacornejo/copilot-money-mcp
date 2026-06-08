/**
 * Conformance smoke: assert our `TRANSACTION_TYPES` constant matches the
 * server's real `TransactionType` GraphQL enum (issue #421).
 *
 * Run: `bun run scripts/smoke/transaction-type-conformance.ts`
 *
 * NON-MUTATING. Requires an authenticated app.copilot.money browser session.
 *
 * See scripts/smoke/_conformance.ts for how the validation-only probe works
 * without touching real data, and scripts/smoke/conformance-checks.ts for this
 * enum's probe shape and known-bad control.
 */

import { runConformanceStandalone } from './run-standalone.js';
import { TRANSACTION_TYPE_CHECK } from './conformance-checks.js';

runConformanceStandalone(TRANSACTION_TYPE_CHECK);
