/**
 * The largest delay `setTimeout` honours. Node clamps anything larger to 1 ms
 * (with a TimeoutOverflowWarning), which would make every decode time out at
 * once, so a larger timeout is refused rather than passed through.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Parse a timeout in milliseconds, as given to `--timeout` or
 * `DECODE_TIMEOUT_MS`: digits only once surrounding whitespace is trimmed (so
 * "5000ms" or "5e3" is refused rather than truncated by parseInt, while a
 * stray space or newline from a shell or config file is not), above 0 and at
 * most MAX_TIMEOUT_MS. Returns undefined for anything else; each caller
 * decides what that means.
 */
export function parseTimeoutMs(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const ms = Number(trimmed);
  return ms > 0 && ms <= MAX_TIMEOUT_MS ? ms : undefined;
}
