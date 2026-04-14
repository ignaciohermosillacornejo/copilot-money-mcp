# Copilot Money GraphQL Crawl — Agent SOP

You are a research subagent. Your job is to systematically navigate https://copilot.money via the `claude-in-chrome` MCP extension, observe what GraphQL operations fire, and produce complete documentation under `docs/graphql-capture/`.

**Design reference:** `docs/superpowers/specs/2026-04-14-graphql-capture-design.md`
**Operator runbook:** `scripts/graphql-capture/README.md`

## Preconditions you must verify before starting

- The operator has pasted `scripts/graphql-capture/interceptor.js` into DevTools console and reloaded the page. Confirm by asking them, or by evaluating `window.__gqlLogInstalled` via the extension if available.
- `docs/graphql-capture/` directory exists and is gitignored.
- `raw/captured-log.jsonl` starts empty.

## Crawl plan

Work **one top-level area at a time**, in this order:

1. Dashboard / home
2. Accounts (list, detail, connection management, manual accounts)
3. Transactions (list, filters, detail, splits, tags, notes, attachments, review queue)
4. Categories (list, create, edit, delete, hierarchy / groups)
5. Budgets (list, create, edit, delete, rollovers)
6. Goals (list, create, edit, delete, contributions)
7. Recurring (list, create, edit, delete, pause/resume, detection queue)
8. Investments (holdings, performance, securities detail, allocations)
9. Cash flow / trends / reports
10. Tags (list, create, edit, delete, assignment)
11. Rules (auto-categorization, if present)
12. Settings (profile, household, notifications, integrations, export, subscription)
13. Search
14. Modal-only surfaces discovered while crawling 1–13

## Per-area loop

For each area:

1. Navigate to every screen and sub-screen using `claude-in-chrome` click/scroll/type.
2. Exercise read-only interactions: filters, sort, detail views, opening modals, filling (but NOT submitting) create/edit forms.
3. Drain the log: ask the operator to run `copy(JSON.stringify(window.__gqlLog)); window.__gqlLog = []` and paste the result to a temp file, OR read `window.__gqlLog` directly via the extension's eval capability and clear it.
4. Append the drained entries to `docs/graphql-capture/raw/captured-log.jsonl` (one JSON object per line).
5. Run scrub: `bun scripts/graphql-capture/scrub.ts docs/graphql-capture/raw/captured-log.jsonl docs/graphql-capture/raw/scrubbed.jsonl`.
6. Run doc generator: `bun scripts/graphql-capture/generate-docs.ts docs/graphql-capture/raw/scrubbed.jsonl docs/graphql-capture/`.
7. Write a flow doc at `docs/graphql-capture/flows/NN-<area>.md` describing the narrative: screens visited, operations observed per screen in order, dependencies between operations, quirks.
8. Report to the operator:
   - Operations captured in this area (query names, mutation names).
   - Screens visited.
   - Anything skipped and why.
   - Anything unexpected.

## Mutation capture

Most mutations cannot be observed without actually submitting a form. For each mutation category:

- Create a test entity: name it `GQL-TEST` (budget, category, goal, tag) or use a small value (transaction amount near zero, recurring with a clearly-fake merchant).
- Update that entity to observe update mutations.
- Delete that entity to observe delete mutations.
- Ask the operator for approval **before** each destructive action. The operator may approve a category up front ("go ahead with all the budget mutations on GQL-TEST entities").

**Never:**
- Connect/disconnect bank accounts.
- Trigger sync on real accounts.
- Submit real money-moving actions (transfers, payments).
- Touch the subscription/billing surface beyond read-only browsing.

## Autonomy upgrade

After area 1 the operator reviews your output. If they approve continuing autonomously, proceed through areas 2–14 without per-area approval, BUT:

- Still stop and ask before each destructive mutation category.
- Still stop if you encounter a new top-level surface not in the crawl plan.
- Still stop on any auth error, rate-limit-looking response, or suspected anti-bot signal.

## End of crawl

1. Have the operator export the HAR file to `docs/graphql-capture/raw/session-YYYY-MM-DD.har`.
2. Write the top-level `docs/graphql-capture/README.md` with: capture date(s), Copilot web app version (grep `build` / version strings from an observed response if visible), browser/OS, account shape (which account types were connected, which surfaces were empty/unavailable), any gaps in coverage.
3. Write `docs/graphql-capture/schema/types.md` with observed GraphQL types and fields inferred from responses. Group by top-level type name when discoverable from `__typename` fields.
4. Report final statistics: total unique operations (queries + mutations), total observations, total screens covered, gaps.

## What a good output looks like

- Every file in `operations/queries/` and `operations/mutations/` has a fully filled template (no `<fill in from flow docs>` remaining).
- Every operation file links back to the flow(s) where it was observed.
- `schema/operations.md` is a complete index.
- `flows/NN-*.md` describes WHY operations fire in the order they do (e.g. "account detail fires GetAccount then GetAccountTransactions then GetAccountBalanceHistory in parallel — balance history waits for GetAccount's currency field").
- `raw/captured-log.jsonl` has one entry per GraphQL call and is the canonical source.
- `raw/session-*.har` is the belt-and-suspenders backup.
