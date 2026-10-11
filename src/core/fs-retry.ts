/**
 * Bounded reissue for syscalls interrupted by a retryable errno (#774).
 *
 * `EINTR` says a syscall was interrupted by a signal before it did its work
 * and should be reissued; it is not a failure. Node's (and Bun's) synchronous
 * `fs` functions surface it as a thrown error instead of retrying, so the retry
 * has to be ours. Measured against the live Copilot container during #756:
 * ~1 `readdirSync` in 1,000 blocked for seconds and then threw `EINTR`, and the
 * snapshot copy hit the same errno on `copyFileSync` under concurrent load.
 *
 * `EAGAIN` is included for the same contract ("resource temporarily
 * unavailable — try again"). It is not expected from blocking calls on regular
 * files, but when it does appear it carries the same meaning, and the bound
 * makes treating it as retryable cost at most a few reissues.
 *
 * The reissue is immediate. An interrupt is not back-pressure; there is nothing
 * to wait out, and these call sites are synchronous so a sleep would block the
 * event loop. The bound exists so that a pathological storm still surfaces as
 * the original error instead of a hang.
 *
 * Every retryable synchronous fs call in `src/` goes through `retryInterrupted`
 * as `retryInterrupted(() => fs.op(...))`; `tests/no-unretried-fs-syscalls.test.ts`
 * enforces that shape.
 */

/** Errnos whose contract is "reissue me", not "stop". */
export const RETRYABLE_ERRNOS: ReadonlySet<string> = new Set(['EINTR', 'EAGAIN']);

/** Total attempts, including the first, before the interrupt is rethrown. */
export const MAX_INTERRUPT_ATTEMPTS = 5;

/** True when `err` is an errno-shaped error whose code is retryable. */
export function isRetryableErrno(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && RETRYABLE_ERRNOS.has(code);
}

/**
 * Run `op`, reissuing it while it throws a retryable errno, up to
 * `maxAttempts` attempts in total. Any other error — and the last retryable
 * one — is rethrown unchanged, so callers' own `code` checks (`ENOENT` and
 * friends) keep working exactly as before.
 */
export function retryInterrupted<T>(op: () => T, maxAttempts = MAX_INTERRUPT_ATTEMPTS): T {
  // `attempt >= maxAttempts` is never true for NaN or Infinity, so either would
  // make a permanent interrupt spin forever, the one hang the bound exists to
  // prevent; and below 1 there would be no attempt at all.
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(
      `retryInterrupted: maxAttempts must be a positive integer, got ${maxAttempts}`
    );
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return op();
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryableErrno(err)) throw err;
    }
  }
}
