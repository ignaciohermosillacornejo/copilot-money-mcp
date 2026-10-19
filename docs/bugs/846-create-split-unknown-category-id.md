---
id: 846
title: create_transaction and split_transaction stored a nonexistent category id, leaving the row with no category in the app
class: referential-integrity-gap
status: fixed
detected: live-probe # v3.0 release parity re-run (2026-10-18), row ERR-09: create_transaction with a made-up category id, then a live read
fixed_in: not yet
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/846
date: 2026-10-18
---

## Symptom

`create_transaction` with a well-formed but made-up 20-character `category_id` returned
`success: true`. A live read of the new row returned that `category_id`, and the web app
showed the transaction with no category. **Silent**: nothing in the response said the id
pointed at nothing. By code, a `split_transaction` child took the same path.

## How it was detected

The release parity test has an error-handling row (ERR-09) that sends each write tool a
plausible-looking unknown id and checks what comes back. `bulk_edit_transactions`
rejected it client-side; `create_transaction` accepted it, and the follow-up live read
showed the server had stored it.

## Root cause

`CopilotMoneyTools.createTransaction` and `splitTransaction` (`src/tools/tools.ts`)
checked only the id's **shape** (`validateDocId`) before sending. Copilot performs no
referential check on a category id: `bulkEditTransactions` was already known to store an
unknown one verbatim (ledger:
`Mutation.bulkEditTransactions:no-referential-validation`, 2026-08-01), and that is why
`bulk_edit_transactions`, `update_transaction(s)` and `update_recurring` validate against
the categories list. The check existed; it was applied per tool, by whoever wrote each
tool, and the two creating paths never got it.

## Why the tests didn't catch it

Every test of the existing check was written for the tool it guarded (`bulk-edit`,
`update-transaction`, `reference-validation`). Nothing enumerated the write tools that
take a `category_id`, so a tool without the check had no test that would notice. The
create and split tests used ids that were not in any category fixture at all, which is
itself the bug's shape: the fixtures could not have told an unknown id from a known one.

## The fix

- **Root cause:** `validateCategoryId` is now called by every write that stores a
  category id: `create_transaction`, each `split_transaction` child (once per distinct
  id), and `set_budget`, joining `update_transaction(s)`, `bulk_edit_transactions` and
  `update_recurring`. It is the one check; no tool has its own.
- **Downstream:** a miss on a cached categories list (1-day TTL) now refetches once
  before rejecting, so a category created in the app since the list was cached is not
  refused by the wider check.
- **Same PR, same class of "the server's error was the only check":** every write date
  (`create_transaction`, `update_transaction(s)`, split children) must be a real calendar
  date, and `set_budget`'s month must be 01–12 (#825). `2026-02-30` used to reach the
  server, whose 400 was reported as possible API drift. The validator lives in
  `src/utils/date.ts`; read filters are unchanged.
- Ledger: `Mutation.createTransaction:no-referential-validation` (verified-once, the
  parity run) and `Mutation.splitTransaction:no-referential-validation` (unverified,
  inferred from the shared create path).

`update_category` and `delete_category` take a `category_id` too, but it names the record
being written rather than a reference stored on another one, so they are listed in the
detector's table as exemptions with that reason.

## Detector

`tests/tools/write-reference-validation.test.ts` derives, from `WRITE_TOOL_DEFS`, every
write tool whose input schema has a `category_id` (at any depth) and requires each to have
a case or a stated exemption, so a new tool fails until it joins. Each case sends an
unknown id through the registry handler against a real `LiveCopilotDatabase` and asserts
the rejection with no mutation sent, paired with a control where a known id reaches the
mutation. The same file does the same for every write tool taking a `date` or `month`.
Two rows in `scripts/mutation-guards.ts` (`create_transaction validates its category id`,
`split_transaction validates child category ids`), both **mutation-verified**.

The class is wider than categories: tag ids are validated on every write that takes
them, but recurring ids (`create_transaction.recurring_id`,
`add_transaction_to_recurring`) are not. Not covered here.

## Lesson

A check that has to be remembered per tool will be forgotten on one. When the server
does not validate references, the list of tools that send one should be derived, not
written down.
