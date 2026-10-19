---
name: finance
description: "Use for open-ended financial questions: 'can I afford X?', 'should I buy X?', 'how much can I spend on Y?', or any affordability, budgeting, or financial planning question. Also use when the user asks a financial question that doesn't fit /finance-cleanup, /finance-pulse, or /finance-trip."
metadata:
  modes: "live, cache"
---

# Finance — Financial Advisor

## When to use

- Open-ended financial questions: "can I afford X?", "should I buy X?", "how much can I spend on Y?"
- Affordability checks for any purchase amount, from coffee to a car
- Any financial reasoning question that doesn't fit a more specific skill

## Do NOT use if

- The user wants a status check or check-in → use `/finance-pulse`
- The user wants to categorize, fix, or clean transactions → use `/finance-cleanup`
- The user wants to track a trip's expenses → use `/finance-trip`
- The user wants to reconcile Amazon orders against transactions → use `/amazon-sync`

Answer open-ended financial questions using transaction data, account balances, and the user's financial profile. This is the thinking skill — it reasons about affordability, tradeoffs, and financial decisions.

## Phase 1 — Understand the Question

1. **Read the user profile** at `~/.claude/copilot-money/user-profile.md`. If the file doesn't exist: run `mkdir -p ~/.claude/copilot-money`, then copy `skills/user-profile.template.md` (relative to the copilot-money-mcp repo root) to the profile path. First-time bootstrap may require CWD = repo root for the template read. You need:
   - Income & Obligations (for Free Money calculation)
   - Savings & Goals
   - Irregular Expenses
   - Account roles (which account pays for what)

   If the profile is mostly empty, suggest: "I need some baseline numbers to answer this well. Want to run `/finance-pulse` first to set up your profile?"

2. **Classify the question by magnitude:**
   - **Small (<$50):** Quick check. One sentence answer.
   - **Medium ($50-500):** Budget context. Does it fit in Free Money?
   - **Large ($500-5K):** Full dual-check (budget + cash flow) + tradeoff analysis.
   - **Major (>$5K):** Multi-month projection, impact on savings goals, seasonal context.

3. **Check the mode, then pull relevant data.** The tool names differ by server mode. If the tool list has `get_transactions_live` (live), you are in live mode — always the case when write tools are on. If it has `get_transactions` (cache) instead, you are in cache mode. Call only the tool for your mode. Based on the question:
   - Current balances: `get_accounts_live` (live) / `get_accounts` (cache).
   - Month-to-date spending: `get_transactions_live` (live) / `get_transactions` (cache) with `period: "this_month"`. The default terse row carries what this skill reasons about (`amount`, `date`, `name`, `category_name`).
     - In live mode add `fields: ["default", "type"]` to `get_transactions_live` (live), so the spend recipe in 2.1 can keep REGULAR rows only.
     - In cache mode add `fields: ["default", "original_name"]` to `get_transactions` (cache) when you are going to SHOW transactions: Rule 6 asks for the full merchant name, and `original_name` is not in the default row. Live rows have no such field; show `name`.
   - Upcoming obligations: `get_upcoming_recurrings_live` (live) for bills due soon and `get_recurring_live` (live) for the full list, or `get_recurring_transactions` (cache).
   - The category list, for the category the question is about: `get_categories_live` (live) / `get_categories` (cache). Compute the category's spending from the transaction rows (2.1), not from this tool.
   - Savings targets that might be affected: `get_goals` (both modes).

## Phase 2 — Analyze

### 2.1 Budget Check

Does the purchase fit within Free Money?

```
Free Money = Net Monthly Income
           − Fixed Obligations
           − Savings Target
           − Amortized Irregular Expenses
           − Already Spent This Month (actual merchant charges, not profile estimates)
```

Use the same computation as `/finance-pulse`. If the profile has these numbers, use them. If not, compute from transaction data using Python via Bash.

**"Spent this month" must match the app.** When you quote what the user has spent this month, in total or for a category, use `/finance-pulse` section 2.2, which is how the Copilot app computes it. Summing every `amount` is wrong, because income rows are negative. In short:
1. Take this month's rows. Transfers and excluded-category rows are already dropped by default. In live mode a row the user excluded individually, in a category that is not excluded, cannot be filtered out (the API has no per-transaction exclusion flag), so the live total can run slightly high.
2. Keep spending rows only: `type` is `REGULAR` in live mode. In cache mode rows have no type, and skipping uncategorized rows drops income.
3. Skip uncategorized rows.
4. Net the amounts within each category, so refunds offset purchases.
5. Add this month's still-unpaid recurring bills. In live mode, take them from `get_upcoming_recurrings_live` (live). It appears to cover only about the next 14 days, so also add the `get_recurring_live` (live) rows whose `nextPaymentDate` falls later in this month, and drop duplicates by `id`. For a month that has ended, this term is zero.

Skipping step 5 under-reports by exactly the unpaid bills, which is the gap the app's figure shows. For Free Money's "Already Spent" term, use steps 1–4 only: unpaid fixed bills are already in Fixed Obligations.

### 2.2 Cash Flow Check (for Large and Major only)

Will account balances stay above a safe buffer after the purchase clears?

1. Start with current checking balance
2. Add expected income before the purchase date (next payroll deposit)
3. Subtract known upcoming obligations (rent, credit card autopays, recurring charges due before the purchase date)
4. Subtract the purchase amount
5. Check: is the remaining balance above a safe buffer? (10% of monthly income for stable income, 20% for variable)

If budget check says "yes" but cash flow says "no" (or vice versa), explain the contradiction:
- "You have room in your budget, but your checking balance would dip to $X after this clears — that's below your $Y buffer. Wait until after your next paycheck on [date]."
- "Your checking can handle it right now, but it would eat your entire remaining discretionary budget for the month."

