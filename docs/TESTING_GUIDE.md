# Testing Guide for Claude Desktop

This guide provides comprehensive instructions for testing the Copilot Money MCP Server in Claude Desktop.

## Prerequisites

Before testing, ensure you have:

1. **Claude Desktop** installed (latest version)
   - Download from: https://claude.ai/desktop

2. **Copilot Money** installed with local database
   - The server reads from the local LevelDB cache at: `~/Library/Containers/com.copilot.production/Data/Library/Application Support/firestore/__FIRAPP_DEFAULT/copilot-production-22904/main`
   - Make sure you have transaction data in Copilot Money

3. **Bun or Node.js 18+**
   ```bash
   bun --version  # Recommended
   # or
   node --version
   ```

## Installation Methods

### Method 1: Install from .mcpb File (Recommended)

This is the simplest method for testing:

1. **Locate the .mcpb file**:
   ```bash
   ls -lh copilot-money-mcp.mcpb
   ```
   Should show: ~318KB file

2. **Double-click the .mcpb file**:
   - Claude Desktop should open automatically
   - You'll see an installation prompt
   - Click "Install"
   - Restart Claude Desktop

3. **Verify installation**:
   - Open Claude Desktop
   - Go to: Settings → Developer → MCP Servers
   - You should see: `copilot-money-mcp` (enabled ✓)

### Method 2: Manual Installation

If double-clicking doesn't work:

1. **Copy .mcpb to Claude's directory**:
   ```bash
   cp copilot-money-mcp.mcpb ~/Library/Application\ Support/Claude/mcpb/
   ```

2. **Restart Claude Desktop**:
   - Quit Claude Desktop completely (Cmd+Q)
   - Reopen Claude Desktop
   - The server should now appear in Settings

### Method 3: Development Mode (For Testing Changes)

For active development and testing:

1. **Edit Claude Desktop config**:
   ```bash
   code ~/Library/Application\ Support/Claude/claude_desktop_config.json
   ```

2. **Add the server manually**:
   ```json
   {
     "mcpServers": {
       "copilot-money-dev": {
         "command": "node",
         "args": [
           "/Users/nach/Projects/copilot-money-mcp/dist/cli.js"
         ]
       }
     }
   }
   ```

3. **Restart Claude Desktop**

## Verifying Installation

### Check Server Status

1. Open Claude Desktop
2. Go to: **Settings → Developer → MCP Servers**
3. Look for: `copilot-money-mcp`
4. Status should show: **Connected** (green indicator)

### Check Available Tools

Start a new conversation in Claude Desktop and ask:

```
What MCP tools do you have access to?
```

You should see 8 tools listed:
- `get_transactions` - Query transactions with filtering
- `get_accounts` - List all accounts with balances
- `get_categories` - Get spending by category
- `get_recurring_transactions` - Find recurring/subscription charges
- `get_budgets` - View budget tracking
- `get_goals` - View financial goals
- `get_cache_info` - Check database cache status
- `refresh_database` - Refresh the database cache

### First-Time Tool Approvals ⚠️

**Important:** When you first use each tool, Claude Desktop will show an approval prompt. This is normal security behavior.

**What you'll see:**
1. First query triggers an approval dialog
2. Dialog shows:
   - Tool name (e.g., "get_transactions")
   - Tool description
   - Parameters being passed (e.g., `{"period": "this_month", "limit": 30}`)
3. Options: "Allow" or "Deny"

**Expected behavior:**
- **8 separate approvals** - One for each tool when first used
- **One-time only** - After approving, no more prompts for that tool
- **Persistent** - Approvals survive Claude Desktop restarts

**Why this happens:**
- Claude Desktop requires explicit consent before any MCP tool accesses data
- Even read-only tools (with `readOnlyHint: true`) require approval
- This is by design for security, not a bug or configuration issue

**What to do:**
1. Click "Allow" when prompted
2. Continue with your query
3. If you use a different tool, approve it when prompted
4. After approving all 8 tools once, testing becomes seamless

**Tip:** Try using multiple tools in your first test session to get approvals out of the way!

## Testing All Tools

### Test 1: get_transactions

**Basic Query:**
```
Show me my last 10 transactions
```

**Expected Response:**
- List of 10 most recent transactions
- Each transaction includes: date, merchant, amount, category
- Should be formatted in a readable table or list

**Advanced Queries:**
```
What did I spend in January 2026?
Find all transactions over $100 from last month
Show me all my grocery purchases from the last 30 days
```

**Expected Results:**
- Proper date filtering
- Amount filtering works correctly
- Category filtering is accurate
- Results sorted by date (newest first)

**What to Verify:**
- ✅ No errors or crashes
- ✅ Response time <5 seconds
- ✅ Data matches your Copilot Money app
- ✅ Dates are formatted correctly (YYYY-MM-DD)
- ✅ Amounts are formatted with 2 decimal places

---

### Test 2: get_categories

**Basic Query:**
```
Show me my spending by category this month
```

**Expected Response:**
- List of categories with transaction counts and totals
- Categories sorted by amount (highest first)

**Advanced Queries:**
```
Break down my spending by category for last month
What are my top spending categories?
Show me category spending for Q1
```

