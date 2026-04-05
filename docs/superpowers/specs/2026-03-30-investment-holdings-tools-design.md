# Investment Holdings Tools Design

**Date:** 2026-03-30 (updated 2026-04-05)
**Issue:** [#147 — Feature request: get_holdings / get_securities tool for investment positions](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/147)
**Reference fork:** [ptw1255/copilot-money-mcp](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/compare/main...ptw1255:copilot-money-mcp:main)

---

## Goal

Add investment position-level tools to the MCP server so AI clients can query individual holdings (ticker, quantity, price, cost basis, total return, account) rather than just account-level balances.

## Scope

**In scope (this PR):**
- Database accessor methods for securities, holdings, and holdings history (models + decoder already exist)
- 3 new MCP tools: `get_investment_prices`, `get_investment_splits`, `get_holdings`
- Tests and fixtures

**Out of scope (follow-up work):**
- `get_balance_history` tool
- `investment_performance` / TWR tool
- Enhancements to existing tools (`include_summary`, `include_history`, `annual_cost`)
- Portfolio summary / `group_by` aggregation on `get_holdings`

## What Already Exists (post recent PRs)

Models, decoders, and collection routing are all done. The decoder's `decodeAllCollections()` returns all the data we need:

| Data | Model | Decoder | In AllCollectionsResult | Database accessor |
|---|---|---|---|---|
| Securities (17 docs) | `Security` in `security.ts` | `processSecurity` | `securities: Security[]` | **No** |
| Holdings in accounts | `AccountHoldingSchema` in `account.ts` | Part of account processing | `accounts[].holdings` | **No** (accounts loaded, but no holdings-specific accessor) |
| Holdings history (84 docs) | `HoldingsHistory` in `holdings-history.ts` | `processHoldingsHistory` | `holdingsHistory: HoldingsHistory[]` | **No** |
| Investment prices | `InvestmentPrice` in `investment-price.ts` | `processInvestmentPrice` | `investmentPrices: InvestmentPrice[]` | `getInvestmentPrices()` exists but no MCP tool |
| Investment splits | `InvestmentSplit` in `investment-split.ts` | `processInvestmentSplit` | `investmentSplits: InvestmentSplit[]` | `getInvestmentSplits()` exists but no MCP tool |

**Current tool count: 9.** Target: 12 (add 3).

## What We Need to Build

### 1. Database Layer (src/core/database.ts)

Add cache fields and accessor methods for collections not yet exposed:

**Securities:**
- Cache: `_securities: Security[] | null`, `_loadingSecurities: Promise<Security[]> | null`
- Populate from `AllCollectionsResult.securities` in `loadAllCollections()`
- Clear in `clearCache()`
- Accessor: `getSecurities()` — returns all securities
- Accessor: `getSecurityMap()` — returns `Map<security_id, Security>` for cross-referencing

**Holdings history:**
- Cache: `_holdingsHistory: HoldingsHistory[] | null`, `_loadingHoldingsHistory`
- Accessor: `getHoldingsHistory(options?)` — filter by securityId, accountId, startDate, endDate

Note: Holdings (with cost_basis) come from `accounts[].holdings` which is already cached. No extra cache field needed — `getAccounts()` already returns accounts with holdings arrays.

### 2. MCP Tools (src/tools/tools.ts)

#### Tool 1: `get_investment_prices`

Exposes already-decoded investment price data.

- **Filters:** `ticker_symbol`, `start_date`, `end_date`, `price_type` (daily/hf)
- **Pagination:** `limit` (default 100), `offset`
- **Returns:** `{ count, total_count, offset, has_more, tickers: string[], prices: InvestmentPrice[] }`

#### Tool 2: `get_investment_splits`

Exposes already-decoded stock split history.

- **Filters:** `ticker_symbol`, `start_date`, `end_date`
- **Pagination:** `limit`, `offset`
- **Returns:** `{ count, total_count, offset, has_more, splits: InvestmentSplit[] }`

#### Tool 3: `get_holdings` (primary tool — addresses #147)

Joins `accounts[].holdings` + `securities` + accounts to provide a portfolio view with cost basis.

- **Filters:** `account_id`, `ticker_symbol`
- **Options:** `include_history` (boolean, default false)
- **Pagination:** `limit`, `offset`

**Internal logic:**
1. Load accounts → extract `holdings[]` arrays from investment accounts
2. Load securities → build `Map<security_id, Security>` for enrichment
3. Join: for each holding, look up security → ticker_symbol, name, type
4. Compute: `average_cost = cost_basis / quantity`, `total_return = institution_value - cost_basis`, `total_return_percent`
5. If `ticker_symbol` filter: resolve via security map and filter
6. If `include_history`: load holdingsHistory, attach matching snapshots per holding

**Output:**

```typescript
{
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  holdings: Array<{
    security_id: string;
    ticker_symbol?: string;
    name?: string;
    type?: string;
    account_id: string;
    account_name?: string;
    quantity: number;
    institution_price: number;
    institution_value: number;
    cost_basis?: number;
    average_cost?: number;
    total_return?: number;
    total_return_percent?: number;
    is_cash_equivalent?: boolean;
    iso_currency_code?: string;
    history?: Array<{
      month: string;
      snapshots: Record<string, { price: number; quantity: number }>;
    }>;
  }>;
}
```

### 3. Server Routing (src/server.ts)

Three new cases in `handleCallTool` switch.

### 4. Manifest (manifest.json)

Three new tool entries with `readOnlyHint: true`.

### 5. Testing

**Test fixtures:** Add securities and holdings data to synthetic database. Add holdings arrays to existing synthetic account documents.

**Tool tests (tests/tools/tools.test.ts):**
- `get_investment_prices`: shape, ticker filter, date range, price_type, pagination
- `get_investment_splits`: shape, ticker filter, date range, pagination
- `get_holdings`: enriched output, average_cost/total_return computation, null cost_basis handling, account_id filter, ticker_symbol filter, include_history flag, pagination

**Unit tests:** tool count assertions (9 → 12), model validation

---

## Issue #147 Coverage

All 8 requested fields delivered:

| Requested | Source | Status |
|---|---|---|
| ticker | `securities.ticker_symbol` | Yes |
| name | `securities.name` | Yes |
| quantity | `accounts[].holdings[].quantity` | Yes |
| current price | `accounts[].holdings[].institution_price` | Yes |
| average cost | `cost_basis / quantity` | Yes |
| total return | `institution_value - cost_basis` | Yes |
| equity value | `accounts[].holdings[].institution_value` | Yes |
| account name | Joined from accounts | Yes |

## Known Limitations

1. **Nullable cost basis** — cash-equivalent positions have `cost_basis: null`. Average cost and total return omitted for these.
2. **Holdings freshness** — only as current as the last Copilot Money sync.
3. **No portfolio summary** — aggregate allocation views (by type, by account) planned as follow-up.

## Future Work

- Portfolio summary / `group_by` param on `get_holdings`
- `get_balance_history` tool (4,945 docs)
- `investment_performance` / TWR tool (887 docs)
- Enhancements: `include_summary` on transactions, `include_history` on goals, `annual_cost` on recurring
