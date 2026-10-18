---
id: 822
title: delete_transaction accepted a split parent, and Copilot credited the parent's amount back to the account a second time
class: aggregation-double-count
status: fixed
detected: live-probe # v3.0 release parity test (2026-10-14): round-trip create → split → delete on a manual account, then the account balance in the web app
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/835
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/822
date: 2026-10-15
---

## Symptom

On a manual account at balance **B** (synthetic figures): `create_transaction` for `100`
left `B − 100`; `split_transaction` into `60` + `40` left it unchanged; deleting both
children returned it to `B`, which is correct. Then `delete_transaction` on the **parent**
succeeded, and the balance became **`B + 100`**. The web app showed the extra `+100` on the
account. On a manual account nothing corrects it except a hand edit of the balance.
**Silent** as far as the tool goes: the delete returned `deleted: true`.

## How it was detected

The three-way release parity test runs round-trip writes against throwaway rows in the
user's Manual account and cleans up afterwards. Cleanup deleted the split parent along
with its children, and the account balance in the web app no longer matched its value
before the run. The caller reached the parent only by id — `split_transaction`'s own
response carries `parent_transaction_id` — because split parents never appear in reads.

## Root cause

`CopilotMoneyTools.deleteTransaction` (`src/tools/tools.ts`) forwarded any id to the
`DeleteTransaction` mutation. Copilot's server treats a split parent's delete as the delete
of an ordinary transaction and reverses its amount on the account, although the children
already replaced that amount — so the same money is credited twice across the parent/child
hierarchy. Nothing on our side knew the target was a parent: the tool checks no cache, and
its description did not mention split parents. `split_transaction`'s description made it
worse by describing undo as "deleting each child and editing the parent's category back",
which reads as an invitation to touch the parent.

There is no server-side way to reverse a split: a 2026-10-15 probe of twenty candidate
mutation names (`unsplitTransaction`, `mergeTransaction(s)`, `undoSplit`, `removeSplit`,
`deleteSplit(Transaction)`, `revertSplit`, …) found none.

A second instance of the same defect lived in the round-trip smoke harness
(`scripts/smoke/roundtrip-checks.ts`): the `split_transaction` check's parent stayed
registered for cleanup, so every full smoke run deleted a split parent on the real account
after its children.

## Why the tests didn't catch it

The delete tests used ordinary transactions only; no test combined split and delete. The
mocked mutation cannot show a balance, and the server-side effect — the only place the bug
exists — is visible solely in the account balance, which no automated check reads. The
smoke harness that did exercise split-then-delete against the real backend verifies rows
by re-read and never looks at the account balance afterwards.

## The fix

`deleteTransaction` refuses an id it knows to be a split parent, before the delete is
sent:

- an in-memory session record: `split_transaction` records the parent it split (first
  statement after the mutation resolves, and the parent is evicted from both caches at the
  same point, so a drifted response cannot leave a stale pre-split row behind), and deleting
  a split **child** records that child's parent before the delete is sent — which is what
  still knows the parent after its last child is gone, the exact sequence above;
- live mode (the shipped CLI always runs writes this way, since `--write` implies
  `--live-reads`): a session record taken with no window-cache invalidation since, or a
  cached row whose `parentId` is the id (`LiveCopilotDatabase.hasSplitChildOf`), refuses
  with no request. Otherwise the write-resolve window is loaded (the same windowed fetch
  write resolution uses) and checked for a child row. A row for the id itself, from a month
  fetched during this check, proves it is not a parent — the Transactions query omits split
  parents — and retires a session record; a merely cached row does not. Local-cache rows are
  scanned only if already in memory; a LevelDB decode is never triggered. A failed window
  fetch does not block the delete; the check proceeds on what is already held;
- cache-only mode (a library/test fallback): the local cache row has non-empty
  `children_transaction_ids`, or any cached row's `parent_transaction_id` is the id.

The refusal says to delete the children instead, that there is no unsplit, and how to retry
after removing the split in the app (`refresh_cache`, or `refresh_database` if the split
was cached locally — stale local rows can refuse in live mode too).
That the parent stays hidden once its children are deleted is **unverified**, and two
decisions rest on it: the smoke harness leaving the parent behind (it logs the id), and the
live-first check retiring a session record when a freshly fetched row for the id comes back.
If a childless ex-parent ever reappeared as an ordinary row, the retirement would let its
delete through, and the `refresh_cache` the refusal recommends is what opens that path.
Ledger: `Transaction.parentId:childlessParentHidden` (unverified). There is no opt-in override. Both tool
descriptions now state the rule, and the smoke harness deregisters the parent before it
sends the split, so cleanup deletes only the children even when the split's response is
lost.

Best-effort by construction: a parent split in the app, in a month neither cache holds, and
not seen this session, is still accepted — after a server restart the session record is
gone.

## Detector

`tests/unit/delete-split-parent.test.ts` covers each source of evidence separately (session
split, delete-children-then-parent, local `children_transaction_ids`, local child pointer,
live child row) and asserts no `DeleteTransaction` is sent, plus that ordinary
transactions and split children still delete. The refusal is registered in
`scripts/mutation-guards.ts` (`delete_transaction refuses a split parent`), so
`bun run check:mutation-guards` proves the file goes red when the refusal is removed —
**mutation-verified**.

Partial for the class: other write tools that accept a parent id (`update_transaction`
amount/date, `add_transaction_to_recurring`, `review_transactions`,
`bulk_edit_transactions`) are not guarded, because their server-side effect on a parent has
not been observed.

## Lesson

A write whose damage lands only in a derived server value (a balance) is invisible to
every check that verifies the written row. Round-trip tests of destructive writes should
read the account balance before and after.
