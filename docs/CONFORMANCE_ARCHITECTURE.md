# Conformance architecture — how this repo defends against API drift

This document explains the *system* that the per-feature docs only describe in
pieces. If you're touching the GraphQL surface, adding a tool, or fixing a bug,
read this first — it's the "why" behind the ledger, the smokes, the PR template,
and the weekly job.

## The failure this exists to prevent

This server reads Copilot Money's local cache and writes through Copilot's
GraphQL API at `app.copilot.money/api/graphql`. That API is **not ours** — we
don't own it, version it, or get told when it changes. Everything we do rests on
hundreds of *assumptions* about it: that an enum still accepts `MONTHLY`, that an
input type still has a `tagIds` field, that saving a transaction actually saves.

Bug #419 was the wake-up call: Copilot changed their server, our model went
stale, and **nothing told us** — worse, our unit tests encoded the *same* wrong
assumption, so they stayed green while the app was broken. A test that mocks the
thing it's verifying is grading the worksheet against an answer key it wrote
itself.

The fix is one principle, applied everywhere:

> **No fact about Copilot's API without an oracle.**

An *oracle* is an independent, trustworthy check of an assumption — one whose
answer comes from the real server (or from code, never from a hand-written mock
that could share our mistake). Every external assumption must be backed by one,
and "we forgot to verify this" must be a **red build**, not a silent gap.

## The three kinds of oracle

There is no single way to verify an assumption, so the suite uses three,
strongest-available wins:

1. **Trick-question probes** (`smoke:conformance`) — for enums and input fields.
   We send the live server a deliberately-malformed request and read its
   rejection: if it complains the *right* way ("`X` is not a valid value of enum
   `Y`"), the language we think it speaks is confirmed. These are **non-mutating
   by construction** — they're designed to fail validation *before* any resolver
   runs (fake IDs, a malformed sibling field). Harness: `scripts/smoke/_conformance.ts`,
   `scripts/smoke/_field-conformance.ts`.

2. **Read-backs** (`smoke:reads`) — for query operations. We fetch real data
   through the same code path the app uses and confirm it comes back shaped how
   we expect. Harness: `scripts/smoke/read-checks.ts`.

3. **Reversible round-trips** (`smoke:roundtrip`) — for writes. The only true
   answer key for a write is to **do it, read it back, and undo it**: create an
   object → re-read it to prove it actually persisted (never trust the mutation's
   own "ok" echo) → delete it. This is mutating, so it is owner-attended only and
   never scheduled. Harness: `scripts/smoke/roundtrip.ts`,
   `scripts/smoke/roundtrip-checks.ts`. This is the oracle that caught the
   `create_recurring` bug: the server *said* the create failed, the read-back
   proved it had secretly succeeded.

A runtime fourth layer backs the write *responses*: `runtime:zod-warn` validates
every mutation response against a Zod schema inside the GraphQL client
(`src/core/graphql/client.ts`) and **warns without ever throwing or dropping
data** — drift is counted and logged, never fatal.

## The ledger: the spine

`src/conformance/ledger.ts` is the machine-readable inventory of *every* external
assumption and the oracle (if any) guarding it. Each entry carries a
**verification class**:

| Class | Meaning |
| --- | --- |
| `gated` | An oracle actively re-verifies this; drift fails a check. |
| `verified-once` | Confirmed against the server at a point in time (cite the PR), but no standing oracle. |
| `unverified` | We assume it; nothing checks it yet. Honest debt. |

`bun run smoke` prints the class distribution at the end — the "are we getting
better?" number. As of the 2026-06 program it sits near 99% gated/verified.

The ledger is enforced by plain unit tests that run in cloud CI (no auth, no
network): `tests/conformance/ledger.test.ts` fails the build if a write-tool
param has no ledger entry, if a named oracle points at a script that doesn't
exist, or if a `gated` entry has no oracle. **Adding a tool without registering
its assumptions is a compile-level error, not a code-review catch.**

## The five invariants (the architecture)

The defense is five interlocking loops. Each installs one invariant and is
enforced by code on `main`, not by discipline:

1. **Inner loop — single source of truth.** One definition site per tool
   (`src/tools/registry/`), deduped enum/value constants, and test mocks
   *derived from* the real types so a wrong mock shape fails `tsc` instead of
   passing. Gates: `tests/unit/tsconfig-tests-sync.test.ts`, the registry tests.

2. **Boundary loop — no fact without an oracle.** The ledger + the three smoke
   tiers above. Gates: `tests/conformance/ledger.test.ts`,
   `tests/scripts/read-smoke-coverage.test.ts`,
   `tests/scripts/roundtrip-coverage.test.ts` (each enforces a *bijection* — every
   tool/operation must have a smoke, and every smoke must map to a ledger entry).

3. **Drift visibility — loud by default.** Correct error attribution (a schema
   drift reads differently from "you're logged out"), surfaced schema-drop counts,
   bounded retry that **never retries an ambiguous mutation** (a write that might
   have applied is never blindly re-sent), and the `runtime:zod-warn` response
   layer. Lives in `src/core/graphql/client.ts`, `src/tools/errors.ts`.

4. **Meta loop — every incident upgrades the system.** The PR template
   (`.github/PULL_REQUEST_TEMPLATE.md`) forces an "External assumptions" section
   with an evidence class on every PR; the **Bug Response Ritual**
   (`CONTRIBUTING.md`) forces every bug fix to add a *class-level* detector, not
   just a one-off test. The `/boundary-audit` skill (`skills/boundary-audit/`)
   re-runs the whole inventory quarterly and files what's drifted (reports land in
   `docs/audits/`).

