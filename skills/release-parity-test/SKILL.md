---
name: release-parity-test
description: "Use before cutting a release, after a change to live reads, write tools or skills, or when the user asks to test the MCP against the web app. Runs the three-way parity test in test-matrix.md (cache mode vs live MCP vs app.copilot.money), including round-trip writes with throwaway test data in the user's Manual account, then cleans up. Produces a local report with real figures and PII-free GitHub issues. Repo-maintenance skill, not a finance skill."
---

# Release Parity Test

A repeatable end-to-end check that what the MCP reports matches what Copilot's
own web app shows, in both read modes, and that every write is visible to the
next read. First run: 2026-10-14, before v3.0 (issues #820–#825). The plan was
then reviewed against the code and the `docs/bugs/` corpus, which added most of
the `not run` rows.

The case list lives in [`test-matrix.md`](test-matrix.md). This file is the
procedure. To extend the test, add rows there (its "How to extend" section);
change this file only when the procedure itself changes.

A full run is long. When time is short, run every **[P1]** row plus the rows
whose Last run is a FAIL. Leave the rest as they are: a row this run did not
repeat keeps its earlier result; if that result is anything but a plain PASS
or `not run`, set its `; not re-run <date>` stamp. A recorded FAIL is never
replaced by a SKIP (test-matrix.md, How to extend).

## When to use

- Before a release (the version-bump PR), after the last feature merge
- After a change to `src/tools/live/`, `src/core/live-database.ts`, the write
  tools in `src/tools/tools.ts`, the field-selection presets, or `skills/`
  (then include the SKL section)
- The user asks to "test against the web app", "run the parity test", or
  "check the MCP matches Copilot"

## Do NOT use if

- The question is one enum or field against production → `bun run smoke`
- The user wants a financial analysis → `/finance-pulse`, `/finance-cleanup`
- There is no Manual account and the user has not agreed to the write cases
  being skipped (see Guardrail 2)

## Guardrails

1. **The web app is ground truth.** When the MCP and the web app disagree, the
   bug is in our code or our description until shown otherwise. Copilot-side
   quirks get documented, not "fixed".
2. **Writes go only to the Manual account the user names in chat for this run.**
   Every created object's name starts with `ZZ MCP Test <RUN>`, where `<RUN>` is
   the run's `YYYYMMDD-HHMM`, so leftovers from an earlier run cannot be
   mistaken for this run's objects. The cleanup ledger is a section of the local
   report file. Log each write **before** sending it (planned name, account,
   date, amount, expected balance effect, status `sent`); when the response
   arrives, add the id and set `created`; save after every line. Before any
   update, split or delete, the id must be in this run's ledger, its
   `account_id` must be the Manual account, and a live read must show its name
   still carries the run prefix.
3. **Changing a setting on a real account (hiding it, for example) needs the
   user's explicit yes in chat for that run**, and must be undone in the same
   run. Approval from a previous run does not carry over.
4. **Never delete a split parent.** Delete the children only (#822). Deleting
   the parent double-credits the account balance.
5. **PII.** Real balances, amounts, account, merchant and place names go only
   into the local report under `docs/superpowers/` (gitignored).
   `test-matrix.md`, issues and PRs get PASS/FAIL, ratios and synthetic numbers.
   The session transcript holds real figures too (tool output, page text): never
   paste from it into an issue or PR without rewriting the figures.
6. **Cleanup always runs**, including after a failure partway through. It works
   from the ledger file, so a new session can finish it: Phase 0 reads the
   latest `RELEASE-PARITY-TEST-*.md` and completes any ledger line not marked
   `confirmed-gone` before starting. Check the balance after every cleanup group
   (CL-07). Stop and tell the user, without trying to repair anything, if the
   balance moves by an amount the ledger does not explain, or if any write
   reached a non-Manual account.
7. **Web automation.** The web column needs the Claude in Chrome extension; its
   skill is provided by the host, not this repo. Load its tools first. If it is
   unavailable, every web comparison is SKIP (no browser), never PASS on two
   sources: the web is the ground truth.
   Read pages with the extension's page-text tool rather than screenshots, and
   read figures from the page's own search, filters and totals, never by
   counting rendered rows (lists load more as you scroll). Record the raw text
   you read. Before filing a FAIL that rests on a web figure, reload and read it
   again; right after a write, wait 30 seconds and reload once. If an input
   misbehaves (masked or content-editable fields), stop and ask the user to do
   that one step; never commit a value you have not read back.
8. **A write that errors may still have landed.** On any write error do not
   retry. That includes `writeMayHaveApplied`, a bulk edit's "N/M succeeded",
   `deleted: false`, and a shape error after the call. First run
   `refresh_cache { scope: "transactions", months: [...] }`, search live for the
   run prefix, and check the web. Set the ledger line to what actually happened.
   Retry only once the object is confirmed absent.
9. **Keep test rows away from real data unless the case needs it.** When a case
   needs a real category (TXN-05, a split child), note that category's month
   total in the web before the write and check it at the end (CL-08). Test names
   must contain no real merchant name, since a real recurring's rule could pick
   the row up (REC-05). Use `set_budget` only on the test category, and restore
   a budget to its previous value: `"0"` is a budget of zero, not "no budget".

## Phase 0 — Preflight (section P)

1. `git fetch`; the checkout the MCP server runs from (`~/.claude.json`,
   `copilot-money` entry) must be at `origin/main`, and the server process must
   have started after that commit (`ps -o lstart,command -ax | grep src/cli.ts`).
   Ask the user to `/mcp` reconnect `copilot-money` if not.
2. `cache-call.ts` must run from the same commit (P-06). Run `bun run smoke`
   (P-05): any drift verdict ends the run.
3. Confirm live and write mode (P-02) and open a Chrome tab on the web app
   (P-03).
4. Ask the user which account is the Manual test account and confirm
   `isManual: true` (P-04). Record its id, item id, balance, and every existing
   transaction id as DO NOT TOUCH. If it has real transactions, check balances
   as changes from the baseline, never as absolute values.
5. Start the local report, `docs/superpowers/RELEASE-PARITY-TEST-<YYYY-MM-DD>.md`,
   with the cleanup ledger at the top. Finish any unfinished ledger from an
   earlier run first (Guardrail 6), then clear leftovers (P-08).
6. Record the clock and the live-tier months (P-09). Pick a cold month at least
   two months back for the COH cases.

## Phase 1 — Reads (ACC, NET, INV, TXN, CAT, BUD, REC, GOAL, V3)

- **Live**: call the MCP tools directly.
- **Cache**: the cache-mode read tools are hidden while `--live-reads` is on,
  so call them through the helper, which runs the same `CopilotMoneyTools`
  method against the local cache (read methods only):

  ```bash
  bun run parity:cache getAccounts '{"include_hidden":true}'
  bun run parity:cache getTransactions '{"start_date":"…","end_date":"…","fields":["all"]}'
  ```

  If the server's `copilot-money` entry passes `--db-path`, export
  `PARITY_DB_PATH` with the same value, or the two columns read different
  databases. The helper prints the database it read to stderr; record it.

  Before each cache comparison, confirm with `getCacheInfo` that the desktop app
  has synced (P-07). Wait at most 15 minutes, then mark that case's cache
  comparison SKIP (stale); its live and web comparisons still count.
- **Web**: Accounts, Investments (and a holding's detail panel),
  Transactions, Categories, Recurrings, Goals, Dashboard, for the same range.

Join the sources by id across every page (continue until `has_more` is false).
Compare counts, then amounts, then names. A row present in only one source is a
FAIL unless the report explains it (TXN-07). **A filter case passes only after
comparing it with the other mode and the web on real data, not just on test
rows**: that is how TXN-03 passed while TXN-08 is a predicted FAIL. Write each
difference to the report with both values, then decide: our bug, our
description, or Copilot's own behaviour.

## Phase 2 — Writes and coherence (W, COH, ERR)

1. Create the W-section test data in the Manual account, logging each write
   before sending it.
2. After each write, check it in live **and** in the web.
3. Coherence is the part most likely to regress, and it is invisible unless you
   test a **cold month** (P-09): it is cached for a week. Read it once, write
   into it, read again, and look at `_cache_hit` and `_cache_oldest_fetched_at`.
   A missing or stale row with a fetch time earlier than the write is a
   coherence failure; `refresh_cache { scope: "transactions", months: [...] }`
   then confirms the write did land. Test both directions: MCP write → MCP read,
   and web edit → MCP read (COH-09).
4. Run the ERR inputs; each should fail before any write. Treat any write that
   errors under Guardrail 8.
5. With the user's approval for this run: INV-04 and TXN-14 (hide an
   investment account, compare, unhide).

## Phase 2.5 — Skills (SKL)

Run each skill in a subagent with a fixed prompt, against a fixed past month at
least 45 days old so late charges have settled. Compare its figures with the
web for that month, and list every write-tool call in the subagent's transcript
against what it was allowed to do. Skills that write use only test rows.

## Phase 3 — Cleanup (CL)

In this order, checking the balance after each group (CL-07):

1. Recurring items deleted; budget overrides restored to their baseline values
   (not `"0"`).
2. Transactions deleted in reverse creation order, split **children** only.
3. Each split parent's state read and recorded (CL-06). Never delete one; a
   remaining parent is a known leftover.
4. The test category and tag deleted.

Then: live and cache show no run-prefixed objects (wait for the desktop app, up
to 15 minutes, CL-09), and any real-account setting changed in Phase 2 is
restored. If the balance does not match the baseline, use the per-group checks
to name the step that caused it, give the user the exact difference and the
steps to set the Manual account's balance back in the web app, and afterwards
read it back in the web and in live (after `refresh_cache { scope: "accounts" }`).
Never create a balancing transaction.

## Phase 3.5 — Session and packaging (SES)

After cleanup: SES-01 needs the server to have run 65+ minutes (schedule its
read and write late in the run), SES-03 and SES-04 are quick local checks,
SES-05 installs the release artifact in a scratch directory, and SES-02 (log
out of the web app) runs last of all, because it ends the web session.

## Phase 4 — Report

1. Update **Last run** for every case you ran in `test-matrix.md` (date + PASS /
   FAIL #N / SKIP with reason; partial results per its How to extend). Rows you
   did not run keep their result; if it is anything but a plain PASS or
   `not run`, set its `; not re-run <date>` stamp. Add rows for anything new
   you tested.
2. File each new defect as a GitHub issue: search first, use synthetic numbers,
   include reproduction steps, root cause if found, a fix direction, and a
   class-level detector (CONTRIBUTING.md "Bug Response Ritual"). Batch
   low-severity ones into one issue.
3. Commit the matrix update in its own PR. The local report stays local.
