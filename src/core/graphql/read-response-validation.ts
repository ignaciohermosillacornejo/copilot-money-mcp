/**
 * Warn-mode Zod validation for GraphQL READ query response payloads
 * (issue #537).
 *
 * The mutation write path already validates response shapes warn-mode
 * (response-validation.ts, runtime:zod-warn). This module is the same idea
 * pointed at read queries: the hand-written `*Response` interfaces in
 * queries/*.ts are only spot-checked on load-bearing fields by the Tier-0
 * read smoke, so a non-load-bearing field going missing or changing type
 * degrades output silently. Here every registered read response is validated
 * against a looseObject Zod mirror; drift is counted and logged, never thrown
 * or dropped.
 *
 * Semantics — strictly WARN-MODE (never throw, never alter the payload):
 * - Schemas mirror the raw `*Response` shape the client returns (before any
 *   wrapper post-processing such as the categories flatten), using
 *   `z.looseObject` so NEW server fields and `__typename` flow through
 *   without warnings. Drift = a field we READ going missing or changing type.
 * - Reads whose nodes feed WRITES (Transactions) are intentionally NOT
 *   registered here — they keep their own drop-based check
 *   (read-validation.ts). `validateQueryResponse` skips any unregistered
 *   operation silently: an unregistered read is legitimate `unverified`
 *   ledger debt, and the ledger + bijection tests provide build-time safety
 *   without a runtime log-flood.
 *
 * This is the `runtime:read-zod-warn` oracle in the conformance ledger: every
 * `Query.<field>:response` surface it gates must have a schema registered
 * here — enforced bidirectionally by tests/conformance/ledger.test.ts.
 */

import type { ZodType } from 'zod';
import { normalizeDriftPath } from './drift-path.js';
import { AccountResponseSchema, AccountsResponseSchema } from './queries/accounts.js';
import { AggregatedHoldingsResponseSchema } from './queries/aggregated-holdings.js';
import { BalanceHistoryResponseSchema } from './queries/balance-history.js';
import { CategoriesResponseSchema } from './queries/categories.js';
import { HoldingsResponseSchema } from './queries/holdings.js';
import { InvestmentAllocationResponseSchema } from './queries/investment-allocation.js';
import { InvestmentBalanceResponseSchema } from './queries/investment-balance.js';
import { InvestmentLiveBalanceResponseSchema } from './queries/investment-live-balance.js';
import { MonthlySpendResponseSchema } from './queries/monthly-spend.js';
import { NetworthResponseSchema } from './queries/networth.js';
import { RecurringsResponseSchema } from './queries/recurrings.js';
import { SecurityPricesResponseSchema } from './queries/security-prices.js';
import { SecurityPricesHighFrequencyResponseSchema } from './queries/security-prices-high-frequency.js';
import { TagsResponseSchema } from './queries/tags.js';
import { TopMoversResponseSchema } from './queries/top-movers.js';
import { UpcomingRecurringsResponseSchema } from './queries/upcoming-recurrings.js';
import { UserResponseSchema } from './queries/user.js';

/**
 * Name of this runtime check as registered in the ledger's
 * RUNTIME_CHECK_NAMES. `runtime:read-zod-warn` oracles point here. Distinct
 * from the mutation `zod-warn` and the transactions `transactions-read-shape`
 * checks.
 */
export const READ_RESPONSE_SHAPE_RUNTIME_CHECK = 'read-zod-warn' as const;

export interface QueryResponseShapeEntry {
  /** Conformance ledger surface this schema verifies. */
  surface: `Query.${string}:response`;
  schema: ZodType;
}

function entry(rootField: string, schema: ZodType): QueryResponseShapeEntry {
  return { surface: `Query.${rootField}:response`, schema };
}

/**
 * Registry keyed by GraphQL OPERATION name (the first argument wrappers pass
 * to `client.query(...)`). Operation names are PascalCase and do NOT always
 * match the root Query field (Account→account, and in later batches
 * MonthlySpend→monthlySpending, Networth→networthHistory).
 *
 * Every registered surface must have a matching `runtime:read-zod-warn`
 * ledger entry (and vice-versa) — the ledger test enforces both directions.
 */
