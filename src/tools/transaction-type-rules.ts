/**
 * The `transaction_type` rules shared by get_transactions (cache mode) and
 * get_transactions_live (#843).
 *
 * Before this module each mode carried its own predicates and they had drifted
 * apart on the same data: live `refunds` was "every negative amount", so
 * paychecks counted as refunds, while cache `refunds` required a keyword in the
 * merchant name and matched almost nothing; live `credits` was "INCOME rows"
 * and cache `credits` was a keyword rule that excludes income, so the two sets
 * were disjoint. Each value now has ONE meaning, written down once here, and
 * each mode only adapts its own row shape to {@link TypeRuleRow}. A mode cannot
 * drift from the rule without changing this file, and
 * tests/tools/transaction-type-parity.test.ts runs every shared value through
 * both modes' tool paths over one fixture and requires the same ids.
 *
 * `foreign` and `duplicates` stay cache-only: they read location and
 * currency fields the GraphQL row does not carry.
 *
 * PIPELINE POSITION IS PART OF THE CONTRACT. Both modes apply these rules
 * after their row filters (transfers, deleted, excluded, split parents,
 * pending): live in postFilter step 9, cache in getTransactions' MODE 3. A
 * rule is a row-wise predicate, so it commutes with those filters, but
 * `exclude_excluded` sees different things in each mode, and keeping the
 * rules after it is what makes that the ONLY documented divergence (#854
 * review). Moving either mode's rule step changes parity.
 */

import { isIncomeCategory, isTransferCategory } from '../utils/categories.js';
import { getTransactionDisplayName, type Transaction } from '../models/index.js';
import type { TransactionNode } from '../core/graphql/queries/transactions.js';

/**
 * Copilot's transaction type, as each mode can observe it. Live reads it off
 * GraphQL's `type`; cache mode reads the decoded `income` / `internal_transfer`
 * booleans, which processTransaction derives from the same document `type`
 * string (a document with no `type` at all is an ordinary Plaid row, so it is
 * `regular`).
 */
export type TypeRuleKind = 'regular' | 'income' | 'internal_transfer';

/** The mode-neutral row every rule is evaluated against. */
export interface TypeRuleRow {
  kind: TypeRuleKind;
  amount: number;
  /** `null` when uncategorized. Each adapter folds `''` into `null`. */
  category_id: string | null;
  /**
   * Resolved display name of `category_id`, `null` when uncategorized or
   * unknown. LAZY in both adapters: computed by the adapter's `resolveName` on
   * first read, so only a rule that reads it pays for it, and no side table of
   * "rules that read the name" exists to fall out of date (#854 review).
   */
  readonly category_name: string | null;
  /** Display name of the transaction (merchant). Compared case-insensitively. */
  name: string;
  tag_ids: readonly string[];
}

/** Maps a non-empty category id to its known display name, or `null`. */
export type CategoryNameResolver = (categoryId: string) => string | null;

/** A `category_name` that calls `resolveName` once, on first read. */
function lazyCategoryName(
  categoryId: string | null,
  resolveName: CategoryNameResolver
): () => string | null {
  let resolved: string | null | undefined;
  return () => {
    if (resolved === undefined) resolved = categoryId ? resolveName(categoryId) : null;
    return resolved;
  };
}

/**
 * Cache-mode adapter. `kind` comes from the booleans processTransaction
 * derives from the document's `type` string; a document with neither flag is
 * a REGULAR row. `category_id: ''` (what the decoder writes on income and
 * transfer rows) is folded into `null`.
 *
 * Callers pass `resolveName` = lookupKnownCategoryName over the user's
 * categories (src/utils/categories.ts): the user's name, else the Plaid-taxonomy
 * name, else `null` — never getCategoryName()'s title-case / echo of an unknown
 * id, which would let `hsa_eligible` match text inside a raw id (#854 review).
 *
 * KNOWN CACHE-ONLY WIDENING: the Plaid-taxonomy tier. Old cache documents can
 * carry a Plaid id (`medical_pharmacies_and_supplements`) that resolves to a
 * name here; live rows carry opaque ids only, and live's resolver has no Plaid
 * tier. A cache row with a Plaid id has no live twin to disagree with, so this
 * widens cache mode rather than splitting a row's answer — the same shape as
 * inSpendingCategory's id checks below.
 */
export function cacheTypeRuleRow(txn: Transaction, resolveName: CategoryNameResolver): TypeRuleRow {
  const categoryId = txn.category_id ? txn.category_id : null;
  const categoryName = lazyCategoryName(categoryId, resolveName);
  return {
    kind:
      txn.internal_transfer === true
        ? 'internal_transfer'
        : txn.income === true
          ? 'income'
          : 'regular',
    amount: txn.amount,
    category_id: categoryId,
    get category_name() {
      return categoryName();
    },
    name: getTransactionDisplayName(txn),
    tag_ids: txn.tag_ids ?? [],
  };
}

/**
 * Live-mode adapter. `kind` is GraphQL's own `type`, and the empty
 * `categoryId` the server returns on income and transfer rows is folded into
 * `null`. Callers pass `resolveName` = the categories cache's id -> name map,
 * `?? null`; there is no Plaid tier in live mode.
 */
export function liveTypeRuleRow(
  n: TransactionNode,
  resolveName: CategoryNameResolver
): TypeRuleRow {
  const categoryId = n.categoryId ? n.categoryId : null;
  const categoryName = lazyCategoryName(categoryId, resolveName);
  return {
    kind:
      n.type === 'INCOME'
        ? 'income'
        : n.type === 'INTERNAL_TRANSFER'
          ? 'internal_transfer'
          : 'regular',
    amount: n.amount,
    category_id: categoryId,
    get category_name() {
      return categoryName();
    },
    name: n.name,
    tag_ids: n.tags.map((t) => t.id),
  };
}

