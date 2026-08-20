/**
 * Scheduled Tier-1 drift check (#440), invoked weekly by launchd (see
 * scripts/install-scheduled-smoke.sh). Runs `bun run smoke` — non-mutating
 * conformance only, NEVER the B4 round-trip smokes — and records the outcome
 * where the next dev session can see it (get_connection_status reads the
 * status file via src/utils/scheduled-smoke-status.ts).
 *
 * Outcomes are four-state on purpose, and the reasoning is the same each time:
 * a state that fires an alarm must be reached by *evidence*, never by
 * fallthrough.
 *
 *   - `auth-missing`: a machine with no Copilot browser session must never
 *     report `pass` — absence of auth is not absence of drift.
 *   - `incomplete`: a run that was killed, could not start, or failed in a way
 *     this runner does not model must never report `fail` — absence of
 *     completion is not presence of drift.
 *   - `fail` therefore requires a drift verdict in the output. It is the one
 *     state that means "Copilot changed their API", so nothing else may
 *     borrow its wording.
 *
 * The `incomplete` state exists because of a real false alarm: a laptop asleep
 * at the scheduled slot had its run frozen mid-flight, burned the 10-minute
 * *wall-clock* budget across sleep cycles, and was SIGTERM'd on the next wake —
 * after every gate inside it had already passed. See
 * docs/bugs/661-non-completion-classified-as-drift.md.
 *
 * On failure or non-completion: a macOS notification + a dated report file
 * under ~/.claude/copilot-money/smoke-reports/. On pass: silent.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import {
  defaultScheduledSmokeStatusPath,
  type ScheduledSmokeResult,
} from '../src/utils/scheduled-smoke-status.js';

/** Wall-clock ceiling for one `bun run smoke` attempt. A healthy run takes
 * ~20s; this is a runaway backstop, not a performance budget. It is wall
 * clock, so system sleep counts against it — hence the retry below. */
const SMOKE_TIMEOUT_MINUTES = 10;

/**
 * The only outputs that mean "the smoke reached a verdict and the verdict was
 * drift". Both are printed by the smoke immediately before it exits nonzero
 * (`scripts/smoke/conformance.ts`, `scripts/smoke/reads.ts`). Requiring one of
 * these is what keeps `fail` from becoming the fallthrough bucket.
 */
export const DRIFT_VERDICT_MARKERS = [
  '[smoke] FAIL — conformance drift detected',
  '[smoke] FAIL — read-surface drift detected',
] as const;

/** Signatures that mean "could not authenticate", not "the API drifted". */
const AUTH_MISSING_PATTERNS = [
  /No Copilot Money session found/i,
  /token exchange failed/i,
  /PROJECT_NUMBER_MISMATCH/,
  /UNAUTHENTICATED/,
  /expired or unauthenticated session/i,
  // The smoke's own wording when it gives up before sending any probe. Its
  // absence from this list is why seven consecutive weekly runs on a
  // logged-out machine were reported as API drift.
  /could not acquire an authenticated Copilot session/i,
];

/**
 * One `bun run smoke` attempt, flattened from `SpawnSyncReturns`.
 *
 * `status` is `null` whenever the child never produced an exit code — killed
 * by a signal, or never spawned at all. The previous version of this runner
 * collapsed that to `status ?? 1` and dropped `signal`/`errorCode` on the
 * floor, which is precisely how a SIGTERM became "conformance failure".
 */
export interface SmokeRunResult {
  /** Child exit code; null when killed by a signal or never started. */
  status: number | null;
  /** Signal that killed the child, if any. */
  signal: NodeJS.Signals | null;
  /** spawnSync's own error code: ETIMEDOUT when the timeout fired, ENOENT when bun is missing. */
  errorCode: string | null;
  /** Combined stdout + stderr. */
  output: string;
}

export function classifySmokeOutcome(run: SmokeRunResult): ScheduledSmokeResult {
  if (run.status === 0) return 'pass';
  // Evidence first: a drift verdict counts even if the run was killed after
  // printing it — the drift was genuinely observed.
  if (DRIFT_VERDICT_MARKERS.some((m) => run.output.includes(m))) return 'fail';
  if (AUTH_MISSING_PATTERNS.some((p) => p.test(run.output))) return 'auth-missing';
  return 'incomplete';
}

/** How an incomplete run ended, in the fewest words that stay actionable. */
function describeTermination(run: SmokeRunResult): string {
  if (run.signal) {
    const cause = run.errorCode === 'ETIMEDOUT' ? ` after the ${SMOKE_TIMEOUT_MINUTES}m timeout` : '';
    return `killed by ${run.signal}${cause}`;
  }
  if (run.errorCode) return `could not run (${run.errorCode})`;
  return `exit ${String(run.status ?? 'unknown')}`;
}

