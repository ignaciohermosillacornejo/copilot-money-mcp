# Completeness-guard audit — 2026-08-29

Triggered by the #635 bug class biting for the third time during the v3.0.0
release (PRs #673, #676). Scope: every guard in the repo — tests, `scripts/`
gates, and CI workflows — examined for one specific defect. Not a general
code review.

Method: four parallel auditors, each in an isolated worktree off `main` at
`18ec7d6c`. **Every finding below was proven by mutation**: break the thing
the guard claims to protect, run the suite or the gate, and record that it
stayed green. Suspicions were discarded. Baseline for "green" is
**2853 pass / 20 skip / 0 fail at `18ec7d6c`**.

Quote that triple, not a bare pass count: this baseline predates #676, which added
`tests/exported-constants.test.ts`, so a reader reproducing these mutations on a later
commit will see a higher number and must not read the difference as drift.

**Coverage of this pass.** Four slices, all complete: the ratchet /
conformance / e2e infrastructure; the tool surface and registry; the non-test
gates (`scripts/`, CI workflows, skills); and the data layer (`decoder.ts`,
`src/core/graphql/**`, `src/models/**`). Findings F1–F18 cover the first
three; **D1–D7 in §6 cover the data layer, and D1 has the highest blast
radius in the document** — it silently corrupts spend totals.

---

## 1. The class

> A guard whose coverage is a **hand-maintained list**. It protects the N
> things someone remembered to list, and silently protects nothing for the
> N+1th.

The repo already knew this class. It is named in `docs/bugs/README.md`, and
the v3.0.0 plan carried it as a global constraint: *"Mutation-check each
preset: delete a field, confirm a test fails."* It shipped anyway — because
the countermeasure was a **procedure**, not a **mechanism**. Procedures
depend on someone executing them under time pressure.

Worse, each fix reproduced the bug one level up:

| | What broke | The fix | How the fix leaked |
|---|---|---|---|
| #635 | Field deleted from a preset, undetected | Assert the field | *Forget a field* |
| #673 | 3 of 5 `DEFAULT_TOP_MOVER_FIELDS` deletable | Pin each preset by hand | *Forget a preset* |
| #676 (first revision) | — | Discover presets in one module | *Forget a module* |

The third row was found by this audit, not in review.

### Why the existing safety nets cannot catch it

| Mechanism | Why it misses |
|---|---|
| Context-budget ratchet | Budgets are **upper** bounds. A shorter list produces a *smaller* response and sails through. |
| `satisfies readonly (keyof Row)[]` | Catches a **typo**, not a deletion — a shorter list still satisfies the constraint. |
| Line coverage | The list is executed by every test that calls the tool. 100% covered, zero detection. |
| Type system | These are `readonly string[]`. Nothing anywhere types "complete". |

## 2. The pattern that does work

**Discover instances programmatically; fail in both directions.**

- **forward** — an instance exists with no pinned expectation → someone added
  one and no test came with it
- **backward** — a pinned expectation names an instance that no longer exists
  → a stale expectation quietly protecting nothing
- **non-vacuity** — assert discovery found *anything*, or the forward check
  passes trivially over an empty list (the guard's own failure mode, one
  level up)

The backward direction also guards the discovery mechanism itself: if
discovery silently under-matches, the instances it can no longer see read as
"vanished" and it goes red.

Reference implementations in-repo: `tests/exported-constants.test.ts`
(source-tree scan, #676), `tests/scripts/read-smoke-coverage.test.ts`,
`tests/scripts/roundtrip-coverage.test.ts`,
`tests/tools/registry/live-timeframe-enum.test.ts`, and
`scripts/check-privacy-endpoints.ts`.

---

## 3. Findings

Severity is blast radius: what silently ships if the gap is hit.

| # | Severity | Area | Gap |
|---|---|---|---|
| F1 | **Security** | `check-concealment` | `prepack` not in `FORBIDDEN_LIFECYCLE` |
| F2 | **Security** | `check-concealment` | Extensionless files unscanned (`.husky/pre-push`) |
| F3 | **High** | `--write` gate | Dispatch gating has no per-tool completeness guard; already drifted |
| F4 | High | Conformance ledger | A renamed response-schema key silently kills a `gated` claim |
| F5 | High | Docs | `docs/tools-by-mode.md` has zero gates |
| F6 | Medium | Conformance ledger | `Mutation.*` surfaces anchored to nothing, both directions |
| F7 | Medium | Conformance ledger | Enum walk covers write schemas only — already bitten |
| F8 | Medium | Live budgets | `COVERED_LIVE_TOOLS` self-referential; 10 of 17 live tools unbudgeted |
| F9 | Medium | Docs | A new tool passes all 7 gates while documented nowhere — already shipped stale |
| F10 | Medium | Skills linter | Validates 10 name prefixes only; no parameter validation at all |
| F11 | Medium | `sync-manifest` | Descriptions never resync |
| F12 | Medium | Registry | `swappedOutInLiveMode` pinned only in the deletion direction |
| F13 | Low | `check-pr-sections` | Ritual-field deletions invisible |
| F14 | Low | e2e | `'all tool responses can be serialized'` covers 2 of 33 tools |
| F15 | Low | Skills linter | `KNOWN_TOOL_PARAMS` has dead entries; one masks a typo of a real tool |
| F16 | Low | `check-version-sync` | Reads only the first `packages[]` entry |
| F17 | Low | `check-deps-pinned` | Misses `overrides` / `resolutions` |
| F18 | Low | CI | `auto-release.yml` has no `needs:` on Tests; release path re-runs no gates |

### F1 — `prepack` is not a forbidden lifecycle hook (Security)

`scripts/check-concealment.ts:126`. `FORBIDDEN_LIFECYCLE` lists four hook
names; npm runs more.

**Mutation.** Added `"prepack": "node -e \"...execSync('echo pwned')\""` to
`package.json` scripts. Gate output: `check-concealment: 355 files scanned,
nothing hidden`, exit 0. The gate's own 29 tests pass.

**Why it matters.** `prepack` executes during `npm publish` — inside the
`npm-publish.yml` job that holds `id-token: write`.

**Fix.** Invert it: enumerate `package.json.scripts` keys and refuse any that
is in npm's full lifecycle set and not in a pinned allowlist. The file's own
comment already argues this — *"an allowlist entry here is indistinguishable
from the attack."*

### F2 — Extensionless files are never scanned (Security)

`scripts/check-concealment.ts:77`, `SCOPED_EXTENSIONS` (14 entries).

**Mutation.** Wrote an identical concealed payload (60-space run, 538-column
line, `execSync` of a piped `curl`) to `scripts/probe-hook`, `probe.rb`,
`probe.ps1`, `probe.mts`. All passed. **Control:** the same bytes as
`scripts/probe.ts` fail on two rules.

**Why it matters.** `.husky/pre-push` runs on every developer push and has no
extension. The walker descends into `.husky` — dot-dirs are not in
`SKIP_DIRS` — but `inScope()` (lines 180-182) drops it because
`lastIndexOf('.')` is `-1`.

**Fix.** Scan every non-`SKIP_FILES` file, sniffing for NUL to skip binaries,
instead of allowlisting extensions.

### F3 — The `--write` dispatch gate has no completeness guard (High)

Four independent hand-maintained name lists:
`tests/unit/server-protocol.test.ts:544` (`ALL_WRITE_TOOLS`), `:578`, `:614`,
and `tests/unit/server-write-dispatch.test.ts:16` (`WRITE_TOOL_SPECS`).
Nothing compares any of them to `WRITE_TOOL_DEFS`.

**They have already drifted.** The rejection list at `:614` holds 17 of 19
write tools. `update_transactions` and `bulk_edit_transactions` were added to
the registry and never got a "refuses without `--write`" test.

**Mutation (exploitable).** In `src/server.ts:182`, changed
`const isWriteTool = toolDef !== undefined && !toolDef.readOnly;` to
`... && name !== 'bulk_edit_transactions';` — i.e. a read-only server will
execute the bulk-edit mutation. **Result: 2853 pass, 0 fail.** Same with
`update_transactions`. **Control** with `update_transaction` (a name that
*is* listed): 1 fail.

**Mutation (backward).** Deleted `bulk_edit_transactions` from three of the
lists: 2851 pass, 0 fail — two tests silently vanished.

**Note.** The *listing* gate is sound: a write tool leaking into the
read-only list fails four exact-count checks. Counts catch listing exposure;
they cannot catch **dispatch** exposure, which is the gate that actually runs
the mutation.

**Fix.** Delete all four lists; derive from `WRITE_TOOL_DEFS`, with a
per-tool `MINIMAL_ARGS` map guarded bidirectionally and a non-vacuity floor.
`tests/scripts/roundtrip-coverage.test.ts:52` is the in-repo template.

### F4 — A `gated` ledger claim can be a dead gate (High)

`tests/conformance/ledger.test.ts:140-157` enforces a bijection for
`runtime:zod-warn` — but it compares `entry.surface` values, never the
registry **keys** in `MUTATION_RESPONSE_SCHEMAS`.

**Mutation.** Renamed the key `CreateTag:` → `CreateTagTypo:` in
`src/core/graphql/response-validation.ts:193` and the matching key in the
hand-written `VALID_RESPONSES` test map. **2853 pass, 0 fail.**
`src/core/graphql/tags.ts:23` still calls `client.mutate('CreateTag', …)`,
dispatch is by exact key, so that response is never validated again — while
the ledger continues to advertise `class: 'gated', oracle: runtime:zod-warn`.

**Fix.** Port the read-side guard verbatim:
`tests/scripts/read-smoke-coverage.test.ts:114` already does this for
`QUERY_RESPONSE_SCHEMAS`.

### F5 — `docs/tools-by-mode.md` has zero gates (High)

The canonical per-tool inventory, linked from `README.md`, is referenced by
nothing in `tests/`, `scripts/`, or `.github/`.

**Mutation.** Deleted the rows for `get_top_movers_live`,
`get_investment_splits`, `bulk_edit_transactions`, and renamed
`get_networth_live` → `get_net_worth_live` (a tool that does not exist).
All seven gates exit 0; `bun test` 2853 pass, 0 fail.

**Fix.** Bidirectional name comparison against `ALL_TOOL_DEFS`, same shape as
`tests/unit/manifest-sync.test.ts`.

### F6 — `Mutation.*` ledger surfaces are anchored to nothing (Medium)

Three separate mutations, each full-suite green: deleting
`operation('createTag')`; renaming a surface to one that does not exist;
adding a new generated mutation with zero ledger rows.

**Control proving the asymmetry.** The same third mutation done as a *query*
fails two tests in `read-smoke-coverage.test.ts`. Reads are guarded
bidirectionally against `operations.generated.ts` (#460); writes are not.

The ledger happens to be complete for mutations today — 18 generated mutation
root fields, all present. This is an unexploded mine, not a live defect.

### F7 — The ledger enum walk covers write-tool schemas only (Medium)

`tests/conformance/ledger.test.ts:56-114`, `collectParams()` iterates
`createWriteToolSchemas()` only.

**Mutation.** Added `sort: { enum: ['ASC','DESC'] }` to `get_holdings_live`:
green. **Control:** the identical property on `delete_tag` fails immediately.

**Already bitten.** `TOP_MOVERS_FILTERS`
(`src/tools/live/top-movers.ts:40`) is sent as `$filter: TopMoversFilter`, a
real external GraphQL enum, with **zero occurrences in the ledger**. Contrast
`TimeFrame`, ledgered by hand precisely because the walk cannot see it —
there is even a comment at `ledger.ts:341` admitting the read side is manual.

### F8 — `COVERED_LIVE_TOOLS` is self-referential (Medium)

`tests/context-budget-live.test.ts:55` + `:308`. The completeness guard in
`tests/helpers/context-budget.ts:53-60` *is* bidirectional and non-vacuous —
but only between two hand-maintained structures. Neither is compared to
`LIVE_TOOL_DEFS`.

**Mutation A.** Removed `get_top_movers_live` from the allowlist and its
budget row: green.
**Mutation B.** Registered a new live tool returning a ~9.5 KB default row:
the live budget file stayed green. Adding the one line the *schema* guard
demanded made both budget files green with the fat row entirely unratcheted.

**Consequence today: 10 of 17 live tools have no response budget.**

In fairness to the code — and on the same principle that credits
`check-concealment.ts` in F1 for arguing the right way in its own comment —
`tests/context-budget-live.test.ts:26-29` already states plainly that this is
*"an explicit allowlist, not a filter over `LIVE_TOOL_DEFS`, so covering the
remaining live tools later is purely additive."* So this is a **documented
limitation with no ratchet**, not an unseen gap. The finding stands, because
nothing forces the additive step and 10 of 17 is the proof — but it is a
weaker indictment than F3 or F5, where nobody had noticed at all.

**Fix.** Derive from `LIVE_TOOL_DEFS`; keep the allowlist only as an explicit
`UNBUDGETED_LIVE_TOOLS` exclusion, so a new live tool must be budgeted or
consciously excluded.

### F9 — A new tool passes every gate while documented nowhere (Medium)

**Mutation.** Added a 15th cache read, then fixed *exactly* what
`check:tool-counts` demanded and ran `sync-manifest` — the diligent-developer
path. All seven gates exit 0. The tool is absent from `docs/tools-by-mode.md`
and README's per-tool sections, and `manifest.json`'s own description still
reads "14 read-only tools".

`scripts/check-tool-counts.ts:51-131` is a hand-maintained `(file, needle)`
list. It omits `manifest.json`, `docs/tools-by-mode.md`,
`docs/TESTING_GUIDE.md`, `docs/EXAMPLE_QUERIES.md`.

**Already realized on `main`, all gates green:** `docs/TESTING_GUIDE.md:102`
says "You should see 8 tools listed"; `docs/EXAMPLE_QUERIES.md:541` says
"these 12 tools".

### F10 — The skills linter validates 10 name prefixes and no parameters (Medium)

`scripts/check-skills.py:45`, `TOOL_PREFIXES`.

**Mutation.** Referenced eight nonexistent tools (`list_transactions`,
`search_transactions`, `tag_transaction`, `merge_categories`,
`export_budget`, `find_recurring`, `categorize_transactions`,
`sync_accounts`) from a skill: `OK: 6 skills validated`, exit 0.
**Control:** `get_bogus_thing` correctly fails.

Separately, referencing `catgory_name`, `amount_min`, `not_a_real_param`
also exits 0 — parameters are not validated at all.

**Fix.** Build the prefix set from real names
(`{n.split('_')[0] + '_' for n in known_tools}`), and resolve backticked
snake_case tokens against the union of every tool's `inputSchema.properties`.

### F11 — `sync-manifest` never resyncs descriptions (Medium)

`scripts/sync-manifest.ts:52`. **Mutation.** Replaced `get_cache_info`'s
registry description entirely. `bun run sync-manifest` printed *"No changes
needed - manifest was already in sync."*; all gates and 2853 tests pass. The
text Claude Desktop shows users can diverge from the schema permanently.

### F12 — `swappedOutInLiveMode` is pinned only in the deletion direction (Medium)

`tests/unit/tool-registry.test.ts:57` asserts equality against six pinned
names. Removing a flag goes red; **adding** a new `{x}_live` whose cache twin
exists but is unflagged cannot.

**Mutation.** Registered `get_goals_live` without the flag, bumping counts as
a developer would: only four prose/count failures. Verified the real defect
directly — in `--live-reads` mode the server then lists both `get_goals` and
`get_goals_live`, two tools for one semantic read, one serving the stale
cache. That is exactly what the invariant at `src/server.ts:150-157` promises
never happens.

### F13–F18

- **F13** `scripts/check-pr-sections.sh:28` — deleting `'Siblings checked:'`
  and `'Ledger updated:'` from `RITUAL_FIELDS` is invisible (the existing
  test only proves *some* field is required, and its body contains the two
  survivors). Adding a 6th field to CONTRIBUTING.md and the PR template is
  equally invisible.
- **F14** `tests/e2e/server.test.ts:375-387` — the test titled *"all tool
  responses can be serialized to JSON"* iterates a hand-written array of
  **two**. A `Date` returned from `getCacheInfo()` (lossy round trip) passes;
  the same `Date` in `getAccounts()` fails.
- **F15** `scripts/check-skills.py:62` — `KNOWN_TOOL_PARAMS` contains
  `split_transactions` and `update_existing`, which appear nowhere else in
  the repo. The first permanently whitelists the plural misspelling of the
  real tool `split_transaction`.
- **F16** `scripts/check-version-sync.ts:30` reads only `packages[0]`.
- **F17** `scripts/check-deps-pinned.ts:31` omits `overrides` /
  `resolutions`.
- **F18** `.github/workflows/auto-release.yml` has no `needs:` on the Tests
  workflow and re-runs no gates. A version bump landing on `main` with
  `check:version-sync` red would still build and publish; only branch
  protection stops it.

---

## 4. Verified correct — do not re-audit

- `tests/helpers/context-budget.ts:48-74` — bidirectional plus a non-vacuity
  floor. The *helper* is the good pattern; F8 is about one call site.
- `tests/context-budget.test.ts` — both tables discovery-based over
  `ALL_TOOL_DEFS`.
- `tests/unit/tool-registry.test.ts:33-55` — `readOnly` ↔ `readOnlyHint`
  agreement and `requiresLiveReads` are quantified over `ALL_TOOL_DEFS`.
- Reclassifying an existing write tool as a read is well defended: moving
  `create_tag` to `READ_TOOL_DEFS` *with both counts bumped* still fails 26
  tests, including semantic ones (roundtrip coverage, stale ledger
  `toolParams`, manifest sync).
- `tests/scripts/read-smoke-coverage.test.ts`,
  `tests/scripts/roundtrip-coverage.test.ts` — bijective, non-vacuous,
  anchored to generated artifacts.
- `tests/unit/manifest-sync.test.ts` — bidirectional on names.
- `tests/helpers/mock-graphql.ts` — an unmocked operation *rejects*, so the
  live budget suite cannot pass vacuously.
- `scripts/check-privacy-endpoints.ts` — discovery-based, bidirectional,
  with a justified one-entry allowlist and honest documented limits.
- `check:version-sync` covers all six version occurrences that exist.
- `scripts/decode-coverage.ts` is a manual report and says so — it does not
  advertise coverage it lacks.

### Correction to a claim in CLAUDE.md

CLAUDE.md notes that `bun run check` does not run `check:skills`, which
reads as a coverage gap. It is not one: `tests/scripts/check-skills.test.ts`
invokes the real linter against the real repo, and runs in the `tests` job of
`test.yml` and in the pre-push hook. Same for `check:deps-pinned`. Both were
confirmed by mutation. No gate in the `scripts/` slice is orphaned from CI —
the only CI gap is F18, on the release path.

---

## 5. Remediation

| Batch | Findings | Rationale |
|---|---|---|
| 1 | F1, F2 | Security; the publish path and the pre-push hook |
| 2 | F3 | Write-gate dispatch exposure; already drifted |
| 3 | F4, F6, F7 | Conformance ledger, one coherent surface |
| 4 | F5, F9, F10, F15 | Docs + skills rot |
| 5 | F8, F12, F14 | Test-infrastructure completeness |
| 6 | F11, F13, F16, F17, F18 | Low-severity gate cleanups |
| 0 | **D1, D2** | **Ahead of everything: silent financial-data loss** |
| 7 | D3, D4, D5, D6 | Decoder routing, parity, mutation ratchet, Zod mirrors |
| 8 | D7 | Model/decoder mirror gap |

Each batch should fix the **class**, not the instance: derive from the
authoritative source, fail in both directions, and assert non-vacuity. An
instance-only regression test does not satisfy "detector added" under the
repo's Bug Response Ritual.


---

## 6. Data layer (D1–D7)

Separately numbered because this slice landed after F1–F18 were written. D1
outranks everything above it.

### D1 — Decoder extraction lists are unpinned; deleting one silently drops user financial data (highest blast radius in this audit)

Every `process*` function in `src/core/decoder.ts` decides what reaches users
through literal arrays — `stringFields`, `booleanFields`, `numericFields`,
`stringArrayFields`. Nothing pins them. This is the #635 shape applied to the
data itself rather than to a response preset.

Confirmed green deletions, each run individually against the full suite:

| Mutation | Line | Consequence if shipped |
|---|---|---|
| `'excluded'` from `processTransaction` booleanFields | `decoder.ts:831` | the `exclude_excluded` filter (`src/tools/tools.ts:884`) becomes a **no-op — excluded transactions counted in every spend total** |
| `'excluded'` from `processCategory` | `decoder.ts:1736` | excluded-category filter (`tools.ts:614`) no-ops |
| `'category_id'` from `processBudget` | `decoder.ts:1267` | budget → category link gone |
| `'category_id'` from `processRecurring` | `decoder.ts:1132` | recurring → category link gone |
| `'mask'`, `'institution_name'` from `processAccount` | `decoder.ts:946` | account identifiers vanish |
| `'plaid_category_id'` from `processTransaction` | `decoder.ts:~787` | Plaid taxonomy gone |

The `'excluded'` deletion was run through the **full `bun run check`**: 2853
pass / 0 fail, lint and typecheck clean. A user asking "how much did I spend"
would get a wrong number, silently.

Some fields (`logo`, `user_hidden`, `tag_ids`, `user_note`,
`internal_transfer`, `pending`) *do* fail on deletion — but only because
`tests/core/decoder-coverage.test.ts:2690` and siblings happen to name them by
hand. Protection covers the N fields someone listed.

**Fix.** Per processor, take its own `consumed:` list (already spread from the
extraction arrays), synthesize a doc carrying every name, decode, and assert
each name is a key on the decoded row. Explicit `NOT_SURFACED` allowlist for
legitimate drops; non-vacuity floor on processor count.

### D2 — `warnUnreadFields` is per-processor opt-in with no registry

Deleting the `warnUnreadFields(...)` call from `processAccount`
(`decoder.ts:1080`) **and** `processHoldingsHistory` (`decoder.ts:2184`):
2853 pass / 0 fail. The only new-upstream-field detector for those collections
disappears, and `unread_field_warnings` in `get_cache_info` silently reads 0.
All 27 processors call it today; nothing keeps the 28th honest.

**Fix.** A source-scan ratchet in the style already used one file over —
`tests/core/decode-path-parity.test.ts:117` scans `function process*(` bodies
with a `found > 10` floor. Same scan, assert each body contains
`warnUnreadFields(`.

### D3 — Unrouted collections are dropped with no counter

A test DB with docs in `credit_score_history` and
`items/*/accounts/*/rewards` produced `decodeStats` keys of `["transactions"]`
only — no warning, no drop counter, nothing in `get_cache_info`.
`decodeAllCollections` (`decoder.ts:2806`) has no terminal `else`.

The real-cache backstop is also a hand list: `scripts/smoke/cache.ts:236`
names **9** roots out of the **28** arrays in `AllCollectionsResult`
(`decoder.ts:713`). Deleting `securities` and `tags` from it: 2853 pass / 0
fail. `balanceHistory`, `holdingsHistory`, `investmentSplits`,
`plaidAccounts` and 15 others were never in it.

### D4 — The parity `cases` list is #622's own class detector, as a 9-element hand list

`tests/core/decode-path-parity.test.ts:160`.

- **Forward:** added a `decodeSecurities()` export carrying the exact #622
  predicate bug (leaf-segment match that never occurs → 0 rows while the
  aggregate path returns all): **2853 pass / 0 fail.**
- **Backward:** deleted the `categories` case: 2852 pass / 0 fail. Nothing
  pins `cases.length`.
- **Live instance:** `decodeUserAccounts` (`decoder.ts:682`) is an exported
  standalone decoder with no parity case, here or in `scripts/smoke/cache.ts`.

### D5 — A new GraphQL mutation gets no response schema, no ledger entry, no smoke

Added `'EditUser'` to `IN_SCOPE_MUTATIONS`, regenerated, and shipped a wrapper
calling `client.mutate('EditUser', …)`: **2853 pass / 0 fail.**

Cause: `tests/scripts/read-smoke-coverage.test.ts:38` does
`if (typeof value !== 'string' || !value.startsWith('query ')) continue;` —
the entire ratchet is query-only. This is the same asymmetry as F6, reached
from the other side. The only signal is a runtime `console.warn` that fires
the first time the mutation runs against Copilot.

### D6 — Response-shape Zod mirrors are unpinned field lists

Each schema hand-mirrors a hand-written interface with nothing forcing
agreement.

- `response-validation.ts:73` `CreatedTransactionSchema` — deleting
  `isPending`, `createdAt`, `tipAmount`, `suggestedCategoryIds`,
  `recurringId`, `userNotes`, `tags`, `isReviewed`, or
  **`type: z.enum(TRANSACTION_TYPES)`** each left 0 fail. The `type` one is
  worst: lines 64–70 promise a new server `TransactionType` warns; deleting
  the line retires that promise silently.
- `read-validation.ts:39` `transactionNodeSchema` — **drop-based, and it feeds
  writes.** Deleting `categoryId`, `isPending`, `isoCurrencyCode`,
  `createdAt`, `suggestedCategoryIds` each → 0 fail. Only `parentId` is
  pinned.
- `queries/accounts.ts:73` `AccountNodeSchema` — deleting `mask`,
  `isUserClosed`, `latestBalanceUpdate` each → 0 fail. `latestBalanceUpdate`
  is precisely the field whose string→number drift #537 caught.

**Fix.** Iterate the schema registries and pin `Object.keys(schema.shape)`
verbatim per entry — the same block shape as the #635 class detector, so a new
registry entry with no pinned key set fails forward.

### D7 (low) — Zod model fields are declarations with no populate check

Adding `overdraft_limit` to `AccountSchema` and `merchant_confidence` to
`TransactionSchema`: suite green. Neither is extracted by any processor, so
both are pure documentation that reads as coverage. All model schemas are
`.passthrough()`, so the reverse loses type validation but not data.

### Incidental, but it will cost someone an afternoon

`tests/integration/mcpb-bundle.test.ts:144` runs `bun run pack:mcpb` →
`build` → `generate:graphql`, which **overwrites
`src/core/graphql/operations.generated.ts` mid-suite**. A mutation to that
file is silently reverted mid-run, producing nondeterministic pass counts
(2853 / 2870 / 1984 across three runs of the same tree). Anyone
mutation-testing that file must go through the capture + `IN_SCOPE_*` path.

### Data-layer guards already correct

- `tests/scripts/read-smoke-coverage.test.ts` — bidirectional over query
  operations, non-vacuity floor, plus an activation check that the registry
  key is a real operation name. The model D5 should be extended to.
- `tests/core/decode-path-parity.test.ts:117` — textbook discovery pattern
  (balanced-paren scan, floor, anchor).
- Decoder **routing branches** are well covered: deleting the securities /
  investment_splits / balance_history / plaid-account / holdings_history arms
  each fails 1–4 tests.
- Processor `consumed:` lists are spread from the same arrays used for
  extraction, so `consumed` cannot drift from what is read.