/**
 * A category that counts as spending: the row has one, and it is not an
 * income or transfer category. The id checks matter in cache mode, where Plaid
 * taxonomy ids such as `income_wages` still appear on old documents; on live
 * rows (opaque ids) the `kind === 'regular'` test the rules also apply is what
 * keeps income and transfers out.
 *
 * Known cache-only widening, which live mode cannot mirror: isIncomeCategory /
 * isTransferCategory match any id CONTAINING income, payroll, salary, wage,
 * transfer or payment. A REGULAR cache row still carrying such a legacy id
 * (the #824 clear only fires on income/transfer-typed rows) is therefore not
 * in a spending category in cache mode, while its live twin, with an opaque
 * id, is. Opaque Firestore ids do not contain those words in practice.
 */
function inSpendingCategory(row: TypeRuleRow): boolean {
  if (!row.category_id) return false;
  return !isIncomeCategory(row.category_id) && !isTransferCategory(row.category_id);
}

/** Merchant-name keywords that mark a credit (cache mode's long-standing list). */
export const CREDIT_NAME_KEYWORDS = ['credit', 'cashback', 'reward', 'rebate', 'bonus'] as const;

/** Category-name keywords that mark a medical category. */
export const HSA_CATEGORY_KEYWORDS = [
  'health',
  'medical',
  'pharmac',
  'dental',
  'eye care',
  'vision',
] as const;

/** Merchant-name keywords that mark a medical merchant. */
export const HSA_MERCHANT_KEYWORDS = [
  'cvs',
  'walgreens',
  'pharmacy',
  'medical',
  'dental',
  'vision',
  'hospital',
] as const;

function includesAny(haystack: string | null, needles: readonly string[]): boolean {
  if (!haystack) return false;
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

/**
 * The rules. Copilot's sign convention: positive = money out (a purchase),
 * negative = money in.
 */
export const TRANSACTION_TYPE_RULES = {
  /**
   * A refund is money back on a purchase: a NEGATIVE, REGULAR row in a
   * spending category. Never INCOME (a paycheck is negative too, which is how
   * live mode used to count paychecks as refunds), never a transfer, never
   * uncategorized. No merchant-name keyword is required: a merchant refund
   * usually carries the merchant's own name.
   *
   * Why a category is required: without one, a negative REGULAR row is any
   * money coming in — a peer payment, a deposit, a manual adjustment — and
   * nothing on the row tells a refund apart from those. The category is the
   * only signal that the money came back against spending. The cost is real:
   * a refund not yet categorized is not counted until it is. `credits` admits
   * uncategorized rows because its merchant-name keyword is the signal there.
   */
  refunds: (row: TypeRuleRow) =>
    row.kind === 'regular' && row.amount < 0 && inSpendingCategory(row),

  /**
   * Cache mode's meaning, kept for both modes: a NEGATIVE, REGULAR row whose
   * merchant name contains credit, cashback, reward, rebate or bonus, and
   * whose category (if any) is not an income or transfer category. INCOME
   * rows are never credits. A categorized statement credit can also be a
   * refund; the two sets may overlap.
   */
  credits: (row: TypeRuleRow) =>
    row.kind === 'regular' &&
    row.amount < 0 &&
    (!row.category_id || inSpendingCategory(row)) &&
    includesAny(row.name, CREDIT_NAME_KEYWORDS),

  /**
   * A HEURISTIC for medical spending, not an eligibility determination: a
   * POSITIVE (purchase), REGULAR row whose category name contains health,
   * medical, pharmac(y), dental, eye care or vision, OR whose merchant name
   * contains cvs, walgreens, pharmacy, medical, dental, vision or hospital.
   */
  hsa_eligible: (row: TypeRuleRow) =>
    row.kind === 'regular' &&
    row.amount > 0 &&
    (includesAny(row.category_name, HSA_CATEGORY_KEYWORDS) ||
      includesAny(row.name, HSA_MERCHANT_KEYWORDS)),

  /** Any row carrying at least one tag. */
  tagged: (row: TypeRuleRow) => row.tag_ids.length > 0,
} as const satisfies Record<string, (row: TypeRuleRow) => boolean>;

export type SharedTransactionType = keyof typeof TRANSACTION_TYPE_RULES;

export const SHARED_TRANSACTION_TYPES = Object.keys(
  TRANSACTION_TYPE_RULES
) as readonly SharedTransactionType[];

export function isSharedTransactionType(value: string): value is SharedTransactionType {
  return Object.prototype.hasOwnProperty.call(TRANSACTION_TYPE_RULES, value);
}

/**
 * The rules in words, for the `transaction_type` parameter description of both
 * tools. Kept beside the predicates so a rule change and its description change
 * land in the same diff.
 */
export const TRANSACTION_TYPE_RULES_TEXT =
  'Same rule in cache and live mode (positive amount = money out). refunds: a negative ' +
  'REGULAR row in a spending category; never INCOME, a transfer or uncategorized. ' +
  'credits: a negative REGULAR row whose name has credit/cashback/reward/rebate/bonus and ' +
  'whose category is not income or transfer; may overlap refunds. hsa_eligible: a ' +
  'heuristic, not an eligibility ruling: a positive REGULAR row whose category name has ' +
  'health/medical/pharmac/dental/eye care/vision or whose name has ' +
  'cvs/walgreens/pharmacy/medical/dental/vision/hospital. tagged: has a tag.';
