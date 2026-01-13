# Copilot Money MCP - Complete Implementation Plan

**Status**: Active Development
**Created**: 2026-01-13
**Current Phase**: 6/10 Complete

---

## 📊 Completed Collections

- ✅ **Phase 1**: Transactions (30+ fields, 5,500+ records)
- ✅ **Phase 2**: Accounts (all types, ~20 records)
- ✅ **Phase 3**: Recurring Transactions (~50 subscriptions)
- ✅ **Phase 4**: Balance History (1,000+ snapshots)
- ✅ **Phase 5**: Budgets (~10 budget rules)
- ✅ **Phase 6**: Financial Goals (savings goals) - **JUST COMPLETED**

**Total MCP Tools**: 25
**Test Coverage**: 417 tests passing

---

## 🎯 Remaining Implementation Plan

### **Option 1: Investment Price Data** (Phase 7)
**Priority**: HIGH (for investment tracking)
**Estimated Complexity**: MEDIUM
**Expected Records**: ~10,000 price records

#### Implementation Details

**Collection**: `/investment_prices/{ticker}/{date}`

**Data Structure**:
```typescript
interface InvestmentPrice {
  ticker: string;           // e.g., "AAPL", "BTC"
  date: string;             // YYYY-MM-DD
  price: number;            // Price value
  currency: string;         // ISO currency code (USD, etc.)
  source?: string;          // "Yahoo Finance", "CoinGecko", etc.
  high?: number;            // Daily high
  low?: number;             // Daily low
  volume?: number;          // Trading volume
}
```

**Files to Create/Modify**:
1. `src/models/investment-price.ts` - Schema and types
2. `src/core/decoder.ts` - Add `decodeInvestmentPrices()` function
3. `src/core/database.ts` - Add `getInvestmentPrices()` method
4. `src/tools/tools.ts` - Add `getInvestmentPrices()` tool method
5. `src/server.ts` - Register `get_investment_prices` handler
6. `tests/` - Add test coverage

**MCP Tools to Add**:
- `get_investment_prices` - Query prices by ticker/date range
- `get_investment_price_latest` - Get most recent price for ticker
- `get_portfolio_valuation` - Calculate current portfolio value

**Database Search Pattern**:
- Path marker: `investment_prices/` or `/investment_prices/`
- Extract ticker from path
- Extract date from path or document
- Parse price data (likely stored as double)

**Acceptance Criteria**:
- [ ] Decoder extracts prices for all tickers
- [ ] Can query by ticker symbol
- [ ] Can query by date range
- [ ] Price values accurate to 2 decimal places
- [ ] All tests passing
- [ ] Documentation updated

---

### **Option 2: Investment Splits** (Phase 8)
**Priority**: HIGH (for investment tracking)
**Estimated Complexity**: LOW
**Expected Records**: ~300 splits

#### Implementation Details

**Collection**: `/investment_splits/{ticker}`

**Data Structure**:
```typescript
interface InvestmentSplit {
  ticker: string;           // e.g., "AAPL", "TSLA"
  date: string;             // Split date YYYY-MM-DD
  split_ratio: string;      // e.g., "2:1", "3:1", "1:2"
  ratio_multiplier: number; // Calculated: 2.0, 3.0, 0.5
  description?: string;     // Human description
}
```

**Files to Create/Modify**:
1. `src/models/investment-split.ts` - Schema and types
2. `src/core/decoder.ts` - Add `decodeInvestmentSplits()` function
3. `src/core/database.ts` - Add `getInvestmentSplits()` method
4. `src/tools/tools.ts` - Add `getInvestmentSplits()` tool method
5. `src/server.ts` - Register `get_investment_splits` handler
6. `tests/` - Add test coverage

**MCP Tools to Add**:
- `get_investment_splits` - Query splits by ticker
- `calculate_adjusted_shares` - Calculate share count after splits

**Database Search Pattern**:
- Path marker: `investment_splits/` or `/investment_splits/`
- Extract ticker from path
- Parse split ratio and date

