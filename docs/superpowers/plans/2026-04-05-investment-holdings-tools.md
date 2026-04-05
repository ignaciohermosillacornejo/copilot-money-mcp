# Investment Holdings Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 3 new MCP tools (`get_holdings`, `get_investment_prices`, `get_investment_splits`) so AI clients can query investment positions with cost basis, prices, and splits.

**Architecture:** Models and decoders already exist. We add database cache/accessor methods for securities and holdings history, then build 3 tool methods that join holdings (from account docs) with securities for enrichment. `get_holdings` computes average cost and total return from the existing `cost_basis` field.

**Tech Stack:** TypeScript, Zod (runtime validation), Bun (test runner + runtime), MCP SDK.

**Spec:** `docs/superpowers/specs/2026-03-30-investment-holdings-tools-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/core/database.ts` | Modify | Add cache fields + accessor methods for securities and holdings history |
| `src/tools/tools.ts` | Modify | Add 3 tool methods + 3 tool schemas |
| `src/server.ts` | Modify | Add 3 switch cases in handleCallTool |
| `manifest.json` | Modify | Add 3 tool entries |
| `tests/tools/tools.test.ts` | Modify | Add tests for all 3 tools |

---

### Task 1: Database — Securities cache and accessors

**Files:**
- Modify: `src/core/database.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/tools/tools.test.ts` at the end of the file:

```typescript
describe('database securities accessors', () => {
  let db: CopilotDatabase;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._securities = [
      { security_id: 'hash1', ticker_symbol: 'AAPL', name: 'Apple Inc.', type: 'equity', current_price: 150.0, is_cash_equivalent: false },
      { security_id: 'hash2', ticker_symbol: 'SCHX', name: 'Schwab U.S. Large-Cap ETF', type: 'etf', current_price: 25.0, is_cash_equivalent: false },
      { security_id: 'hash3', ticker_symbol: 'USD', name: 'United States Dollar', type: 'cash', current_price: 1.0, is_cash_equivalent: true },
    ];
  });

  test('getSecurities returns all securities', async () => {
    const result = await db.getSecurities();
    expect(result.length).toBe(3);
  });

  test('getSecurityMap returns map keyed by security_id', async () => {
    const map = await db.getSecurityMap();
    expect(map.size).toBe(3);
    expect(map.get('hash1')?.ticker_symbol).toBe('AAPL');
    expect(map.get('hash2')?.ticker_symbol).toBe('SCHX');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tools/tools.test.ts -t "database securities"`
Expected: FAIL — `db.getSecurities is not a function`

- [ ] **Step 3: Add securities cache fields and loading**

In `src/core/database.ts`, add after the existing `_accountNameMap` field (around line 157):

```typescript
  private _securities: Security[] | null = null;
  private _holdingsHistory: HoldingsHistory[] | null = null;
```

Add after `_loadingUserAccounts` (around line 170):

```typescript
  private _loadingSecurities: Promise<Security[]> | null = null;
  private _loadingHoldingsHistory: Promise<HoldingsHistory[]> | null = null;
```

Add the import at the top of the file (add `Security` and `HoldingsHistory` to the existing model imports):

```typescript
import type { Security, HoldingsHistory } from '../models/index.js';
```

In `loadAllCollections()`, after `this._userAccounts = result.userAccounts;` (around line 358), add:

```typescript
      this._securities = result.securities;
      this._holdingsHistory = result.holdingsHistory;
```

In `clearCache()`, add to the null-clearing block (after `this._accountNameMap = null;`):

```typescript
    this._securities = null;
    this._holdingsHistory = null;
```

And add to the loading-promises null-clearing block (after `this._loadingUserAccounts = null;`):

```typescript
    this._loadingSecurities = null;
    this._loadingHoldingsHistory = null;
```

- [ ] **Step 4: Add private loadSecurities method**

Add after the existing `loadUserAccounts` method:

