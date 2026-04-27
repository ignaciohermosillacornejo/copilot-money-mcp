/**
 * Month-keyed window cache for transaction reads.
 *
 * Transactions are tiered by the age of the month's most recent day:
 *   - min_age ≤ 7d → live (no cache; always refetch)
 *   - 7d < min_age ≤ 21d → warm (1h TTL)
 *   - min_age > 21d → cold (1w TTL)
 *
 * `plan()` decomposes a date range into months and returns
 * (cachedRows, toFetch). The caller fetches missing months and
 * `ingestMonth()`s the results. Write-through patches (upsert/delete)
 * locate the target window by transaction.date.
 *
 * Eviction runs iteratively after each ingest; a single high-volume
 * ingest can push the total well past the cap.
 *
 * See docs/superpowers/specs/2026-04-24-graphql-live-tiered-cache-design.md.
 */

import { monthsCovered, monthAge, type YearMonth } from '../../utils/date.js';
import type { InFlightRegistry } from './in-flight-registry.js';

/** Minimal shape required for cache identity / window placement. */
export interface CachedTransaction {
  id: string;
  date: string; // YYYY-MM-DD
  [key: string]: unknown;
}

export type Tier = 'live' | 'warm' | 'cold';

export interface TransactionWindowCacheOptions {
  liveTtlMs: number; // typically 0 — never cache live tier
  warmTtlMs: number; // e.g. 1h
  coldTtlMs: number; // e.g. 1w
  maxRows: number; // total-row cap before eviction
}

export interface PlanResult<T extends CachedTransaction> {
  cachedRows: T[];
  toFetch: YearMonth[];
}

interface WindowEntry<T extends CachedTransaction> {
  rows: T[];
  fetched_at: number;
}

export class TransactionWindowCache<T extends CachedTransaction = CachedTransaction> {
  private readonly windows = new Map<YearMonth, WindowEntry<T>>();
  private readonly lastAccessed = new Map<YearMonth, number>();

  constructor(
    private readonly opts: TransactionWindowCacheOptions,
    // Stored for Phase 3 forward-compat — when transaction reads migrate
    // onto this cache, the registry will gate concurrent month fetches.
    // Phase 2 ingestMonth is externally driven so the field is unused yet.
    private readonly inflight: InFlightRegistry
  ) {
    // Suppress unused-private-field warning while inflight is forward-compat only.
    void this.inflight;
  }

  tierFor(month: YearMonth, now: Date): Tier {
    const age = monthAge(month, now);
    if (age <= 7) return 'live';
    if (age <= 21) return 'warm';
    return 'cold';
  }

  private ttlFor(tier: Tier): number {
    switch (tier) {
      case 'live':
        return this.opts.liveTtlMs;
      case 'warm':
        return this.opts.warmTtlMs;
      case 'cold':
        return this.opts.coldTtlMs;
    }
  }

  plan(range: { from: string; to: string }, now: Date): PlanResult<T> {
    const months = monthsCovered(range);
    const cachedRows: T[] = [];
    const toFetch: YearMonth[] = [];

    for (const month of months) {
      const tier = this.tierFor(month, now);
      if (tier === 'live') {
        // Live tier: always refetch, never surface cache. Per the spec
        // (§Query resolution), the caller fetches authoritative data and
        // any prior write-through state will be overwritten by ingestMonth.
        toFetch.push(month);
        continue;
      }
      const entry = this.windows.get(month);
      const ttl = this.ttlFor(tier);
      if (entry && Date.now() - entry.fetched_at < ttl) {
        this.lastAccessed.set(month, Date.now());
        for (const row of entry.rows) {
          if (row.date >= range.from && row.date <= range.to) cachedRows.push(row);
        }
      } else {
        toFetch.push(month);
      }
    }

    return { cachedRows, toFetch };
  }

  ingestMonth(month: YearMonth, rows: T[], fetched_at: number): void {
    this.windows.set(month, { rows: [...rows], fetched_at });
    this.lastAccessed.set(month, Date.now());
    this.evictLRU(this.opts.maxRows);
  }

  upsert(tx: T): void {
    const month = tx.date.slice(0, 7);
    // Delete from any other window that holds this id (date-change case).
    for (const [m, entry] of this.windows) {
      if (m === month) continue;
      const idx = entry.rows.findIndex((r) => r.id === tx.id);
      if (idx >= 0) entry.rows.splice(idx, 1);
    }
    const entry = this.windows.get(month);
    if (!entry) return; // no-op for uncached months
    const idx = entry.rows.findIndex((r) => r.id === tx.id);
    if (idx >= 0) entry.rows[idx] = tx;
    else entry.rows.push(tx);
    this.lastAccessed.set(month, Date.now());
  }

  delete(id: string): void {
    for (const entry of this.windows.values()) {
      const idx = entry.rows.findIndex((r) => r.id === id);
      if (idx >= 0) entry.rows.splice(idx, 1);
    }
  }

  invalidate(scope: 'all' | YearMonth[]): void {
    if (scope === 'all') {
      this.windows.clear();
      this.lastAccessed.clear();
      return;
    }
    for (const m of scope) {
      this.windows.delete(m);
      this.lastAccessed.delete(m);
    }
  }

  totalRows(): number {
    let total = 0;
    for (const entry of this.windows.values()) total += entry.rows.length;
    return total;
  }

  hasMonth(month: YearMonth): boolean {
    return this.windows.has(month);
  }

  cachedMonths(): YearMonth[] {
    return Array.from(this.windows.keys());
  }

  entriesForMonth(month: YearMonth): T[] {
    return this.windows.get(month)?.rows ?? [];
  }

  private evictLRU(maxTotalRows: number): void {
    while (this.totalRows() > maxTotalRows) {
      const oldest = this.oldestAccessedMonth();
      if (!oldest) return;
      this.windows.delete(oldest);
      this.lastAccessed.delete(oldest);
    }
  }

  private oldestAccessedMonth(): YearMonth | null {
    let oldestMonth: YearMonth | null = null;
    let oldestTs = Infinity;
    for (const [m, ts] of this.lastAccessed) {
      if (ts < oldestTs) {
        oldestTs = ts;
        oldestMonth = m;
      }
    }
    return oldestMonth;
  }
}