**Expected Results:**
- Categories are aggregated correctly
- Amounts are accurate
- Period filtering works

**What to Verify:**
- ✅ All categories with transactions are listed
- ✅ Amounts match Copilot Money
- ✅ Period filtering works correctly
- ✅ Parent category info is included

---

### Test 3: get_accounts

**Basic Query:**
```
What's my total balance across all accounts?
```

**Expected Response:**
- List of all accounts with:
  - Account name
  - Account type (checking, savings, credit card, etc.)
  - Current balance
- Total balance calculated across all accounts

**Advanced Queries:**
```
Show me all my checking accounts
List all my bank accounts
What accounts do I have?
```

**Expected Results:**
- All accounts from Copilot Money are listed
- Balances match Copilot Money app
- Total is calculated correctly

**What to Verify:**
- ✅ All accounts are listed
- ✅ Balances are accurate
- ✅ Total balance is correct
- ✅ Account names and types are correct
- ✅ No duplicate accounts

---

### Test 4: get_recurring_transactions

**Basic Query:**
```
Show me my recurring charges and subscriptions
```

**Expected Response:**
- List of detected recurring transactions
- Includes frequency (monthly, weekly, etc.)
- Estimated monthly cost

**Advanced Queries:**
```
What subscriptions am I paying for?
Show me details for my Netflix subscription
Find all my monthly recurring charges
```

**Expected Results:**
- Recurring items are detected correctly
- Frequency is accurate
- Next expected date is shown
- Transaction history is available

**What to Verify:**
- ✅ Recurring items are identified
- ✅ Frequency detection is accurate
- ✅ Amounts are correct
- ✅ Detail view works with name filter
- ✅ No false positives

---

### Test 5: get_budgets

**Basic Query:**
```
Show me my budgets
```

**Expected Response:**
- List of budgets with:
  - Budget name/category
  - Budgeted amount
  - Period (monthly, yearly, etc.)

**Advanced Queries:**
```
What are my active budgets?
Show me my grocery budget
How much have I budgeted in total?
```

**Expected Results:**
- All budgets are listed
- Amounts are accurate
- Active/inactive filtering works

**What to Verify:**
- ✅ All budgets are listed
- ✅ Amounts are correct
- ✅ Category names are resolved (not raw IDs)
- ✅ Total budgeted is calculated

---

### Test 6: get_goals

**Basic Query:**
```
Show me my financial goals
```

**Expected Response:**
- List of goals with:
  - Goal name
  - Target amount
  - Current progress

**What to Verify:**
- ✅ All goals are listed
- ✅ Progress is accurate
- ✅ Target amounts are correct

---

## Performance Testing

### Response Time

For each tool, measure response time:

```
[Ask question]
[Note start time]
[Wait for response]
[Note end time]
```

**Targets:**
- Simple queries: <2 seconds
- Complex queries (with filtering): <5 seconds
- Search queries: <3 seconds

If any query takes longer than 10 seconds, report as a performance issue.

### Memory Usage

Monitor memory usage during testing:

1. **Open Activity Monitor** (Cmd+Space → "Activity Monitor")
2. **Find the MCP server process**: Search for "node" or "copilot-money-mcp"
3. **Monitor memory**: Should stay under 100MB

**Expected Memory:**
- Initial load: ~20-50MB
- After queries: ~30-70MB
- Peak usage: <100MB

If memory exceeds 200MB, report as a memory leak.

---

## Error Handling Tests

Test how the server handles errors:

### Test 1: Database Not Found

1. **Temporarily rename the database directory**:
   ```bash
   mv ~/Library/Containers/com.copilot.production/Data/Library/Application\ Support/firestore \
      ~/Library/Containers/com.copilot.production/Data/Library/Application\ Support/firestore.backup
   ```

2. **Try a query**: "Show me my transactions"

3. **Expected Result**:
   - Clear error message: "Database not found" or similar
   - No crash or hang
   - Helpful suggestion to check Copilot Money installation

4. **Restore the database**:
   ```bash
   mv ~/Library/Containers/com.copilot.production/Data/Library/Application\ Support/firestore.backup \
      ~/Library/Containers/com.copilot.production/Data/Library/Application\ Support/firestore
   ```

### Test 2: Invalid Date Period

Try queries with invalid dates:

```
Show me transactions from "invalid_date"
Get spending for "not_a_period"
```

**Expected Result**:
- Clear error message
- Suggestion for valid formats
- No crash

### Test 3: Empty Results

Try queries that should return no results:

```
Find transactions for merchant "NONEXISTENT_MERCHANT_12345"
Show me spending on category "INVALID_CATEGORY"
```

**Expected Result**:
- Message: "No transactions found" or similar
- No error or crash
- Suggestion to try different filters

---

## Privacy & Security Tests

> **Note:** These tests assume the default **read-only mode**. If you start the server with `--write`, write tools are enabled and the server will make authenticated HTTPS requests to Copilot Money's Firebase/Firestore backend to apply your requested changes — so Tests 1 and 2 below will not hold. Run these tests without the `--write` flag.

