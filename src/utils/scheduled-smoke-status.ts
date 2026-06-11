/**
 * Reader for the scheduled drift-check status written by
 * scripts/scheduled-smoke.ts (#440). The launchd job records its last run
 * here so get_connection_status can surface drift-check staleness/failures
 * inside a dev session. Missing or unreadable status is `null` — the tool
 * must never fail because the scheduled job isn't installed.
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const SCHEDULED_SMOKE_RESULTS = ['pass', 'fail', 'auth-missing'] as const;
export type ScheduledSmokeResult = (typeof SCHEDULED_SMOKE_RESULTS)[number];

export interface ScheduledSmokeStatus {
  last_run: string;
  result: ScheduledSmokeResult;
  summary: string;
  /** Dated report file for failures; null for pass/auth-missing. */
  report: string | null;
}

export function defaultScheduledSmokeStatusPath(): string {
  return join(homedir(), '.claude', 'copilot-money', 'scheduled-smoke.json');
}

export function readScheduledSmokeStatus(
  path: string = defaultScheduledSmokeStatusPath()
): ScheduledSmokeStatus | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.last_run !== 'string' ||
    typeof obj.summary !== 'string' ||
    typeof obj.result !== 'string' ||
    !(SCHEDULED_SMOKE_RESULTS as readonly string[]).includes(obj.result)
  ) {
    return null;
  }
  return {
    last_run: obj.last_run,
    result: obj.result as ScheduledSmokeResult,
    summary: obj.summary,
    report: typeof obj.report === 'string' ? obj.report : null,
  };
}
