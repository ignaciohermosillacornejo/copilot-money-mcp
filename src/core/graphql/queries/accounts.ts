/**
 * GraphQL query wrapper for the Accounts read path.
 *
 * Returns a flat array — Copilot's web UI uses a list query without
 * pagination (account counts are bounded). One round-trip per call.
 *
 * The captured query at docs/graphql-capture/operations/queries/Accounts.md
 * takes a `$filter: AccountFilter` and `$accountLink: Boolean = false` —
 * Phase 2 passes neither (server defaults). The accountLink branch is
 * unused; the response shape mirrors AccountFields.
 */

import type { GraphQLClient } from '../client.js';
import { ACCOUNTS } from '../operations.generated.js';

export interface AccountNode {
  id: string;
  itemId: string;
  name: string;
  balance: number;
  // Boolean flag in the real response (verified against Chrome capture
  // 2026-04-15) — indicates whether the account currently has a live
  // balance feed. Distinct from `hasLiveBalance` (capability flag, set
  // when Plaid offers live balance for the institution).
  liveBalance: boolean;
  type: string;
  subType: string | null;
  mask: string | null;
  isUserHidden: boolean;
  isUserClosed: boolean;
  isManual: boolean;
  color: string | null;
  limit: number | null;
  institutionId: string | null;
  hasHistoricalUpdates: boolean;
  hasLiveBalance: boolean;
  latestBalanceUpdate: string | null;
}

interface AccountsResponse {
  accounts: AccountNode[];
}

/**
 * Fetch all accounts via the Accounts query.
 *
 * No pagination — accounts are bounded (~10s per user). One GraphQL
 * round-trip returns the full set, which the SnapshotCache then caches
 * with a 1h TTL.
 */
export async function fetchAccounts(client: GraphQLClient): Promise<AccountNode[]> {
  const data = await client.query<Record<string, never>, AccountsResponse>(
    'Accounts',
    ACCOUNTS,
    {} as Record<string, never>
  );
  return data.accounts;
}
