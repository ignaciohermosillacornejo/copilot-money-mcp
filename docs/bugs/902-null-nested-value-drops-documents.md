---
id: 902
title: A null price on one holding silently removed a whole retirement account and its balance from every total
class: wire-type-drift
status: fixed
detected: user-report # reporter saw decode_health degraded with one dropped account and filed the stderr schema-drop line
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/916
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/902
date: 2026-11-16
---

## Symptom

An MX-linked 401k was missing from `get_accounts`, and its balance was missing from
`total_balance` and `total_assets`. The Copilot app showed the account normally, and its
balance history was still readable by account id. `get_cache_info` reported
`decode_health: degraded` with `accounts: { dropped: 1 }`, and stderr carried:

```
schema drop: collection=accounts docId=<redacted> path=holdings.0.institution_price
  code=invalid_type message="Invalid input: expected number, received null"
```

Silent where it mattered: net worth and asset totals were understated by the account's
whole balance, and nothing in a normal tool response said so.

## How it was detected

A user reported it, from the same two signals that made #659 actionable: the
`decode_health` summary (#442) told them something was missing, and the `schema drop`
warn (#311) told them which path. Nothing on the maintainer's side would have found it —
the value only exists in caches with an MX-linked brokerage that sends no price for a
fund.

## Root cause

The decoder builds every top-level field of an account with a typed getter
(`getNumber`, `getString`, explicit null handling for `limit` and
`verification_status`), but copies nested containers verbatim: `holdings` is
`toPlainObject(item.value)` per element (`src/core/decoder.ts`, `processAccount`). So
every leaf inside a holding reaches Zod exactly as Copilot wrote it, and Zod is the only
type check it gets. `AccountHoldingSchema.institution_price` is `z.number().optional()`,
which rejects `null`; and a rejected leaf cost the whole document, because
`validateOrWarn` (`src/core/schema-warn.ts`) returned `null` on any failure that the #659
non-finite repair could not fix.

This is the third instance of one shape:

- **#302** — null `vested_quantity` / `vested_value` dropped accounts. Fixed by making
  those two fields nullable (and the sibling Plaid-account schema in a second PR).
- **#659** — an `Infinity` price dropped an account and 18 history months. Fixed at the
  choke point, but only for one kind of value: non-finite numbers.
- **#902** — a `null` price. The #659 repair strips non-finite leaves; `null` is not
  non-finite, so the document still dropped.

Each fix was narrower than the class. #302 was indexed by field, #659 by value; the
class is indexed by *placement* — a value inside a verbatim-copied nested container.

## Why the tests didn't catch it

- **#659's structural sweep** (`tests/core/schema-warn.test.ts`, "non-finite repair") was
  indexed by placement, which was the right axis, but injected only non-finite values.
  It proved that an `Infinity` anywhere could not cost the document, and said nothing about
  a `null` in the same place.
- **Schema unit tests** cover `null` for the fields someone thought could be null
  (`cost_basis`, `vested_*`). Nobody had seen a null price, so no fixture had one — the
  same blind spot #659's entry describes, one value over.
- **`smoke:cache`** scans the real cache for non-finite values only, and the maintainer's
  cache has no MX-linked holdings anyway.
- **`decode_health`** worked as designed: it reported the drop. It is a reporter, not a
  gate.

## The fix

Root-cause fix: `validateOrWarn` now attempts a second repair after the non-finite strip —
`repairNestedIssues` (`src/core/nested-repair.ts`). It reads Zod's issue paths and, for
any failure **below the top level**, removes the rejected value if it is present
(an optional leaf costs that leaf), or the node enclosing it if the value is absent (a
required nested field costs the one holding, contribution or snapshot that lacks it).
It repeats until the document validates, nothing more can be removed, or a bound of eight
rounds runs out (deeper than any current model needs). A failure at the top level is never
repaired, and the repair never climbs to a top-level field: those come from the decoder's
typed getters, so a mismatch there is real shape drift and still drops and warns as
before. Running out of rounds or of things to remove is different — a give-up, not an
expected refusal — so besides the usual `schema drop` it emits a distinct
`nested repair gave up: … reason=exhausted|no-progress` warn rather than passing for the
pre-fix drop.

Repaired documents count as `repaired` in `decode_health`, whose note now names both kinds
of repair, and each removed path is logged once per failure shape as
`invalid nested field: … paths=… code=… message=… — value did not match the schema;
removed, document kept`.

`get_holdings` needed no change: it already skips a holding with no price, so the
repaired account returns with its balance and other holdings intact.

The schema was deliberately left alone. Making `institution_price` nullable would fix
this instance and widen the type every consumer reads (`get_holdings` checks
`=== undefined`), while the next null on the next nested field would drop a document
again. Removing the value gives consumers the absence they already handle.

## Detector

`tests/core/nested-field-sweep.test.ts`: walks **every object schema exported from
`src/models/`**, builds a valid document with every field populated, then at every node
below the top level (array elements, record entries and record keys, nested-object fields
and each leaf in them) injects `null`, a wrong-type primitive, for numbers `Infinity`, and
for record keys a key the key schema rejects, and asserts
the document still decodes through `validateOrWarn` with all of its top-level fields and
zero drops. Cases are derived from the schemas, so a nested field or model added later is
swept the day it lands; a schema the sampler cannot build fails a named test instead of
escaping. A control half asserts that a required top-level field set to `null` still
drops, so the repair cannot quietly swallow top-level drift.

**Mutation-verified**: disabling the nested repair in `validateOrWarn` (keeping #659's
non-finite strip) turns 142 of the sweep's 218 tests red, and all three end-to-end
regression tests in `tests/core/nested-repair-decode.test.ts`.

Siblings checked: the nested containers in `AccountSchema.holdings`,
`PlaidAccountSchema.holdings` (the #302 sibling), `AmazonOrderSchema.items`,
`GoalHistorySchema.contributions` / `daily_data`, `HoldingsHistorySchema.history`,
`BudgetSchema.amounts`, `InvestmentSplitSchema.adjustments`, and every string-id array
were all exposed to the same drop and are all covered by the sweep. Live-mode reads were
not affected: GraphQL response validation is warn-only and never drops a row.

## Lesson

#659's lesson was "schema validation at a decode boundary should degrade to less data,
never to no record" — and its fix then degraded only for one kind of bad value. When a
fix is meant to close a class, index the detector by every axis the class varies on
(here: placement *and* value), or the next value in the same place is the next bug report.
