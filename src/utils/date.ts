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
      throw new Error(`Unknown period: ${period}`);
  }
}
