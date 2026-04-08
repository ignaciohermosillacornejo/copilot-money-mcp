# Missing Tools Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 5 new read tools and 1 write tool to close all identified gaps between decoded Firestore collections and exposed MCP tools.

**Architecture:** Each tool follows the existing pattern — add cache + database accessor in `database.ts`, implement tool method + schema in `tools.ts`, register in `server.ts` switch + `manifest.json`. TDD throughout.

**Tech Stack:** TypeScript, Bun test runner, Zod schemas, Firestore REST API (writes)

**Spec:** `docs/superpowers/specs/2026-04-07-missing-tools-audit-design.md`

---

### Task 1: Add `getBalanceHistory()` to database layer

**Files:**
- Modify: `src/core/database.ts:146-161` (cache fields), `src/core/database.ts:259-297` (clearCache), `src/core/database.ts:413-430` (loadAllCollections population)
- Test: `tests/core/database.test.ts`

Balance history data comes from `decodeAllCollections()` but is not currently cached in the database class. We need to add caching infrastructure and a public accessor.

- [ ] **Step 1: Write failing test for `getBalanceHistory()`**

```typescript
describe('getBalanceHistory', () => {
  test('returns all balance history when no filters', async () => {
    const history = await db.getBalanceHistory();
    expect(history.length).toBeGreaterThan(0);
  });

  test('filters by accountId', async () => {
    const allHistory = await db.getBalanceHistory();
    const accountId = allHistory[0]!.account_id;
    const filtered = await db.getBalanceHistory({ accountId });
    expect(filtered.every((h) => h.account_id === accountId)).toBe(true);
  });

  test('filters by date range', async () => {
    const filtered = await db.getBalanceHistory({
      startDate: '2024-01-01',
      endDate: '2024-06-30',
    });
    for (const h of filtered) {
      expect(h.date >= '2024-01-01').toBe(true);
      expect(h.date <= '2024-06-30').toBe(true);
    }
  });

  test('returns empty array when no matches', async () => {
    const result = await db.getBalanceHistory({ accountId: 'nonexistent' });
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/database.test.ts --filter "getBalanceHistory"`
Expected: FAIL — `db.getBalanceHistory is not a function`

- [ ] **Step 3: Add cache fields and implement `getBalanceHistory()`**

In `src/core/database.ts`, add import at top:

```typescript
import { BalanceHistory } from '../models/balance-history.js';
```

Add cache field after line 161 (`private _holdingsHistory`):

```typescript
private _balanceHistory: BalanceHistory[] | null = null;
```

Add to `clearCache()` after line 278 (`this._holdingsHistory = null`):

```typescript
this._balanceHistory = null;
```

Add to `loadAllCollections()` after line 430 (`this._tags = result.tags`):

```typescript
this._balanceHistory = result.balanceHistory;
```

Add private loader method (same pattern as `loadGoalHistory`):

```typescript
private async loadBalanceHistory(): Promise<BalanceHistory[]> {
  if (this._balanceHistory !== null) {
    return this._balanceHistory;
  }

  if (!this._allCollectionsLoaded) {
    await this.loadAllCollections();
    return this._balanceHistory ?? [];
  }

  return [];
}
```

Add public accessor method (before `checkCacheLimitation`):

```typescript
/**
 * Get balance history — daily balance snapshots for accounts.
 *
 * Firestore path: items/{item_id}/accounts/{account_id}/balance_history/{date}
 *
 * @param options - Optional filters for accountId and date range
 * @returns Array of BalanceHistory sorted by account_id asc, date desc
 */
async getBalanceHistory(
  options: {
    accountId?: string;
    startDate?: string;
    endDate?: string;
  } = {}
): Promise<BalanceHistory[]> {
  const { accountId, startDate, endDate } = options;
  const all = await this.loadBalanceHistory();
  let result = [...all];

  if (accountId) {
    result = result.filter((h) => h.account_id === accountId);
  }
  if (startDate) {
    result = result.filter((h) => h.date >= startDate);
  }
  if (endDate) {
    result = result.filter((h) => h.date <= endDate);
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/database.test.ts --filter "getBalanceHistory"`
Expected: PASS (tests may need mock data setup — use the `(db as any)._balanceHistory = [...]` pattern from the existing test setup if testing against mocks rather than real DB)

- [ ] **Step 5: Commit**

```bash
git add src/core/database.ts tests/core/database.test.ts
git commit -m "feat: add getBalanceHistory() to database layer"
```

---

### Task 2: Add `getInvestmentPerformance()` and `getTwrHoldings()` to database layer

**Files:**
- Modify: `src/core/database.ts` (cache fields, clearCache, loadAllCollections, new methods)
- Test: `tests/core/database.test.ts`

Same caching pattern as Task 1, for two more collections.

- [ ] **Step 1: Write failing tests**

```typescript
describe('getInvestmentPerformance', () => {
  test('returns all performance data when no filters', async () => {
    const perf = await db.getInvestmentPerformance();
    expect(Array.isArray(perf)).toBe(true);
  });

  test('filters by securityId', async () => {
    const all = await db.getInvestmentPerformance();
    if (all.length === 0) return; // skip if no data
    const secId = all[0]!.security_id!;
    const filtered = await db.getInvestmentPerformance({ securityId: secId });
    expect(filtered.every((p) => p.security_id === secId)).toBe(true);
  });
});

describe('getTwrHoldings', () => {
  test('returns all TWR data when no filters', async () => {
    const twr = await db.getTwrHoldings();
    expect(Array.isArray(twr)).toBe(true);
  });

  test('filters by securityId', async () => {
    const all = await db.getTwrHoldings();
    if (all.length === 0) return;
    const secId = all[0]!.security_id!;
    const filtered = await db.getTwrHoldings({ securityId: secId });
    expect(filtered.every((t) => t.security_id === secId)).toBe(true);
  });

  test('filters by month range', async () => {
    const filtered = await db.getTwrHoldings({
      startMonth: '2024-01',
      endMonth: '2024-06',
    });
    for (const t of filtered) {
      if (t.month) {
        expect(t.month >= '2024-01').toBe(true);
        expect(t.month <= '2024-06').toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/database.test.ts --filter "getInvestmentPerformance|getTwrHoldings"`
Expected: FAIL — methods not found