### 2.3 Tradeoff Analysis (for Large and Major only)

What would the user need to give up or adjust?

- "You'd need to cut dining by $X/week for the rest of the month"
- "This would use 60% of your remaining Free Money — you'd have $Y/day for the next Z days"
- "This is equivalent to 3 months of your Netflix subscription"

Scale the comparison to something relatable. Don't just show numbers — show what they mean.

### 2.4 Risk Flags

Proactively flag relevant context:
- **Upcoming irregular expenses:** "Your car insurance renewal ($X) is due next month"
- **Seasonal spending:** October-December → holiday spending ahead. Summer → utility spikes.
- **Variable income:** If income type is variable, use conservative (25th percentile) baseline and say so explicitly.
- **Credit card timing:** If paying by credit card, note the float — "Charged today, you have until [statement date] before it hits your checking"
- **Recent large expenses:** "You already spent $X on [category] this month, which is 2x your average"

## Phase 3 — Present

**Tone:** Match `~/.claude/copilot-money/user-profile.md` Communication Style. Default: blunt, dollar amounts.

**Never give binary yes/no.** Always present:

1. **Signal:** One of three levels:
   - "Comfortably affordable" — fits in budget AND cash flow, no tradeoffs needed
   - "Tight but possible" — fits but requires adjustment or awareness
   - "Would create strain" — doesn't fit without significant changes

2. **Key number:** The most important figure for the decision:
   - "You'd have $X left for the rest of the month" (remaining Free Money after purchase)
   - "Your daily budget would drop from $X to $Y" (impact on pace)

3. **Tradeoffs** (if any): What adjustments would be needed.

4. **Risk flags** (if any): Context that might change the decision.

**Scaling output to magnitude:**
- **Small:** One sentence. "That's fine — you have $X in Free Money this month."
- **Medium:** 2-3 sentences. Signal + key number + one tradeoff if relevant.
- **Large:** Full analysis. Signal + key number + tradeoffs + risk flags. ~10 lines.
- **Major:** Full analysis + multi-month projection + savings impact. Up to 20 lines.

### Examples of good responses:

**Small ($30 book):**
> That's fine. You have $2,449 left this month — $144/day for 17 days. A $30 book barely moves the needle.

**Medium ($200 dinner):**
> Tight but possible. You have $2,449 left this month ($144/day). A $200 dinner drops that to $2,249 ($132/day) — still workable, but you've already spent $630 on restaurants this month, about twice your usual.

**Large ($1,500 weekend trip):**
> Would create strain. You have $2,449 in Free Money this month. A $1,500 trip would leave $949 for the remaining 17 days ($56/day vs your usual $187/day pace).
>
> Your next paycheck ($4,611) lands around Apr 17, which helps — but your rent ($3,142), credit card autopays, and subscriptions will eat most of it.
>
> If you want to do this: push discretionary spending to near-zero for the rest of April, and you'll be fine by May 1.

## Phase 4 — Follow-up

If the user asks "what if" variations, re-run the analysis with the new parameters. Keep the conversation flowing — don't re-pull all data unless the question changes significantly.

If the question reveals new financial context (e.g., "I'm getting a raise next month"), offer to update the profile: "Want me to update your income in the profile?"

## Rules

1. **Read-only.** This skill never writes to Copilot Money. It reads data and reasons about it.
2. **Never binary yes/no.** Always signal + key number + context.
3. **Pre-compute, don't interrogate.** Use profile and transaction data to compute answers. Confirm assumptions ("I see you earn ~$X/month — is that right?") rather than asking the user to provide numbers.
4. **Use Python for math.** All arithmetic via Bash with Python. No mental math on >10 numbers.
5. **Scale depth to magnitude.** A $30 purchase doesn't need a 20-line analysis.
6. **Show full merchant names.** Always `name` or `original_name`, never truncated.
7. **Explicit about limitations.** "I'm working from your transaction history — I don't know about cash income, side gigs, or expenses paid outside these accounts."
8. **Not financial advice.** If the question ventures into investment advice, tax strategy, or legal territory, say: "This is data-informed reasoning, not certified financial advice. Talk to a professional for [specific topic]."
9. **Invoke sub-skills when appropriate.** If the user's question would be better served by `/finance-pulse`, `/finance-cleanup`, or `/finance-trip`, suggest it. Don't try to replicate their functionality.
10. **Income is intentionally uncategorized.** Income transactions (negative amounts) have no category. This is by design — don't flag it.
11. **Large datasets go to disk.** MCP tool responses >100KB are saved to temp files. Use Python via Bash to process them — do not try to read them into context.
12. **Reference existing budgets, carefully.** The user may have budgets in Copilot Money: `get_budgets_live` (live) / `get_budgets` (cache). The amount Copilot returns for this month has rollover applied (in live mode it is `budget_amount` on `get_categories_live` (live)), so it is not the figure the user set: it can be far above it, or negative after an overspent month. Don't phrase it as "your $X budget is at $Y". If a budget is useful context, say what is left: "you have about $20 left in your restaurant budget this month". Skip a budget whose amount is zero or negative.
13. **No savings goals = no savings deduction.** If `get_goals` returns 0, Free Money doesn't reserve for savings. Flag this in affordability analysis: "Note: you have no savings target set, so this calculation doesn't protect any savings."
14. **Where reads come from depends on the mode.** In live mode, reads come from Copilot's API and are cached in memory for a while. If data looks stale, call `refresh_cache` (live). In cache mode, reads come from the local LevelDB cache that the Copilot Money app syncs, which can lag behind the app. If data looks stale, call `refresh_database` (cache), and if that does not help, ask the user to open the Copilot app so it syncs.
