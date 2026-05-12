/**
 * Uniform pagination + truncation shape for time-series live tools.
 *
 * Live tools can return long row counts (multi-year daily balance / price
 * history) that overflow the MCP single-tool-result token cap. This helper:
 *
 * 1. Clamps `max_rows` to [1, 5000] with a default of 500.
 * 2. Clamps `offset` to >= 0.
 * 3. Slices the most-recent rows (the tail of an ascending-by-time series).
 * 4. Reports `total_rows` (pre-truncation) and `truncated` (whether the
 *    response was capped — i.e., there are older rows the caller did not
 *    receive in this response).
 *
 * Slice math (ascending series):
 *   end   = total - offset
 *   start = max(0, end - effective_max_rows)
 *   rows  = series.slice(start, end)
 *
 * So `offset=0` returns the newest `max_rows` rows (the tail), `offset=500`
 * returns the next-most-recent batch (the 500 rows older than the newest
 * 500), and so on. `offset >= total` produces an empty result without
 * throwing.
 *
 * `truncated` is `true` when there are MORE rows older than what was
 * returned (i.e., `start > 0`, equivalently `total > offset + effective_max`).
 * It is intentionally `false` when `offset + effective_max == total` exactly,
 * because no older rows remain.
 */

/** Default number of rows returned when `max_rows` is not provided. */
export const DEFAULT_MAX_ROWS = 500;
/** Hard upper bound applied after `max_rows` is parsed. */
export const HARD_MAX_ROWS = 5000;
/** Hard lower bound applied after `max_rows` is parsed. */
export const MIN_MAX_ROWS = 1;

export interface PaginationOpts {
  /**
   * Cap on the number of rows returned. Clamped to [1, 5000]; non-finite
   * values fall back to the default. Default: 500.
   */
  max_rows?: number;
  /**
   * Number of rows to skip from the most-recent end. Clamped to >= 0;
   * non-finite values fall back to 0. Default: 0.
   */
  offset?: number;
}

export interface PaginationResult<T> {
  /** The page of rows (sub-slice of the input). */
  rows: T[];
  /** Pre-truncation count of the input series. */
  total_rows: number;
  /** True iff there are older rows the caller did not receive. */
  truncated: boolean;
}

export interface ClampMaxRowsOpts {
  /** Override the upper bound (default HARD_MAX_ROWS = 5000). */
  hardMax?: number;
  /** Override the fallback used when the input is undefined/non-finite (default DEFAULT_MAX_ROWS = 500). */
  defaultValue?: number;
}

/**
 * Clamp `max_rows` to [MIN_MAX_ROWS, hardMax]. Non-finite or omitted values
 * resolve to `defaultValue`. Fractional inputs are floored. Defaults preserve
 * the original behavior (hardMax=5000, defaultValue=500); pass overrides for
 * tools with a different limit shape (e.g. holdings caps at 10000).
 */
export function clampMaxRows(n: number | undefined, opts: ClampMaxRowsOpts = {}): number {
  const hardMax = opts.hardMax ?? HARD_MAX_ROWS;
  const def = opts.defaultValue ?? DEFAULT_MAX_ROWS;
  if (n === undefined) return def;
  if (!Number.isFinite(n)) return def;
  return Math.max(MIN_MAX_ROWS, Math.min(hardMax, Math.floor(n)));
}

/**
 * Clamp `offset` to >= 0. Non-finite or omitted values resolve to 0.
 * Fractional inputs are floored.
 */
export function clampOffset(n: number | undefined): number {
  if (n === undefined) return 0;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

/**
 * Slice the most-recent rows of an ascending-by-time series, applying the
 * shared pagination contract. See module JSDoc for the slice math.
 *
 * Important: the input series MUST already be sorted ascending by time
 * (oldest → newest) for the "most-recent" semantics to hold. Callers should
 * sort before calling.
 */
export function paginate<T>(series: readonly T[], opts: PaginationOpts = {}): PaginationResult<T> {
  const effective_max = clampMaxRows(opts.max_rows);
  const offset = clampOffset(opts.offset);
  const total = series.length;
  const end = Math.max(0, total - offset);
  const start = Math.max(0, end - effective_max);
  const rows = series.slice(start, end);
  // `truncated` is strict — equal totals (offset + max == total) means no
  // older rows remain to fetch.
  return {
    rows,
    total_rows: total,
    truncated: total > offset + effective_max,
  };
}
