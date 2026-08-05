---
id: 530
title: The live conformance smoke crashed on startup for a month — scripts/ silently drifted from a src/ contract change
class: path-divergence
status: fixed
detected: live-probe  # routine smoke run crashed with `candidates.slice is not a function` before any network call
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/530
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/531 (follow-up class detector)
date: 2026-07-11
---

## Symptom

`bun run smoke` and `bun run smoke:roundtrip` — the live Tier-1 conformance gate, the
project's primary defense against Copilot API drift — crashed with
`candidates.slice is not a function` before consulting a single token, for every user,
regardless of login state. The gate had been un-runnable since 2026-06-13 (~4 weeks) and
nobody noticed, which means no live conformance checking happened for that entire window.

## How it was detected

Someone tried to run the smoke. It crashed instantly. There was no earlier signal: the
break shipped inside the #478 auth fix and every CI gate stayed green.

## Root cause

PR #478 changed `FirebaseAuth`'s `TokenExtractor` contract from "return a single
`{token, browser}`" to "return `{candidates, checked}`". Production call sites in
`src/server.ts` were migrated; six call sites in `scripts/`
(`scripts/smoke/{_conformance,_harness,reads,roundtrip}.ts`, `scripts/smoke-graphql.ts`,
`scripts/verify-optimistic-consistency.ts`) still passed the old single-result extractor.
`getIdToken()`'s cold path destructured `candidates` from the old shape → `undefined` →
`.slice` threw.

The structural cause: `tsconfig` included only `src/**/*`, so `scripts/` sat outside the
typechecked boundary. Two callers of the same contract — one typechecked, one not — and
the unchecked one drifted the first time the contract moved. That gap is the class: any
`src/` API change is invisible to every `scripts/` consumer until one is executed.

## The fix

PR #530 swapped all six script call sites to `extractRefreshTokenCandidates`, matching
production. PR #533 then landed the class-level fix: a `scripts/` typecheck wired into
`bun run check` and CI, so a `src/` contract change that breaks a script fails the build
instead of the next unlucky smoke run.

## Detector

Class-level and real: the `scripts/` typecheck gate (#531 → PR #533) in `bun run check`
and CI.

## Lesson

Any code outside the typechecked boundary is a standing contract-drift liability — and a
drift *detector* that only runs when a human remembers to run it is itself undetected
drift. The smoke being broken for a month without an alarm is as significant as the crash:
gates need their own heartbeat.
