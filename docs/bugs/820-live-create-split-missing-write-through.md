---
id: 820
title: In live mode, a created transaction (or split children) was invisible to reads of a cached month for up to a week
class: stale-cache-semantics
status: fixed
detected: live-probe  # v3.0 release parity test (2026-10-14): create_transaction in last month, then get_transactions_live
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/831
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/820
date: 2026-10-15
---

## Symptom

In live mode, `create_transaction` dated in a month whose last day is more than 14 days old
succeeded, but `get_transactions_live` for that month returned 0 rows with
`_cache_hit: true` for up to a week. `refresh_cache` for the month made it appear.
Transactions created in the current month showed up at once, because recent months are
never cached, which made the bug easy to miss. Inferred from the code, not observed:
`split_transaction` in a cached month made the whole amount vanish from live reads, since
the parent was evicted and the children were never added. **Silent.**

## How it was detected

The same v3.0 release parity run as [#821](821-live-write-through-snake-case-patch.md): a
round-trip create into last month on a manual account, read back with
`exclude_transfers: false`.

## Root cause

Writes keep the live `TransactionWindowCache` coherent by write-through. Updates and
deletes had one; creates had none. `createTransaction` in `src/tools/tools.ts` only fed the
routing-id meta index (`indexTransactionMeta`), and `splitTransaction` fed the index and
evicted the parent but never inserted the children. A month in the cold tier keeps its
cached rows for `coldTtlMs` (one week, `src/core/live-database.ts`), so the new rows stayed
out of the cache until it expired.

## Why the tests didn't catch it

The create and split tool tests asserted the mutation request, the response mapping and
the meta-index feed. That feed was the only live-cache interaction they knew about. No
test read the live cache back after a write, so a write path with no write-through at all
looked the same as one that had it.

## The fix

`create_transaction` upserts the server's created row with `upsertLiveTransaction`.
`split_transaction` evicts the parent as before and then upserts each child, setting
`parentId` to the parent's id, because the mutation fragment does not select it and a
Transactions read reports split children that way (ledger:
`Transaction.parentId:splitChildren`, verified-once: probe 2026-10-15, counts only). The
upsert is a no-op for a month that is not cached, so the next read fetches it from the
server.

Not fixed, and out of scope here: the local LevelDB snapshot that cache mode reads.
`split_transaction` evicts the parent from it too, but `CopilotDatabase` has no insert
API, so split children are never added. Cache-mode reads show the vanished-amount symptom
until the local cache reloads (5-minute TTL by default, `COPILOT_CACHE_TTL_MINUTES`) and
the Copilot app has synced the children into its LevelDB.

## Detector

Shared with #821: `tests/tools/live-write-coherence.test.ts`, one case per transaction
write tool, exhaustive over `WRITE_TOOL_DEFS`. The create write-through is also a
registered mutation guard (`create_transaction writes through to the live cache` in
`scripts/mutation-guards.ts`): deleting the call fails the `create_transaction` case.
Mutation-verified by `bun run check:mutation-guards`.

## Lesson

A cache with write-through needs a check that every write path has one. The table test
makes "new write tool" and "new coherence case" one change, so a missing write-through
fails a test instead of reaching users.
