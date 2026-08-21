---
id: 662
title: Content-based dedup key silently dropped real accounts — the same defect as #122, in the collection nobody swept
class: identity-resolution
status: fixed
detected: code-review  # reviewing a contributor PR (#660) that touched account naming; the dedup was adjacent, not the subject
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/667
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/662
date: 2026-08-21
---

## Symptom

Cache-mode `get_accounts` returned fewer accounts than the user has. On a real cache it
returned **two fewer** than the live GraphQL surface did for the same user: three
investment accounts shared one institution-supplied `name` and carried no `mask`, so two
of the three were discarded during decode.

This is the silent kind. No error, no warning, no count mismatch surfaced to the caller —
the response looked complete, and the only way to notice was to compare against a second
source. The two dropped accounts happened to carry no balance, so net worth was correct by
luck; the key drops any same-name/same-mask pair regardless of balance.

## How it was detected

Reviewing PR #660, an external contributor's fix making `get_accounts` prefer the user's
`nickname` over the institution label. The dedup was not the subject of that PR and the
contributor had no reason to look at it.

Worth being precise about the mechanism, because it was nearly luck: verifying #660 meant
comparing cache output against live output account-by-account, and that comparison — run
for a different reason — put a count discrepancy between the two modes on screen. The confirmation
came from an artifact already sitting in the terminal: the decoder had logged an
`unread field: collection=accounts docId=…` warning for a document that was **absent from
its own return value**, proving the document was read and then thrown away rather than
missing from the cache.

No gate caught this. Nothing would have, until someone next compared the two modes.

## Root cause

`decodeAccounts()` (`src/core/decoder.ts:325`) deduplicated with the key
`` `${getAccountDisplayName(acc)}|${acc.mask ?? ''}` `` — that is,
`name ?? official_name ?? 'Unknown'` joined to the mask. `decodeAllCollections()`
(`src/core/decoder.ts:2977`) shipped a second, independent copy of the same key.

The dedup's *intent* is to collapse one Firestore document appearing multiple times across
LevelDB levels — a storage artifact. The key used **content** as identity. Two accounts at
one institution routinely share a provider name (generic labels like a card product name
are assigned per-product, not per-account) and investment sub-accounts often have no mask
at all, at which point the key degenerates to `name|` and every such account collides.

`account_id` was available on every decoded row the whole time: `processAccount` falls
back to the Firestore documentId, so the identity key can never be absent.

Two aggravating details:

- The dedup runs **before** anything consults `nickname`. A user who renames two
  identically-named accounts precisely so they can be told apart gets no benefit — which
  partly defeats #660, the PR that surfaced this.
- Accounts were the **only** content-keyed dedup left in the decoder. Transactions,
  recurring, budgets and goals all key on their document id.

## Why the tests didn't catch it

- **No test asserted a count.** `decodeAccounts` had two tests: one account in, one out;
  three accounts with three distinct names in, three out. Neither seeded a name collision,
  so the key's failure mode was never exercised.
- **`decode-path-parity.test.ts` was blind by construction.** It proves the standalone and
  aggregate decoders agree. Both carried the same bad key, so they agreed — correctly, and
  uselessly. A parity gate cannot see a defect present on both sides.
- **The real-cache decode gate measures decode success, not survival.** A document that
  decodes cleanly and is then dropped by a downstream dedup counts as decoded.
- **The class was already named and the sibling never swept.** #122 fixed exactly this bug
  in transactions in March 2026, wrote down the lesson — *"Dedup keys are identity claims…
  key on the storage identity (document ID), never on a content tuple"* — and applied it
  in both `decodeTransactions()` and `decodeAllCollections()`. The accounts dedup, a few
  dozen lines away in the same file with the same shape, was not audited. #122's own
  Detector section records the gap honestly: *"Instance tests only for the dedup key
  itself."* Five months later that gap was still open.

## The fix

PR #667. Root-cause fix: extract `deduplicateAccounts()` keyed on `account_id`, mirroring
`deduplicateTransactions()`, and call it from both decode paths — removing the second copy
of the key rather than correcting it in place.

Everything else is downstream: an instance regression test for two same-name/no-mask
accounts, and the class detector below.

## Detector

`tests/core/dedup-identity.test.ts` — new, and the class-level gate #122 never got.

For every collection the decoder dedups (transactions, accounts, recurring, budgets,
goals) it seeds **two documents identical in every content field, differing only by id**,
then asserts both survive — on the standalone decoder *and* on the single-pass aggregate,
since this defect shipped two independent copies. Any future dedup that reaches for a
content heuristic instead of an identity fails here, whatever field it picks.

**Mutation-verified.** Reintroducing the old key in `deduplicateAccounts` turns three tests
red — the instance regression test plus both account paths in the detector — while the
nine sibling-collection assertions stay green, confirming the detector is specific to the
defect rather than sensitive to any change. Per the #596 discipline, executing a guard is
not the same as detecting its deletion.

Note what this detector still cannot see: it proves distinct documents survive, not that
true storage duplicates are collapsed. `createTestDb` writes one row per id, so a genuine
double-stored document is not expressible in the fixture — the same limitation #122 had.

## Lesson

#122 already wrote the right lesson. The failure here was not knowing it — it was never
asking *"where else does this shape exist?"* A named bug class earns its keep only if
filing one is followed by sweeping its siblings; otherwise the taxonomy is a record of
bugs found rather than a tool for finding them. #624 got this right (found by deliberately
auditing siblings of #622) and this one did not.

Concretely: when a fix's lesson is "never key X on Y", the same commit should grep for
every other place that keys on Y. Here that was one `grep` over one file, and it would have
turned up the accounts dedup in March.
