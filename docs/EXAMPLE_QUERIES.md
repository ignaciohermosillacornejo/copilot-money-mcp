# Example Queries Guide

This guide provides example natural language queries you can use with the Copilot Money MCP Server through Claude Desktop.

## Getting Started

### Basic Account Information

```
"What's my current account balance?"
"Show me all my accounts"
"How much is in my Chase checking account?"
```

### Simple Transaction Queries

```
"Show me my last 10 transactions"
"What did I buy at Amazon this month?"
"Show me all my transactions over $100"
```

---

## Core Transaction Queries

### By Date

```
"Show me all transactions from last month"
"What did I spend in December?"
"Show me my transactions for the last 90 days"
"What were my expenses between January 1st and January 10th?"
```

### By Merchant

```
"Show me all my Starbucks purchases this year"
"How much have I spent at Whole Foods?"
"Find all my Uber rides in the last 30 days"
"Show me every Amazon transaction from last quarter"
```

### By Category

```
"Show me all my restaurant transactions"
"What did I spend on groceries this month?"
"Show me all my travel expenses"
"Find my healthcare spending for the year"
```

### By Amount

```
"Show me all transactions over $500"
"Find purchases between $50 and $200"
"What are my largest transactions this month?"
"Show me small transactions under $10"
```

---

## Spending Analysis

### Category Breakdown

```
"Break down my spending by category for last month"
"What categories did I spend the most on this year?"
"Show me my spending categories for the last 90 days"
"Which category is my biggest expense?"
```

### Merchant Analysis

```
"Which merchants do I spend the most money at?"
"Show me my top 10 merchants by spending"
"Who are my most frequent merchants?"
"How much do I spend at my top 5 stores?"
```

### Day of Week Patterns

```
"Do I spend more on weekdays or weekends?"
"Show me my spending by day of the week"
"Which day do I spend the most money?"
"What's my average spending per day of the week?"
```

### Spending Velocity

```
"How fast am I spending this month?"
"Am I on track with my spending for this month?"
"What's my daily burn rate?"
"Project my month-end spending total"
```

---

## Income & Credits

### Income Tracking

```
"How much income did I have last month?"
"Show me all my paychecks this year"
"What are my income sources?"
"How much money came in last quarter?"
```

### Credits & Refunds

```
"Show me all my refunds this month"
"What credits did I receive?"
"Find all my Amazon refunds"
"Show me statement credits from my Amex"
```

---

## Travel & International

### Foreign Transactions

```
"Show me all my international transactions"
"How much did I spend abroad last month?"
"What foreign transaction fees did I pay?"
"Show me spending by country"
```

### Trip Analysis

```
"Analyze my trip to Chile in December"
"Show me all my trips this year"
"How much did I spend during my vacation?"
"What were my travel expenses for each trip?"
```

---

## Data Quality & Maintenance

### Data Quality Checks

```
"Check my data quality for the last 90 days"
"Are there any issues with my financial data?"
"Find data quality problems in my transactions"
"Check if I have any duplicate accounts"
```

### Duplicate Detection

```
"Find duplicate transactions"
"Are there any repeated charges?"
"Show me potential duplicate transactions"
```

### Unusual Transactions

```
"Find unusual transactions this month"
"Show me transactions that are significantly higher than normal"
"What are my outlier expenses?"
"Find anomalies in my spending"
```

---

## Subscriptions & Recurring

### Finding Subscriptions

```
"What subscriptions do I have?"
"Show me all my recurring charges"
"How much am I spending on subscriptions per month?"
"Find all my monthly recurring expenses"
```

### Subscription Analysis

```
"Which subscriptions are most expensive?"
"When is my next Netflix charge?"
"Show me all my software subscriptions"
"What streaming services am I paying for?"
```

---

## Healthcare & HSA/FSA

### Eligible Expenses

```
"Show me HSA eligible transactions"
"What healthcare expenses can I submit to my FSA?"
"Find all my pharmacy purchases"
"Show me medical expenses from last year"
```

### Healthcare Spending

```
"How much did I spend on healthcare this year?"
"Show me all my CVS purchases"
"What did I spend at doctors and hospitals?"
"Find all my dental expenses"
```

---

## Comparative Analysis

### Period Comparison

```
"Compare my spending this month vs last month"
"How does this quarter compare to last quarter?"
"Am I spending more or less than last year?"
"Compare my income this year to last year"
```

### Category Trends

```
"Has my restaurant spending increased?"
"Am I spending less on groceries than before?"
"Compare my travel spending year over year"
"Show me how my categories have changed"
```

---

## Advanced Queries

### Multi-Filter Queries

```
"Show me restaurant transactions over $100 from last month"
"Find all Amazon purchases between $50-$200 this year"
"Show me international transactions on my Chase card"
"Find Uber rides over $30 in December"
```

### Specific Transaction Lookup

```
"Find the transaction at Starbucks on December 15th for $5.75"
"Show me the Whole Foods purchase from last Tuesday"
"Look up my Amazon order from January 3rd"
```

### Export & Reporting

```
"Export all my transactions from 2025 to CSV"
"Give me a JSON export of last month's spending"
"Export my Q4 transactions"
"Download my year-end transaction data"
```

---

## Example Conversation Flows

### Monthly Review

