/**
 * The one definition of a `YYYY-MM-DD` date field in the cache models (#920).
 *
 * Every date range and bucket in cache mode compares these strings with `<` /
 * `<=`, so a well-formed but impossible day such as `2025-02-30` would sort
 * past the real end of its month and silently fall out of every range that
 * should hold it. Requiring a real calendar day turns that into a counted
 * schema drop (or a repaired nested entry) that decode_health reports. The
 * live row schema uses the same isCalendarDate rule (#917).
 *
 * tests/models/calendar-date-fields.test.ts fails if a model declares a date
 * field by the pattern alone instead of through this helper.
 */

import { z } from 'zod';
import { isCalendarDate } from '../utils/date.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The refinement's message, named in the schema-drop warning. */
export const CALENDAR_DATE_MESSAGE = 'Date must be a day that exists on the calendar';

/** A `YYYY-MM-DD` string that names a day that exists. */
export function calendarDateField(patternMessage = 'Must be YYYY-MM-DD format') {
  return (
    z
      .string()
      .regex(DATE_PATTERN, patternMessage)
      // mutation-guard: a cached date field is a calendar day
      .refine(isCalendarDate, CALENDAR_DATE_MESSAGE)
  );
}
