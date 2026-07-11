/**
 * Tier-2 reversible round-trip smoke runner (issue #438, Epic B #421).
 *
 * !!! MUTATING !!! Sends real writes to the LIVE Copilot endpoint. This is
 * a local, consciously-run, ATTENDED gate:
 *   - never scheduled, never part of `bun run smoke` (Tier 1 stays
 *     non-mutating),
 *   - refuses to start if marker residue from a prior run exists,
 *   - guaranteed cleanup (LIFO, in `finally`) plus a final sweep that fails
 *     loudly with the leftover ids if anything survived.
 *
 * Run:  bun run smoke:roundtrip            (all 17 write tools)
 *       bun run smoke:roundtrip -- --only tags
 *       bun run smoke:roundtrip -- --list  (print the plan, no auth, no writes)
 *
 * Requires an authenticated app.copilot.money browser session; without one
 * it fails fast before sending anything. Output logs marker-bearing
 * synthetic names and opaque ids only — never real names or amounts
 * (PII rules per CLAUDE.md).
 */

import { FirebaseAuth } from '../../src/core/auth/firebase-auth.js';
import { extractRefreshTokenCandidates } from '../../src/core/auth/browser-token.js';
import { GraphQLClient } from '../../src/core/graphql/client.js';
import { getResponseDriftStats } from '../../src/core/graphql/response-validation.js';
import {
  ROUNDTRIP_CHECKS,
  CleanupRegistry,
  buildResidueReaders,
  collectResidue,
  formatPlan,
  makeMarker,
  parseRoundtripArgs,
  type CleanupFailure,
  type ResidueRecord,
  type RoundtripContext,
} from './roundtrip-checks.js';

interface RoundtripResult {
  tool: string;
  status: 'PASS' | 'SKIP' | 'FAIL';
  detail?: string;
}

function log(msg: string, fields?: Record<string, unknown>): void {
  const prefix = `[roundtrip] ${msg}`;
  if (fields) {
    console.error(prefix, fields);
  } else {
    console.error(prefix);
  }
}

function printResidue(header: string, residue: readonly ResidueRecord[]): void {
  console.error(`\n[roundtrip] ${header}`);
  for (const r of residue) {
    console.error(`  - ${r.kind} id=${r.id} name='${r.name}'`);
  }
}

