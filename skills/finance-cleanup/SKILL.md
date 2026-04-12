---
name: finance-cleanup
description: "Use when the user wants to clean up transactions, fix categories, find missing recurring charges, or do general transaction hygiene in Copilot Money."
---

# Finance Cleanup

Walk the user through a structured cleanup of their Copilot Money transaction data. You have access to MCP tools for reading and writing Copilot Money data. This is a multi-phase process: gather, detect, present, fix, update profile, summarize.

## Phase 1 — Gather Data

1. **Read the user profile.** Open `skills/user-profile.md` and note any existing preferences, especially under "Cleanup Preferences" and "Preferences." These override your judgment — if the profile says "Uber Eats = Dining," never flag Uber Eats as miscategorized.

2. **Ask about scope.** Before pulling data, ask the user:
   - Full cleanup or focused? (e.g., "just recurrings" or "just uncategorized")
   - Any specific date range? Default to last 6 months.
   - Any accounts to skip?

3. **Pull data.** Use these MCP tools:
   - `get_transactions` — unreviewed transactions (set `reviewed: false`)
   - `get_transactions` — last 6 months of all transactions (for historical patterns)
   - `get_recurring_transactions` — current recurring charges
   - `get_categories` — full category list
   - `get_accounts` — to map account IDs to names

   Run all reads before any analysis. Cache the results mentally — you will cross-reference heavily.

## Phase 2 — Detect Issues

Work through each detection pass. Use Bash with Python for any arithmetic on large transaction sets (aggregations, frequency analysis, statistical checks). Do not attempt mental math on more than ~10 numbers.

### 2.1 Miscategorized Transactions

For each merchant that appears 3+ times in the 6-month history:
- Count how many times each category was used for that merchant.
- If a transaction's category differs from the merchant's dominant category (used >80% of the time), flag it.
- **Exception:** If the user profile lists an explicit category preference for that merchant, use the profile's category as ground truth instead of the statistical mode.
- **Exception:** If a transaction has been manually reviewed and recategorized by the user (reviewed = true with a non-default category), treat it as intentional — do not flag.

### 2.2 Misclassified Transfers

Two directions to check:

**False transfers (marked Internal Transfer but probably not):**
- Transaction category is "Internal Transfer" or similar transfer category.
- The merchant name is a recognizable business (not a bank/brokerage name).
- No matching opposite-sign transaction of the same amount exists within 48 hours across any account.

**Missing transfers (should be Internal Transfer but are not):**
- Two transactions with the same absolute amount, opposite signs, within 48 hours, across different accounts.
- Neither is categorized as a transfer.

### 2.3 Missing Recurring Charges

Scan the 6-month transaction history for merchants appearing 3+ times at regular intervals:
- Intervals should be 28-31 days apart, with a tolerance of +/-3 days.
- Compare against existing recurrings from `get_recurring_transactions`. Skip merchants already tracked.
- **Price drift:** Flag if amount varies >5% for charges under $50, or >3% for charges between $50-$200, or >2% for charges over $200.
- **Missed cycles:** If the most recent occurrence is 7+ days past the expected next date, flag as potentially cancelled or missed.

### 2.4 Quick Wins

- **No category:** Transactions with no category assigned.
- **Old unreviewed:** Unreviewed transactions older than 90 days.
- **Duplicates:** Same merchant + same amount within 24 hours. Allow 2-3 occurrences for common small purchases (coffee shops, transit, parking) before flagging.

## Phase 3 — Present Findings

**Tone:** Be blunt and direct. Talk like a friend reviewing a bank statement, not a financial advisor writing a report.

Examples of good phrasing:
- "You've been paying $15/month for Hulu since 2024 — are you actually watching it?"
- "Uber Eats keeps getting filed as Transportation. You've corrected this 47 times. Want me to fix all 3 new ones to Dining?"
- "There's a $4.99 charge from 'AAPL.COM/BILL' every month that isn't in your recurrings. Probably iCloud storage."
- "Two $500 transfers between your checking and savings on March 3rd aren't marked as transfers. Want me to fix that?"

**Presentation rules:**
- Group findings by type (miscategorized, transfers, recurrings, quick wins).
- Present in batches of 3-5 items at a time. Do not dump 40 findings at once.
- For each item, state: what's wrong, what you'd change, and why.
- Wait for the user to approve, reject, or modify each batch before moving on.
- If you are uncertain about a finding, say so explicitly. "I'm not sure about this one — $12.99 from 'SP * SOMETHING' could be Spotify or a Shopify purchase."

**Never auto-approve. Never skip the presentation phase.**

## Phase 4 — Apply Fixes

Only after the user approves a batch:

- **Recategorize:** Use `update_transaction` for each transaction that needs a category change. Set the correct `categoryId`.
- **New recurrings:** Use `create_recurring` for merchants the user confirms as recurring.
- **Mark reviewed:** Use `review_transactions` to mark cleaned-up transactions as reviewed.
- **Transfer fixes:** Use `update_transaction` to change category to/from Internal Transfer.

After each batch of writes:
- Confirm what was changed: "Done — recategorized 3 Uber Eats transactions to Dining, marked 5 old transactions as reviewed."
- If any write fails, report the error and move on. Do not retry silently.

## Phase 5 — Update Profile

After all fixes are applied, update `skills/user-profile.md` with any new preferences learned during this session:

- New merchant-to-category mappings the user confirmed (under "Cleanup Preferences" or "Preferences").
- Any accounts the user said to always skip.
- Any categories the user said to never touch.
- Frequency preferences (e.g., "run cleanup monthly").

**Tell the user exactly what you are saving before writing.** Example: "I'm adding to your profile: 'Uber Eats = Dining', 'Skip Coinbase account for cleanup'. OK?"

## Phase 6 — Summary

End with a brief summary:
- How many transactions fixed, broken down by type (recategorized, new recurrings, marked reviewed, transfer fixes).
- Any items the user deferred or rejected — note them so they can revisit.
- Suggested next cleanup date based on transaction volume (e.g., "You get ~120 transactions/month — I'd run this again in 2-3 weeks").

## Rules

1. **Never write without asking.** Every write operation must be explicitly approved by the user first.
2. **Dry-run first.** Always present findings (Phase 3) before applying any fixes (Phase 4). No exceptions.
3. **Respect the profile.** `skills/user-profile.md` preferences override statistical analysis. If the profile says a merchant is categorized a certain way, do not flag it.
4. **Be honest about uncertainty.** If you cannot confidently identify a merchant or determine the right category, say so. Let the user decide.
5. **Use Bash with Python for math.** For aggregations, frequency calculations, or any arithmetic involving more than ~10 values, use Python via the Bash tool. Do not do mental math on large sets.
6. **Batch size.** Present 3-5 findings at a time. Never dump everything at once.
7. **No invented data.** Only reference transactions, merchants, and amounts that actually appear in the MCP tool results. Never fabricate examples.
