---
id: 904
title: Cache-mode get_accounts counted an account Copilot had auto-merged into another, putting its frozen balance in the totals
class: ui-parity
status: fixed
detected: user-report # reporter noticed total_liabilities included an old card record the app no longer shows
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/928
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/904
date: 2026-11-19
---

## Symptom

Cache-mode `get_accounts` returned an account that the Copilot app does not show: an older
card record that Copilot had auto-merged into its successor. Its document carried
`merged: { end_date, source: "auto" }` and no `user_deleted`. The old record's frozen
balance was counted in `total_liabilities`, so net worth was off by that amount while the
account list looked plausible. The failure was silent: nothing on the row said why the app
leaves it out. `get_holdings` appeared correct only because a card has no positions.
A merged brokerage would have double-counted there too.

## How it was detected

A user report, split out of #902 as its second point. Nothing we run could have caught
it. The maintainer cache holds no merged account document (measured while fixing: 22
account documents, none carrying `merged`, and no `merged` field in any collection), so no
fixture, smoke or probe here has ever seen the shape.

## Root cause

`isVisibleAccount` (`src/models/account.ts`) read `user_deleted` and `user_hidden` only.
#82 had hidden merged accounts by `user_deleted`, because the one merged account seen then
carried it. That made `user_deleted` a stand-in for "merged", and this merge path does not
set it. `merged` was decoded into `Account.merged` and never consulted. Both consumers of
the rule (`get_accounts` rows and totals, `get_holdings`) inherited the gap.

## Why the tests didn't catch it

- The fixtures covered the two flags the rule already read. The only fixture carrying
  `merged` (`tests/core/decoder-coverage.test.ts`) was an invented
  `{ from_account: ... }` shape that checked decoding only, not visibility.
- `smoke:cache` check 7 re-derives the rule from raw fields, and its agreement test with
  `isVisibleAccount` enumerated only the flags both already knew, so a missing third term
  was invisible to it.
- No check compared cache visibility against live visibility per account. The one
  cache-vs-live account smoke (`smoke:account-names`) passes `include_hidden: true` to both
  sides on purpose, so it never looks at visibility at all.

## The fix

Root cause: `isVisibleAccount` hides an account whose document carries a `merged` map,
whatever its `source`. The fields the rule reads are one exported list,
`ACCOUNT_VISIBILITY_FIELDS`, and `get_accounts`' default field preset carries every member (a test fails if it does not), so a row
returned under `include_hidden: true` still shows the `merged` map that hid it. Also
changed: `smoke:cache`'s raw re-derivation reads `merged` the way the decoder does, the
decoder fixture uses the reported shape, and the tool descriptions say merged accounts are
excluded.

## Detector

- `tests/models/account-visibility.test.ts` (mutation-verified: dropping the `merged` term
  fails it and the two tool tests). It requires each field in `ACCOUNT_VISIBILITY_FIELDS`
  to hide an account on its own, and the rule to read exactly that list, checked with a
  Proxy that records what the rule reads. It also requires the default preset to carry
  the list. This catches a term added to the rule but not the list, or to the list but
  not the preset. It cannot find a marker nobody has written down yet.
- `smoke:account-visibility` (new, in the `bun run smoke` composite) is the class-level
  oracle for that remaining gap. It applies `isVisibleAccount` to every cache document
  and `isUserHidden`/`isUserClosed` to every live `Accounts` row, and FAILs when an account
  is visible in one mode and hidden in the other. That is the shape of #82, #624 and this
  bug. It needs real data, so it runs in the weekly drift check, not CI. On the
  maintainer's data it passes with no merged account present and says so, so the `merged`
  term itself is still unexercised by anything we run.

## Lesson

A flag that happens to coincide with a state is not the state: `user_deleted` stood in
for "merged" because the one example seen had both. When a rule exists in two vocabularies
(cache document, GraphQL wire), the cheapest real check is to apply both to the same
accounts and compare. That comparison is now in the weekly drift check.