async function main(): Promise<void> {
  let args;
  try {
    args = parseRoundtripArgs(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(`[roundtrip] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const checks = args.only
    ? ROUNDTRIP_CHECKS.filter((check) => check.domain === args.only)
    : ROUNDTRIP_CHECKS;

  if (args.list) {
    console.error(formatPlan(checks));
    console.error('\n[roundtrip] --list mode: no auth performed, no requests sent.');
    return;
  }

  console.error(
    '[roundtrip] !!! MUTATING SMOKE !!! — this run creates, edits, and deletes real\n' +
      '            objects (marker-named, synthetic amounts) against the LIVE Copilot\n' +
      '            account. Watch the per-step output below.\n'
  );
  console.error(formatPlan(checks));
  console.error('');

  const auth = new FirebaseAuth(() => extractRefreshTokenCandidates());
  try {
    await auth.getIdToken();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      '[roundtrip] FAIL — could not acquire an authenticated Copilot session, no writes were sent.\n' +
        '        The round-trip smoke needs a logged-in app.copilot.money browser session\n' +
        '        on this machine (it is a local attended gate, not a CI job).\n' +
        `        Underlying error: ${message}`
    );
    process.exit(1);
  }
  const client = new GraphQLClient(auth);
  const readers = buildResidueReaders(client);

  // Pre-flight: refuse to start when a prior run left marker objects behind —
  // a second run on top of residue makes the final sweep unattributable.
  const preexisting = await collectResidue(readers);
  if (preexisting.length > 0) {
    printResidue(
      'FAIL — pre-flight found marker residue from a prior run; refusing to start.\n' +
        '        Delete these objects (Copilot UI or delete tools), then re-run:',
      preexisting
    );
    process.exit(1);
  }
  log('pre-flight: no marker residue found — starting');

  const ctx: RoundtripContext = {
    client,
    state: { marker: makeMarker() },
    registry: new CleanupRegistry(),
    log,
  };
  log(`run marker: ${ctx.state.marker}`);

  const results: RoundtripResult[] = [];
  let cleanupFailures: CleanupFailure[] = [];
  let sweepResidue: ResidueRecord[] = [];
  try {
    // Sequential on purpose: later checks consume objects created by earlier
    // ones, and one mutation at a time is what the maintainer can follow live.
    for (const [index, check] of checks.entries()) {
      log(`${String(index + 1)}/${String(checks.length)} ${check.tool} — ${check.flow}`);
      try {
        const outcome = await check.run(ctx);
        if (outcome?.skipped) {
          results.push({ tool: check.tool, status: 'SKIP', detail: outcome.skipped });
          log(`${check.tool}: SKIP (${outcome.skipped})`);
        } else {
          results.push({ tool: check.tool, status: 'PASS' });
          log(`${check.tool}: PASS`);
        }
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        results.push({ tool: check.tool, status: 'FAIL', detail });
        log(`${check.tool}: FAIL — ${detail}`);
      }
    }
  } finally {
    // Guaranteed cleanup of everything the run still owns, then a final
    // sweep re-querying the server for ANY marker-bearing object.
    log(`cleanup: ${String(ctx.registry.pending.length)} object(s) still registered`);
    cleanupFailures = await ctx.registry.runAll(log);
    sweepResidue = await collectResidue(readers);
  }

  // Summary.
  const width = Math.max(...results.map((r) => r.tool.length), 'TOOL'.length);
  console.error('\n[roundtrip] Round-trip summary:');
  console.error(`  ${'TOOL'.padEnd(width)}  RESULT`);
  for (const r of results) {
    const suffix = r.status !== 'PASS' && r.detail ? `  (${r.detail})` : '';
    console.error(`  ${r.tool.padEnd(width)}  ${r.status}${suffix}`);
  }

  // B3 response-shape drift counters come for free on every mutation this
  // run sent (warn-mode — informational here, never a failure by itself).
  const drift = getResponseDriftStats();
  const driftEntries = Object.entries(drift);
  if (driftEntries.length > 0) {
    console.error('\n[roundtrip] Response-shape drift counters (B3 zod-warn, warn-mode):');
    for (const [surface, count] of driftEntries) {
      console.error(`  ${surface}: ${String(count)}`);
    }
  } else {
    console.error('\n[roundtrip] Response-shape drift counters (B3 zod-warn): none');
  }

  let failed = false;
  const failures = results.filter((r) => r.status === 'FAIL');
  if (failures.length > 0) {
    failed = true;
    console.error('\n[roundtrip] FAIL — round-trip drift detected:');
    for (const r of failures) console.error(`  - [${r.tool}] ${r.detail ?? 'unknown error'}`);
  }
  if (cleanupFailures.length > 0) {
    failed = true;
    console.error('\n[roundtrip] FAIL — cleanup could not delete these objects:');
    for (const f of cleanupFailures) {
      console.error(`  - ${f.kind} id=${f.id} name='${f.label}': ${f.error}`);
    }
  }
  if (sweepResidue.length > 0) {
    failed = true;
    printResidue(
      'FAIL — final sweep found leftover marker objects; delete them manually:',
      sweepResidue
    );
  } else {
    console.error('\n[roundtrip] final sweep: zero marker residue — cleanup verified.');
  }

  if (failed) process.exit(1);

  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.error(
    `\n[roundtrip] PASS — ${String(results.length - skipped)}/${String(checks.length)} write ` +
      `round-trips verified against the server${skipped > 0 ? ` (${String(skipped)} skipped)` : ''}.`
  );
}

main().catch((err: unknown) => {
  console.error('[roundtrip] FAIL:', err);
  process.exit(1);
});
