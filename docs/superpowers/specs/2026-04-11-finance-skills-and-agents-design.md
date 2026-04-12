# Finance Skills & Agents Design

**Date:** 2026-04-11
**Status:** Approved
**Scope:** Skill architecture, testing infrastructure, scheduling, user profile, and deep research plan for building an intelligent financial agent layer on top of copilot-money-mcp.

## Design Philosophy

**Thin tools, fat agents.** The MCP server provides raw data access and writes. All intelligence — pattern detection, anomaly flagging, categorization reasoning, financial advice — lives in skill prompts. No middleware, no aggregation layer, no heuristic code. Agents are smart enough to reason over raw data if the tools expose it well.

**Blunt and concrete by default.** Skills talk like a financially literate friend, not a dashboard. "That's 4 hours of your after-tax work" over "$180 spent." "You've been paying $15/month for Hulu since 2024 — have you watched it?" over "Subscription detected: Hulu." Put things in simple, human terms that make the user *feel* the money. Then adapt — if the user asks for more detail or a softer tone, the skill records that preference in `user-profile.md` and adjusts going forward. No calculator tool — the agent does arithmetic inline or shells out to Python for anything complex.

## 1. Skill Architecture

Four skills, three focused workflows plus one orchestrator:

### `/finance-cleanup` — Transaction Hygiene

**Purpose:** Compress the current ~3-4 hour quarterly cleanup into a guided ~15-minute session.

**What it does:**
- Pulls all unreviewed transactions since the last cleanup
- Scans for likely miscategorizations by comparing each transaction's category against the merchant's historical category distribution (e.g., "Uber Eats categorized as Transportation — you've categorized Uber Eats as Dining 47 times before")
- Finds spend that looks recurring but isn't tracked in recurrings (e.g., "you've been charged $14.99 by iCloud every month for 6 months but it's not in your recurring list — want me to add it?")
- Flags transactions marked as internal transfers that look like real spend (and vice versa)
- Presents findings in batches, applies fixes via write tools with user approval
- Marks reviewed transactions as reviewed when confirmed
- Updates `user-profile.md` when user expresses category/merchant preferences

**Key principle:** Dry-run first. The skill does the detective work, presents findings with evidence, user approves/rejects. Never writes without asking.

### `/finance-pulse` — Situational Awareness

**Purpose:** Answer "how am I doing?" in 30 seconds.