```typescript
  /**
   * Load securities with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadSecurities(): Promise<Security[]> {
    if (this._securities !== null) {
      return this._securities;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._securities ?? [];
    }

    // No standalone decoder for securities — batch loading only
    return this._securities ?? [];
  }

  /**
   * Load holdings history with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadHoldingsHistory(): Promise<HoldingsHistory[]> {
    if (this._holdingsHistory !== null) {
      return this._holdingsHistory;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._holdingsHistory ?? [];
    }

    return this._holdingsHistory ?? [];
  }
```

- [ ] **Step 5: Add public getSecurities and getSecurityMap methods**

Add after the existing `getInvestmentSplits` method:

```typescript
  /**
   * Get securities from the database.
   *
   * Securities are stored in: /securities/{security_id}
   * Contains Plaid security reference data: ticker, name, type, price.
   *
   * @returns Array of Security objects
   */
  async getSecurities(): Promise<Security[]> {
    return this.loadSecurities();
  }

  /**
   * Get a Map of security_id → Security for efficient lookups.
   *
   * @returns Map keyed by security_id
   */
  async getSecurityMap(): Promise<Map<string, Security>> {
    const securities = await this.loadSecurities();
    const map = new Map<string, Security>();
    for (const s of securities) {
      map.set(s.security_id, s);
    }
    return map;
  }

  /**
   * Get holdings history from the database.
   *
   * Holdings history is stored in:
   * /items/{item_id}/accounts/{account_id}/holdings_history/{hash}/history/{month}
   *
   * @param options - Filter options
   * @param options.securityId - Filter by security hash
   * @param options.accountId - Filter by account ID
   * @returns Array of HoldingsHistory objects
   */
  async getHoldingsHistory(
    options: {
      securityId?: string;
      accountId?: string;
    } = {}
  ): Promise<HoldingsHistory[]> {
    const { securityId, accountId } = options;

    const allHistory = await this.loadHoldingsHistory();
    let result = [...allHistory];

    if (securityId) {
      result = result.filter((h) => h.security_id === securityId);
    }

    if (accountId) {
      result = result.filter((h) => h.account_id === accountId);
    }

    return result;
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/tools/tools.test.ts -t "database securities"`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `bun run check`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/core/database.ts tests/tools/tools.test.ts
git commit -m "feat: add database accessors for securities and holdings history

