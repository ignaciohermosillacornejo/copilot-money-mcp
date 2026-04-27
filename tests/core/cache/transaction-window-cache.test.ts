import { describe, expect, test } from 'bun:test';
import { InFlightRegistry } from '../../../src/core/cache/in-flight-registry.js';
import {
  TransactionWindowCache,
  type CachedTransaction,
} from '../../../src/core/cache/transaction-window-cache.js';

const mkTx = (id: string, date: string): CachedTransaction => ({
  id,
  date,
  amount: 10,
  name: `tx-${id}`,
});

const makeCache = () =>
  new TransactionWindowCache(
    {
      liveTtlMs: 0, // never cache live tier
      warmTtlMs: 60 * 60 * 1000, // 1h
      coldTtlMs: 7 * 24 * 60 * 60 * 1000, // 1w
      maxRows: 1000,
    },
    new InFlightRegistry()
  );

describe('TransactionWindowCache.tierFor', () => {
  const today = new Date('2026-04-15');

  test('current month → live', () => {
    const cache = makeCache();
    expect(cache.tierFor('2026-04', today)).toBe('live');
  });

  test('previous month with min_age in (7, 21] → warm', () => {
    const cache = makeCache();
    expect(cache.tierFor('2026-03', today)).toBe('warm'); // 15d
  });

  test('two months ago → cold', () => {
    const cache = makeCache();
    expect(cache.tierFor('2026-02', today)).toBe('cold'); // 46d
  });

  test('future month → live (clamped)', () => {
    const cache = makeCache();
    expect(cache.tierFor('2026-05', today)).toBe('live');
  });
});

