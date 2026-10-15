/**
 * scripts/parity/cache-call.ts runs CopilotMoneyTools methods by name against
 * the user's real cache, during a test that also holds write access. Its
 * docblock promises it can only read. TypeScript proves each READ_METHODS entry
 * exists, not that it reads: adding 'deleteTransaction' would typecheck. These
 * tests make the promise enforced (review on #826).
 */
import { beforeAll, describe, expect, test } from 'bun:test';

import { READ_METHODS, parseArgs } from '../../scripts/parity/cache-call.js';
import { ALL_TOOL_DEFS } from '../../src/tools/registry/index.js';

/**
 * The CopilotMoneyTools methods a tool's handler calls, found by running the
 * handler against a context whose `tools` only records method names. Handlers
 * are wrapped at registration (dropEmptyFieldSelection), so their source text
 * does not show the call; running them does, and nothing real is reached.
 */
async function methodsCalledBy(def: (typeof ALL_TOOL_DEFS)[number]): Promise<string[]> {
  const called: string[] = [];
  const tools = new Proxy(
    {},
    {
      get:
        (_target, method) =>
        (..._args: unknown[]) => {
          called.push(String(method));
          return Promise.resolve({});
        },
    }
  );
  try {
    await def.handler({ tools } as unknown as Parameters<typeof def.handler>[0], {});
  } catch {
    // A live tool reaches for ctx.live and throws; it calls no CopilotMoneyTools
    // method, which is what this records.
  }
  return called;
}

const readMethods = new Set<string>();
const writeMethods = new Set<string>();

describe('parity cache-call is read-only', () => {
  beforeAll(async () => {
    for (const def of ALL_TOOL_DEFS) {
      const target = def.readOnly ? readMethods : writeMethods;
      for (const method of await methodsCalledBy(def)) target.add(method);
    }
  });

  test('the registry scan found both read and write tools', () => {
    // Non-vacuity: if the handlers stopped reaching ctx.tools (a new wrapper, a
    // renamed context field) the spy would record nothing and both checks below
    // would pass vacuously.
    expect(readMethods.size).toBeGreaterThan(5);
    expect(writeMethods.size).toBeGreaterThan(5);
    expect(writeMethods.has('deleteTransaction')).toBe(true);
  });

  test('every allowlisted method is behind a readOnly tool', () => {
    expect(READ_METHODS.filter((m) => !readMethods.has(m))).toEqual([]);
  });

  test('no allowlisted method is behind a write tool', () => {
    expect(READ_METHODS.filter((m) => writeMethods.has(m))).toEqual([]);
  });
});

describe('parity cache-call argument parsing', () => {
  test('accepts a JSON object, and no argument as an empty one', () => {
    expect(parseArgs('{"period":"last_month"}')).toEqual({ period: 'last_month' });
    expect(parseArgs(undefined)).toEqual({});
  });

  test.each(['null', '"last_month"', '5', '[1,2]', 'true'])(
    'rejects %s instead of running an unfiltered read',
    (input) => {
      expect(() => parseArgs(input)).toThrow('args must be a JSON object');
    }
  );
});
