/**
 * `retryInterrupted` — the bounded reissue for syscalls that failed with an
 * errno whose contract is "try again" (#774).
 *
 * The two directions that matter: an interrupt that clears is invisible to the
 * caller, and one that never clears still surfaces after a FIXED number of
 * attempts rather than spinning. Errors that mean "stop" must not be retried at
 * all — `ENOENT` in particular, because the LevelDB copy loop gives it its own
 * omit-and-continue meaning and a retry would only delay that.
 */

import { describe, test, expect } from 'bun:test';
import {
  retryInterrupted,
  isRetryableErrno,
  RETRYABLE_ERRNOS,
  MAX_INTERRUPT_ATTEMPTS,
} from '../../src/core/fs-retry.js';

function errno(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: synthetic, scandir '/x'`);
  err.code = code;
  return err;
}

/** An op that throws `code` for its first `failures` calls, then returns 'ok'. */
function flaky(code: string, failures: number): { op: () => string; calls: () => number } {
  let calls = 0;
  return {
    op: () => {
      calls++;
      if (calls <= failures) throw errno(code);
      return 'ok';
    },
    calls: () => calls,
  };
}

describe('retryInterrupted', () => {
  test('the bound is small and leaves room to retry at all', () => {
    // A bound of 1 is "no retry"; an unbounded one is a hang. Pin the shape.
    expect(MAX_INTERRUPT_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_INTERRUPT_ATTEMPTS).toBeLessThanOrEqual(10);
  });

  test('an op that succeeds first time is called once', () => {
    const f = flaky('EINTR', 0);
    expect(retryInterrupted(f.op)).toBe('ok');
    expect(f.calls()).toBe(1);
  });

  test.each([...RETRYABLE_ERRNOS])(
    '%s that clears before the bound is reissued until it succeeds',
    (code) => {
      const failures = MAX_INTERRUPT_ATTEMPTS - 1;
      const f = flaky(code, failures);
      expect(retryInterrupted(f.op)).toBe('ok');
      expect(f.calls()).toBe(failures + 1);
    }
  );

  test('an interrupt that never clears throws the interrupt after exactly the bound', () => {
    const f = flaky('EINTR', Number.POSITIVE_INFINITY);
    let thrown: unknown;
    try {
      retryInterrupted(f.op);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as NodeJS.ErrnoException | undefined)?.code).toBe('EINTR');
    expect(f.calls()).toBe(MAX_INTERRUPT_ATTEMPTS);
  });

  test('a caller-supplied bound is honoured', () => {
    const f = flaky('EINTR', Number.POSITIVE_INFINITY);
    expect(() => retryInterrupted(f.op, 2)).toThrow('EINTR');
    expect(f.calls()).toBe(2);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'a bound of %p is refused before the op runs (it would mean no attempt, or no bound)',
    (bound) => {
      const f = flaky('EINTR', Number.POSITIVE_INFINITY);
      expect(() => retryInterrupted(f.op, bound)).toThrow(RangeError);
      expect(f.calls()).toBe(0);
    }
  );

  test.each(['ENOENT', 'EACCES', 'EIO', 'ENOTDIR'])(
    '%s is not retryable and is thrown from the first attempt',
    (code) => {
      const f = flaky(code, Number.POSITIVE_INFINITY);
      expect(() => retryInterrupted(f.op)).toThrow(code);
      expect(f.calls()).toBe(1);
    }
  );

  test('a non-errno error is thrown from the first attempt', () => {
    let calls = 0;
    expect(() =>
      retryInterrupted(() => {
        calls++;
        throw new Error('EINTR in the message is not an errno');
      })
    ).toThrow('not an errno');
    expect(calls).toBe(1);
  });
});

describe('isRetryableErrno', () => {
  test('reads the code, not the message', () => {
    expect(isRetryableErrno(errno('EINTR'))).toBe(true);
    expect(isRetryableErrno(errno('EAGAIN'))).toBe(true);
    expect(isRetryableErrno(errno('ENOENT'))).toBe(false);
    expect(isRetryableErrno(new Error('EINTR'))).toBe(false);
    expect(isRetryableErrno('EINTR')).toBe(false);
    expect(isRetryableErrno(null)).toBe(false);
  });
});