describe('TransactionWindowCache.plan', () => {
  const today = new Date('2026-04-15');

  test('all months absent from cache → all in toFetch', () => {
    const cache = makeCache();
    const result = cache.plan({ from: '2026-02-01', to: '2026-04-15' }, today);
    expect(result.toFetch).toEqual(['2026-02', '2026-03', '2026-04']);
    expect(result.cachedRows).toEqual([]);
  });

  test('cached fresh months are pulled; live month is always in toFetch', () => {
    const cache = makeCache();
    cache.ingestMonth('2026-02', [mkTx('a', '2026-02-10')], Date.now());
    cache.ingestMonth('2026-03', [mkTx('b', '2026-03-20')], Date.now());

    const result = cache.plan({ from: '2026-02-01', to: '2026-04-15' }, today);
    expect(result.toFetch).toEqual(['2026-04']);
    expect(result.cachedRows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  test('stale cold-tier month is in toFetch', () => {
    const cache = makeCache();
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    cache.ingestMonth('2026-02', [mkTx('a', '2026-02-10')], eightDaysAgo);

    const result = cache.plan({ from: '2026-02-01', to: '2026-02-28' }, today);
    expect(result.toFetch).toEqual(['2026-02']);
  });

  test('live-tier month never surfaces cached rows even if ingested', () => {
    // Spec contract: live tier = always refetch, never surface cache.
    // Caller is responsible for ingesting fresh results; old cache state
    // for a live month is not optimistically returned.
    const cache = makeCache();
    cache.ingestMonth('2026-04', [mkTx('a', '2026-04-10')], Date.now());

    const result = cache.plan({ from: '2026-04-01', to: '2026-04-30' }, today);
    expect(result.toFetch).toEqual(['2026-04']);
    expect(result.cachedRows).toEqual([]);
  });

  test('cachedRows are sliced to the requested range', () => {
    const cache = makeCache();
    cache.ingestMonth('2026-03', [mkTx('a', '2026-03-05'), mkTx('b', '2026-03-25')], Date.now());

    const result = cache.plan({ from: '2026-03-10', to: '2026-03-31' }, today);
    expect(result.cachedRows.map((r) => r.id)).toEqual(['b']);
  });
});

describe('TransactionWindowCache write-through', () => {
  test('upsert into existing cached month replaces in place', () => {
    const cache = makeCache();
    cache.ingestMonth('2026-03', [mkTx('a', '2026-03-10')], Date.now());

    cache.upsert({ ...mkTx('a', '2026-03-10'), name: 'updated' });

    const result = cache.plan({ from: '2026-03-01', to: '2026-03-31' }, new Date('2026-04-15'));
    expect(result.cachedRows[0]?.name).toBe('updated');
  });

  test('upsert into uncached month is a no-op', () => {
    const cache = makeCache();
    expect(() => cache.upsert(mkTx('a', '2026-03-10'))).not.toThrow();

    const result = cache.plan({ from: '2026-03-01', to: '2026-03-31' }, new Date('2026-04-15'));
    expect(result.cachedRows).toEqual([]);
    expect(result.toFetch).toEqual(['2026-03']);
  });

  test('upsert with date change moves the row across windows', () => {
    const cache = makeCache();
    cache.ingestMonth('2026-03', [mkTx('a', '2026-03-10')], Date.now());
    cache.ingestMonth('2026-04', [], Date.now());

    cache.upsert({ ...mkTx('a', '2026-04-05'), name: 'moved' });

    // Inspect window state directly — `plan()` would filter the April
    // entry via the live-tier rule, which is unrelated to the move.
    expect(cache.entriesForMonth('2026-03')).toEqual([]);
    expect(cache.entriesForMonth('2026-04').map((r) => r.id)).toEqual(['a']);
    expect(cache.entriesForMonth('2026-04')[0]?.name).toBe('moved');
  });

  test('delete removes the row from its window', () => {
    const cache = makeCache();
    cache.ingestMonth('2026-03', [mkTx('a', '2026-03-10')], Date.now());

    cache.delete('a');

    const result = cache.plan({ from: '2026-03-01', to: '2026-03-31' }, new Date('2026-04-15'));
    expect(result.cachedRows).toEqual([]);
  });
});

describe('TransactionWindowCache.evictLRU', () => {
  test('iteratively evicts oldest-accessed months until under cap', () => {
    const cache = new TransactionWindowCache(
      {
        liveTtlMs: 0,
        warmTtlMs: 60 * 60 * 1000,
        coldTtlMs: 7 * 24 * 60 * 60 * 1000,
        maxRows: 100,
      },
      new InFlightRegistry()
    );
    // Three months with 60 rows each = 180 total > cap.
    const fill = (m: string) => Array.from({ length: 60 }, (_, i) => mkTx(`${m}-${i}`, `${m}-15`));
    cache.ingestMonth('2026-01', fill('2026-01'), 1);
    cache.ingestMonth('2026-02', fill('2026-02'), 2);
    cache.ingestMonth('2026-03', fill('2026-03'), 3);

    // Single ingest doesn't help — must evict iteratively.
    expect(cache.totalRows()).toBeLessThanOrEqual(100);
    // The newest months survive.
    expect(cache.hasMonth('2026-03')).toBe(true);
  });
});

describe('TransactionWindowCache.invalidate', () => {
  test('all clears every window', () => {
    const cache = makeCache();
    cache.ingestMonth('2026-03', [mkTx('a', '2026-03-10')], Date.now());
    cache.ingestMonth('2026-04', [mkTx('b', '2026-04-10')], Date.now());

    cache.invalidate('all');

    expect(cache.hasMonth('2026-03')).toBe(false);
    expect(cache.hasMonth('2026-04')).toBe(false);
  });

  test('selective list clears only named months', () => {
    const cache = makeCache();
    cache.ingestMonth('2026-03', [mkTx('a', '2026-03-10')], Date.now());
    cache.ingestMonth('2026-04', [mkTx('b', '2026-04-10')], Date.now());

    cache.invalidate(['2026-03']);

    expect(cache.hasMonth('2026-03')).toBe(false);
    expect(cache.hasMonth('2026-04')).toBe(true);
  });
});

describe('TransactionWindowCache accessors', () => {
  test('cachedMonths returns the keys of currently-cached windows', () => {
    const cache = makeCache();
    expect(cache.cachedMonths()).toEqual([]);

    cache.ingestMonth('2026-03', [mkTx('a', '2026-03-10')], Date.now());
    cache.ingestMonth('2026-04', [mkTx('b', '2026-04-10')], Date.now());

    expect(cache.cachedMonths().sort()).toEqual(['2026-03', '2026-04']);
  });

  test('entriesForMonth returns seeded rows for ingested month', () => {
    const cache = makeCache();
    const rows = [mkTx('a', '2026-03-10'), mkTx('b', '2026-03-25')];
    cache.ingestMonth('2026-03', rows, Date.now());

    const result = cache.entriesForMonth('2026-03');
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  test('entriesForMonth returns empty array for uncached month', () => {
    const cache = makeCache();
    expect(cache.entriesForMonth('2026-03')).toEqual([]);
  });
});
