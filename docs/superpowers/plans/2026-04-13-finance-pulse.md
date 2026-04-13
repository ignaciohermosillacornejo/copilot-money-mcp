# /finance-pulse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `/finance-pulse` skill that answers "how am I doing?" in 30 seconds — one "free money" number, a few actionable flags, prospective framing.

**Architecture:** A single skill prompt file at `skills/finance-pulse/SKILL.md` that orchestrates MCP read tools to compute financial state, compare against baselines, and surface 3-5 actionable items. No code changes to the MCP server — all intelligence lives in the skill prompt. The skill populates `user-profile.md` sections (Income & Obligations, Accounts, Irregular Expenses) on first run if empty, then uses cached profile data on subsequent runs.

**Tech Stack:** Skill prompt (markdown), MCP tools (read-only), Python via Bash (for arithmetic on large datasets)

---

## File Structure

```
skills/
├── finance-pulse/
│   └── SKILL.md              # The skill prompt — all logic lives here
├── user-profile.template.md   # Committed template — copied to user-profile.md on first run
├── user-profile.md            # Gitignored — auto-populated with personal data by skills
```

No new source files. No test files (skill is a prompt, tested by running it against real data with snapshots).

---

### Task 1: Create the Skill Prompt — Data Gathering Phase

**Files:**
- Create: `skills/finance-pulse/SKILL.md`

This task creates the skill file with frontmatter and Phase 1 (data gathering). The skill reads the user profile, pulls all necessary data from MCP tools, and prepares for analysis.

- [ ] **Step 1: Create the skill file with frontmatter and Phase 1**

```markdown
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
```

- [ ] **Step 2: Verify the file exists and frontmatter is valid**

Run: `head -5 skills/finance-pulse/SKILL.md`
Expected: frontmatter with name and description

- [ ] **Step 3: Commit**

```bash
git add skills/finance-pulse/SKILL.md
git commit -m "feat(skill): finance-pulse — Phase 1 data gathering"
```

---

### Task 2: Phase 2 — Bootstrap & Compute Financial State

**Files:**
- Modify: `skills/finance-pulse/SKILL.md`

This task adds the bootstrapping logic for first-run (detecting income, obligations, account roles) and the core "free money" computation.

- [ ] **Step 1: Append Phase 2 to the skill file**

Add after Phase 1:

```markdown
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
```

- [ ] **Step 2: Verify the appended content**

Run: `grep -c "Phase 2" skills/finance-pulse/SKILL.md`
Expected: Multiple matches (section headers)

- [ ] **Step 3: Commit**

```bash
git add skills/finance-pulse/SKILL.md
git commit -m "feat(skill): finance-pulse — Phase 2 compute financial state"
```

---

### Task 3: Phase 3 — Present & Phase 4 — Update Profile

**Files:**
- Modify: `skills/finance-pulse/SKILL.md`

This task adds the presentation layer (what the user actually sees) and profile maintenance.

- [ ] **Step 1: Append Phase 3 and Phase 4 to the skill file**

Add after Phase 2:

```markdown
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
```

- [ ] **Step 2: Verify complete skill structure**

Run: `grep "^## Phase" skills/finance-pulse/SKILL.md`
Expected:
```
## Phase 1 — Gather Data
## Phase 2 — Compute Financial State
## Phase 3 — Present
## Phase 4 — Update Profile
```

- [ ] **Step 3: Commit**

```bash
git add skills/finance-pulse/SKILL.md
git commit -m "feat(skill): finance-pulse — Phase 3 presentation and Phase 4 profile"
```

---

### Task 4: Register the Skill and Set Up Scheduled Trigger

**Files:**
- Modify: `skills/finance-pulse/SKILL.md` (no changes — just verify)

This task wires up the skill so it's discoverable and sets up the weekly scheduled trigger.

- [ ] **Step 1: Verify skill is discoverable**

The skill lives at `skills/finance-pulse/SKILL.md` with proper frontmatter. Claude Code auto-discovers skills from `skills/` directories. Verify:

Run: `head -4 skills/finance-pulse/SKILL.md`
Expected: frontmatter with `name: finance-pulse`

- [ ] **Step 2: Create the weekly scheduled trigger (MANUAL — requires human interaction)**

> **Note for agentic workers:** This step requires interactive `/schedule` invocation. Skip it during automated execution — flag it as a follow-up for the user.

Ask the user to invoke `/schedule` in Claude Code and configure:

- Name: `weekly-pulse`
- Schedule: Sunday at 6pm (user's local time)
- Command: Run `/finance-pulse` in read-only mode, output report
- Repository: current repo (copilot-money-mcp)

If the user prefers a different cadence or doesn't want scheduling yet, skip this step. The skill works perfectly as an on-demand `/finance-pulse` invocation.

- [ ] **Step 3: Commit any schedule configuration changes**

```bash
git add -A
git commit -m "feat(skill): register finance-pulse and configure weekly trigger"
```

---

### Task 5: Smoke Test with Real Data

**Files:**
- No file changes — this is a test run

- [ ] **Step 1: Create a safety snapshot**

```bash
bun run snapshot:create pre-pulse-test
```

- [ ] **Step 2: Run the skill interactively**

Invoke `/finance-pulse` in Claude Code. On first run, expect:
- Bootstrap: income detection, fixed obligations detection, account roles
- User confirms detected values
- Profile gets populated
- Free Money number computed and presented
- 3-5 flags surfaced
- Output fits one screen

- [ ] **Step 3: Verify profile was updated**

Check that `skills/user-profile.md` now has populated sections for:
- Income & Obligations
- Accounts
- Irregular Expenses (if any detected)

- [ ] **Step 4: Run again to test non-bootstrap path**

Invoke `/finance-pulse` again. This time:
- Should skip bootstrap (profile already populated)
- Should go straight to computation and presentation
- Should be faster than first run

- [ ] **Step 5: Note any issues for iteration**

If the skill needs adjustments based on real data:
1. Restore snapshot: `bun run snapshot:restore pre-pulse-test`
2. Edit `skills/finance-pulse/SKILL.md`
3. Re-run and iterate

- [ ] **Step 6: Final commit with any adjustments**

```bash
git add skills/finance-pulse/SKILL.md skills/user-profile.md
git commit -m "fix(skill): finance-pulse adjustments from smoke test"
```

---

## Spec Coverage Check

| Spec Requirement | Task |
|---|---|
| "Free money" number | Task 2 (2.2) |
| Category spending vs 90-day rolling averages with variance thresholds | Task 2 (2.3) |
| New charges that don't match known patterns (anomalies) | Task 2 (2.5) |
| 3-tier alert prioritization | Task 2 (2.5) |
| Subscriptions sorted by cost, missed dates, price drift | Task 2 (2.4) |
| Runway calculation | Task 2 (2.2) |
| Prospective framing | Task 3 |
| 3-5 actionable items max | Task 3 |
| Respect user-profile.md preferences | Task 1 (read), Task 3 (rules) |
| Read-only — never writes to Copilot Money | Task 3 (rules) |
| Scheduled weekly trigger (Sunday evening) | Task 4 |
| Profile bootstrapping (income, obligations, accounts) | Task 2 (2.1) |
| Use Python for arithmetic | Task 1, Task 2, Task 3 (rules) |
| Full merchant names | Task 3 (rules) |
