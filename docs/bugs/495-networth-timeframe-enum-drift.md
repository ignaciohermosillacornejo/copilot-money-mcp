---
id: 495
title: get_networth_live advertised time_frame values that the server rejects with a hard 400
class: external-api-drift
status: fixed
detected: dogfooding  # side-by-side parity comparison with Copilot's official MCP beta, confirmed by a live probe of every enum value
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/495
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/494
date: 2026-06-15
---

## Symptom

`get_networth_live` advertised `time_frame: ['ALL', 'YEAR', 'MONTH', 'YTD']` and its
description claimed the endpoint "accepts only these four values." `YEAR` and `MONTH` are
not members of the server's `TimeFrame` enum and return a hard 400 — so half the advertised
values were dead on arrival, and an agent following the schema would fail on exactly the
inputs the schema told it to use.

## How it was detected

During the official-MCP comparison work (registering Copilot's own remote MCP beta
alongside this server and auditing parity), then pinned by a one-shot live probe of all
candidate values: `ALL`/`YTD`/`ONE_DAY`/`ONE_WEEK`/`ONE_MONTH`/`THREE_MONTHS`/`ONE_YEAR`
→ 200; `MONTH`/`YEAR` → 400.

## Root cause

The tool schema hardcoded a literal enum list instead of reusing the shared,
conformance-gated `ALL_TIME_FRAMES` set. The Networth endpoint takes the canonical
`TimeFrame` enum; the hand-typed list invented two members and dropped five real ones.
Sibling tools (balance-history, investment-prices) already derived from the shared set —
networth was the lone hand-typed offender.

## The fix

Replace the literal with `[...ALL_TIME_FRAMES]` so the schema cannot drift from the shared
union; correct the description; drop the false "only these four values" claim.

## Detector

Class-level and real: `tests/tools/registry/live-timeframe-enum.test.ts` iterates every
live tool schema and asserts any `time_frame` enum equals `ALL_TIME_FRAMES` (verified to go
red when the drift is reintroduced). The canonical set itself is pinned to the server by
the existing TimeFrame smoke conformance gate (#439).

## Lesson

Any client-side enum that mirrors a server enum must be *derived* from the single
conformance-gated set, never retyped by hand. A hand-typed copy is a fork that will drift.