/** One-line human summary of a run, appropriate to its outcome. */
export function summarizeSmokeOutput(result: ScheduledSmokeResult, run: SmokeRunResult): string {
  if (result === 'auth-missing') {
    return 'no Copilot browser session — drift NOT checked (log into app.copilot.money)';
  }
  if (result === 'incomplete') {
    // Never quote the last log line here: a run cut off mid-sentence ends on
    // debris like `[smoke] months_window=1 {`, which reads as a finding.
    return `drift check did not complete — ${describeTermination(run)}; drift NOT checked`.slice(
      0,
      300
    );
  }
  // Track the last *verdict*, not the last prefixed line. The composite smoke
  // ends with the refresh scripts, whose final line is an object-open brace —
  // which is how a clean run once summarized itself as `[smoke] done {`.
  const lines = run.output.trim().split('\n');
  const reversed = [...lines].reverse();
  const verdict = reversed.find((l) => /^\[smoke\] (PASS|FAIL) —/.test(l));
  const marker = verdict ?? reversed.find((l) => l.startsWith('[smoke]'));
  return (marker ?? lines[0] ?? '').slice(0, 300);
}

/** Notification copy per outcome. `fail` is the only one allowed to say drift. */
const ALARMS: Partial<Record<ScheduledSmokeResult, { title: string; describe: string }>> = {
  fail: {
    title: 'Copilot MCP drift check FAILED',
    describe: 'Scheduled smoke found a conformance failure.',
  },
  incomplete: {
    title: 'Copilot MCP drift check DID NOT COMPLETE',
    describe: 'Scheduled smoke was cut off before reaching a verdict; drift was NOT checked.',
  },
};

/** Injection seam so the retry/report/notify flow is testable without spawning. */
export interface ScheduledSmokeDeps {
  /** Runs one `bun run smoke` attempt. */
  spawn: () => SmokeRunResult;
  /** Persists the status record; `output` is non-null when a report should be spilled. */
  write: (status: Record<string, unknown>, output: string | null) => void;
  notify: (title: string, message: string) => void;
}

function defaultSpawn(): SmokeRunResult {
  const repoDir = process.env.COPILOT_MCP_REPO ?? join(import.meta.dir, '..');
  const run = spawnSync(process.execPath, ['run', 'smoke'], {
    cwd: repoDir,
    encoding: 'utf-8',
    timeout: SMOKE_TIMEOUT_MINUTES * 60 * 1000,
  });
  return {
    status: run.status,
    signal: run.signal,
    errorCode: (run.error as NodeJS.ErrnoException | undefined)?.code ?? null,
    output: `${run.stdout ?? ''}${run.stderr ?? ''}`,
  };
}

function defaultWrite(status: Record<string, unknown>, output: string | null): void {
  // The override lives in defaultScheduledSmokeStatusPath(), so reader and
  // writer resolve the same path from the same variable (#638).
  const statusPath = defaultScheduledSmokeStatusPath();
  mkdirSync(dirname(statusPath), { recursive: true });
  const report = status.report;
  if (output !== null && typeof report === 'string') {
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, output);
  }
  writeFileSync(statusPath, JSON.stringify(status, null, 2));
}

function defaultNotify(title: string, message: string): void {
  // COPILOT_MCP_SMOKE_QUIET suppresses the popup (tests exercise the alarm
  // paths; they must not spam real notifications).
  if (process.env.COPILOT_MCP_SMOKE_QUIET) return;
  // Best-effort; a failed or hung notification must not mask the status write.
  spawnSync(
    'osascript',
    ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
    { timeout: 10_000 }
  );
}

/**
 * Runs the drift check and returns the process exit code (importable so tests
 * can execute the full flow in-process, where coverage is visible).
 *
 * A first attempt that never completed is retried once. The observed failure
 * mode is a laptop that slept through its run and SIGTERM'd it on wake — by
 * which point the machine is awake and a ~20s retry simply passes, so the
 * retry converts the common false alarm into a silent pass rather than into
 * better-worded noise.
 */
export function runScheduledSmoke(deps: ScheduledSmokeDeps = DEFAULT_DEPS): number {
  let run = deps.spawn();
  let result = classifySmokeOutcome(run);
  if (result === 'incomplete') {
    run = deps.spawn();
    result = classifySmokeOutcome(run);
  }

  const lastRun = new Date().toISOString();
  const alarm = ALARMS[result];

  let report: string | null = null;
  if (alarm) {
    const reportsDir = join(dirname(defaultScheduledSmokeStatusPath()), 'smoke-reports');
    // Full timestamp so same-day failures (manual kickstarts) never overwrite.
    report = join(reportsDir, `${lastRun.replace(/[:.]/g, '-')}-smoke-failure.txt`);
  }

  deps.write(
    { last_run: lastRun, result, summary: summarizeSmokeOutput(result, run), report },
    alarm ? run.output : null
  );

  if (alarm) deps.notify(alarm.title, `${alarm.describe} Report: ${report ?? 'none'}`);

  // launchd treats nonzero exit as job failure. `auth-missing` is an expected
  // state (machine logged out) recorded in the status file, so it exits 0;
  // `incomplete` survived a retry and means the job did not do its job.
  return alarm ? 1 : 0;
}

const DEFAULT_DEPS: ScheduledSmokeDeps = {
  spawn: defaultSpawn,
  write: defaultWrite,
  notify: defaultNotify,
};

if (import.meta.main) process.exit(runScheduledSmoke());
