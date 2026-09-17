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

`bun run check:mutation-guards` (`scripts/mutation-guards.ts`), in `bun run check` and as a
step in `.github/workflows/test.yml`. It is a ledger of designated safety invariants: each
row carries the exact edit that disables one guard and the single test file that must go red
when it does, and the runner asserts BOTH directions — the file passes unmutated and fails
mutated. A guard whose removal leaves its detector green is reported as `VACUOUS`, which is
the shape of this bug caught mechanically rather than by a reviewer who happened to be told
to mutation-test.

Three details are there because the gate could otherwise carry the very defect it checks
for. The mutated run must execute the same number of tests as the baseline and report no
module-level error, so a `find` string that merely breaks the parse cannot pass as a
detection. The baseline must be green, so an always-failing test cannot be registered as
proof. And every guard carries a `// mutation-guard: <name>` marker at its site which the
gate requires to be in bijection with the registry, so deleting a row — the cheapest way to
make a ledger quiet — leaves an orphaned marker and fails.

Six guards are registered, not the five proposed in the issue: three of those five were
ambiguous (matched twice) or inert (removing the string left the `throw` standing), and the
`skipped`-rows entry turned out to name two distinct guards, `bulk_edit_transactions` and
`review_transactions`, which are now separate rows.

Scope, stated because a ledger invites being read as coverage: this proves the registered
invariants have detectors. It says nothing about the rest of the suite, where a vacuous
assertion is still only findable by writing one deliberately or by mutation-testing by hand.

## Lesson

For any safety guard, derive the test by deleting the guard first and watching what fails —
if the answer is "nothing," the test asserts a message, not a property. And a claim of
"mutation-tested" is worth nothing unless a machine re-checks it; coverage percentages are
structurally incapable of substituting.
