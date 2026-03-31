# Investment Holdings Tools Design

**Date:** 2026-03-30
**Issue:** [#147 — Feature request: get_holdings / get_securities tool for investment positions](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/147)
**Reference fork:** [ptw1255/copilot-money-mcp](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/compare/main...ptw1255:copilot-money-mcp:main) — wealth management data pipeline with 11 commits

---

## Goal

Add investment position-level tools to the MCP server so AI clients can query individual holdings (ticker, quantity, price, account) rather than just account-level balances. This directly addresses a user building an AI-powered financial advisor who needs portfolio detail for rebalancing and research.

## Scope

**In scope (this PR):**
- 2 new Zod models: `Security`, `HoldingHistory`
- Decoder + database support for 2 new Firestore collections
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

### Cost basis investigation

Exhaustively searched all 52,528 documents for field names containing: cost, basis, average, return, gain, loss, purchase, acquisition. **Zero matches.** The Copilot Money app displays average cost and total return per holding (confirmed via screenshots), but this data comes from the server API (Plaid's investment/holdings/get), not the local Firestore cache. This is a known limitation documented in the `get_holdings` tool description.

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
2. `processHoldingHistory(fields, docId, collection)` — extracts security_id, account_id, item_id from collection path. Converts history map (ms timestamps → {price, quantity}) to snapshots with ISO date keys. Skips empty container docs (0 fields).

**Collection routing in `decodeAllCollections`:**

```
collectionMatches(collection, 'securities')      → processSecurity
collection.includes('/holdings_history/')
  && collection.includes('/history')             → processHoldingHistory
```

Empty containers at `holdings_history/*` are naturally skipped (no `/history` suffix match).

**`AllCollectionsResult` extension:**

```typescript
interface AllCollectionsResult {
  // ... existing fields ...
  securities: Security[];
  holdingHistory: HoldingHistory[];
}
```

**Deduplication & sorting:**
- Securities: dedupe by `security_id`
- HoldingHistory: dedupe by `security_id|account_id|month`, sort by security_id then month desc

**Standalone exports:** `decodeSecurities(dbPath)` and `decodeHoldingHistory(dbPath)` for individual loading (follows existing pattern for every collection).

### Database (src/core/database.ts)

**New cache fields:**

```typescript
private _securities: Security[] | null = null;
private _holdingHistory: HoldingHistory[] | null = null;
private _loadingSecurities: Promise<Security[]> | null = null;
private _loadingHoldingHistory: Promise<HoldingHistory[]> | null = null;
```

Populated via batch loading (from `AllCollectionsResult`) or standalone loaders. Cleared in `clearCache()`.

**New accessor methods:**

1. `getSecurities(options?)` — filter by ticker_symbol, type, is_cash_equivalent
2. `getSecurityMap()` — returns `Map<security_id, Security>` for efficient cross-referencing by `get_holdings`
3. `getHoldingHistory(options?)` — filter by securityId, accountId, startDate, endDate

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

Computed tool that joins holdings_history + securities + accounts to provide a portfolio view.

**Input:**

| Param | Type | Description |
|---|---|---|
| `account_id` | string? | Filter by investment account |
| `ticker_symbol` | string? | Filter by ticker symbol |
| `include_history` | boolean? | Attach monthly snapshots (default false) |
| `limit` | integer? | Max results (default 100) |
| `offset` | integer? | Pagination offset (default 0) |

**Internal logic:**
1. Load `holdingHistory` — group by `security_id + account_id`, take latest month's latest snapshot → quantity and snapshot_price
2. Load `securityMap` — join on security_id → ticker_symbol, name, type, current_price
3. Load accounts — join on account_id → account_name
4. Compute `equity_value = quantity * current_price`
5. If ticker_symbol filter provided, resolve via securityMap and filter
6. If include_history, attach full snapshots per holding

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
    account_id?: string;
    account_name?: string;
    quantity: number;
    current_price?: number;
    equity_value?: number;
    snapshot_price: number;
    snapshot_date: string;
    is_cash_equivalent?: boolean;
    iso_currency_code?: string;
    history?: Array<{
      month: string;
      snapshots: Record<string, { price: number; quantity: number }>;
    }>;
  }>;
  _note?: string;
}
```

The `_note` field will state: "Cost basis and total return are not available in the local Firestore cache. Use get_investment_prices and get_investment_splits for historical price analysis."

**Tool description** in the schema will clearly communicate this limitation and cross-reference the other investment tools.

### Server routing

Three new cases in `handleCallTool` switch in `src/server.ts`. Tool count: 8 → 11.

### Manifest

Three new entries in `manifest.json` with `readOnlyHint: true`.

---

## Section 4: Testing

### Test fixtures (tests/fixtures/synthetic-db/)

New fixture data in the synthetic database:

- **Securities:** 3-4 synthetic securities with different types (equity, etf, mutual fund, cash equivalent USD)
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
- Returns holdings enriched with ticker, name, type, account_name, equity_value
- Filters by account_id
- Filters by ticker_symbol
- `include_history: false` (default) — no history key in response
- `include_history: true` — history array attached per holding
- Holdings with no matching security still return (security_id only)
- Cash equivalents included
- Pagination

### Unit tests

- `tests/unit/server-protocol.test.ts` — update tool count assertion (8 → 11)
- Model validation tests for `SecuritySchema` and `HoldingHistorySchema`
- Decoder tests for `processSecurities` and `processHoldingHistory`

### Integration test

- `tests/integration/tools.test.ts` — update tool count assertion

### Existing tests

All existing tests must continue to pass. `bun run check` (typecheck + lint + format + test) must be green.

---

## Known Limitations

1. **No cost basis / total return** — not in local Firestore cache. The app fetches this from Copilot Money's server API.
2. **Holdings freshness** — `get_holdings` is only as current as the last Copilot Money sync. The `snapshot_date` field indicates when the data was last updated.
3. **Security count** — only 17 securities in the current cache. Holdings with unknown security_id will still return but without ticker/name/type enrichment.

## Future Work

- `get_balance_history` tool (4,945 docs)
- `investment_performance` / TWR data (887 docs)
- Enhancements: `include_summary` on transactions, `include_history` on goals, `annual_cost` on recurring
- Full cache coverage for all 35 collection paths
