/**
 * Reader for the scheduled drift-check status written by
 * scripts/scheduled-smoke.ts (#440). The launchd job records its last run
 * here so get_connection_status can surface drift-check staleness/failures
 * inside a dev session. Missing or unreadable status is `null` — the tool
 * must never fail because the scheduled job isn't installed.
 *
 * Reader and writer resolve the path identically through
 * `defaultScheduledSmokeStatusPath()`, so `COPILOT_MCP_SMOKE_STATUS_PATH` is
 * one knob rather than a writer-only override (#638). Without that symmetry a
 * test had no seam to point the reader at a fixture, which is why the
 * context-budget ratchet was reading real `$HOME` state.
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';

export const SCHEDULED_SMOKE_RESULTS = ['pass', 'fail', 'auth-missing'] as const;
export type ScheduledSmokeResult = (typeof SCHEDULED_SMOKE_RESULTS)[number];

/**
 * Ceiling for `report` as surfaced by the reader. Comfortably above the ~80
 * chars a real report path occupies, small enough that a pathological writer
 * cannot push `get_connection_status` off its context budget.
 */
export const SCHEDULED_SMOKE_REPORT_MAX_CHARS = 256;

/** Bound `report` on read; the ellipsis marks that truncation occurred. */
function truncateReport(value: string | null): string | null {
  if (value === null || value.length <= SCHEDULED_SMOKE_REPORT_MAX_CHARS) return value;
  return `${value.slice(0, SCHEDULED_SMOKE_REPORT_MAX_CHARS - 1)}…`;
}

const ScheduledSmokeStatusSchema = z.object({
  last_run: z.string(),
  result: z.enum(SCHEDULED_SMOKE_RESULTS),
  summary: z.string(),
  /**
   * Path to a dated report file for failures; null for pass/auth-missing.
   *
   * The intended payload is a *path*, not report contents. That intent is only
   * a convention, because this reader does not control who writes the file, so
   * the value is truncated on read to keep `get_connection_status` inside its
   * context budget regardless of the writer (#638).
   *
   * Truncating rather than rejecting is deliberate: a `z.string().max()` would
   * turn an oversized file into a parse failure, degrading the tool on exactly
   * the machines whose status is most worth reporting.
   */
  report: z
    .string()
    .nullable()
    .optional()
    .transform((v) => truncateReport(v ?? null)),
});

export type ScheduledSmokeStatus = z.infer<typeof ScheduledSmokeStatusSchema>;

export function defaultScheduledSmokeStatusPath(): string {
  return (
    process.env.COPILOT_MCP_SMOKE_STATUS_PATH ??
    join(homedir(), '.claude', 'copilot-money', 'scheduled-smoke.json')
  );
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
