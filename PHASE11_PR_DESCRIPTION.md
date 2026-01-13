# Phase 11: Goal History Subcollection

## Summary

This PR implements Phase 11 of the Copilot Money MCP server enhancements, adding comprehensive support for the **financial goal history subcollection**. This enables tracking of monthly goal progress, contribution analysis, and completion estimates based on historical data.

## What's New

### 4 New MCP Tools

1. **`get_goal_progress`** - Get current progress and status for financial goals
   - Shows current amount saved, progress percentage, estimated completion
   - Calculates actual progress from historical snapshots
   - Works for individual goals or all goals

2. **`get_goal_history`** - Get monthly historical snapshots of goal progress
   - Returns monthly data showing how goal amounts changed over time
   - Includes start/end amounts for each month, progress percentages
   - Useful for visualizing goal progress trends

3. **`estimate_goal_completion`** - Estimate when goals will be completed
   - Calculates completion dates based on historical contribution rates
   - Shows months remaining, estimated completion month
   - Indicates whether goal is on track based on expected vs actual contributions

4. **`get_goal_contributions`** - Analyze goal contribution patterns
   - Shows total deposits, withdrawals, net contributions
   - Provides monthly breakdown with deposits/withdrawals separated
   - Calculates average monthly contribution rate

### Total Tool Count: 25 → 29 tools

## Implementation Details

### New Files Created

1. **`src/models/goal-history.ts`** (203 lines)
   - `GoalHistorySchema` - Zod schema for validation
   - `DailySnapshotSchema` - Schema for daily snapshots nested within monthly data
   - `GoalContributionSchema` - Schema for contribution/transaction tracking
   - Helper functions for progress tracking, contribution analysis, and data extraction

2. **`tests/unit/goal-history.test.ts`** (434 lines)
   - Comprehensive test coverage for all goal history functionality
   - 15+ test cases covering all scenarios

### Modified Files

- `src/models/goal.ts` - Added completion estimation and velocity tracking
- `src/core/decoder.ts` - Added goal history decoder (+180 lines)
- `src/core/database.ts` - Added getGoalHistory method (+50 lines)
- `src/tools/tools.ts` - Implemented 4 new tools (+390 lines)
- `src/server.ts` - Added tool handlers (+45 lines)
- `tests/unit/server-protocol.test.ts` - Updated tool count
- `README.md` - Updated documentation
- `src/models/index.ts`, `src/core/index.ts` - Added exports

## Data Structure

Path: `/users/{user_id}/financial_goals/{goal_id}/financial_goal_history/{month}`

Each document represents a monthly snapshot with current_amount, target_amount, and daily_data nested objects.

## Testing

- ✅ 15+ new unit tests
- ✅ Schema validation tests
- ✅ Progress calculation tests
- ✅ Tool count updated (25 → 29)
- ✅ All edge cases covered

## Files Changed

**Total:** 11 files changed, ~1,302 additions

---

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
