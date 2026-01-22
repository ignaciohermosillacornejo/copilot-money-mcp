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

Use compact structured data instead of verbose JSON:

```typescript
// ❌ BAD: Verbose JSON (100+ tokens per transaction)
{
  "transaction_id": "txn_abc123...",
  "amount": 42.50,
  "date": "2026-01-10",
  "name": "Starbucks",
  "original_name": "STARBUCKS #12345",
  "category_id": "cat_food_dining",
  // ... 15 more fields
}

// ✅ GOOD: Essential fields only (20-30 tokens per transaction)
{
  "date": "2026-01-10",
  "name": "Starbucks",
  "amount": 42.50,
  "category_name": "Food & Dining"
}
```

**Implementation:** `src/tools/tools.ts` - enriched transaction mapping

#### 2. Smart Defaults

Always use sensible limits:
- `get_transactions`: **limit=50** (default)
- `search_transactions`: **limit=20** (default)
- `get_accounts`: Return all (only ~14 accounts)

Document limits clearly in tool descriptions so Claude knows the constraints.

#### 3. Summary-First Approach

Aggregation tools return totals/counts before details:

```typescript
// ✅ GOOD: Summary first, then paginated data
{
  "count": 50,
  "total_count": 234,
  "has_more": true,
  "transactions": [/* limited results */]
}
```

#### 4. Token Budget Awareness

**Estimated Token Usage:**

| Tool | Default Output | Estimated Tokens | Status |
|------|----------------|------------------|--------|
| `get_transactions` (50) | 50 enriched transactions | 2K-5K | ✅ Safe |
| `get_categories` | Aggregated by category | 500-1K | ✅ Safe |
| `get_accounts` | All accounts (~10-20) | 200-500 | ✅ Safe |
| `get_recurring_transactions` | Recurring items | 1K-3K | ✅ Safe |
| `get_budgets` | Budget list | 200-500 | ✅ Safe |
| `get_goals` | Goal list | 200-500 | ✅ Safe |
| **Unlimited transactions** | Full JSON dump | **200K-300K** | ❌ NEVER |

### Implementation Guidelines

1. **Use TypeScript utilities** (`src/tools/tools.ts`):
   - Enrich transactions with human-readable category names
   - Include pagination metadata (count, total_count, has_more)
   - Use `roundAmount()` for consistent decimal formatting

2. **Always show counts**:
   - Return `count` (current page) and `total_count` (all matching)
   - Include `has_more` boolean for pagination awareness

3. **Prioritize recent data**:
   - Sort by date descending (most recent first)
   - Recent data is usually more relevant

4. **Default limits**:
   - `get_transactions`: 50 results default
   - All tools have sensible defaults that fit context windows

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

**Last Updated:** 2026-01-21
**Status:** Implemented in v1.2.1
