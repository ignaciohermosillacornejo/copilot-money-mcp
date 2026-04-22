/**
 * Unit tests for validateOrWarn — the shared helper that replaces silent
 * `safeParse → return null` patterns in the decoder. On parse failure it
 * returns null (preserving caller contract) but emits a structured
 * `console.warn` to stderr so silent schema drops become auditable.
 *
 * Dedupe is per-process, keyed by (collection, first-issue path, issue code),
 * to prevent log flood when Copilot ships a new field shape affecting every
 * doc in a collection.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { z } from 'zod';
import { validateOrWarn, warnUnreadFields, __resetWarnedKeys } from '../../src/core/schema-warn.js';
import type { FirestoreValue } from '../../src/core/protobuf-parser.js';

const Schema = z.object({
  id: z.string(),
  amount: z.number(),
});

describe('validateOrWarn', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    __resetWarnedKeys();
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('returns parsed data on success', () => {
    const result = validateOrWarn(
      Schema,
      { id: 'x', amount: 1 },
      {
        collection: 'accounts',
        docId: 'doc1',
      }
    );

    expect(result).toEqual({ id: 'x', amount: 1 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('returns null and warns on failure', () => {
    const result = validateOrWarn(
      Schema,
      { id: 'x', amount: 'not-a-number' },
      {
        collection: 'accounts',
        docId: 'doc1',
      }
    );

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('copilot-money-mcp');
    expect(message).toContain('schema drop');
    expect(message).toContain('collection=accounts');
    expect(message).toContain('docId=doc1');
    expect(message).toContain('path=amount');
  });

  test('dedupes identical failures (same collection + path + code)', () => {
    validateOrWarn(
      Schema,
      { id: 'x', amount: 'bad' },
      {
        collection: 'accounts',
        docId: 'doc1',
      }
    );
    validateOrWarn(
      Schema,
      { id: 'y', amount: 'also-bad' },
      {
        collection: 'accounts',
        docId: 'doc2',
      }
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('different failure paths emit separate warns', () => {
    validateOrWarn(
      Schema,
      { id: 'x', amount: 'bad' },
      {
        collection: 'accounts',
        docId: 'doc1',
      }
    );
    validateOrWarn(
      Schema,
      { id: 42, amount: 1 },
      {
        collection: 'accounts',
        docId: 'doc2',
      }
    );

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test('different collections emit separate warns for the same path', () => {
    validateOrWarn(
      Schema,
      { id: 'x', amount: 'bad' },
      {
        collection: 'accounts',
        docId: 'doc1',
      }
    );
    validateOrWarn(
      Schema,
      { id: 'x', amount: 'bad' },
      {
        collection: 'transactions',
        docId: 'doc2',
      }
    );

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test('__resetWarnedKeys clears state between runs (schema-drop path)', () => {
    validateOrWarn(
      Schema,
      { id: 'x', amount: 'bad' },
      {
        collection: 'accounts',
        docId: 'doc1',
      }
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);

    __resetWarnedKeys();

    validateOrWarn(
      Schema,
      { id: 'x', amount: 'bad' },
      {
        collection: 'accounts',
        docId: 'doc2',
      }
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

describe('warnUnreadFields', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  // Small factory for FirestoreValue-shaped test fixtures — we only care about
  // the .keys() of the Map, not the values, so `type: 'string'` is fine.
  function fakeFields(keys: string[]): Map<string, FirestoreValue> {
    return new Map(keys.map((k) => [k, { type: 'string', value: '' } as FirestoreValue]));
  }

  beforeEach(() => {
    __resetWarnedKeys();
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('emits no warns when every raw field is consumed', () => {
    warnUnreadFields(
      fakeFields(['a', 'b']),
      {
        consumed: ['a', 'b'],
        ignored: [],
      },
      { collection: 'transactions', docId: 'doc1' }
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('emits no warns when every raw field is explicitly ignored', () => {
    warnUnreadFields(
      fakeFields(['legacy1', 'legacy2']),
      {
        consumed: [],
        ignored: ['legacy1', 'legacy2'],
      },
      { collection: 'accounts', docId: 'doc1' }
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('warns once per unknown field with collection+docId+field in message', () => {
    warnUnreadFields(
      fakeFields(['known', 'mystery_field']),
      {
        consumed: ['known'],
        ignored: [],
      },
      { collection: 'transactions', docId: 'doc42' }
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain('copilot-money-mcp');
    expect(msg).toContain('unread field');
    expect(msg).toContain('collection=transactions');
    expect(msg).toContain('docId=doc42');
    expect(msg).toContain('field=mystery_field');
  });

  test('dedupes the same (collection, field) across calls', () => {
    warnUnreadFields(
      fakeFields(['new_thing']),
      { consumed: [], ignored: [] },
      { collection: 'transactions', docId: 'doc1' }
    );
    warnUnreadFields(
      fakeFields(['new_thing']),
      { consumed: [], ignored: [] },
      { collection: 'transactions', docId: 'doc2' }
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('same field across different collections emits separate warns', () => {
    warnUnreadFields(
      fakeFields(['shared']),
      { consumed: [], ignored: [] },
      { collection: 'transactions', docId: 'doc1' }
    );
    warnUnreadFields(
      fakeFields(['shared']),
      { consumed: [], ignored: [] },
      { collection: 'accounts', docId: 'doc2' }
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test('multiple unknown fields in one call emit one warn each', () => {
    warnUnreadFields(
      fakeFields(['known', 'mystery_a', 'mystery_b']),
      { consumed: ['known'], ignored: [] },
      { collection: 'transactions', docId: 'doc1' }
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test('consumed and ignored entries can overlap without crashing', () => {
    warnUnreadFields(
      fakeFields(['a']),
      { consumed: ['a'], ignored: ['a'] },
      { collection: 'transactions', docId: 'doc1' }
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('__resetWarnedKeys clears unread-field dedupe state too', () => {
    warnUnreadFields(
      fakeFields(['x']),
      { consumed: [], ignored: [] },
      { collection: 'transactions', docId: 'doc1' }
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);

    __resetWarnedKeys();

    warnUnreadFields(
      fakeFields(['x']),
      { consumed: [], ignored: [] },
      { collection: 'transactions', docId: 'doc2' }
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