### Test 1: No Network Requests (Read-Only Mode)

1. **Start the server without `--write`** (default mode).

2. **Disconnect from the internet**:
   - Turn off Wi-Fi
   - Or use Network Link Conditioner to block all traffic

3. **Try several read queries**:
   - All read queries should still work
   - No "network error" messages

4. **Expected Result**:
   - All read tools work offline
   - No network requests attempted

### Test 2: Read-Only Access (Default Mode)

Verify that in read-only mode the server doesn't modify data:

1. **Start the server without `--write`** (default mode).
2. **Note current transaction count** in Copilot Money
3. **Run multiple read queries** through Claude Desktop
4. **Check Copilot Money** - transaction count should be unchanged
5. **Check database files**:
   ```bash
   ls -l ~/Library/Containers/com.copilot.production/Data/Library/Application\ Support/firestore/__FIRAPP_DEFAULT/copilot-production-22904/main/*.ldb
   ```
   Modification times should not change from MCP queries

**Expected Result**:
- Database files not modified by MCP
- No new transactions created
- All data remains unchanged

> In **write mode** (`--write`), the server *can* legitimately modify your Copilot Money data through the Firestore REST API. Write tests belong in the write-tool test suite, not here.

---

## Integration Tests

### Test 1: Multiple Queries in Sequence

Test a conversation with multiple queries:

```
User: What's my total balance?
Claude: [Shows balance]
User: Show me my last 5 transactions
Claude: [Shows transactions]
User: How much did I spend on dining last month?
Claude: [Shows spending breakdown]
```

**Expected Result**:
- All queries work correctly
- Context is maintained
- No performance degradation

### Test 2: Complex Natural Language

Test with complex, natural queries:

```
"I'm trying to understand my spending habits. Can you show me how much I spent on groceries and dining out combined last month, and compare that to my total spending?"
```

**Expected Result**:
- Claude correctly interprets the query
- Multiple tool calls are made if needed
- Results are synthesized and presented clearly

---

## Common Issues & Solutions

### Issue: Server Not Appearing in Settings

**Solution:**
1. Check if .mcpb is in the correct directory:
   ```bash
   ls ~/Library/Application\ Support/Claude/mcpb/*.mcpb
   ```
2. Restart Claude Desktop completely (Cmd+Q, then reopen)
3. Check Claude Desktop logs:
   ```bash
   tail -f ~/Library/Logs/Claude/mcp*.log
   ```

### Issue: "Database not found" Error

**Solution:**
1. Verify Copilot Money is installed
2. Check database path:
   ```bash
   ls -la ~/Library/Containers/com.copilot.production/Data/Library/Application\ Support/firestore/__FIRAPP_DEFAULT/copilot-production-22904/main/
   ```
3. If using a custom path, use the `--db-path` CLI argument

### Issue: Tools Not Working

**Solution:**
1. Check server logs for errors:
   ```bash
   tail -f ~/Library/Logs/Claude/mcp*.log
   ```
2. Verify Node.js version:
   ```bash
   node --version
   ```
3. Reinstall the .mcpb bundle

### Issue: Slow Performance

**Solution:**
1. Check database size:
   ```bash
   du -sh ~/Library/Containers/com.copilot.production/Data/Library/Application\ Support/firestore/__FIRAPP_DEFAULT/copilot-production-22904/main/
   ```
2. Check available memory in Activity Monitor
3. Close other applications
4. Try refreshing the cache: ask Claude to "refresh the database"
5. Try restarting Claude Desktop

---

## Reporting Issues

If you encounter any issues, please report them with:

1. **Issue Description**: What went wrong?
2. **Steps to Reproduce**: How to trigger the issue?
3. **Expected Behavior**: What should happen?
4. **Actual Behavior**: What actually happened?
5. **Environment**:
   - macOS version
   - Claude Desktop version
   - Node.js version
   - Copilot Money version
6. **Logs**: Relevant log excerpts from:
   ```bash
   ~/Library/Logs/Claude/mcp*.log
   ```

Report issues at: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues

---

## Success Checklist

Before considering testing complete, verify:

- [ ] All 8 tools work correctly
- [ ] Response times are acceptable (<5s)
- [ ] Memory usage is reasonable (<100MB)
- [ ] Error handling is graceful
- [ ] No crashes or hangs
- [ ] Privacy is maintained (no network requests in default read-only mode)
- [ ] Data accuracy matches Copilot Money
- [ ] Complex queries are handled well
- [ ] Server survives multiple queries
- [ ] Cache refresh works correctly

---

## Next Steps

After successful testing:

1. **Document results**: Note any issues or observations
2. **Create GitHub release**: Tag version 1.0.0
3. **Submit to MCP directory**: Follow submission process
4. **Share with community**: Announce the release

---

## Resources

- **Repository**: https://github.com/ignaciohermosillacornejo/copilot-money-mcp
- **Privacy Policy**: [PRIVACY.md](PRIVACY.md)
- **User Guide**: [README.md](README.md)
- **MCP Documentation**: https://modelcontextprotocol.io/
- **Claude Desktop Help**: https://support.claude.com/

---

**Happy Testing! 🚀**
