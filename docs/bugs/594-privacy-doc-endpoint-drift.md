---
id: 594
title: PRIVACY.md described network destinations and modes the code no longer had — including calling a network-bearing mode offline
class: doc-reality-drift
status: fixed
detected: audit-sweep  # maintainer documentation review; invisible to every automated check, since nothing read Markdown
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/594
issue: none — found and fixed directly
date: 2026-08-03
---

## Symptom

PRIVACY.md stated in five places that network traffic goes to `firestore.googleapis.com`,
and that network traffic happens only in `--write` mode. Both claims were false:

- The real data endpoint is `https://app.copilot.money/api/graphql`
  (`src/core/graphql/client.ts:22`); `firestore.googleapis.com` appears nowhere in `src/`.
  The only Google host is `securetoken.googleapis.com`, used solely for the token
  exchange — no financial data goes to Google.
- `--live-reads` is a *read-only* flag that turns on all of that traffic, and PRIVACY.md
  did not mention it at all. "Read-only mode makes zero network requests" was false for a
  documented, supported configuration. A privacy-conscious reader could run `--live-reads`
  on a shared or monitored machine believing nothing left it.

For a privacy policy in a personal-finance tool, the document itself is a user-facing
output — and it was wrong in the direction that matters (undisclosed traffic).

## How it was detected

A maintainer docs review during the v3/context-diet era. Nothing else could have caught
it: tests exercise behavior, lint reads syntax, and no existing check opened a Markdown
file. README.md had been correct for months; only PRIVACY.md was behind.

## Root cause

PRIVACY.md was written against the original Firestore-REST design and never revised when
the GraphQL client replaced it; `--live-reads` was added later and never documented as
network-bearing. Documentation had no coupling of any kind to the code it described.

## The fix

Rewrote PRIVACY.md around the real three modes (cache-only / `--live-reads` online /
`--write`), with a per-mode table of exact destinations, and separated the Firebase token
exchange from the data path so "Google is contacted" cannot be confused with "Google
receives your finances."

## Detector

Class-level, for the endpoint slice of the class: `scripts/check-privacy-endpoints.ts`,
wired into `bun run check` and CI. It diffs every `https` host reachable at runtime in
`src/` (comments stripped) against every host named in PRIVACY.md — a host in code but not
the doc is undisclosed traffic, a host in the doc but not the code is a stale claim, both
fail. Verified against the pre-fix document (correctly failed) and against an injected
rogue host (correctly failed). The detector itself then needed a bug fix — its comment
stripper could be blinded by `/*` and `*/` inside string literals (#614 → PR #619).

Note the detector covers *hosts* only. Sibling doc-reality drifts remain open: PRIVACY.md
does not disclose browser-profile-storage reads (#615), and the landing page advertises a
tool count no mode actually exposes (#610). Tool-count figures got their own detector
(`check:tool-counts`, PR #588).

## Lesson

Docs that make verifiable claims about system behavior — endpoints, modes, counts — are
load-bearing outputs and drift silently because no gate reads them. Either derive the claim
from code or write a checker that diffs claim against code; "we'll keep it updated" has a
measured failure rate of 100% over an architecture migration.
