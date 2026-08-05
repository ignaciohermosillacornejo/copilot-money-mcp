---
id: 266
title: Copilot restricted direct Firestore writes; all 18 write tools broke with 403
class: external-api-drift
status: fixed
detected: live-probe  # an update_transaction against the real backend returned 403 PERMISSION_DENIED
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/275
issue: none — found and fixed directly (mitigated first in PR #266, v1.7.0)
date: 2026-04-15
---

## Symptom
Every write tool — all 18 of them, the project's headline feature — failed against the live backend with `403 PERMISSION_DENIED`. Nothing in our code changed; Copilot changed their Firestore security rules to block third-party clients.

## How it was detected
A live `update_transaction` call failed with the 403. There was no monitoring; the breakage was discovered by using the tools, an unknown time after Copilot flipped the rules.

## Root cause
The entire write architecture rested on one unstated external assumption: that Copilot's Firestore security rules would keep permitting authenticated third-party REST writes to user documents. That was never a contract — it was an accident of configuration, and the vendor closed it. (The same architecture had already produced #232, since raw datastore writes bypassed server-side document invariants; the 403 killed the approach outright.)

## The fix
Two stages. PR #266 (v1.7.0) stopped the bleeding: published CLI shipped read-only, `--write` printed an unavailability notice, docs/site reshaped around the 17 read tools — while keeping write-tool source on main. PR #275 (v2.0.0) rewrote every write tool onto Copilot's own GraphQL API at `app.copilot.money/api/graphql` — the same endpoint the vendor's web app uses, which they cannot casually revoke without breaking themselves.

## Detector
At the time, none. This event is the origin story of today's class-level system: the conformance ledger (`src/conformance/ledger.ts`), live smoke scripts, per-PR "External assumptions" declarations with evidence classes, and the weekly drift check (see `docs/CONFORMANCE_ARCHITECTURE.md`) all exist to surface vendor-side drift before users do.

## Lesson
Depending on a vendor's *misconfiguration* is different from depending on their *API* — build on the surface the vendor's own clients use, because that's the only one with an implicit stability guarantee. And enumerate external assumptions explicitly so that when one breaks, you know what else stands on it.
