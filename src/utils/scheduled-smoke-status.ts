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
import { z } from 'zod';

export const SCHEDULED_SMOKE_RESULTS = ['pass', 'fail', 'auth-missing'] as const;
export type ScheduledSmokeResult = (typeof SCHEDULED_SMOKE_RESULTS)[number];

const ScheduledSmokeStatusSchema = z.object({
  last_run: z.string(),
  result: z.enum(SCHEDULED_SMOKE_RESULTS),
  summary: z.string(),
  /** Dated report file for failures; null for pass/auth-missing. */
  report: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
});

export type ScheduledSmokeStatus = z.infer<typeof ScheduledSmokeStatusSchema>;

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
  const result = ScheduledSmokeStatusSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