**Acceptance Criteria**:
- [ ] Decoder extracts all splits
- [ ] Split ratios parsed correctly
- [ ] Can query by ticker
- [ ] Helper to calculate adjusted shares
- [ ] All tests passing
- [ ] Documentation updated

---

### **Option 3: Items Collection** (Phase 9)
**Priority**: MEDIUM
**Estimated Complexity**: LOW
**Expected Records**: ~10 items

#### Implementation Details

**Collection**: `/items/{item_id}`

**Data Structure**:
```typescript
interface Item {
  item_id: string;              // Plaid item identifier
  institution_id: string;       // Bank/brokerage institution ID
  institution_name: string;     // Display name
  status: string;               // "good", "requires_update", etc.
  last_successful_update?: string;  // ISO timestamp
  last_failed_update?: string;      // ISO timestamp
  error?: {
    error_type?: string;
    error_code?: string;
    error_message?: string;
  };
  available_products?: string[];    // ["transactions", "investments"]
  billed_products?: string[];       // Products being charged
  consent_expiration_time?: string; // When consent expires
  update_type?: string;             // "background", "user_present_required"
  account_count?: number;           // Number of accounts in this item
}
```

**Files to Create/Modify**:
1. `src/models/item.ts` - Schema and types
2. `src/core/decoder.ts` - Add `decodeItems()` function
3. `src/core/database.ts` - Add `getItems()` method
4. `src/tools/tools.ts` - Add `getItems()` tool method
5. `src/server.ts` - Register `get_items` handler
6. `tests/` - Add test coverage

**MCP Tools to Add**:
- `get_items` - List all Plaid connections
- `get_item_status` - Check connection health

**Database Search Pattern**:
- Path marker: `items/` or `/items/`
- Extract item_id from path
- Parse status and metadata

**Acceptance Criteria**:
- [ ] Decoder extracts all items
- [ ] Status accurately reflects connection health
- [ ] Can see which banks are connected
- [ ] Error messages decoded when present
- [ ] All tests passing
- [ ] Documentation updated

---

### **Option 4: Categories Collection** (Phase 10)
**Priority**: MEDIUM
**Estimated Complexity**: LOW
**Expected Records**: ~100 categories

#### Implementation Details

**Collection**: `/categories/{category_id}`

**Data Structure**:
```typescript
interface CategoryFull {
  category_id: string;          // Unique ID
  name: string;                 // Display name
  parent_category_id?: string;  // Parent for hierarchy
  icon?: string;                // Icon identifier
  color?: string;               // Hex color code
  order?: number;               // Display order
  is_hidden?: boolean;          // Hide in UI
  is_other?: boolean;           // "Other" category flag
  plaid_category_ids?: string[]; // Associated Plaid categories
  user_created?: boolean;       // Custom vs built-in
}
```

**Files to Create/Modify**:
1. `src/models/category.ts` - Enhance existing minimal schema
2. `src/core/decoder.ts` - Add `decodeCategoriesFull()` function
3. `src/core/database.ts` - Add `getCategoriesFull()` method
4. `src/tools/tools.ts` - Enhance category tools
5. `src/server.ts` - Update category handlers
6. `tests/` - Add test coverage

**MCP Tools to Add/Enhance**:
- `get_categories` - Enhanced with full category tree
- `get_category_hierarchy` - Show parent-child relationships
- `get_subcategories` - Get children of a category

**Database Search Pattern**:
- Path marker: `categories/` or `/categories/`
- Extract category_id from path
- Parse hierarchy relationships

**Acceptance Criteria**:
- [ ] Decoder extracts all category fields
- [ ] Parent-child relationships preserved
- [ ] Icons and colors extracted
- [ ] Can build full category tree
- [ ] All tests passing
- [ ] Documentation updated

---

### **Option 5: Goal History Subcollection** (Phase 11)
**Priority**: HIGH (complements just-completed goals)
**Estimated Complexity**: MEDIUM
**Expected Records**: Hundreds (monthly snapshots per goal)

