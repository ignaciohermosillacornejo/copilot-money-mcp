# Data Quality Tool User Guide

## Overview

The `get_data_quality_report` tool helps you identify and fix data quality issues in your Copilot Money financial data. Rather than masking problems, this tool surfaces them so you can correct them at the source in Copilot Money itself.

## When to Use This Tool

Run this tool before doing financial analysis to ensure accurate results, especially:

- ✅ After international travel
- ✅ When spending totals seem unexpectedly high
- ✅ Before generating financial reports
- ✅ After syncing new accounts
- ✅ Periodically (monthly or quarterly) as a data health check

## How to Use

### Basic Usage

Simply ask Claude to check your data quality:

```
"Can you check my financial data quality for the last 90 days?"
```

Claude will call:
```json
{
  "tool": "get_data_quality_report",
  "arguments": {
    "period": "last_90_days"
  }
}
```

### Advanced Usage

You can specify custom date ranges:

```
"Check data quality between December 1st and January 10th"
```

```json
{
  "tool": "get_data_quality_report",
  "arguments": {
    "start_date": "2025-12-01",
    "end_date": "2026-01-10"
  }
}
```

## What the Tool Detects

### 1. Unresolved Category IDs ❓

**Problem:** Some transactions have category IDs that can't be mapped to human-readable names (e.g., `Bx0KfZMa8Lcct3xDfAvU` or `13005000`).

**Example Output:**
```json
{
  "category_issues": {
    "unresolved_category_count": 3,
    "unresolved_categories": [
      {
        "category_id": "Bx0KfZMa8Lcct3xDfAvU",
        "transaction_count": 22,
        "total_amount": 1548.08,
        "sample_transactions": [
          {
            "date": "2025-12-15",
            "merchant": "Starbucks",
            "amount": 5.75
          }
        ]
      }
    ]
  }
}
```

**How to Fix:**
1. Open Copilot Money app
2. Find the transactions listed in `sample_transactions`
3. Manually recategorize them to the correct category
4. The change will propagate to future reports

---

### 2. Potential Currency Conversion Issues 💱

**Problem:** Foreign currency amounts may be displayed in USD without proper conversion (e.g., 2,969 Chilean Pesos showing as $2,969.00).

**Example Output:**
```json
{
  "currency_issues": {
    "potential_unconverted_count": 5,
    "suspicious_transactions": [
      {
        "transaction_id": "txn_abc123",
        "date": "2025-12-26",
        "merchant": "Pronto Pte Rest SANTIAGO CL",
        "amount": 2969.96,
        "currency": "USD",
        "reason": "Large amount with foreign merchant name - possible unconverted currency"
      }
    ]
  }
}
```

**How to Fix:**
1. Verify the actual amount charged (check your credit card statement)
2. If the amount is wrong in Copilot Money:
   - Contact Copilot Money support
   - Or manually edit the transaction amount in the app
3. The tool helps you identify which transactions to investigate

**Common Patterns:**
- Very round numbers (2,000, 3,000, etc.) with foreign merchants
- Amounts that seem 20-50x too high (currency exchange rate issue)
- Foreign city names in merchant name (SANTIAGO, LONDON, etc.)

---

### 3. Non-Unique Transaction IDs 🔢

**Problem:** Multiple transactions share the same ID, which can cause issues with transaction lookup and duplicate detection.

**Example Output:**
```json
{
  "duplicate_issues": {
    "non_unique_transaction_ids": [
      {
        "transaction_id": "13005000",
        "occurrences": 40,
        "sample_dates": ["2025-12-01", "2025-12-05", "2025-12-10", "2025-12-15", "2025-12-20"]
      }
    ]
  }
}
```

**How to Fix:**
This is typically a Copilot Money internal issue. The IDs shown are often category IDs being used as transaction IDs.

**Action:**
- Note which transactions are affected
- Use date + merchant + amount for identification instead of ID
- Report to Copilot Money support if this affects your workflow

---

### 4. Potential Duplicate Accounts 👥

**Problem:** Multiple accounts with the same name and type may indicate duplicates or sync issues.

**Example Output:**
```json
{
  "duplicate_issues": {
    "potential_duplicate_accounts": [
      {
        "account_name": "Meta Platforms 401(k)",
        "account_type": "401k",
        "count": 2,
        "account_ids": ["acc_123", "acc_456"],
        "balances": [136662.04, 40245.23]
      }
    ]
  }
}
```

**How to Fix:**
1. Open Copilot Money app
2. Go to Accounts section
3. Check if both accounts are legitimate:
   - **If duplicate:** Remove one account
   - **If different:** Rename one for clarity (e.g., "Meta 401k - Old" vs "Meta 401k - Current")
4. Verify your total balance is correct after making changes

---

### 5. Suspicious Categorizations 🏷️

**Problem:** Common merchants are miscategorized in ways that don't make sense.

**Example Output:**
```json
{
  "suspicious_categorizations": [
    {
      "transaction_id": "txn_uber_123",
      "date": "2025-12-10",
      "merchant": "UBER TRIP",
      "amount": 25.50,
      "category_assigned": "Travel > Parking",
      "reason": "Uber should be Rideshare, not Parking"
    },
    {
      "transaction_id": "txn_pharm_456",
      "date": "2025-12-15",
      "merchant": "Farmacia Punta de Lo",
      "amount": 45.75,
      "category_assigned": "Shops > Office Supplies",
      "reason": "Pharmacy should be Healthcare, not Office Supplies"
    }
  ]
}
```

