import { mock } from 'bun:test';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import type { EditAccountResponse } from '../../src/core/graphql/accounts.js';
import type {
  EditBudgetMonthlyResponse,
  EditBudgetResponse,
} from '../../src/core/graphql/budgets.js';
import type {
  CreateCategoryResponse,
  DeleteCategoryResponse,
  EditCategoryResponse,
} from '../../src/core/graphql/categories.js';
import type {
  CreateRecurringResponse,
  DeleteRecurringResponse,
  EditRecurringResponse,
} from '../../src/core/graphql/recurrings.js';
import type {
  CreateTagResponse,
  DeleteTagResponse,
  EditTagResponse,
} from '../../src/core/graphql/tags.js';
import type {
  AddTransactionToRecurringResponse,
  BulkEditTransactionsResponse,
  CreatedTransaction,
  CreateTransactionResponse,
  DeleteTransactionResponse,
  EditTransactionResponse,
  SplitTransactionResponse,
} from '../../src/core/graphql/transactions.js';
import type { AccountsResponse } from '../../src/core/graphql/queries/accounts.js';
import type { AggregatedHoldingsResponse } from '../../src/core/graphql/queries/aggregated-holdings.js';
import type { BalanceHistoryResponse } from '../../src/core/graphql/queries/balance-history.js';
import type { CategoriesResponse } from '../../src/core/graphql/queries/categories.js';
import type { HoldingsResponse } from '../../src/core/graphql/queries/holdings.js';
import type { InvestmentAllocationResponse } from '../../src/core/graphql/queries/investment-allocation.js';
import type { InvestmentBalanceResponse } from '../../src/core/graphql/queries/investment-balance.js';
import type { InvestmentLiveBalanceResponse } from '../../src/core/graphql/queries/investment-live-balance.js';
import type { MonthlySpendResponse } from '../../src/core/graphql/queries/monthly-spend.js';
import type { NetworthResponse } from '../../src/core/graphql/queries/networth.js';
import type { RecurringsResponse } from '../../src/core/graphql/queries/recurrings.js';
import type { SecurityPricesResponse } from '../../src/core/graphql/queries/security-prices.js';
import type { SecurityPricesHighFrequencyResponse } from '../../src/core/graphql/queries/security-prices-high-frequency.js';
import type { TagsResponse } from '../../src/core/graphql/queries/tags.js';
import type { TopMoversResponse } from '../../src/core/graphql/queries/top-movers.js';
import type { TransactionsResponse } from '../../src/core/graphql/queries/transactions.js';
import type { UpcomingRecurringsResponse } from '../../src/core/graphql/queries/upcoming-recurrings.js';
import type { UserResponse } from '../../src/core/graphql/queries/user.js';

export interface RecordedCall {
  op: string;
  query: string;
  variables: unknown;
}

export type MockGraphQLClient = GraphQLClient & {
  _calls: RecordedCall[];
};

/**
 * Operation name → response type, derived from the production response
 * types in `src/core/graphql/`. This is what makes mocks type-safe: a
 * canned response whose shape drifts from what the wrapper actually
 * expects fails `tsc` instead of silently keeping the suite green
 * (the #419 failure class — mock encodes the same wrong assumption as
 * the code under test).
 *
 * When adding a GraphQL operation, export its response interface from the
 * domain module and register it here.
 */
export interface GraphQLOperationResponses {
  // Mutations
  AddTransactionToRecurring: AddTransactionToRecurringResponse;
  CreateCategory: CreateCategoryResponse;
  CreateRecurring: CreateRecurringResponse;
  CreateTag: CreateTagResponse;
  CreateTransaction: CreateTransactionResponse;
  DeleteCategory: DeleteCategoryResponse;
  DeleteRecurring: DeleteRecurringResponse;
  DeleteTag: DeleteTagResponse;
  DeleteTransaction: DeleteTransactionResponse;
  EditAccount: EditAccountResponse;
  EditBudget: EditBudgetResponse;
  EditBudgetMonthly: EditBudgetMonthlyResponse;
  EditCategory: EditCategoryResponse;
  EditRecurring: EditRecurringResponse;
  EditTag: EditTagResponse;
  EditTransaction: EditTransactionResponse;
  BulkEditTransactions: BulkEditTransactionsResponse;
  SplitTransaction: SplitTransactionResponse;
  // Queries (live reads)
  Accounts: AccountsResponse;
  AggregatedHoldings: AggregatedHoldingsResponse;
  BalanceHistory: BalanceHistoryResponse;
  Categories: CategoriesResponse;
  Holdings: HoldingsResponse;
  InvestmentAllocation: InvestmentAllocationResponse;
  InvestmentBalance: InvestmentBalanceResponse;
  InvestmentLiveBalance: InvestmentLiveBalanceResponse;
  MonthlySpend: MonthlySpendResponse;
  Networth: NetworthResponse;
  Recurrings: RecurringsResponse;
  SecurityPrices: SecurityPricesResponse;
  SecurityPricesHighFrequency: SecurityPricesHighFrequencyResponse;
  Tags: TagsResponse;
  TopMovers: TopMoversResponse;
  Transactions: TransactionsResponse;
  UpcomingRecurrings: UpcomingRecurringsResponse;
  User: UserResponse;
}

