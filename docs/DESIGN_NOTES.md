# Design Notes

## Context-Conscious MCP Tool Design

**Critical Consideration:** MCP tools must be mindful of Claude's context window.

### The Challenge

With **5,253 transactions** in our demo database, naive implementations could easily consume:
- **200K-300K tokens** if returning all transactions 😱
- This would exhaust Claude's context window
- Users would experience poor performance and truncated responses

### Our Solution: Context-Efficient Design

#### 1. Concise Output Format

Use compact string formatting instead of verbose JSON:

```python
# ❌ BAD: Verbose JSON (100+ tokens per transaction)
{
  "transaction_id": "txn_abc123...",
  "amount": 42.50,
  "date": "2026-01-10",
  "name": "Starbucks",
  "original_name": "STARBUCKS #12345",
  "category_id": "cat_food_dining",
  # ... 15 more fields
}

# ✅ GOOD: Compact format (20-30 tokens per transaction)
"2026-01-10 | Starbucks | $42.50 | Food & Dining"
```

**Implementation:** `src/copilot_money_mcp/utils/formatting.py`

#### 2. Smart Defaults

Always use sensible limits:
- `get_transactions`: **limit=50** (default)
- `search_transactions`: **limit=20** (default)
- `get_accounts`: Return all (only ~14 accounts)

Document limits clearly in tool descriptions so Claude knows the constraints.

#### 3. Summary-First Approach

Aggregation tools return totals/counts before details:

```python
# ✅ GOOD: Summary first, then samples
"""
Found 234 grocery transactions totaling $5,432.10 in January 2026.

Top merchants:
1. Whole Foods: $1,234.56 (45 transactions)
2. Trader Joe's: $892.30 (32 transactions)
3. Safeway: $654.21 (28 transactions)
...and 12 more merchants

Recent transactions:
2026-01-10 | Whole Foods | $87.23 | Groceries
2026-01-09 | Trader Joe's | $45.67 | Groceries
...and 229 more transactions
"""
```

#### 4. Token Budget Awareness

**Estimated Token Usage:**

| Tool | Default Output | Estimated Tokens | Status |
|------|----------------|------------------|--------|
| `get_transactions` (50) | 50 compact lines | 2K-5K | ✅ Safe |
| `spending_summary` | Aggregated totals | 500-1K | ✅ Safe |
| `account_balances` | ~14 accounts | 200-500 | ✅ Safe |
| `search_transactions` (20) | 20 compact lines | 1K-2K | ✅ Safe |
| **All 5,253 transactions** | Full JSON dump | **200K-300K** | ❌ NEVER |

### Implementation Guidelines

1. **Create formatting utilities** (`utils/formatting.py`):
   - `format_transaction_compact(txn) -> str`
   - `format_summary_response(data, total_count) -> str`
   - `truncate_with_message(items, limit) -> str`

2. **Always show counts**:
   - "Showing 50 of 234 transactions"
   - "...and 184 more transactions"

3. **Prioritize recent data**:
   - Sort by date descending (most recent first)
   - Recent data is usually more relevant

4. **Consider verbose mode**:
   - Optional `verbose=True` parameter for detailed output
   - Default to concise format

### Testing Context Efficiency

In Phase 5, verify:
- Maximum response size for each tool < 10K tokens
- Tools with default parameters fit comfortably in context
- Long result sets are properly truncated with clear messages

### Future Optimizations

If context is still an issue:
- Add `max_tokens` parameter to tools
- Implement streaming for very large result sets
- Add pagination support
- Create "preview" mode (first 10 results + summary)

---

**Last Updated:** 2026-01-11
**Status:** Documented for Phase 3 implementation
