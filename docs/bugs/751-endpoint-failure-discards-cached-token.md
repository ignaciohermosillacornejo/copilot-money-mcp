---
id: 751
title: An endpoint-level failure discarded a known-good refresh token, so the next call re-read every browser profile
class: proxy-for-authority
status: fixed
detected: code-review  # surfaced while reviewing the fast-path guard added by #749
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/760
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/751
date: 2026-09-16
---

## Symptom

Silent, and paid in privacy rather than in wrong answers. In `--live-reads` or `--write`
mode, if Google's token endpoint answered a refresh with `429`, `403 PERMISSION_DENIED`,
or a `400 API_KEY_INVALID` — none of which say anything about the token that was sent —
the *next* tool call could no longer refresh the credential it already held. It fell into
a cold extraction instead: a browser-wide Local Storage read across every profile of every
installed browser, plus up to `MAX_EXCHANGE_CANDIDATES` exchanges against the very
endpoint that had just rate-limited us. A transient outage cost a re-scrape of every
site's Firebase tokens, and did so while the credential that would have worked was still
valid.

Nobody reported it. It would look, from the outside, like a slow call after a blip.

## How it was detected

Reading the code around a different fix. [#749](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/749)
made the fast path *rethrow* endpoint-level failures instead of swallowing them into a
cold re-extract — the right call, and it drew attention to the fact that by the time that
new guard ran, `exchangeToken` had already thrown the token away three lines earlier. The
guard and the discard disagreed about what the failure meant, and only the guard had been
looked at.

Nothing else was going to find it. No test asserted anything about the *survival* of the
cached token, and both #722 and #749 had written tests about which error the caller sees,
which is invariant under this bug.

## Root cause

`src/core/auth/firebase-auth.ts`, in `exchangeToken`: `this.refreshToken = null` ran
unconditionally inside `if (!response.ok)`, before the error was thrown.

The mechanism is the class. Discarding the cached token is a verdict — *this token is
finished* — and the only thing entitled to deliver it is a statement the endpoint made
about the token. "The request failed" was used as a stand-in for that statement. It is a
faithful stand-in whenever the endpoint really did reject the token, which is the common
case and the one anybody testing by hand would produce; it is wrong for every failure that
is about the endpoint, the API key, or the network. The module already drew that exact
line for two other decisions (`isCandidateRejection` in the candidate loop, and again in
the fast path's catch). This was the third site, and the only one that had never been
asked the question.

## Why the tests didn't catch it

- The suite had eight tests over this classification and every one of them asserted which
  **error the caller sees**. The bug does not change the error; it changes what is left
  behind afterwards, and no test made a third call.
- #749's fast-path tests come closest — they assert the extractor was not invoked a second
  time — but they stop at the call that fails. One more `getIdToken()` would have shown it.
- Coverage was no help: the line executed in every one of those tests. It was doing the
  wrong thing in full view.

## The fix

Root cause: the discard is now gated on `isTokenFinished(err)` — a candidate-level
rejection that is also explained by being logged out — and the fast path's fall-through
condition *is that same predicate*, extracted rather than duplicated. That matters beyond
tidiness: the file's standing claim that "falling through cannot leave a dead credential
cached" is now true by construction instead of by two expressions happening to agree.

Downstream: `DEAD_TOKEN_CODES`, `ENDPOINT_LEVEL_STATUSES` and `ENDPOINT_LEVEL_ERROR_CODES`
are exported so the detector can be driven from them rather than from a copy.

## Detector

Class-level, in `tests/core/auth/candidate-ordering.test.ts`: a matrix built **from the
production lists themselves** asserts that every member of `ENDPOINT_LEVEL_STATUSES` and
`ENDPOINT_LEVEL_ERROR_CODES` (plus a 5xx, which the predicate reaches by a third route)
leaves the cached token in place and refreshable on the next call — the extractor must not
run a second time — and the mirror image over `DEAD_TOKEN_CODES`, where the token must be
discarded. A signal added to any of those lists is asserted the day it is added.

**Mutation-verified, four ways.** Clearing unconditionally (the bug) turns 8 rows red;
never clearing turns 2 red; dropping either half of the shared predicate turns 2 and 1 red
respectively. Two further rows — `USER_DISABLED` and a code Google has not shipped — exist
only to kill the "too loose" mutant, since both are candidate-level 400s that still must
not discard the credential.

The class's other half lives in `scripts/check-workflows.ts` (invariant 3), which catches
the same substitution in GitHub workflow gates; see
[#741](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/741). Neither
generalises, and that is the honest limit: "this input is only a proxy for the authority"
is a semantic claim about one decision, not a shape a scanner can recognise.

## Lesson

When a decision is destructive and its input is a failure, ask what the failure is a
statement *about*. This module had answered that question twice already and written the
answer down as a predicate both times; the third site did not so much get it wrong as
never ask. The cheap habit is the one this fix ends with: when two places must agree about
what an error means, make them call the same predicate, so drift is impossible rather than
merely unlikely.
