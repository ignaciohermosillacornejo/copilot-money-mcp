import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getDecodeTimeoutMs } from '../../src/core/decoder';

describe('getDecodeTimeoutMs', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.DECODE_TIMEOUT_MS;
    delete process.env.DECODE_TIMEOUT_MS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DECODE_TIMEOUT_MS;
    } else {
      process.env.DECODE_TIMEOUT_MS = originalEnv;
    }
  });

  it('returns 90_000 default when env var is not set', () => {
    expect(getDecodeTimeoutMs()).toBe(90_000);
  });

  it('reads valid value from DECODE_TIMEOUT_MS env var', () => {
    process.env.DECODE_TIMEOUT_MS = '60000';
    expect(getDecodeTimeoutMs()).toBe(60_000);
  });

  it('ignores NaN env var, returns default', () => {
    process.env.DECODE_TIMEOUT_MS = 'not-a-number';
    expect(getDecodeTimeoutMs()).toBe(90_000);
  });

  it('ignores zero env var, returns default', () => {
    process.env.DECODE_TIMEOUT_MS = '0';
    expect(getDecodeTimeoutMs()).toBe(90_000);
  });

  it('ignores negative env var, returns default', () => {
    process.env.DECODE_TIMEOUT_MS = '-1000';
    expect(getDecodeTimeoutMs()).toBe(90_000);
  });
});
