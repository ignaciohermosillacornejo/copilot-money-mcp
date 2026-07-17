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

import { z } from 'zod';
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
  /**
   * Numeric epoch timestamp (ms), or null. Drifted from the ISO-string shape
   * seen in the 2026-04 Chrome capture — the server changed the field's type
   * string→number since then, caught by the read-shape smoke on 2026-07-16
   * (#537).
   */
  latestBalanceUpdate: number | null;
}

export interface AccountsResponse {
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
    {}
  );
  return data.accounts;
}

/**
 * Zod mirror of `AccountNode` (AccountFields fragment) for warn-mode
 * read-shape validation (#537). Shared by the Accounts (list) and singular
 * Account queries — the latter has no wrapper, so its schema is assembled in
 * QUERY_RESPONSE_SCHEMAS from this node schema.
 */
export const AccountNodeSchema = z.looseObject({
  id: z.string(),
  itemId: z.string(),
  name: z.string(),
  balance: z.number(),
  liveBalance: z.boolean(),
  type: z.string(),
  subType: z.string().nullable(),
  mask: z.string().nullable(),
  isUserHidden: z.boolean(),
  isUserClosed: z.boolean(),
  isManual: z.boolean(),
  color: z.string().nullable(),
  limit: z.number().nullable(),
  institutionId: z.string().nullable(),
  hasHistoricalUpdates: z.boolean(),
  hasLiveBalance: z.boolean(),
  latestBalanceUpdate: z.number().nullable(),
});

/** Zod mirror of `AccountsResponse` (the list query). */
export const AccountsResponseSchema = z.looseObject({
  accounts: z.array(AccountNodeSchema),
});

/** Zod mirror of the singular `Account` query response (no wrapper exists). */
export const AccountResponseSchema = z.looseObject({
  account: AccountNodeSchema,
});
