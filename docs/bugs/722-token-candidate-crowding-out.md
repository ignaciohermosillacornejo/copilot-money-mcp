---
id: 722
title: A logged-in user could be told to log in, because other sites' Firebase tokens filled the ten-candidate exchange budget before the real session was tried
class: ambiguous-candidate-selection
status: fixed
detected: code-review  # noticed while reviewing #720, the PR that wrote the ten-candidate cap down in PRIVACY.md
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/726
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/722
date: 2026-09-14
---

## Symptom

A user with a live Copilot Money session in their browser runs the server with
`--live-reads` or `--write` and gets:

```
No Copilot Money session found. Searched: Chrome, Arc, … Please log into Copilot Money
at https://app.copilot.money in your browser, then try again.
```

Logging in again does not help, because they never logged out. The message names the one
action that cannot fix it, which is worse than a bare failure: it sends the user away from
the cause. Same shape as [#478](478-foreign-token-project-mismatch.md) — that bug reported
a real state (logged out) in an unreadable way; this one reports a false state confidently.

Reaching it required a browser profile holding ten or more `AMf-` refresh tokens from
*other* Firebase-backed sites, so it was rare rather than impossible. Nobody is known to
have hit it.

## How it was detected

By writing the behaviour down. [#720](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/720)
was a docs-only PR documenting the browser-storage read surface in `PRIVACY.md`, and it
had to state the cap precisely: "at most ten candidates are tried." Reviewing that
sentence raised the question the code never asked — *the first ten of what order?* — and
the order turned out to be disk-discovery order, in which the browser-wide store comes
before a later profile's Copilot store.

Worth recording as a mechanism, because it is not on this corpus's list: no test, probe,
sweep or user found this. Describing a surface accurately enough for a privacy document
did. A claim about a bound is only meaningful together with what the bound applies to, and
writing the claim down is what forced the second half into view.

## Root cause

Two correct-looking halves in different files, wrong only in combination.

`src/core/auth/browser-token.ts` emitted candidates in discovery order, and
`getChromiumProfileStoragePaths` interleaves the two kinds of source *per profile*:

```
Chrome/Default/IndexedDB/https_app.copilot.money_0…   ← Copilot's origin only
Chrome/Default/Local Storage/leveldb                  ← every site's storage
Chrome/Profile 1/IndexedDB/https_app.copilot.money_0… ← Copilot's origin only
…
```

So "prefer the Copilot store" held *within* a profile and nowhere else.
`src/core/auth/firebase-auth.ts:70` then took `candidates.slice(0, 10)`. Ten tokens from
the first profile's browser-wide store therefore consumed the entire budget before the
loop reached a later profile's Copilot-scoped store.

The cap was not the defect. A cap on an arbitrarily-ordered list is *finite but not safe*:
what it discards is whatever happened to sort last. Ordering is what makes discarding
harmless, because then everything dropped came from the low-probability pool.

A second instance of the same class was found while fixing this one and is fixed here too:
any non-`PROJECT_NUMBER_MISMATCH` failure aborted the whole loop, on the reasoning that
such an error "is a real exchange failure for a Copilot-project token." That inference is
false. The extractor finds candidates by regex-scanning raw LevelDB bytes, so a truncated
match is routine — and a probe run for this fix confirms an `AMf-`-shaped non-token is
rejected with `INVALID_REFRESH_TOKEN`, not `PROJECT_NUMBER_MISMATCH`. One garbage string
from any site's storage could end the search for a real session.

## Why the tests didn't catch it

`tests/core/auth/firebase-auth.test.ts:175` tested the cap — 25 foreign candidates, expect
exactly 10 exchanges — and passed for the same reason the bug existed: every candidate in
it was foreign, so *which* ten were tried could not matter. The test asserted the bound and
was silent on the ordering the bound's safety depends on. It was not a weak assertion; it
was a complete assertion about the wrong half.

Nothing else could have caught it. The two halves lived in different files with no shared
fixture, and `TokenResult` had no way to express where a candidate came from, so no test
could have asked the question even if someone had thought to.

## The fix

Root cause: candidates carry provenance (`TokenResult.scoped` — "found in a directory only
`app.copilot.money` writes to"), and every scoped candidate is hoisted ahead of every
browser-wide one before the cap applies. Stable partition, so discovery order survives
within each group.

The ordering is applied in **both** places on purpose: in the extractor, whose
single-candidate wrapper needs it, and again in `FirebaseAuth`, where the cap lives — a
bound whose safety depends on a collaborator having sorted first is not a bound. Each site
is independently mutation-verified below.

Downstream: de-duplication now promotes provenance (a token seen in a browser-wide store
*and* in Copilot's own directory ranks as scoped), and the exchange loop distinguishes a
verdict on a *candidate* from a verdict on the *endpoint* — the former is skipped past, the
latter (5xx, transport, and 429, which is a 4xx by number and a "back off" by meaning)
still stops the run immediately.

Classification is by *meaning*, not by status number. Review and probe together showed
status alone cannot carry it: an invalid API key returns **400** `API_KEY_INVALID` — the
same status a bad refresh token uses — and no key at all returns **403**. Left on the
status rule, a rotated key would have spent the whole budget and then reported "log in"
for an outage logging in cannot fix, which is this bug's own symptom.

Provenance also decides what is worth *reporting*. A rejection from a browser-wide
candidate says nothing about Copilot, so only a **scoped** candidate's unexplained failure
is surfaced raw; everything else still resolves to the actionable "log in" message. Without
that, a logged-out user whose `Local Storage` held one truncated `AMf-` fragment would have
got a Firebase 400 instead — #722's symptom reached from the opposite side.

*Unexplained* then had to be narrowed twice more, because each round of carve-outs changed
what was left in it. After the endpoint-level codes moved out, the codes that could still
reach the raw branch were mostly `INVALID_REFRESH_TOKEN` and `TOKEN_EXPIRED` — a **dead
token**, which is not a mystery at all but the very state the actionable message names. Those
are now explained too; `USER_DISABLED` and any code we have never seen stay raw, because an
unrecognised rejection on a token from Copilot's own store is where a raw error beats a
guess. The same reasoning reached the *fast* path, which refreshes a server-issued token
and used to throw its raw 400: a token the server issued is known-good only until the user
logs out, so a dead one there now falls through to a cold re-extract instead.

The cap stays at ten, and stays a single global budget rather than one budget per source.
With scoped candidates already holding the first slots, a per-source budget could not
improve their chances; its only effect would be to let more of other sites' tokens reach
Google's endpoint.

## Detector

`tests/core/auth/candidate-ordering.test.ts` — class-level, and **mutation-verified** in
every direction it asserts (no count: this sentence has already gone stale twice). It runs
the real extractor over a real temp profile layout built by the production path helper, and
only `fetch` is faked (deciding accept-vs-reject from the token the request actually
carries, which is the one thing that cannot run locally).

| Mutation | Test that goes red |
|---|---|
| extractor returns discovery order | scoped-store preference across profiles |
| `FirebaseAuth` caps without ordering | unsorted extractor result defeats the budget |
| loop aborts on any non-mismatch error | a truncated token / a 403 ends the search |
| de-dup keeps first provenance | token in both stores ranked by weakest source |
| origin match is a bare substring | lookalike `app.copilot.money.example.com` ranks scoped |
| budget trusts the extractor to de-duplicate | one token repeated past the cap starves the session |
| key-level 4xx treated as a candidate verdict | a rotated API key spends the budget, then says "log in" |
| a dead scoped token treated as unexplained | residue after logout reports a raw 400, not "log in" |
| the allowlist inverted into a denylist | an unrecognised future code resolves to "log in" |
| the fast path rethrows instead of falling through | a dead cached token reports a raw 400 |

A second gate came out of the review, and it is the more interesting one: the auth test
files were **not in any typecheck program**, so adding a required field to `TokenResult`
broke nothing anywhere — the existing `as TokenResult[]` assertions silently produced
`scoped: undefined`. They are now in `tsconfig.tests.json`, with the extractor mocks typed
by return annotation rather than assertion, so dropping the field is a build error. Also
mutation-verified.

The class invariant it encodes is broader than the reported bug: *no single candidate may
end the search for a valid one behind it*, whatever its position or failure mode. That is
the sentence [#478](478-foreign-token-project-mismatch.md) should have left behind and did
not — it shipped an instance-only ratchet, and the class recurred here.

Ledger: the three assumptions about Google's token-exchange endpoint that the loop branches
on are now entries in `src/conformance/ledger.ts` (`Securetoken.v1Token:*`), closing the
gap #478's post-mortem recorded. Two are `verified-once`, one is honestly `unverified`.

## Lesson

State the bound and the ordering together, or neither means anything. "At most ten
candidates are tried" is not a safety property until you say ten of *what order* — and the
version of this system where that sentence was true and the system still failed is exactly
the version that shipped.

The corollary is about the detector, not the code: a test that pins a limit should also pin
what the limit is allowed to discard. Ours pinned the number and let the choice go
unobserved for three months.

And one found only by fixing it: a required field added to a shared type is a migration
only where something typechecks. Four files here asserted their way past it with `as`, in a
directory no `tsconfig` covered, so the compiler had no opinion at all.
