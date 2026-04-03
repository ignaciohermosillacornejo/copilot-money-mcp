# Full Decode Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode 100% of LevelDB documents (55.3% → 100%) across 11 PRs.

**Architecture:** For each collection: add Zod schema model, add process function to decoder.ts, wire into decodeAllCollections if/else chain and AllCollectionsResult, add schema tests, update coverage script. Each PR is committed, pushed, and a GitHub PR is created.

**Tech Stack:** TypeScript, Zod, Bun test runner, classic-level

---

### Task 1: Decode investment_performance (3 patterns, ~9,235 docs)

**Files:**
- Create: `src/models/investment-performance.ts`
- Modify: `src/core/decoder.ts` — add AllCollectionsResult fields, process functions, routing
- Modify: `src/models/index.ts` — re-export
- Create: `tests/models/investment-performance.test.ts`
- Modify: `scripts/decode-coverage.ts` — update isDecoded()

**Context:** Three related patterns:
- `investment_performance` (10 docs) — metadata: securityId, type, userId, access, position, last_update
- `investment_performance/{hash}` (8,323 docs) — same as above but per-security
- `investment_performance/{hash}/twr_holding` (902 docs) — monthly TWR data with epoch-ms keyed history objects

- [ ] **Step 1: Create model file `src/models/investment-performance.ts`**

```typescript
import { z } from 'zod';

export const InvestmentPerformanceSchema = z
  .object({
    performance_id: z.string(),
    security_id: z.string().optional(),
    type: z.string().optional(),
    user_id: z.string().optional(),
    access: z.array(z.string()).optional(),
    position: z.number().optional(),
    last_update: z.string().optional(),
  })
  .passthrough();

export type InvestmentPerformance = z.infer<typeof InvestmentPerformanceSchema>;

export const TwrHoldingSchema = z
  .object({
    twr_id: z.string(), // constructed from path: {security_hash}:{month}
    security_id: z.string().optional(),
    month: z.string().optional(),
    history: z.record(z.string(), z.object({ value: z.number() }).passthrough()).optional(),
  })
  .passthrough();

export type TwrHolding = z.infer<typeof TwrHoldingSchema>;
```

- [ ] **Step 2: Create test file `tests/models/investment-performance.test.ts`**

```typescript
import { describe, expect, test } from 'bun:test';
import {
  InvestmentPerformanceSchema,
  TwrHoldingSchema,
} from '../../src/models/investment-performance';

describe('InvestmentPerformanceSchema', () => {
  test('validates minimal object', () => {
    const result = InvestmentPerformanceSchema.safeParse({ performance_id: 'perf-1' });
    expect(result.success).toBe(true);
  });

  test('validates full object', () => {
    const result = InvestmentPerformanceSchema.safeParse({
      performance_id: 'abc123hash',
      security_id: 'abc123hash',
      type: 'overall-security',
      user_id: 'all',
      access: ['all'],
      position: 1,
      last_update: '2026-01-01T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  test('passes through unknown fields', () => {
    const result = InvestmentPerformanceSchema.safeParse({
      performance_id: 'perf-1',
      unknown_field: 'value',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.unknown_field).toBe('value');
  });
});

describe('TwrHoldingSchema', () => {
  test('validates minimal object', () => {
    const result = TwrHoldingSchema.safeParse({ twr_id: 'hash:2026-01' });
    expect(result.success).toBe(true);
  });

  test('validates with history data', () => {
    const result = TwrHoldingSchema.safeParse({
      twr_id: 'hash:2026-01',
      security_id: 'abc123hash',
      month: '2026-01',
      history: {
        '1609822800000': { value: -0.001024 },
        '1609909200000': { value: -0.002390 },
      },
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `bun test tests/models/investment-performance.test.ts`

- [ ] **Step 4: Add process functions to `src/core/decoder.ts`**

Add imports at top of decoder.ts:
```typescript
import { InvestmentPerformance, InvestmentPerformanceSchema, TwrHolding, TwrHoldingSchema } from '../models/investment-performance.js';
```

Add process functions (after existing process functions, before `decodeAllCollections`):
```typescript
function processInvestmentPerformance(
  fields: Map<string, FirestoreValue>,
  docId: string
): InvestmentPerformance | null {
  const data: Record<string, unknown> = {
    performance_id: docId,
  };

  const stringFields = ['security_id', 'type', 'user_id', 'last_update'];
  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value) data[field] = value;
  }

  // Also check securityId (camelCase variant used in Firestore)
  const securityId = getString(fields, 'securityId');
  if (securityId && !data.security_id) data.security_id = securityId;

  const userId = getString(fields, 'userId');
  if (userId && !data.user_id) data.user_id = userId;

  const position = getNumber(fields, 'position');
  if (position !== undefined) data.position = position;

  const access = getStringArray(fields, 'access');
  if (access) data.access = access;

  const validated = InvestmentPerformanceSchema.safeParse(data);
  return validated.success ? validated.data : null;
}

