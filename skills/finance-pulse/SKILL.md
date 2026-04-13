---
name: finance-pulse
description: "Use when the user asks how they're doing financially, wants a spending check-in, asks about free money or discretionary budget, or says 'pulse'. Read-only — never writes to Copilot Money."
---

# Finance Pulse

Give the user a 30-second financial check-in. One number, a few flags, prospective framing. Read-only — this skill never writes.

## Phase 1 — Gather Data

1. **Read the user profile.** Open `skills/user-profile.md`. If it doesn't exist, copy `skills/user-profile.template.md` to `skills/user-profile.md` first. Note:
   - Income & Obligations (if populated): monthly income, rent, fixed costs
   - Savings & Goals: targets and active goals
   - Irregular Expenses: amortized monthly reserve
   - Preferences: what not to flag, categories they care about
   - Communication Style: detail level, tone, framing
   - If Income & Obligations is empty, this is a first run — Phase 2 will handle bootstrapping.

2. **Pull data.** Use these MCP tools in parallel:
   - `get_accounts` — all accounts with balances (for net worth and available cash)
   - `get_transactions` with `period: "this_month"`, `exclude_transfers: true` — current month spending
   - `get_transactions` with `period: "last_month"`, `exclude_transfers: true` — last month for comparison
   - `get_transactions` with `period: "last_90_days"`, `exclude_transfers: true` — for rolling averages
   - `get_categories` with `view: "list"`, `period: "this_month"` — category spending this month
   - `get_categories` with `view: "list"`, `period: "last_90_days"` — category spending for 90-day baseline
   - `get_recurring_transactions` with `period: "last_90_days"` — subscriptions and recurrings
   - `get_budgets` with `active_only: true` — any budgets the user set
   - `get_goals` with `active_only: true` — savings goals

   Paginate `get_transactions` if needed (100 per page). Use `limit` and `offset`.

3. **Handle large datasets.** Transaction data will be large. Do NOT try to hold all transactions in your context. Instead:
   - Use Python via Bash for all aggregations, grouping, and arithmetic
   - Save transaction data to temp files and process with Python scripts
   - Only bring summary statistics back into your context for presentation

## Phase 2 — Compute Financial State

### 2.1 Bootstrap (first run only)

If `skills/user-profile.md` has empty Income & Obligations section, bootstrap it:

1. **Detect income.** Use Python to scan the 90-day transaction data for recurring credits (negative amounts) from the same source. Look for:
   - Payroll deposits: same source, similar amounts, biweekly or monthly cadence
   - Other regular income: dividends, side income, etc.
   - Present findings to user: "I see biweekly deposits of ~$X from [source]. Is this your primary income?"
   - Calculate monthly income (biweekly × 26/12, monthly × 1)

2. **Detect fixed obligations.** From recurring transactions, identify:
   - Rent/mortgage (largest recurring, often labeled)
   - Utilities (ISP, phone, electricity — check user profile Cleanup Preferences for known merchants)
   - Insurance, loan payments
   - Present: "I found these fixed monthly costs: [list]. Anything missing or wrong?"

3. **Detect account roles.** From `get_accounts`:
   - Primary checking: highest-activity depository account
   - Savings: depository accounts with low transaction volume
   - Credit cards: list with recent activity level
   - Present: "Your primary checking appears to be [name]. Savings in [name]. Cards: [list]. Right?"

4. **Detect irregular expenses.** Pull a separate 13-month transaction window (NOT the 90-day window used for trends — annual charges need a full year to detect). Scan for:
   - Annual/semi-annual charges (large one-off amounts from merchants that appear yearly — e.g., car insurance, Amazon Prime annual, domain renewals)
   - Known irregular categories: car maintenance, medical, insurance premiums
   - Amortize detected amounts to monthly: annual ÷ 12, semi-annual ÷ 6
   - Present: "I found these irregular expenses: [list]. Monthly reserve: ~$X"

5. **Save to profile.** After user confirms, update the relevant sections of `skills/user-profile.md`. On subsequent runs, skip bootstrapping and read the profile directly.

### 2.2 Compute Free Money

Use Python via Bash for all arithmetic. The formula:

```
Free Money = Net Monthly Income
           − Fixed Obligations (rent, utilities, insurance, loans)
           − Savings Target (from goals or profile)
           − Amortized Irregular Expenses (sinking fund reserve)
           − Already Spent This Month (non-fixed, non-savings spending)
```

Steps:
1. Sum fixed obligations from profile (or detected in bootstrap)
2. Sum savings targets from `get_goals` or profile
3. Sum amortized irregular expenses from profile
4. Sum this month's discretionary spending (total spending minus fixed obligations minus savings contributions)
5. Free Money = Net Income − Fixed − Savings − Irregular − Already Spent

Also compute:
- **Days remaining in month** (today through end of month)
- **Daily discretionary budget** = Free Money ÷ days remaining
- **Runway** = Free Money ÷ (average daily discretionary spend from last 90 days)

### 2.3 Category Trends

Use Python to compare this month's spending by category against 90-day rolling monthly averages:

