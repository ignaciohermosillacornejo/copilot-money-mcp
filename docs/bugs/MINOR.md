# Minor bug ledger

Bugs real enough to record but too small to justify a full post-mortem — mostly CI and
release plumbing, packaging, and latent defects fixed before anyone hit them.

They are here for two reasons: a class with only minor instances still shows up in the
[class list](README.md#bug-classes), and a run of minor bugs in one area is often the
early signal for a major one. `silent-failure-masking` appears **more often than any other
class** below and has one full entry — a class that keeps costing us release, audit and CI
incidents without often producing a bug worth a post-mortem is exactly the pattern this
ledger exists to make visible. (That sentence used to name a number, which nothing derived
and which had drifted by two before anyone noticed. A count no gate computes is a count
that will be wrong; the ordering is the claim worth making.)

Promote a row to a full entry if a later instance turns out to be user-visible.

| | Bug | Class | Fixed in |
|---|---|---|---|
| #9 | Release workflow silently skipped builds on `workflow_dispatch` | `silent-failure-masking` | #9 |
| #26 | Internal transfers counted as spending; cross-record field contamination; accounts missed by the 1000-byte scan window | `heuristic-decode-bleed` | #26 |
| #62 | Description truncation dropped or garbled text when no period was present | `ui-parity` | #62 |
| #65 | Fixtures used future dates, so date-window filters were never realistically exercised | `fixture-reality-drift` | #65 |
| #70 | Account names showed bank-internal strings instead of user-defined names | `identity-resolution` | #70 |
| #84 | Transactions in excluded *categories* still counted in spending — only transaction-level `excluded` was honoured | `ui-parity` | #84 |
| #91 | Budgets referencing deleted categories leaked raw Firestore IDs as `category_name` | `identity-resolution` | #91 |
| #96 | Native module (`classic-level`) bundling broke npm and Cursor installs | `packaging-environment-mismatch` | #96 |
| #121–#127 | Six-PR chain of fork-PR review workflow misconfigurations (secrets, triggers, permissions) | `silent-failure-masking` | #121–#127 |
| #128 | Review bot posted broken or empty comments | `silent-failure-masking` | #128 |
| #132 | `package.json` `main` pointed at a non-existent file | `packaging-environment-mismatch` | #132 |
| #135 | Hard-coded 30s decode timeout crashed the worker on large databases | `config-blind-default` | #135 |
| #188 | PR-audit workflow used the wrong bot name and wrong endpoint — found zero comments, so audits were never filed | `silent-failure-masking` | #188 |
| #213 | `update_transaction` accepted non-existent tag IDs — silent success, tag never appeared | `referential-integrity-gap` | #213 |
| #216 | Auto-release diffed `HEAD~1`, so version bumps in batch pushes never released; the tag-exists guard was a no-op without fetched tags | `silent-failure-masking` | #216 |
| #223 | Committed skill/profile docs contained personal surnames | `doc-reality-drift` | #223 |
| #246 | Docs claimed 41 tools after consolidation to 35 | `doc-reality-drift` | #246 |
| #283 | Tool descriptions promised behaviour four tools didn't have, misleading the calling model | `doc-reality-drift` | #283 |
| #297 | Split CI jobs each uploaded partial coverage, so reported coverage was wrong | `silent-failure-masking` | #297 |
| #310 | Same null-vested defect latent in the sibling `PlaidAccountSchema` (found by deliberate sibling sweep) | `wire-type-drift` | #310 |
| #342 | Unbounded `while(true)` GraphQL pagination could hang on a pathological stable cursor | `external-api-drift` | #342 |
| #345 | Main-thread temp-DB cache served stale LevelDB snapshots for up to 5 minutes | `stale-cache-semantics` | #349 |
| #350 | Compaction could delete an `.ldb` between `readdir` and `stat`/`copy` | `stale-cache-semantics` | #352 |
| #357 | Category flattening discarded parent linkage, making the hierarchy unrecoverable — the enabler for #363 | `aggregation-double-count` | #357 |
| #360 | Charge cards returned `limit: 0` instead of `null`, risking divide-by-zero utilization | `external-api-drift` | #360 |
| #379 | `total_return_percent` rounded half-up while the app floors — off by 0.01 vs the UI | `ui-parity` | #379 |
| #414 | `update_transaction` couldn't rename: `name` writability was assumed absent, never probed | `external-api-drift` | #414 |
| #448 | Repo instructions had drifted from the code, steering agents with wrong facts | `doc-reality-drift` | #448 |
| #514 | `split_transaction` read parents from the cache only, failing for out-of-window parents | `stale-cache-semantics` | #514 |
| #516 | Resolvers scanned date-filtered fetch returns instead of the stores those fetches fed | `path-divergence` | #516 |
| #517 | Reference IDs validated against the cache in live mode — live-created IDs rejected, stale ones accepted | `stale-cache-semantics` | #517 |
| #527 | `create_transaction`'s meta-index feed lacked the empty-routing-id guard its read-side sibling got | `path-divergence` | #527 |
| #532 | Empty-string routing IDs dropped safely but silently — drift telemetry gap | `external-api-drift` | #532 |
| #535 | `securityPrices[].price` typed non-null but the wire returns null; series could emit null/NaN | `wire-type-drift` | #535 |
| #564 | `package-lock.json` version left at the prior release; `check:version-sync` didn't cover it | `path-divergence` | #564 |
| #565 | Read-drift warnings keyed by full array-index path — one drift warned per row instead of once | `silent-failure-masking` | #565 |
| #577 | `check:skills` failed on clean main: the scraper read a hardcoded path, then failed open against a phantom tool list | `vacuous-assertion` | #577 |
| #588 | Stale tool-count figures in `package.json` and two docs | `doc-reality-drift` | #588 |
| #612 | Decoder unread-field drift: the server added a `_migration_backfill` marker | `external-api-drift` | #612 |
| #619 | The privacy-endpoint scanner's comment stripper could be blinded by delimiters inside string literals — a false negative in a brand-new detector | `vacuous-assertion` | #619 |
| #641 | Meta-index cap valve stranded its `.pid.tmp` when the rename threw after a successful write — latent, no report | `stranded-artifact` | #670 |
| #645 | The db-unavailable dispatch refusal omitted `isError`, so MCP clients saw a successful call carrying an error message — the one green guard among four | `silent-failure-masking` | #646 |
| #691, #694, #696, #699 | The exported-constant pin discovered declarations with a regex over regex-stripped text: a comment marker in a string literal dropped its declaration, a block opener in a line comment ate the ones after it, the bracket-free body bound dropped bracket-bearing members, and the sweep merged cross-file name collisions. All latent — no instance in `src/` — but every failure direction was silent | `silent-under-collecting-scan` | #721 |
| #695 | `TRANSFER_CATEGORIES` and `INCOME_CATEGORIES` were `new Set([...])`, outside that pin's grammar, so every member but the one each spot-check named was deletable with the suite green — the live instance of the same class | `silent-under-collecting-scan` | #721 |
| #701 | The concealment gate's scan loop dropped an unreadable file with a bare `catch { continue }` while the summary printed a pre-loop total — a security gate vouching for files it never opened; two tracked directory symlinks had been silently skipped on every run | `silent-failure-masking` | #724 |
| #701 | A docblock in the same gate documented the wrong declaration after a later PR inserted a pair into the gap — the second time for that block, and four more instances across `src/`, `scripts/` and `tests/` found by the sweep written to catch it | `doc-reality-drift` | #724 |
| #643 | `auto-merge.yml` was `pull_request_review`-only; GitHub parks that run at `action_required` for a first-time fork contributor and refuses to release it, so the workflow never fired and never reported failing | `silent-failure-masking` | #727 |
| #692 | Ten of twelve workflow jobs declared no `timeout-minutes`, inheriting GitHub's 360-minute default — ~360x the slowest observed job, and one of them holds `id-token: write` | `config-blind-default` | #727 |
| #642 | `bun test` hard-exits without firing `process.on('exit')`, so the temp-copy exit sweep could not run at suite end — a full run stranded 46 `copilot-leveldb-*` directories in `$TMPDIR`, and repeat runs stacked inside the hour-long orphan-sweep window | `deferred-cleanup-never-runs` | #725 |
| #714 | Test files asserted while bun was still collecting: a renamed conformance-ledger surface arrived as an unnamed load error and silently dropped two tests from the run. Two instances (a third had been caught in review on #713); the new AST gate found the second | `collection-time-assertion` | #725 |
| #727 | `scripts/check-workflows.ts` — the entire point of that PR — was never committed: `.gitignore` ignores `scripts/*` behind a hand-maintained allowlist, so `git add -A` skipped it in silence, every local gate passed reading it off disk, and CI was the first to notice. The new gate's first run found eight more tooling files tracked but ignore-matched, one rename from the same fate | `silent-failure-masking` | #746 |
| #723 | `docs/EXAMPLE_QUERIES.md` claimed 12 tools over a table that omitted two the default mode lists — self-consistent and incomplete at once, so a count needle alone would have ratcheted the understatement in | `doc-reality-drift` | #746 |
| #741 | `auto-merge.yml` read the approving identity off `github.repository_owner` — an account that spells a person's login only while the repo is personal, and an organisation login (which reviews nothing) afterwards. Latent and fail-closed, so it would have cost a maintainer an afternoon rather than a merge. The gate written for it found two live siblings: `npm-publish.yml` declared `TRUSTED_PUBLISHERS` with the comment "only these users can publish" and read it nowhere, while three gates carried their own copy of the literal; `auto-release.yml` repeated the login across three job gates with nothing to check them against | `proxy-for-authority` | #760 |
| #763 | `scripts/smoke/cache.ts` derived the raw side of its decode-loss and conservation checks from a root-prefix match while the decoder routes by leaf, so six of nine roots were compared against an empty set and check 1 reported the same PASS it would report for a wholly broken decoder. The sibling audit found check 3 doing the same over an empty `DEPENDED_ON` — vacuous since #624 removed its only entry. Both latent: the gate reported healthy, not wrong | `vacuous-assertion` | #777 |
| #755 | `actions/checkout` was SHA-pinned in eight workflow steps, six commented `# v7` and two `# v6` — the same SHA labelled across a major version, and a Dependabot bump then preserved both labels. Nothing parsed the comment, so nothing could tell. Latent: the pin itself was right, only its human-readable half was wrong | `unparsed-claim-beside-verified-value` | #755 |
| #756 | `tests/core/database-errors.test.ts` built sixteen `CopilotDatabase`es with no path — each one a `readdirSync` walk of the user's live Copilot Money container — for tests that immediately assigned the discovered path away. That readdir is bimodal: 8,470 calls measured on an idle machine gave 93% under 1ms, nothing at all between 100ms and 1s, and 8 that blocked for seconds and failed `EINTR` (longest 6,366ms). Thirty-two per run put bun's 5,000ms default timeout inside ~10% of runs of that file, failing a random one of fifteen cases — and `bun run check` is the pre-push hook, so it landed on unrelated pushes | `ambient-state-dependency` | #780 |
| #778 | The fix for #763 reported the gap without closing it: `smoke:cache` still counted its raw side by root prefix while the decoder routed by leaf, so six roots were never compared and `items` summed every subcollection beneath it (a permanent conservation WARN). Same mechanism one file over: `scripts/decode-coverage.ts` mirrored the decoder's dispatch chain by hand and had kept the `items/{id}` clause #627 removed; and the standalone `decodeX()` readers each kept their own filter, which #794 had just patched for `users/<uid>/accounts` with a fourth copy of the same predicate. All of them now call the decoder's exported `routeCollection`, so there is one routing decision instead of several. Widening the comparison to every route then found 19 processors that build a row from a fieldless parent pointer, two of them live on a real cache — filed as #797 with a two-way ratchet | `path-divergence` | #778 |
| #765, #770 | `FirebaseAuth.getIdToken` has no in-flight dedupe. A caller parked on an `await` while a sibling call installed a live session resumed as if nothing had changed, and with nothing usable of its own it reported "No Copilot Money session found", or rethrew an endpoint error such as a 429, while its object held a working token. #765 fixed the first of four resume points, and only for a dead-token verdict. The other three (the one-shot retry, the cold-path browser read, a cold-path candidate exchange) were found by review and fixed in the follow-up. Latent, no user report | `check-then-act-across-await` | #769, #792 |
| #796 | The #770 re-checks could return a sibling's session but not stop a write: with no in-flight dedupe, a cold-path candidate that succeeded after a sibling installed a session overwrote it inside `exchangeToken`, possibly with another account's, so two concurrent callers could be handed two accounts' ID tokens. Every concurrent caller also paid for its own browser read and exchanges. Fixed by one shared refresh promise per instance, which made the re-check ladder and the one-shot retry unreachable, so both were removed. Latent, no user report | `check-then-act-across-await` | #802 |
| #627 | `processItem` built an `items` row from every fieldless `items/{id}` parent pointer (hundreds on a real cache, collapsed by dedup to the handful whose ids matched no real item), while a comment at the call site asserted it returned null. Fixed for that one processor only | `phantom-row` | #630 |
| #797 | The rest of the #627 class: 19 of the 27 routes with a processor still built a row from a fieldless document. Found when #778 widened `smoke:cache` to every route. Two were live on a real cache, `plaid_accounts` (~5,100 entries) and `holdings_history_meta` (~800), all fieldless structural entries whose "document id" is a subcollection name, so the phantom rows carried ids like `transactions` and `history`, which is why the smoke had to exclude them; the other 17 were latent. Every processor now returns null for a fieldless document, and the per-route sweep that found them is the class detector | `phantom-row` | #804 |
| #824 | Cache mode reported a category on INCOME / INTERNAL_TRANSFER rows whose document kept one (seen on rows made by `create_transaction`); the app shows none. Fixed in the decoder, with `smoke:cache` check 9 comparing raw documents against decoded rows | `ui-parity` | #830 |
| #832 | A single-mutation transaction write (`update_transaction`, an `update_transactions` row, `delete_transaction`, `split_transaction`, `add_transaction_to_recurring`, `create_transaction`) that threw left its live month cached, so a write the server applied before a transport error was served pre-write from the cold tier for up to a week. Every catch now drops the target's month (create: its date's month) and the accounts snapshot. Latent, found in review of #831 | `stale-cache-semantics` | not yet |