```
User: "Let's review my finances for December"

Claude: [Gets spending by category for December]

User: "What were my top merchants?"

Claude: [Shows top merchants for December]

User: "Did I spend more than November?"

Claude: [Compares December vs November]

User: "Check for any data quality issues"

Claude: [Runs data quality report]
```

### Trip Analysis

```
User: "I traveled to Chile in December. Can you analyze my trip?"

Claude: [Gets trip data for Chile]

User: "What were my biggest expenses?"

Claude: [Shows top spending categories for the trip]

User: "How much did I pay in foreign transaction fees?"

Claude: [Gets foreign transactions and FX fees]

User: "Check if any of those transactions look wrong"

Claude: [Runs data quality report, finds currency issues]
```

### Subscription Audit

```
User: "What subscriptions am I paying for?"

Claude: [Gets recurring transactions]

User: "Which ones are most expensive?"

Claude: [Sorts by amount]

User: "Show me when each one charges"

Claude: [Shows next expected charge dates]

User: "How much total per month?"

Claude: [Calculates monthly subscription cost]
```

### Healthcare Expense Tracking

```
User: "Show me all my healthcare expenses for 2025"

Claude: [Gets HSA/FSA eligible transactions]

User: "How much is that total?"

Claude: [Sums amounts]

User: "Export these to CSV so I can submit to my HSA"

Claude: [Exports transactions]
```

---

## Tips for Better Queries

### Be Specific with Dates

✅ **Good:** "Show me transactions from December 1st to December 31st"
❌ **Vague:** "Show me recent transactions"

### Use Merchant Names Exactly

✅ **Good:** "Show me Whole Foods purchases"
❌ **Vague:** "Show me grocery store stuff"

### Specify Categories Clearly

✅ **Good:** "Show me restaurant spending"
❌ **Vague:** "Show me food"

### Ask Follow-up Questions

Instead of one complex query, ask a series of related questions:
1. "Show me my spending for last month"
2. "What categories were highest?"
3. "Show me all restaurant transactions"
4. "Which restaurants did I visit most?"

### Use Period Shorthand

Claude understands these period shortcuts:
- "this month"
- "last month"
- "last 30 days"
- "last 90 days"
- "this year"
- "last year"
- "year to date" or "ytd"
- "this quarter"
- "last quarter"

---

## Common Scenarios

### 1. Monthly Budget Check

```
"What did I spend this month?"
"Break it down by category"
"Am I on track for my usual spending?"
"Compare to last month"
```

### 2. Pre-Tax Preparation

```
"Export all 2025 transactions to CSV"
"Show me all my business expenses"
"Find all my charitable donations"
"Show me HSA eligible expenses"
```

### 3. Expense Report for Work

```
"Show me all my travel expenses from the conference trip in October"
"Find meals and entertainment expenses"
"Export these to CSV"
```

### 4. Subscription Cleanup

```
"What subscriptions do I have?"
"Which ones haven't charged in the last 60 days?"
"Show me all streaming service subscriptions"
"Find subscriptions under $10/month"
```

### 5. International Trip Budget Review

```
"Analyze my international trip last month"
"What did I spend by category?"
"How much in foreign transaction fees?"
"Check for currency conversion errors"
```

### 6. Fraud Check

```
"Show me all unusual transactions this month"
"Find any duplicate charges"
"Show me transactions I haven't reviewed"
"Are there any suspicious amounts?"
```

---

## Troubleshooting Queries

### If You Get Unexpected Results

```
"Check data quality for [period]"
"Show me unresolved categories"
"Find suspicious categorizations"
"Are there any duplicate accounts?"
```

### If Amounts Seem Wrong

```
"Show me foreign transactions with potential currency issues"
"Find transactions over $1000 with foreign merchants"
"Check for unconverted foreign currency amounts"
```

### If You Can't Find a Transaction

```
"Search for [merchant name]"
"Show me all transactions on [date]"
"Find transactions around [amount]"
"Show me pending transactions"
```

---

## Pro Tips

### 1. Start with Data Quality
Before detailed analysis, run: `"Check my data quality"`

### 2. Use Natural Language
You don't need to know tool names or parameters - just ask naturally!

### 3. Be Conversational
Claude remembers context, so you can have a conversation:
- "Show me December spending"
- "Now break that down by category"
- "What about just restaurants?"
- "Which restaurants specifically?"

### 4. Ask for Explanations
- "Why is my spending so high this month?"
- "Explain this unusual transaction"
- "What's driving my grocery costs?"

### 5. Request Visualizations
While the MCP server returns data, you can ask Claude to:
- "Summarize this in a table"
- "Show me the top 5"
- "Format this as a list"

---

## Tool Reference (Behind the Scenes)

When you ask questions, Claude uses these 8 tools automatically:

| Your Question | Tool Used |
|---------------|-----------|
| "Show my transactions" | `get_transactions` |
| "Search for Amazon" | `get_transactions` (with merchant filter) |
| "What are my accounts?" | `get_accounts` |
| "Spending by category" | `get_categories` |
| "What categories exist?" | `get_categories` |
| "Find subscriptions" | `get_recurring_transactions` |
| "Show my budgets" | `get_budgets` |
| "What are my goals?" | `get_goals` |
| "Check cache status" | `get_cache_info` |
| "Refresh database" | `refresh_database` |

---

**For more information:**
- [README](../README.md) - Installation and setup
- [Testing Guide](TESTING_GUIDE.md) - For developers

Have a query pattern that's not listed here? [Open an issue](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues) to suggest additions!
