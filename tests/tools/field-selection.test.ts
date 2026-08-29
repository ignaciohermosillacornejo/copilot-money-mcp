/**
 * Unit tests for the shared field-selection engine (#597 v3 base).
 *
 * The engine is generic over row shape: fixtures below deliberately mix
 * transaction-shaped and account-shaped rows with Firestore-shaped opaque
 * IDs (repo convention — no id-equals-name fixtures).
 */

import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_TRANSACTION_FIELDS,
  expandFieldSelection,
  projectRows,
} from '../../src/tools/field-selection.js';
// Namespace import so the preset detector below can DISCOVER presets by shape
// rather than importing a hand-maintained list of them — see its header.
import * as fieldSelection from '../../src/tools/field-selection.js';

// Firestore-shaped opaque IDs (synthetic).
const TXN_ID_1 = 'Zx9kQ2mVp3LqR8sTuW1y';
const TXN_ID_2 = 'Bf4nH7jKw2PdX5cYvA8e';
const ACCOUNT_ID = 'aQ3mZ8kL1xNv6RtE9pWs';

const txnRows = [
  {
    transaction_id: TXN_ID_1,
    date: '2024-02-01',
    amount: 100,
    name: 'Merchant One',
    category_name: 'Groceries',
    account_id: ACCOUNT_ID,
    pending: false,
    plaid_category_id: 'food_groceries',
    is_amazon: false,
  },
  {
    transaction_id: TXN_ID_2,
    date: '2024-02-02',
    amount: 200,
    name: 'Merchant Two',
    category_name: 'Shopping',
    account_id: ACCOUNT_ID,
    pending: true,
    normalized_merchant: 'merchant two',
  },
];

describe('DEFAULT_TRANSACTION_FIELDS', () => {
  test('is exactly the 10-field v3 default preset', () => {
    expect([...DEFAULT_TRANSACTION_FIELDS]).toEqual([
      'transaction_id',
      'date',
      'amount',
      'name',
      'category_name',
      'account_id',
      'item_id',
      'pending',
      'excluded',
      'internal_transfer',
    ]);
  });
});

describe('expandFieldSelection', () => {
  const preset = ['id', 'date', 'amount'] as const;

  test('undefined -> undefined (caller decides the default)', () => {
    expect(expandFieldSelection(undefined, preset)).toBeUndefined();
  });

  test('empty array -> undefined (caller decides the default)', () => {
    expect(expandFieldSelection([], preset)).toBeUndefined();
  });

  test('plain list passes through in order', () => {
    expect(expandFieldSelection(['amount', 'id'], preset)).toEqual(['amount', 'id']);
  });

  test('dedupes repeated names, keeping the first occurrence', () => {
    expect(expandFieldSelection(['amount', 'id', 'amount'], preset)).toEqual(['amount', 'id']);
  });

  test('"default" expands to the preset in preset order', () => {
    expect(expandFieldSelection(['default'], preset)).toEqual(['id', 'date', 'amount']);
  });

  test('"default" plus extras appends without duplication', () => {
    expect(expandFieldSelection(['default', 'plaid_category_id'], preset)).toEqual([
      'id',
      'date',
      'amount',
      'plaid_category_id',
    ]);
  });

  test('explicit name before "default" keeps its position (order-preserving dedupe)', () => {
    expect(expandFieldSelection(['date', 'default'], preset)).toEqual(['date', 'id', 'amount']);
  });

  test('repeated "default" tokens expand once', () => {
    expect(expandFieldSelection(['default', 'default'], preset)).toEqual(['id', 'date', 'amount']);
  });

  test('"all" anywhere -> undefined (no projection)', () => {
    expect(expandFieldSelection(['all'], preset)).toBeUndefined();
    expect(expandFieldSelection(['date', 'all', 'amount'], preset)).toBeUndefined();
  });

  test('"*" anywhere -> undefined (no projection)', () => {
    expect(expandFieldSelection(['*'], preset)).toBeUndefined();
    expect(expandFieldSelection(['default', '*'], preset)).toBeUndefined();
  });

  test('non-array input throws a clear Error naming the expected type', () => {
    expect(() => expandFieldSelection('date' as unknown as string[], preset)).toThrow(/array/i);
    expect(() => expandFieldSelection({} as unknown as string[], preset)).toThrow(/array/i);
  });

  test('"default" with an empty preset throws instead of expanding to nothing', () => {
    // Silent `[]` here would make projectRows return all-empty rows for a
    // mis-wired consumer that forgot to pass its preset.
    expect(() => expandFieldSelection(['default'], [])).toThrow(/preset/i);
    expect(() => expandFieldSelection(['default', 'default'], [])).toThrow(/preset/i);
  });
});