function processTwrHolding(
  fields: Map<string, FirestoreValue>,
  docId: string,
  key: string
): TwrHolding | null {
  // Extract security hash from the key path
  // Path: investment_performance/{hash}/twr_holding/{month}
  const parts = key.split('/');
  let securityId: string | undefined;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === 'investment_performance' && i + 1 < parts.length) {
      securityId = parts[i + 1];
      break;
    }
  }

  const data: Record<string, unknown> = {
    twr_id: securityId ? `${securityId}:${docId}` : docId,
    security_id: securityId,
    month: docId,
  };

  // Extract history map (epoch_ms -> { value })
  const historyMap = getMap(fields, 'history');
  if (historyMap) {
    const history: Record<string, { value: number }> = {};
    for (const [epochKey, val] of historyMap) {
      if (val.type === 'map') {
        const valueField = val.value.get('value');
        if (valueField && (valueField.type === 'double' || valueField.type === 'integer')) {
          history[epochKey] = { value: valueField.value };
        }
      }
    }
    if (Object.keys(history).length > 0) data.history = history;
  }

  const validated = TwrHoldingSchema.safeParse(data);
  return validated.success ? validated.data : null;
}
```

- [ ] **Step 5: Add to AllCollectionsResult and wire into decodeAllCollections**

Add to `AllCollectionsResult` interface:
```typescript
investmentPerformance: InvestmentPerformance[];
twrHoldings: TwrHolding[];
```

Add arrays in `decodeAllCollections`:
```typescript
const rawInvestmentPerformance: InvestmentPerformance[] = [];
const rawTwrHoldings: TwrHolding[] = [];
```

Add routing in the if/else chain (AFTER the investment_prices block, BEFORE the investment_splits block):
```typescript
} else if (collection.endsWith('/twr_holding')) {
  const twr = processTwrHolding(fields, documentId, key);
  if (twr) rawTwrHoldings.push(twr);
} else if (collectionMatches(collection, 'investment_performance') || collection.includes('investment_performance/')) {
  const perf = processInvestmentPerformance(fields, documentId);
  if (perf) rawInvestmentPerformance.push(perf);
}
```

Add dedup and return (after existing dedup blocks):
```typescript
// Investment performance: dedupe by performance_id
const perfSeen = new Set<string>();
const investmentPerformance: InvestmentPerformance[] = [];
for (const perf of rawInvestmentPerformance) {
  if (!perfSeen.has(perf.performance_id)) {
    perfSeen.add(perf.performance_id);
    investmentPerformance.push(perf);
  }
}