- [ ] **Step 3: Implement both methods**

Add imports at top of `src/core/database.ts`:

```typescript
import { InvestmentPerformance } from '../models/investment-performance.js';
import { TwrHolding } from '../models/investment-performance.js';
```

Add cache fields after the `_balanceHistory` field added in Task 1:

```typescript
private _investmentPerformance: InvestmentPerformance[] | null = null;
private _twrHoldings: TwrHolding[] | null = null;
```

Add to `clearCache()`:

```typescript
this._investmentPerformance = null;
this._twrHoldings = null;
```

Add to `loadAllCollections()` cache population:

```typescript
this._investmentPerformance = result.investmentPerformance;
this._twrHoldings = result.twrHoldings;
```

Add private loaders:

```typescript
private async loadInvestmentPerformance(): Promise<InvestmentPerformance[]> {
  if (this._investmentPerformance !== null) {
    return this._investmentPerformance;
  }

  if (!this._allCollectionsLoaded) {
    await this.loadAllCollections();
    return this._investmentPerformance ?? [];
  }

  return [];
}

private async loadTwrHoldings(): Promise<TwrHolding[]> {
  if (this._twrHoldings !== null) {
    return this._twrHoldings;
  }

  if (!this._allCollectionsLoaded) {
    await this.loadAllCollections();
    return this._twrHoldings ?? [];
  }

  return [];
}
```

Add public accessors:

```typescript
/**
 * Get investment performance data per security.
 *
 * Firestore path: investment_performance/{hash}
 *
 * @param options - Optional filter by securityId
 * @returns Array of InvestmentPerformance objects
 */
async getInvestmentPerformance(
  options: {
    securityId?: string;
  } = {}
): Promise<InvestmentPerformance[]> {
  const { securityId } = options;
  const all = await this.loadInvestmentPerformance();
  let result = [...all];

  if (securityId) {
    result = result.filter((p) => p.security_id === securityId);
  }

  return result;
}

/**
 * Get time-weighted return (TWR) monthly data for holdings.
 *
 * Firestore path: investment_performance/{hash}/twr_holding
 *
 * @param options - Optional filters for securityId and month range
 * @returns Array of TwrHolding objects
 */
async getTwrHoldings(
  options: {
    securityId?: string;
    startMonth?: string;
    endMonth?: string;
  } = {}
): Promise<TwrHolding[]> {
  const { securityId, startMonth, endMonth } = options;
  const all = await this.loadTwrHoldings();
  let result = [...all];

  if (securityId) {
    result = result.filter((t) => t.security_id === securityId);
  }
  if (startMonth) {
    result = result.filter((t) => t.month && t.month >= startMonth);
  }
  if (endMonth) {
    result = result.filter((t) => t.month && t.month <= endMonth);
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/database.test.ts --filter "getInvestmentPerformance|getTwrHoldings"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/database.ts tests/core/database.test.ts
git commit -m "feat: add getInvestmentPerformance() and getTwrHoldings() to database layer"
```

---

### Task 3: Extend `getSecurities()` with filter params

**Files:**
- Modify: `src/core/database.ts:1294-1296`
- Test: `tests/core/database.test.ts`

The existing `getSecurities()` takes no params. Add optional `tickerSymbol` and `type` filters, backwards-compatible.

- [ ] **Step 1: Write failing test**

```typescript
describe('getSecurities filtering', () => {
  test('filters by tickerSymbol case-insensitively', async () => {
    const all = await db.getSecurities();
    if (all.length === 0) return;
    const ticker = all[0]!.ticker_symbol!;
    const filtered = await db.getSecurities({ tickerSymbol: ticker.toLowerCase() });
    expect(filtered.every((s) => s.ticker_symbol?.toLowerCase() === ticker.toLowerCase())).toBe(true);
  });

  test('filters by type', async () => {
    const all = await db.getSecurities();
    if (all.length === 0) return;
    const type = all[0]!.type!;
    const filtered = await db.getSecurities({ type });
    expect(filtered.every((s) => s.type === type)).toBe(true);
  });

  test('returns all when no filters passed', async () => {
    const all = await db.getSecurities();
    const also = await db.getSecurities({});
    expect(all.length).toBe(also.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/database.test.ts --filter "getSecurities filtering"`
Expected: FAIL — `getSecurities` doesn't accept arguments

- [ ] **Step 3: Update `getSecurities()` signature**

Replace the existing method at line 1294:

```typescript
async getSecurities(
  options: {
    tickerSymbol?: string;
    type?: string;
  } = {}
): Promise<Security[]> {
  const { tickerSymbol, type } = options;
  const all = await this.loadSecurities();
  let result = [...all];

  if (tickerSymbol) {
    const lower = tickerSymbol.toLowerCase();
    result = result.filter((s) => s.ticker_symbol?.toLowerCase() === lower);
  }
  if (type) {
    result = result.filter((s) => s.type === type);
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/database.test.ts --filter "getSecurities"`
Expected: PASS

- [ ] **Step 5: Verify existing callers still work**

Run: `bun test`
Expected: All 1267+ tests pass. Existing callers of `getSecurities()` pass no args, so the default `{}` keeps them working.

- [ ] **Step 6: Commit**

```bash
git add src/core/database.ts tests/core/database.test.ts
git commit -m "feat: add tickerSymbol and type filters to getSecurities()"
```

---

### Task 4: Implement `get_balance_history` tool