**Common Miscategorizations:**
| Merchant Type | Wrong Category | Correct Category |
|---------------|----------------|------------------|
| Uber | Parking | Rideshare |
| Whole Foods, Jumbo | Pawn Shops | Groceries |
| H&M, Zara | CBD | Clothing |
| Apple.com/Bill | Dance & Music | Subscriptions |
| Pharmacies | Office Supplies | Healthcare |
| Claude.ai | Travel/Cruises | Software |

**How to Fix:**
1. In Copilot Money, find the transaction
2. Change the category to the correct one
3. Copilot Money may learn the pattern for future transactions

---

## Understanding the Report

### Summary Section
```json
{
  "summary": {
    "total_transactions": 450,
    "total_accounts": 8,
    "issues_found": 42
  }
}
```

- `total_transactions`: Total transactions analyzed in the period
- `total_accounts`: Total accounts in your Copilot Money
- `issues_found`: Total number of issues detected across all categories

### Interpreting Results

**Good Report (Few Issues):**
```json
{
  "summary": { "issues_found": 5 },
  "category_issues": { "unresolved_category_count": 0 },
  "currency_issues": { "potential_unconverted_count": 0 },
  "duplicate_issues": {
    "non_unique_transaction_ids": [],
    "potential_duplicate_accounts": []
  },
  "suspicious_categorizations": []
}
```
✅ Your data is in good shape!

**Problematic Report:**
```json
{
  "summary": { "issues_found": 87 },
  "category_issues": { "unresolved_category_count": 15 },
  "currency_issues": { "potential_unconverted_count": 23 },
  "suspicious_categorizations": [/* 20+ items */]
}
```
⚠️ Significant data quality issues - worth spending time to clean up

---

## Example Claude Queries

### Check Overall Data Quality
```
"Check my data quality for the last 3 months"
```

### After International Travel
```
"I just got back from Chile. Can you check if my international
transactions look correct for December?"
```

### Before Financial Analysis
```
"Before we analyze my spending, can you check if there are any
data quality issues I should fix first?"
```

### Targeted Investigation
```
"Check data quality just for January - I notice some weird
amounts in my spending report"
```

### After Adding New Accounts
```
"I just linked my new credit card. Can you check if there
are any duplicate accounts?"
```

---

## Best Practices

### 1. Regular Health Checks
Run the data quality report **monthly** to catch issues early:
```
"Check data quality for this month"
```

### 2. Fix Issues Promptly
- Small issues are easier to fix than accumulated problems
- Fix categorizations while you remember what transactions are for
- Clean currency issues immediately after international travel

### 3. Verification Workflow
1. Run data quality report
2. Fix flagged issues in Copilot Money
3. Re-run report to verify fixes
4. Proceed with financial analysis

### 4. Don't Panic
- Some issues are cosmetic (e.g., weird category IDs that don't affect totals)
- Focus on high-impact issues first (currency conversion, duplicates)
- Not every "suspicious" categorization is actually wrong

---

## Limitations

### What This Tool Cannot Fix

❌ **Cannot automatically correct data** - This is a read-only reporting tool
❌ **Cannot modify Copilot Money database** - You must make changes in the app
❌ **Cannot guarantee 100% accuracy** - Some "issues" may be false positives
❌ **Cannot access Plaid/bank data** - Only sees what Copilot Money has synced

### Known False Positives

1. **Large legitimate transactions** may be flagged as currency issues
2. **Unusual but correct categories** may be flagged as suspicious
3. **Intentional duplicate accounts** (e.g., checking + savings at same bank) are flagged

Use your judgment and verify against your actual bank/credit card statements.

---

## Technical Details

### Report Limits
To keep responses manageable, the tool limits certain sections:
- Top 20 suspicious transactions (currency issues)
- Top 20 non-unique transaction IDs
- Top 20 suspicious categorizations
- Full list of unresolved categories (no limit)

### Detection Logic

**Unresolved Categories:**
- Category ID with no mapping in our database
- IDs that look like random strings (20+ chars)
- Numeric IDs without known mappings

**Currency Issues:**
- Amounts >$1,000 with foreign merchant indicators
- Very round numbers (divisible by 1000) with foreign merchants
- Merchant names containing foreign city names or country codes

**Suspicious Categorizations:**
- Pattern matching against common merchant names
- Known incorrect category assignments
- Based on real-world data quality feedback

---

## Support

### If You Find Issues Not Detected

Please report false negatives to help improve the tool:
- What issue did you find manually?
- What merchant/category was involved?
- Why wasn't it detected?

### If You Get False Positives

The tool errs on the side of flagging potential issues. If something is flagged incorrectly:
- Verify it's actually correct in your records
- Ignore the flag if you're confident
- Consider if the categorization could be clearer

---

## Example Complete Workflow

```
User: "Check my data quality for the last 90 days"

Claude: [Runs get_data_quality_report]

Claude: "I found 23 data quality issues in your last 90 days:

1. **Currency Issues** (12 transactions): Several Chilean
   transactions show suspiciously large amounts. For example,
   'Pronto Pte Rest SANTIAGO' shows $2,969.96 - this might
   actually be 2,970 Chilean Pesos (~$3.30 USD).

2. **Suspicious Categories** (8 transactions):
   - Uber rides categorized as 'Parking'
   - Farmacia (pharmacy) as 'Office Supplies'

3. **Unresolved Categories** (3 different category IDs
   affecting 250+ transactions): These show as IDs instead
   of readable names.

I recommend fixing the currency issues first as they
significantly inflate your spending totals."

User: "Thanks! I'll fix those in Copilot Money."
```

---

## Version History

**v1.1.0** (2026-01-12)
- Initial release of data quality report tool
- Detects 5 major categories of issues
- Comprehensive reporting with examples

---

**For more information, see:**
- [Main README](../README.md)
- [CHANGELOG](../CHANGELOG.md)
- [Issue Tracker](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues)
