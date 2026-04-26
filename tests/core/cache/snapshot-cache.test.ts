import { describe, expect, test } from 'bun:test';
import { InFlightRegistry } from '../../../src/core/cache/in-flight-registry.js';
import { SnapshotCache } from '../../../src/core/cache/snapshot-cache.js';

interface Row {
  id: string;
  name: string;
}

const makeCache = (ttlMs = 1000) =>
  new SnapshotCache<Row>({ key: 'rows', ttlMs, keyFn: (r) => r.id }, new InFlightRegistry());

describe('SnapshotCache', () => {
  test('first read is a miss; loader populates the cache', async () => {
    const cache = makeCache();
    let loads = 0;
    const result = await cache.read(async () => {
      loads += 1;
      return [{ id: '1', name: 'one' }];
    });

    expect(result.hit).toBe(false);
    expect(result.rows).toEqual([{ id: '1', name: 'one' }]);
    expect(typeof result.fetched_at).toBe('number');
    expect(loads).toBe(1);
  });

  test('second read within TTL is a cache hit; loader not called', async () => {
    const cache = makeCache();
    let loads = 0;
    const loader = async () => {
      loads += 1;
      return [{ id: '1', name: 'one' }];
    };

    await cache.read(loader);
    const result = await cache.read(loader);

    expect(result.hit).toBe(true);
    expect(loads).toBe(1);
  });

  test('read past TTL refetches', async () => {
    const cache = makeCache(10);
    let loads = 0;
    const loader = async () => {
      loads += 1;
      return [{ id: String(loads), name: `n${loads}` }];
    };

    await cache.read(loader);
    await new Promise((r) => setTimeout(r, 15));
    const result = await cache.read(loader);

    expect(result.hit).toBe(false);
    expect(result.rows).toEqual([{ id: '2', name: 'n2' }]);
    expect(loads).toBe(2);
  });

  test('upsert mutates the in-memory snapshot', async () => {
    const cache = makeCache();
    await cache.read(async () => [{ id: '1', name: 'one' }]);

    cache.upsert({ id: '2', name: 'two' });
    cache.upsert({ id: '1', name: 'updated' });

    const result = await cache.read(async () => {
      throw new Error('should not be called');
    });
    expect(result.rows).toEqual([
      { id: '1', name: 'updated' },
      { id: '2', name: 'two' },
    ]);
    expect(result.hit).toBe(true);
  });

  test('delete removes the row from the snapshot', async () => {
    const cache = makeCache();
    await cache.read(async () => [
      { id: '1', name: 'one' },
      { id: '2', name: 'two' },
    ]);

    cache.delete('1');

    const result = await cache.read(async () => {
      throw new Error('should not be called');
    });
    expect(result.rows).toEqual([{ id: '2', name: 'two' }]);
  });

  test('upsert/delete are no-ops when snapshot not loaded', () => {
    const cache = makeCache();
    expect(() => cache.upsert({ id: '1', name: 'one' })).not.toThrow();
    expect(() => cache.delete('1')).not.toThrow();
  });

  test('invalidate clears the snapshot; next read is a miss', async () => {
    const cache = makeCache();
    await cache.read(async () => [{ id: '1', name: 'one' }]);

    cache.invalidate();

    let loads = 0;
    const result = await cache.read(async () => {
      loads += 1;
      return [{ id: '2', name: 'two' }];
    });
    expect(result.hit).toBe(false);
    expect(loads).toBe(1);
  });

  test('cache populated before in-flight registry clears (race contract)', async () => {
    const reg = new InFlightRegistry();
    const cache = new SnapshotCache<Row>(
      { key: 'rows', ttlMs: 1000, keyFn: (r) => r.id },
      reg
    );

    let loaderResolves!: (rows: Row[]) => void;
    const loaderPromise = new Promise<Row[]>((resolve) => {
      loaderResolves = resolve;
    });

    const readA = cache.read(() => loaderPromise);
    loaderResolves([{ id: '1', name: 'one' }]);
    await readA;

    // After A resolves, both registry-cleanup and cache-write must have
    // happened. A subsequent read must be a hit, not a fresh fetch.
    let loads = 0;
    const result = await cache.read(async () => {
      loads += 1;
      return [];
    });
    expect(result.hit).toBe(true);
    expect(loads).toBe(0);
  });
});
