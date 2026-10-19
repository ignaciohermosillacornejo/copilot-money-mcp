---
id: 842
title: delete_transaction accepted a split parent once its children were deleted, because Copilot returns it as an ordinary row again
class: aggregation-double-count
status: fixed
detected: live-probe # v3.0 release parity test (2026-10-18), row W-23: split, delete both children, refresh_cache, fresh read of the month, then delete the parent
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/852
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/842
date: 2026-10-18
---

## Symptom

The #822 guard refused a split parent while it still had children. Once both children were
deleted, `refresh_cache` followed by a fresh read of the month returned the parent as an
ordinary row (`parentId: null`, the parent's amount), and the next `delete_transaction` on
it was **accepted**. The #822 post-mortem's own repro shows what that costs: on a manual
account at balance **B** (synthetic figures), deleting the children returns it to `B`, and
deleting the childless parent leaves it at **`B + 100`**. The tool returned
`deleted: true`, so it was **silent**. The #822 refusal message pointed the caller at this
path: it recommended `refresh_cache` and a retry.

## How it was detected

The release parity test's row W-23 was written to settle the assumption #822 had left
`unverified` in the ledger (`Transaction.parentId:childlessParentHidden`): that a split
parent stays out of the Transactions query after all of its children are gone. Its fresh
read showed the parent id. The row exists because the #822 post-mortem named the
assumption and the decision that rested on it; the parity test then ran the check that
retired it. A follow-up probe the same day (manual test account, a synthetic row split in
two, dated before the account's balance reset so it had no balance effect) mapped what
evidence exists, which shaped the fix.

## Root cause

`CopilotMoneyTools.splitParentEvidence` (`src/tools/tools.ts`) retired a session split record
when a row for the id came back from a month fetched during the check, on the premise that
the Transactions query never returns a split parent. That premise held only while the parent
had children. Copilot's `Transaction` has no split marker at all: the only split-named field,
`hasSplitError`, is false on the parent, the children and the ex-parent alike. Once the last
child is deleted, the ex-parent is indistinguishable from any other row in both
`transactions` and `transaction(id)`, and its raw Firestore document carries no marker
either. The guard treated "the server shows this row" as negative evidence, and no such
evidence exists.

Two smaller defects shared the cause. The refusal message told the caller to run
`refresh_cache` and retry, and `refresh_cache` is what moved the cache generation so the
retirement branch could run. And the record was in memory only, so a restart forgot every
parent, and the window fetch then saw an ordinary row.

## Why the tests didn't catch it

The behaviour was tested on purpose, in the wrong direction: `a session record is retired
when the server returns the id as an ordinary row` asserted the retirement and modelled the
server the way the unverified ledger entry described it. The mocked Transactions query
returned whatever the test said the server would, and nothing compared that with the real
API. The ledger did its job here: the entry was classed `unverified`, said which decision
rested on it and how to check it, and the parity test checked it. Nothing stopped an
`unverified` entry from deciding whether a destructive write is sent, though.

## The fix

- **Root cause:** no evidence is negative any more. A recorded split parent is refused for
  the life of the record, whatever the server returns for the id. The record is a plain set
  (the generation stamp only served retirement).
- **Local evidence that survives the children:** deleting a split child leaves its document
  in the desktop app's Firestore cache with `user_deleted: true` and `parent_transaction_id`
  still set. The decoder still drops those documents as rows, but `decodeAllCollections`
  now collects every id a transaction document names as a parent (deleted documents
  included, plus `children_transaction_ids` owners) into
  `AllCollectionsResult.splitParentIds`, in the same single pass.
  `CopilotDatabase.getSplitParentIds()` exposes it, and `splitParentEvidence` consults it in
  live and cache-only mode. Live mode now decodes the local cache for this check when
  nothing has loaded it yet or the loaded data is past the cache TTL, so a split made and
  un-split in the app mid-session is seen too. Delete is rare and destructive, and the
  decode is the same batch every cache read uses: usually seconds, at worst the decode
  timeout (90 s by default). An unreadable or timed-out cache still never blocks a delete;
  the guard then rests on the record and the live checks for that call.
- **Persistence:** split records are written to `split-parents.<uid>.jsonl` beside the
  routing-id index (`~/.claude/copilot-money/`, append-only JSONL, uid-scoped, same opt-out),
  so a parent split through this server stays refused after a restart. The in-memory half is
  cleared on a mid-session login change, matching the uid-scoped file.
- **Downstream:** the refusal no longer offers a retry and says the parent reappears as an
  ordinary row once its children are deleted. Both tool descriptions now say the same.
  Ledger: `Transaction.parentId:childlessParentHidden` (unverified) is replaced by
  `Transaction.parentId:childlessParentReappears` and
  `FirestoreTransaction.parent_transaction_id:survivesSoftDelete`, both verified-once.

Still best-effort: a parent split and un-split entirely in the app, with no desktop-app sync
of the deleted children and no record from this server, is not known.

## Detector

`tests/unit/delete-split-parent.test.ts` gains the exact #842 sequence (split, both children
deleted, a freshly fetched window returns the parent as an ordinary row, so the delete must
still be refused and nothing sent), a real-LevelDB fixture with soft-deleted children that
refuses the parent in live mode with an empty session and in cache-only mode, and a restart
test across two tool instances sharing a store, plus a delete past the cache TTL that must
see a child deleted after the first decode. Five new rows in `scripts/mutation-guards.ts`,
each **mutation-verified** by `bun run check:mutation-guards`:

- `a fresh row never retires a split record`: the record check is removed;
- `split-parent records survive a restart`: the persisted record is dropped from the check;
- `delete reads the local cache's split evidence in live mode`: live mode skips it;
- `split-parent evidence honours the cache TTL`: the id set is never re-read once loaded;
- `soft-deleted split children still name their parent`: the decoder collects parent ids
  only from documents that produce a row.

The #822 row now also names the #842 test. Same partial coverage of the class as #822: the
read-side sums and the other write tools that accept a parent id are not covered.

## Lesson

A safety guard must not draw a negative conclusion ("this id is safe") from an `unverified`
ledger entry. If an assumption decides whether a destructive write is sent, verify it before
the guard ships, or make the guard refuse whenever the assumption is uncertain.
