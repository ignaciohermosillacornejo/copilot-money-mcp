/**
 * Scheduled Tier-1 drift check (#440), invoked weekly by launchd (see
 * scripts/install-scheduled-smoke.sh). Runs `bun run smoke` — non-mutating
 * conformance only, NEVER the B4 round-trip smokes — and records the outcome
 * where the next dev session can see it (get_connection_status reads the
 * status file via src/utils/scheduled-smoke-status.ts).
 *
 * Outcomes are three-state on purpose: a machine with no Copilot browser
 * session must report `auth-missing`, never `pass` — absence of auth is not
 * absence of drift.
 *
 * On failure: a macOS notification + a dated report file under
 * ~/.claude/copilot-money/smoke-reports/. On pass: silent.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import {
  defaultScheduledSmokeStatusPath,
  type ScheduledSmokeResult,
} from '../src/utils/scheduled-smoke-status.js';

/** Signatures that mean "could not authenticate", not "the API drifted". */
const AUTH_MISSING_PATTERNS = [
  /No Copilot Money session found/i,
  /token exchange failed/i,
  /PROJECT_NUMBER_MISMATCH/,
  /UNAUTHENTICATED/,
  /expired or unauthenticated session/i,
];

export function classifySmokeOutcome(exitCode: number, output: string): ScheduledSmokeResult {
  if (exitCode === 0) return 'pass';
  return AUTH_MISSING_PATTERNS.some((p) => p.test(output)) ? 'auth-missing' : 'fail';
}

/** Last [smoke]/[ledger] line of output — a one-line human summary. */
export function summarizeSmokeOutput(result: ScheduledSmokeResult, output: string): string {
  if (result === 'auth-missing') {
    return 'no Copilot browser session — drift NOT checked (log into app.copilot.money)';
  }
  const lines = output.trim().split('\n');
  const marker = [...lines].reverse().find((l) => l.startsWith('[smoke]'));
  return (marker ?? lines[0] ?? '').slice(0, 300);
}

function notify(title: string, message: string): void {
  // COPILOT_MCP_SMOKE_QUIET suppresses the popup (tests exercise the fail
  // path; they must not spam real notifications).
  if (process.env.COPILOT_MCP_SMOKE_QUIET) return;
  // Best-effort; a failed or hung notification must not mask the status write.
  spawnSync(
    'osascript',
    ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
    { timeout: 10_000 }
  );
}

/** Runs one drift check and returns the process exit code (importable so
 * tests can execute the full flow in-process, where coverage is visible). */
export function runScheduledSmoke(): number {
  const repoDir = process.env.COPILOT_MCP_REPO ?? join(import.meta.dir, '..');
  const statusPath = process.env.COPILOT_MCP_SMOKE_STATUS_PATH ?? defaultScheduledSmokeStatusPath();
  const reportsDir = join(dirname(statusPath), 'smoke-reports');
  mkdirSync(dirname(statusPath), { recursive: true });

  const run = spawnSync(process.execPath, ['run', 'smoke'], {
    cwd: repoDir,
    encoding: 'utf-8',
    timeout: 10 * 60 * 1000,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const exitCode = run.status ?? 1;
  const result = classifySmokeOutcome(exitCode, output);
  const lastRun = new Date().toISOString();

  let report: string | null = null;
  if (result === 'fail') {
    mkdirSync(reportsDir, { recursive: true });
    // Full timestamp so same-day failures (manual kickstarts) never overwrite.
    report = join(reportsDir, `${lastRun.replace(/[:.]/g, '-')}-smoke-failure.txt`);
    writeFileSync(report, output);
    notify(
      'Copilot MCP drift check FAILED',
      `Scheduled smoke found a conformance failure. Report: ${report}`
    );
  }

  writeFileSync(
    statusPath,
    JSON.stringify(
      { last_run: lastRun, result, summary: summarizeSmokeOutput(result, output), report },
      null,
      2
    )
  );

  // launchd treats nonzero exit as job failure; auth-missing is an expected
  // state (machine logged out), recorded in the status file, so exit 0.
  return result === 'fail' ? 1 : 0;
}

if (import.meta.main) process.exit(runScheduledSmoke());
