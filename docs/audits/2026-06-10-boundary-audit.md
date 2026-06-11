# Boundary audit — 2026-06-10

Previous audit: none (first run of `/boundary-audit`, issue #445). Window
reviewed: 2026-03-12 → 2026-06-10 (90 days).

Produced by the `skills/boundary-audit/SKILL.md` ritual against
`src/conformance/ledger.ts` as of this commit.

## 1. Inventory diff (assumptions vs ledger)

Operations the code can send (from `src/core/graphql/operations.generated.ts`):
17 mutations, 19 queries.

| Surface class | Result |
|---|---|
| Mutations (17 documents) | **Covered.** All 17 map to `Mutation.*` ledger entries (operation-name → field-name mapping: `EditBudget` → `editCategoryBudget`, `EditBudgetMonthly` → `editCategoryBudgetMonthly`). Bidirectional tool-param coverage enforced by `tests/conformance/ledger.test.ts` (green, 11 tests). The no-MCP-tool escape hatch (`editAccount`) has an explicit entry. |
| Mutation input fields + response shapes | **Covered.** Input fields ledgered per the 2026-06 write-field audit lineage; all 17 response shapes ledgered (`unverified`, by design until B3 #437). |
| Queries (19 operations: Account, Accounts, AggregatedHoldings, BalanceHistory, Categories, Holdings, InvestmentAllocation, InvestmentBalance, InvestmentLiveBalance, MonthlySpend, Networth, Recurrings, SecurityPrices, SecurityPricesHighFrequency, Tags, TopMovers, Transactions, UpcomingRecurrings, User) | **Uncovered — Finding F1.** Zero `Query.*` ledger entries exist. Only the `TimeFrame` enum represents the read surface. The 19 operation signatures and their hand-written response interfaces (`src/core/graphql/queries/*.ts`) are unlisted assumptions. #439 plans smokes + ledger upgrades for these; the inventory entries themselves should exist (classed `unverified`) so the Phase-2 trend is honest before those smokes land. |
| Cache decoder surface (`src/core/decoder.ts`) | **Covered by separate controls, out of ledger scope (documented).** The ledger header scopes itself to the GraphQL surface. The cache boundary has its own class-level controls: `warnUnreadFields` wired into all collection processors (loud on unknown fields) and `bun run scripts/decode-coverage.ts` (doc-level decode %). No new collection processor landed in the window without coverage. No finding. |
| Docs facts about the external API | **Covered.** CLAUDE.md/README claims about the GraphQL endpoint and auth match `src/core/graphql/client.ts` and `src/core/auth/`. Freshness details in §4. |

## 2. Class distribution

Source: `formatClassDistribution()` from `src/conformance/ledger.ts`.

| class | now | last audit | delta |
|---|---|---|---|
| gated | 3 (4%) | — | baseline |
| verified-once | 63 (75%) | — | baseline |
| unverified | 18 (21%) | — | baseline |
| **total** | **84** | — | baseline |

Trend verdict: baseline established. The 18 `unverified` = 17 mutation
response shapes + `TimeFrame`; all 18 already have open follow-ups (#437
response-shape Zod warn-mode, #439 TimeFrame conformance probe), so no new
issues are needed for them. Watch item for the next audit: `gated` share
should rise as B2–B5 (#436–#439) land; `unverified` will first *grow* when F1
adds the read-surface entries — that growth is honesty, not regression.

## 3. Bug-class review

Fix-shaped PRs merged in the window, reviewed together per the D1 ratchet
questions (class, class-level detector, siblings):

| incident | class | class-level detector | siblings checked |
|---|---|---|---|
| #420 (create_recurring frequency values wrong) | Local enum transcribed wrong vs server | **Yes** — `scripts/smoke/conformance.ts` harness (#422), ledger oracle `smoke:conformance`, gated | Yes — TransactionType + RecurringState probed in #422/#424; remaining enum stragglers tracked in #439 |
| #394 (cache-mode tag filter compared name against IDs) | User-facing name accepted where storage holds opaque IDs; resolution step skipped | Instance-only regression tests (`tests/tools/tools.test.ts` tag-name resolution cases). The enabling condition — test fixtures whose IDs equal display names — has no gate; nothing stops a new fixture from masking the same class elsewhere. **Finding F2** | Partially — tag path fixed and tested; no sweep recorded for other name→ID filter paths, and no fixture-shape gate |
| #355/#360/#363 (liability bucketing case-sensitivity; charge-card limit zero-sentinel; budget totals double-counting parent+child) | Cache/live model divergence from app semantics, found by one-shot manual parity audit (2026-05-04 batch, 8 findings) | Instance tests per fix. Recurrence of the *audit* is now this skill; recurring live verification is #438 (round-trip smokes) + #440 (scheduled smoke) — open, referenced | Yes — the parity audit itself was the sibling sweep (all 8 findings fixed) |
| #344 (soft-deleted transactions shown) | Cache soft-delete semantics unmodeled (`user_deleted` flag vs tombstones) | Decoder filter + tests; semantics documented (transactions soft-delete, other collections tombstone) | Yes — collection-by-collection delete semantics checked when documented |
| #349/#352 (LevelDB reader stale temp cache; compaction TOCTOU) | Filesystem race against the live Copilot app mutating the cache | Regression tests in leveldb-reader suite; class is inherently racy — instance tests + fingerprint invalidation are the practical ceiling | Yes — copy path and fingerprint path both covered by the pair of PRs |
| #302/#310 (null `vested_quantity`/`vested_value` rejected) | Zod model stricter than cache reality (nullability) | Partial — `warnUnreadFields` catches unknown fields but not over-strict nullability; `scripts/decode-coverage.ts` over a real cache catches it, but only when run manually. Acceptable for now; revisit if the class recurs | Yes — both holding fields fixed together across the two PRs |

Aggregate pattern: every incident in the window is some form of "local model
diverges from external reality" — the exact class the conformance ledger +
Epic B oracles exist to ratchet. The #419→#424 arc shows the full ritual
working; #394 is the one incident where the class-level detector is still
missing (F2).

## 4. Docs freshness

Beyond `tests/unit/doc-sync.test.ts` (tool-count phrases and removed-path
references are automated and green):

- **Stale — Finding F3:** CLAUDE.md Quick Reference and CONTRIBUTING.md both
  describe `bun run check` as "typecheck + lint + format:check + test"; the
  actual script also runs `check:version-sync` and `check:server-json` (and
  uses `bun test --bail`). Neither doc mentions `check:skills`, which is not
  part of `check` and must be run separately — worth stating wherever skills
  work is described.
- Clean: all file/directory paths mentioned in CLAUDE.md exist
  (`src/tools/live/`, `tests/helpers/test-db.ts`, `docs/graphql-live-reads.md`,
  `tests/tools/tools.test.ts`); every `bun run` script named in CLAUDE.md
  exists in `package.json`; live-reads swap behavior and counts match
  `src/server.ts` (pinned by doc-sync); database-location claim matches the
  default-path candidates in `src/core/database.ts`.

## 5. Findings & filed issues

| # | finding | severity | issue |
|---|---|---|---|
| F1 | 19 read-side query operations + response shapes have no ledger inventory entries (only the `TimeFrame` enum represents the read surface) | medium | #460 |
| F2 | Name→ID resolution bug class (#394) has instance-only tests; no gate prevents id-equals-name fixtures from masking sibling bugs of the same class | medium | #461 |
| F3 | `bun run check` description stale in CLAUDE.md + CONTRIBUTING.md (omits version-sync/server-json gates; `check:skills` separateness undocumented) | low | #462 |

Not filed: response-shape and TimeFrame `unverified` entries (covered by open
#437/#439); cache-boundary ledger exclusion (explicit, documented scope
decision with its own controls).