**Files:**
- Modify: `src/tools/tools.ts` (new method + schema)
- Test: `tests/tools/tools.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('getBalanceHistory', () => {
  test('requires granularity parameter', async () => {
    await expect(tools.getBalanceHistory({} as any)).rejects.toThrow('granularity is required');
  });

  test('rejects invalid granularity', async () => {
    await expect(tools.getBalanceHistory({ granularity: 'hourly' as any })).rejects.toThrow(
      'Invalid granularity'
    );
  });

  test('returns daily balance history', async () => {
    const result = await tools.getBalanceHistory({ granularity: 'daily' });
    expect(result.count).toBeGreaterThanOrEqual(0);
    expect(result).toHaveProperty('total_count');
    expect(result).toHaveProperty('has_more');
    expect(result).toHaveProperty('balance_history');
  });

  test('downsamples to weekly', async () => {
    const daily = await tools.getBalanceHistory({ granularity: 'daily' });
    const weekly = await tools.getBalanceHistory({ granularity: 'weekly' });
    expect(weekly.total_count).toBeLessThanOrEqual(daily.total_count);
  });

  test('downsamples to monthly', async () => {
    const daily = await tools.getBalanceHistory({ granularity: 'daily' });
    const monthly = await tools.getBalanceHistory({ granularity: 'monthly' });
    expect(monthly.total_count).toBeLessThanOrEqual(daily.total_count);
  });

  test('filters by account_id', async () => {
    const result = await tools.getBalanceHistory({
      granularity: 'daily',
      account_id: 'acc-1',
    });
    for (const h of result.balance_history) {
      expect(h.account_id).toBe('acc-1');
    }
  });

  test('paginates with limit and offset', async () => {
    const result = await tools.getBalanceHistory({
      granularity: 'daily',
      limit: 2,
      offset: 0,
    });
    expect(result.count).toBeLessThanOrEqual(2);
  });
});
```

Set up mock balance history data in `beforeEach`:

```typescript
(db as any)._balanceHistory = [
  { balance_id: 'i1:acc-1:2024-01-01', date: '2024-01-01', item_id: 'i1', account_id: 'acc-1', current_balance: 1000 },
  { balance_id: 'i1:acc-1:2024-01-08', date: '2024-01-08', item_id: 'i1', account_id: 'acc-1', current_balance: 1100 },
  { balance_id: 'i1:acc-1:2024-01-15', date: '2024-01-15', item_id: 'i1', account_id: 'acc-1', current_balance: 1200 },
  { balance_id: 'i1:acc-1:2024-01-22', date: '2024-01-22', item_id: 'i1', account_id: 'acc-1', current_balance: 1300 },
  { balance_id: 'i1:acc-1:2024-01-29', date: '2024-01-29', item_id: 'i1', account_id: 'acc-1', current_balance: 1400 },
  { balance_id: 'i1:acc-1:2024-02-05', date: '2024-02-05', item_id: 'i1', account_id: 'acc-1', current_balance: 1500 },
  { balance_id: 'i1:acc-2:2024-01-01', date: '2024-01-01', item_id: 'i1', account_id: 'acc-2', current_balance: 5000 },
];
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tools/tools.test.ts --filter "getBalanceHistory"`
Expected: FAIL — `tools.getBalanceHistory is not a function`

- [ ] **Step 3: Implement `getBalanceHistory()` method in `CopilotMoneyTools`**

Add to `src/tools/tools.ts` in the `CopilotMoneyTools` class, after the last read tool method:

```typescript
async getBalanceHistory(options: {
  account_id?: string;
  start_date?: string;
  end_date?: string;
  granularity: 'daily' | 'weekly' | 'monthly';
  limit?: number;
  offset?: number;
}): Promise<{
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  accounts: string[];
  balance_history: Array<{
    date: string;
    account_id: string;
    account_name?: string;
    current_balance?: number;
    available_balance?: number;
    limit?: number;
  }>;
}> {
  const { account_id, start_date, end_date, granularity } = options;
  const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
  const validatedOffset = validateOffset(options.offset);

  if (!granularity) {
    throw new Error('granularity is required — must be "daily", "weekly", or "monthly"');
  }
  const validGranularities = ['daily', 'weekly', 'monthly'] as const;
  if (!(validGranularities as readonly string[]).includes(granularity)) {
    throw new Error(
      `Invalid granularity: ${granularity}. Must be one of: ${validGranularities.join(', ')}`
    );
  }
  if (start_date) validateDate(start_date, 'start_date');
  if (end_date) validateDate(end_date, 'end_date');

  const raw = await this.db.getBalanceHistory({
    accountId: account_id,
    startDate: start_date,
    endDate: end_date,
  });

  // Downsample if needed
  let sampled = raw;
  if (granularity === 'weekly' || granularity === 'monthly') {
    // Group by account_id + period key, keep last date per group
    const grouped = new Map<string, typeof raw[0]>();
    for (const row of raw) {
      const periodKey =
        granularity === 'monthly'
          ? `${row.account_id}:${row.date.slice(0, 7)}` // YYYY-MM
          : `${row.account_id}:${getISOWeekKey(row.date)}`; // YYYY-Www
      const existing = grouped.get(periodKey);
      if (!existing || row.date > existing.date) {
        grouped.set(periodKey, row);
      }
    }
    sampled = [...grouped.values()].sort((a, b) => {
      const acctCmp = a.account_id.localeCompare(b.account_id);
      if (acctCmp !== 0) return acctCmp;
      return b.date.localeCompare(a.date);
    });
  }

  // Enrich with account names
  const accountNameMap = await this.db.getAccountNameMap();
  const accountSet = new Set<string>();

  const enriched = sampled.map((row) => {
    accountSet.add(row.account_id);
    return {
      date: row.date,
      account_id: row.account_id,
      account_name: accountNameMap.get(row.account_id),
      current_balance: row.current_balance,
      available_balance: row.available_balance,
      limit: row.limit ?? undefined,
    };
  });

  const totalCount = enriched.length;
  const hasMore = validatedOffset + validatedLimit < totalCount;
  const paged = enriched.slice(validatedOffset, validatedOffset + validatedLimit);

  return {
    count: paged.length,
    total_count: totalCount,
    offset: validatedOffset,
    has_more: hasMore,
    accounts: [...accountSet].sort(),
    balance_history: paged,
  };
}
```

Add the ISO week helper at the top of the file (near the other helpers):

```typescript
function getISOWeekKey(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dayOfWeek = d.getUTCDay() || 7; // Mon=1, Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek); // Thursday of the week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}
```

- [ ] **Step 4: Add schema to `createToolSchemas()`**

Add before the closing `];` of `createToolSchemas()` (before line 4090):

