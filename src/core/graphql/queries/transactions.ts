/**
 * GraphQL query wrapper for the Transactions read path.
 *
 * Pure functions that translate a subset of the get_transactions tool
 * arg shape into the TransactionFilter + TransactionSort input shapes
 * captured from Copilot's web UI on 2026-04-23.
 */

export type ReadTransactionType = 'REGULAR' | 'INCOME' | 'INTERNAL_TRANSFER' | 'RECURRING';

export interface DateRange {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

export interface AccountRef {
  accountId: string;
  itemId: string;
}

export interface TransactionFilterInput {
  dates?: DateRange[];
  accountIds?: AccountRef[];
  categoryIds?: string[];
  recurringIds?: string[];
  tagIds?: string[];
  types?: ReadTransactionType[];
  isReviewed?: boolean;
  matchString?: string;
}

export interface BuildFilterOptions {
  startDate?: string;
  endDate?: string;
  accountRefs?: AccountRef[];
  categoryIds?: string[];
  recurringIds?: string[];
  tagIds?: string[];
  types?: ReadTransactionType[];
  isReviewed?: boolean;
  matchString?: string;
}

const FAR_PAST = '1970-01-01';
const FAR_FUTURE = '9999-12-31';

export function buildTransactionFilter(opts: BuildFilterOptions): TransactionFilterInput | null {
  const filter: TransactionFilterInput = {};
  let hasAny = false;

  if (opts.startDate || opts.endDate) {
    filter.dates = [{ from: opts.startDate ?? FAR_PAST, to: opts.endDate ?? FAR_FUTURE }];
    hasAny = true;
  }
  if (opts.accountRefs?.length) {
    filter.accountIds = opts.accountRefs;
    hasAny = true;
  }
  if (opts.categoryIds?.length) {
    filter.categoryIds = opts.categoryIds;
    hasAny = true;
  }
  if (opts.recurringIds?.length) {
    filter.recurringIds = opts.recurringIds;
    hasAny = true;
  }
  if (opts.tagIds?.length) {
    filter.tagIds = opts.tagIds;
    hasAny = true;
  }
  if (opts.types?.length) {
    filter.types = opts.types;
    hasAny = true;
  }
  if (opts.isReviewed !== undefined) {
    filter.isReviewed = opts.isReviewed;
    hasAny = true;
  }
  if (opts.matchString !== undefined && opts.matchString !== '') {
    filter.matchString = opts.matchString;
    hasAny = true;
  }

  return hasAny ? filter : null;
}