describe('projectRows', () => {
  test('projects each row to the requested allowlist', () => {
    const { rows, warning } = projectRows(txnRows, ['transaction_id', 'amount']);
    expect(warning).toBeUndefined();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['amount', 'transaction_id']);
    }
    expect(rows[0].transaction_id).toBe(TXN_ID_1);
    expect(rows[1].amount).toBe(200);
  });

  test('is generic over row shape (works on non-transaction rows)', () => {
    const accountRows = [
      { account_id: ACCOUNT_ID, balance: 5000, type: 'depository', logo: 'aGVsbG8=' },
    ];
    const { rows, warning } = projectRows(accountRows, ['account_id', 'balance']);
    expect(warning).toBeUndefined();
    expect(rows).toEqual([{ account_id: ACCOUNT_ID, balance: 5000 }]);
  });

  test('undefined fields -> rows unchanged, no warning', () => {
    const { rows, warning } = projectRows(txnRows, undefined);
    expect(warning).toBeUndefined();
    expect(rows).toEqual(txnRows);
  });

  test('empty fields array -> rows unchanged, no warning', () => {
    const { rows, warning } = projectRows(txnRows, []);
    expect(warning).toBeUndefined();
    expect(rows).toEqual(txnRows);
  });

  test('"all" / "*" -> full rows, no projection', () => {
    expect(projectRows(txnRows, ['all']).rows).toEqual(txnRows);
    expect(projectRows(txnRows, ['*']).rows).toEqual(txnRows);
  });

  test('"all" plus a typo returns full rows AND still reports the typo', () => {
    // Detection is deliberately independent of projection: an unknown name
    // is surfaced even when the "all" token made it inconsequential.
    const { rows, warning } = projectRows(txnRows, ['all', 'not_a_real_field'], {
      knownFields: new Set(['transaction_id']),
    });
    expect(rows).toEqual(txnRows);
    expect(warning).toBeDefined();
    expect(warning).toContain('not_a_real_field');
  });

  test('"default" expands via opts.preset', () => {
    const { rows, warning } = projectRows(txnRows, ['default'], {
      preset: ['transaction_id', 'date'],
    });
    expect(warning).toBeUndefined();
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['date', 'transaction_id']);
    }
  });

  test('non-array fields throws a clear Error naming the expected type', () => {
    expect(() => projectRows(txnRows, 'transaction_id' as unknown as string[])).toThrow(/array/i);
  });

  test('"default" without opts.preset throws instead of returning all-empty rows', () => {
    expect(() => projectRows(txnRows, ['default'])).toThrow(/preset/i);
  });

  test('a hostile own __proto__ key cannot pollute projected rows', () => {
    // JSON.parse creates __proto__ as an OWN key; a naive `out[key] = value`
    // copy would assign through the inherited setter instead.
    const hostile = JSON.parse(
      '{"transaction_id":"Jm5xT8wQz2NvK4rBpL7c","__proto__":{"polluted":true}}'
    ) as Record<string, unknown>;
    const { rows } = projectRows([hostile], ['transaction_id', '__proto__']);
    expect(Object.keys(rows[0])).toEqual(['transaction_id']);
    expect((rows[0] as { polluted?: boolean }).polluted).toBeUndefined();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  describe('unknown-name detection with knownFields', () => {
    // 'item_id' is deliberately in knownFields but on NO fixture row, and
    // 'plaid_category_id' is on a fixture row but NOT in knownFields — the
    // tests below use them to prove knownFields (not row keys) is the
    // authority, so a mutation that disables this branch cannot pass.
    const knownFields: ReadonlySet<string> = new Set([
      'transaction_id',
      'date',
      'amount',
      'category_name',
      'item_id',
    ]);

    test('unknown requested names produce a warning listing them', () => {
      const { rows, warning } = projectRows(
        txnRows,
        ['transaction_id', 'not_a_real_field', 'also_bogus'],
        { knownFields }
      );
      expect(warning).toBeDefined();
      expect(warning).toContain('not_a_real_field');
      expect(warning).toContain('also_bogus');
      // Unknown names never leak into projected rows.
      for (const row of rows) {
        expect(Object.keys(row)).toEqual(['transaction_id']);
      }
    });

    test('known names and tokens never warn', () => {
      const { warning } = projectRows(txnRows, ['default', 'transaction_id', 'amount'], {
        knownFields,
        preset: ['transaction_id'],
      });
      expect(warning).toBeUndefined();
    });

    test('a field in knownFields but absent from EVERY row does not warn', () => {
      // knownFields is the authority when provided: optional document fields
      // legitimately absent from a given result page must not warn. The
      // row-key fallback WOULD warn here, so this discriminates the modes.
      const { warning } = projectRows(txnRows, ['item_id', 'date'], {
        knownFields,
      });
      expect(warning).toBeUndefined();
    });

    test('zero rows with knownFields still warns on a bogus name', () => {
      // The authority set works without any rows to compare against; only
      // the row-key fallback stays silent on zero rows.
      const { rows, warning } = projectRows([], ['item_id', 'bogus_name'], { knownFields });
      expect(rows).toEqual([]);
      expect(warning).toBeDefined();
      expect(warning).toContain('bogus_name');
      expect(warning).not.toContain('item_id');
    });

    test('a name present on a row but NOT in knownFields warns', () => {
      // plaid_category_id exists on the first fixture row, but the authority
      // set does not list it — knownFields wins over row keys.
      const { warning } = projectRows(txnRows, ['transaction_id', 'plaid_category_id'], {
        knownFields,
      });
      expect(warning).toBeDefined();
      expect(warning).toContain('plaid_category_id');
    });

    test('custom valid-fields hint appears in the warning', () => {
      const { warning } = projectRows(txnRows, ['bogus_field'], {
        knownFields,
        validFieldsHint: 'the transaction document fields plus enrichment fields',
      });
      expect(warning).toContain('bogus_field');
      expect(warning).toContain('the transaction document fields plus enrichment fields');
    });
  });

  describe('unknown-name detection without knownFields (row-key fallback)', () => {
    test('names absent from every row produce a warning', () => {
      const { warning } = projectRows(txnRows, ['transaction_id', 'not_a_real_field']);
      expect(warning).toBeDefined();
      expect(warning).toContain('not_a_real_field');
    });

    test('a name present on at least one row does not warn', () => {
      // normalized_merchant is only on the second fixture row.
      const { warning } = projectRows(txnRows, ['transaction_id', 'normalized_merchant']);
      expect(warning).toBeUndefined();
    });

    test('empty rows -> no warning (nothing to compare against)', () => {
      const { rows, warning } = projectRows([], ['anything_at_all']);
      expect(rows).toEqual([]);
      expect(warning).toBeUndefined();
    });

    test('inherited prototype properties do not mask the warning', () => {
      // `'toString' in row` is true via the prototype chain, but no row OWNS
      // it — the projection would yield empty rows, so it must warn.
      const { rows, warning } = projectRows(txnRows, ['toString']);
      expect(warning).toBeDefined();
      expect(warning).toContain('toString');
      for (const row of rows) {
        expect(Object.keys(row)).toEqual([]);
      }
    });
  });

  // ===================================================================
  // CLASS-LEVEL DETECTOR for the #635 bug class:
  // "deleting a field from a preset survived all 2,679 tests."
  //
  // That class has now bitten twice. The second time (PR #673) three of the
  // five DEFAULT_TOP_MOVER_FIELDS entries could be deleted with the whole
  // suite still green. Nothing else in the repo can catch it:
  //
  //   - The context-budget ratchet measures an UPPER bound. A preset that
  //     loses fields produces a SMALLER response, so it sails through.
  //   - The `satisfies readonly (keyof Row)[]` clauses on the presets catch a
  //     TYPO, not a DELETION — a shorter list still satisfies the constraint.
  //   - Line coverage is useless here: the preset is executed by every test
  //     that calls the tool. Executing is not detecting.
  //   - The type system never sees "a complete row"; a preset is just strings.
  //
  // The first fix attempt was a per-preset verbatim test, hand-written one at
  // a time. That is the SAME failure shape one level up: it protects the four
  // presets someone remembered, and silently protects nothing for the fifth.
  // PR B adds an accounts preset; PR C reshapes the transactions one.
  //
  // So this block DISCOVERS presets instead of listing them, and is
  // bidirectional — the two directions fail for different reasons:
  //   forward:  a preset the engine exports with no pinned expectation
  //             (i.e. someone added a preset and no test came with it)
  //   backward: a pinned expectation naming a preset that no longer exists
  //             (i.e. stale expectation quietly protecting nothing)
  //
  // Discovery is by SHAPE (an exported array of strings), not by name, so a
  // preset that breaks the DEFAULT_*_FIELDS naming convention is still
  // caught. Every other export of this module is an object or a function.
  //
  // If you are changing a preset deliberately: update PINNED_PRESETS here and
  // re-baseline the response budgets in tests/context-budget.test.ts. That is
  // the intended workflow, not an obstacle — the point is that the change
  // cannot happen SILENTLY.
  // ===================================================================
  describe('every field preset is pinned (#635 class detector)', () => {
    const PINNED_PRESETS: Record<string, readonly string[]> = {
      DEFAULT_TRANSACTION_FIELDS: [
        'transaction_id',
        'date',
        'amount',
        'name',
        'category_name',
        'account_id',
        'item_id',
        'pending',
        'excluded',
        'internal_transfer',
      ],
      DEFAULT_INVESTMENT_PRICE_FIELDS: [
        'security_id',
        'ticker_symbol',
        'price_type',
        'date',
        'month',
        'latest_price',
        'latest_at',
      ],
      DEFAULT_TOP_MOVER_FIELDS: ['security_id', 'ticker_symbol', 'name', 'type', 'change'],
      DEFAULT_CATEGORY_LIVE_FIELDS: [
        'id',
        'parentId',
        'name',
        'colorName',
        'isExcluded',
        'budget_amount',
      ],
    };

    const discovered = Object.entries(fieldSelection)
      .filter(
        ([, value]) => Array.isArray(value) && value.every((item) => typeof item === 'string')
      )
      .map(([name, value]) => [name, value as readonly string[]] as const)
      .sort(([a], [b]) => a.localeCompare(b));

    // Without this, an import-shape change that makes `discovered` empty would
    // leave the forward check passing vacuously over an empty list — the exact
    // "guard that cannot fail" trap this block exists to prevent, reappearing
    // one level up. (The backward check would also fail in that case, but this
    // gives the failure an unambiguous message.)
    test('discovery finds the presets at all', () => {
      expect(discovered.length).toBeGreaterThan(0);
    });

    test('forward: every preset the engine exports has a pinned expectation', () => {
      const unpinned = discovered.map(([name]) => name).filter((name) => !(name in PINNED_PRESETS));
      expect(unpinned).toEqual([]);
    });

    test('backward: every pinned expectation still names a live preset', () => {
      const live = new Set(discovered.map(([name]) => name));
      const stale = Object.keys(PINNED_PRESETS).filter((name) => !live.has(name));
      expect(stale).toEqual([]);
    });

    for (const [name, value] of discovered) {
      test(`${name} contents are unchanged`, () => {
        expect([...value]).toEqual([...(PINNED_PRESETS[name] ?? [])]);
      });
    }
  });

  test('does not mutate input rows', () => {
    const before = JSON.stringify(txnRows);
    projectRows(txnRows, ['transaction_id'], { knownFields: new Set(['transaction_id']) });
    expect(JSON.stringify(txnRows)).toBe(before);
  });
});
