/**
 * Conformance smoke runner (issues #421, #436).
 *
 * Runs every conformance check against the LIVE Copilot GraphQL endpoint,
 * using one shared id token:
 *   - enum checks (RecurringFrequency, RecurringState, TransactionType), and
 *   - input-field checks (every input type's declared field names, with an
 *     unknown-field control — issue #436),
 * then prints a per-surface PASS/FAIL summary table and exits non-zero if
 * anything drifted from the server.
 *
 * Run: `bun run scripts/smoke/conformance.ts`
 *      (or `bun run smoke:conformance` / `bun run smoke`)
 *
 * NON-MUTATING. Requires an authenticated app.copilot.money browser session;
 * without one it fails fast with a clear message (and exit 1) before sending
 * any probe.
 */

import {
  ALL_CONFORMANCE_CHECKS,
  assertEnumConformance,
  getIdToken,
  type EnumConformanceResult,
} from './conformance-checks.js';
import {
  ALL_FIELD_CONFORMANCE_CHECKS,
  assertFieldConformance,
  type FieldConformanceResult,
} from './field-conformance-checks.js';
import { formatClassDistribution } from '../../src/conformance/ledger.js';

type ConformanceResult = EnumConformanceResult | FieldConformanceResult;

async function main(): Promise<void> {
  let idToken: string;
  try {
    idToken = await getIdToken();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      '[smoke] FAIL — could not acquire an authenticated Copilot session, no probes were sent.\n' +
        '        The conformance smoke needs a logged-in app.copilot.money browser session\n' +
        '        on this machine (it is a local pre-merge gate, not a CI job).\n' +
        `        Underlying error: ${message}`
    );
    process.exit(1);
  }

  // Checks run sequentially across surfaces to keep peak concurrency bounded —
  // each check already fires its own values/fields + control in parallel
  // internally.
  const results: ConformanceResult[] = [];
  for (const check of ALL_CONFORMANCE_CHECKS) {
    const result: EnumConformanceResult = await assertEnumConformance({ ...check, idToken });
    results.push(result);
  }
  for (const check of ALL_FIELD_CONFORMANCE_CHECKS) {
    results.push(await assertFieldConformance({ ...check, idToken }));
  }

  // Summary table.
  const width = Math.max(...results.map((r) => r.label.length), 'SURFACE'.length);
  console.error('\n[smoke] Conformance summary:');
  console.error(`  ${'SURFACE'.padEnd(width)}  RESULT`);
  for (const r of results) {
    const status = r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.error(`  ${r.label.padEnd(width)}  ${status}`);
  }

  // Conformance ledger class distribution (issue #435) — the
  // "are we getting better" number, printed pass or fail.
  console.error(`\n${formatClassDistribution()}`);

  const failed = results.filter((r) => r.failures.length > 0);
  if (failed.length > 0) {
    console.error('\n[smoke] FAIL — conformance drift detected:');
    for (const r of failed) {
      for (const f of r.failures) console.error(`  - [${r.label}] ${f}`);
    }
    process.exit(1);
  }

  console.error(
    `\n[smoke] PASS — all ${ALL_CONFORMANCE_CHECKS.length} enums and ` +
      `${ALL_FIELD_CONFORMANCE_CHECKS.length} input types match the server.`
  );
}

main().catch((err: unknown) => {
  console.error('[smoke] FAIL:', err);
  process.exit(1);
});