5. **Architecture — one definition per tool.** The registry collapses schema +
   handler + classification + manifest into a single `ToolDefinition`, so the
   counts the doc-sync and ledger gates derive can't disagree with reality.
   Gate: `tests/unit/doc-sync.test.ts`.

## The standing posture (when no one is coding)

Every gate above is *activity-triggered* (push, PR, pre-push). The original
threat — Copilot changing the API while no development is happening — needs a
time trigger. A weekly launchd job (`scripts/scheduled-smoke.ts`, installed via
`scripts/install-scheduled-smoke.sh`, documented in `docs/scheduled-smoke.md`)
runs **Tier-1 only** (non-mutating; never the round-trips) on the owner's
machine, where the browser session lives. Its outcome is three-state —
`pass` / `fail` / `auth-missing` — because **absence of auth must never look like
absence of drift**. The result is surfaced inside a dev session via
`get_connection_status` (`src/utils/scheduled-smoke-status.ts`), so stale or
failed checks are visible without hunting for logs.

## How to extend it (the contributor's view)

- **Adding a write tool?** Register it in `src/tools/registry/`, add its input
  fields/enums to the ledger, and add a round-trip in
  `scripts/smoke/roundtrip-checks.ts`. The bijection tests will fail until you do.
- **Adding/confirming an enum or input field?** Add a conformance probe, flip its
  ledger entry to `gated`, and cite the PR in the evidence field.
- **Fixing a bug?** Fill the Bug Response Ritual in the PR. The required question
  is *"what class does this belong to, and what now catches the whole class?"* —
  an instance-only regression test does not satisfy it. (Worked example: the
  `create_recurring` over-selection bug, PR #471.)
- **Every PR:** answer the "External assumptions" section. "None" is a valid,
  explicit answer — deleting the section is not.

## Map — where each piece lives

| Concern | Location |
| --- | --- |
| Assumption inventory + classes | `src/conformance/ledger.ts` |
| Ledger enforcement (CI) | `tests/conformance/ledger.test.ts` |
| Enum/field probes (Tier 1) | `scripts/smoke/_conformance.ts`, `_field-conformance.ts` |
| Read smokes (Tier 1) | `scripts/smoke/read-checks.ts` |
| Round-trips (Tier 2, attended) | `scripts/smoke/roundtrip.ts`, `roundtrip-checks.ts` |
| Coverage bijection gates | `tests/scripts/{read-smoke,roundtrip}-coverage.test.ts` |
| Response validation (runtime) | `src/core/graphql/client.ts` |
| Error taxonomy + retry | `src/core/graphql/client.ts`, `src/tools/errors.ts` |
| Tool registry | `src/tools/registry/` |
| Weekly scheduled check | `scripts/scheduled-smoke.ts`, `docs/scheduled-smoke.md` |
| PR ritual + evidence classes | `.github/PULL_REQUEST_TEMPLATE.md`, `CONTRIBUTING.md` |
| Quarterly audit | `skills/boundary-audit/`, reports in `docs/audits/` |

## Running the gates

```bash
bun run check            # all activity-triggered gates (typecheck, lint, tests) — no auth
bun run smoke            # Tier 1 live: enums + input fields + reads (needs browser session)
bun run smoke:roundtrip  # Tier 2 live: reversible write round-trips (MUTATING, attended only)
```