#### Implementation Details

**Collection**: `/users/{user_id}/financial_goals/{goal_id}/financial_goal_history/{month}`

**Data Structure**:
```typescript
interface GoalHistoryMonth {
  goal_id: string;          // Parent goal
  month: string;            // YYYY-MM format
  daily_data?: {
    [date: string]: {       // "2026-01-13"
      balance?: number;     // Goal balance on this day
      contribution?: number; // Contribution made
    };
  };
  monthly_summary?: {
    opening_balance: number;
    closing_balance: number;
    total_contributions: number;
    total_withdrawals: number;
  };
}

interface GoalProgress {
  goal_id: string;
  goal_name: string;
  target_amount: number;
  current_balance: number;
  progress_percentage: number;
  monthly_contribution: number;
  estimated_completion_date?: string;
  days_to_completion?: number;
  on_track: boolean;
}
```

**Files to Create/Modify**:
1. `src/models/goal-history.ts` - New schema for history
2. `src/models/goal.ts` - Add progress calculation helpers
3. `src/core/decoder.ts` - Add `decodeGoalHistory()` function
4. `src/core/database.ts` - Add `getGoalHistory()` method
5. `src/tools/tools.ts` - Add goal progress tools
6. `src/server.ts` - Register goal history handlers
7. `tests/` - Add test coverage

**MCP Tools to Add**:
- `get_goal_progress` - Current progress toward goals
- `get_goal_history` - Historical balance data
- `estimate_goal_completion` - Predict when goal will be met
- `get_goal_contributions` - Track contribution history

**Database Search Pattern**:
- Path marker: `financial_goal_history/` or `/financial_goals/{id}/financial_goal_history/`
- Extract goal_id from parent path
- Extract month from path (YYYY-MM)
- Parse daily_data nested object

**Acceptance Criteria**:
- [ ] Decoder extracts monthly snapshots
- [ ] Daily balance data parsed correctly
- [ ] Can calculate current progress
- [ ] Can estimate completion dates
- [ ] All tests passing
- [ ] Documentation updated

---

### **Option 6: Advanced Analytics Tools** (Phase 12)
**Priority**: MEDIUM
**Estimated Complexity**: HIGH
**Expected Impact**: HIGH (new insights from existing data)

#### Implementation Details

**No new collections** - builds on existing data

**New MCP Tools to Create**:

1. **Net Worth Tracking**
   - `get_net_worth_history` - Net worth over time from balance_history
   - `get_net_worth_change` - Compare periods
   - `get_net_worth_breakdown` - By account type

2. **Spending Analytics**
   - `get_spending_trends` - Month-over-month trends
   - `predict_spending` - ML-based spending predictions
   - `get_spending_anomalies` - Unusual spending detection (enhanced)
   - `get_spending_velocity` - Rate of spending changes

3. **Budget Analytics**
   - `get_budget_vs_actual` - Compare budget to actual spending
   - `get_budget_adherence_score` - Overall budget performance
   - `get_over_budget_categories` - Categories exceeding limits

4. **Investment Analytics**
   - `get_portfolio_performance` - ROI, gains/losses
   - `get_portfolio_allocation` - Asset distribution
   - `get_portfolio_diversity_score` - Diversification metric
   - `get_investment_returns` - Calculate actual returns

5. **Goal Analytics**
   - `get_goal_velocity` - Rate of progress
   - `get_goal_health_score` - On-track vs behind
   - `project_goal_outcomes` - Forecast completion

6. **Cash Flow**
   - `get_cash_flow_summary` - Income vs expenses
   - `get_cash_flow_forecast` - Predict future cash flow
   - `get_burn_rate` - Rate of spending savings

**Files to Create/Modify**:
1. `src/tools/analytics.ts` - New analytics tool suite
2. `src/tools/tools.ts` - Import and register analytics
3. `src/utils/calculations.ts` - Shared calculation helpers
4. `src/utils/ml-predictions.ts` - Simple ML for predictions
5. `src/server.ts` - Register all analytics tools
6. `tests/tools/analytics.test.ts` - Comprehensive tests

