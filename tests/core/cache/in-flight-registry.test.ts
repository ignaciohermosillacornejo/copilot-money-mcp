import { describe, expect, test } from 'bun:test';
import { InFlightRegistry } from '../../../src/core/cache/in-flight-registry.js';

describe('InFlightRegistry', () => {
  test('two simultaneous calls with the same key share one loader invocation', async () => {
    const reg = new InFlightRegistry();
    let invocations = 0;
    const loader = async () => {
      invocations += 1;
      await new Promise((r) => setTimeout(r, 10));
      return 'value';
    };

    const [a, b] = await Promise.all([reg.run('k', loader), reg.run('k', loader)]);

    expect(a).toBe('value');
    expect(b).toBe('value');
    expect(invocations).toBe(1);
  });

  test('post-success, next call invokes loader fresh', async () => {
    const reg = new InFlightRegistry();
    let invocations = 0;
    const loader = async () => {
      invocations += 1;
      return invocations;
    };

    const first = await reg.run('k', loader);
    const second = await reg.run('k', loader);

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(invocations).toBe(2);
  });

  test('failure clears the entry so next call retries', async () => {
    const reg = new InFlightRegistry();
    let attempts = 0;
    const loader = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
      return 'ok';
    };

    await expect(reg.run('k', loader)).rejects.toThrow('boom');
    const result = await reg.run('k', loader);

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  test('different keys do not share promises', async () => {
    const reg = new InFlightRegistry();
    let invocations = 0;
    const loader = async () => {
      invocations += 1;
      return invocations;
    };

    const [a, b] = await Promise.all([reg.run('k1', loader), reg.run('k2', loader)]);

    expect(invocations).toBe(2);
    expect(a + b).toBe(3); // 1+2 in some order
  });
});
