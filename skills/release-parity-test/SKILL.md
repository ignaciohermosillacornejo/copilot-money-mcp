---
name: release-parity-test
description: "Use before cutting a release, after a change to live reads or write tools, or when the user asks to test the MCP against the web app. Runs the three-way parity test in test-matrix.md (cache mode vs live MCP vs app.copilot.money), including round-trip writes with throwaway test data in the user's Manual account, then cleans up. Produces a local report with real figures and PII-free GitHub issues. Repo-maintenance skill, not a finance skill."
---

# Release Parity Test

A repeatable end-to-end check that what the MCP reports matches what Copilot's
own web app shows, in both read modes, and that every write tool's result is
visible to the next read. First run: 2026-10-14, before v3.0 (issues
#820–#825).

The case list lives in [`test-matrix.md`](test-matrix.md). This file is the
procedure. To extend the test, add rows there (its "How to extend" section);
change this file only when the procedure itself changes.

## When to use

- Before a release (the version-bump PR), after the last feature merge
- After a change to `src/tools/live/`, `src/core/live-database.ts`, the write
  tools in `src/tools/tools.ts`, or the field-selection presets
- The user asks to "test against the web app", "run the parity test", or
  "check the MCP matches Copilot"

## Do NOT use if

- The question is one enum or field against production → `bun run smoke`
- The user wants a financial analysis → `/finance-pulse`, `/finance-cleanup`
- There is no Manual account and the user has not agreed to the write cases
  being skipped (see Guardrails 2)

## Guardrails

1. **The web app is ground truth.** When the MCP and the web app disagree, the
   bug is in our code or our description until shown otherwise. Copilot-side
   quirks get documented, not "fixed".
2. **Writes go only to the Manual account**, and every created object's name
   starts with `ZZ MCP Test`, so it is easy to find and cannot be mistaken for
   real data. Record every id in a cleanup ledger the moment it is created.
3. **Changing a setting on a real account (hiding it, for example) needs the
   user's explicit yes in chat for that run**, and must be undone in the same
   run. Approval from a previous run does not carry over.
4. **Never delete a split parent.** Delete the children only (#822). Deleting
   the parent double-credits the account balance.
5. **PII.** Real balances, amounts, account and merchant names go only into the
   local report under `docs/superpowers/` (gitignored). `test-matrix.md`, issues
   and PRs get PASS/FAIL, ratios and synthetic numbers only.
6. **Cleanup always runs**, including after a failure partway through, and ends
   by checking the Manual account balance against the baseline.
7. **Web automation**: load the Chrome tools first (`claude-in-chrome` skill).
   Read pages with the extension's page-text tool rather than screenshots. If an input misbehaves (masked or
   content-editable fields), stop and ask the user to do that one step; never
   commit a value you have not read back.

## Phase 0 — Preflight

Run matrix section **P**:

1. `git fetch` and make sure the checkout the MCP server runs from (see
   `~/.claude.json`, the `copilot-money` entry) is at `origin/main`, then check
   the server process started after that commit:
   `ps -o lstart,command -ax | grep src/cli.ts`. A stale process tests old code.
   Ask the user to `/mcp` reconnect `copilot-money` if needed.
2. Confirm live mode (P-02) and open a Chrome tab on the web app (P-03).
3. Record the Manual account baseline (P-04): id, item id, balance, and its
   transactions.
4. Start the local report:
   `docs/superpowers/RELEASE-PARITY-TEST-<YYYY-MM-DD>.md`, with a cleanup ledger
   section at the top.

## Phase 1 — Reads (sections ACC, INV, TXN, CAT/BUD, REC, V3)

- **Live** side: call the MCP tools directly.
- **Cache** side: the cache-mode read tools are hidden while `--live-reads` is
  on, so call them through the helper, which runs the same `CopilotMoneyTools`
  method against the local cache:

  ```bash
  bun run scripts/parity/cache-call.ts getAccounts '{"include_hidden":true}'
  bun run scripts/parity/cache-call.ts getTransactions '{"start_date":"…","end_date":"…","fields":["all"]}'
  ```

  The local cache only changes when the Copilot desktop app syncs, which
  usually takes a few minutes after a write.
- **Web** side: Accounts, Investments (and a holding's detail panel),
  Transactions, Categories, Dashboard. Use the same date range as the tool call.

Compare ids first, then fields. Write each difference to the report with both
values, then decide: our bug, our description, or Copilot's own behaviour.

## Phase 2 — Writes and coherence (sections W, COH, ERR)

1. Create the W-section test data in the Manual account. Log every id.
2. After each write, check it in live **and** in the web app.
3. Coherence (COH) is the part most likely to regress, and it is invisible
   unless you test a **cold month**: one whose last day is more than 14 days old
   is cached for a week. Read that month once, write into it, read again, and
   look at `_cache_hit` and `_cache_oldest_fetched_at`. A row missing or stale
   with a fetch time earlier than the write is a coherence failure.
   `refresh_cache { scope: "transactions", months: [...] }` then confirms the
   write did land.
4. Run the ERR inputs; each should fail before any write.
5. Optional with user approval: INV-04 (hide an investment account, compare,
   unhide).

## Phase 3 — Cleanup (section CL)

In this order: recurring and budget overrides, then transactions (split
**children** only), then the test category and tag. Then:

- live and cache show no `ZZ MCP Test` objects (wait for the desktop app to sync
  the cache)
- the Manual account balance equals the baseline in live (after
  `refresh_cache { scope: "accounts" }`) and in the web app
- any real-account setting changed in Phase 2 is restored

If the balance does not match, tell the user the exact difference; editing a
manual balance in the web app is a step for them.

## Phase 4 — Report

1. Update **Last run** for every case in `test-matrix.md` (date + PASS / FAIL #N
   / SKIP). Add rows for anything new you tested.
2. File each new defect as a GitHub issue: search first, use synthetic numbers,
   include reproduction steps, root cause if found, a fix direction, and a
   class-level detector (CONTRIBUTING.md "Bug Response Ritual"). Batch
   low-severity ones into one issue.
3. Commit the matrix update in its own PR. The local report stays local.
