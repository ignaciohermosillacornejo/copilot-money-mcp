/**
 * Account model for Copilot Money data.
 *
 * Based on Firestore document structure documented in REVERSE_ENGINEERING_FINDING.md.
 */

import { z } from 'zod';

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

/**
 * Account schema with validation.
 */
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
    /**
     * NOT a visibility flag — despite the name, and despite #624 listing it
     * alongside `nickname` and `user_hidden` as the third "account
     * customization" Copilot migrated onto the account document (#666).
     *
     * MEASURED 2026-09-16 against a real cache (counts only): of 21 account
     * documents, 8 carry `dashboard_active: false` and 13 carry `true`, and
     * the split is exactly account TYPE — every `false` document is an
     * investment account, every `true` one is not. It is not visibility: 6 of
     * the 8 `false` documents carry no `user_hidden` at all, and a live
     * `Accounts` round-trip the same day returned all 6 with
     * `isUserHidden: false, isUserClosed: false`. Filtering the default
     * `get_accounts` on it — the change #666 floated — would have dropped
     * every investment account from the account list.
     *
     * It is also absent from `AccountFields`, the fragment Copilot's own
     * client requests for an account, so live mode has no counterpart: any
     * cache-side behaviour built on it would be a cache/live divergence of the
     * #663/#683 kind, invisible to the parity tests because only one mode has
     * the field.
     *
     * So it stays decoded and deliberately unfiltered, and the claim is not
     * left as prose: `scripts/smoke/cache.ts` re-checks the independence above
     * on whatever real cache it runs, and the assumption is filed as
     * `FirestoreAccount.dashboard_active:notVisibility` in
     * `src/conformance/ledger.ts`.
     */
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

/**
 * Cache-document form: `user_deleted` (merged/removed) or `user_hidden`.
 *
 * `dashboard_active` is deliberately NOT a third term. It reads like one and
 * #624 named it one; the measurement recorded on its declaration above shows
 * it tracks account type, and the accounts it is `false` for are reported by
 * the server as neither hidden nor closed. Adding it here would hide every
 * investment account (#666).
 */
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

/**
 * The label to show for an account: the user's Copilot nickname when they have
 * set a usable one, the provider's label otherwise (#660, #663).
 *
 * Empty-string handling is the whole reason this is a function. `nickname` is
 * a bare optional string on {@link AccountSchema} — no `.min(1)` — so `''` is
 * a value the decoder can produce for a cleared nickname, and the two call
 * sites disagreed about it: `getAccounts` used truthiness (`''` falls through
 * to the provider label) while `getHoldings` used `??` (`''` wins, and the row
 * reports an empty name). Same account, two names — #663 again, in the
 * opposite direction, introduced by the commit that fixed #663.
 *
 * Truthiness is the right branch: an account whose nickname is blank should
 * still be identifiable, so a blank one is not a name. The rule is about
 * IDENTIFIABILITY, so it applies to all three inputs, not just the nickname:
 * `name: '   '` is exactly as unidentifiable as `nickname: '   '`, and it is
 * representable — `processAccount` in `src/core/decoder.ts` drops an account
 * only when `name` AND `official_name` are both absent, so a whitespace-only
 * `name` beside a perfectly good `official_name` reaches here.
 *
 * Sibling of {@link isVisibleAccount}, and here for the same reason — the rule
 * existed at one site and a second surface reimplemented it slightly
 * differently.
 */
export function preferredAccountName(
  account: Pick<Account, 'nickname' | 'name' | 'official_name'>
): string | undefined {
  // Blank-detection trims, the returned value does not. `'   '` is truthy, so
  // bare truthiness would hand back a label that is exactly as unidentifiable
  // as `''` — the case the rule above exists to reject. Nothing upstream trims:
  // all three are `z.string().optional()` with no transform and the decoder
  // passes them through. Trimming the ANSWER would be a different decision — it
  // would silently rewrite a name the user typed — so only the blank test is
  // trimmed.
  //
  // One predicate applied three times rather than three `||` operands with one
  // of them special-cased: a rule stated for one input and applied to another
  // is how the two call sites drifted in the first place (#663).
  const usable = (s?: string): string | undefined => (s?.trim() ? s : undefined);
  return usable(account.nickname) || usable(account.name) || usable(account.official_name);
}
