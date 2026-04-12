# Finance Skills & Agents Design

**Date:** 2026-04-11
**Status:** Approved
**Scope:** Skill architecture, testing infrastructure, scheduling, user profile, and deep research plan for building an intelligent financial agent layer on top of copilot-money-mcp.

## Design Philosophy

**Thin tools, fat agents.** The MCP server provides raw data access and writes. All intelligence — pattern detection, anomaly flagging, categorization reasoning, financial advice — lives in skill prompts. No middleware, no aggregation layer, no heuristic code. Agents are smart enough to reason over raw data if the tools expose it well.

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
- Compares current month spending (by category) against trailing 3-month and 6-month averages — flags categories significantly above average
- Lists new charges that don't match any known merchant or recurring pattern — potential anomalies or accidental subscriptions
- Shows subscriptions/recurrings sorted by cost, flags any that missed their expected date (possible cancellation or billing issue)
- Calculates "runway" — based on current balances, recurring obligations, and average discretionary spend, roughly how many weeks of normal spending can be sustained
- Summarizes net cash flow for the month so far (income minus all outflows)
- Respects user preferences from `user-profile.md` (e.g., don't flag small coffee purchases)

**Key principle:** Read-only. No changes, just awareness. Primary candidate for scheduled automation.

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
- Understands user's full financial picture by pulling accounts, balances, recurring obligations, recent trends
- Answers affordability questions by considering: current balances, upcoming known obligations, average discretionary spending, savings targets from `user-profile.md`
- Can invoke sub-skill workflows when appropriate ("let me check your recent spending trends" -> pulse logic; "let me make sure your data is clean first" -> suggests running cleanup)
- Explicit about being a data-informed assistant, not giving certified financial advice
- Uses `user-profile.md` extensively for personalized context (income, fixed obligations, splurge thresholds, account roles)

**Key principle:** This is a prompt, not code. It's the "personality" layer that knows how to reason about finances using raw MCP tool calls.

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
- Rent/mortgage: $X/month
- Other fixed obligations: [list]

## Preferences
- Spending I don't want flagged: [e.g., daily coffee, small convenience store runs]
- Categories I care most about: [e.g., dining, travel, subscriptions]
- "Splurge" threshold: $X for a single discretionary purchase
- Savings target: $X/month or X% of income

## Accounts
- Primary checking: [which account is the "main" one]
- Credit cards: [which ones, how you use them]

## Trip Tracking
- Default trip tag color: [preference]
- Typical trip categories to watch: flights, hotels, restaurants, rideshare, activities

## Cleanup Preferences
- Category overrides: [e.g., "Uber Eats is always Dining, not Transport"]
- Merchants to ignore in cleanup: [e.g., known internal transfers]
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

Research results will be incorporated into skill prompts once available.

## 7. Implementation Order

1. **Testing infrastructure** — snapshot scripts + `review_transactions` concurrency cap (enables safe iteration)
2. **User profile** — empty `user-profile.md` with structure (skills need this from day one)
3. **`/finance-cleanup`** — highest immediate value (directly addresses the 3-4 hour quarterly pain)
4. **`/finance-pulse`** — situational awareness + scheduling
5. **`/finance-trip`** — trip tracking (addresses the unfinished Tahiti trip)
6. **`/finance`** — orchestrator (builds on the other three)
7. **Scheduled triggers** — wire up weekly pulse + monthly cleanup
