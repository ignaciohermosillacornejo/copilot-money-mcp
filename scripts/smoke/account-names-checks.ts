/**
 * Cache↔live account-naming parity (#665) — the pure half.
 *
 * #660 made cache-mode `get_accounts` report the user's Copilot nickname as
 * `name`. Live-mode `get_accounts_live` does no nickname handling at all: it
 * returns GraphQL `AccountNode.name` as sent, and the two modes agree only
 * because the server already resolves the nickname on the wire
 * (`AccountNode.name:resolvesNickname` in `src/conformance/ledger.ts`). If
 * Copilot changed which label it surfaces, or the cache's `nickname` semantics
 * shifted, the modes would silently diverge again — the read-shape gate checks
 * KEYS, not what a key means.
 *
 * Kept apart from the runner (`account-names.ts`) so the comparison and the
 * verdict are unit-testable without a cache or a session
 * (`tests/scripts/account-names-checks.test.ts`).
 *
 * PII: names are compared in memory and never leave these functions. The
 * result and the verdict carry counts only.
 */

import { preferredAccountName } from '../../src/models/account.js';

/** The raw cache fields the nickname rule reads, keyed by account id. */
export interface CacheAccountLabels {
  account_id: string;
  nickname?: string;
  name?: string;
  official_name?: string;
}

export interface AccountNameParity {
  /** Account ids present in both modes — the rows actually compared. */
  compared: number;
  /** Compared ids whose `name` differs between the two modes. */
  mismatched: number;
  /** Ids only the cache returned (e.g. a stale cache, or an account added since). */
  cacheOnly: number;
  /** Ids only live returned. */
  liveOnly: number;
  /**
   * Compared accounts whose usable nickname differs from the provider label —
   * the only rows on which "cache reports the nickname" and "cache reports the
   * provider label" predict different answers. Zero means this run could not
   * tell the two sources apart, however many rows agreed.
   */
  discriminating: number;
}

/**
 * Compare `name` per account id between the cache tool's rows and the live
 * tool's rows, and count how many compared rows could tell a nickname from a
 * provider label.
 */
export function compareAccountNames(
  cacheNames: ReadonlyMap<string, string | undefined>,
  liveNames: ReadonlyMap<string, string | undefined>,
  cacheLabels: readonly CacheAccountLabels[]
): AccountNameParity {
  const labelsById = new Map(cacheLabels.map((l) => [l.account_id, l]));
  let compared = 0;
  let mismatched = 0;
  let cacheOnly = 0;
  let discriminating = 0;

  for (const [id, cacheName] of cacheNames) {
    if (!liveNames.has(id)) {
      cacheOnly++;
      continue;
    }
    compared++;
    if (cacheName !== liveNames.get(id)) mismatched++;

    const labels = labelsById.get(id);
    if (labels?.nickname?.trim()) {
      // The provider label is what the account would be called with no
      // nickname: the same rule, minus the nickname operand.
      const providerLabel = preferredAccountName({
        name: labels.name,
        official_name: labels.official_name,
      });
      if (preferredAccountName(labels) !== providerLabel) discriminating++;
    }
  }

  let liveOnly = 0;
  for (const id of liveNames.keys()) if (!cacheNames.has(id)) liveOnly++;

  return { compared, mismatched, cacheOnly, liveOnly, discriminating };
}

export type ParityStatus = 'PASS' | 'WARN' | 'FAIL';

/**
 * Turn the counts into a verdict.
 *
 * - FAIL when any compared account is named differently, or when both modes
 *   returned accounts but no id matched — a join that resolves nothing is a
 *   broken check, not a clean one.
 * - WARN when every compared account agreed but none was discriminating: the
 *   two modes agree, and this data cannot say whether they agree on the
 *   nickname or on the provider label. Not a failure (the user simply has no
 *   such nickname), but never reported as coverage.
 * - PASS otherwise.
 */
export function classifyAccountNameParity(p: AccountNameParity): {
  status: ParityStatus;
  detail: string;
} {
  const counts =
    `${p.compared} compared, ${p.mismatched} mismatched, ${p.discriminating} discriminating ` +
    `(nickname differs from provider label), ${p.cacheOnly} cache-only, ${p.liveOnly} live-only`;

  if (p.mismatched > 0) {
    return {
      status: 'FAIL',
      detail:
        `${counts} — cache get_accounts and get_accounts_live name ${p.mismatched} account(s) ` +
        `differently. Either the server stopped resolving the nickname into AccountNode.name, ` +
        `or the cache's nickname semantics shifted (or the cache is stale — reopen Copilot ` +
        `to sync it and re-run before concluding drift)`,
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
  if (p.discriminating === 0) {
    return {
      status: 'WARN',
      detail:
        `${counts} — every compared name agrees, but no account has a nickname that differs ` +
        `from its provider label, so this run CANNOT distinguish "both report the nickname" ` +
        `from "both report the provider label". Parity holds; the nickname claim is unexercised`,
    };
  }
  return {
    status: 'PASS',
    detail:
      `${counts} — names agree on every compared account, including ${p.discriminating} ` +
      `where the nickname and the provider label differ, so both modes report the nickname`,
  };
}
