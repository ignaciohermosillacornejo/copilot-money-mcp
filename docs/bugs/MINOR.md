# Minor bug ledger

Bugs real enough to record but too small to justify a full post-mortem — mostly CI and
release plumbing, packaging, and latent defects fixed before anyone hit them.

They are here for two reasons: a class with only minor instances still shows up in the
[class list](README.md#bug-classes), and a run of minor bugs in one area is often the
early signal for a major one. `silent-failure-masking` appears **seven** times below and
has no full entry — a class that has never once produced a bug worth a post-mortem, yet
keeps costing us release and audit incidents, is exactly the pattern this ledger exists to
make visible.

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
