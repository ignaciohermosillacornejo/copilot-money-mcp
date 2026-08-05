---
id: 394
title: Cache-mode tag filter compared tag names against opaque tag IDs — always zero results
class: identity-resolution
status: fixed
detected: dogfooding  # filtering by a tag known to exist returned zero rows
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/394
issue: none — found and fixed directly (tracked in project memory for a month as an open suspicion)
date: 2026-05-12
---

## Symptom
Cache-mode `get_transactions` with a `tag` filter returned zero transactions for any normally-created tag, even when tagged transactions demonstrably existed.

## How it was detected
Empirically, while exercising tags end-to-end: a tag was written to a transaction via `update_transaction`, the cache was confirmed to hold the tag's opaque Firestore ID in `tag_ids`, and the filter still returned nothing. The bug had been suspected in project memory for over a month before the clean repro.

## Root cause
The filter compared the user's input tag NAME directly against `txn.tag_ids`, which holds opaque Firestore-generated IDs (e.g. `9qyEMnfMXknwvx9OnYhk`). The two live in different identifier spaces and never match — except for one legacy tag whose id happened to equal its name, which was exactly the shape the test fixtures used (`tag_ids: ['work']` for a tag named `work`). The fixtures' id-equals-name convenience masked the bug completely.

## The fix
Resolve the input name to one or more tag IDs via the cached `tags` collection before filtering (case-insensitive, `#` prefix stripped, falling back to `tag_id` when a tag has no name so legacy shapes still work). Fixtures were rewritten with realistic opaque IDs across six scenarios so the original masking is impossible to reintroduce the same way.

## Detector
None at the time of the fix — instance-only regression tests, plus a repo convention ("fixtures must use realistic Firestore-shaped opaque IDs; id-equals-name fixtures mask resolution bugs") applied by hand in review.

The class-level gate landed later: `assertOpaqueIds` in `tests/helpers/test-db.ts` (issue #461) now throws when any ID-keyed fixture document has an id equal to its own display name, so the specific masking that hid this bug cannot be reintroduced. Note what it does and does not cover — it makes the *fixture* honest, so a name-vs-id comparison fails loudly in tests. It does not detect identifier-space confusion in general; nothing checks that a filter compares values from the space the data actually uses.

## Lesson
Whenever a filter accepts a human-readable value, the first question is which identifier space the stored data uses — and the second is whether the fixtures would fail if the answer were "a different one." Trivial fixtures where id == name test nothing about resolution.
