---
id: 596
title: Two tests in the bulk-edit PR executed safety guards but could not fail if the guards were deleted
class: vacuous-assertion
status: fixed
detected: adversarial-review  # independent adversarial review explicitly instructed to mutation-test the guards rather than eyeball them
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/587 (commit cada00b, pre-merge)
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/596
date: 2026-08-02
---

## Symptom

No user-visible symptom — which is the point of the class. Two tests in the
`update_transactions` bulk-edit PR (#587) were green for both the correct and the broken
behavior:

1. **Stop-on-first-failure had zero effective coverage.** Deleting *both* `stopOnError`
   guards in `runBoundedPool` left all 2,435 tests passing. The only default-mode test
   asserted the error *message* — `/failed at transaction_id=txn-05 (\d+\/8 succeeded)/` —
   and `\d+` matches whether the batch stopped after the failure or ran every row. Had the
   guard been refactored away, a 200-edit batch failing at row 3 would have written the
   remaining 197 edits against real financial data, with an error string indistinguishable
   from correct stopped-early behavior.
2. **A steering ratchet pinned nothing.** `/name.*note.*date.*amount/` was meant to pin a
   specific steering sentence in a tool description but actually matched the description's
   unrelated field *enumeration*; deleting the sentence stayed green. Worse, the commit
   message claimed the test had been mutation-tested — part of the test had been, that
   assertion had not.

## How it was detected

An independent adversarial review of the rebased PR, explicitly instructed to
mutation-test rather than read: delete the guard, run the suite, see if anything notices.
Codecov reported 98.7% patch coverage and both guards were *executed* by tests — line
coverage answers "did this run," not "would anything notice if it were wrong." Review
caught it only because mutation-testing was demanded; that is luck, not a repeatable
property of review.

## Root cause

Both assertions were predicates satisfied by correct *and* broken behavior. The
stop-on-failure test pinned the error message instead of the property ("entries queued
behind the failure are never attempted"); the ratchet regex was anchored to text that
survives deletion of the thing it was supposed to protect. A meta-cause: "mutation-tested"
existed as an unverifiable claim in commit messages and PR bodies, so an overclaim
propagated unchallenged.

## The fix

In-PR, before merge (commit cada00b): a new test pins the actual property — with a 20-edit,
5-wide pool where entry 0 rejects and entries 1–4 are slow, entries 5..19 must never reach
the wire — and was verified to fail when the guards are deleted. The ratchet was
re-anchored on the real steering sentence and verified the same way.

## Detector

None automated yet — this is the class's canonical entry precisely because the proposed
class-level detector is still an open issue (#596): a mutation-guard registry
(`check:mutation-guards`) that applies each registered guard's exact mutation and asserts
the named test file fails, turning "mutation-tested" from a PR-body claim into something CI
verifies. Five seed guards were hand-verified during #587/#595. Until the registry lands,
the only defense is the manual mutation-test ritual, which this incident demonstrates is
not reliably applied — one of the two vacuous tests carried a false "mutation-tested"
claim.

## Lesson

For any safety guard, derive the test by deleting the guard first and watching what fails —
if the answer is "nothing," the test asserts a message, not a property. And a claim of
"mutation-tested" is worth nothing unless a machine re-checks it; coverage percentages are
structurally incapable of substituting.
