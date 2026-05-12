import { describe, expect, test } from 'bun:test';
import {
  paginate,
  clampMaxRows,
  clampOffset,
  DEFAULT_MAX_ROWS,
  HARD_MAX_ROWS,
  MIN_MAX_ROWS,
} from '../../src/utils/pagination.js';

// 10-row ascending series; the "newest" rows are at the tail.
const small = Array.from({ length: 10 }, (_, i) => i);

// 1500-row ascending series; long enough to exercise default/cap behavior.
const big = Array.from({ length: 1500 }, (_, i) => i);

describe('paginate — default behavior', () => {
  test('omitting both args returns newest DEFAULT_MAX_ROWS rows', () => {
    const r = paginate(big);
    expect(r.rows.length).toBe(DEFAULT_MAX_ROWS);
    expect(r.total_rows).toBe(1500);
    expect(r.truncated).toBe(true);
    // tail of ascending series — newest rows
    expect(r.rows[0]).toBe(1500 - DEFAULT_MAX_ROWS);
    expect(r.rows[r.rows.length - 1]).toBe(1499);
  });

  test('series smaller than max_rows returns all rows, truncated=false', () => {
    const r = paginate(small);
    expect(r.rows).toEqual(small);
    expect(r.total_rows).toBe(10);
    expect(r.truncated).toBe(false);
  });

  test('empty input series → empty rows, total=0, truncated=false', () => {
    const r = paginate<number>([]);
    expect(r.rows).toEqual([]);
    expect(r.total_rows).toBe(0);
    expect(r.truncated).toBe(false);
  });
});

describe('paginate — truncation flag', () => {
  test('total > max_rows → truncated=true', () => {
    const r = paginate(big, { max_rows: 500 });
    expect(r.truncated).toBe(true);
  });

  test('total <= max_rows → truncated=false', () => {
    const r = paginate(small, { max_rows: 50 });
    expect(r.truncated).toBe(false);
  });

  test('boundary: total == max_rows exactly → truncated=false', () => {
    const r = paginate(small, { max_rows: 10 });
    expect(r.rows).toEqual(small);
    expect(r.truncated).toBe(false);
  });

  test('boundary: offset + max_rows == total exactly → truncated=false (no older rows remain)', () => {
    // 10 rows, max=5, offset=5 → returns rows[0..5) (the older half).
    // total > offset + max  →  10 > 5 + 5  →  false.
    const r = paginate(small, { max_rows: 5, offset: 5 });
    expect(r.rows).toEqual([0, 1, 2, 3, 4]);
    expect(r.truncated).toBe(false);
  });
});

describe('paginate — clamping', () => {
  test('max_rows above HARD_MAX_ROWS is clamped down', () => {
    const r = paginate(big, { max_rows: 100_000 });
    expect(r.rows.length).toBe(Math.min(big.length, HARD_MAX_ROWS));
  });

  test('max_rows below MIN_MAX_ROWS is clamped up to 1', () => {
    const r = paginate(small, { max_rows: 0 });
    expect(r.rows.length).toBe(MIN_MAX_ROWS);
    expect(r.rows[0]).toBe(9); // most-recent
    expect(r.truncated).toBe(true);
  });

  test('negative max_rows is clamped up to 1', () => {
    const r = paginate(small, { max_rows: -100 });
    expect(r.rows.length).toBe(MIN_MAX_ROWS);
  });

  test('negative offset is clamped to 0', () => {
    const r = paginate(small, { max_rows: 3, offset: -50 });
    // offset 0 means newest-3 — i.e., [7, 8, 9]
    expect(r.rows).toEqual([7, 8, 9]);
  });

  test('non-finite max_rows falls back to default', () => {
    const r = paginate(big, { max_rows: Number.NaN });
    expect(r.rows.length).toBe(DEFAULT_MAX_ROWS);
  });

  test('non-finite offset falls back to 0', () => {
    const r = paginate(small, { max_rows: 3, offset: Number.NaN });
    expect(r.rows).toEqual([7, 8, 9]);
  });

  test('fractional max_rows is floored', () => {
    expect(clampMaxRows(3.9)).toBe(3);
  });

  test('fractional offset is floored', () => {
    expect(clampOffset(2.9)).toBe(2);
  });
});

