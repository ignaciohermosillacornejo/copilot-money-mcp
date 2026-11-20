/**
 * The cache-mode account visibility rule and the fields it reads (#904).
 *
 * `isVisibleAccount` is the one rule every cache surface that lists accounts or
 * sums their balances applies (#683). #904 added a third term, `merged`, so
 * these tests pin the rule's INPUTS rather than one fixture per term:
 *
 * - every field in `ACCOUNT_VISIBILITY_FIELDS` hides an otherwise-plain
 *   account on its own;
 * - the rule reads no field outside that list, so the list cannot fall behind
 *   a term added to the body;
 * - `get_accounts`' default preset carries the whole list, so a row that
 *   `include_hidden: true` brings back still says why it was hidden.
 */

import { describe, expect, test } from 'bun:test';
import {
  ACCOUNT_VISIBILITY_FIELDS,
  isVisibleAccount,
  type Account,
} from '../../src/models/account.js';
import { DEFAULT_ACCOUNT_FIELDS } from '../../src/tools/field-selection.js';

type VisibilityInput = Parameters<typeof isVisibleAccount>[0];

/** The value that marks an account hidden, per field. */
const HIDING_VALUE: { [K in (typeof ACCOUNT_VISIBILITY_FIELDS)[number]]: Account[K] } = {
  user_hidden: true,
  user_deleted: true,
  // The shape reported in #902/#904: an end date and the merge's origin.
  merged: { end_date: '2024-03-01', source: 'auto' },
};

describe('isVisibleAccount (#683, #904)', () => {
  test('a plain account is visible', () => {
    expect(isVisibleAccount({})).toBe(true);
  });

  for (const field of ACCOUNT_VISIBILITY_FIELDS) {
    test(`${field} alone hides an account`, () => {
      expect(isVisibleAccount({ [field]: HIDING_VALUE[field] } as VisibilityInput)).toBe(false);
    });
  }

  test('the boolean flags hide only when true', () => {
    expect(isVisibleAccount({ user_hidden: false, user_deleted: false })).toBe(true);
  });

  test('merged hides whatever its source says, including none (#904)', () => {
    // The rule is the map's presence. "auto" is the only source seen so far;
    // a merge recorded any other way is still a merged account.
    for (const merged of [{ source: 'auto' }, { source: 'user' }, { end_date: '2024-03-01' }, {}]) {
      expect(isVisibleAccount({ merged })).toBe(false);
    }
  });

  test('a null merged is not a merge', () => {
    // Matches the decoder and smoke:cache, which take only a real map.
    expect(isVisibleAccount({ merged: null } as unknown as VisibilityInput)).toBe(true);
  });

  test('a merged account is hidden even with user_deleted explicitly false (#904)', () => {
    // The report's shape: the merge did not set user_deleted, which is what
    // #82's filter relied on.
    expect(isVisibleAccount({ user_deleted: false, merged: HIDING_VALUE.merged })).toBe(false);
  });

  test('the rule reads exactly ACCOUNT_VISIBILITY_FIELDS', () => {
    const read = new Set<string>();
    const spy = new Proxy({} as VisibilityInput, {
      get(_target, key) {
        if (typeof key === 'string') read.add(key);
        return undefined;
      },
    });
    // A plain account takes every branch, so every field the body consults is read.
    expect(isVisibleAccount(spy)).toBe(true);
    expect([...read].sort()).toEqual([...ACCOUNT_VISIBILITY_FIELDS].sort());
  });
});

describe('get_accounts default preset carries the visibility fields (#904)', () => {
  test('every field the rule reads is in DEFAULT_ACCOUNT_FIELDS', () => {
    const preset = new Set<string>(DEFAULT_ACCOUNT_FIELDS);
    expect(ACCOUNT_VISIBILITY_FIELDS.filter((f) => !preset.has(f))).toEqual([]);
  });
});
