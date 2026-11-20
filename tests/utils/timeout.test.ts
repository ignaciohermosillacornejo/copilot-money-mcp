/**
 * Unit tests for parseTimeoutMs (src/utils/timeout.ts), the one rule behind
 * both `--timeout` and `DECODE_TIMEOUT_MS`. The MAX_TIMEOUT_MS boundary is
 * pinned on both sides: setTimeout clamps a larger delay to 1 ms, so an
 * off-by-one here turns every decode into an instant timeout.
 */

import { describe, test, expect } from 'bun:test';
import { MAX_TIMEOUT_MS, parseTimeoutMs } from '../../src/utils/timeout.js';

describe('parseTimeoutMs', () => {
  test('MAX_TIMEOUT_MS is the largest delay setTimeout honours (2^31 - 1)', () => {
    expect(MAX_TIMEOUT_MS).toBe(2 ** 31 - 1);
  });

  test('accepts exactly MAX_TIMEOUT_MS', () => {
    expect(parseTimeoutMs(String(MAX_TIMEOUT_MS))).toBe(MAX_TIMEOUT_MS);
  });

  test('refuses MAX_TIMEOUT_MS + 1', () => {
    expect(parseTimeoutMs(String(MAX_TIMEOUT_MS + 1))).toBeUndefined();
  });

  test('refuses 0 and accepts 1', () => {
    expect(parseTimeoutMs('0')).toBeUndefined();
    expect(parseTimeoutMs('1')).toBe(1);
  });

  test('accepts an ordinary value', () => {
    expect(parseTimeoutMs('5000')).toBe(5000);
  });

  test('tolerates surrounding whitespace', () => {
    expect(parseTimeoutMs(' 5000')).toBe(5000);
    expect(parseTimeoutMs('5000\n')).toBe(5000);
    expect(parseTimeoutMs('\t5000 ')).toBe(5000);
  });

  test.each(['', '   ', '5000ms', '5e3', '-5', '+5', '50 00', '5.0', '0x10'])(
    'refuses %p',
    (raw) => {
      expect(parseTimeoutMs(raw)).toBeUndefined();
    }
  );
});
