# Investment Holdings Tools Design

**Date:** 2026-03-30
**Issue:** [#147 — Feature request: get_holdings / get_securities tool for investment positions](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/147)
**Reference fork:** [ptw1255/copilot-money-mcp](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/compare/main...ptw1255:copilot-money-mcp:main) — wealth management data pipeline with 11 commits

---

## Goal

Add investment position-level tools to the MCP server so AI clients can query individual holdings (ticker, quantity, price, cost basis, total return, account) rather than just account-level balances. This directly addresses a user building an AI-powered financial advisor who needs portfolio detail for rebalancing and research.

## Scope

**In scope (this PR):**
- 3 new Zod models: `Security`, `Holding`, `HoldingHistory`
- Decoder + database support for 2 new Firestore collections + extraction of holdings from existing account documents
- 3 new MCP tools: `get_investment_prices`, `get_investment_splits`, `get_holdings`
- Tests and fixtures for all new functionality

**Out of scope (follow-up work):**
- `get_balance_history` tool (4,945 docs in cache — separate PR)
- Enhancements to existing tools: `include_summary` on transactions, `include_history` on goals, `annual_cost` on recurring
- `investment_performance` / TWR data (887 docs — separate PR)
- Full cache coverage for remaining undecoded collections (amazon orders, tags, changes, etc.)

## Data Discovery Findings

Scanned all 52,528 documents across 35 unique collection paths in the Firestore cache.

### New collections discovered

| Collection | Docs | Description |
|---|---|---|
| `securities` | 17 | Plaid security reference data: ticker_symbol, name, type, current_price, isin, cusip |
| `investment_performance/*/twr_holding` | 887 | Daily time-weighted return per security per month (out of scope) |
| `items/*/accounts/*/balance_history` | 4,945 | Daily balance snapshots per account (out of scope) |
| `items/*/accounts/*/holdings_history/*/history` | 84 | Monthly snapshots of {price, quantity} per security per account |

### Cost basis discovery

An initial top-level field name audit found nothing. A deeper investigation discovered that **cost basis IS cached locally**, nested inside a `holdings` array within account documents (`items/*/accounts/*`).

Each element in the `holdings` array is a full Plaid holding object:

```typescript
{
  account_id: string;
  cost_basis: number | null;       // Total cost basis in USD (NOT per-share). Null for cash positions.
  institution_price: number;       // Current price per share (from institution)
  institution_value: number;       // Current total value (= institution_price × quantity)
  quantity: number;                // Number of shares
  security_id: string;             // SHA256 hash — joins to securities collection
  original_security_id: string;    // Plaid's internal security ID
  iso_currency_code: string;
  vested_quantity: number | null;  // For RSUs/stock plans
  vested_value: number | null;
}
```

**Computed values (verified against app screenshots):**

| Metric | Formula | Example (SCHX) |
|---|---|---|
| Average cost | `cost_basis / quantity` | $77,047.42 / 3,517.551 = **$21.90** |
| Total return ($) | `institution_value - cost_basis` | $88,185.00 - $77,047.42 = **$11,137.58** |
| Total return (%) | `(institution_value - cost_basis) / cost_basis × 100` | **14.46%** |

Exact matches confirmed for SCHX ($21.90), META ($562.50), and DASH ($220.46).

**Important notes:**
- `cost_basis` is null for cash-equivalent positions (money market funds, USD)
- `cost_basis` is the total dollar amount invested, not per-share — divide by quantity for average cost
- Same security can appear across multiple account documents — aggregate by security_id if needed
- The existing decoder's `toPlainObject()` already correctly parses these nested arrays — no parser changes needed

---

## Section 1: New Models

### Security (src/models/security.ts)

Maps security hash to human-readable data. Source: `securities` collection (17 docs).

```typescript
SecuritySchema = z.object({
  security_id: z.string(),
  ticker_symbol: z.string(),
  name: z.string(),
  type: z.string(),                    // "equity", "etf", "mutual fund", "cryptocurrency"
  current_price: z.number().optional(),
  close_price: z.number().optional(),
  close_price_as_of: z.unknown().optional(),
  is_cash_equivalent: z.boolean().optional(),
  iso_currency_code: z.string().optional(),
  isin: z.string().nullable().optional(),
  cusip: z.string().nullable().optional(),
  sedol: z.string().nullable().optional(),
  provider_type: z.string().nullable().optional(),  // "FUND", "ETF", etc.
  source: z.string().optional(),                    // "eod", "polygon"
  last_update: z.string().optional(),
  update_frequency: z.number().optional(),
}).passthrough();
```

Fields confirmed via live data: all 17 documents have `security_id`, `ticker_symbol`, `name`, `type`, `close_price`, `iso_currency_code`. `current_price` present in 16/17.

### Holding (src/models/holding.ts)

Current investment position from Plaid. Source: `holdings[]` array nested inside account documents (`items/*/accounts/*`).

```typescript
HoldingSchema = z.object({
  account_id: z.string(),
  security_id: z.string(),
  quantity: z.number(),
  cost_basis: z.number().nullable(),
  institution_price: z.number(),
  institution_value: z.number(),
  iso_currency_code: z.string().optional(),
  original_security_id: z.string().optional(),
  institution_price_as_of: z.string().nullable().optional(),
  institution_price_datetime: z.string().nullable().optional(),
  vested_quantity: z.number().nullable().optional(),
  vested_value: z.number().nullable().optional(),
  unofficial_currency_code: z.string().nullable().optional(),
}).passthrough();
```

### HoldingHistory (src/models/holding-history.ts)

Monthly snapshots of investment positions. Source: `items/*/accounts/*/holdings_history/*/history/{YYYY-MM}` (84 docs).

```typescript
HoldingSnapshotSchema = z.object({
  price: z.number(),
  quantity: z.number(),
});

HoldingHistorySchema = z.object({
  security_id: z.string(),              // extracted from collection path
  account_id: z.string().optional(),     // extracted from collection path
  item_id: z.string().optional(),        // extracted from collection path
  month: z.string(),                     // doc ID, YYYY-MM format
  snapshots: z.record(z.string(), HoldingSnapshotSchema).optional(),
}).passthrough();
```

The `history` map in Firestore uses millisecond timestamps as keys. The decoder converts these to ISO date strings (YYYY-MM-DD) for usability.

---

## Section 2: Decoder & Database Layer

### Decoder (src/core/decoder.ts)

**New processor functions:**

1. `processSecurity(fields, docId)` — straightforward field extraction, validates with `SecuritySchema`
2. `processHoldings(fields, docId)` — extracts the `holdings` array from account document fields, validates each element with `HoldingSchema`. Returns `Holding[]` (may be empty if no holdings array present).
3. `processHoldingHistory(fields, docId, collection)` — extracts security_id, account_id, item_id from collection path. Converts history map (ms timestamps → {price, quantity}) to snapshots with ISO date keys. Skips empty container docs (0 fields).

**Collection routing in `decodeAllCollections`:**

```
collectionMatches(collection, 'securities')                         → processSecurity
collection.includes('items/') && collection.endsWith('/accounts')   → processHoldings (in addition to existing processAccount)
collection.includes('/holdings_history/')
  && collection.includes('/history')                                → processHoldingHistory
```

Note: account documents are already iterated for `processAccount`. The same document is also passed to `processHoldings` to extract the nested `holdings` array. This happens in the same loop iteration — no extra database pass.

**`AllCollectionsResult` extension:**

```typescript
interface AllCollectionsResult {
  // ... existing fields ...
  securities: Security[];
  holdings: Holding[];
  holdingHistory: HoldingHistory[];
}
```

**Deduplication & sorting:**
- Securities: dedupe by `security_id`
- Holdings: dedupe by `account_id|security_id` (same holding can appear in duplicate account docs)
- HoldingHistory: dedupe by `security_id|account_id|month`, sort by security_id then month desc

**Standalone exports:** `decodeSecurities(dbPath)`, `decodeHoldings(dbPath)`, and `decodeHoldingHistory(dbPath)` for individual loading.

### Database (src/core/database.ts)

**New cache fields:**

```typescript
private _securities: Security[] | null = null;
private _holdings: Holding[] | null = null;
private _holdingHistory: HoldingHistory[] | null = null;
private _loadingSecurities: Promise<Security[]> | null = null;
private _loadingHoldings: Promise<Holding[]> | null = null;
private _loadingHoldingHistory: Promise<HoldingHistory[]> | null = null;
```

Populated via batch loading (from `AllCollectionsResult`) or standalone loaders. Cleared in `clearCache()`.

**New accessor methods:**

1. `getSecurities(options?)` — filter by ticker_symbol, type, is_cash_equivalent
2. `getSecurityMap()` — returns `Map<security_id, Security>` for efficient cross-referencing
3. `getHoldings(options?)` — filter by accountId, securityId. Returns `Holding[]` from account documents.
4. `getHoldingHistory(options?)` — filter by securityId, accountId, startDate, endDate

### Worker thread

The worker thread (`src/core/decoder-worker.ts`) passes through `AllCollectionsResult` — extending the interface automatically includes the new fields.

---

## Section 3: MCP Tools

### Tool 1: `get_investment_prices`

Exposes already-decoded investment price data as a queryable tool.

**Input:**

| Param | Type | Description |
|---|---|---|
| `ticker_symbol` | string? | Filter by ticker (e.g., "AAPL", "BTC-USD") |
| `start_date` | string? | Start date (YYYY-MM-DD or YYYY-MM) |
| `end_date` | string? | End date (YYYY-MM-DD or YYYY-MM) |
| `price_type` | "daily" \| "hf"? | Filter by price type |
| `limit` | integer? | Max results (default 100) |
| `offset` | integer? | Pagination offset (default 0) |

**Output:** `{ count, total_count, offset, has_more, tickers: string[], prices: InvestmentPrice[] }`

### Tool 2: `get_investment_splits`

Exposes already-decoded stock split history.

**Input:**

| Param | Type | Description |
|---|---|---|
| `ticker_symbol` | string? | Filter by ticker |
| `start_date` | string? | Start date (YYYY-MM-DD) |
| `end_date` | string? | End date (YYYY-MM-DD) |
| `limit` | integer? | Max results (default 100) |
| `offset` | integer? | Pagination offset (default 0) |

**Output:** `{ count, total_count, offset, has_more, splits: InvestmentSplit[] }`

### Tool 3: `get_holdings` (primary tool — addresses #147)

Computed tool that joins holdings (from account docs) + securities + accounts to provide a full portfolio view with cost basis.

**Input:**

| Param | Type | Description |
|---|---|---|
| `account_id` | string? | Filter by investment account |
| `ticker_symbol` | string? | Filter by ticker symbol |
| `include_history` | boolean? | Attach monthly price/quantity snapshots (default false) |
| `limit` | integer? | Max results (default 100) |
| `offset` | integer? | Pagination offset (default 0) |

**Internal logic:**
1. Load `holdings` (from account documents' `holdings[]` arrays) — gives quantity, cost_basis, institution_price, institution_value, security_id, account_id
2. Load `securityMap` — join on security_id → ticker_symbol, name, type, is_cash_equivalent
3. Load accounts — join on account_id → account_name
4. Compute per holding:
   - `average_cost = cost_basis / quantity` (when cost_basis is not null)
   - `total_return = institution_value - cost_basis` (when cost_basis is not null)
   - `total_return_percent = (institution_value - cost_basis) / cost_basis * 100` (when cost_basis is not null)
5. If ticker_symbol filter provided, resolve via securityMap and filter
6. If include_history, load holdingHistory and attach matching monthly snapshots per holding (joined on security_id + account_id)

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
    type?: string;               // "equity", "etf", "mutual fund", "cryptocurrency"
    account_id: string;
    account_name?: string;
    quantity: number;
    institution_price: number;   // price per share from institution
    institution_value: number;   // total current value
    cost_basis?: number;         // total cost (null for cash equivalents)
    average_cost?: number;       // cost_basis / quantity
    total_return?: number;       // institution_value - cost_basis
    total_return_percent?: number; // percentage return
    is_cash_equivalent?: boolean;
    iso_currency_code?: string;
    // Only present when include_history: true
    history?: Array<{
      month: string;
      snapshots: Record<string, { price: number; quantity: number }>;
    }>;
  }>;
}
```

**Tool description** will note that cost_basis may be null for cash-equivalent positions, and will cross-reference `get_investment_prices` and `get_investment_splits` for historical analysis.

### Server routing

Three new cases in `handleCallTool` switch in `src/server.ts`. Tool count: 8 → 11.

### Manifest

Three new entries in `manifest.json` with `readOnlyHint: true`.

---

## Section 4: Testing

### Test fixtures (tests/fixtures/synthetic-db/)

New fixture data in the synthetic database:

- **Securities:** 3-4 synthetic securities with different types (equity, etf, mutual fund, cash equivalent USD)
- **Holdings in account docs:** Add `holdings` arrays to existing synthetic account documents with cost_basis, quantity, institution_price, institution_value, security_id
- **Holding history:** A few monthly docs per security per account with daily {price, quantity} snapshots
- No new fixtures needed for investment_prices/splits (already have fixture data)

### Tool tests (tests/tools/tools.test.ts)

**`get_investment_prices`:**
- Returns all prices with correct shape
- Filters by ticker_symbol, date range, price_type
- Pagination (limit, offset, has_more)

**`get_investment_splits`:**
- Returns all splits with correct shape
- Filters by ticker_symbol, date range
- Pagination

**`get_holdings`:**
- Returns holdings enriched with ticker, name, type, account_name
- Returns computed fields: average_cost, total_return, total_return_percent
- cost_basis is null for cash-equivalent holdings → average_cost/total_return omitted
- Filters by account_id
- Filters by ticker_symbol
- `include_history: false` (default) — no history key in response
- `include_history: true` — history array attached per holding
- Holdings with no matching security still return (security_id only)
- Pagination

### Unit tests

- `tests/unit/server-protocol.test.ts` — update tool count assertion (8 → 11)
- Model validation tests for `SecuritySchema`, `HoldingSchema`, and `HoldingHistorySchema`
- Decoder tests for `processSecurity`, `processHoldings`, and `processHoldingHistory`

### Integration test

- `tests/integration/tools.test.ts` — update tool count assertion

### Existing tests

All existing tests must continue to pass. `bun run check` (typecheck + lint + format + test) must be green.

---

## Issue #147 Coverage

All 8 requested fields delivered:

| Requested | Source | Status |
|---|---|---|
| ticker | `securities.ticker_symbol` | **Yes** |
| name | `securities.name` | **Yes** |
| quantity | `holdings[].quantity` | **Yes** |
| current price | `holdings[].institution_price` | **Yes** |
| average cost | `holdings[].cost_basis / quantity` | **Yes** |
| total return | `holdings[].institution_value - cost_basis` | **Yes** |
| equity value | `holdings[].institution_value` | **Yes** |
| account name | Joined from accounts | **Yes** |

Both requested filters (`account_id`, `symbol`) supported.

## Known Limitations

1. **Nullable cost basis** — cash-equivalent positions (USD, money market) have `cost_basis: null`. Average cost and total return are omitted for these.
2. **Holdings freshness** — data is only as current as the last Copilot Money sync. The `institution_price_as_of` field indicates when prices were last updated.
3. **Security count** — only 17 securities in the current cache. Holdings with unknown security_id will still return but without ticker/name/type enrichment.

## Future Work

- `get_balance_history` tool (4,945 docs)
- `investment_performance` / TWR data (887 docs)
- Enhancements: `include_summary` on transactions, `include_history` on goals, `annual_cost` on recurring
- Full cache coverage for all 35 collection paths