```typescript
{
  name: 'get_balance_history',
  description:
    'Get daily balance snapshots for accounts over time. Returns current_balance, ' +
    'available_balance, and limit per day. Requires a granularity parameter (daily, weekly, ' +
    'or monthly) to control response size. Weekly and monthly modes downsample by keeping ' +
    'the last data point per period. Filter by account_id and date range.',
  inputSchema: {
    type: 'object',
    properties: {
      account_id: {
        type: 'string',
        description: 'Filter by account ID',
      },
      start_date: {
        type: 'string',
        description: 'Start date (YYYY-MM-DD)',
      },
      end_date: {
        type: 'string',
        description: 'End date (YYYY-MM-DD)',
      },
      granularity: {
        type: 'string',
        enum: ['daily', 'weekly', 'monthly'],
        description:
          'Required. Controls response density: daily (every day), weekly (one per week), ' +
          'or monthly (one per month). Use weekly or monthly for longer time ranges.',
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
    required: ['granularity'],
  },
  annotations: { readOnlyHint: true },
},
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/tools/tools.test.ts --filter "getBalanceHistory"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/tools.ts tests/tools/tools.test.ts
git commit -m "feat: add get_balance_history tool with granularity downsampling"
```

---

### Task 5: Implement `get_investment_performance` tool

**Files:**
- Modify: `src/tools/tools.ts` (new method + schema)
- Test: `tests/tools/tools.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('getInvestmentPerformance', () => {
  test('returns all performance data', async () => {
    const result = await tools.getInvestmentPerformance();
    expect(result).toHaveProperty('count');
    expect(result).toHaveProperty('performance');
    expect(Array.isArray(result.performance)).toBe(true);
  });

  test('filters by ticker_symbol', async () => {
    const result = await tools.getInvestmentPerformance({ ticker_symbol: 'AAPL' });
    expect(Array.isArray(result.performance)).toBe(true);
  });

  test('filters by security_id', async () => {
    const result = await tools.getInvestmentPerformance({ security_id: 'sec-1' });
    for (const p of result.performance) {
      expect(p.security_id).toBe('sec-1');
    }
  });

  test('enriches with ticker_symbol from security map', async () => {
    const result = await tools.getInvestmentPerformance();
    if (result.count > 0) {
      const hasEnrichedField = result.performance.some(
        (p) => p.ticker_symbol !== undefined || p.name !== undefined
      );
      expect(hasEnrichedField).toBe(true);
    }
  });

  test('paginates with limit and offset', async () => {
    const result = await tools.getInvestmentPerformance({ limit: 1 });
    expect(result.count).toBeLessThanOrEqual(1);
  });
});
```

Set up mock data in `beforeEach`:

```typescript
(db as any)._investmentPerformance = [
  { performance_id: 'perf-1', security_id: 'sec-1', type: 'equity' },
  { performance_id: 'perf-2', security_id: 'sec-2', type: 'etf' },
];
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tools/tools.test.ts --filter "getInvestmentPerformance"`
Expected: FAIL

- [ ] **Step 3: Implement `getInvestmentPerformance()` method**

```typescript
async getInvestmentPerformance(
  options: {
    ticker_symbol?: string;
    security_id?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<{
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  performance: Array<
    InvestmentPerformance & {
      ticker_symbol?: string;
      name?: string;
    }
  >;
}> {
  const { ticker_symbol, security_id } = options;
  const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
  const validatedOffset = validateOffset(options.offset);

  const securityMap = await this.db.getSecurityMap();

  // Resolve ticker_symbol to security IDs
  let tickerSecurityIds: Set<string> | undefined;
  if (ticker_symbol) {
    tickerSecurityIds = new Set<string>();
    for (const [id, sec] of securityMap) {
      if (sec.ticker_symbol?.toLowerCase() === ticker_symbol.toLowerCase()) {
        tickerSecurityIds.add(id);
      }
    }
  }

  let data = await this.db.getInvestmentPerformance(
    security_id ? { securityId: security_id } : {}
  );

  // Apply ticker filter
  if (tickerSecurityIds) {
    data = data.filter((p) => p.security_id && tickerSecurityIds!.has(p.security_id));
  }

  // Enrich with security data
  const enriched = data.map((p) => {
    const sec = p.security_id ? securityMap.get(p.security_id) : undefined;
    return {
      ...p,
      ticker_symbol: sec?.ticker_symbol,
      name: sec?.name,
    };
  });

  const totalCount = enriched.length;
  const hasMore = validatedOffset + validatedLimit < totalCount;
  const paged = enriched.slice(validatedOffset, validatedOffset + validatedLimit);

  return {
    count: paged.length,
    total_count: totalCount,
    offset: validatedOffset,
    has_more: hasMore,
    performance: paged,
  };
}
```

- [ ] **Step 4: Add schema to `createToolSchemas()`**

```typescript
{
  name: 'get_investment_performance',
  description:
    'Get per-security investment performance data. Returns raw performance documents ' +
    'from Firestore, enriched with ticker symbol and name from the securities collection. ' +
    'Filter by ticker symbol or security ID.',
  inputSchema: {
    type: 'object',
    properties: {
      ticker_symbol: {
        type: 'string',
        description: 'Filter by ticker symbol (e.g., "AAPL", "VTSAX")',
      },
      security_id: {
        type: 'string',
        description: 'Filter by security ID (SHA256 hash)',
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
  annotations: { readOnlyHint: true },
},
```

- [ ] **Step 5: Run tests, verify pass**

Run: `bun test tests/tools/tools.test.ts --filter "getInvestmentPerformance"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/tools.ts tests/tools/tools.test.ts
git commit -m "feat: add get_investment_performance tool"
```

---

### Task 6: Implement `get_twr_returns` tool

**Files:**
- Modify: `src/tools/tools.ts` (new method + schema)
- Test: `tests/tools/tools.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('getTwrReturns', () => {
  test('returns all TWR data', async () => {
    const result = await tools.getTwrReturns();
    expect(result).toHaveProperty('count');
    expect(result).toHaveProperty('twr_returns');
  });

  test('filters by security_id', async () => {
    const result = await tools.getTwrReturns({ security_id: 'sec-1' });
    for (const t of result.twr_returns) {
      expect(t.security_id).toBe('sec-1');
    }
  });

  test('filters by month range', async () => {
    const result = await tools.getTwrReturns({
      start_month: '2024-01',
      end_month: '2024-06',
    });
    for (const t of result.twr_returns) {
      if (t.month) {
        expect(t.month >= '2024-01').toBe(true);
        expect(t.month <= '2024-06').toBe(true);
      }
    }
  });

  test('enriches with ticker_symbol from security map', async () => {
    const result = await tools.getTwrReturns();
    if (result.count > 0) {
      expect(result.twr_returns[0]).toHaveProperty('ticker_symbol');
    }
  });
});
```