// TWR holdings: dedupe by twr_id
const twrSeen = new Set<string>();
const twrHoldings: TwrHolding[] = [];
for (const twr of rawTwrHoldings) {
  if (!twrSeen.has(twr.twr_id)) {
    twrSeen.add(twr.twr_id);
    twrHoldings.push(twr);
  }
}
```

Add to return object:
```typescript
investmentPerformance,
twrHoldings,
```

- [ ] **Step 6: Re-export from `src/models/index.ts`**

```typescript
export {
  InvestmentPerformanceSchema,
  type InvestmentPerformance,
  TwrHoldingSchema,
  type TwrHolding,
} from './investment-performance.js';
```

- [ ] **Step 7: Update coverage script `scripts/decode-coverage.ts`**

Add to `isDecoded()`:
```typescript
if (matches('twr_holding')) return true;
if (matches('investment_performance') || rawCollection.includes('investment_performance/')) return true;
```

- [ ] **Step 8: Run all tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 9: Commit, push, create PR**

```bash
git add src/models/investment-performance.ts src/models/index.ts src/core/decoder.ts tests/models/investment-performance.test.ts scripts/decode-coverage.ts
git commit -m "feat: decode investment_performance collections (~9,235 docs)"
git push
gh pr create --title "feat: decode investment_performance (55→72%)" --body "..."
```

---

### Task 2: Decode plaid account documents (items/*/accounts/*, ~6,962 docs)

**Files:**
- Create: `src/models/plaid-account.ts`
- Modify: `src/core/decoder.ts`
- Modify: `src/models/index.ts`
- Create: `tests/models/plaid-account.test.ts`
- Modify: `scripts/decode-coverage.ts`

**Context:** These are `items/{item_id}/accounts/{account_id}` documents — Plaid's raw account data with holdings arrays containing cost basis. The collection path has 4 segments; the last segment is an account ID (not "accounts"). In the decoder's if/else chain, these fall through because `collectionMatches(collection, 'accounts')` matches `items/{id}/accounts` (3 segments ending in "accounts") but NOT `items/{id}/accounts/{account_id}` (4 segments ending in an account ID).

The key routing check: the raw collection path looks like `items/{id}/accounts/{id}` where the last segment is an account doc ID. We need to match paths that contain `items/` and have `/accounts/` followed by another segment (the account doc ID).

- [ ] **Step 1: Create model file `src/models/plaid-account.ts`**

```typescript
import { z } from 'zod';

const HoldingSchema = z
  .object({
    security_id: z.string().optional(),
    account_id: z.string().optional(),
    cost_basis: z.number().nullable().optional(),
    institution_price: z.number().optional(),
    institution_value: z.number().optional(),
    quantity: z.number().optional(),
    iso_currency_code: z.string().optional(),
    vested_quantity: z.number().optional(),
    vested_value: z.number().optional(),
  })
  .passthrough();

export type Holding = z.infer<typeof HoldingSchema>;

export const PlaidAccountSchema = z
  .object({
    plaid_account_id: z.string(),
    account_id: z.string().optional(),
    item_id: z.string().optional(),
    name: z.string().optional(),
    official_name: z.string().optional(),
    mask: z.string().optional(),
    account_type: z.string().optional(),
    subtype: z.string().optional(),
    current_balance: z.number().optional(),
    available_balance: z.number().optional(),
    limit: z.number().nullable().optional(),
    iso_currency_code: z.string().optional(),
    holdings: z.array(HoldingSchema).optional(),
  })
  .passthrough();

export type PlaidAccount = z.infer<typeof PlaidAccountSchema>;
```

- [ ] **Step 2: Create test file `tests/models/plaid-account.test.ts`**

Test schema validation: minimal, full with holdings, passthrough unknown fields.

- [ ] **Step 3: Add process function to decoder.ts**

```typescript
function processPlaidAccount(
  fields: Map<string, FirestoreValue>,
  docId: string,
  collection: string
): PlaidAccount | null {
  const data: Record<string, unknown> = {
    plaid_account_id: docId,
  };

  // Extract item_id from collection path: items/{item_id}/accounts/{account_id}
  const pathParts = collection.split('/');
  const itemsIdx = pathParts.indexOf('items');
  if (itemsIdx >= 0 && itemsIdx + 1 < pathParts.length) {
    data.item_id = pathParts[itemsIdx + 1];
  }

  const stringFields = ['account_id', 'name', 'official_name', 'mask', 'account_type', 'subtype', 'iso_currency_code'];
  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value) data[field] = value;
  }

  const numericFields = ['current_balance', 'available_balance', 'limit'];
  for (const field of numericFields) {
    const value = getNumber(fields, field);
    if (value !== undefined) data[field] = value;
  }

  // Extract holdings array
  const holdingsValue = fields.get('holdings');
  if (holdingsValue?.type === 'array') {
    const holdings: Record<string, unknown>[] = [];
    for (const item of holdingsValue.value) {
      if (item.type === 'map') {
        const holding = toPlainObject(item.value);
        holdings.push(holding);
      }
    }
    if (holdings.length > 0) data.holdings = holdings;
  }

  const validated = PlaidAccountSchema.safeParse(data);
  return validated.success ? validated.data : null;
}
```

- [ ] **Step 4: Wire into decodeAllCollections**

Routing — add BEFORE the existing `collectionMatches(collection, 'accounts')` check. The key insight: these are 4+ segment paths like `items/{id}/accounts/{id}` where the collection includes `items/` and contains `/accounts/` but doesn't END with `/accounts`:
```typescript
} else if (
  collection.includes('items/') &&
  collection.includes('/accounts/') &&
  !collection.endsWith('/accounts') &&
  !collection.endsWith('/balance_history') &&
  !collection.endsWith('/transactions') &&
  !collection.includes('/holdings_history')
) {
  const plaidAccount = processPlaidAccount(fields, documentId, collection);
  if (plaidAccount) rawPlaidAccounts.push(plaidAccount);
}
```

Add to AllCollectionsResult, arrays, dedup, return.

- [ ] **Step 5: Re-export, update coverage script, run tests, commit, push, create PR**

---

### Task 3: Decode balance_history (~4,968 docs)

**Files:**
- Create: `src/models/balance-history.ts`
- Modify: `src/core/decoder.ts`
- Modify: `src/models/index.ts`
- Create: `tests/models/balance-history.test.ts`
- Modify: `scripts/decode-coverage.ts`

**Context:** Path: `items/{item_id}/accounts/{account_id}/balance_history/{date}`. Doc ID is the date (YYYY-MM-DD). Fields: current_balance, available_balance, limit, _origin.

- [ ] **Step 1: Create model**

```typescript
export const BalanceHistorySchema = z
  .object({
    balance_id: z.string(), // constructed: {account_path}:{date}
    date: z.string().optional(),
    account_id: z.string().optional(),
    item_id: z.string().optional(),
    current_balance: z.number().optional(),
    available_balance: z.number().optional(),
    limit: z.number().nullable().optional(),
  })
  .passthrough();