export type MockResponseEntry<Op extends keyof GraphQLOperationResponses> =
  | GraphQLOperationResponses[Op]
  | Error
  | ((variables: unknown) => GraphQLOperationResponses[Op] | Error);

export type MockResponsesByOp = {
  [Op in keyof GraphQLOperationResponses]?: MockResponseEntry<Op>;
};

/**
 * Build a fake GraphQLClient for tests.
 *
 * `responsesByOp` maps operation name → canned response. Keys must be
 * known operation names and values must conform to that operation's
 * response type (see GraphQLOperationResponses). Values may be:
 *  - a response object that will be returned from `client.mutate(...)`,
 *  - a function `(variables) => response` for per-call dynamic responses,
 *  - an `Error` instance, in which case the mutate call rejects with it.
 *
 * All calls are recorded on `client._calls` for later assertion:
 *   expect(client._calls[0].op).toBe('EditTransaction')
 *   expect(client._calls[0].variables).toEqual({ ... })
 */
export function createMockGraphQLClient(responsesByOp: MockResponsesByOp = {}): MockGraphQLClient {
  const calls: RecordedCall[] = [];
  const entries = responsesByOp as Record<string, unknown>;
  const dispatch = (op: string, query: string, variables: unknown): Promise<unknown> => {
    calls.push({ op, query, variables });
    if (!(op in entries)) {
      return Promise.reject(new Error(`No mock response for operation: ${op}`));
    }
    const entry = entries[op];
    if (entry instanceof Error) return Promise.reject(entry);
    if (typeof entry === 'function') {
      try {
        const resolved = (entry as (v: unknown) => unknown)(variables);
        if (resolved instanceof Error) return Promise.reject(resolved);
        return Promise.resolve(resolved);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }
    return Promise.resolve(entry);
  };
  const client = {
    mutate: mock(dispatch),
    // Same transport in production (GraphQLClient.query delegates to mutate);
    // mirror that here so live-read wrappers work against this mock too.
    query: mock(dispatch),
    _calls: calls,
  };
  return client as unknown as MockGraphQLClient;
}

/** Fields a fixture may set on {@link serverTransaction}; tags may be id-only. */
export type ServerTransactionFields = Omit<Partial<CreatedTransaction>, 'tags'> & {
  id: string;
  tags?: Array<{ id: string; name?: string; colorName?: string }>;
};

/**
 * A transaction as the transaction MUTATIONS return it (their TransactionFields
 * fragment — see CreatedTransaction), with neutral defaults for every field a
 * fixture does not care about.
 *
 * The response types are the full selection because since #821 the live cache
 * is patched from the returned row, so every field is consumed; a fixture that
 * spelled out only the handful of fields one assertion reads no longer
 * type-checks. Tags may be given id-only — name/colorName are defaulted.
 */
export function serverTransaction(fields: ServerTransactionFields): CreatedTransaction {
  const { tags, ...rest } = fields;
  return {
    name: 'Coffee Shop',
    date: '2024-01-15',
    amount: 50,
    categoryId: 'c',
    type: 'REGULAR',
    accountId: 'acct1',
    itemId: 'item1',
    isPending: false,
    isReviewed: false,
    createdAt: 0,
    recurringId: null,
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    goal: null,
    ...rest,
    tags: (tags ?? []).map((t) => ({
      id: t.id,
      name: t.name ?? `tag ${t.id}`,
      colorName: t.colorName ?? 'BLUE1',
    })),
  };
}

/** {@link serverTransaction} for bulkEditTransactions, whose fragment also selects parentId. */
export function bulkServerTransaction(
  fields: ServerTransactionFields & { parentId?: string | null }
): CreatedTransaction & { parentId: string | null } {
  return { ...serverTransaction(fields), parentId: fields.parentId ?? null };
}

/**
 * Canned `BulkEditTransactions` response that echoes every requested id back
 * as updated, with the requested input applied.
 *
 * Shared because the shape is fiddly in a way that matters: the server returns
 * `updated`/`failed` rather than a single transaction, and the wrapper diffs
 * `updated` against the ids it asked for to detect silently-skipped rows. A
 * hand-rolled echo that forgets an id would look like a skip and fail the call
 * for the wrong reason.
 */
export function bulkEditEcho(vars: unknown): GraphQLOperationResponses['BulkEditTransactions'] {
  const v = vars as {
    filter: { ids: { id: string }[] };
    input: {
      isReviewed?: boolean;
      categoryId?: string;
      type?: 'REGULAR' | 'INCOME' | 'INTERNAL_TRANSFER';
      addTagIds?: string[];
      removeTagIds?: string[];
    };
  };
  return {
    bulkEditTransactions: {
      updated: v.filter.ids.map((t) =>
        bulkServerTransaction({
          id: t.id,
          name: 'Coffee Shop',
          // Mirror the verified server behaviour: INCOME/INTERNAL_TRANSFER clear
          // the category regardless of what categoryId was sent.
          categoryId:
            v.input.type === 'INCOME' || v.input.type === 'INTERNAL_TRANSFER'
              ? ''
              : (v.input.categoryId ?? 'c'),
          userNotes: null,
          isReviewed: v.input.isReviewed ?? true,
          type: v.input.type ?? ('REGULAR' as const),
          date: '2024-01-15',
          amount: 50,
          tags: (v.input.addTagIds ?? []).map((id) => ({ id })),
        })
      ),
      failed: [],
    },
  };
}