Set up mock data in `beforeEach`:

```typescript
(db as any)._twrHoldings = [
  { twr_id: 'twr-1', security_id: 'sec-1', month: '2024-01', history: { '1704067200000': { value: 100 } } },
  { twr_id: 'twr-2', security_id: 'sec-1', month: '2024-02', history: { '1706745600000': { value: 105 } } },
  { twr_id: 'twr-3', security_id: 'sec-2', month: '2024-03', history: { '1709251200000': { value: 200 } } },
];
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tools/tools.test.ts --filter "getTwrReturns"`
Expected: FAIL

- [ ] **Step 3: Implement `getTwrReturns()` method**

```typescript
async getTwrReturns(
  options: {
    ticker_symbol?: string;
    security_id?: string;
    start_month?: string;
    end_month?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<{
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  twr_returns: Array<
    TwrHolding & {
      ticker_symbol?: string;
      name?: string;
    }
  >;
}> {
  const { ticker_symbol, security_id, start_month, end_month } = options;
  const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
  const validatedOffset = validateOffset(options.offset);

  const securityMap = await this.db.getSecurityMap();

  // Resolve ticker to security IDs
  let tickerSecurityIds: Set<string> | undefined;
  if (ticker_symbol) {
    tickerSecurityIds = new Set<string>();
    for (const [id, sec] of securityMap) {
      if (sec.ticker_symbol?.toLowerCase() === ticker_symbol.toLowerCase()) {
        tickerSecurityIds.add(id);
      }
    }
  }

  let data = await this.db.getTwrHoldings({
    securityId: security_id,
    startMonth: start_month,
    endMonth: end_month,
  });

  // Apply ticker filter
  if (tickerSecurityIds) {
    data = data.filter((t) => t.security_id && tickerSecurityIds!.has(t.security_id));
  }

  // Enrich with security data
  const enriched = data.map((t) => {
    const sec = t.security_id ? securityMap.get(t.security_id) : undefined;
    return {
      ...t,
      ticker_symbol: sec?.ticker_symbol,
      name: sec?.name,
    };
  });

  const totalCount = enriched.length;
  const hasMore = validatedOffset + validatedLimit < totalCount;
  const paged = enriched.slice(validatedOffset, validatedOffset + validatedLimit);

  return {
    count: paged.length,
    total_count: totalCount,
    offset: validatedOffset,
    has_more: hasMore,
    twr_returns: paged,
  };
}
```

- [ ] **Step 4: Add schema to `createToolSchemas()`**

```typescript
{
  name: 'get_twr_returns',
  description:
    'Get time-weighted return (TWR) monthly data for investment holdings. Returns raw ' +
    'monthly TWR documents with epoch-millisecond keyed history entries. ' +
    'Filter by ticker symbol, security ID, or month range (YYYY-MM).',
  inputSchema: {
    type: 'object',
    properties: {
      ticker_symbol: {
        type: 'string',
        description: 'Filter by ticker symbol (e.g., "AAPL", "VTSAX")',
      },
      security_id: {
        type: 'string',
        description: 'Filter by security ID (SHA256 hash)',
      },
      start_month: {
        type: 'string',
        description: 'Start month (YYYY-MM)',
      },
      end_month: {
        type: 'string',
        description: 'End month (YYYY-MM)',
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
  annotations: { readOnlyHint: true },
},
```

- [ ] **Step 5: Run tests, verify pass**

Run: `bun test tests/tools/tools.test.ts --filter "getTwrReturns"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/tools.ts tests/tools/tools.test.ts
git commit -m "feat: add get_twr_returns tool"
```

---

### Task 7: Implement `get_securities` tool

**Files:**
- Modify: `src/tools/tools.ts` (new method + schema)
- Test: `tests/tools/tools.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('getSecurities', () => {
  test('returns all securities', async () => {
    const result = await tools.getSecurities();
    expect(result).toHaveProperty('count');
    expect(result).toHaveProperty('securities');
    expect(Array.isArray(result.securities)).toBe(true);
  });

  test('filters by ticker_symbol case-insensitively', async () => {
    const result = await tools.getSecurities({ ticker_symbol: 'aapl' });
    for (const s of result.securities) {
      expect(s.ticker_symbol?.toLowerCase()).toBe('aapl');
    }
  });

  test('filters by type', async () => {
    const result = await tools.getSecurities({ type: 'etf' });
    for (const s of result.securities) {
      expect(s.type).toBe('etf');
    }
  });

  test('paginates with limit and offset', async () => {
    const result = await tools.getSecurities({ limit: 1 });
    expect(result.count).toBeLessThanOrEqual(1);
    expect(result).toHaveProperty('has_more');
  });
});
```

Set up mock data in `beforeEach`:

```typescript
(db as any)._securities = [
  { security_id: 'sec-1', ticker_symbol: 'AAPL', name: 'Apple Inc.', type: 'equity', current_price: 175.50 },
  { security_id: 'sec-2', ticker_symbol: 'VTSAX', name: 'Vanguard Total Stock Market', type: 'mutual fund', current_price: 105.20 },
  { security_id: 'sec-3', ticker_symbol: 'BND', name: 'Vanguard Bond ETF', type: 'etf', current_price: 72.30 },
];
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tools/tools.test.ts --filter "getSecurities"`
Expected: FAIL

- [ ] **Step 3: Implement `getSecurities()` tool method**

```typescript
async getSecurities(
  options: {
    ticker_symbol?: string;
    type?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<{
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  securities: Security[];
}> {
  const { ticker_symbol, type } = options;
  const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
  const validatedOffset = validateOffset(options.offset);

  const securities = await this.db.getSecurities({
    tickerSymbol: ticker_symbol,
    type,
  });

  const totalCount = securities.length;
  const hasMore = validatedOffset + validatedLimit < totalCount;
  const paged = securities.slice(validatedOffset, validatedOffset + validatedLimit);

  return {
    count: paged.length,
    total_count: totalCount,
    offset: validatedOffset,
    has_more: hasMore,
    securities: paged,
  };
}
```