describe('paginate — offset semantics (counts from the end)', () => {
  test('offset=0 returns the newest max_rows rows', () => {
    const r = paginate(small, { max_rows: 3, offset: 0 });
    expect(r.rows).toEqual([7, 8, 9]);
  });

  test('offset=max_rows returns the next-most-recent batch', () => {
    const r = paginate(small, { max_rows: 3, offset: 3 });
    expect(r.rows).toEqual([4, 5, 6]);
    // total > offset + max  →  10 > 3 + 3  →  truncated=true (older rows remain)
    expect(r.truncated).toBe(true);
  });

  test('walking offset eventually drains the series', () => {
    const page1 = paginate(small, { max_rows: 3, offset: 0 });
    const page2 = paginate(small, { max_rows: 3, offset: 3 });
    const page3 = paginate(small, { max_rows: 3, offset: 6 });
    // last page: 10 - 6 = 4 rows remain at the head (indices 0..3)
    // start = max(0, 4 - 3) = 1, end = 4 → rows[1..4) = [1, 2, 3]
    expect(page1.rows).toEqual([7, 8, 9]);
    expect(page2.rows).toEqual([4, 5, 6]);
    expect(page3.rows).toEqual([1, 2, 3]);
    expect(page3.truncated).toBe(true);
  });

  test('offset beyond total returns empty rows, truncated=false', () => {
    const r = paginate(small, { max_rows: 3, offset: 100 });
    expect(r.rows).toEqual([]);
    expect(r.total_rows).toBe(10);
    expect(r.truncated).toBe(false);
  });

  test('offset exactly at total returns empty rows', () => {
    const r = paginate(small, { max_rows: 3, offset: 10 });
    expect(r.rows).toEqual([]);
    expect(r.total_rows).toBe(10);
  });
});

describe('clampMaxRows — override paths', () => {
  test('defaultValue override is used when input is undefined', () => {
    expect(clampMaxRows(undefined, { defaultValue: 100 })).toBe(100);
  });

  test('defaultValue override is used when input is non-finite', () => {
    expect(clampMaxRows(Number.NaN, { defaultValue: 50 })).toBe(50);
    expect(clampMaxRows(Number.POSITIVE_INFINITY, { defaultValue: 50 })).toBe(50);
  });

  test('hardMax override caps inputs above its value', () => {
    expect(clampMaxRows(20_000, { hardMax: 10_000 })).toBe(10_000);
  });

  test('hardMax override accepts values at and below its value', () => {
    expect(clampMaxRows(10_000, { hardMax: 10_000 })).toBe(10_000);
    expect(clampMaxRows(7_500, { hardMax: 10_000 })).toBe(7_500);
  });

  test('MIN_MAX_ROWS floor still applies under override', () => {
    expect(clampMaxRows(0, { hardMax: 10_000, defaultValue: 100 })).toBe(MIN_MAX_ROWS);
    expect(clampMaxRows(-5, { hardMax: 10_000, defaultValue: 100 })).toBe(MIN_MAX_ROWS);
  });

  test('default hardMax / defaultValue still applies when not overridden', () => {
    expect(clampMaxRows(undefined)).toBe(DEFAULT_MAX_ROWS);
    expect(clampMaxRows(100_000)).toBe(HARD_MAX_ROWS);
  });
});

describe('paginate — slicing math', () => {
  test('big series, max=500, offset=0 → tail (indices 1000..1499)', () => {
    const r = paginate(big, { max_rows: 500, offset: 0 });
    expect(r.rows[0]).toBe(1000);
    expect(r.rows[499]).toBe(1499);
  });

  test('big series, max=500, offset=500 → indices 500..999', () => {
    const r = paginate(big, { max_rows: 500, offset: 500 });
    expect(r.rows[0]).toBe(500);
    expect(r.rows[499]).toBe(999);
  });

  test('partial last page: 10 rows, max=4, offset=8 → only 2 rows remain at head', () => {
    // end = 10 - 8 = 2, start = max(0, 2 - 4) = 0 → rows[0..2)
    const r = paginate(small, { max_rows: 4, offset: 8 });
    expect(r.rows).toEqual([0, 1]);
    expect(r.truncated).toBe(false);
  });
});