**What it does:**
- Opens with a single "free money" number: what's truly available for discretionary spending right now (income minus obligations, savings targets, amortized irregular expenses, buffer)
- Compares current month spending by category against 90-day rolling averages, using variance-appropriate thresholds: >20% for stable categories (utilities), >50% for medium (groceries), >100% for high-variance (dining). Requires minimum $25-50 absolute increase to avoid noise.
- Lists new charges that don't match any known merchant or recurring pattern — potential anomalies. Uses 3-tier prioritization: always surface (fraud indicators, forgotten subs, duplicates), selective (unknown merchants), digest-only (spending spikes)
- Shows subscriptions/recurrings sorted by cost, flags any that missed their expected date by 7+ days (possible cancellation or billing issue), and flags price drift (>5% for <$50, >3% for $50-200)
- Calculates runway: total discretionary capacity / average daily discretionary spend = days remaining
- Frames everything prospectively: "You have $X left for dining this week" not "You spent $X on dining last month"
- Caps output to 3-5 actionable items max to avoid alert fatigue
- Respects user preferences from `user-profile.md` (e.g., don't flag small coffee purchases)

**Key principle:** Read-only. One number + a few actionable flags. Prospective framing, not retrospective reporting. Primary candidate for scheduled automation.

### `/finance-trip` — Trip Expense Tracking

**Purpose:** Track trip expenses without spreadsheets.

**What it does:**
- Takes a trip name and date range, finds all transactions in that window
- Uses location data and merchant types to suggest which transactions belong to the trip
- Lets user confirm/reject, then tags confirmed ones with the trip tag (creating the tag if needed)
- Can re-run on an existing trip tag to find stragglers (charges that posted late, forgot to tag)
- Shows running total by category (flights, hotels, food, activities, transport)
- References trip preferences from `user-profile.md`

**Key principle:** Date range + location + merchant type is the heuristic, but the user makes the final call on what's in vs. out.

### `/finance` — The Orchestrator

**Purpose:** Open-ended financial advisor for questions like "can I afford a weekend trip to Napa?"

**What it does:**
- Answers affordability questions using a dual-check model:
  1. **Budget check:** Does it fit within Free Money? (`Net Income − Fixed Obligations − Savings Target − Amortized Irregular Expenses − Committed Discretionary − Buffer`)
  2. **Cash flow check:** Will account balances stay above buffer threshold on the specific date(s) payment clears? Projects daily balances forward accounting for known income and expenses.
- Scales analysis depth by magnitude: small (<$50) gets a quick check, medium ($50-500) gets budget context, large ($500-5K) gets full dual-check + tradeoff analysis, major (>$5K) gets multi-month projection
- Never gives binary yes/no. Presents: signal (comfortably affordable / tight but possible / would create strain) + key number (remaining capacity after purchase) + tradeoffs ("you'd need to cut dining by $80/week for 3 weeks") + risk flags (variable income, upcoming irregular expenses, seasonal context)
- For variable income: uses 25th percentile of last 6 months as conservative baseline with explicit uncertainty language
- Accounts for credit card timing: knows statement closing dates, calculates float, flags when cash won't be available for full balance payment
- Flags seasonal context proactively (October → holiday spending ahead, summer → utility spikes)
- Pre-computes financial state and confirms with user rather than interrogating ("I see you earn ~$X/month and pay $Y in rent — is that right?")
- Can invoke sub-skill workflows when appropriate
- Explicit about being a data-informed assistant, not giving certified financial advice
- Uses `user-profile.md` extensively; updates it when user provides new financial context

**Key principle:** Affordability is a constraint-satisfaction problem, not a balance check. Always show the reasoning, never just the answer.

### Future: `/finance-invest`

Investment-focused skill for portfolio analysis, allocation drift, performance attribution. Not in scope now, but the MCP server already has rich investment data (holdings, prices, splits, TWR returns, performance) to support it.

## 2. User Finance Profile

### Location

```
skills/user-profile.md
```

### Structure

```markdown
# Financial Profile

## Income & Obligations
- Primary income: ~$X/month, deposited [frequency]
- Income type: [stable/variable] — if variable, conservative baseline uses 25th percentile of last 6 months
- Rent/mortgage: $X/month
- Other fixed obligations: [list with amounts]

## Savings & Goals
- Savings target: $X/month or X% of income
- Active savings goals: [list from Copilot goals]
- Emergency fund status: [adequate/building/nonexistent]

## Irregular Expenses (Sinking Funds)
- Annual/semi-annual payments detected from history: [auto-populated]
- Monthly amortized reserve: ~$X/month total
- Examples: car maintenance, insurance, holidays, medical, etc.

## Preferences
- Spending I don't want flagged: [e.g., daily coffee, small convenience store runs]
- Categories I care most about: [e.g., dining, travel, subscriptions]
- "Splurge" threshold: $X for a single discretionary purchase
- Buffer preference: [X% of income — default 10% for stable, 20% for variable]

## Accounts
- Primary checking: [which account is the "main" one]
- Credit cards: [name, statement closing date, how used — e.g., "Amex for dining, Chase for travel"]
- Account roles: [which accounts are for spending vs. saving vs. bills]

## Trip Tracking
- Default trip tag color: [preference]
- Typical trip categories to watch: flights, hotels, restaurants, rideshare, activities

## Communication Style
- Detail level: [simple/moderate/detailed] — default: simple
- Tone: [blunt/neutral/gentle] — default: blunt
- Framing: [concrete "hours of work" / dollar amounts / percentages] — default: concrete
- After-tax hourly rate: $X/hr (used for "that's N hours of work" framing)
- Learned preferences: [auto-populated, e.g., "wants category breakdowns for trips but just totals for monthly pulse"]

## Cleanup Preferences
- Category overrides: [e.g., "Uber Eats is always Dining, not Transport"]
- Merchants to ignore in cleanup: [e.g., known internal transfers]
- Recurring charges the user has confirmed are intentional: [list]
```

### Maintenance

- **Fully auto-maintained by skills.** Each skill reads the profile at the start of every run and updates it when the user expresses preferences that would be useful in future runs.
- **User can edit anytime** by asking Claude to update it.
- **Version-controlled** — changes are visible in git history.
- **Starts mostly empty** and fills in over time through use.

## 3. Testing Infrastructure

### LevelDB Snapshots

Scripts for reproducible read state during skill development:

- `bun run snapshot:create [name]` — copies the LevelDB directory to `snapshots/{name}/` with timestamp
- `bun run snapshot:restore [name]` — copies it back, calls `refresh_database` to reload
- `bun run snapshot:list` — shows available snapshots with dates and sizes

### Iteration Workflow

```
1. bun run snapshot:create before-cleanup-v1
2. Run skill in read-only/analysis mode
3. Review findings — not happy with detection quality
4. bun run snapshot:restore before-cleanup-v1
5. Tweak skill prompt
6. Repeat from step 2
```

The iteration loop targets the **detection and analysis logic**, which is read-only. Writes only happen when the user is satisfied with what the skill finds.

### Write Safety

**Concurrency cap on `review_transactions`:** Batch the `Promise.all` to 10-20 concurrent writes instead of unbounded fan-out. This is the only tool that can trigger multiple simultaneous writes.

All other write tools are single-write-per-call. The MCP protocol is inherently sequential (agent sends tool call, waits for response), so an agent cannot accidentally fire hundreds of writes simultaneously.

**No write rollback mechanism.** We avoid the problem through dry-run-first design rather than trying to undo writes.

## 4. Scheduled Automation

### Weekly Pulse (Sunday evening)

- Runs `/finance-pulse`
- Outputs a summary report
- Flags anything needing attention: spending spikes, missed recurrings, anomalous charges
- Read-only — never writes

### Monthly Cleanup Prompt (1st of the month)

- Runs `/finance-cleanup` in analysis-only mode
- Generates a report of findings: likely miscategorized transactions, potential new recurrings, unreviewed count
- User runs interactive cleanup at their convenience
- Read-only — never writes

### Trip Stragglers (on-demand)

- After a trip ends, `/finance-trip` can be re-run ~2 weeks later to catch late-posting charges
- Not scheduled — user invokes when ready

All scheduled runs are read-only analysis. They surface what needs attention without making changes.

## 5. Architecture

### Layer Diagram

```
┌─────────────────────────────────────┐
│  Scheduled Triggers (cron)          │  When to run
│  └─ invoke skills on a schedule     │
├─────────────────────────────────────┤
│  Skills (prompt files)              │  How to think
│  └─ /finance, /finance-cleanup,     │
│     /finance-pulse, /finance-trip   │
├─────────────────────────────────────┤
│  User Profile (user-profile.md)     │  Who the user is
│  └─ preferences, obligations,       │
│     account roles, thresholds       │
├─────────────────────────────────────┤
│  MCP Server (copilot-money-mcp)     │  What to do
│  └─ 35 tools: raw data access       │
│     + writes                        │
└─────────────────────────────────────┘
```

### Responsibility Boundaries

| Layer | Contains | Does NOT contain |
|-------|----------|-----------------|
| **MCP Server** | Raw data access, validation, write safety (concurrency cap), schema enforcement | Business logic, aggregation, heuristics, merchant grouping, anomaly detection |
| **Skills** | Domain knowledge in prompts — what to look for, how to reason about finances, what questions to ask, when to write vs. report | State between runs, persistent memory, ML models |
| **User Profile** | Personal financial context, preferences, thresholds, account roles | Transient data, session state |
| **Scheduled Triggers** | Cadence and invocation — which skill, how often | Logic — triggers just call skills |

### Key Principles

- **Skills are just prompts.** A skill is a markdown file with a system prompt. Improving a skill means editing a prompt, not shipping code.
- **Skills live in this repo** under `skills/` since they're purpose-built for this MCP server.
- **Subagents for parallelism.** When a skill needs multiple independent analyses (e.g., `/finance-pulse` checking trends AND subscriptions AND anomalies), it dispatches subagents. Claude Code's native agent dispatching handles this — no separate agent framework.
- **No middleware intelligence.** The MCP server exposes raw data. All reasoning happens in skill prompts.

### Skill File Structure

```
skills/
├── finance.md           # orchestrator
├── finance-cleanup.md   # transaction hygiene
├── finance-pulse.md     # situational awareness
├── finance-trip.md      # trip expense tracking
└── user-profile.md      # personal financial context (auto-maintained)
```

## 6. Deep Research Plan

Three research sessions to inform skill prompt design. User will run these independently and save results to markdown files.

### Research 1: "Personal Finance Automation — What's Actually Useful?"

Focus: What financial hygiene tasks do people neglect? What spending insights actually change behavior? What proactive alerts/nudges work in practice? What can an automated system replicate from a financial advisor's first meeting?

### Research 2: "Anomaly Detection in Personal Spending"

Focus: Heuristics and reasoning patterns (not ML models) for flagging unexpected charges, forgotten subscriptions, spending spikes, unknown merchants, recurring pattern mismatches. Acceptable false-positive rates. How existing apps approach this.

### Research 3: "The 'Can I Afford This?' Problem"

Focus: How to reason about discretionary spending capacity using account balances, recurring obligations, spending history, income patterns, and savings goals. What financial planners consider. The simplest useful mental model for "truly free money this month."

Research results have been incorporated into the skill designs below (Section 8).

## 7. Research Findings (Incorporated)

Three deep research sessions were completed. Key findings that shaped the skill designs:

### From "Personal Finance Automation — What's Actually Useful?"

- **Subscription waste is the #1 target.** Americans spend $219/month on subscriptions but estimate $86 (2.5x perception gap). $32/month wasted on forgotten subs. 72% on autopay with no conscious reapproval. Price drift ($1-3 increases) adds $15-30/month unnoticed.
- **Passive tracking doesn't change behavior.** Mint had 25M users and still failed — automated tracking reduces cognitive engagement alongside friction. Manual/prompted decisions are what work.
- **Prospective framing beats retrospective.** "You have $400 left for dining this week" changes behavior; "You spent $380 on dining last month" mostly doesn't. Restore the "pain of paying" that digital transactions erode.
- **Precommitment is the most powerful intervention.** Thaler's Save More Tomorrow: savings rates from 3.5% to 13.6%. Prompt allocation *before* payday, not after.
- **Conversational interfaces get 20x engagement** vs. dashboards (Cleo AI benchmark). Our skills are inherently conversational — this is the right modality.
- **Financial advisor first meeting is ~60-70% automatable** with transaction data. Pre-compute and confirm ("I see you earn ~$X/month and pay $Y in rent — is that right?"), don't interrogate.
- **One number beats twelve charts.** PocketGuard's "In My Pocket" is the most praised budgeting nudge — collapses complexity into a single actionable figure.
- **Alert fatigue is real.** 67% of PFM users abandon within the first month. Optimal cadence: payday nudges, mid-month pace checks, anomaly-triggered alerts — not daily summaries. 4-hour cooldown between similar alerts.

### From "Anomaly Detection in Personal Spending"

- **Hybrid architecture works best.** LLMs achieve only 32% accuracy on pure numerical anomaly detection, but excels at merchant disambiguation, contextual reasoning, and explanation. Pre-compute statistics, feed as natural language, let LLM judge and explain.
- **Convert data to prose, not CSV.** "On March 15, you spent $47.23 at Walmart in Groceries. Your average Walmart transaction is $52.30" dramatically improves LLM accuracy vs. tabular format.
- **3-tier alert prioritization:**
  - Tier 1 (always alert): fraud indicators, forgotten subscriptions, duplicate charges, recurring amount changes
  - Tier 2 (selective): unknown merchants, budget overspend
  - Tier 3 (digest only): spending category spikes, dormant category reactivation
- **Max 3-5 meaningful alerts per week.** Under 20% false positive rate. 64% of users delete apps sending 5+ notifications/week.
- **Subscription detection thresholds:** Monthly = 28-31 days ±3; need ≥3 instances. Amount drift: >5% for <$50, >3% for $50-200. Missed cycle: flag after 7 days past expected date.
- **Category spike thresholds:** Low variance (utilities): >20% above average. Medium (groceries): >50%. High (dining): >100% (2x). Require minimum $25-50 absolute increase.
- **Duplicate detection:** Same merchant, exact amount within 24h = high confidence. Allow 2-3 same-day for coffee/fast food.

### From "The 'Can I Afford This?' Problem"

- **Core formula:** `Free Money = Net Income − Fixed Obligations − Savings Target − Amortized Irregular Expenses − Committed Discretionary − Buffer`
- **Two independent checks required:** Budget check (does it fit allocated discretionary?) AND cash flow check (will the account stay positive on the day it clears?). These can produce contradictory answers.
- **Variable income:** Use 25th percentile of last 6 months as conservative baseline. Buffer: 5-10% for stable income, 15-25% for variable.
- **Amortized irregular expenses** (sinking funds): Typical household $1,000-1,200/month across 8-15 categories. Auto-detect from transaction history by scanning for annual/semi-annual payments.
- **Credit card timing matters:** Purchase on day 1 of cycle = 55 days float; last day = 21-25 days. Agent should know statement closing dates.
- **Never binary yes/no.** Present: signal (comfortable/tight/strain) + key number (remaining capacity) + tradeoff analysis + risk flags + reasoning transparency.
- **Magnitude tiers:** Small (<$50), Medium ($50-500), Large ($500-5K), Major (>$5K). Depth of analysis scales with magnitude.
- **Seasonal awareness:** Holiday spending $900-1,200/person, underestimated by 20-30%. Proactively warn in October. Utility bills swing 40-60% seasonally.

## 8. Implementation Order

1. **Testing infrastructure** — snapshot scripts + `review_transactions` concurrency cap (enables safe iteration)
2. **User profile** — empty `user-profile.md` with structure (skills need this from day one)
3. **`/finance-cleanup`** — highest immediate value (directly addresses the 3-4 hour quarterly pain)
4. **`/finance-pulse`** — situational awareness + scheduling
5. **`/finance-trip`** — trip tracking (addresses the unfinished Tahiti trip)
6. **`/finance`** — orchestrator (builds on the other three)
7. **Scheduled triggers** — wire up weekly pulse + monthly cleanup
