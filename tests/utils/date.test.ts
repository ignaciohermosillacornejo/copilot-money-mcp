/**
 * Unit tests for date utilities.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { parsePeriod, getMonthRange, monthsCovered, monthAge } from '../../src/utils/date.js';

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
    setMockDate('2025-01-15T12:00:00Z');
    const [start, end] = parsePeriod('this_month');
    expect(start).toBe('2025-01-01');
    expect(end).toBe('2025-01-31');
  });

  test("parses 'last_month' period", () => {
    setMockDate('2025-01-15T12:00:00Z');
    const [start, end] = parsePeriod('last_month');
    expect(start).toBe('2024-12-01');
    expect(end).toBe('2024-12-31');
  });

  test("parses 'this_year' period", () => {
    setMockDate('2025-01-15T12:00:00Z');
    const [start, end] = parsePeriod('this_year');
    expect(start).toBe('2025-01-01');
    expect(end).toBe('2025-12-31');
  });

  test("parses 'last_year' period", () => {
    setMockDate('2025-01-15T12:00:00Z');
    const [start, end] = parsePeriod('last_year');
    expect(start).toBe('2024-01-01');
    expect(end).toBe('2024-12-31');
  });

  test("parses 'last_7_days' period", () => {
    setMockDate('2025-01-15T12:00:00Z');
    const [start, end] = parsePeriod('last_7_days');
    // Should be 7 days ago to today
    expect(start).toBe('2025-01-08');
    expect(end).toBe('2025-01-15');
  });

  test("parses 'last_30_days' period", () => {
    setMockDate('2025-01-15T12:00:00Z');
    const [start, end] = parsePeriod('last_30_days');
    expect(start).toBe('2024-12-16');
    expect(end).toBe('2025-01-15');
  });

  test("parses 'last_90_days' period", () => {
    setMockDate('2025-01-15T12:00:00Z');
    const [start, end] = parsePeriod('last_90_days');
    expect(start).toBe('2024-10-17');
    expect(end).toBe('2025-01-15');
  });

  test("parses 'ytd' (year to date) period", () => {
    setMockDate('2025-01-15T12:00:00Z');
    const [start, end] = parsePeriod('ytd');
    expect(start).toBe('2025-01-01');
    expect(end).toBe('2025-01-15');
  });

  test('throws error for invalid period', () => {
    expect(() => parsePeriod('invalid_period')).toThrow('Unknown period');
  });

  test('parses last_month when current month is February', () => {
    setMockDate('2025-02-15T12:00:00Z');
    const [start, end] = parsePeriod('last_month');
    expect(start).toBe('2025-01-01');
    expect(end).toBe('2025-01-31');
  });

  test('parses last_month when current month is March', () => {
    setMockDate('2025-03-15T12:00:00Z');
    const [start, end] = parsePeriod('last_month');
    // February 2025 (not a leap year)
    expect(start).toBe('2025-02-01');
    expect(end).toBe('2025-02-28');
  });
});

describe('getMonthRange', () => {
  test('gets range for January', () => {
    const [start, end] = getMonthRange(2025, 1);
    expect(start).toBe('2025-01-01');
    expect(end).toBe('2025-01-31');
  });

  test('gets range for February in non-leap year', () => {
    const [start, end] = getMonthRange(2025, 2);
    expect(start).toBe('2025-02-01');
    expect(end).toBe('2025-02-28');
  });

  test('gets range for February in leap year', () => {
    const [start, end] = getMonthRange(2024, 2);
    expect(start).toBe('2024-02-01');
    expect(end).toBe('2024-02-29');
  });

  test('gets range for December', () => {
    const [start, end] = getMonthRange(2025, 12);
    expect(start).toBe('2025-12-01');
    expect(end).toBe('2025-12-31');
  });

  test('gets range for April (30 days)', () => {
    const [start, end] = getMonthRange(2025, 4);
    expect(start).toBe('2025-04-01');
    expect(end).toBe('2025-04-30');
  });

  test('throws error for invalid month (13)', () => {
    expect(() => getMonthRange(2025, 13)).toThrow();
  });

  test('throws error for invalid month (0)', () => {
    expect(() => getMonthRange(2025, 0)).toThrow();
  });
});

describe('monthsCovered', () => {
  test('single-month range returns one entry', () => {
    expect(monthsCovered({ from: '2026-04-05', to: '2026-04-20' })).toEqual(['2026-04']);
  });

  test('multi-month range enumerates all covered months', () => {
    expect(monthsCovered({ from: '2026-02-15', to: '2026-04-15' })).toEqual([
      '2026-02',
      '2026-03',
      '2026-04',
    ]);
  });

  test('range across a year boundary', () => {
    expect(monthsCovered({ from: '2025-11-15', to: '2026-02-10' })).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });

  test('start === end is single month', () => {
    expect(monthsCovered({ from: '2026-04-15', to: '2026-04-15' })).toEqual(['2026-04']);
  });
});

describe('monthAge', () => {
  test('current month → 0 days', () => {
    expect(monthAge('2026-04', new Date('2026-04-15'))).toBe(0);
  });

  test('previous month → days from end of that month', () => {
    // 2026-03-31 is 15 days before 2026-04-15
    expect(monthAge('2026-03', new Date('2026-04-15'))).toBe(15);
  });

  test('two months ago → ~46 days', () => {
    // 2026-02-28 is 46 days before 2026-04-15 (non-leap year 2026)
    expect(monthAge('2026-02', new Date('2026-04-15'))).toBe(46);
  });

  test('future month → 0 days (clamped)', () => {
    expect(monthAge('2026-05', new Date('2026-04-15'))).toBe(0);
  });

  test('year-boundary previous month', () => {
    // 2025-12-31 is 5 days before 2026-01-05
    expect(monthAge('2025-12', new Date('2026-01-05'))).toBe(5);
  });

  test('multi-year staleness math handles intervening leap years', () => {
    // 2024 is a leap year (Feb 29); 2024-01-31 → 2026-04-15 = 805 days.
    expect(monthAge('2024-01', new Date('2026-04-15'))).toBe(805);
  });

  test('age is timezone-invariant when now is parsed from YYYY-MM-DD', () => {
    // `new Date('2026-04-15')` is parsed as UTC midnight; the helper must
    // not let the host TZ shift the day count. Run-time TZ stash + restore.
    const originalTZ = process.env.TZ;
    try {
      process.env.TZ = 'America/Vancouver'; // UTC-7/8
      expect(monthAge('2026-03', new Date('2026-04-15'))).toBe(15);
      expect(monthAge('2026-02', new Date('2026-04-15'))).toBe(46);

      process.env.TZ = 'Pacific/Auckland'; // UTC+12/13
      expect(monthAge('2026-03', new Date('2026-04-15'))).toBe(15);
      expect(monthAge('2026-02', new Date('2026-04-15'))).toBe(46);
    } finally {
      if (originalTZ === undefined) delete process.env.TZ;
      else process.env.TZ = originalTZ;
    }
  });
});