Add the `Security` type import at the top of `tools.ts` if not already present:

```typescript
import type { Security } from '../models/security.js';
```

- [ ] **Step 4: Add schema to `createToolSchemas()`**

```typescript
{
  name: 'get_securities',
  description:
    'Get security master data — stocks, ETFs, mutual funds, and cash equivalents. ' +
    'Returns ticker symbol, name, type, current price, ISIN/CUSIP identifiers, ' +
    'and update metadata. Filter by ticker symbol or security type.',
  inputSchema: {
    type: 'object',
    properties: {
      ticker_symbol: {
        type: 'string',
        description: 'Filter by ticker symbol (e.g., "AAPL", "VTSAX")',
      },
      type: {
        type: 'string',
        description: 'Filter by security type (e.g., "equity", "etf", "mutual fund")',
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
  annotations: { readOnlyHint: true },
},
```

- [ ] **Step 5: Run tests, verify pass**

Run: `bun test tests/tools/tools.test.ts --filter "getSecurities"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/tools.ts tests/tools/tools.test.ts
git commit -m "feat: add get_securities tool"
```

---

### Task 8: Implement `get_goal_history` tool

**Files:**
- Modify: `src/tools/tools.ts` (new method + schema)
- Test: `tests/tools/tools.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('getGoalHistory', () => {
  test('returns all goal history', async () => {
    const result = await tools.getGoalHistory();
    expect(result).toHaveProperty('count');
    expect(result).toHaveProperty('goal_history');
  });

  test('filters by goal_id', async () => {
    const result = await tools.getGoalHistory({ goal_id: 'goal-1' });
    for (const h of result.goal_history) {
      expect(h.goal_id).toBe('goal-1');
    }
  });

  test('filters by month range', async () => {
    const result = await tools.getGoalHistory({
      start_month: '2024-01',
      end_month: '2024-06',
    });
    for (const h of result.goal_history) {
      expect(h.month >= '2024-01').toBe(true);
      expect(h.month <= '2024-06').toBe(true);
    }
  });

  test('enriches with goal_name', async () => {
    const result = await tools.getGoalHistory({ goal_id: 'goal-1' });
    if (result.count > 0) {
      expect(result.goal_history[0]).toHaveProperty('goal_name');
    }
  });

  test('paginates with limit and offset', async () => {
    const result = await tools.getGoalHistory({ limit: 1 });
    expect(result.count).toBeLessThanOrEqual(1);
  });
});
```

Use the existing `mockGoalHistoryWrongOrder` data in beforeEach or add:

```typescript
// If not already present, goal history mock data should match the existing pattern
// The existing mockGoalHistoryWrongOrder already has goal_id: 'goal-1' entries
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tools/tools.test.ts --filter "getGoalHistory"`
Expected: FAIL

- [ ] **Step 3: Implement `getGoalHistory()` tool method**

```typescript
async getGoalHistory(
  options: {
    goal_id?: string;
    start_month?: string;
    end_month?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<{
  count: number;
  total_count: number;
  offset: number;
  has_more: boolean;
  goal_history: Array<
    GoalHistory & {
      goal_name?: string;
    }
  >;
}> {
  const { goal_id, start_month, end_month } = options;
  const validatedLimit = validateLimit(options.limit, DEFAULT_QUERY_LIMIT);
  const validatedOffset = validateOffset(options.offset);

  const history = await this.db.getGoalHistory(goal_id, {
    startMonth: start_month,
    endMonth: end_month,
  });

  // Build goal name map for enrichment
  const goals = await this.db.getGoals(false);
  const goalNameMap = new Map<string, string>();
  for (const g of goals) {
    if (g.name) goalNameMap.set(g.goal_id, g.name);
  }

  const enriched = history.map((h) => ({
    ...h,
    goal_name: goalNameMap.get(h.goal_id),
  }));

  const totalCount = enriched.length;
  const hasMore = validatedOffset + validatedLimit < totalCount;
  const paged = enriched.slice(validatedOffset, validatedOffset + validatedLimit);

  return {
    count: paged.length,
    total_count: totalCount,
    offset: validatedOffset,
    has_more: hasMore,
    goal_history: paged,
  };
}
```

Add the `GoalHistory` type import if not already present:

```typescript
import type { GoalHistory } from '../models/goal-history.js';
```

- [ ] **Step 4: Add schema to `createToolSchemas()`**

```typescript
{
  name: 'get_goal_history',
  description:
    'Get monthly progress snapshots for financial goals. Returns current_amount, ' +
    'target_amount, daily data points, and contribution records per month. ' +
    'Filter by goal_id or month range (YYYY-MM).',
  inputSchema: {
    type: 'object',
    properties: {
      goal_id: {
        type: 'string',
        description: 'Filter by goal ID',
      },
      start_month: {
        type: 'string',
        description: 'Start month (YYYY-MM)',
      },
      end_month: {
        type: 'string',
        description: 'End month (YYYY-MM)',
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
  annotations: { readOnlyHint: true },
},
```

- [ ] **Step 5: Run tests, verify pass**

Run: `bun test tests/tools/tools.test.ts --filter "getGoalHistory"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/tools.ts tests/tools/tools.test.ts
git commit -m "feat: add get_goal_history tool"
```

---

### Task 9: Implement `update_recurring` write tool