export const QUERY_RESPONSE_SCHEMAS: Readonly<Record<string, QueryResponseShapeEntry>> = {
  User: entry('user', UserResponseSchema),
  Accounts: entry('accounts', AccountsResponseSchema),
  Account: entry('account', AccountResponseSchema),
  Categories: entry('categories', CategoriesResponseSchema),
  Tags: entry('tags', TagsResponseSchema),
  Recurrings: entry('recurrings', RecurringsResponseSchema),
  UpcomingRecurrings: entry('unpaidUpcomingRecurrings', UpcomingRecurringsResponseSchema),
  MonthlySpend: entry('monthlySpending', MonthlySpendResponseSchema),
  Networth: entry('networthHistory', NetworthResponseSchema),
  BalanceHistory: entry('accountBalanceHistory', BalanceHistoryResponseSchema),
  Holdings: entry('holdings', HoldingsResponseSchema),
  AggregatedHoldings: entry('aggregatedHoldings', AggregatedHoldingsResponseSchema),
  InvestmentAllocation: entry('investmentAllocation', InvestmentAllocationResponseSchema),
  TopMovers: entry('topMovers', TopMoversResponseSchema),
  InvestmentBalance: entry('investmentBalance', InvestmentBalanceResponseSchema),
  InvestmentLiveBalance: entry('investmentLiveBalance', InvestmentLiveBalanceResponseSchema),
  SecurityPrices: entry('securityPrices', SecurityPricesResponseSchema),
  SecurityPricesHighFrequency: entry(
    'securityPricesHighFrequency',
    SecurityPricesHighFrequencyResponseSchema
  ),
};

// ---------------------------------------------------------------------------
// Warn-mode validation + drift counters (separate from the mutation counters
// so roundtrip.ts's mutation-drift report stays unpolluted).
// ---------------------------------------------------------------------------

export type ReadResponseDriftStats = Record<string, number>;

const driftCounts = new Map<string, number>();

// Dedupe key = `${operationName}::${normalizeDriftPath(issue.path)}::${issue.code}`.
// Array indices in the path normalize to `*` (#552) so one drift across an
// array's elements warns once, not once per element. One warn per unique key
// per process — prevents log flood when every call to the same query drifts
// the same way.
const warnedKeys = new Set<string>();

/** Snapshot of the per-surface read drift counters (copy, safe to mutate). */
export function getReadResponseDriftStats(): ReadResponseDriftStats {
  return Object.fromEntries(driftCounts);
}

/**
 * Validate a read query response payload against its registered schema,
 * warn-mode. Never throws; never alters `data`. Unregistered operations are
 * skipped silently (see the module doc).
 */
export function validateQueryResponse(operationName: string, data: unknown): void {
  const registered = QUERY_RESPONSE_SCHEMAS[operationName];
  if (!registered) return;

  const result = registered.schema.safeParse(data);
  if (result.success) return;

  driftCounts.set(registered.surface, (driftCounts.get(registered.surface) ?? 0) + 1);

  // Warn for EVERY issue, each deduped per (operation, path, code) per process
  // — the unique drift inventory is logged in full while repeats stay silent.
  for (const issue of result.error.issues) {
    const pathStr = issue.path.join('.');
    const key = `${operationName}::${normalizeDriftPath(issue.path)}::${issue.code}`;
    if (warnedKeys.has(key)) continue;
    warnedKeys.add(key);
    // console.warn writes to stderr in Node/Bun — safe for the MCP stdio
    // transport (stdout carries JSON-RPC). Messages describe expected/received
    // TYPES, not the user's data.
    console.warn(
      `[copilot-money-mcp] read response shape drift: operation=${operationName} ` +
        `surface=${registered.surface} path=${pathStr} code=${issue.code} message="${issue.message}"`
    );
  }
}

// Exposed for tests only: clears the dedupe set and drift counters.
export function __resetReadResponseDriftState(): void {
  driftCounts.clear();
  warnedKeys.clear();
}
