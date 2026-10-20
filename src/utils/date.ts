/**
 * Date utilities for parsing periods and date ranges.
 */

/**
 * Format a Date object as "YYYY-MM-DD".
 */
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * True when `value` is `YYYY-MM-DD` AND names a day that exists on the
 * calendar — `2026-02-30`, `2026-04-31` and `2026-13-01` are well-formed but
 * false (#825). Computed in UTC so the answer never depends on the host's
 * time zone or DST.
 */
export function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  // Day 0 of the next month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDay;
}

/**
 * Validate an optional read-filter date (`start_date`, `end_date`, ...): it
 * must be `YYYY-MM-DD` and a day that exists (#825). One function and one
 * message per failure for every read tool in both modes, so `2026-02-30` is
 * refused the same way everywhere instead of matching nothing (cache) or
 * reaching the server (live).
 */
export function validateDateArg(date: string | undefined, paramName: string): string | undefined {
  if (date === undefined) return undefined;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid ${paramName} format. Expected YYYY-MM-DD, got: ${String(date)}`);
  }
  if (!isCalendarDate(date)) {
    throw new Error(`Invalid ${paramName}: ${date} is not a real calendar date`);
  }
  return date;
}

/** True when `value` is `YYYY-MM` with a month from 01 to 12 (#825). */
export function isCalendarMonth(value: string): boolean {
  const m = /^\d{4}-(\d{2})$/.exec(value);
  if (!m) return false;
  const month = Number(m[1]);
  return month >= 1 && month <= 12;
}

/**
 * Get the date range for a specific month.
 */
export function getMonthRange(year: number, month: number): [string, string] {
  if (month < 1 || month > 12) {
    throw new Error(`Month must be between 1 and 12, got ${month}`);
  }

  // Get the last day of the month
  const lastDay = new Date(year, month, 0).getDate();

  const start = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-01`;
  const end = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${lastDay.toString().padStart(2, '0')}`;

  return [start, end];
}

/**
 * Every period parsePeriod accepts, in the order its error and the tool
 * descriptions list them (the descriptions are built from this list).
 */
export const PERIODS = [
  'this_month',
  'last_month',
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'ytd',
  'this_year',
  'last_year',
] as const;

/**
 * Parse a period string into (start_date, end_date).
 *
 * Supported periods:
 * - "this_month", "last_month"
 * - "this_year", "last_year"
 * - "last_7_days", "last_30_days", "last_90_days"
 * - "ytd" (year to date)
 *
 * @returns Tuple of [start_date, end_date] as "YYYY-MM-DD" strings
 * @throws Error if period is not recognized
 */
export function parsePeriod(period: string): [string, string] {
  const today = new Date();

  switch (period) {
    case 'this_month': {
      const year = today.getFullYear();
      const month = today.getMonth() + 1; // JavaScript months are 0-indexed
      return getMonthRange(year, month);
    }

    case 'last_month': {
      // Calculate previous month
      const firstDayThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      const lastDayLastMonth = new Date(firstDayThisMonth.getTime() - 24 * 60 * 60 * 1000);
      const year = lastDayLastMonth.getFullYear();
      const month = lastDayLastMonth.getMonth() + 1;
      return getMonthRange(year, month);
    }

    case 'this_year': {
      const year = today.getFullYear();
      const start = `${year}-01-01`;
      const end = `${year}-12-31`;
      return [start, end];
    }

    case 'last_year': {
      const year = today.getFullYear() - 1;
      const start = `${year}-01-01`;
      const end = `${year}-12-31`;
      return [start, end];
    }

    case 'last_7_days': {
      const start = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
      return [formatDate(start), formatDate(today)];
    }

    case 'last_30_days': {
      const start = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
      return [formatDate(start), formatDate(today)];
    }

    case 'last_90_days': {
      const start = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
      return [formatDate(start), formatDate(today)];
    }

    case 'ytd': {
      // Year to date: from Jan 1 to today
      const start = `${today.getFullYear()}-01-01`;
      const end = formatDate(today);
      return [start, end];
    }

    default:
      throw new Error(`Unknown period: ${period}. Valid periods: ${PERIODS.join(', ')}.`);
  }
}

/**
 * A YYYY-MM string used as a window-cache key.
 */
export type YearMonth = string;

export interface DateRangeArg {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

/**
 * Enumerate every calendar month overlapped by the inclusive
 * [from, to] range, in chronological order. Inputs are YYYY-MM-DD.
 */
export function monthsCovered(range: DateRangeArg): YearMonth[] {
  const startYear = Number(range.from.slice(0, 4));
  const startMonth = Number(range.from.slice(5, 7));
  const endYear = Number(range.to.slice(0, 4));
  const endMonth = Number(range.to.slice(5, 7));

  const months: YearMonth[] = [];
  let y = startYear;
  let m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    months.push(`${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

/**
 * Age in whole days of the most recent day of the given YYYY-MM month
 * relative to `now`. Clamped at 0 — current and future months return 0.
 *
 * Used by TransactionWindowCache to resolve a month into one of the
 * tier classes (live ≤14d / cold >14d). Computed in UTC so the tier
 * classification is timezone-invariant: a month with `now - last_day`
 * of exactly 14.0 days produces the same tier in every TZ.
 */
export function monthAge(month: YearMonth, now: Date): number {
  const year = Number(month.slice(0, 4));
  const monthNum = Number(month.slice(5, 7));
  // Last day of the month at UTC midnight: day 0 of next month in UTC.
  const lastDayUtcMs = Date.UTC(year, monthNum, 0);
  // `now` projected to UTC midnight on its calendar date — strips intra-day
  // hours so age is measured in whole calendar days, regardless of host TZ.
  const nowUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ageMs = nowUtcMs - lastDayUtcMs;
  if (ageMs <= 0) return 0;
  return Math.floor(ageMs / (24 * 60 * 60 * 1000));
}
