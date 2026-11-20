import { describe, expect, test } from 'bun:test';
import {
  classifyAccountVisibilityParity,
  compareAccountVisibility,
  type AccountVisibilityParity,
  type CacheVisibilityInput,
  type LiveVisibilityInput,
} from '../../scripts/smoke/account-visibility-checks.js';

// Firestore-shaped opaque ids, not names, so an id/name mix-up cannot pass.
const A = 'Xk3PqR9vTzL2mWn8bYc4';
const B = 'Qa7HsD2fJk9LpZx3VbN1';
const C = 'Mn5TyU8iOp1AsDf4GhJ6';
const D = 'Rt2WqE6yUi9OpLk3JhG5';

const MERGED = { end_date: '2024-03-01', source: 'auto' };
const open = (id: string): LiveVisibilityInput => ({
  id,
  isUserHidden: false,
  isUserClosed: false,
});
const closed = (id: string): LiveVisibilityInput => ({
  id,
  isUserHidden: false,
  isUserClosed: true,
});
const hidden = (id: string): LiveVisibilityInput => ({
  id,
  isUserHidden: true,
  isUserClosed: false,
});

const ZERO: AccountVisibilityParity = {
  compared: 0,
  cacheHidesLiveShows: 0,
  cacheHidesLiveShowsMerged: 0,
  cacheShowsLiveHides: 0,
  hiddenAgreed: 0,
  cacheOnlyVisible: 0,
  cacheOnlyHidden: 0,
  liveOnlyVisible: 0,
  liveOnlyHidden: 0,
  merged: 0,
  mergedCompared: 0,
};

describe('compareAccountVisibility', () => {
  test('agreement on visible and hidden rows', () => {
    const cache: CacheVisibilityInput[] = [
      { account_id: A },
      { account_id: B, user_hidden: true },
      { account_id: C, user_deleted: true },
    ];
    expect(compareAccountVisibility(cache, [open(A), hidden(B), closed(C)])).toEqual({
      ...ZERO,
      compared: 3,
      hiddenAgreed: 2,
    });
  });

  test('a merged account the cache hides and live lists as open is a disagreement (#904)', () => {
    const parity = compareAccountVisibility(
      [{ account_id: A }, { account_id: B, user_deleted: false, merged: MERGED }],
      [open(A), open(B)]
    );
    expect(parity).toEqual({
      ...ZERO,
      compared: 2,
      cacheHidesLiveShows: 1,
      cacheHidesLiveShowsMerged: 1,
      merged: 1,
      mergedCompared: 1,
    });
  });

  test('a merged account live closes is agreement (#904)', () => {
    const parity = compareAccountVisibility([{ account_id: A, merged: MERGED }], [closed(A)]);
    expect(parity).toEqual({
      ...ZERO,
      compared: 1,
      hiddenAgreed: 1,
      merged: 1,
      mergedCompared: 1,
    });
  });

  test('a merged account live omits entirely is agreement, not one-sided (#904)', () => {
    const parity = compareAccountVisibility(
      [{ account_id: A }, { account_id: B, merged: MERGED }],
      [open(A)]
    );
    // Not compared: live never ruled on it.
    expect(parity).toEqual({ ...ZERO, compared: 1, cacheOnlyHidden: 1, merged: 1 });
    expect(classifyAccountVisibilityParity(parity).status).toBe('PASS');
  });

  test('an account the cache shows and live hides is the missing-marker shape', () => {
    // What #904 looked like from the other side before the fix: the cache
    // reads no marker, live hides the account.
    const parity = compareAccountVisibility([{ account_id: A }], [closed(A)]);
    expect(parity.cacheShowsLiveHides).toBe(1);
  });

  test('one-sided rows are split by whether their own mode shows them', () => {
    const parity = compareAccountVisibility(
      [{ account_id: A }, { account_id: B }],
      [open(A), open(C), hidden(D)]
    );
    expect(parity).toEqual({
      ...ZERO,
      compared: 1,
      cacheOnlyVisible: 1,
      liveOnlyVisible: 1,
      liveOnlyHidden: 1,
    });
  });
});

