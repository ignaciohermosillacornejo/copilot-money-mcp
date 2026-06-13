/**
 * Fixture-shape invariant gate (issue #461).
 *
 * Class-level ratchet for the name→ID resolution bug class fixed in PR #394.
 * That bug — cache-mode `get_transactions` comparing a user-facing tag NAME
 * against opaque tag IDs — went undetected for over a month because the only
 * fixture exercising the path used a tag whose ID equaled its display name
 * (`tag_id: 'work'` for a tag named `work`), so the broken `name === id`
 * comparison passed by accident.
 *
 * The invariant: synthetic fixture documents for ID-keyed entities must use
 * opaque IDs that are DISTINCT from their own display name. If id === name,
 * a resolution step that should map name → id can be silently skipped and the
 * fixture will still "pass", masking the same class of bug on sibling paths
 * (categories, accounts, recurrings, ...).
 *
 * The check is enforced two ways:
 *  1. `assertOpaqueIds()` is wired into `createTestDb()`, so EVERY LevelDB-backed
 *     fixture is validated as it is built (see test-db.ts).
 *  2. The unit tests below pin the helper's behavior so the gate itself can't
 *     silently regress.
 */

import { describe, test, expect } from 'bun:test';
import { assertOpaqueIds, ID_NAME_FIELD_PAIRS } from './test-db.js';

describe('fixture-shape invariant (issue #461)', () => {
  test('passes when ids are opaque and distinct from display names', () => {
    expect(() =>
      assertOpaqueIds([
        {
          collection: 'categories',
          id: 'cat_8f3kq9',
          fields: { category_id: 'cat_8f3kq9', name: 'Groceries' },
        },
        {
          collection: 'accounts',
          id: 'acc_2bz1',
          fields: { account_id: 'acc_2bz1', name: 'Checking' },
        },
      ])
    ).not.toThrow();
  });

  test('passes for Plaid-taxonomy slug ids that are not equal to the display name', () => {
    // Plaid category ids look name-ish (`food_dining`) but never equal the
    // human display name (`Food & Dining`), so they are legitimately opaque.
    expect(() =>
      assertOpaqueIds([
        {
          collection: 'categories',
          id: 'food_dining',
          fields: { category_id: 'food_dining', name: 'Food & Dining' },
        },
      ])
    ).not.toThrow();
  });

  test('throws when a doc id equals its display name', () => {
    expect(() =>
      assertOpaqueIds([
        {
          collection: 'categories',
          id: 'Groceries',
          fields: { category_id: 'Groceries', name: 'Groceries' },
        },
      ])
    ).toThrow(/id-equals-name/i);
  });

  test('throws when id equals name case-insensitively (a comparison could still match)', () => {
    expect(() =>
      assertOpaqueIds([
        {
          collection: 'accounts',
          id: 'checking',
          fields: { account_id: 'checking', name: 'Checking' },
        },
      ])
    ).toThrow(/id-equals-name/i);
  });

  test('throws when the id field inside fields equals the name (even if doc id differs)', () => {
    // The decoded model reads the *_id field, so an id==name there is just as
    // dangerous as on the doc id.
    expect(() =>
      assertOpaqueIds([
        {
          collection: 'recurring',
          id: 'rec_opaque',
          fields: { recurring_id: 'Netflix', name: 'Netflix' },
        },
      ])
    ).toThrow(/id-equals-name/i);
  });

  test('error message names the offending collection and value', () => {
    let message = '';
    try {
      assertOpaqueIds([
        {
          collection: 'accounts',
          id: 'Savings',
          fields: { account_id: 'Savings', name: 'Savings' },
        },
      ]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('accounts');
    expect(message).toContain('Savings');
  });

  test('ignores collections not in ID_NAME_FIELD_PAIRS', () => {
    // 'budgets' is not a name→ID resolution surface (no entry in
    // ID_NAME_FIELD_PAIRS), so the gate doesn't inspect it — even though the
    // id happens to equal the category_id here.
    expect(() =>
      assertOpaqueIds([
        {
          collection: 'budgets',
          id: 'food_dining',
          fields: { budget_id: 'food_dining', category_id: 'food_dining' },
        },
      ])
    ).not.toThrow();
  });

  test('throws for a tag doc whose id equals its name', () => {
    // tags are in ID_NAME_FIELD_PAIRS (the #394 bug was the tag filter);
    // pin that the gate actually fires for them, not just categories/accounts.
    expect(() =>
      assertOpaqueIds([
        {
          collection: 'tags',
          id: 'vacation',
          fields: { tag_id: 'vacation', name: 'vacation' },
        },
      ])
    ).toThrow(/id-equals-name/i);
  });

  test('covers the documented name→ID-keyed collections', () => {
    // Guards against silently dropping a collection from the invariant.
    const collections = ID_NAME_FIELD_PAIRS.map((p) => p.collectionPrefix);
    expect(collections).toContain('categories');
    expect(collections).toContain('accounts');
    expect(collections).toContain('recurring');
    expect(collections).toContain('tags');
  });
});
