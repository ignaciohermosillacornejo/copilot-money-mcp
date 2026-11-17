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

/**
 * `fail` is reserved for a drift verdict the smoke actually printed;
 * `incomplete` covers every run that never reached a verdict (killed, timed
 * out, crashed unmodelled). Keeping them distinct is what stops a frozen
 * laptop from reading as an API change — see
 * `docs/bugs/661-non-completion-classified-as-drift.md`.
 */
export const SCHEDULED_SMOKE_RESULTS = ['pass', 'fail', 'auth-missing', 'incomplete'] as const;
export type ScheduledSmokeResult = (typeof SCHEDULED_SMOKE_RESULTS)[number];

/**
 * Ceiling for `report` as surfaced by the reader. Comfortably above the ~80
 * chars a real report path occupies, small enough that a pathological writer
 * cannot push `get_connection_status` off its context budget.
 */
export const SCHEDULED_SMOKE_REPORT_MAX_CHARS = 256;

/** Bound a string on read; the ellipsis marks that truncation occurred. */
function truncateTo(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function truncateReport(value: string | null): string | null {
  return value === null ? null : truncateTo(value, SCHEDULED_SMOKE_REPORT_MAX_CHARS);
}

/**
 * Bounds for `not_checked` as surfaced by the reader. The writer records at
 * most one entry per registered skip marker (a handful); these ceilings only
 * matter for a hand-edited or foreign file, same reasoning as `report`. The
 * count must stay at or above `SKIP_MARKERS.length` in scripts/scheduled-smoke.ts
 * (tests/scripts/scheduled-smoke.test.ts enforces it), or a run that skipped
 * every member would surface with some of them silently dropped.
 */
export const SCHEDULED_SMOKE_NOT_CHECKED_MAX = 6;
export const SCHEDULED_SMOKE_CHECK_NAME_MAX_CHARS = 32;

/**
 * A member of the smoke composite that exited 0 without a real comparison:
 * `SKIP` compared nothing (e.g. no local cache), `WARN` compared but could not
 * discriminate. Neither is drift, and neither is a check that passed (#819).
 */
const NotCheckedSchema = z.object({
  check: z.string().transform((v) => truncateTo(v, SCHEDULED_SMOKE_CHECK_NAME_MAX_CHARS)),
  verdict: z.enum(['SKIP', 'WARN']),
});

export type ScheduledSmokeNotChecked = z.infer<typeof NotCheckedSchema>;

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
  /**
   * Composite members that did not really check anything this run (written
   * only for a passing run). Omitted
   * when empty (and from files written before #819), so a fully checked run
   * costs `get_connection_status` nothing.
   */
  // `.catch`: a malformed or future-shaped list (a verdict word this reader
  // does not know) drops the list, not the whole status, which would read as
  // "the job is not installed". Same reasoning as truncating `report`.
  not_checked: z
    .array(NotCheckedSchema)
    .optional()
    .catch(undefined)
    .transform((v) =>
      v === undefined || v.length === 0 ? undefined : v.slice(0, SCHEDULED_SMOKE_NOT_CHECKED_MAX)
    ),
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
