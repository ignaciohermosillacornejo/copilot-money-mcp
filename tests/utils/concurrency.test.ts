import { describe, expect, test } from 'bun:test';
import { pLimit } from '../../src/utils/concurrency.js';

describe('pLimit', () => {
  test('returns the resolved value of fn()', async () => {
    const limit = pLimit(2);
    const result = await limit(async () => 42);
    expect(result).toBe(42);
  });

  test('keeps active count ≤ N at any moment', async () => {
    const N = 4;
    const limit = pLimit(N);
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const tasks = Array.from({ length: 10 }, () =>
      limit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => release.push(r));
        active -= 1;
        return 'done';
      })
    );
    // Let the first batch start.
    await Promise.resolve();
    await Promise.resolve();
    expect(active).toBeLessThanOrEqual(N);
    // Drain in FIFO order.
    while (release.length > 0) {
      release.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(N);
  });

  test('runs sequentially when concurrency=1', async () => {
    const limit = pLimit(1);
    const order: number[] = [];
    const tasks = [1, 2, 3].map((n) =>
      limit(async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(n);
      })
    );
    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
  });

  test('rejection in one task does not poison the pool', async () => {
    const limit = pLimit(2);
    const a = limit(async () => {
      throw new Error('boom');
    });
    const b = limit(async () => 'ok');
    await expect(a).rejects.toThrow('boom');
    await expect(b).resolves.toBe('ok');
  });

  test('queued tasks run in FIFO order after first batch settles', async () => {
    const limit = pLimit(1);
    const order: string[] = [];
    const t1 = limit(async () => {
      order.push('a');
    });
    const t2 = limit(async () => {
      order.push('b');
    });
    const t3 = limit(async () => {
      order.push('c');
    });
    await Promise.all([t1, t2, t3]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('throws RangeError when concurrency is zero, negative, or non-integer', () => {
    expect(() => pLimit(0)).toThrow(RangeError);
    expect(() => pLimit(-1)).toThrow(RangeError);
    expect(() => pLimit(2.5)).toThrow(RangeError);
    expect(() => pLimit(NaN)).toThrow(RangeError);
  });

  test('preserves non-Error rejection values verbatim (string, object)', async () => {
    const limit = pLimit(2);
    await expect(
      limit(async () => {
        throw 'string-error';
      })
    ).rejects.toBe('string-error');
    const obj = { code: 42 };
    await expect(
      limit(async () => {
        throw obj;
      })
    ).rejects.toBe(obj);
  });
});