Add cache fields, loading methods, and public accessors:
- getSecurities() — returns all securities
- getSecurityMap() — returns Map<security_id, Security> for lookups
- getHoldingsHistory(options?) — filter by securityId, accountId"
```

---

### Task 2: Tool — get_investment_prices

**Files:**
- Modify: `src/tools/tools.ts` (add method + schema)
- Modify: `src/server.ts` (add switch case)
- Modify: `manifest.json` (add tool entry)
- Test: `tests/tools/tools.test.ts`

- [ ] **Step 1: Write the failing test**

Add mock data and tests to `tests/tools/tools.test.ts`:

```typescript
describe('getInvestmentPrices', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._allCollectionsLoaded = true;
    (db as any)._accounts = [];
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
    (db as any)._investmentPrices = [
      { investment_id: 'hash1', ticker_symbol: 'AAPL', price: 150.0, date: '2024-01-15', price_type: 'hf' },
      { investment_id: 'hash1', ticker_symbol: 'AAPL', month: '2024-01', close_price: 148.0, price_type: 'daily' },
      { investment_id: 'hash2', ticker_symbol: 'SCHX', price: 25.0, date: '2024-01-15', price_type: 'hf' },
      { investment_id: 'hash2', ticker_symbol: 'SCHX', month: '2024-02', close_price: 26.0, price_type: 'daily' },
    ];
    tools = new CopilotMoneyTools(db);
  });

  test('returns all prices', async () => {
    const result = await tools.getInvestmentPrices({});
    expect(result.count).toBe(4);
    expect(result.total_count).toBe(4);
    expect(result).toHaveProperty('tickers');
    expect(result).toHaveProperty('prices');
  });

  test('filters by ticker_symbol', async () => {
    const result = await tools.getInvestmentPrices({ ticker_symbol: 'AAPL' });
    expect(result.count).toBe(2);
    for (const p of result.prices) {
      expect(p.ticker_symbol).toBe('AAPL');
    }
  });

  test('filters by price_type', async () => {
    const result = await tools.getInvestmentPrices({ price_type: 'daily' });
    expect(result.count).toBe(2);
    for (const p of result.prices) {
      expect(p.price_type).toBe('daily');
    }
  });

  test('respects limit and offset', async () => {
    const result = await tools.getInvestmentPrices({ limit: 2, offset: 1 });
    expect(result.count).toBe(2);
    expect(result.total_count).toBe(4);
    expect(result.offset).toBe(1);
    expect(result.has_more).toBe(true);
  });

  test('returns unique tickers list', async () => {
    const result = await tools.getInvestmentPrices({});
    expect(result.tickers).toContain('AAPL');
    expect(result.tickers).toContain('SCHX');
    expect(result.tickers.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tools/tools.test.ts -t "getInvestmentPrices"`
Expected: FAIL — `tools.getInvestmentPrices is not a function`

- [ ] **Step 3: Implement the tool method**

Add to `src/tools/tools.ts` in the `CopilotMoneyTools` class, after the `getGoals` method:

```typescript
  /**
   * Get investment price history.
   */
  async getInvestmentPrices(options: {
    ticker_symbol?: string;
    start_date?: string;
    end_date?: string;
    price_type?: 'daily' | 'hf';
    limit?: number;
    offset?: number;
  } = {}): Promise<{
    count: number;
    total_count: number;
    offset: number;
    has_more: boolean;
    tickers: string[];
    prices: InvestmentPrice[];
  }> {
    const { ticker_symbol, start_date, end_date, price_type } = options;
    const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
    const validatedOffset = validateOffset(options.offset);

    if (start_date) validateDate(start_date, 'start_date');
    if (end_date) validateDate(end_date, 'end_date');

    const prices = await this.db.getInvestmentPrices({
      tickerSymbol: ticker_symbol,
      startDate: start_date,
      endDate: end_date,
      priceType: price_type,
    });

    // Extract unique tickers
    const tickerSet = new Set<string>();
    for (const p of prices) {
      if (p.ticker_symbol) tickerSet.add(p.ticker_symbol);
    }

    const totalCount = prices.length;
    const hasMore = validatedOffset + validatedLimit < totalCount;
    const paged = prices.slice(validatedOffset, validatedOffset + validatedLimit);

    return {
      count: paged.length,
      total_count: totalCount,
      offset: validatedOffset,
      has_more: hasMore,
      tickers: [...tickerSet].sort(),
      prices: paged,
    };
  }
```

Add `InvestmentPrice` to the type imports at the top of tools.ts (find the existing import from `'../models/index.js'` and add it).

- [ ] **Step 4: Add the tool schema**

Add to the `createToolSchemas()` return array in `src/tools/tools.ts`, after the `get_goals` entry:

```typescript
    {
      name: 'get_investment_prices',
      description:
        'Get investment price history for portfolio tracking. Returns daily and high-frequency ' +
        'price data for stocks, ETFs, mutual funds, and crypto. Filter by ticker symbol, date range, ' +
        'or price type (daily/hf). Includes OHLCV data when available.',
      inputSchema: {
        type: 'object',
        properties: {
          ticker_symbol: {
            type: 'string',
            description: 'Filter by ticker symbol (e.g., "AAPL", "BTC-USD", "VTSAX")',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD or YYYY-MM)',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD or YYYY-MM)',
          },
          price_type: {
            type: 'string',
            enum: ['daily', 'hf'],
            description: 'Filter by price type: daily (monthly aggregates) or hf (high-frequency intraday)',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results (default: 100, max: 10000)',
            default: 100,
          },
          offset: {
            type: 'integer',
            description: 'Number of results to skip for pagination (default: 0)',
            default: 0,
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
```

- [ ] **Step 5: Add server routing**

Add to `src/server.ts` in the `handleCallTool` switch statement, before the `default` case:

```typescript
        case 'get_investment_prices':
          result = await this.tools.getInvestmentPrices(
            (typedArgs as Parameters<typeof this.tools.getInvestmentPrices>[0]) || {}
          );
          break;
```

- [ ] **Step 6: Add manifest entry**

Add to `manifest.json` in the `tools` array:

```json
    {
      "name": "get_investment_prices",
      "description": "Get investment price history for portfolio tracking. Returns daily and high-frequency price data for stocks, ETFs, mutual funds, and crypto."
    }
```

- [ ] **Step 7: Run tests**

Run: `bun test tests/tools/tools.test.ts -t "getInvestmentPrices"`
Expected: PASS

- [ ] **Step 8: Run full test suite**

Run: `bun run check`
Expected: All tests pass (including manifest sync test)

- [ ] **Step 9: Commit**

```bash
git add src/tools/tools.ts src/server.ts manifest.json tests/tools/tools.test.ts
git commit -m "feat: add get_investment_prices MCP tool

Exposes already-decoded investment price data as a queryable tool.
Supports filtering by ticker symbol, date range, and price type
(daily/hf) with pagination."
```

---

### Task 3: Tool — get_investment_splits

**Files:**
- Modify: `src/tools/tools.ts` (add method + schema)
- Modify: `src/server.ts` (add switch case)
- Modify: `manifest.json` (add tool entry)
- Test: `tests/tools/tools.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/tools/tools.test.ts`:

```typescript
describe('getInvestmentSplits', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._allCollectionsLoaded = true;
    (db as any)._accounts = [];
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
    (db as any)._investmentSplits = [
      { split_id: 's1', ticker_symbol: 'AAPL', split_date: '2020-08-31', split_ratio: '4:1', multiplier: 4 },
      { split_id: 's2', ticker_symbol: 'TSLA', split_date: '2022-08-25', split_ratio: '3:1', multiplier: 3 },
      { split_id: 's3', ticker_symbol: 'AAPL', split_date: '2014-06-09', split_ratio: '7:1', multiplier: 7 },
    ];
    tools = new CopilotMoneyTools(db);
  });

  test('returns all splits', async () => {
    const result = await tools.getInvestmentSplits({});
    expect(result.count).toBe(3);
    expect(result.total_count).toBe(3);
    expect(result).toHaveProperty('splits');
  });

  test('filters by ticker_symbol', async () => {
    const result = await tools.getInvestmentSplits({ ticker_symbol: 'AAPL' });
    expect(result.count).toBe(2);
    for (const s of result.splits) {
      expect(s.ticker_symbol).toBe('AAPL');
    }
  });

  test('filters by date range', async () => {
    const result = await tools.getInvestmentSplits({ start_date: '2020-01-01', end_date: '2021-12-31' });
    expect(result.count).toBe(1);
    expect(result.splits[0].ticker_symbol).toBe('AAPL');
  });

  test('respects limit and offset', async () => {
    const result = await tools.getInvestmentSplits({ limit: 1, offset: 0 });
    expect(result.count).toBe(1);
    expect(result.total_count).toBe(3);
    expect(result.has_more).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tools/tools.test.ts -t "getInvestmentSplits"`
Expected: FAIL — `tools.getInvestmentSplits is not a function`

- [ ] **Step 3: Implement the tool method**

Add to `src/tools/tools.ts` in the `CopilotMoneyTools` class, after `getInvestmentPrices`:

```typescript
  /**
   * Get stock split history.
   */
  async getInvestmentSplits(options: {
    ticker_symbol?: string;
    start_date?: string;
    end_date?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{
    count: number;
    total_count: number;
    offset: number;
    has_more: boolean;
    splits: InvestmentSplit[];
  }> {
    const { ticker_symbol, start_date, end_date } = options;
    const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
    const validatedOffset = validateOffset(options.offset);

    if (start_date) validateDate(start_date, 'start_date');
    if (end_date) validateDate(end_date, 'end_date');

    const splits = await this.db.getInvestmentSplits({
      tickerSymbol: ticker_symbol,
      startDate: start_date,
      endDate: end_date,
    });

    const totalCount = splits.length;
    const hasMore = validatedOffset + validatedLimit < totalCount;
    const paged = splits.slice(validatedOffset, validatedOffset + validatedLimit);

    return {
      count: paged.length,
      total_count: totalCount,
      offset: validatedOffset,
      has_more: hasMore,
      splits: paged,
    };
  }
```

Add `InvestmentSplit` to the type imports at the top of tools.ts.

- [ ] **Step 4: Add the tool schema**

Add to `createToolSchemas()` after `get_investment_prices`:

```typescript
    {
      name: 'get_investment_splits',
      description:
        'Get stock split history. Returns split ratios, dates, and multipliers for ' +
        'accurate historical price and share calculations. Filter by ticker symbol or date range.',
      inputSchema: {
        type: 'object',
        properties: {
          ticker_symbol: {
            type: 'string',
            description: 'Filter by ticker symbol (e.g., "AAPL", "TSLA")',
          },
          start_date: {
            type: 'string',
            description: 'Start date (YYYY-MM-DD)',
          },
          end_date: {
            type: 'string',
            description: 'End date (YYYY-MM-DD)',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results (default: 100, max: 10000)',
            default: 100,
          },
          offset: {
            type: 'integer',
            description: 'Number of results to skip for pagination (default: 0)',
            default: 0,
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
```

- [ ] **Step 5: Add server routing**

Add to `src/server.ts` switch, before `default`:

```typescript
        case 'get_investment_splits':
          result = await this.tools.getInvestmentSplits(
            (typedArgs as Parameters<typeof this.tools.getInvestmentSplits>[0]) || {}
          );
          break;
```

- [ ] **Step 6: Add manifest entry**

```json
    {
      "name": "get_investment_splits",
      "description": "Get stock split history. Returns split ratios, dates, and multipliers for accurate historical price and share calculations."
    }
```

- [ ] **Step 7: Run tests and full suite**

Run: `bun test tests/tools/tools.test.ts -t "getInvestmentSplits" && bun run check`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add src/tools/tools.ts src/server.ts manifest.json tests/tools/tools.test.ts
git commit -m "feat: add get_investment_splits MCP tool

Exposes stock split history for accurate historical calculations.
Filter by ticker symbol and date range with pagination."
```

---

### Task 4: Tool — get_holdings (the star tool)

**Files:**
- Modify: `src/tools/tools.ts` (add method + schema)
- Modify: `src/server.ts` (add switch case)
- Modify: `manifest.json` (add tool entry)
- Test: `tests/tools/tools.test.ts`

- [ ] **Step 1: Write the failing test**

Add mock data and tests to `tests/tools/tools.test.ts`:

```typescript
import type { Transaction, Account, Security, HoldingsHistory } from '../../src/models/index.js';

// ... (add Security and HoldingsHistory to the existing import)

const mockSecurities: Security[] = [
  { security_id: 'sec_aapl', ticker_symbol: 'AAPL', name: 'Apple Inc.', type: 'equity', current_price: 190.0, is_cash_equivalent: false, iso_currency_code: 'USD' },
  { security_id: 'sec_schx', ticker_symbol: 'SCHX', name: 'Schwab U.S. Large-Cap ETF', type: 'etf', current_price: 25.0, is_cash_equivalent: false, iso_currency_code: 'USD' },
  { security_id: 'sec_usd', ticker_symbol: 'USD', name: 'United States Dollar', type: 'cash', current_price: 1.0, is_cash_equivalent: true, iso_currency_code: 'USD' },
];

const mockAccountsWithHoldings: Account[] = [
  {
    account_id: 'inv_acc1',
    current_balance: 100000,
    name: 'Individual Brokerage',
    account_type: 'investment',
    holdings: [
      { security_id: 'sec_aapl', account_id: 'inv_acc1', cost_basis: 15000, institution_price: 190.0, institution_value: 19000, quantity: 100, iso_currency_code: 'USD' },
      { security_id: 'sec_schx', account_id: 'inv_acc1', cost_basis: 5000, institution_price: 25.0, institution_value: 7500, quantity: 300, iso_currency_code: 'USD' },
      { security_id: 'sec_usd', account_id: 'inv_acc1', cost_basis: null, institution_price: 1.0, institution_value: 500, quantity: 500, iso_currency_code: 'USD' },
    ],
  },
  {
    account_id: 'inv_acc2',
    current_balance: 50000,
    name: 'Retirement 401k',
    account_type: 'investment',
    holdings: [
      { security_id: 'sec_schx', account_id: 'inv_acc2', cost_basis: 8000, institution_price: 25.0, institution_value: 12500, quantity: 500, iso_currency_code: 'USD' },
    ],
  },
];

const mockHoldingsHistory: HoldingsHistory[] = [
  {
    history_id: 'sec_aapl:2024-01',
    security_id: 'sec_aapl',
    account_id: 'inv_acc1',
    month: '2024-01',
    history: { '2024-01-15': { price: 185.0, quantity: 100 }, '2024-01-31': { price: 188.0, quantity: 100 } },
  },
  {
    history_id: 'sec_aapl:2024-02',
    security_id: 'sec_aapl',
    account_id: 'inv_acc1',
    month: '2024-02',
    history: { '2024-02-15': { price: 189.0, quantity: 100 } },
  },
];

describe('getHoldings', () => {
  let db: CopilotDatabase;
  let tools: CopilotMoneyTools;

  beforeEach(() => {
    db = new CopilotDatabase('/fake/path');
    (db as any)._allCollectionsLoaded = true;
    (db as any)._transactions = [];
    (db as any)._accounts = [...mockAccountsWithHoldings];
    (db as any)._recurring = [];
    (db as any)._budgets = [];
    (db as any)._goals = [];
    (db as any)._goalHistory = [];
    (db as any)._investmentPrices = [];
    (db as any)._investmentSplits = [];
    (db as any)._items = [];
    (db as any)._userCategories = [];
    (db as any)._userAccounts = [];
    (db as any)._securities = [...mockSecurities];
    (db as any)._holdingsHistory = [...mockHoldingsHistory];
    tools = new CopilotMoneyTools(db);
  });

  test('returns all holdings enriched with security data', async () => {
    const result = await tools.getHoldings({});
    // 3 holdings in acc1 + 1 in acc2 = 4
    expect(result.total_count).toBe(4);
    expect(result.count).toBe(4);

    const aapl = result.holdings.find((h) => h.ticker_symbol === 'AAPL');
    expect(aapl).toBeDefined();
    expect(aapl!.name).toBe('Apple Inc.');
    expect(aapl!.type).toBe('equity');
    expect(aapl!.quantity).toBe(100);
    expect(aapl!.institution_price).toBe(190.0);
    expect(aapl!.institution_value).toBe(19000);
    expect(aapl!.account_name).toBe('Individual Brokerage');
  });

  test('computes average_cost and total_return when cost_basis is present', async () => {
    const result = await tools.getHoldings({});

    const aapl = result.holdings.find((h) => h.ticker_symbol === 'AAPL');
    expect(aapl!.cost_basis).toBe(15000);
    expect(aapl!.average_cost).toBe(150); // 15000 / 100
    expect(aapl!.total_return).toBe(4000); // 19000 - 15000
    expect(aapl!.total_return_percent).toBeCloseTo(26.67, 1); // 4000/15000 * 100
  });

  test('omits average_cost and total_return when cost_basis is null', async () => {
    const result = await tools.getHoldings({});

    const usd = result.holdings.find((h) => h.ticker_symbol === 'USD');
    expect(usd).toBeDefined();
    expect(usd!.cost_basis).toBeUndefined();
    expect(usd!.average_cost).toBeUndefined();
    expect(usd!.total_return).toBeUndefined();
  });

  test('filters by account_id', async () => {
    const result = await tools.getHoldings({ account_id: 'inv_acc2' });
    expect(result.count).toBe(1);
    expect(result.holdings[0].ticker_symbol).toBe('SCHX');
    expect(result.holdings[0].account_name).toBe('Retirement 401k');
  });

  test('filters by ticker_symbol', async () => {
    const result = await tools.getHoldings({ ticker_symbol: 'SCHX' });
    // SCHX is in both accounts
    expect(result.count).toBe(2);
    for (const h of result.holdings) {
      expect(h.ticker_symbol).toBe('SCHX');
    }
  });

  test('does not include history by default', async () => {
    const result = await tools.getHoldings({});
    for (const h of result.holdings) {
      expect(h.history).toBeUndefined();
    }
  });

  test('includes history when include_history is true', async () => {
    const result = await tools.getHoldings({ include_history: true });
    const aapl = result.holdings.find((h) => h.ticker_symbol === 'AAPL');
    expect(aapl!.history).toBeDefined();
    expect(aapl!.history!.length).toBe(2); // 2 months of history
  });

  test('respects limit and offset', async () => {
    const result = await tools.getHoldings({ limit: 2, offset: 1 });
    expect(result.count).toBe(2);
    expect(result.total_count).toBe(4);
    expect(result.offset).toBe(1);
    expect(result.has_more).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tools/tools.test.ts -t "getHoldings"`
Expected: FAIL — `tools.getHoldings is not a function`

- [ ] **Step 3: Implement the tool method**

Add to `src/tools/tools.ts` in the `CopilotMoneyTools` class, after `getInvestmentSplits`:

```typescript
  /**
   * Get current investment holdings with cost basis and returns.
   *
   * Joins holdings (from account documents) with securities for enrichment.
   * Computes average cost and total return when cost_basis is available.
   */
  async getHoldings(options: {
    account_id?: string;
    ticker_symbol?: string;
    include_history?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Promise<{
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
        snapshots: Record<string, { price?: number; quantity?: number }>;
      }>;
    }>;
  }> {
    const { account_id, ticker_symbol, include_history = false } = options;
    const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
    const validatedOffset = validateOffset(options.offset);

    // Load data sources
    const accounts = await this.db.getAccounts();
    const securityMap = await this.db.getSecurityMap();

    // Build ticker → security_id lookup for ticker_symbol filtering
    let tickerSecurityIds: Set<string> | undefined;
    if (ticker_symbol) {
      tickerSecurityIds = new Set<string>();
      for (const [id, sec] of securityMap) {
        if (sec.ticker_symbol?.toLowerCase() === ticker_symbol.toLowerCase()) {
          tickerSecurityIds.add(id);
        }
      }
    }

    // Extract holdings from investment accounts
    type HoldingEntry = {
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
        snapshots: Record<string, { price?: number; quantity?: number }>;
      }>;
    };

    const holdings: HoldingEntry[] = [];

    for (const acct of accounts) {
      if (!acct.holdings || acct.holdings.length === 0) continue;
      if (account_id && acct.account_id !== account_id) continue;

      for (const h of acct.holdings) {
        if (!h.security_id || h.quantity === undefined || h.institution_price === undefined || h.institution_value === undefined) continue;

        // Apply ticker filter
        if (tickerSecurityIds && !tickerSecurityIds.has(h.security_id)) continue;

        // Enrich with security data
        const sec = securityMap.get(h.security_id);

        const entry: HoldingEntry = {
          security_id: h.security_id,
          ticker_symbol: sec?.ticker_symbol,
          name: sec?.name,
          type: sec?.type,
          account_id: acct.account_id,
          account_name: acct.name ?? acct.official_name,
          quantity: h.quantity,
          institution_price: h.institution_price,
          institution_value: h.institution_value,
          is_cash_equivalent: sec?.is_cash_equivalent,
          iso_currency_code: h.iso_currency_code ?? sec?.iso_currency_code,
        };

        // Compute cost basis derived fields
        if (h.cost_basis != null && h.cost_basis !== 0) {
          entry.cost_basis = roundAmount(h.cost_basis);
          entry.average_cost = roundAmount(h.cost_basis / h.quantity);
          entry.total_return = roundAmount(h.institution_value - h.cost_basis);
          entry.total_return_percent = roundAmount(
            ((h.institution_value - h.cost_basis) / Math.abs(h.cost_basis)) * 100
          );
        }

        holdings.push(entry);
      }
    }

    // Attach history if requested
    if (include_history) {
      const allHistory = await this.db.getHoldingsHistory();

      for (const holding of holdings) {
        const matchingHistory = allHistory.filter(
          (hh) =>
            hh.security_id === holding.security_id &&
            (!hh.account_id || hh.account_id === holding.account_id)
        );

        if (matchingHistory.length > 0) {
          holding.history = matchingHistory
            .filter((hh) => hh.month && hh.history)
            .map((hh) => ({
              month: hh.month!,
              snapshots: hh.history!,
            }))
            .sort((a, b) => b.month.localeCompare(a.month));
        }
      }
    }

    // Paginate
    const totalCount = holdings.length;
    const hasMore = validatedOffset + validatedLimit < totalCount;
    const paged = holdings.slice(validatedOffset, validatedOffset + validatedLimit);

    return {
      count: paged.length,
      total_count: totalCount,
      offset: validatedOffset,
      has_more: hasMore,
      holdings: paged,
    };
  }
```

Add `Security` and `HoldingsHistory` to the type imports at the top of tools.ts if not already imported.

- [ ] **Step 4: Add the tool schema**

Add to `createToolSchemas()` after `get_investment_splits`:

```typescript
    {
      name: 'get_holdings',
      description:
        'Get current investment holdings with position-level detail. Returns ticker, name, ' +
        'quantity, current price, equity value, average cost, and total return per holding. ' +
        'Joins data from account holdings, securities, and optionally historical snapshots. ' +
        'Filter by account or ticker symbol. Note: cost_basis may be unavailable for ' +
        'cash-equivalent positions.',
      inputSchema: {
        type: 'object',
        properties: {
          account_id: {
            type: 'string',
            description: 'Filter by investment account ID',
          },
          ticker_symbol: {
            type: 'string',
            description: 'Filter by ticker symbol (e.g., "AAPL", "SCHX")',
          },
          include_history: {
            type: 'boolean',
            description: 'Include monthly price/quantity snapshots per holding (default: false)',
            default: false,
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results (default: 100, max: 10000)',
            default: 100,
          },
          offset: {
            type: 'integer',
            description: 'Number of results to skip for pagination (default: 0)',
            default: 0,
          },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
```

- [ ] **Step 5: Add server routing**

Add to `src/server.ts` switch, before `default`:

```typescript
        case 'get_holdings':
          result = await this.tools.getHoldings(
            (typedArgs as Parameters<typeof this.tools.getHoldings>[0]) || {}
          );
          break;
```

- [ ] **Step 6: Add manifest entry**

```json
    {
      "name": "get_holdings",
      "description": "Get current investment holdings with position-level detail including ticker, quantity, price, average cost, and total return per holding."
    }
```

- [ ] **Step 7: Run tests**

Run: `bun test tests/tools/tools.test.ts -t "getHoldings"`
Expected: PASS

- [ ] **Step 8: Run full test suite**

Run: `bun run check`
Expected: All tests pass (tool count now 12, manifest sync passes)

- [ ] **Step 9: Commit**

```bash
git add src/tools/tools.ts src/server.ts manifest.json tests/tools/tools.test.ts
git commit -m "feat: add get_holdings MCP tool

Computed tool that joins holdings from account documents with securities
for enriched portfolio view. Returns ticker, name, quantity, price,
equity value, average cost, and total return per holding.

Closes #147"
```

---

### Task 5: Protocol test updates and final verification

**Files:**
- Modify: `tests/unit/server-protocol.test.ts`

- [ ] **Step 1: Add new tools to protocol tests**

In `tests/unit/server-protocol.test.ts`, find the `expect(toolNames).toContain(...)` block and add:

```typescript
    expect(toolNames).toContain('get_investment_prices');
    expect(toolNames).toContain('get_investment_splits');
    expect(toolNames).toContain('get_holdings');
```

- [ ] **Step 2: Run full test suite**

Run: `bun run check`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/unit/server-protocol.test.ts
git commit -m "test: add protocol assertions for new investment tools"
```

- [ ] **Step 4: Push and update PR**

```bash
git push
```
