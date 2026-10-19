---
name: finance-pulse
description: "Use when the user asks how they're doing financially, wants a spending check-in, asks about free money or discretionary budget, or says 'pulse'. Read-only — never writes to Copilot Money."
metadata:
  modes: "live, cache"
---

# Finance Pulse

## When to use

- The user asks how they're doing financially or wants a check-in
- The user asks about "free money" or discretionary budget
- The user says "pulse" or asks for a spending summary

## Do NOT use if

- The user wants a specific affordability decision → use `/finance`
- The user wants to fix categories or clean transactions → use `/finance-cleanup`

Give the user a 30-second financial check-in. One number, a few flags, prospective framing. Read-only — this skill never writes.

## Phase 1 — Gather Data

1. **Read the user profile** at `~/.claude/copilot-money/user-profile.md`. If the file doesn't exist: run `mkdir -p ~/.claude/copilot-money`, then copy `skills/user-profile.template.md` (relative to the copilot-money-mcp repo root) to the profile path. First-time bootstrap may require CWD = repo root for the template read. Note:
   - Income & Obligations (if populated): monthly income, rent, fixed costs
   - Savings & Goals: targets and active goals
   - Irregular Expenses: amortized monthly reserve
   - Preferences: what not to flag, categories they care about
   - Communication Style: detail level, tone, framing
   - If Income & Obligations is empty, this is a first run — Phase 2 will handle bootstrapping.

2. **Check the mode, then pull data.** The server runs in one of two modes, and the tool names differ. If the tool list has `get_transactions_live` (live), you are in live mode — always the case when write tools are on. If it has `get_transactions` (cache) instead, you are in cache mode. Each step below names the tool for each mode; call only the one for your mode. Run these in parallel:
   - Accounts with balances (net worth, available cash): `get_accounts_live` (live) / `get_accounts` (cache).
   - Transactions for three windows: `get_transactions_live` (live) / `get_transactions` (cache), each with `exclude_transfers: true` and one of `period: "this_month"`, `period: "last_month"`, `period: "last_90_days"`. Both tools take these arguments.
     - In live mode also pass `fields: ["default", "type", "recurring_id"]` to `get_transactions_live` (live): `type` is how 2.2 keeps REGULAR rows only, and `recurring_id` is what the 2.5 price-drift check groups by. Neither is in the default row.
     - In cache mode no `fields` argument is needed on `get_transactions` (cache): the default row has what this skill computes from it (amounts, category names, merchant names, dates).
   - The category list (names, and which categories are excluded): `get_categories_live` (live) / `get_categories` (cache). Per-category spending is computed from the transaction rows (2.2, 2.4), not read from this tool, so the figure is the same in both modes.
   - Recurring charges, live mode: `get_recurring_live` (live), default rows. These carry `state`, `nextPaymentDate` and `nextPaymentAmount` but no charge history: their `payments` holds only the next payment.
   - Recurring charges, cache mode: `get_recurring_transactions` (cache) with `period: "last_90_days"` and `fields: ["default", "transactions"]`. The `fields` argument is what the cache-mode price-drift check in 2.5 reads: the matched per-charge `transactions` array is not in the default row.
   - This month's unpaid bills, live mode: `get_upcoming_recurrings_live` (live). Needed for the "spent this month" figure in 2.2; see the caveat there about its horizon.
   - Budgets, live mode: `get_budgets_live` (live) with `months_window: 1`. Only the current month is needed, and the default returns 12 months per budget.
   - Budgets, cache mode: `get_budgets` (cache) with `active_only: true`.
   - Savings goals: `get_goals` with `active_only: true` (both modes).

   Transaction reads return 100 rows per page; page through with `limit` and `offset` until a page comes back short.

3. **Handle large datasets and do all math via Python.** Transaction data will be large. Do NOT try to hold all transactions in your context, and do NOT do mental math on more than ~10 numbers. Instead:
   - Use Python via Bash for ALL aggregations, averages, projections, grouping, and arithmetic
   - Save transaction data to temp files and process with Python scripts
   - Only bring summary statistics back into your context for presentation

## Phase 1.5 — Profile Freshness Check

Run this BETWEEN Phase 1's read and Phase 2's compute. It catches the common case where the profile was bootstrapped months ago and the underlying numbers (income, fixed obligations, account roles) have drifted.

1. **Parse `last_verified` from each profile section's HTML comment.** Sections to check:
   - `## Income & Obligations`
   - `## Irregular Expenses (Sinking Funds)`
   - `## Accounts`

   `## Savings & Goals` is intentionally NOT in this list — the savings target comes live from `get_goals` each session, so there's no stale-profile concern. The template doesn't carry a `last_verified` stamp for that section.

   Each section has a comment of the form `<!-- last_verified: YYYY-MM-DD -->` or `<!-- last_verified: never -->`. Extract the date.

2. **Read `staleness_threshold_days` from `## Preferences`.** It's stored as a comment of the form `<!-- staleness_threshold_days: <N> ... -->` — extract the first integer after the colon (any trailing text is human-readable documentation only). Default to `90` if the comment is absent or the value can't be parsed.

