---
id: 843
title: transaction_type refunds and credits selected different, even disjoint, rows in cache and live mode
class: path-divergence
status: fixed
detected: live-probe  # release parity row TXN-08 compared both modes over the window both cover
fixed_in: not yet
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/843
date: 2026-10-18
---

## Symptom

The same `transaction_type` filter over the same window returned unrelated sets depending on
the mode. Live `refunds` returned every negative amount, so paychecks came back as refunds;
cache `refunds` returned nothing. Live `credits` and cache `credits` shared no row at all.
`hsa_eligible` agreed only partly (cache a strict subset of live). Silent in both modes: each
answer looked plausible on its own, and only putting them side by side showed the problem.

## How it was detected

The release parity skill's row TXN-08 ran each value in both modes over the window both
cover and compared ids. The divergence was predicted by reading the code before the run; the
run confirmed it on real data.

## Root cause

Two implementations of one parameter. `src/tools/live/transactions.ts` (`postFilter`, step 9)
had its own one-line predicates (`amount < 0`; `amount < 0 && type === 'INCOME'`; category
name contains health or medical), and `src/tools/tools.ts` (`_filterByTransactionType`) had
keyword rules over the merchant name that exclude income. Neither described what it selected,
so neither could be checked against the other or against intent. Cache mode had also lost its
only income guard: since #824 the decoder clears `category_id` on income rows, so
`isIncomeCategory(txn.category_id)` could no longer recognise one.

## Why the tests didn't catch it

Each mode's tests pinned its own predicate (`refunds filters to negative amounts` in live,
an hsa row in cache), so each suite encoded its own meaning and stayed green. No test fed one
fixture to both modes.

## The fix

One rule per value, in `src/tools/transaction-type-rules.ts`, evaluated over a mode-neutral
row that each mode builds with a small adapter (`cacheTypeRuleRow`, `liveTypeRuleRow`). The
rules are stated in both `transaction_type` descriptions from one string beside the
predicates. The decoder now derives an `income` boolean from the document `type`, as it does
`internal_transfer`, which is what lets cache mode apply "never INCOME".

## Detector

`tests/tools/transaction-type-parity.test.ts`: every value live mode accepts is run through
both tools' real entry points over one fixture (opaque ids, cache names upper-cased as on
disk, a negative INCOME row, an INCOME row with a credit keyword, a transfer) and must return
the same ids, plus the ids written out per value. It also fails if live mode accepts a value
the shared rule table does not define. Mutation-checked: making the live adapter treat INCOME
as REGULAR turns the `credits` case red. The detector covers this parameter only; other
filters that exist in both modes (`category`, `exclude_excluded`) are not swept by it.

## Lesson

A parameter both modes accept is one contract, so it needs one implementation and one test
that runs both modes over the same rows. Two suites that each test their own mode cannot
notice that the modes disagree.
