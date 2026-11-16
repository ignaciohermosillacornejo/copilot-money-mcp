/**
 * Scheduled-smoke status surfacing (#440): get_connection_status reports the
 * last scheduled drift-check run so a dev session (or the user) can see
 * staleness and failures without hunting for log files. Absence of the file
 * (job never installed / never ran) is `null`, never an error.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SCHEDULED_SMOKE_CHECK_NAME_MAX_CHARS,
  SCHEDULED_SMOKE_NOT_CHECKED_MAX,
  SCHEDULED_SMOKE_REPORT_MAX_CHARS,
  defaultScheduledSmokeStatusPath,
  readScheduledSmokeStatus,
} from '../../src/utils/scheduled-smoke-status.js';

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function statusFile(content: string): string {
  dir = mkdtempSync(join(tmpdir(), 'smoke-status-'));
  const file = join(dir, 'scheduled-smoke.json');
  writeFileSync(file, content);
  return file;
}

describe('readScheduledSmokeStatus', () => {
  test('returns null when the status file does not exist', () => {
    expect(readScheduledSmokeStatus('/nonexistent/path/scheduled-smoke.json')).toBeNull();
  });

  test('parses a valid status file', () => {
    const file = statusFile(
      JSON.stringify({
        last_run: '2026-06-11T10:00:00Z',
        result: 'pass',
        summary: 'all 3 enums and 12 input types match the server',
      })
    );
    expect(readScheduledSmokeStatus(file)).toEqual({
      last_run: '2026-06-11T10:00:00Z',
      result: 'pass',
      summary: 'all 3 enums and 12 input types match the server',
      report: null,
    });
  });

  test('carries the report path on failures', () => {
    const file = statusFile(
      JSON.stringify({
        last_run: '2026-06-11T10:00:00Z',
        result: 'fail',
        summary: '1 surface failed',
        report: '/Users/x/.claude/copilot-money/smoke-reports/2026-06-11.txt',
      })
    );
    expect(readScheduledSmokeStatus(file)?.report).toBe(
      '/Users/x/.claude/copilot-money/smoke-reports/2026-06-11.txt'
    );
  });

  test('auth-missing is a distinct result, not a pass or fail', () => {
    const file = statusFile(
      JSON.stringify({
        last_run: '2026-06-11T10:00:00Z',
        result: 'auth-missing',
        summary: 'no Copilot browser session — drift NOT checked',
      })
    );
    expect(readScheduledSmokeStatus(file)?.result).toBe('auth-missing');
  });

  test('incomplete is a distinct result, not a fail', () => {
    // A run that was killed before reaching a verdict must be readable as its
    // own state; collapsing it into `fail` is what sent a dev session hunting
    // for API drift that had never been observed.
    const file = statusFile(
      JSON.stringify({
        last_run: '2026-08-17T17:41:30Z',
        result: 'incomplete',
        summary: 'drift check did not complete — killed by SIGTERM after the 10m timeout',
      })
    );
    expect(readScheduledSmokeStatus(file)?.result).toBe('incomplete');
  });

  test('a pass that skipped a member says which one (#819)', () => {
    const file = statusFile(
      JSON.stringify({
        last_run: '2026-06-11T10:00:00Z',
        result: 'pass',
        summary: 'drift check passed; NOT checked: account-name parity (SKIP)',
        not_checked: [{ check: 'account-name parity', verdict: 'SKIP' }],
      })
    );
    expect(readScheduledSmokeStatus(file)?.not_checked).toEqual([
      { check: 'account-name parity', verdict: 'SKIP' },
    ]);
  });

  test('omits not_checked when every member was checked, or the writer predates it', () => {
    for (const extra of [{ not_checked: [] }, {}]) {
      const file = statusFile(
        JSON.stringify({ last_run: '2026-06-11T10:00:00Z', result: 'pass', summary: 's', ...extra })
      );
      const status = readScheduledSmokeStatus(file);
      expect(status).not.toBeNull();
      expect(status && 'not_checked' in status && status.not_checked !== undefined).toBe(false);
    }
  });

  test('a malformed not_checked drops the list, not the whole status', () => {
    for (const bogus of [['account-name parity'], [{ check: 'x', verdict: 'INFO' }], 'SKIP']) {
      const file = statusFile(
        JSON.stringify({
          last_run: '2026-06-11T10:00:00Z',
          result: 'pass',
          summary: 's',
          not_checked: bogus,
        })
      );
      const status = readScheduledSmokeStatus(file);
      expect(status?.result).toBe('pass');
      expect(status?.summary).toBe('s');
      expect(status?.not_checked).toBeUndefined();
    }
  });

  test('bounds a hand-edited not_checked list', () => {
    const file = statusFile(
      JSON.stringify({
        last_run: '2026-06-11T10:00:00Z',
        result: 'pass',
        summary: 's',
        not_checked: Array.from({ length: 50 }, () => ({
          check: 'x'.repeat(500),
          verdict: 'WARN',
        })),
      })
    );
    const notChecked = readScheduledSmokeStatus(file)?.not_checked ?? [];
    expect(notChecked.length).toBe(SCHEDULED_SMOKE_NOT_CHECKED_MAX);
    for (const entry of notChecked) {
      expect(entry.check.length).toBe(SCHEDULED_SMOKE_CHECK_NAME_MAX_CHARS);
    }
  });

  test('returns null on malformed JSON instead of throwing', () => {
    const file = statusFile('not json {');
    expect(readScheduledSmokeStatus(file)).toBeNull();
  });

  test('returns null on JSON with the wrong shape', () => {
    const file = statusFile(JSON.stringify({ something: 'else' }));
    expect(readScheduledSmokeStatus(file)).toBeNull();
  });

  test('returns null on an unknown result value (hand-edited file)', () => {
    const file = statusFile(
      JSON.stringify({ last_run: '2026-06-11T10:00:00Z', result: 'unknown', summary: 'x' })
    );
    expect(readScheduledSmokeStatus(file)).toBeNull();
  });
});

describe('report bounding (#638)', () => {
  test('leaves a realistic report path untouched', () => {
    const report = '/Users/x/.claude/copilot-money/smoke-reports/2026-06-11-smoke-failure.txt';
    const file = statusFile(
      JSON.stringify({ last_run: '2026-06-11T10:00:00Z', result: 'fail', summary: 's', report })
    );
    expect(readScheduledSmokeStatus(file)?.report).toBe(report);
  });

  test('truncates an oversized report rather than rejecting the status', () => {
    const file = statusFile(
      JSON.stringify({
        last_run: '2026-06-11T10:00:00Z',
        result: 'fail',
        summary: 's',
        report: 'x'.repeat(SCHEDULED_SMOKE_REPORT_MAX_CHARS * 4),
      })
    );
    const status = readScheduledSmokeStatus(file);
    // Rejecting would drop the whole status, degrading get_connection_status on
    // exactly the machines whose state is most worth reporting.
    expect(status).not.toBeNull();
    expect(status?.report?.length).toBe(SCHEDULED_SMOKE_REPORT_MAX_CHARS);
    expect(status?.report?.endsWith('…')).toBe(true);
  });

  test('keeps a report of exactly the ceiling intact', () => {
    const report = 'x'.repeat(SCHEDULED_SMOKE_REPORT_MAX_CHARS);
    const file = statusFile(
      JSON.stringify({ last_run: '2026-06-11T10:00:00Z', result: 'fail', summary: 's', report })
    );
    expect(readScheduledSmokeStatus(file)?.report).toBe(report);
  });
});

describe('status path resolution (#638)', () => {
  const VAR = 'COPILOT_MCP_SMOKE_STATUS_PATH';

  test('reader and writer resolve the same override', () => {
    const previous = process.env[VAR];
    process.env[VAR] = '/tmp/some-explicit-smoke-status.json';
    try {
      // The writer in scripts/scheduled-smoke.ts calls this same function, so
      // agreement here is agreement on both sides — the asymmetry that left the
      // context-budget ratchet reading real $HOME state.
      expect(defaultScheduledSmokeStatusPath()).toBe('/tmp/some-explicit-smoke-status.json');
    } finally {
      if (previous === undefined) delete process.env[VAR];
      else process.env[VAR] = previous;
    }
  });

  test('falls back to the home-directory path when unset', () => {
    const previous = process.env[VAR];
    delete process.env[VAR];
    try {
      expect(defaultScheduledSmokeStatusPath()).toContain(
        join('.claude', 'copilot-money', 'scheduled-smoke.json')
      );
    } finally {
      if (previous !== undefined) process.env[VAR] = previous;
    }
  });
});
