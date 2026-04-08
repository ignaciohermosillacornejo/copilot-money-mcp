# Missing Tools Audit — Design Spec

**Date:** 2026-04-07
**Scope:** 5 new READ tools, 1 new WRITE tool
**Philosophy:** MCP reflects Firestore collections as cleanly as possible — raw data, no aggregation.

## Tools Summary

| Tool | Type | Collection | Docs |
|------|------|-----------|------|
| `get_balance_history` | READ | `items/{item_id}/accounts/{account_id}/balance_history/{date}` | ~4,945 |
| `get_investment_performance` | READ | `investment_performance/{hash}` | ~8,088 |
| `get_twr_returns` | READ | `investment_performance/{hash}/twr_holding` | ~887 |
| `get_securities` | READ | `securities` | ~17 |
| `get_goal_history` | READ | `users/{user_id}/financial_goals/{goal_id}/financial_goal_history/{month}` | ~2 |
| `update_recurring` | WRITE | `users/{user_id}/recurring` | CRUD gap fill |

## Excluded from scope

- **Account management** (`rename_account`, `hide_account`) — not needed now
- **Amazon orders** — niche, low priority
- **Investment performance metadata** (~10 docs) — internal bookkeeping, no user value

---

## 1. New Database Methods (src/core/database.ts)

### `getBalanceHistory(options)`

```typescript
async getBalanceHistory(options: {
  accountId?: string;
  startDate?: string;  // YYYY-MM-DD
  endDate?: string;    // YYYY-MM-DD
} = {}): Promise<BalanceHistory[]>
```

- Source: `decodeAllCollections().balanceHistory`
- Filters by `accountId`, `startDate`, `endDate`
- Sorted by `account_id` asc, then `date` desc
- Needs caching like other collection methods

### `getInvestmentPerformance(options)`

```typescript
async getInvestmentPerformance(options: {
  securityId?: string;
} = {}): Promise<InvestmentPerformance[]>
```

- Source: `decodeAllCollections().investmentPerformance`
- Filters by `securityId`
- Excludes metadata-only docs (those without meaningful performance data)

### `getTwrHoldings(options)`

```typescript
async getTwrHoldings(options: {
  securityId?: string;
  startMonth?: string;  // YYYY-MM
  endMonth?: string;    // YYYY-MM
} = {}): Promise<TwrHolding[]>
```

- Source: `decodeAllCollections().twrHoldings`
- Filters by `securityId`, month range

### `getSecurities(options)` — extend existing

```typescript
// Existing: getSecurities(): Promise<Security[]>
// Add optional filter params:
async getSecurities(options: {
  tickerSymbol?: string;
  type?: string;
} = {}): Promise<Security[]>
```

- Add optional `tickerSymbol` (case-insensitive) and `type` filters
- Existing callers pass no args, so backwards-compatible

### `getGoalHistory(options)` — already exists

```typescript
// Already implemented with goalId, startMonth, endMonth, limit
// No changes needed
```

---

## 2. Read Tool Implementations (src/tools/tools.ts)

All follow the standard pattern: validate params, call `db.getX()`, paginate with `slice()`, return standard metadata (`count`, `total_count`, `offset`, `has_more`).

### `get_balance_history`

**Input schema:**
- `account_id` (string, optional) — filter by account
- `start_date` (string, optional) — YYYY-MM-DD
- `end_date` (string, optional) — YYYY-MM-DD
- `granularity` (string, **required**) — `daily` | `weekly` | `monthly`
- `limit` (integer, optional, default 100)
- `offset` (integer, optional, default 0)

**Behavior:**
- Fetches raw daily snapshots via `db.getBalanceHistory()`
- For `weekly`: keeps only the last available data point per calendar week (Mon-Sun)
- For `monthly`: keeps only the last available data point per calendar month
- No averaging or aggregation — just downsampling by picking the latest row per period
- Enriches each row with account name from `getAccountNameMap()`

**Response shape:**
```typescript
{
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  accounts: string[];  // unique account IDs in result set
  balance_history: Array<{
    date: string;
    account_id: string;
    account_name?: string;
    current_balance?: number;
    available_balance?: number;
    limit?: number;
  }>;
}
```

### `get_investment_performance`

**Input schema:**
- `ticker_symbol` (string, optional) — filter by ticker, resolved via security map
- `security_id` (string, optional) — filter by security ID directly
- `limit` (integer, optional, default 100)
- `offset` (integer, optional, default 0)

