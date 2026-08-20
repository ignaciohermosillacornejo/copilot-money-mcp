/**
 * Full-flow runs of the scheduled-smoke runner against a stub repo whose
 * `smoke` script produces each outcome. runScheduledSmoke() executes
 * in-process (so coverage sees it); only `bun run smoke` is a subprocess.
 * Exercises outcome classification, status-file write, report write, and
 * exit codes — without touching the network or the real status file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runScheduledSmoke } from '../../scripts/scheduled-smoke.js';

const ENV_KEYS = ['COPILOT_MCP_REPO', 'COPILOT_MCP_SMOKE_STATUS_PATH', 'COPILOT_MCP_SMOKE_QUIET'];
const savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
let dir: string | null = null;

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function runWithStubSmoke(smokeScript: string): {
  exitCode: number;
  status: Record<string, unknown>;
} {
  dir = mkdtempSync(join(tmpdir(), 'sched-smoke-e2e-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { smoke: smokeScript } }));
  const statusPath = join(dir, 'status.json');
  process.env.COPILOT_MCP_REPO = dir;
  process.env.COPILOT_MCP_SMOKE_STATUS_PATH = statusPath;
  process.env.COPILOT_MCP_SMOKE_QUIET = '1';
  const exitCode = runScheduledSmoke();
  let raw: string;
  try {
    raw = readFileSync(statusPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Expected runScheduledSmoke() to write a status file at ${statusPath}, ` +
        `but it could not be read (exitCode=${exitCode}). The runner likely ` +
        `exited before writing status. Underlying error: ${String(err)}`
    );
  }
  let status: Record<string, unknown>;
  try {
    status = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Status file at ${statusPath} is not valid JSON (exitCode=${exitCode}). ` +
        `Contents: ${JSON.stringify(raw)}. Parse error: ${String(err)}`
    );
  }
  return { exitCode, status };
}

describe('scheduled-smoke runner (full flow, stub smoke)', () => {
  test('passing smoke → result pass, no report, exit 0', () => {
    const { exitCode, status } = runWithStubSmoke("echo '[smoke] PASS — synthetic all-clear'");
    expect(exitCode).toBe(0);
    expect(status.result).toBe('pass');
    expect(status.summary).toBe('[smoke] PASS — synthetic all-clear');
    expect(status.report).toBeNull();
    expect(typeof status.last_run).toBe('string');
  });

  // The stub must print a marker the real smoke actually prints. An invented
  // one ("[smoke] FAIL — synthetic drift detected") is how the original suite
  // convinced itself the fail path worked while the wordings the smoke really
  // emits went unmatched — the same mistake as the bug this file guards.
  test('drift verdict → result fail, dated report with full output, exit 1', () => {
    const { exitCode, status } = runWithStubSmoke(
      "echo '[smoke] FAIL — conformance drift detected:' && exit 1"
    );
    expect(exitCode).toBe(1);
    expect(status.result).toBe('fail');
    expect(typeof status.report).toBe('string');
    expect(existsSync(status.report as string)).toBe(true);
    expect(readFileSync(status.report as string, 'utf-8')).toContain('conformance drift detected');
  });

  test('read-surface drift verdict → result fail, exit 1', () => {
    const { exitCode, status } = runWithStubSmoke(
      "echo '[smoke] FAIL — read-surface drift detected:' && exit 1"
    );
    expect(exitCode).toBe(1);
    expect(status.result).toBe('fail');
  });

  test('a nonzero exit with no verdict → result incomplete, not fail', () => {
    const { exitCode, status } = runWithStubSmoke("echo 'error: unmodelled explosion' && exit 1");
    expect(exitCode).toBe(1);
    expect(status.result).toBe('incomplete');
    expect(status.summary).toContain('drift NOT checked');
    // The report is still written — an unexplained non-completion is worth
    // keeping; what changed is that it no longer claims the API drifted.
    expect(existsSync(status.report as string)).toBe(true);
  });

  test('a run killed by a signal → result incomplete, and the runner retried', () => {
    // Each attempt appends a line, so the file length counts real spawns.
    dir = mkdtempSync(join(tmpdir(), 'sched-smoke-e2e-'));
    const attempts = join(dir, 'attempts.log');
    const statusPath = join(dir, 'status.json');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { smoke: `echo x >> ${attempts} && kill -TERM $$` } })
    );
    process.env.COPILOT_MCP_REPO = dir;
    process.env.COPILOT_MCP_SMOKE_STATUS_PATH = statusPath;
    process.env.COPILOT_MCP_SMOKE_QUIET = '1';

    const exitCode = runScheduledSmoke();
    const status = JSON.parse(readFileSync(statusPath, 'utf-8')) as Record<string, unknown>;

    expect(readFileSync(attempts, 'utf-8').trim().split('\n')).toHaveLength(2);
    expect(exitCode).toBe(1);
    expect(status.result).toBe('incomplete');
    expect(status.summary).toContain('drift NOT checked');
  });

  test('auth failure → result auth-missing, no report, exit 0', () => {
    const { exitCode, status } = runWithStubSmoke(
      "echo 'error: No Copilot Money session found. Searched: Chrome' && exit 1"
    );
    expect(exitCode).toBe(0);
    expect(status.result).toBe('auth-missing');
    expect(status.summary).toContain('drift NOT checked');
    expect(status.report).toBeNull();
  });
});
