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
import {
  validateOrWarn,
  warnUnreadFields,
  __resetWarnedKeys,
  getDecodeStats,
  resetDecodeStats,
} from '../../src/core/schema-warn.js';
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

// Per-collection decode counters (issue #442). Unlike the stderr warns above,
// drops are counted per document (NOT deduped) so the counters reflect the
// true number of missing documents.
describe('decode stats counters', () => {
  let warnSpy: ReturnType<typeof spyOn>;

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

  test('counts decoded and dropped documents per collection', () => {
    validateOrWarn(Schema, { id: 'a', amount: 1 }, { collection: 'accounts', docId: 'doc1' });
    validateOrWarn(Schema, { id: 'b', amount: 2 }, { collection: 'accounts', docId: 'doc2' });
    validateOrWarn(Schema, { id: 'c', amount: 'bad' }, { collection: 'accounts', docId: 'doc3' });

    expect(getDecodeStats()).toEqual({
      accounts: { decoded: 2, dropped: 1, repaired: 0, unread_field_warnings: 0 },
    });
  });

  test('drops are counted per document even when the stderr warn is deduped', () => {
    // Same failure path + code in both docs → one stderr warn, two drops.
    validateOrWarn(Schema, { id: 'a', amount: 'bad' }, { collection: 'accounts', docId: 'doc1' });
    validateOrWarn(
      Schema,
      { id: 'b', amount: 'also-bad' },
      { collection: 'accounts', docId: 'doc2' }
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(getDecodeStats().accounts?.dropped).toBe(2);
  });

  test('tracks collections independently', () => {
    validateOrWarn(Schema, { id: 'a', amount: 1 }, { collection: 'accounts', docId: 'doc1' });
    validateOrWarn(Schema, { id: 'b', amount: 'bad' }, { collection: 'transactions', docId: 'd2' });

    expect(getDecodeStats()).toEqual({
      accounts: { decoded: 1, dropped: 0, repaired: 0, unread_field_warnings: 0 },
      transactions: { decoded: 0, dropped: 1, repaired: 0, unread_field_warnings: 0 },
    });
  });

  test('counts unique unread fields once per (collection, field)', () => {
    warnUnreadFields(
      fakeFields(['mystery_a', 'mystery_b']),
      { consumed: [], ignored: [] },
      { collection: 'transactions', docId: 'doc1' }
    );
    // Same fields on a second doc — already counted.
    warnUnreadFields(
      fakeFields(['mystery_a', 'mystery_b']),
      { consumed: [], ignored: [] },
      { collection: 'transactions', docId: 'doc2' }
    );

    expect(getDecodeStats().transactions?.unread_field_warnings).toBe(2);
  });

  test('resetDecodeStats clears counters but not stderr dedupe state', () => {
    validateOrWarn(Schema, { id: 'a', amount: 'bad' }, { collection: 'accounts', docId: 'doc1' });
    warnUnreadFields(
      fakeFields(['mystery']),
      { consumed: [], ignored: [] },
      { collection: 'accounts', docId: 'doc1' }
    );
    expect(getDecodeStats().accounts).toEqual({
      decoded: 0,
      dropped: 1,
      repaired: 0,
      unread_field_warnings: 1,
    });
    expect(warnSpy).toHaveBeenCalledTimes(2);

    resetDecodeStats();
    expect(getDecodeStats()).toEqual({});

    // A new pass re-counts the still-unread field even though its stderr
    // warning was already emitted (per-pass counter vs process-lifetime warn).
    validateOrWarn(Schema, { id: 'b', amount: 'bad' }, { collection: 'accounts', docId: 'doc2' });
    warnUnreadFields(
      fakeFields(['mystery']),
      { consumed: [], ignored: [] },
      { collection: 'accounts', docId: 'doc2' }
    );
    expect(getDecodeStats().accounts).toEqual({
      decoded: 0,
      dropped: 1,
      repaired: 0,
      unread_field_warnings: 1,
    });
    // No new stderr output: both the schema-drop and unread-field warns dedupe
    // for the lifetime of the process.
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test('getDecodeStats returns an independent snapshot', () => {
    validateOrWarn(Schema, { id: 'a', amount: 1 }, { collection: 'accounts', docId: 'doc1' });
    const snapshot = getDecodeStats();
    snapshot.accounts.decoded = 999;

    expect(getDecodeStats().accounts?.decoded).toBe(1);
  });
});

/**
 * Non-finite repair (issue #659).
 *
 * Firestore stores IEEE-754 doubles, so `NaN` / `±Infinity` reach Zod, which
 * rejects all three. Before this repair a single such leaf discarded the whole
 * document: one holding priced `Infinity` (quantity 0 upstream) removed an
 * entire investment account from `get_accounts` and 18 months of holdings
 * history from `get_holdings`.
 *
 * The sweep below is the class-level detector. It is deliberately indexed by
 * WHERE the leaf sits rather than by which schema declared it: the field that
 * happened to be hit is an accident of one user's brokerage, while the walk's
 * branches (object, object-in-array, dynamically keyed record) are what can
 * actually be wrong. Delete the repair from `validateOrWarn` and every row
 * fails.
 */
describe('validateOrWarn — non-finite repair', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  const HoldingsSchema = z.object({
    account_id: z.string(),
    current_balance: z.number(),
    holdings: z
      .array(z.object({ security_id: z.string(), institution_price: z.number().optional() }))
      .optional(),
  });

  const HistorySchema = z.object({
    history_id: z.string(),
    history: z.record(z.string(), z.object({ price: z.number().optional() })).optional(),
  });

  const OptionalPriceSchema = z.object({ id: z.string(), price: z.number().optional() });

  beforeEach(() => {
    __resetWarnedKeys();
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test.each([
    ['top-level field', OptionalPriceSchema, { id: 'x', price: Infinity }, { id: 'x' }, 'price'],
    [
      'object nested in an array',
      HoldingsSchema,
      {
        account_id: 'acc_1',
        current_balance: 5000,
        holdings: [{ security_id: 'sec_1', institution_price: -Infinity }],
      },
      {
        account_id: 'acc_1',
        current_balance: 5000,
        holdings: [{ security_id: 'sec_1' }],
      },
      'holdings.0.institution_price',
    ],
    [
      'dynamically keyed record',
      HistorySchema,
      { history_id: 'hh:2026-08', history: { '1787025600000': { price: NaN } } },
      { history_id: 'hh:2026-08', history: { '1787025600000': {} } },
      'history.1787025600000.price',
    ],
  ])(
    'keeps the document when a non-finite value sits in a %s',
    (_placement, schema, input, expected, path) => {
      const result = validateOrWarn(schema, input, { collection: 'accounts', docId: 'doc1' });

      expect(result).toEqual(expected);
      expect(getDecodeStats().accounts).toEqual({
        decoded: 1,
        dropped: 0,
        repaired: 1,
        unread_field_warnings: 0,
      });

      const message = warnSpy.mock.calls[0]?.[0] as string;
      expect(message).toContain('non-finite field');
      expect(message).toContain('collection=accounts');
      expect(message).toContain('docId=doc1');
      expect(message).toContain(`paths=${path}`);
    }
  );

  test('reports every stripped path in one warn', () => {
    validateOrWarn(
      HoldingsSchema,
      {
        account_id: 'acc_1',
        current_balance: 5000,
        holdings: [
          { security_id: 'sec_1', institution_price: Infinity },
          { security_id: 'sec_2', institution_price: NaN },
        ],
      },
      { collection: 'accounts', docId: 'doc1' }
    );

    const message = warnSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('holdings.0.institution_price');
    expect(message).toContain('holdings.1.institution_price');
  });

  test('still drops the document when the non-finite value was required', () => {
    // Stripping a required field cannot rescue the document — it is now
    // missing rather than non-finite — so the drop is reported as before.
    const result = validateOrWarn(
      HoldingsSchema,
      { account_id: 'acc_1', current_balance: Infinity },
      { collection: 'accounts', docId: 'doc1' }
    );

    expect(result).toBeNull();
    expect(getDecodeStats().accounts).toEqual({
      decoded: 0,
      dropped: 1,
      repaired: 0,
      unread_field_warnings: 0,
    });
    expect(warnSpy.mock.calls[0]?.[0]).toContain('schema drop');
  });

  test('leaves unrelated validation failures alone', () => {
    const result = validateOrWarn(
      OptionalPriceSchema,
      { id: 42, price: 1 },
      { collection: 'accounts', docId: 'doc1' }
    );

    expect(result).toBeNull();
    expect(getDecodeStats().accounts?.repaired).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('schema drop');
  });

  test('a non-finite value alongside a real failure still drops', () => {
    const result = validateOrWarn(
      OptionalPriceSchema,
      { id: 42, price: Infinity },
      { collection: 'accounts', docId: 'doc1' }
    );

    expect(result).toBeNull();
    expect(getDecodeStats().accounts).toEqual({
      decoded: 0,
      dropped: 1,
      repaired: 0,
      unread_field_warnings: 0,
    });
  });

  test('counts every repaired document even though the warn dedupes', () => {
    validateOrWarn(
      OptionalPriceSchema,
      { id: 'a', price: Infinity },
      { collection: 'accounts', docId: 'doc1' }
    );
    validateOrWarn(
      OptionalPriceSchema,
      { id: 'b', price: NaN },
      { collection: 'accounts', docId: 'doc2' }
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(getDecodeStats().accounts).toEqual({
      decoded: 2,
      dropped: 0,
      repaired: 2,
      unread_field_warnings: 0,
    });
  });

  test('does not mutate the input document', () => {
    const input = { id: 'x', price: Infinity };
    validateOrWarn(OptionalPriceSchema, input, { collection: 'accounts', docId: 'doc1' });

    expect(input.price).toBe(Infinity);
  });
});

/**
 * Warn dedupe across documents whose paths differ only by position.
 *
 * Flood control keys on the failing path, and array indices / epoch-ms map
 * keys vary per document — so before this, 18 dropped months at
 * `history.<distinct epoch>.price` emitted 18 warns that all said the same
 * thing, which is what #659's reporter saw. Numeric segments collapse in the
 * KEY only; the logged path stays exact so the warn is still actionable.
 *
 * Non-numeric dynamic keys (a `YYYY-MM-DD` in `daily_data`) still key
 * separately — pre-existing behaviour, not something this repair changed.
 */
describe('validateOrWarn — warn dedupe collapses positional paths', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  const HoldingsSchema = z.object({
    account_id: z.string(),
    holdings: z.array(z.object({ institution_price: z.number().optional() })).optional(),
  });

  const HistorySchema = z.object({
    history_id: z.string(),
    history: z.record(z.string(), z.object({ price: z.number().optional() })).optional(),
  });

  beforeEach(() => {
    __resetWarnedKeys();
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('one non-finite warn for the same field at different array indices', () => {
    validateOrWarn(
      HoldingsSchema,
      { account_id: 'acc_1', holdings: [{ institution_price: Infinity }, {}] },
      { collection: 'accounts', docId: 'doc1' }
    );
    validateOrWarn(
      HoldingsSchema,
      { account_id: 'acc_2', holdings: [{}, { institution_price: Infinity }] },
      { collection: 'accounts', docId: 'doc2' }
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    // The logged path keeps the real index — the key is what collapses.
    expect(warnSpy.mock.calls[0]?.[0]).toContain('paths=holdings.0.institution_price');
    expect(getDecodeStats().accounts?.repaired).toBe(2);
  });

  test('one non-finite warn for the same field under different epoch-ms keys', () => {
    validateOrWarn(
      HistorySchema,
      { history_id: 'hh:2026-07', history: { '1785124800000': { price: Infinity } } },
      { collection: 'holdings_history', docId: '2026-07' }
    );
    validateOrWarn(
      HistorySchema,
      { history_id: 'hh:2026-08', history: { '1787025600000': { price: NaN } } },
      { collection: 'holdings_history', docId: '2026-08' }
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(getDecodeStats().holdings_history?.repaired).toBe(2);
  });

  test('schema drops dedupe the same way', () => {
    const Strict = z.object({
      history: z.record(z.string(), z.object({ price: z.number() })),
    });

    validateOrWarn(
      Strict,
      { history: { '1785124800000': { price: 'not-a-number' } } },
      { collection: 'holdings_history', docId: '2026-07' }
    );
    validateOrWarn(
      Strict,
      { history: { '1787025600000': { price: 'not-a-number' } } },
      { collection: 'holdings_history', docId: '2026-08' }
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Both drops are still counted — only the stderr line is deduped.
    expect(getDecodeStats().holdings_history?.dropped).toBe(2);
  });

  test('genuinely different fields still warn separately', () => {
    validateOrWarn(
      HoldingsSchema,
      { account_id: 42, holdings: [] },
      { collection: 'accounts', docId: 'doc1' }
    );
    validateOrWarn(
      HoldingsSchema,
      { account_id: 'acc_1', holdings: 'not-an-array' },
      { collection: 'accounts', docId: 'doc2' }
    );

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
