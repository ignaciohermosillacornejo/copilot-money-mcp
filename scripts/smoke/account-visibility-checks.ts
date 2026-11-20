/**
 * Cache↔live account-visibility parity (#904) — the pure half.
 *
 * Cache mode decides which accounts count with `isVisibleAccount` over the
 * Firestore account document; live mode with `isVisibleAccountNode` over
 * GraphQL `isUserHidden` / `isUserClosed`. The two vocabularies share no field
 * names, so nothing but real data can say whether they agree. Each time they
 * did not, a user found it first: #82 (`user_deleted`), #624 (`user_hidden`
 * read from an extinct collection), #666 (`dashboard_active` proposed as a
 * third term, and wrong), and #904 (`merged` without `user_deleted`). This is
 * the check that compares them per account id.
 *
 * Kept apart from the runner (`account-visibility.ts`) so the comparison and
 * the verdict are unit-testable without a cache or a session
 * (`tests/scripts/account-visibility-checks.test.ts`).
 *
 * PII: only ids and booleans enter; the result carries counts only.
 */

import { isVisibleAccount, isVisibleAccountNode } from '../../src/models/account.js';

/** A cache account document as the visibility rule reads it. */
export type CacheVisibilityInput = Parameters<typeof isVisibleAccount>[0] & {
  account_id: string;
};

/** A live account row as the visibility rule reads it. */
export interface LiveVisibilityInput {
  id: string;
  isUserHidden: boolean;
  isUserClosed: boolean;
}

export interface AccountVisibilityParity {
  /** Account ids present in both modes: the rows actually compared. */
  compared: number;
  /** Compared ids the cache hides and live shows. */
  cacheHidesLiveShows: number;
  /** Of those, how many the cache hides because of `merged` (#904). */
  cacheHidesLiveShowsMerged: number;
  /** Compared ids the cache shows and live hides: the cache rule is missing a marker. */
  cacheShowsLiveHides: number;
  /** Compared ids both modes hide: the rows that make agreement mean something. */
  hiddenAgreed: number;
  /** Ids only the cache has, which the cache shows (stale cache, or a real gap). */
  cacheOnlyVisible: number;
  /** Ids only the cache has, which the cache hides: neither mode shows them. */
  cacheOnlyHidden: number;
  /** Ids only live has, which live shows (usually a stale cache). */
  liveOnlyVisible: number;
  /** Ids only live has, which live hides. */
  liveOnlyHidden: number;
  /** Cache documents carrying `merged`, compared or not: how much the #904 term was exercised. */
  merged: number;
}

export function compareAccountVisibility(
  cache: readonly CacheVisibilityInput[],
  live: readonly LiveVisibilityInput[]
): AccountVisibilityParity {
  const liveById = new Map(live.map((l) => [l.id, l]));
  const cacheIds = new Set(cache.map((c) => c.account_id));
  const p: AccountVisibilityParity = {
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
  };

  for (const c of cache) {
    if (c.merged !== undefined) p.merged++;
    const cacheVisible = isVisibleAccount(c);
    const l = liveById.get(c.account_id);
    if (!l) {
      if (cacheVisible) p.cacheOnlyVisible++;
      else p.cacheOnlyHidden++;
      continue;
    }
    p.compared++;
    const liveVisible = isVisibleAccountNode(l);
    if (!cacheVisible && liveVisible) {
      p.cacheHidesLiveShows++;
      if (c.merged !== undefined) p.cacheHidesLiveShowsMerged++;
    } else if (cacheVisible && !liveVisible) {
      p.cacheShowsLiveHides++;
    } else if (!cacheVisible && !liveVisible) {
      p.hiddenAgreed++;
    }
  }
  for (const l of live) {
    if (cacheIds.has(l.id)) continue;
    if (isVisibleAccountNode(l)) p.liveOnlyVisible++;
    else p.liveOnlyHidden++;
  }
  return p;
}

export type ParityStatus = 'PASS' | 'WARN' | 'FAIL';