3. **For each section older than the threshold (or with `last_verified: never`):**

   - **Interactive mode (default):** Prompt the user once, listing every stale section at once. For each section, format the freshness clause based on the stamp:
     - `last_verified: never` → "never verified"
     - valid date → "last verified [N] days ago" (where N is today minus the stamp date)

     Example prompt: "Your profile sections are stale: [Income & Obligations] last verified 142 days ago; [Accounts] never verified. Re-bootstrap? [y/skip]". A single y/skip applies to all stale sections.
   - **Scheduled mode (per Rule "Scheduled runs are silent"):** Skip the prompt; tag each stale section for the Phase 3 warning prefix and proceed.

4. **If the user picks `y`:** run only the bootstrap subflow for each stale section (the corresponding step from Phase 2.1: step 1 for Income, step 2 for Obligations, step 3 for Accounts, step 4 for Irregular Expenses). Skip the bootstrap steps for non-stale sections. After each section's bootstrap saves to profile, also update its `<!-- last_verified: -->` comment to today's date in YYYY-MM-DD form.

5. **If the user picks `skip`:** proceed with stale data. Pass the list of stale section names + their `last_verified` dates to Phase 3 for warning output.

6. **If no sections are stale:** skip Phase 1.5 silently — no output.

## Phase 2 — Compute Financial State

### 2.1 Bootstrap (first run only)

If `~/.claude/copilot-money/user-profile.md` has empty Income & Obligations section, bootstrap it:

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

3. **Detect account roles.** From `get_accounts_live` (live) / `get_accounts` (cache):
   - Primary checking: highest-activity depository account
   - Savings: depository accounts with low transaction volume
   - Credit cards: list with recent activity level
   - Present: "Your primary checking appears to be [name]. Savings in [name]. Cards: [list]. Right?"

4. **Detect irregular expenses.** Pull a separate 13-month transaction window using `start_date` and `end_date` (e.g., `start_date: "2025-03-13"`, `end_date: "2026-04-13"` — there is no "last_13_months" period shorthand). This is NOT the 90-day window used for trends — annual charges need a full year to detect. Scan for:
   - Annual/semi-annual charges (large one-off amounts from merchants that appear yearly — e.g., car insurance, Amazon Prime annual, domain renewals)
   - Known irregular categories: car maintenance, medical, insurance premiums
   - Amortize detected amounts to monthly: annual ÷ 12, semi-annual ÷ 6
   - Present: "I found these irregular expenses: [list]. Monthly reserve: ~$X"

5. **Save to profile.** After user confirms, update the relevant sections of `~/.claude/copilot-money/user-profile.md`. For each section saved, also update its `<!-- last_verified: -->` HTML comment to today's date in YYYY-MM-DD form (this is what Phase 1.5 reads to decide if the section is stale). On subsequent runs, skip bootstrapping and read the profile directly.

### 2.2 Spent This Month (the app's figure)

Whenever you report what the user has "spent this month" (Quick Stats, a category total, "how much have I spent"), compute it the way the Copilot app does, so the number matches the one on their screen. Summing every `amount` does not: income rows are negative and net against all spending.

1. Take this month's transaction rows. Transfers and rows in excluded categories are already gone, since `exclude_transfers` and `exclude_excluded` default to true.
2. Keep spending rows only. Live mode: keep rows whose `type` is `REGULAR`, which drops `INCOME`. Cache mode: rows carry no type, so rely on step 3, which drops income because Copilot leaves income uncategorized (Rule 7).
3. Skip uncategorized rows (no `category_name`). The app does not count them.
4. Net per category: sum `amount` within each category, so a refund (negative) offsets a purchase in the same category. The sum over categories is the posted spend.
5. Add this month's still-unpaid recurring charges, overdue or upcoming, with a due date on or before the last day of the month. The app already counts them in each category's "spent" for the month.
   - Live mode: take them from `get_upcoming_recurrings_live` (live). It appears to return only bills due within about the next 14 days, so later in the month, add every `get_recurring_live` (live) row whose state is active and whose `nextPaymentDate` falls in this month, and drop duplicates by `id`. Use `nextPaymentAmount` for each.
   - Cache mode: use each recurring's `next_expected_date` and `average_amount` from `get_recurring_transactions` (cache) when the date falls in the rest of this month. This is an approximation: the cache has no "paid" flag. Say so if the figure matters.
   - For a month that has ended, this term is zero.

Spent this month = posted spend (step 4) + unpaid recurrings (step 5). Do the arithmetic in Python.

### 2.3 Compute Free Money

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
2. Sum savings targets from `get_goals` or profile. If `get_goals` returns 0 AND the profile has no savings target, set this term to 0 and note it for Phase 3 output: "No savings target set — Free Money doesn't reserve anything for savings."
3. Sum amortized irregular expenses from profile
4. Sum this month's discretionary spending: the posted spend from 2.2 step 4, minus the transactions that match fixed obligation merchants (by name/category). Leave out 2.2's unpaid-recurrings term here: unpaid fixed bills are already covered by the Fixed Obligations term. Do NOT subtract the profile's fixed amount — subtract the actual charges from those merchants. This ensures over-charges (e.g., rent higher than usual) are correctly captured rather than silently inflating Free Money.
5. Free Money = Net Income − Fixed − Savings − Irregular − Already Spent