**Behavior:**
- Returns raw per-security performance docs
- Enriches with `ticker_symbol` and `name` from `getSecurityMap()`
- Ticker filter uses case-insensitive match against security map (same pattern as `get_holdings`)

**Response shape:**
```typescript
{
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  performance: Array<InvestmentPerformance & {
    ticker_symbol?: string;
    name?: string;
  }>;
}
```

### `get_twr_returns`

**Input schema:**
- `ticker_symbol` (string, optional) — resolved via security map
- `security_id` (string, optional) — filter directly
- `start_month` (string, optional) — YYYY-MM
- `end_month` (string, optional) — YYYY-MM
- `limit` (integer, optional, default 100)
- `offset` (integer, optional, default 0)

**Behavior:**
- Returns raw TWR monthly docs with epoch-ms keyed history entries intact
- Enriches with `ticker_symbol` and `name` from security map

**Response shape:**
```typescript
{
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  twr_returns: Array<TwrHolding & {
    ticker_symbol?: string;
    name?: string;
  }>;
}
```

### `get_securities`

**Input schema:**
- `ticker_symbol` (string, optional) — case-insensitive filter
- `type` (string, optional) — filter by security type
- `limit` (integer, optional, default 100)
- `offset` (integer, optional, default 0)

**Behavior:**
- Returns raw security master data
- Simple filters on `ticker_symbol` and `type`

**Response shape:**
```typescript
{
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  securities: Security[];
}
```

### `get_goal_history`

**Input schema:**
- `goal_id` (string, optional) — filter by goal
- `start_month` (string, optional) — YYYY-MM
- `end_month` (string, optional) — YYYY-MM
- `limit` (integer, optional, default 100)
- `offset` (integer, optional, default 0)

**Behavior:**
- Thin wrapper around existing `db.getGoalHistory()`
- Returns raw monthly snapshots with `daily_data` and `contributions` arrays intact
- Enriches with goal name from goals data

**Response shape:**
```typescript
{
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  goal_history: Array<GoalHistory & {
    goal_name?: string;
  }>;
}
```

---

## 3. Write Tool: `update_recurring`

### Input schema

- `recurring_id` (string, **required**)
- `name` (string, optional)
- `amount` (number, optional)
- `frequency` (string, optional) — validated against `VALID_RECURRING_FREQUENCIES`
- `category_id` (string, optional)
- `account_id` (string, optional)
- `merchant_name` (string, optional)
- `emoji` (string, optional)
- `match_string` (string, optional)
- `transaction_ids` (string[], optional)
- `excluded_transaction_ids` (string[], optional)
- `included_transaction_ids` (string[], optional)
- `days_filter` (number, optional)

### Validation

- `validateDocId(recurring_id)` — format check
- Verify recurring exists via `db.getRecurring(false)`
- `name`: non-empty after trim
- `amount`: > 0
- `frequency`: must be in `VALID_RECURRING_FREQUENCIES`
- `category_id`, `account_id`: `validateDocId` if provided
- `match_string`: non-empty after trim
- `transaction_ids`, `excluded_transaction_ids`, `included_transaction_ids`: validated as arrays of strings
- `days_filter`: validated as number
- At least one field must be provided, else error

### Write pattern

- Dynamic `fieldsToUpdate` + `updateMask` (same as `update_goal`, `update_budget`)
- Writes to `users/${userId}/recurring` via `client.updateDocument()`
- Clears cache: `this.db.clearCache()`

### Response

```typescript
{
  success: boolean;
  recurring_id: string;
  name: string;
  updated_fields: string[];
}
```

---

## 4. Registration (3 touchpoints per tool)

### Tool schemas — `createToolSchemas()` in `src/tools/tools.ts`

Each tool gets a schema object with `name`, `description`, `inputSchema`, and `annotations`.
- All 5 read tools: `readOnlyHint: true`
- `update_recurring`: no `readOnlyHint`

### Server handler — `src/server.ts`

- Add case for each tool name in the switch statement
- `update_recurring` added to the `WRITE_TOOLS` set (requires `--write` flag)

### Manifest — `manifest.json`

- Add entry for each tool with `name` and `description`

---

## 5. Testing

Each tool gets tests following existing patterns:

- **Unit tests** in `tests/tools/tools.test.ts` — mock database, verify filtering, pagination, validation, error cases
- **Schema tests** for any new model changes
- **E2E tests** in `tests/tools/write-tools-phase3.test.ts` (or new file) for `update_recurring`
- Verify tool registration in server handler tests
