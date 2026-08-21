---
id: 659
title: An Infinity price in the cache silently removed a whole investment account and 18 months of holdings history
class: wire-type-drift
status: fixed
detected: user-report # reporter read decode_health, saw 19 dropped documents, and filed the stderr warnings
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/667
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/659
date: 2026-08-21
---

## Symptom

`get_cache_info` reported `decode_health: degraded` — 19 documents dropped, 18 in
`holdings_history` and 1 in `accounts` — with stderr warnings whose message reads like a
typo:

```
schema drop: collection=accounts docId=<redacted> path=holdings.0.institution_price
  code=invalid_type message="Invalid input: expected number, received number"
```

The user-visible consequence was larger than the warning suggests, and silent: the dropped
`accounts` document was an entire investment account, so it was absent from `get_accounts`
and from every total computed over it — a real account, with a real balance, that the tool
simply never mentioned. The 18 `holdings_history` documents were 18 months of price
history missing from `get_holdings(include_history: true)`.

## How it was detected

A user reported it. Nothing here caught it: the reporter's cache contained the value and
the maintainer's did not — a scan of 54,259 real documents in the maintainer's cache found
zero non-finite numbers, so no amount of dogfooding on this machine would have surfaced it.
What made the report actionable was `validateOrWarn` (#311) and the `decode_health` summary
(#442): the drop was loud enough for a user to see it, quote it, and count it. That is the
detector from #302 paying off one class-instance later.

## Root cause

Firestore stores IEEE-754 doubles, and IEEE-754 has three values JSON and Zod do not:
`NaN`, `Infinity`, `-Infinity`. Copilot writes one of them — a holding whose quantity is 0
gets an `Infinity` price, since the price is a value/quantity division upstream — and
`src/core/protobuf-parser.ts:249` reads it back faithfully, because the wire format says so.

Zod v4 rejects all three from `z.number()`, and a rejected leaf cost the WHOLE document:
`validateOrWarn` (`src/core/schema-warn.ts`) returns `null` on any parse failure, and every
`process*` function treats `null` as "no document". One unusable price therefore deleted an
account.

Two details worth recording:

- **The message is not a typo, it is a version tell.** Zod v4 reports `NaN` as
  `received NaN` and non-finite numbers as `received number`. "expected number, received
  number" therefore means `±Infinity` specifically — the reporter's NaN hypothesis was the
  natural reading and the wrong one.
- **It was a regression, not a longstanding defect.** Zod 3 accepted `±Infinity` from
  `z.number()` (it rejected only `NaN`). The dependency bump `d5034c0` (3.25.76 → 4.3.5,
  first released in v1.2.3) tightened it. That account decoded fine before v1.2.3 and had
  been vanishing quietly ever since.

## Why the tests didn't catch it

- **Unit and decoder tests**: every synthetic fixture in the suite is written in TypeScript
  object literals by someone thinking about the field's meaning. Nobody writes
  `institution_price: Infinity`, because nobody thinks of a price as non-finite — the value
  only exists because a division upstream produced it. The fixtures and the schemas shared
  the same blind spot.
- **`smoke:cache`** (the real-cache gate, #622): it runs against whatever cache the machine
  has. The maintainer's has no non-finite values, so the check that would have found this
  did not exist to be run — nothing enumerated *values Firestore can hold that Zod cannot*.
- **`decode_health`**: worked exactly as designed. It reported the drops; it just had no
  reader until a user ran it.

## The fix

Root-cause fix ([#667](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/667)):
`validateOrWarn` now attempts one repair before giving up on a document — strip non-finite
numeric leaves (`src/core/non-finite.ts`) and re-validate. Documents that become valid are
kept, with the stripped paths logged and counted; documents that fail for any other reason
still drop and warn exactly as before, so the repair cannot mask an unrelated mismatch.
Fields are removed rather than nulled because the schemas declare them `z.number().optional()`,
which accepts absence and rejects `null`.

Downstream: `decode_health` gained a `repaired` counter per collection and a note that says
plainly which documents lost a field, so partial loss is reported rather than swallowed.
`get_holdings` needed no change — it already skips holdings with no price, so the repaired
account returns with its balance and its other lots intact.

The fix is deliberately at the choke point rather than on `institution_price`. #302 fixed
the field that hit it (`vested_*` → nullable) and left the whole-document drop in place;
this is the second time that behaviour turned a one-field mismatch into missing accounts.

## Detector

Two, at different layers:

1. **Structural sweep** (`tests/core/schema-warn.test.ts`, "non-finite repair"): asserts a
   document survives a non-finite leaf in each place one can sit — a top-level field, an
   object nested in an array (`holdings.0.institution_price`), and a dynamically keyed
   record (`history.<epoch>.price`). It is indexed by *placement*, not by schema, because
   the field that happened to be hit is an accident of one user's brokerage while the walk's
   branches are what can actually be wrong. **Mutation-verified**: removing the repair block
   from `validateOrWarn` turns every row red.
2. **Reality check** (`scripts/smoke/cache.ts`, `non-finite values`): scans the real cache
   for non-finite numeric leaves and reports the collection and path (map keys redacted).
   It WARNs rather than FAILs — the value is not our bug and no longer costs data — but it
   is the only thing that can answer "does this class occur in the wild, and where", which
   is exactly the question this bug's fixtures could not answer.

## Lesson

The blast radius of a validation failure is a design decision, and this project has now
made the wrong one twice: discarding a document over one leaf turns a cosmetic type
mismatch into a missing bank account. Schema validation at a decode boundary should degrade
to *less data*, never to *no record*. The second-order lesson is cheaper: when a foreign
format is richer than your type system — IEEE-754 has three values JSON does not — the gap
is enumerable, so enumerate it once at the boundary instead of waiting for each value to
arrive in a bug report.
