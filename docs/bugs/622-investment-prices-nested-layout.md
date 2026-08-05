---
id: 622
title: get_investment_prices returned rows that named no security, mislabelled their type, and silently dropped 91% of documents
class: fixture-reality-drift
status: fixed
detected: incidental  # found while working on something else (scoping the #605 token diet)
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/623
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/622
date: 2026-08-05
---

## Symptom

Every row `get_investment_prices` returned looked like this:

```json
{ "investment_id": "2025-06", "price_type": "hf",
  "prices": { "1748836800000": 000.00 } }
```

`investment_id` held a **month**. `tickers` came back empty. `price_type: "daily"` returned zero rows. There was no way to tell which security any row described — and most documents never appeared at all.

This had been true since the tool was written. It was never reported, because a caller has no way to know the answer is wrong: the response is confidently shaped and internally consistent.

## How it was detected

Not by a test, and not by a bug report. It surfaced while scoping [#605](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/605), a pure **token-diet** task — an audit had measured this tool as the worst context offender, ~98% of its response being a nested price series, and the plan was simply to drop the series by default.

Writing that required knowing what a row looked like, so the tool was called against the real cache before any code was written. The output was self-evidently broken.

**The generalizable part:** the bug was found by *looking at real output*, which nothing in the workflow otherwise required. A performance task became a correctness task only because the first step happened to be "call it and read the result."

## Root cause

Copilot stores prices as one subcollection per security:

```
investment_prices/{security_id}/daily/{YYYY-MM}
investment_prices/{security_id}/hf/{YYYY-MM-DD}
```

The security identity exists **only in a middle path segment**. The decoder treated the collection as flat, and four defects followed:

1. **No identity.** `processInvestmentPrice` did `getString(fields, 'investment_id') ?? docId`. Real documents carry no `investment_id` field, so it fell back to the document id — the period. The security hash was in the collection path, which the function never read.
2. **No ticker.** `ticker_symbol` isn't on the document either; it lives in `securities`, and nothing joined them. So `tickers` was always `[]` and the ticker filter could never match.
3. **Wrong type label.** `price_type` came from `key.includes('/daily/')` — a substring test against the **raw LevelDB key**. Production keys are binary ordered-code, so the literal never appears and every row fell through to `hf`. The `daily` documents were mislabelled and `price_type: "daily"` matched nothing.
4. **Silent data loss.** Dedup keyed on `` `${investment_id}-${date||month||'unknown'}` ``, which given (1) evaluated to the same string for every security sharing a period. Measured on a real cache: **863 documents in, 78 rows out — 91% discarded**, with no error.

There was also a **path divergence**: the standalone `decodeInvestmentPrices` matched the *leaf* segment and found **0** documents, while the aggregate `decodeAllCollections` carried a bespoke extra clause and found all 863. Which one ran depended on load order. Nothing compared them.

## Why the tests didn't catch it

The fixture built a **flat** `investment_prices` collection with `investment_id` and `ticker_symbol` present as document fields — a shape Copilot does not produce. The fixture satisfied every assertion the decoder needed, so the suite was green and always had been.

The diagnostic signature of this class: **fixing the bug made the tests fail.** Twelve went red.

Two mechanical details made it worse, both worth knowing:

- The fixture writer emits **utf8** keys; production keys are **binary**. Any logic that inspects the raw key takes one branch in tests and the opposite in production. Defect 3 was therefore untestable by construction.
- The string-key format caps fixtures at three path segments, so deeper documents are silently dropped from iteration — while real transactions, `balance_history`, and `holdings_history` all live at depth 5+.

Other defenses that were in place and still missed it:

- **`warnUnreadFields`** fires on fields *present in real data but unread*. This is the mirror image: fields the code read that **don't exist**, plus collection-level structure a per-document field diff cannot see. It had even fired on these documents during an earlier triage — about an unrelated field.
- **decode-coverage** measures *routing*, not correctness. The aggregate path's bespoke clause claimed the documents, so coverage read healthy while every row was mangled.
- **The conformance ledger** is scoped to the GraphQL boundary. No decode assumption has an entry.
- **`real-database.test.ts`** — a real-data oracle already existed, but it is opt-in, in no gate, and its assertions are Zod-shape-level, which garbage satisfies: `investment_id: "2025-06"` is a perfectly valid string.

## The fix

- `iterateDocuments` gained `collectionRoot` for collections whose documents live under per-entity subcollections; `collection` is now documented as a **leaf** match.
- Both collection-filter sites share one predicate, so they cannot drift again.
- `processInvestmentPrice` takes the **parsed collection**, never the raw key. `security_id` and `price_type` come from the path; the period comes from the document id.
- Dedup/sort keys on `(security_id, price_type, period)`, shared by both decode paths.
- `ticker_symbol` is joined from `securities` in the database layer, before the ticker filter runs.
- `security_id` replaces `investment_id` as the row identity.
- **Fixtures now build the real nested layout**, including the nested `prices` map. This is the root-cause fix; everything else is downstream.

## Detector

Two, both mutation-verified (reintroducing each defect turns specific tests red):

1. **`tests/core/decode-path-parity.test.ts`** — every collection reachable by both a standalone `decodeX()` and the aggregate `decodeAllCollections()` must return identical rows. This bug *was* a 0-vs-863 disagreement between two paths that nothing compared. Needs no real data.
2. **Raw-key ratchet** — no `process*` helper may accept the raw LevelDB key, because such logic takes opposite branches in fixtures and production and so cannot be tested.

Neither detector would have caught the *sibling* found the same day ([#624](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/624)), where the collection is simply empty and both decode paths correctly agree there is nothing to decode. That gap is the argument for a real-cache invariant scan.

## Lesson

A synthetic fixture for a reverse-engineered external format proves only that the code agrees with its author's assumption. When the fixture and the code come from the same belief, their agreement carries **zero information** — and the suite's greenness is actively misleading.

The cheap habit that found this: **call the tool against real data and read the output** before optimizing it. The structural fix: make fixtures derive from observed reality, and put a detector on any pair of code paths that must agree.