Also compute:
- **Days remaining in month** (today through end of month)
- **Daily discretionary budget** = Free Money ÷ days remaining
- **Runway** = Free Money ÷ (average daily discretionary spend from last 90 days)

### 2.4 Category Trends

Use Python to compare this month's spending by category against 90-day rolling monthly averages. Compute each window's per-category totals from its transaction rows with 2.2 steps 1–4 (net per category, REGULAR rows, uncategorized skipped):

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

### 2.5 Subscription & Recurring Check

From the recurring rows pulled in Phase 1:
- Sort by cost (highest first): `nextPaymentAmount` in live mode, `average_amount` in cache mode.
- Flag any that missed their expected date by 7+ days (possible cancellation or billing issue): a `nextPaymentDate` (live) or `next_expected_date` (cache) 7 or more days in the past.
- Flag price drift: amount changed >5% for charges <$50, >3% for $50-200, >2% for >$200. This needs each recurring's charge history over the 90-day window.
  - Live mode: the recurring rows hold only the next payment, so take the history from the 90-day `get_transactions_live` (live) rows, which Phase 1 pulled with `fields: ["default", "type", "recurring_id"]`. Group them by `recurring_id`, match each group to its recurring by `id`, and compare the amounts in date order.
  - Cache mode: compare the per-charge amounts in each row's `transactions` array from `get_recurring_transactions` (cache), which Phase 1 requested with `fields: ["default", "transactions"]`.
  - If the history is missing, the check cannot run. Say so rather than inferring drift from a single amount.
- Cache mode only: `get_recurring_transactions` (cache) also detects recurring patterns Copilot is not tracking. Flag any that aren't in the Copilot subscriptions list. Live mode returns only the recurrings Copilot tracks, so skip this flag there.

### 2.6 Anomaly Scan

Scan this month's transactions for:
- **Unknown merchants:** Merchants that don't appear in the 90-day history at all (first-time charges)
- **Potential duplicates:** Same merchant + same amount within 24 hours (flag if ≥2 for large purchases, ≥3 for small <$10)
- **Unusually large charges:** Single transactions >2x the merchant's historical average amount

Prioritize using 3-tier system:
- **Tier 1 (always surface):** Potential duplicates, recurring price increases, missed recurring cycles
- **Tier 2 (selective — include if <5 total flags):** Unknown merchants >$20, budget overspend
- **Tier 3 (digest only — mention briefly if at all):** Category spending spikes, dormant category reactivation

## Phase 3 — Present

**Tone:** Match `~/.claude/copilot-money/user-profile.md` Communication Style. Default: blunt, simple, dollar amounts.

**Stale-data warning prefix (if Phase 1.5 flagged any stale sections that the user chose to skip).** Prepend the output with a warning block, then continue with The Number / Flags / Quick Stats as normal:

> ⚠️ Using stale profile data:
> - Income & Obligations: last verified [date] ([N] days ago)
> - Accounts: never verified
>
> Re-run with `re-bootstrap` if these numbers feel off.

Format each line based on the stamp value: a real date shows "[date] ([N] days ago)"; `never` shows "never verified".

Only include sections that were actually skipped — don't list every section unconditionally.

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
- Budget overspend: "Groceries has $20 of budget left with 18 days to go." (Say what is left, not "your $X budget": see Rule 9.)

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
3. **One screen.** The entire output should fit on one screen. If it doesn't, cut the least important parts.
4. **Respect profile.** Don't flag spending the user said to ignore. Don't flag categories they don't care about.
5. **First run is special.** If profile is mostly empty, spend time bootstrapping — ask the user to confirm detected income, obligations, and account roles before computing Free Money. This is a one-time cost for accuracy.
6. **Scheduled runs are silent.** When triggered by a schedule (not interactive), output the pulse as a report without asking questions. Use whatever profile data is available. Note any profile gaps as "could not compute X — profile missing Y."
7. **Income is intentionally uncategorized.** Income transactions (negative amounts) have no category on purpose. Never flag them as uncategorized or missing a category.
8. **Large datasets go to disk.** MCP tool responses >100KB are saved to temp files instead of returned inline. Use Python via Bash to process these files. The transaction, account and recurring reads in both modes return terse rows by default since v3.0.0 and are much smaller now (a 100-row transaction page measures ~28KB), so this is no longer routine — but a wide window, or a request that opts fat fields back in via `fields`, can still cross the threshold.
9. **Reference existing budgets, carefully.** The user may have budgets in Copilot Money: `get_budgets_live` (live) / `get_budgets` (cache). Use them to inform spending flags — if a category has a budget, flag when spending (2.2) exceeds or approaches it, not just when it exceeds the 90-day average. The amount Copilot returns for this month has rollover applied (in live mode it is `budget_amount` on `get_categories_live` (live)), so it is not the figure the user set: it can be far above it, or negative after an overspent month. Never phrase it as "your $X budget". Say what is left ("$20 left in Groceries this month"), and skip a budget whose amount is zero or negative rather than reporting it.
