/**
 * Month-keyed window cache for transaction reads.
 *
 * Transactions are tiered by the age of the month's most recent day:
 *   - min_age ≤ 14d → live (no cache; always refetch)
 *   - min_age > 14d → cold (1w TTL)
 *
 * The 14-day boundary captures the meaningful Plaid-sync drift window
 * (recent merchants are still posting late charges) without the
 * complexity of a separate warm tier.
 *
 * `plan()` decomposes a date range into months and returns
 * (cachedRows, toFetch). The caller fetches missing months and
 * `ingestMonth()`s the results. Write-through patches (upsert/delete)
 * locate the target window by transaction.date.
 *
 * Eviction runs iteratively after each ingest; a single high-volume
 * ingest can push the total well past the cap.
 *
 * See docs/superpowers/specs/2026-05-01-graphql-live-tx-windowed-cache-design.md.
 */

import { monthsCovered, monthAge, type YearMonth } from '../../utils/date.js';
import type { InFlightRegistry } from './in-flight-registry.js';

/** Minimal shape required for cache identity / window placement. */
export interface CachedTransaction {
  id: string;
  date: string; // YYYY-MM-DD
}

export type Tier = 'live' | 'cold';

export interface TransactionWindowCacheOptions {
  liveTtlMs: number; // typically 0 — never cache live tier
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
  // Running row count maintained by every mutation. Avoids the previous
  // O(n²) loop where evictLRU recomputed totalRows() on each iteration.
  private _totalRows = 0;

  constructor(
    private readonly opts: TransactionWindowCacheOptions,
    // Held for compatibility with the constructor signature and to express
    // the intent that this cache is part of an InFlightRegistry-coordinated
    // system. Coalescing actually happens at the call site in
    // LiveCopilotDatabase.getTransactions; the cache itself is externally
    // driven via ingestMonth, so the field is unused INSIDE this class.
    private readonly inflight: InFlightRegistry
  ) {
    // Suppress unused-private-field warning while inflight is forward-compat only.
    void this.inflight;
  }

  tierFor(month: YearMonth, now: Date): Tier {
    const age = monthAge(month, now);
    if (age <= 14) return 'live';
    return 'cold';
  }

  private ttlFor(tier: Tier): number {
    switch (tier) {
      case 'live':
        return this.opts.liveTtlMs;
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
      if (entry && now.getTime() - entry.fetched_at < ttl) {
        this.lastAccessed.set(month, now.getTime());
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
    const existing = this.windows.get(month);
    if (existing) this._totalRows -= existing.rows.length;
    const cloned = [...rows];
    this.windows.set(month, { rows: cloned, fetched_at });
    this._totalRows += cloned.length;
    this.lastAccessed.set(month, Date.now());
    this.evictLRU(this.opts.maxRows);
  }

  upsert(tx: T): void {
    const month = tx.date.slice(0, 7);
    // Cross-window removal happens unconditionally — if the row moved
    // from a cached month into an uncached month, the old entry is
    // still removed even though the new window won't be created
    // (insert below is a no-op when target month isn't cached).
    for (const [m, entry] of this.windows) {
      if (m === month) continue;
      const idx = entry.rows.findIndex((r) => r.id === tx.id);
      if (idx >= 0) {
        entry.rows.splice(idx, 1);
        this._totalRows -= 1;
        break; // ids are unique across windows; first match is the only match
      }
    }
    const entry = this.windows.get(month);
    if (!entry) return; // no-op for uncached target months
    const idx = entry.rows.findIndex((r) => r.id === tx.id);
    if (idx >= 0) {
      entry.rows[idx] = tx;
    } else {
      entry.rows.push(tx);
      this._totalRows += 1;
    }
    this.lastAccessed.set(month, Date.now());
  }

  delete(id: string): void {
    for (const entry of this.windows.values()) {
      const idx = entry.rows.findIndex((r) => r.id === id);
      if (idx >= 0) {
        entry.rows.splice(idx, 1);
        this._totalRows -= 1;
        break; // ids are unique across windows
      }
    }
  }

  invalidate(scope: 'all' | YearMonth[]): void {
    if (scope === 'all') {
      this.windows.clear();
      this.lastAccessed.clear();
      this._totalRows = 0;
      return;
    }
    for (const m of scope) {
      const entry = this.windows.get(m);
      if (entry) this._totalRows -= entry.rows.length;
      this.windows.delete(m);
      this.lastAccessed.delete(m);
    }
  }

  totalRows(): number {
    // O(1) — maintained as a running counter on every mutation. See
    // ingestMonth/upsert/delete/invalidate/evictLRU.
    return this._totalRows;
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

  getFetchedAt(month: YearMonth): number | undefined {
    return this.windows.get(month)?.fetched_at;
  }

  private evictLRU(maxTotalRows: number): void {
    while (this._totalRows > maxTotalRows) {
      const oldest = this.oldestAccessedMonth();
      if (!oldest) return;
      const entry = this.windows.get(oldest);
      if (entry) this._totalRows -= entry.rows.length;
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