**Files:**
- Modify: `src/tools/tools.ts` (new method + schema in `createWriteToolSchemas()`)
- Test: `tests/tools/tools.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('updateRecurring', () => {
  test('throws if recurring_id is missing', async () => {
    await expect(tools.updateRecurring({} as any)).rejects.toThrow();
  });

  test('throws if recurring not found', async () => {
    await expect(
      tools.updateRecurring({ recurring_id: 'nonexistent', name: 'Test' })
    ).rejects.toThrow('Recurring not found');
  });

  test('throws if no fields to update', async () => {
    await expect(
      tools.updateRecurring({ recurring_id: 'rec-1' })
    ).rejects.toThrow('No fields to update');
  });

  test('throws if name is empty', async () => {
    await expect(
      tools.updateRecurring({ recurring_id: 'rec-1', name: '  ' })
    ).rejects.toThrow('name must not be empty');
  });

  test('throws if amount <= 0', async () => {
    await expect(
      tools.updateRecurring({ recurring_id: 'rec-1', amount: -5 })
    ).rejects.toThrow('amount must be greater than 0');
  });

  test('throws if frequency is invalid', async () => {
    await expect(
      tools.updateRecurring({ recurring_id: 'rec-1', frequency: 'hourly' })
    ).rejects.toThrow('Invalid frequency');
  });

  test('throws if match_string is empty', async () => {
    await expect(
      tools.updateRecurring({ recurring_id: 'rec-1', match_string: '  ' })
    ).rejects.toThrow('match_string must not be empty');
  });

  test('updates name successfully', async () => {
    const result = await tools.updateRecurring({
      recurring_id: 'rec-1',
      name: 'Updated Name',
    });
    expect(result.success).toBe(true);
    expect(result.recurring_id).toBe('rec-1');
    expect(result.updated_fields).toContain('name');
  });

  test('updates multiple fields', async () => {
    const result = await tools.updateRecurring({
      recurring_id: 'rec-1',
      name: 'New Name',
      amount: 50,
      frequency: 'monthly',
    });
    expect(result.updated_fields).toEqual(expect.arrayContaining(['name', 'amount', 'frequency']));
  });

  test('updates match_string and transaction_ids', async () => {
    const result = await tools.updateRecurring({
      recurring_id: 'rec-1',
      match_string: 'NETFLIX',
      transaction_ids: ['tx-1', 'tx-2'],
    });
    expect(result.updated_fields).toContain('match_string');
    expect(result.updated_fields).toContain('transaction_ids');
  });
});
```

Ensure mock recurring data is set up in `beforeEach` (likely already exists, but verify it includes `recurring_id: 'rec-1'`). The write tool tests also need the mock Firestore client — follow the pattern used by `updateGoal` tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tools/tools.test.ts --filter "updateRecurring"`
Expected: FAIL

- [ ] **Step 3: Implement `updateRecurring()` method**

Add to `CopilotMoneyTools` class in `src/tools/tools.ts`:

```typescript
async updateRecurring(args: {
  recurring_id: string;
  name?: string;
  amount?: number;
  frequency?: string;
  category_id?: string;
  account_id?: string;
  merchant_name?: string;
  emoji?: string;
  match_string?: string;
  transaction_ids?: string[];
  excluded_transaction_ids?: string[];
  included_transaction_ids?: string[];
  days_filter?: number;
}): Promise<{
  success: boolean;
  recurring_id: string;
  name: string;
  updated_fields: string[];
}> {
  const client = this.getFirestoreClient();

  const {
    recurring_id,
    name,
    amount,
    frequency,
    category_id,
    account_id,
    merchant_name,
    emoji,
    match_string,
    transaction_ids,
    excluded_transaction_ids,
    included_transaction_ids,
    days_filter,
  } = args;

  // Validate recurring_id format
  validateDocId(recurring_id, 'recurring_id');

  // Verify recurring exists (include inactive)
  const allRecurring = await this.db.getRecurring(false);
  const recurring = allRecurring.find((r) => r.recurring_id === recurring_id);
  if (!recurring) {
    throw new Error(`Recurring not found: ${recurring_id}`);
  }

  // Build dynamic update fields
  const fieldsToUpdate: Record<string, unknown> = {};
  const updateMask: string[] = [];

  if (name !== undefined) {
    if (!name.trim()) {
      throw new Error('Recurring name must not be empty');
    }
    fieldsToUpdate.name = name.trim();
    updateMask.push('name');
  }
  if (amount !== undefined) {
    if (amount <= 0) {
      throw new Error('amount must be greater than 0');
    }
    fieldsToUpdate.amount = amount;
    updateMask.push('amount');
  }
  if (frequency !== undefined) {
    if (!(VALID_RECURRING_FREQUENCIES as readonly string[]).includes(frequency)) {
      throw new Error(
        `Invalid frequency: ${frequency}. Must be one of: ${VALID_RECURRING_FREQUENCIES.join(', ')}`
      );
    }
    fieldsToUpdate.frequency = frequency;
    updateMask.push('frequency');
  }
  if (category_id !== undefined) {
    validateDocId(category_id, 'category_id');
    fieldsToUpdate.category_id = category_id;
    updateMask.push('category_id');
  }
  if (account_id !== undefined) {
    validateDocId(account_id, 'account_id');
    fieldsToUpdate.account_id = account_id;
    updateMask.push('account_id');
  }
  if (merchant_name !== undefined) {
    fieldsToUpdate.merchant_name = merchant_name;
    updateMask.push('merchant_name');
  }
  if (emoji !== undefined) {
    fieldsToUpdate.emoji = emoji;
    updateMask.push('emoji');
  }
  if (match_string !== undefined) {
    if (!match_string.trim()) {
      throw new Error('match_string must not be empty');
    }
    fieldsToUpdate.match_string = match_string.trim();
    updateMask.push('match_string');
  }
  if (transaction_ids !== undefined) {
    fieldsToUpdate.transaction_ids = transaction_ids;
    updateMask.push('transaction_ids');
  }
  if (excluded_transaction_ids !== undefined) {
    fieldsToUpdate.excluded_transaction_ids = excluded_transaction_ids;
    updateMask.push('excluded_transaction_ids');
  }
  if (included_transaction_ids !== undefined) {
    fieldsToUpdate.included_transaction_ids = included_transaction_ids;
    updateMask.push('included_transaction_ids');
  }
  if (days_filter !== undefined) {
    fieldsToUpdate.days_filter = days_filter;
    updateMask.push('days_filter');
  }

  if (updateMask.length === 0) {
    throw new Error('No fields to update');
  }

  // Resolve user_id and write
  const userId = await client.requireUserId();
  const collectionPath = `users/${userId}/recurring`;
  const firestoreFields = toFirestoreFields(fieldsToUpdate);
  await client.updateDocument(collectionPath, recurring_id, firestoreFields, updateMask);

  // Clear cache
  this.db.clearCache();

  const displayName =
    name?.trim() ?? recurring.name ?? recurring.merchant_name ?? recurring_id;

  return {
    success: true,
    recurring_id,
    name: displayName,
    updated_fields: updateMask,
  };
}
```

- [ ] **Step 4: Add schema to `createWriteToolSchemas()`**

Add before the closing `];` of `createWriteToolSchemas()` (before line 4791):

```typescript
{
  name: 'update_recurring',
  description:
    'Update an existing recurring/subscription item. Can modify name, amount, frequency, ' +
    'category, account, match string, and transaction ID lists. ' +
    'Useful for fixing recurring detection — update match_string and transaction_ids ' +
    'to teach Copilot which transactions belong to this recurring charge. ' +
    'Writes directly to Copilot Money via Firestore.',
  inputSchema: {
    type: 'object',
    properties: {
      recurring_id: {
        type: 'string',
        description: 'ID of the recurring item to update (from get_recurring_transactions)',
      },
      name: {
        type: 'string',
        description: 'New display name for the recurring charge',
      },
      amount: {
        type: 'number',
        description: 'Expected recurring amount (must be > 0)',
      },
      frequency: {
        type: 'string',
        enum: ['weekly', 'biweekly', 'monthly', 'yearly'],
        description: 'How often this charge recurs',
      },
      category_id: {
        type: 'string',
        description: 'Category ID to assign (from get_categories)',
      },
      account_id: {
        type: 'string',
        description: 'Account ID this recurring charge is associated with',
      },
      merchant_name: {
        type: 'string',
        description: 'Merchant name for the recurring charge',
      },
      emoji: {
        type: 'string',
        description: 'Emoji icon for the recurring item',
      },
      match_string: {
        type: 'string',
        description:
          'Pattern used to auto-match incoming transactions to this recurring item ' +
          '(e.g., "NETFLIX" matches transactions with "NETFLIX" in the name)',
      },
      transaction_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Transaction IDs that belong to this recurring item',
      },
      excluded_transaction_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Transaction IDs explicitly excluded from this recurring item',
      },
      included_transaction_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Transaction IDs explicitly included in this recurring item',
      },
      days_filter: {
        type: 'number',
        description: 'Expected day-of-month for matching (e.g., 1 for charges on the 1st)',
      },
    },
    required: ['recurring_id'],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
},
```

- [ ] **Step 5: Run tests, verify pass**

Run: `bun test tests/tools/tools.test.ts --filter "updateRecurring"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/tools.ts tests/tools/tools.test.ts
git commit -m "feat: add update_recurring write tool"
```

---

### Task 10: Register all 6 tools in server.ts and manifest.json

**Files:**
- Modify: `src/server.ts:96-120` (WRITE_TOOLS set), `src/server.ts:353-357` (switch cases)
- Modify: `manifest.json:168-171` (tools array)
- Test: `tests/server/server.test.ts` (or existing handleCallTool tests)

- [ ] **Step 1: Add 5 read tool cases to server.ts switch statement**

Add before the `default:` case (before line 359):

```typescript
case 'get_balance_history':
  result = await this.tools.getBalanceHistory(
    typedArgs as Parameters<typeof this.tools.getBalanceHistory>[0]
  );
  break;

