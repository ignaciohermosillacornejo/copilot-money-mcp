/**
 * Tier-0 read smoke runner (issues #439/#460, Epic B #421).
 *
 * Fires every GraphQL QUERY operation in operations.generated.ts against the
 * LIVE Copilot endpoint (one shared session) via the checks defined in
 * read-checks.ts, prints a per-operation PASS/SKIP/FAIL summary, and exits
 * non-zero if any operation drifted from the server.
 *
 * Run: `bun run scripts/smoke/reads.ts`
 *      (or `bun run smoke:reads`; `bun run smoke` runs conformance + reads)
 *
 * READS ONLY — nothing here mutates. Requires an authenticated
 * app.copilot.money browser session; without one it fails fast with a clear
 * message (and exit 1) before sending any request. Output logs counts only,
 * never names or amounts (PII rules per CLAUDE.md).
 */

import { FirebaseAuth } from '../../src/core/auth/firebase-auth.js';
import { extractRefreshToken } from '../../src/core/auth/browser-token.js';
import { GraphQLClient } from '../../src/core/graphql/client.js';
import { READ_SMOKE_CHECKS, type ReadSmokeState } from './read-checks.js';

interface ReadSmokeResult {
  operation: string;
  status: 'PASS' | 'SKIP' | 'FAIL';
  detail?: string;
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
  const auth = new FirebaseAuth(() => extractRefreshToken());
  try {
    await auth.getIdToken();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      '[smoke] FAIL — could not acquire an authenticated Copilot session, no reads were sent.\n' +
        '        The read smoke needs a logged-in app.copilot.money browser session\n' +
        '        on this machine (it is a local pre-merge gate, not a CI job).\n' +
        `        Underlying error: ${message}`
    );
    process.exit(1);
  }
  const client = new GraphQLClient(auth);

  // Sequential on purpose: later checks consume ids discovered by earlier
  // ones, and one-at-a-time keeps the load on Copilot's API polite.
  const state: ReadSmokeState = {};
  const results: ReadSmokeResult[] = [];
  for (const check of READ_SMOKE_CHECKS) {
    try {
      const outcome = await check.run({ client, state, log });
      if (outcome?.skipped) {
        results.push({ operation: check.operation, status: 'SKIP', detail: outcome.skipped });
      } else {
        results.push({ operation: check.operation, status: 'PASS' });
      }
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ operation: check.operation, status: 'FAIL', detail });
    }
  }

  // Summary table.
  const width = Math.max(...results.map((r) => r.operation.length), 'OPERATION'.length);
  console.error('\n[smoke] Read smoke summary:');
  console.error(`  ${'OPERATION'.padEnd(width)}  RESULT`);
  for (const r of results) {
    const suffix = r.status === 'SKIP' && r.detail ? `  (${r.detail})` : '';
    console.error(`  ${r.operation.padEnd(width)}  ${r.status}${suffix}`);
  }

  const failed = results.filter((r) => r.status === 'FAIL');
  if (failed.length > 0) {
    console.error('\n[smoke] FAIL — read-surface drift detected:');
    for (const r of failed) console.error(`  - [${r.operation}] ${r.detail ?? 'unknown error'}`);
    process.exit(1);
  }

  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.error(
    `\n[smoke] PASS — ${results.length - skipped}/${READ_SMOKE_CHECKS.length} read operations ` +
      `verified against the server${skipped > 0 ? ` (${skipped} skipped)` : ''}.`
  );
}

main().catch((err: unknown) => {
  console.error('[smoke] FAIL:', err);
  process.exit(1);
});
