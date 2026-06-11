/**
 * End-to-end runs of scripts/scheduled-smoke.ts against a stub repo whose
 * `smoke` script produces each outcome. Exercises main(): subprocess spawn,
 * outcome classification, status-file write, report write, and exit codes —
 * without touching the network or the real status file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const RUNNER = join(import.meta.dir, '../../scripts/scheduled-smoke.ts');

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function runScheduledSmoke(smokeScript: string): {
  exitCode: number;
  status: Record<string, unknown>;
  statusPath: string;
} {
  dir = mkdtempSync(join(tmpdir(), 'sched-smoke-e2e-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { smoke: smokeScript } }));
  const statusPath = join(dir, 'status.json');
  const run = spawnSync(process.execPath, ['run', RUNNER], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      COPILOT_MCP_REPO: dir,
      COPILOT_MCP_SMOKE_STATUS_PATH: statusPath,
      COPILOT_MCP_SMOKE_QUIET: '1',
    },
  });
  return {
    exitCode: run.status ?? -1,
    status: JSON.parse(readFileSync(statusPath, 'utf-8')) as Record<string, unknown>,
    statusPath,
  };
}

describe('scheduled-smoke runner (subprocess e2e)', () => {
  test('passing smoke → result pass, no report, exit 0', () => {
    const { exitCode, status } = runScheduledSmoke("echo '[smoke] PASS — synthetic all-clear'");
    expect(exitCode).toBe(0);
    expect(status.result).toBe('pass');
    expect(status.summary).toBe('[smoke] PASS — synthetic all-clear');
    expect(status.report).toBeNull();
    expect(typeof status.last_run).toBe('string');
  });

  test('failing smoke → result fail, dated report with full output, exit 1', () => {
    const { exitCode, status } = runScheduledSmoke(
      "echo '[smoke] FAIL — synthetic drift detected' && exit 1"
    );
    expect(exitCode).toBe(1);
    expect(status.result).toBe('fail');
    expect(typeof status.report).toBe('string');
    expect(existsSync(status.report as string)).toBe(true);
    expect(readFileSync(status.report as string, 'utf-8')).toContain('synthetic drift detected');
  });

  test('auth failure → result auth-missing, no report, exit 0', () => {
    const { exitCode, status } = runScheduledSmoke(
      "echo 'error: No Copilot Money session found. Searched: Chrome' && exit 1"
    );
    expect(exitCode).toBe(0);
    expect(status.result).toBe('auth-missing');
    expect(status.summary).toContain('drift NOT checked');
    expect(status.report).toBeNull();
  });
});
