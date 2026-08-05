---
id: 224
title: Tag filter searched for #hashtags in transaction names; real tags live in tag_ids
class: external-api-drift
status: fixed
detected: live-probe  # tags written via update_transaction were invisible to the tag filter during write-tool smoke testing
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/224
issue: none — found and fixed directly
date: 2026-04-13
---

## Symptom
`get_transactions` with a `tag` filter (and `transaction_type: 'tagged'`) returned zero or wrong results for transactions that actually had tags. A tag applied via `update_transaction` succeeded, persisted, and showed in the app — but the read filter could not find it. Writes appeared to vanish.

## How it was detected
Discovered during the write-tools era while exercising `update_transaction`: programmatically-set tags never showed up in tag-filtered reads. The write path and the app agreed; only our read filter disagreed.

## Root cause
The filter in `src/tools/tools.ts` was built on an imagined data model: it regex-matched `#\w+` patterns inside `txn.name` / `txn.original_name`, assuming Copilot tags are hashtags embedded in transaction names. Copilot actually stores tag membership in a `tag_ids` array on the transaction document. The read path encoded an external data shape that reality never had — no amount of correct writing could make it visible.

## The fix
Both the `tag` parameter and the `tagged` transaction type now check the `tag_ids` array instead of name-pattern matching. Tool descriptions were updated to stop advertising hashtag semantics.

## Detector
none — instance-only regression tests. Notably, the fix itself planted the next bug in this area: it compares the caller's `tag` input (a display name) directly against `tag_ids` entries — an identity-resolution error (name vs id space) that survived until 2026-05-12, when the cache-mode tag filter was fixed to resolve name→id first.

## Lesson
Verify the wire/cache shape of a field against a real document before building a filter on it — a filter built on a guessed shape fails silently with empty results. And when fixing a shape bug, check which id space each side of the new comparison lives in; this fix traded a wrong-shape bug for a wrong-id-space bug.