/**
 * Turn the counts into a verdict.
 *
 * - FAIL when any compared account is visible in one mode and hidden in the
 *   other, or when at least one mode returned accounts but no id matched.
 * - WARN when neither mode returned any account.
 * - WARN when an account one mode SHOWS is missing from the other: the claim
 *   then covers only the overlap, typically because the cache is stale. A
 *   one-sided account that its own mode hides is not counted here — neither
 *   mode shows it, which is agreement.
 * - WARN when no account is hidden in both modes: every visible account
 *   agreeing says nothing about whether the two rules hide the same things.
 * - PASS otherwise.
 */
export function classifyAccountVisibilityParity(p: AccountVisibilityParity): {
  status: ParityStatus;
  detail: string;
} {
  const counts =
    `${p.compared} compared, ${p.cacheHidesLiveShows} cache-hides/live-shows ` +
    `(${p.cacheHidesLiveShowsMerged} merged), ${p.cacheShowsLiveHides} cache-shows/live-hides, ` +
    `${p.hiddenAgreed} hidden in both, ${p.cacheOnlyVisible} cache-only visible, ` +
    `${p.cacheOnlyHidden} cache-only hidden, ${p.liveOnlyVisible} live-only visible, ` +
    `${p.liveOnlyHidden} live-only hidden, ${p.merged} merged in cache`;

  if (p.cacheHidesLiveShows > 0 || p.cacheShowsLiveHides > 0) {
    const causes: string[] = [];
    if (p.cacheShowsLiveHides > 0) {
      causes.push(
        `${p.cacheShowsLiveHides} account(s) the cache counts are hidden or closed in live: the ` +
          `cache document marks them some way isVisibleAccount does not read`
      );
    }
    if (p.cacheHidesLiveShowsMerged > 0) {
      causes.push(
        `${p.cacheHidesLiveShowsMerged} merged account(s) are hidden by the cache but listed as ` +
          `open by live: the #904 premise (a merged account is not shown) does not hold on the ` +
          `wire. Check the Copilot app: if it shows them, the cache rule is wrong; if it does ` +
          `not, live mode counts them too`
      );
    }
    const otherHidden = p.cacheHidesLiveShows - p.cacheHidesLiveShowsMerged;
    if (otherHidden > 0) {
      causes.push(
        `${otherHidden} account(s) the cache hides by user_hidden / user_deleted are open in live`
      );
    }
    return {
      status: 'FAIL',
      detail:
        `${counts} — ${causes.join('; ')}. A stale cache can cause either: reopen Copilot to ` +
        `sync it and re-run before concluding drift`,
    };
  }
  const anyRows =
    p.compared + p.cacheOnlyVisible + p.cacheOnlyHidden + p.liveOnlyVisible + p.liveOnlyHidden;
  if (anyRows === 0) {
    return {
      status: 'WARN',
      detail: `${counts} — neither mode returned any account, so there was nothing to compare`,
    };
  }
  if (p.compared === 0) {
    return {
      status: 'FAIL',
      detail:
        `${counts} — no account id appears in both modes, so nothing was compared. ` +
        `Suspect the id join (cache account_id vs live id) before suspecting the data`,
    };
  }
  if (p.cacheOnlyVisible > 0 || p.liveOnlyVisible > 0) {
    return {
      status: 'WARN',
      detail:
        `${counts} — every compared account agrees, but an account one mode shows is missing ` +
        `from the other, so the claim covers only the ${p.compared} both returned. Usually a ` +
        `stale cache: reopen Copilot to sync it and re-run`,
    };
  }
  if (p.hiddenAgreed === 0 && p.cacheOnlyHidden === 0) {
    return {
      status: 'WARN',
      detail:
        `${counts} — every account is visible in both modes, so this run cannot tell whether ` +
        `the two rules hide the same accounts. Parity holds; the hiding rules are unexercised`,
    };
  }
  return {
    status: 'PASS',
    detail:
      `${counts} — visibility agrees on every compared account, including ` +
      `${p.hiddenAgreed + p.cacheOnlyHidden} that neither mode shows` +
      (p.merged === 0 ? ' (no merged account on this cache, so the #904 term is unexercised)' : ''),
  };
}