describe('classifyAccountVisibilityParity', () => {
  test('FAIL on a merged disagreement names the #904 premise', () => {
    const { status, detail } = classifyAccountVisibilityParity({
      ...ZERO,
      compared: 2,
      cacheHidesLiveShows: 1,
      cacheHidesLiveShowsMerged: 1,
      merged: 1,
      mergedCompared: 1,
    });
    expect(status).toBe('FAIL');
    expect(detail).toContain('#904 premise');
  });

  test('FAIL when the cache counts an account live hides', () => {
    const { status, detail } = classifyAccountVisibilityParity({
      ...ZERO,
      compared: 1,
      cacheShowsLiveHides: 1,
    });
    expect(status).toBe('FAIL');
    expect(detail).toContain('isVisibleAccount does not read');
  });

  test('FAIL on a non-merged hidden disagreement', () => {
    const { status, detail } = classifyAccountVisibilityParity({
      ...ZERO,
      compared: 1,
      cacheHidesLiveShows: 1,
    });
    expect(status).toBe('FAIL');
    expect(detail).toContain('user_hidden / user_deleted');
  });

  test('WARN when there is nothing at all', () => {
    expect(classifyAccountVisibilityParity(ZERO).status).toBe('WARN');
  });

  test('FAIL when rows exist but no id joins', () => {
    const { status, detail } = classifyAccountVisibilityParity({
      ...ZERO,
      cacheOnlyVisible: 1,
      liveOnlyVisible: 1,
    });
    expect(status).toBe('FAIL');
    expect(detail).toContain('id join');
  });

  test('WARN when a shown account is one-sided', () => {
    const { status } = classifyAccountVisibilityParity({
      ...ZERO,
      compared: 2,
      hiddenAgreed: 1,
      liveOnlyVisible: 1,
    });
    expect(status).toBe('WARN');
  });

  test('WARN when nothing is hidden anywhere: agreement on visible rows proves nothing', () => {
    const { status, detail } = classifyAccountVisibilityParity({ ...ZERO, compared: 3 });
    expect(status).toBe('WARN');
    expect(detail).toContain('unexercised');
  });

  test('a one-sided HIDDEN live row does not stop a PASS', () => {
    expect(
      classifyAccountVisibilityParity({ ...ZERO, compared: 2, hiddenAgreed: 1, liveOnlyHidden: 1 })
        .status
    ).toBe('PASS');
  });

  test('PASS says when the merged term went unexercised', () => {
    const { status, detail } = classifyAccountVisibilityParity({
      ...ZERO,
      compared: 2,
      hiddenAgreed: 1,
    });
    expect(status).toBe('PASS');
    expect(detail).toContain('#904 term is unexercised');
  });

  test('PASS with merged accounts live never returned claims agreement by absence only', () => {
    // The ledger entry is promoted on this sentence, so a merged document live
    // omitted must not read as a live confirmation (#928 review).
    const { status, detail } = classifyAccountVisibilityParity({
      ...ZERO,
      compared: 2,
      hiddenAgreed: 1,
      cacheOnlyHidden: 1,
      merged: 1,
    });
    expect(status).toBe('PASS');
    expect(detail).toContain('agree by absence only');
    expect(detail).toContain('live has not confirmed the #904 term');
    expect(detail).not.toContain('confirming');
  });

  test('PASS with a merged account live also hides says it was confirmed', () => {
    const { status, detail } = classifyAccountVisibilityParity({
      ...ZERO,
      compared: 2,
      hiddenAgreed: 1,
      merged: 1,
      mergedCompared: 1,
    });
    expect(status).toBe('PASS');
    expect(detail).toContain('confirming the #904 term');
    expect(detail).not.toContain('absence');
  });

  test('PASS with both kinds names each', () => {
    const { detail } = classifyAccountVisibilityParity({
      ...ZERO,
      compared: 2,
      hiddenAgreed: 1,
      cacheOnlyHidden: 1,
      merged: 2,
      mergedCompared: 1,
    });
    expect(detail).toContain('confirming the #904 term');
    expect(detail).toContain('1 more absent from live agree by absence only');
  });
});
