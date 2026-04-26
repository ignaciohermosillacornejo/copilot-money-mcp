/**
 * Single-flight guard for cache loaders.
 *
 * Multiple simultaneous callers requesting the same key share one
 * underlying loader invocation. The promise is removed from the
 * registry on settlement (either success or failure) so subsequent
 * callers start a fresh invocation.
 *
 * Critical contract: callers MUST populate their cache inside the
 * loader closure, not after `await run()` returns. See
 * docs/superpowers/specs/2026-04-24-graphql-live-tiered-cache-design.md
 * §"InFlightRegistry — concurrent-call safety" for the microtask-race
 * rationale.
 */
export class InFlightRegistry {
  private readonly promises = new Map<string, Promise<unknown>>();

  async run<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const existing = this.promises.get(key);
    if (existing) return existing as Promise<T>;
    const promise = loader().finally(() => {
      this.promises.delete(key);
    });
    this.promises.set(key, promise);
    return promise;
  }
}
