/**
 * Flat-snapshot cache for small entities (accounts, categories, tags,
 * budgets, recurring). One snapshot per entity, configurable TTL,
 * write-through patches via upsert/delete.
 *
 * The cache write happens INSIDE the loader closure passed to
 * InFlightRegistry.run() so cache-population happens-before registry
 * cleanup. See spec §"InFlightRegistry — concurrent-call safety".
 */

import type { InFlightRegistry } from './in-flight-registry.js';

export interface SnapshotCacheOptions<T> {
  /** Stable key used for InFlightRegistry deduplication (e.g., "accounts"). */
  key: string;
  /** Time-to-live in milliseconds. */
  ttlMs: number;
  /** Stable identity for upsert/delete patches. */
  keyFn: (row: T) => string;
}

export interface SnapshotReadResult<T> {
  rows: T[];
  fetched_at: number;
  /**
   * true iff this caller's `read()` returned synchronously from the
   * fresh-cache branch (TTL not expired). false in three cases:
   *   - first-time miss: caller triggered the loader and the fetch
   *   - TTL-expired refetch: caller triggered the loader for fresh data
   *   - in-flight coalescer: caller joined another caller's pending
   *     loader via InFlightRegistry. The coalescer does NOT issue a
   *     network call itself — but we still mark `hit: false` because
   *     the response data was network-derived this turn (just not by
   *     this caller). The semantic is "data was network-fresh this
   *     turn", not "this specific caller paid network cost".
   */
  hit: boolean;
}

interface Entry<T> {
  rows: T[];
  fetched_at: number;
}

export class SnapshotCache<T> {
  private entry: Entry<T> | null = null;

  constructor(
    private readonly opts: SnapshotCacheOptions<T>,
    private readonly inflight: InFlightRegistry
  ) {}

  async read(loader: () => Promise<T[]>): Promise<SnapshotReadResult<T>> {
    if (this.entry && Date.now() - this.entry.fetched_at < this.opts.ttlMs) {
      return { rows: this.entry.rows, fetched_at: this.entry.fetched_at, hit: true };
    }

    const result = await this.inflight.run(this.opts.key, async () => {
      const rows = await loader();
      // Cache write happens-before the loader's returned promise resolves,
      // ensuring it precedes the InFlightRegistry's .finally() cleanup.
      // This also guards against a concurrent invalidate() racing between
      // awaits — the local `entry` is captured before any external code runs.
      const entry: Entry<T> = { rows, fetched_at: Date.now() };
      this.entry = entry;
      return entry;
    });

    return { rows: result.rows, fetched_at: result.fetched_at, hit: false };
  }

  upsert(row: T): void {
    if (!this.entry) return;
    const id = this.opts.keyFn(row);
    const idx = this.entry.rows.findIndex((r) => this.opts.keyFn(r) === id);
    if (idx >= 0) {
      this.entry.rows[idx] = row;
    } else {
      this.entry.rows.push(row);
    }
  }

  delete(key: string): void {
    if (!this.entry) return;
    this.entry.rows = this.entry.rows.filter((r) => this.opts.keyFn(r) !== key);
  }

  invalidate(): void {
    this.entry = null;
  }

  /**
   * Synchronous read of currently-cached rows. Returns undefined if the cache
   * is empty (never populated or invalidated). Does NOT trigger a fetch and
   * does NOT check TTL — used by write-through patches that need to merge
   * against the current cached value.
   */
  peek(): T[] | undefined {
    return this.entry?.rows;
  }
}