**Implementation Strategy**:
- Build on existing decoded data
- Use statistical calculations (moving averages, trends)
- Simple ML (linear regression for predictions)
- Time series analysis for trends
- Comparative analysis (period over period)

**Acceptance Criteria**:
- [ ] All 20+ analytics tools implemented
- [ ] Calculations accurate and tested
- [ ] Predictions reasonably accurate
- [ ] Performance acceptable for large datasets
- [ ] All tests passing
- [ ] Documentation with examples

---

## 🚀 Execution Strategy

### Parallel Development Approach

**High Priority Tracks** (can run in parallel):
1. **Track 1**: Investment Data (Phases 7-8) - Prices + Splits
2. **Track 2**: Goal Progress (Phase 11) - History tracking
3. **Track 3**: Core Collections (Phases 9-10) - Items + Categories

**Final Track**:
4. **Track 4**: Analytics (Phase 12) - After data collections complete

### Recommended Order for Sequential Execution

If running sequentially, follow this order:
1. ✅ Phase 7: Investment Prices (foundational for portfolios)
2. ✅ Phase 8: Investment Splits (complements prices)
3. ✅ Phase 11: Goal History (high user value, complements goals)
4. ✅ Phase 9: Items (quick win, useful metadata)
5. ✅ Phase 10: Categories (quick win, enhances existing tools)
6. ✅ Phase 12: Analytics (grand finale using all data)

---

## 📋 Checklist Template for Each Phase

```markdown
### Phase X: [Collection Name]

**Pre-Implementation**:
- [ ] Review database structure in REVERSE_ENGINEERING_FINDING.md
- [ ] Identify path markers and field patterns
- [ ] Create sample data structure
- [ ] Design MCP tool interfaces

**Implementation**:
- [ ] Create model with Zod schema in `src/models/`
- [ ] Add decoder function in `src/core/decoder.ts`
- [ ] Add database method in `src/core/database.ts`
- [ ] Export from `src/core/index.ts`
- [ ] Add tool methods in `src/tools/tools.ts`
- [ ] Register handlers in `src/server.ts`
- [ ] Update tool count in tests

**Testing**:
- [ ] Unit tests for decoder
- [ ] Unit tests for database methods
- [ ] Unit tests for tool methods
- [ ] Integration tests
- [ ] Test with real database data
- [ ] Validate output accuracy

**Documentation**:
- [ ] Update README with new tools
- [ ] Add JSDoc comments
- [ ] Update IMPLEMENTATION_PLAN.md
- [ ] Create PR with detailed description

**Quality Gates**:
- [ ] All tests passing (417+)
- [ ] Type checking passes
- [ ] Linting passes
- [ ] Formatting verified
- [ ] PR approved and merged
```

---

## 🎯 Success Metrics

**Completion Criteria**:
- All 10 phases implemented
- 40+ MCP tools available
- 100% test coverage maintained
- All collections decoded correctly
- Performance acceptable (<1s for most queries)

**Quality Metrics**:
- Zero decoder errors on real data
- All tool outputs validated
- Documentation complete
- Examples provided for each tool

---

## 🛠️ Agent Instructions

When picking up a phase to implement:

1. **Read this plan section thoroughly**
2. **Review existing similar implementations** (e.g., budgets, goals)
3. **Test with real database** before creating PR
4. **Follow the checklist** exactly
5. **Update this plan** with findings/changes
6. **Create detailed PR** with examples

**Important Notes**:
- Always search for path markers in LevelDB files
- Extract fields AFTER the document ID to avoid adjacent documents
- Use `fieldPattern()` helper for Firestore field encoding
- Test with user's actual database to catch edge cases
- Update test count expectations when adding tools

---

**Last Updated**: 2026-01-13
**Next Phase**: Investment Prices (Phase 7)
