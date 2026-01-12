/**
 * Unit tests for date utilities.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { parsePeriod, getMonthRange } from '../../src/utils/date.js';

// Mock Date for testing time-dependent functions
let originalDate: typeof Date;
let mockDate: Date;

function setMockDate(dateString: string) {
  mockDate = new originalDate(dateString);

  // @ts-expect-error - Mocking global Date
  global.Date = class extends originalDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(mockDate.getTime());
      } else {
        // @ts-expect-error - Constructor with arguments
        super(...args);
      }
    }

    static now() {
      return mockDate.getTime();
    }
  };
}

function restoreDate() {
  global.Date = originalDate;
}

beforeEach(() => {
  originalDate = Date;
});

afterEach(() => {
  restoreDate();
});

describe('parsePeriod', () => {
  test("parses 'this_month' period", () => {
    setMockDate('2026-01-15T12:00:00Z');
    const [start, end] = parsePeriod('this_month');
    expect(start).toBe('2026-01-01');
    expect(end).toBe('2026-01-31');
  });

  test("parses 'last_month' period", () => {
    setMockDate('2026-01-15T12:00:00Z');
    const [start, end] = parsePeriod('last_month');
    expect(start).toBe('2025-12-01');
    expect(end).toBe('2025-12-31');
  });

  test("parses 'this_year' period", () => {
    setMockDate('2026-01-15T12:00:00Z');
    const [start, end] = parsePeriod('this_year');
    expect(start).toBe('2026-01-01');
    expect(end).toBe('2026-12-31');
  });

  test("parses 'last_year' period", () => {
    setMockDate('2026-01-15T12:00:00Z');
    const [start, end] = parsePeriod('last_year');
    expect(start).toBe('2025-01-01');
    expect(end).toBe('2025-12-31');
  });

  test("parses 'last_7_days' period", () => {
    setMockDate('2026-01-15T12:00:00Z');
    const [start, end] = parsePeriod('last_7_days');
    // Should be 7 days ago to today
    expect(start).toBe('2026-01-08');
    expect(end).toBe('2026-01-15');
  });

  test("parses 'last_30_days' period", () => {
    setMockDate('2026-01-15T12:00:00Z');
    const [start, end] = parsePeriod('last_30_days');
    expect(start).toBe('2025-12-16');
    expect(end).toBe('2026-01-15');
  });

  test("parses 'last_90_days' period", () => {
    setMockDate('2026-01-15T12:00:00Z');
    const [start, end] = parsePeriod('last_90_days');
    expect(start).toBe('2025-10-17');
    expect(end).toBe('2026-01-15');
  });

  test("parses 'ytd' (year to date) period", () => {
    setMockDate('2026-01-15T12:00:00Z');
    const [start, end] = parsePeriod('ytd');
    expect(start).toBe('2026-01-01');
    expect(end).toBe('2026-01-15');
  });

  test('throws error for invalid period', () => {
    expect(() => parsePeriod('invalid_period')).toThrow('Unknown period');
  });

  test('parses last_month when current month is February', () => {
    setMockDate('2026-02-15T12:00:00Z');
    const [start, end] = parsePeriod('last_month');
    expect(start).toBe('2026-01-01');
    expect(end).toBe('2026-01-31');
  });

  test('parses last_month when current month is March', () => {
    setMockDate('2026-03-15T12:00:00Z');
    const [start, end] = parsePeriod('last_month');
    // February 2026 (not a leap year)
    expect(start).toBe('2026-02-01');
    expect(end).toBe('2026-02-28');
  });
});

describe('getMonthRange', () => {
  test('gets range for January', () => {
    const [start, end] = getMonthRange(2026, 1);
    expect(start).toBe('2026-01-01');
    expect(end).toBe('2026-01-31');
  });

  test('gets range for February in non-leap year', () => {
    const [start, end] = getMonthRange(2026, 2);
    expect(start).toBe('2026-02-01');
    expect(end).toBe('2026-02-28');
  });

  test('gets range for February in leap year', () => {
    const [start, end] = getMonthRange(2024, 2);
    expect(start).toBe('2024-02-01');
    expect(end).toBe('2024-02-29');
  });

  test('gets range for December', () => {
    const [start, end] = getMonthRange(2026, 12);
    expect(start).toBe('2026-12-01');
    expect(end).toBe('2026-12-31');
  });

  test('gets range for April (30 days)', () => {
    const [start, end] = getMonthRange(2026, 4);
    expect(start).toBe('2026-04-01');
    expect(end).toBe('2026-04-30');
  });

  test('throws error for invalid month (13)', () => {
    expect(() => getMonthRange(2026, 13)).toThrow();
  });

  test('throws error for invalid month (0)', () => {
    expect(() => getMonthRange(2026, 0)).toThrow();
  });
});
