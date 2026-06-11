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
import { readScheduledSmokeStatus } from '../../src/utils/scheduled-smoke-status.js';

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

  test('returns null on malformed JSON instead of throwing', () => {
    const file = statusFile('not json {');
    expect(readScheduledSmokeStatus(file)).toBeNull();
  });

  test('returns null on JSON with the wrong shape', () => {
    const file = statusFile(JSON.stringify({ something: 'else' }));
    expect(readScheduledSmokeStatus(file)).toBeNull();
  });
});
