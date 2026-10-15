---
id: 821
title: In live mode, category, tag, note, review and recurring edits were invisible to reads of a cached month for up to a week
class: stale-cache-semantics
status: fixed
detected: live-probe  # v3.0 release parity test (2026-10-14): write, then read the same cold month through the live tool
fixed_in: not yet
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/821
date: 2026-10-15
---

## Symptom

In live mode (`--live-reads`, implied by `--write`), an edit to a transaction in a month
whose last day is more than 14 days old succeeded on Copilot's server, but
`get_transactions_live` kept returning the old values for up to a week:
`bulk_edit_transactions` adding a tag, then a read, showed `tag_ids: []`;
`review_transactions` with `reviewed: false`, then a read, showed `user_reviewed: true`.
Name, date and amount edits did show up. Nothing in the response said the row was stale.
**Silent**: the output was well-formed and looked right.

## How it was detected

The three-way release parity test for v3.0 (cache mode vs live MCP vs the web app) runs
round-trip writes against throwaway rows and then reads them back. The read-back in a
cold month disagreed with the write; `refresh_cache` for that month fixed it, which
pointed at the cache rather than the server.

## Root cause

`LiveCopilotDatabase.patchLiveTransaction(id, fields: Partial<Transaction>)`
(`src/core/live-database.ts`) merged `fields` onto the cached row with
`{ ...existing, ...fields, id }`. `fields` was the **local cache model** (snake_case:
`category_id`, `user_reviewed`, `tag_ids`, `user_note`, `recurring_id`); `existing` was a
**GraphQL node** (camelCase: `categoryId`, `isReviewed`, `tags`, `userNotes`,
`recurringId`). The spread added dead snake_case keys and left every camelCase field the
live mapper reads untouched. Only `name`, `date` and `amount`, spelled the same in both
models, worked. Five callers in `src/tools/tools.ts` were affected: `update_transaction`,
`update_transactions`, `add_transaction_to_recurring`, `review_transactions` and
`bulk_edit_transactions`.

## Why the tests didn't catch it

The method's own unit tests passed `{ name: 'New' }`, one of the three fields that happened
to work, and cast it `as Record<string, unknown>`. The tool tests asserted the write's
request and response, and the local cache patch, but never read the live cache back
through `get_transactions_live`. TypeScript accepted the bug: `Partial<Transaction>`
admits the snake_case keys, and spreading extra properties is not an excess-property
error. Each layer was tested on its own; nothing tested the round trip across the two
models.

## The fix

The live cache is now patched from the **server's returned row**, not from a translated
local patch. Every transaction mutation already returns the full `TransactionFields`
selection, the same camelCase shape the cache stores. `patchLiveTransaction` is replaced
by `upsertLiveTransaction(node)`, whose parameter is the GraphQL shape: a cache-model
`Transaction` no longer compiles there. The `editTransaction` wrapper now also returns the
transaction it got back. Keys the mutation fragment does not select (`parentId`,
`isoCurrencyCode`) keep their cached values.

An edit never inserts a row the cached month did not have. Its target can be absent
legitimately: a split parent, which the Transactions query omits and the mutation
response does not identify. Inserting it would double-count the parent beside its
children, so an edit of an uncached row invalidates its month instead and the next read
refetches. Only creates and split children insert (found in review of the first version
of this fix, and registered as a second mutation guard).

## Detector

`tests/tools/live-write-coherence.test.ts`: one case per transaction write tool, derived
from `WRITE_TOOL_DEFS` so a new tool without a case fails. Each case seeds a cold month,
writes through the tool's registry handler against a realistic mocked server row, and
reads back through `get_transactions_live`'s handler (the mapper, never the raw cache, where
the dead keys would look like success). It requires a cache hit that reflects every field
the write changed. It was written first and failed red for every #821 caller (and for
#820's create and split) before the fix.

## Lesson

When a write-through crosses two data models, test the round trip through the reader the
user calls, not the writer's output. Checking the cache object would have passed, because
the wrong keys were there.
