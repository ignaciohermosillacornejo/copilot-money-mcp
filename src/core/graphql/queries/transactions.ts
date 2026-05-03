/**
 * GraphQL query wrapper for the Transactions read path.
 *
 * Pure functions that translate a subset of the get_transactions tool
 * arg shape into the TransactionFilter + TransactionSort input shapes
 * captured from Copilot's web UI on 2026-04-23.
 */

import type { GraphQLClient } from '../client.js';
import { TRANSACTIONS } from '../operations.generated.js';

/**
 * TransactionType enum accepted by the read-side TransactionFilter.
 *
 * Verified against the live endpoint on 2026-04-24: the enum is exactly
 * `REGULAR | INCOME | INTERNAL_TRANSFER`. The web UI shows "Recurring"
 * as a filter option, but it maps to `recurringIds` (series linkage),
 * not a fourth enum value — passing `RECURRING` returns
 * BAD_USER_INPUT from the server.
 */
export type ReadTransactionType = 'REGULAR' | 'INCOME' | 'INTERNAL_TRANSFER';

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

export type TransactionSortField = 'DATE' | 'AMOUNT';
export type SortDirection = 'ASC' | 'DESC';

export interface TransactionSortInput {
  field: TransactionSortField;
  direction: SortDirection;
}

export function buildTransactionSort(
  overrides?: Partial<TransactionSortInput>
): TransactionSortInput[] {
  return [
    {
      field: overrides?.field ?? 'DATE',
      direction: overrides?.direction ?? 'DESC',
    },
  ];
}

export interface TransactionTag {
  id: string;
  name: string;
  colorName: string;
}

export interface TransactionGoalRef {
  id: string;
  name: string;
}

export interface TransactionNode {
  id: string;
  accountId: string;
  itemId: string;
  categoryId: string | null;
  recurringId: string | null;
  parentId: string | null;
  isReviewed: boolean;
  isPending: boolean;
  amount: number;
  date: string;
  name: string;
  type: ReadTransactionType;
  userNotes: string | null;
  tipAmount: number | null;
  suggestedCategoryIds: string[];
  isoCurrencyCode: string | null;
  createdAt: number;
  tags: TransactionTag[];
  goal: TransactionGoalRef | null;
}

export interface TransactionEdge {
  cursor: string;
  node: TransactionNode;
}

export interface TransactionsPage {
  edges: TransactionEdge[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
}

export interface PaginateOptions {
  startDate?: string;
}

export type TransactionsFetcher = (after: string | null) => Promise<TransactionsPage>;

// Server caps page size at 25, so 1000 pages = 25k transactions — far above any
// realistic personal-finance window. The cap exists to escape pathological
// server responses (empty edges + hasNextPage=true + stable cursor) that
// would otherwise spin forever, since the startDate early-exit only fires
// when edges is non-empty.
const MAX_PAGES = 1000;

/**
 * Paginate a Transactions query until no more pages are needed.
 *
 * Pure pagination driver — the fetcher callback owns the actual
 * network call. Early-exits when the trailing edge of a page precedes
 * opts.startDate (requires DATE DESC sort to be meaningful). Otherwise
 * follows pageInfo.endCursor until pageInfo.hasNextPage === false, with
 * a hard MAX_PAGES safety cap.
 */
export async function paginateTransactions(
  fetcher: TransactionsFetcher,
  opts: PaginateOptions
): Promise<TransactionNode[]> {
  const collected: TransactionNode[] = [];
  let cursor: string | null = null;

  for (let pageCount = 0; pageCount < MAX_PAGES; pageCount++) {
    const page = await fetcher(cursor);
    for (const edge of page.edges) {
      collected.push(edge.node);
    }

    if (!page.pageInfo.hasNextPage) return collected;

    if (opts.startDate && page.edges.length > 0) {
      const tail = page.edges[page.edges.length - 1]!.node.date;
      if (tail < opts.startDate) return collected;
    }

    cursor = page.pageInfo.endCursor;
    if (cursor === null) return collected;
  }

  throw new Error(
    `paginateTransactions exceeded max page count (${MAX_PAGES}) — server kept returning hasNextPage=true. Likely a server-side pagination bug; narrow the date range or report upstream.`
  );
}

export interface FetchTransactionsArgs {
  first: number;
  after: string | null;
  filter: TransactionFilterInput | null;
  sort: TransactionSortInput[];
}

interface TransactionsResponse {
  transactions: TransactionsPage;
}

/**
 * Single GraphQL round-trip fetching one page of transactions.
 *
 * Delegates transport and auth to the GraphQLClient. Returns the raw
 * page for paginateTransactions to drive.
 */
export async function fetchTransactionsPage(
  client: GraphQLClient,
  args: FetchTransactionsArgs
): Promise<TransactionsPage> {
  const data = await client.query<FetchTransactionsArgs, TransactionsResponse>(
    'Transactions',
    TRANSACTIONS,
    args
  );
  return data.transactions;
}