case 'get_investment_performance':
  result = await this.tools.getInvestmentPerformance(
    typedArgs as Parameters<typeof this.tools.getInvestmentPerformance>[0]
  );
  break;

case 'get_twr_returns':
  result = await this.tools.getTwrReturns(
    typedArgs as Parameters<typeof this.tools.getTwrReturns>[0]
  );
  break;

case 'get_securities':
  result = await this.tools.getSecurities(
    typedArgs as Parameters<typeof this.tools.getSecurities>[0]
  );
  break;

case 'get_goal_history':
  result = await this.tools.getGoalHistory(
    typedArgs as Parameters<typeof this.tools.getGoalHistory>[0]
  );
  break;
```

- [ ] **Step 2: Add `update_recurring` to WRITE_TOOLS set and switch**

Add `'update_recurring'` to the WRITE_TOOLS set (after `'create_goal'` on line 119):

```typescript
'update_recurring',
```

Add the switch case:

```typescript
case 'update_recurring':
  result = await this.tools.updateRecurring(
    typedArgs as Parameters<typeof this.tools.updateRecurring>[0]
  );
  break;
```

- [ ] **Step 3: Add all 6 tools to manifest.json**

Add before the closing `]` of the tools array (before line 171):

```json
{
  "name": "get_balance_history",
  "description": "Get daily balance snapshots for accounts over time with configurable granularity (daily, weekly, monthly)."
},
{
  "name": "get_investment_performance",
  "description": "Get per-security investment performance data, enriched with ticker symbols."
},
{
  "name": "get_twr_returns",
  "description": "Get time-weighted return (TWR) monthly data for investment holdings."
},
{
  "name": "get_securities",
  "description": "Get security master data — ticker, name, type, price, and identifiers."
},
{
  "name": "get_goal_history",
  "description": "Get monthly progress snapshots for financial goals with daily data and contributions."
},
{
  "name": "update_recurring",
  "description": "Update a recurring/subscription item — name, amount, frequency, match string, and transaction IDs."
}
```

- [ ] **Step 4: Run `bun run sync-manifest` to verify manifest matches code**

Run: `bun run sync-manifest`
Expected: No mismatches

- [ ] **Step 5: Run full test suite**

Run: `bun run check`
Expected: All typecheck + lint + format + tests pass

- [ ] **Step 6: Commit**

```bash
git add src/server.ts manifest.json
git commit -m "feat: register 6 new tools in server handler and manifest"
```

---

### Task 11: Final verification and cleanup

**Files:**
- All modified files from Tasks 1-10

- [ ] **Step 1: Run full check suite**

Run: `bun run check`
Expected: All typecheck, lint, format, and tests pass

- [ ] **Step 2: Verify tool count**

Run: `bun -e "import { createToolSchemas } from './src/tools/tools.ts'; import { createWriteToolSchemas } from './src/tools/tools.ts'; console.log('Read:', createToolSchemas().length, 'Write:', createWriteToolSchemas().length, 'Total:', createToolSchemas().length + createWriteToolSchemas().length)"`
Expected: Read: 17, Write: 24, Total: 41

- [ ] **Step 3: Verify manifest sync**

Run: `bun run sync-manifest`
Expected: No mismatches between code and manifest

- [ ] **Step 4: Commit any remaining fixes**

If any fixes were needed, commit them:

```bash
git add -A
git commit -m "chore: final cleanup for missing tools audit"
```
