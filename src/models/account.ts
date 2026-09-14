/**
 * Account model for Copilot Money data.
 *
 * Based on Firestore document structure documented in REVERSE_ENGINEERING_FINDING.md.
 */

import { z } from 'zod';

/**
 * Account schema with validation.
 */
/**
 * Schema for a single holding within an investment account.
 */
const AccountHoldingSchema = z
  .object({
    security_id: z.string().optional(),
    account_id: z.string().optional(),
    cost_basis: z.number().nullable().optional(),
    institution_price: z.number().optional(),
    institution_value: z.number().optional(),
    quantity: z.number().optional(),
    iso_currency_code: z.string().optional(),
    vested_quantity: z.number().nullable().optional(),
    vested_value: z.number().nullable().optional(),
  })
  .passthrough();

export const AccountSchema = z
  .object({
    // Required fields
    account_id: z.string(),
    current_balance: z.number(),

    // Account identification
    id: z.string().optional(),
    name: z.string().optional(),
    official_name: z.string().optional(),
    mask: z.string().optional(), // Last 4 digits
    nickname: z.string().optional(),

    // Account type
    account_type: z.string().optional(), // checking, savings, credit, investment, loan
    subtype: z.string().optional(),
    original_type: z.string().optional(),
    original_subtype: z.string().optional(),

    // Balances
    available_balance: z.number().optional(),
    original_current_balance: z.number().optional(),
    limit: z.number().nullable().optional(),

    // Institution
    item_id: z.string().optional(),
    institution_id: z.string().optional(),
    institution_name: z.string().optional(),

    // Metadata
    iso_currency_code: z.string().optional(),
    color: z.string().optional(),
    custom_color: z.string().optional(),
    logo: z.string().optional(),
    logo_content_type: z.string().optional(),
    _origin: z.string().optional(),

    // Flags
    historical_update: z.boolean().optional(),
    dashboard_active: z.boolean().optional(),
    savings_active: z.boolean().optional(),
    provider_deleted: z.boolean().optional(),
    live_balance_backend_disabled: z.boolean().optional(),
    live_balance_user_disabled: z.boolean().optional(),
    is_manual: z.boolean().optional(),
    user_hidden: z.boolean().optional(),

    // Visibility - accounts marked as deleted by user or merged into other accounts
    user_deleted: z.boolean().optional(),

    // Ownership & linkage
    user_id: z.string().optional(),
    // Stable account identifier that survives re-linking (the provider-side ID
    // doesn't persist across reconnects; persistent_account_id does).
    persistent_account_id: z.string().optional(),
    // Last automated balance snapshot — used when a live fetch isn't available.
    last_auto_current_balance: z.number().optional(),
    // IDs of financial_goals linked to this account (funds toward emergency fund, etc.).
    financial_goal_ids: z.array(z.string()).optional(),

    // Investment fields
    holdings: z.array(AccountHoldingSchema).optional(),
    holdings_initialized: z.boolean().optional(),
    investments_performance_enabled: z.boolean().optional(),

    // Timestamps
    latest_balance_update: z.string().optional(),

    // Grouping
    group_id: z.string().optional(),
    group_leader: z.boolean().optional(),

    // Verification
    verification_status: z.string().nullable().optional(),

    // Complex objects
    metadata: z.record(z.string(), z.unknown()).optional(),
    merged: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type Account = z.infer<typeof AccountSchema>;

/**
 * Get the best display name for an account.
 */
export function getAccountDisplayName(account: Account): string {
  return account.name ?? account.official_name ?? 'Unknown';
}

/**
 * Extended account with computed display_name field.
 */
export interface AccountWithDisplayName extends Account {
  display_name: string;
}

/**
 * Add display_name to an account object.
 */
export function withDisplayName(account: Account): AccountWithDisplayName {
  return {
    ...account,
    display_name: getAccountDisplayName(account),
  };
}

/**
 * ACCOUNT VISIBILITY — one rule, two field vocabularies (#683).
 *
 * "Is this an account the user still counts as part of their finances?" The
 * cache document and the GraphQL wire spell the same idea differently, so the
 * two predicates cannot share a body — but they live here, adjacent to the
 * schema that declares the flags, so a reader finds both at once and a new
 * surface cannot apply one while being unaware of the other.
 *
 * They are here rather than in `src/tools/tools.ts` deliberately: exporting a
 * domain predicate from a ~3k-line tools module means `src/core/` and
 * `src/tools/live/` cannot import it without pulling that module in.
 *
 * Why the rule needed a name at all: it existed as an inline filter at ONE of
 * the surfaces that needed it. `get_accounts` filtered; `get_holdings` loaded
 * the same accounts and did not, so a re-linked brokerage contributed its
 * positions twice while the account list looked correct (#683). The live pair
 * had the identical split.
 */

/** Cache-document form: `user_deleted` (merged/removed) or `user_hidden`. */
export function isVisibleAccount(account: Pick<Account, 'user_deleted' | 'user_hidden'>): boolean {
  return account.user_deleted !== true && account.user_hidden !== true;
}

/**
 * GraphQL-wire form: `isUserClosed` / `isUserHidden`, both always-present
 * booleans rather than optional flags.
 *
 * Structurally typed rather than importing `AccountNode`, so `src/models/`
 * keeps no dependency on the GraphQL layer.
 */
export function isVisibleAccountNode(account: {
  isUserHidden: boolean;
  isUserClosed: boolean;
}): boolean {
  return !account.isUserHidden && !account.isUserClosed;
}
