/**
 * `isAbortOrTimeout` (src/core/abort.ts), the one definition of "this transport
 * error was a timeout or an abort" shared by the GraphQL client and the
 * Firebase token exchange (#802).
 *
 * Its two disjuncts are reached very differently: every request in `src/`
 * carries `AbortSignal.timeout`, so the TimeoutError branch is exercised by the
 * client tests, but nothing in `src/` passes a caller-supplied signal yet, so no
 * other test ever produces an AbortError — deleting that disjunct turned zero
 * tests red (#805). These are built from the runtime's REAL signals rather
 * than hand-made `{ name }` objects, because what the predicate must track is
 * what the runtime throws, and a spelling copied into a fixture would agree
 * with a wrong predicate.
 */
import { describe, expect, test } from 'bun:test';
import { isAbortOrTimeout } from '../../src/core/abort.js';

/** What `fetch` rejects with when `signal` fires: the signal's reason. */
async function reasonOf(signal: AbortSignal): Promise<unknown> {
  if (!signal.aborted) await new Promise((r) => signal.addEventListener('abort', r));
  return signal.reason;
}

describe('isAbortOrTimeout', () => {
  test('an explicit abort — the AbortError branch', async () => {
    const controller = new AbortController();
    controller.abort();
    const reason = await reasonOf(controller.signal);
    // Pinned as the premise, so a runtime that changes the name fails here
    // with a message about the runtime, not about the predicate.
    expect((reason as Error).name).toBe('AbortError');
    expect(isAbortOrTimeout(reason)).toBe(true);
  });

  test('a fired AbortSignal.timeout — the TimeoutError branch', async () => {
    const reason = await reasonOf(AbortSignal.timeout(1));
    expect((reason as Error).name).toBe('TimeoutError');
    expect(isAbortOrTimeout(reason)).toBe(true);
  });

  test('a real fetch aborted by its signal is recognised end to end', async () => {
    // The shape callers actually catch: fetch's own rejection, not the reason
    // read off the signal. No network — the signal is aborted before the call.
    const controller = new AbortController();
    controller.abort();
    const err = await fetch('http://127.0.0.1:9/', { signal: controller.signal }).catch(
      (e: unknown) => e
    );
    expect(isAbortOrTimeout(err)).toBe(true);
  });

  test('other errors, and non-Errors carrying the name, are not', () => {
    expect(isAbortOrTimeout(new Error('ECONNRESET'))).toBe(false);
    expect(isAbortOrTimeout(new TypeError('fetch failed'))).toBe(false);
    // The `instanceof Error` half: a plain object spelled like one is not one.
    expect(isAbortOrTimeout({ name: 'AbortError' })).toBe(false);
    expect(isAbortOrTimeout('TimeoutError')).toBe(false);
    expect(isAbortOrTimeout(undefined)).toBe(false);
  });
});
