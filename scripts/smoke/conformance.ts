/**
 * Conformance smoke runner (issue #421).
 *
 * Runs every enum-conformance check (RecurringFrequency, RecurringState,
 * TransactionType) against the LIVE Copilot GraphQL endpoint, using one shared
 * id token, then prints a per-enum PASS/FAIL summary table and exits non-zero if
 * any enum drifted from the server.
 *
 * Run: `bun run scripts/smoke/conformance.ts`
 *      (or `bun run smoke:conformance` / `bun run smoke`)
 *
 * NON-MUTATING. Requires an authenticated app.copilot.money browser session.
 */

import {
  ALL_CONFORMANCE_CHECKS,
  assertEnumConformance,
  getIdToken,
  type EnumConformanceResult,
} from './conformance-checks.js';
import { formatClassDistribution } from '../../src/conformance/ledger.js';

async function main(): Promise<void> {
  const idToken = await getIdToken();

  // Checks run sequentially across enums to keep peak concurrency bounded —
  // each check already fires its own values + control in parallel internally.
  const results: EnumConformanceResult[] = [];
  for (const check of ALL_CONFORMANCE_CHECKS) {
    const result = await assertEnumConformance({ ...check, idToken });
    results.push(result);
  }

  // Summary table.
  const width = Math.max(...results.map((r) => r.label.length), 'ENUM'.length);
  console.error('\n[smoke] Conformance summary:');
  console.error(`  ${'ENUM'.padEnd(width)}  RESULT`);
  for (const r of results) {
    const status = r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.error(`  ${r.label.padEnd(width)}  ${status}`);
  }

  // Conformance ledger class distribution (issue #435) — the
  // "are we getting better" number, printed pass or fail.
  console.error(`\n${formatClassDistribution()}`);

  const failed = results.filter((r) => r.failures.length > 0);
  if (failed.length > 0) {
    console.error('\n[smoke] FAIL — enum drift detected:');
    for (const r of failed) {
      for (const f of r.failures) console.error(`  - [${r.label}] ${f}`);
    }
    process.exit(1);
  }

  console.error(`\n[smoke] PASS — all ${results.length} enums match the server.`);
}

main().catch((err: unknown) => {
  console.error('[smoke] FAIL:', err);
  process.exit(1);
});