- For each category with spending this month:
  - Calculate 90-day monthly average (total ÷ 3)
  - Calculate current month pace: (amount spent ÷ days elapsed) × days in month
  - Flag if projected spending exceeds average by threshold:
    - Stable categories (utilities, rent, insurance): >20% above average AND >$25 absolute increase
    - Medium variance (groceries, gas, healthcare): >50% above average AND >$25 absolute increase
    - High variance (dining, entertainment, shopping, travel): >100% above average AND >$50 absolute increase
  - Classify each category's variance tier by checking its historical coefficient of variation (std dev / mean):
    - CV < 0.2 → stable
    - CV 0.2-0.5 → medium
    - CV > 0.5 → high variance

### 2.4 Subscription & Recurring Check

From `get_recurring_transactions`:
- Sort by cost (highest first)
- Flag any that missed their expected date by 7+ days (possible cancellation or billing issue)
- Flag price drift: amount changed >5% for charges <$50, >3% for $50-200, >2% for >$200
- Flag any new recurring detected that isn't in the Copilot subscriptions list

### 2.5 Anomaly Scan

Scan this month's transactions for:
- **Unknown merchants:** Merchants that don't appear in the 90-day history at all (first-time charges)
- **Potential duplicates:** Same merchant + same amount within 24 hours (flag if ≥2 for large purchases, ≥3 for small <$10)
- **Unusually large charges:** Single transactions >2x the merchant's historical average amount

Prioritize using 3-tier system:
- **Tier 1 (always surface):** Potential duplicates, recurring price increases, missed recurring cycles
- **Tier 2 (selective — include if <5 total flags):** Unknown merchants >$20, budget overspend
- **Tier 3 (digest only — mention briefly if at all):** Category spending spikes, dormant category reactivation

## Phase 3 — Present

**Tone:** Match `skills/user-profile.md` Communication Style. Default: blunt, simple, dollar amounts.

**Structure — always this order:**

### The Number

Open with the Free Money figure, framed prospectively:

> **You have $X left to spend this month.** That's $Y/day for the next Z days.

If runway is notably short or long, add context:
- Runway < 7 days: "That's tight — you'll need to coast."
- Runway > 30 days: "You're well ahead of pace."
- Runway 7-30 days: no extra comment needed.

If this is the first run (bootstrap happened), frame it as: "Based on what I can see, here's where you stand:" and note that the numbers will get more accurate over time.

### Flags (3-5 max)

Present Tier 1 flags first, then Tier 2 if room. Each flag is one sentence:

- Category spike: "Dining is on pace for $X this month — that's 2x your usual $Y."
- Missed recurring: "Your Spotify charge ($9.99) is 10 days overdue. Cancelled or billing issue?"
- Price drift: "Netflix went from $15.49 to $22.99 this month."
- Duplicate: "Two identical $47.23 charges at Target on April 5 — intentional?"
- Unknown merchant: "First-time charge: $89.00 from 'ACME CORP' on April 8."
- Budget overspend: "Groceries budget ($400): $380 spent with 18 days left."

**Framing rules:**
- Prospective, not retrospective: "You have $X left for dining" not "You spent $X on dining"
- Dollar amounts, not percentages (unless user profile says otherwise)
- Name the merchant/category specifically
- If no flags worth surfacing: "Nothing unusual this month. You're on track."

### Quick Stats (optional — only if user profile detail level is "moderate" or "detailed")

If the user wants more detail, append:
- Top 5 spending categories this month with amounts and vs. average
- Subscriptions total: $X/month across N services
- Net worth snapshot: $X (assets $Y − liabilities $Z)

**Cap total output.** The entire pulse should fit in one screen — roughly 10-15 lines for "simple" detail level, up to 25 for "detailed". If you have more than 5 flags, pick the highest-priority ones.

## Phase 4 — Update Profile

After presenting, silently check if any profile sections should be updated:

- If Free Money components were computed for the first time, save them (this was handled in bootstrap)
- If new recurring merchants were detected, note them in profile under Preferences if user confirms
- Update any stale numbers (e.g., income changed, new fixed obligation detected)

**Do not ask the user about profile updates during pulse.** Pulse is a quick check-in. If profile needs significant updates, suggest: "Your profile might be out of date — want to run a quick update?"

## Rules

1. **Read-only.** This skill never writes to Copilot Money. No `set_*`, no `create_*`, no `review_*` calls.
2. **3-5 flags max.** Never dump 15 findings. Pick the most important ones. Alert fatigue kills usefulness.
3. **Prospective framing.** Always "you have $X left" not "you spent $X". Restore the pain of paying.
4. **Use Python for math.** All aggregations, averages, projections via Bash with Python. No mental math on >10 numbers.
5. **One screen.** The entire output should fit on one screen. If it doesn't, cut the least important parts.
6. **Respect profile.** Don't flag spending the user said to ignore. Don't flag categories they don't care about.
7. **Show full merchant names.** When referencing a transaction, use the full `name` or `original_name`, not the truncated `normalized_merchant`.
8. **First run is special.** If profile is mostly empty, spend time bootstrapping — ask the user to confirm detected income, obligations, and account roles before computing Free Money. This is a one-time cost for accuracy.
9. **Scheduled runs are silent.** When triggered by a schedule (not interactive), output the pulse as a report without asking questions. Use whatever profile data is available. Note any profile gaps as "could not compute X — profile missing Y."
