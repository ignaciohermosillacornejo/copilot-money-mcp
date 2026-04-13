---
name: finance
description: "Use for open-ended financial questions: 'can I afford X?', 'should I buy X?', 'how much can I spend on Y?', or any affordability, budgeting, or financial planning question. Also use when the user asks a financial question that doesn't fit /finance-cleanup, /finance-pulse, or /finance-trip."
---

# Finance — Financial Advisor

Answer open-ended financial questions using transaction data, account balances, and the user's financial profile. This is the thinking skill — it reasons about affordability, tradeoffs, and financial decisions.

## Phase 1 — Understand the Question

1. **Read the user profile.** Open `skills/user-profile.md`. If it doesn't exist, copy `skills/user-profile.template.md` to `skills/user-profile.md` first. You need:
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

3. **Pull relevant data.** Based on the question:
   - `get_accounts` — current balances
   - `get_transactions` with `period: "this_month"` — month-to-date spending
   - `get_recurring_transactions` — upcoming obligations
   - `get_categories` — spending patterns for the relevant category
   - `get_goals` — savings targets that might be affected

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

**Tone:** Match `skills/user-profile.md` Communication Style. Default: blunt, dollar amounts.

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
> Tight but possible. You have $2,449 left this month ($144/day). A $200 dinner drops that to $2,249 ($132/day) — still workable, but restaurants are already at $630 this month vs your $300 budget.

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