```

- [ ] **Steps 2-5:** Same pattern — test, process function, routing (`collection.endsWith('/balance_history')`), wire up, PR.

---

### Task 4: Fix items/* routing (~701 docs)

**Context:** The 701 `items/*` docs have raw collection paths like `items/{item_id}` — these are the same `items` collection but parsed with a longer binary key path. The existing `collectionMatches(collection, 'items')` check should already match these since they end with `items/{id}` — wait, no. `collectionMatches` checks `collection === 'items' || collection.endsWith('/items')`. The raw path `items/{item_id}` does NOT match either condition.

Actually, looking again: the collection from the key parser is `items` and the documentId is `{item_id}`. So `collectionMatches(collection, 'items')` should match. The 701 docs showing as `items/*` in the coverage script is a normalization artifact — the raw path IS `items/{item_id}` which normalizes to `items/*`, but this is actually `collection=items, docId={item_id}` in the key parser.

This needs investigation — may just be a coverage script fix, not a decoder change. The subagent should check by adding debug logging.

- [ ] **Step 1:** Investigate whether these docs are already decoded by the existing items processor
- [ ] **Step 2:** Fix coverage script or decoder routing as needed
- [ ] **Step 3:** Commit, push, PR

---

### Task 5: Decode changes (3 patterns, ~1,987 docs)

**Files:**
- Create: `src/models/change.ts`
- Modify: `src/core/decoder.ts`, `src/models/index.ts`
- Create: `tests/models/change.test.ts`
- Modify: `scripts/decode-coverage.ts`

**Context:** `changes/{id}` (1,033 docs) — mostly empty sync tracking containers. `changes/{id}/t` (559 docs) — transaction change records. `changes/{id}/a` (395 docs) — account change records. These are internal sync data; schemas will be minimal with passthrough.

- [ ] **Steps:** Create model with 3 schemas (Change, TransactionChange, AccountChange), add process functions, route: `changes/*/t` and `changes/*/a` before `changes/*`. Test, commit, PR.

---

### Task 6: Decode holdings_history (2 patterns, ~753 docs)

**Files:**
- Create: `src/models/holdings-history.ts`
- Modify: `src/core/decoder.ts`, `src/models/index.ts`
- Create: `tests/models/holdings-history.test.ts`
- Modify: `scripts/decode-coverage.ts`

**Context:**
- `items/*/accounts/*/holdings_history/{hash}` (662 docs) — metadata for a holding snapshot series
- `items/*/accounts/*/holdings_history/{hash}/history/{month}` (91 docs) — epoch-ms keyed `{ price, quantity }` entries

- [ ] **Steps:** Create model with HoldingsHistoryMeta and HoldingsHistory schemas. Route: check for `/history` ending under `holdings_history` first, then `holdings_history/*`. Test, commit, PR.

---

### Task 7: Decode securities (17 docs)

**Files:**
- Create: `src/models/security.ts`
- Modify: `src/core/decoder.ts`, `src/models/index.ts`
- Create: `tests/models/security.test.ts`
- Modify: `scripts/decode-coverage.ts`

**Context:** Security master data. Fields documented in firestore-collections.md: security_id, ticker_symbol, name, type, provider_type, close_price, current_price, is_cash_equivalent, iso_currency_code, isin, cusip, sedol, source, comparison, etc.

- [ ] **Steps:** Create model, process function with string/number/boolean field extraction, route with `collectionMatches(collection, 'securities')`. Test, commit, PR.

---

### Task 8: Decode user profile (users, users/*, ~229 docs)

**Files:**
- Create: `src/models/user-profile.ts`
- Modify: `src/core/decoder.ts`, `src/models/index.ts`
- Create: `tests/models/user-profile.test.ts`
- Modify: `scripts/decode-coverage.ts`

**Context:** `users` (1 doc) — user settings. `users/*` (228 docs) — these need investigation. Raw path is `users/ptBpjeKOzmZbHeqic6nPYBn9iM82` which in the key parser means collection=`users` and docId=`{user_id}`. So these should be 228 different documents in the `users` collection, but we documented only 1 user doc. The 228 might be subcollection parent documents or duplicates from different LevelDB entries.

- [ ] **Steps:** Create minimal UserProfile model with the documented fields. Route: after all `users/*/xxx` subcollection checks, add `collectionMatches(collection, 'users')` as a catch-all for user docs. The `users/*` pattern should be decoded by this since they have collection=`users`. Test, commit, PR.

---

### Task 9: Decode tags (8 docs)

**Files:**
- Create: `src/models/tag.ts`
- Modify: `src/core/decoder.ts`, `src/models/index.ts`
- Create: `tests/models/tag.test.ts`
- Modify: `scripts/decode-coverage.ts`

**Context:** `users/{user_id}/tags/{tag_id}`. Fields: name, color_name, hex_color.

- [ ] **Steps:** Create Tag model, process function, route with `collectionMatches(collection, 'tags')` (must come before the general `users` catch-all). Test, commit, PR.

---

### Task 10: Decode amazon (2 patterns, ~144 docs)

**Files:**
- Create: `src/models/amazon.ts`
- Modify: `src/core/decoder.ts`, `src/models/index.ts`
- Create: `tests/models/amazon.test.ts`
- Modify: `scripts/decode-coverage.ts`

**Context:**
- `amazon/{id}` (72 docs) — Amazon integration metadata
- `amazon/{id}/orders` (72 docs) — order details with items array, payment, details

- [ ] **Steps:** Create AmazonIntegration and AmazonOrder schemas. Route: `orders` before `amazon`. Test, commit, PR.

---

### Task 11: Decode app metadata (6 tiny collections, ~8 docs)

**Files:**
- Create: `src/models/app-metadata.ts`
- Modify: `src/core/decoder.ts`, `src/models/index.ts`
- Create: `tests/models/app-metadata.test.ts`
- Modify: `scripts/decode-coverage.ts`

**Context:** All tiny (1-2 doc) collections:
- `subscriptions` (1) — App Store subscription
- `invites` (2) — referral codes
- `user_items` (1) — user-to-item mapping
- `feature_tracking` (1) — feature onboarding steps
- `support` (1) — feature flags
- `users/*/financial_goals/*` (2) — goal subcollection parent docs

- [ ] **Steps:** Create schemas for each (all minimal with passthrough), bundle process functions, route each with `collectionMatches`. Handle `financial_goals/*` as a routing fix for the goal parent path. Test, commit, PR.

---

### Task 12: Final verification

- [ ] **Step 1:** Run `bun run scripts/decode-coverage.ts` and verify 100%
- [ ] **Step 2:** Run `bun test` and verify all tests pass
- [ ] **Step 3:** Update `docs/firestore-collections.md` — mark all collections as "Yes" in Decoded column, update coverage line to 100%
- [ ] **Step 4:** Commit and create final PR
